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
export const DB_VERSION = 1;
export const CONV_STORE = "conversations"; // { id, payload, size, at }
export const QUEUE_STORE = "queue"; // { qid (auto), body, createdAt }
export const META_STORE = "meta"; // small kv: { k, v }
export const SYNC_TAG = "ct-send-queue"; // Background Sync tag (also referenced in sw.js)
export const CACHE_LIMIT = 50 * 1024 * 1024; // 50 MB

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
export interface QueuedSend { qid?: number; body: { text: string; resume?: string; model?: string; cwd?: string }; createdAt: number }

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
