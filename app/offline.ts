// app/offline.ts — offline support for the chat app, framework-agnostic (main.tsx wires it in).
//
// Two IndexedDB-backed pieces:
//  1) A conversation cache so opening a chat works offline. Capped at ~50MB; when over,
//     the least-recently-opened conversations are purged (LRU by last-access time).
//  2) An outbound send-queue: when a send fails because we're offline, the message is
//     queued and replayed when connectivity returns — from the page on reconnect, and
//     (on browsers that support it) from the service worker via Background Sync, so it
//     can go out even if the app is backgrounded. iOS has no Background Sync, so there it
//     fires the moment the app is reopened online.
//
// The store names + DB name are mirrored in sw.js (a classic worker can't import this),
// so keep them in sync if you rename anything here.

export const DB_NAME = "ct-app";
export const DB_VERSION = 3;
export const CONV_STORE = "conversations"; // legacy whole-blob cache { id, payload, size, at } — read fallback only
export const ITEM_STORE = "conv_items"; // one record PER MESSAGE: { cid, idx, item, size, at } — tail-only writes
export const CONVMETA_STORE = "conv_meta"; // per-conversation metadata: { cid, count, busy, cwd, live, at }
export const QUEUE_STORE = "queue"; // { qid (auto), body, createdAt }
export const PENDING_STORE = "conv_pending"; // { cid, events, at } — transcript events the service worker
// fetched while the app was closed. The SW cannot run applyEvent (the reducer lives in the bundle), so it
// parks RAW events here and the app folds them into items on next open. Keeps one copy of the reducer.
export const META_STORE = "meta"; // small kv: { k, v }
export const SYNC_TAG = "ct-send-queue"; // Background Sync tag (also referenced in sw.js)
export const CACHE_LIMIT = 50 * 1024 * 1024; // 50 MB
export const MAX_CACHED_CONVS = 150; // LRU cap on how many conversations we keep cached

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONV_STORE)) {
        const s = db.createObjectStore(CONV_STORE, { keyPath: "id" });
        s.createIndex("by_at", "at"); // LRU order
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "qid", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains(ITEM_STORE)) {
        const s = db.createObjectStore(ITEM_STORE, { keyPath: ["cid", "idx"] });
        s.createIndex("by_cid", "cid"); // read/delete all messages of one conversation, ordered by idx
      }
      if (!db.objectStoreNames.contains(CONVMETA_STORE)) {
        const s = db.createObjectStore(CONVMETA_STORE, { keyPath: "cid" });
        s.createIndex("by_at", "at"); // LRU order
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: "cid" });
      }
    };
    req.onblocked = () => reject(req.error || new Error("idb upgrade blocked")); // don't hang the caller; it falls back to network
    req.onsuccess = () => {
      const db = req.result;
      // Let a FUTURE version bump upgrade cleanly: close on versionchange so we never block it.
      db.onversionchange = () => { try { db.close(); } catch { /* */ } dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out: T = undefined as unknown as T;
        const r = fn(s);
        if (r) r.onsuccess = () => (out = r.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const sizeOf = (o: unknown) => {
  try { return JSON.stringify(o).length; } catch { return 0; }
};

// #region conversation cache
export async function cacheConversation(id: string, payload: unknown): Promise<void> {
  if (!id) return;
  try {
    await tx(CONV_STORE, "readwrite", (s) => s.put({ id, payload, size: sizeOf(payload), at: Date.now() }));
    await enforceLimit();
  } catch { /* storage full / private mode — best effort */ }
}

export async function getCachedConversation(id: string): Promise<unknown | null> {
  try {
    const rec = await tx<any>(CONV_STORE, "readonly", (s) => s.get(id));
    if (!rec) return null;
    // bump last-access so the LRU keeps things you actually open
    tx(CONV_STORE, "readwrite", (s) => s.put({ ...rec, at: Date.now() })).catch(() => {});
    return rec.payload ?? null;
  } catch { return null; }
}

// #region per-message conversation cache (tail-only writes)
// evCount = how many RAW transcript events these items were reduced from. It is the delta cursor: the
// next fetch asks for events after it. Distinct from `count` (number of reduced items), because
// applyEvent folds many events into one item (every text_delta grows the same bubble).
export interface ConvMeta { busy?: boolean; cwd?: string | null; live?: boolean; evCount?: number }

// Write ONLY the messages from `fromIdx` onward (the tail that changed while streaming), refresh the
// per-conversation metadata, and drop any records past the new length (a shrink). Nothing else is
// rewritten — a streaming token that grows the last bubble touches exactly one record.
export async function saveConvItems(cid: string, items: any[], fromIdx: number, meta: ConvMeta): Promise<void> {
  if (!cid) return;
  const now = Date.now();
  const start = Math.max(0, fromIdx | 0);
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([ITEM_STORE, CONVMETA_STORE], "readwrite");
      const is = t.objectStore(ITEM_STORE);
      for (let i = start; i < items.length; i++) is.put({ cid, idx: i, item: items[i], size: sizeOf(items[i]), at: now });
      is.delete(IDBKeyRange.bound([cid, items.length], [cid, []])); // prune leftovers if the list shrank
      t.objectStore(CONVMETA_STORE).put({ cid, count: items.length, busy: !!meta.busy, cwd: meta.cwd ?? null, live: !!meta.live, evCount: meta.evCount ?? 0, at: now });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    void enforceConvCap();
  } catch { /* storage full / private mode — best effort */ }
}

// Reconstruct a conversation from its message records (ordered by idx). Falls back to the legacy
// whole-blob cache for anything stored before the per-message store existed.
export async function getConv(cid: string): Promise<{ items: any[]; busy: boolean; cwd: string | null; live: boolean; evCount: number } | null> {
  try {
    const db = await openDB();
    const res = await new Promise<{ items: any[]; meta: any } | null>((resolve) => {
      const t = db.transaction([ITEM_STORE, CONVMETA_STORE], "readonly");
      const metaReq = t.objectStore(CONVMETA_STORE).get(cid);
      const itemsReq = t.objectStore(ITEM_STORE).index("by_cid").getAll(IDBKeyRange.only(cid));
      t.oncomplete = () => {
        const meta = metaReq.result;
        if (!meta) { resolve(null); return; }
        const rows = ((itemsReq.result || []) as any[]).sort((a, b) => a.idx - b.idx);
        resolve({ items: rows.map((r) => r.item), meta });
      };
      t.onerror = () => resolve(null);
    });
    if (res) {
      tx(CONVMETA_STORE, "readwrite", (s) => s.put({ ...res.meta, at: Date.now() })).catch(() => {}); // bump LRU
      return { items: res.items, busy: !!res.meta.busy, cwd: res.meta.cwd ?? null, live: !!res.meta.live, evCount: Number(res.meta.evCount) || 0 };
    }
    const legacy: any = await getCachedConversation(cid);
    // Legacy blob has no cursor, so evCount 0 forces one full refetch, then it is delta from there on.
    if (legacy && Array.isArray(legacy.items)) return { items: legacy.items, busy: !!legacy.busy, cwd: legacy.cwd ?? null, live: !!legacy.live, evCount: 0 };
    return null;
  } catch { return null; }
}

// Events the service worker parked while the app was closed. Returned in arrival order; the caller
// folds them onto the cached items and then clears them.
export async function takePendingEvents(cid: string): Promise<{ events: any[]; evCount: number } | null> {
  try {
    const rec = await tx<any>(PENDING_STORE, "readonly", (s) => s.get(cid));
    if (!rec || !Array.isArray(rec.events) || !rec.events.length) return null;
    return { events: rec.events, evCount: Number(rec.evCount) || 0 };
  } catch { return null; }
}
export async function clearPendingEvents(cid: string): Promise<void> {
  try { await tx(PENDING_STORE, "readwrite", (s) => s.delete(cid)); } catch { /* best effort */ }
}

export async function hasConv(cid: string): Promise<boolean> {
  try { const m = await tx<any>(CONVMETA_STORE, "readonly", (s) => s.get(cid)); return !!m; } catch { return false; }
}

export async function deleteConvCache(cid: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const t = db.transaction([ITEM_STORE, CONVMETA_STORE, CONV_STORE, PENDING_STORE], "readwrite");
      t.objectStore(ITEM_STORE).delete(IDBKeyRange.bound([cid], [cid, []]));
      t.objectStore(CONVMETA_STORE).delete(cid);
      t.objectStore(CONV_STORE).delete(cid);
      t.objectStore(PENDING_STORE).delete(cid);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  } catch { /* */ }
}

// LRU cap by conversation COUNT (message records are small): drop the least-recently-used ones.
async function enforceConvCap(): Promise<void> {
  try {
    const db = await openDB();
    const stale: string[] = await new Promise((resolve) => {
      const t = db.transaction(CONVMETA_STORE, "readonly");
      const rows: { cid: string; at: number }[] = [];
      t.objectStore(CONVMETA_STORE).openCursor().onsuccess = (ev) => {
        const cur = (ev.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) { rows.push({ cid: cur.value.cid, at: cur.value.at || 0 }); cur.continue(); return; }
        if (rows.length <= MAX_CACHED_CONVS) { resolve([]); return; }
        rows.sort((a, b) => a.at - b.at);
        resolve(rows.slice(0, rows.length - MAX_CACHED_CONVS).map((r) => r.cid));
      };
      t.onerror = () => resolve([]);
    });
    for (const cid of stale) await deleteConvCache(cid);
  } catch { /* */ }
}
// #endregion

// Purge least-recently-opened conversations until the cache is back under CACHE_LIMIT.
async function enforceLimit(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const t = db.transaction(CONV_STORE, "readwrite");
      const s = t.objectStore(CONV_STORE);
      let total = 0;
      const rows: { id: string; size: number; at: number }[] = [];
      s.openCursor().onsuccess = (ev) => {
        const cur = (ev.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) { const v = cur.value; total += v.size || 0; rows.push({ id: v.id, size: v.size || 0, at: v.at || 0 }); cur.continue(); return; }
        if (total > CACHE_LIMIT) {
          rows.sort((a, b) => a.at - b.at); // oldest first
          for (const r of rows) { if (total <= CACHE_LIMIT) break; s.delete(r.id); total -= r.size; }
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  } catch { /* best effort */ }
}

export async function cacheList(list: unknown): Promise<void> {
  try { await tx(META_STORE, "readwrite", (s) => s.put({ k: "convList", v: list, at: Date.now() })); } catch {}
}
export async function getCachedList<T = unknown>(): Promise<T | null> {
  try { const rec = await tx<any>(META_STORE, "readonly", (s) => s.get("convList")); return rec?.v ?? null; } catch { return null; }
}

export async function cacheUsage(): Promise<{ count: number; bytes: number }> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const t = db.transaction(CONV_STORE, "readonly");
      const s = t.objectStore(CONV_STORE);
      let count = 0, bytes = 0;
      s.openCursor().onsuccess = (ev) => {
        const cur = (ev.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) { count++; bytes += cur.value.size || 0; cur.continue(); return; }
      };
      t.oncomplete = () => resolve({ count, bytes });
      t.onerror = () => resolve({ count, bytes });
    });
  } catch { return { count: 0, bytes: 0 }; }
}
// #endregion

// #region outbound send-queue
export interface QueuedSend { qid?: number; body: { text: string; resume?: string; model?: string; cwd?: string; cid?: string; voice?: boolean }; createdAt: number }

// We always queue as a /app/api/start body (resume + text): it resumes-or-creates and sends
// in one request, so replay never depends on a live server-side session that offline killed.
export async function enqueueSend(body: QueuedSend["body"]): Promise<void> {
  try { await tx(QUEUE_STORE, "readwrite", (s) => s.add({ body, createdAt: Date.now() })); } catch {}
}

export async function getQueue(): Promise<QueuedSend[]> {
  try { return (await tx<any[]>(QUEUE_STORE, "readonly", (s) => s.getAll())) || []; } catch { return []; }
}
export async function queueCount(): Promise<number> {
  try { return (await tx<number>(QUEUE_STORE, "readonly", (s) => s.count())) || 0; } catch { return 0; }
}
export async function removeQueued(qid: number): Promise<void> {
  try { await tx(QUEUE_STORE, "readwrite", (s) => s.delete(qid)); } catch {}
}

// Replay the queue oldest-first. Stops at the first failure (still offline) and leaves the
// rest queued. Returns how many were sent. Safe to call from the page; the SW has its own copy.
export async function drainQueue(): Promise<number> {
  const items = (await getQueue()).sort((a, b) => a.createdAt - b.createdAt);
  let sent = 0;
  for (const it of items) {
    try {
      const r = await fetch("/app/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(it.body) });
      if (!r.ok) break; // server reachable but rejected — stop to avoid a hot loop; leave queued
      if (it.qid != null) await removeQueued(it.qid);
      sent++;
    } catch { break; } // network down again — stop, keep the rest
  }
  return sent;
}

// Ask the service worker to replay the queue in the background (Android/desktop Chrome).
// Returns true if a background sync was registered; false if unsupported (e.g. iOS) — the
// caller should then drain on the next online event / app open instead.
export async function requestBackgroundSync(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && "sync" in reg) { await (reg as any).sync.register(SYNC_TAG); return true; }
  } catch { /* fall through */ }
  return false;
}
// #endregion

export const isOnline = () => (typeof navigator !== "undefined" ? navigator.onLine : true);
