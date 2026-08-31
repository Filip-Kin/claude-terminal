// claude-terminal service worker: makes the terminal installable (PWA) and
// delivers Web Push notifications even when the app is fully closed.
// Served from /_paste/sw.js but registered at scope "/" (needs the
// Service-Worker-Allowed: / response header, which server.ts sets).

// Android already shows the installed app's icon on the notification, so we do NOT
// set a large `icon` by default (that produced a duplicate icon on the right). Only
// a payload that explicitly passes `icon` gets a large image. The badge is the small
// monochrome status-bar glyph (white sunburst on transparent).
const BADGE = "/_ct/pwa/badge-96.png?v=6";

// #region chat-app offline support (scoped to /app only; the terminal + ttyd WS are untouched)
// v2: the v1 shell was cached BEFORE the manifest link was added to index.html, and
// stale-while-revalidate kept serving that old HTML for "/" — so Chrome evaluated
// installability against a page with no manifest and would only offer a shortcut. The
// activate handler drops any cache whose name is not this one, so a rename refetches the shell.
const APP_CACHE = "ct-app-shell-v2"; // caches the /app shell + its content-hashed assets

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // drop any stale app-shell caches from a previous SW version
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("ct-app-shell-") && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Proactively cache the CURRENT build (shell + its content-hashed assets) so a cold launch with
    // NO connection always boots. Opportunistic fetch-caching alone isn't enough: every deploy changes
    // the asset hashes and a hard-refresh wipes Cache Storage, so without this a fresh offline open
    // (exactly the mountain case) would just spin. Best-effort — never let it fail activation.
    try { await precacheApp(); } catch { /* offline during activate — the page will re-trigger it */ }
  })());
});

// Fetch /app (index.html) + every /app/assets/... it references, and cache them together so the shell
// and its assets are always a consistent set. Called on activate and whenever the page pings us
// (after load + after a version change), so the latest build is ready to serve offline.
async function precacheApp() {
  const cache = await caches.open(APP_CACHE);
  const res = await fetch("/app", { cache: "no-store" });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put("/app", res);
  const assets = new Set((html.match(/\/app\/assets\/[A-Za-z0-9._-]+/g) || []));
  await Promise.all([...assets].map(async (a) => {
    try { const r = await fetch(a); if (r.ok) await cache.put(a, r.clone()); } catch { /* best effort */ }
  }));
}

// The page asks us to (re)precache after it loads and when it detects a new version.
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "ct-precache") event.waitUntil(precacheApp().catch(() => {}));
  if (d.type === "ct-read") event.waitUntil(clearReadNotifications(d.ids).catch(() => {}));
});

// Serve the chat-app shell + hashed assets from cache so /app loads offline. We ONLY act on
// same-origin GETs under /app (never the shell's /app/api/* calls, the terminal, or WS
// upgrades — those fall through to the network exactly as before).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  // The app owns "/" as of 2026-08-31 and the terminal moved to /terminal. "/" is served from the
  // SAME cached shell as "/app" (the router rewrites it to /app, so it is byte-identical), which is
  // what makes a cold PWA launch at the root instant and offline-proof. /terminal is deliberately
  // NOT handled here: its assets, /token and its WebSocket must always go straight to the network.
  if (p === "/terminal" || p.startsWith("/terminal/")) return;
  if (p === "/app" || p === "/app/" || p === "/") {
    // shell: STALE-WHILE-REVALIDATE. Serve the cached shell instantly (so it opens the same on 5G, on
    // one bar, or fully offline — never "loads and loads"), and refresh the cache in the background.
    // A new build is picked up by the app's own version poll -> reload toast, so serving a slightly
    // stale shell for one launch is fine and buys a guaranteed-instant, offline-proof open.
    event.respondWith((async () => {
      const cached = await caches.match("/app");
      const netUpdate = fetch(req).then((res) => { if (res.ok) caches.open(APP_CACHE).then((c) => c.put("/app", res.clone())); return res; }).catch(() => null);
      if (cached) { netUpdate; return cached; }              // instant, even offline
      const res = await netUpdate;                            // first ever load (nothing cached yet)
      return res || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    })());
    return;
  }
  if (p.startsWith("/app/assets/")) {
    // content-hashed -> cache-first
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try { const res = await fetch(req); if (res.ok) (await caches.open(APP_CACHE)).put(req, res.clone()); return res; }
      catch { return cached || Response.error(); }
    })());
    return;
  }
  // Root navigation (the terminal) while OFFLINE: ttyd's shell + WebSocket can't load without the
  // network and nothing caches them, so a cold PWA launch would just error. Redirect to /app, which
  // the SW serves from cache. Only fires when the network fetch actually fails (i.e. offline); when
  // online this passes straight through to the terminal.
  if ((p === "/" || p === "/index.html") && req.mode === "navigate") {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch { return Response.redirect("/app", 302); }
    })());
    return;
  }
  // everything else: not ours — leave the network alone
});

// Background Sync: replay the offline send-queue even if the app is backgrounded/closed
// (Chrome/Android; iOS has no Background Sync, so the page drains on reopen instead).
self.addEventListener("sync", (event) => {
  if (event.tag === "ct-send-queue") event.waitUntil(drainSendQueue());
});

function idbOpenApp() {
  return new Promise((resolve, reject) => {
    let r;
    // Open WITHOUT a version: attach to whatever version the app has created (the app owns the schema
    // and bumps DB_VERSION). Pinning a number here would VersionError once the app upgrades the DB.
    try { r = indexedDB.open("ct-app"); } catch (e) { reject(e); return; }
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function drainSendQueue() {
  let db;
  try { db = await idbOpenApp(); } catch { return; }
  // Always release the connection: a handle held open here BLOCKS the page's schema upgrade, which
  // would strand the app on the old DB version.
  try { await drainWith(db); } finally { try { db.close(); } catch { /* */ } }
}
async function drainWith(db) {
  if (!db.objectStoreNames.contains("queue")) return;
  const all = await new Promise((res) => { const t = db.transaction("queue", "readonly"); const rq = t.objectStore("queue").getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const it of all) {
    try {
      const r = await fetch("/app/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(it.body) });
      if (!r.ok) break; // reachable but rejected — stop; leave queued
      await new Promise((res) => { const t = db.transaction("queue", "readwrite"); t.objectStore("queue").delete(it.qid); t.oncomplete = () => res(); t.onerror = () => res(); });
    } catch { break; } // still offline
  }
}
// #endregion

// #region status push -> offline cache warming
// The server names the conversations that advanced; we fetch each one's delta and park the RAW events
// in `conv_pending`. We deliberately do NOT reduce them into items here: applyEvent lives in the app
// bundle and duplicating it in the worker would give us two reducers to keep in step. The app folds
// them on next open, which is cheap and keeps one source of truth.
const PENDING_CAP = 2000; // stop appending past this; the app then fetches the remainder on open

function idbReq(store, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = store.db.transaction(store.name, mode);
      const rq = fn(t.objectStore(store.name));
      t.oncomplete = () => resolve(rq ? rq.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

async function warmConv(db, id) {
  // Only top up conversations already in the cache. One we have never opened would mean pulling a
  // whole transcript through the worker, which is not what a 15s wake-up is for; the app caches it
  // when it is opened or prewarmed.
  const meta = await idbReq({ db, name: "conv_meta" }, "readonly", (s) => s.get(id));
  if (!meta) return false;
  const pending = await idbReq({ db, name: "conv_pending" }, "readonly", (s) => s.get(id));
  const have = Array.isArray(pending?.events) ? pending.events : [];
  if (have.length >= PENDING_CAP) return false;
  const cursor = pending && pending.evCount > 0 ? pending.evCount : (Number(meta.evCount) || 0);
  // evCount 0 means the page could not vouch for the cursor (it had streamed live events onto these
  // items). Folding a delta from an untrusted cursor would double every message the stream already
  // rendered, so leave it alone: the app does one full fetch on open and re-establishes it.
  if (!(cursor > 0)) return false;
  let data;
  try {
    const r = await fetch(`/app/api/conversation/${encodeURIComponent(id)}?since=${cursor}`, { credentials: "same-origin" });
    if (!r.ok) return false;
    data = await r.json();
  } catch { return false; } // offline or the session expired: cache just stays where it is
  // delta:false means the cursor was out of range and the server sent the whole transcript. We cannot
  // fold that here, so leave it: the app does a full fetch on open and self-heals.
  if (!data || data.delta !== true || !Array.isArray(data.events) || !data.events.length) return false;
  const events = have.concat(data.events).slice(0, PENDING_CAP);
  await idbReq({ db, name: "conv_pending" }, "readwrite", (s) => s.put({ cid: id, events, evCount: data.evTotal, at: Date.now() }));
  return true;
}

async function warmFromStatus(status) {
  const ids = Array.isArray(status.convs) ? status.convs.slice(0, 8) : [];
  if (!ids.length) return;
  let db;
  try { db = await idbOpenApp(); } catch { return; }
  try {
    // The pending store only exists from DB v3. An older page has not upgraded yet, so skip quietly
    // rather than throwing; the next app open creates it.
    if (!db.objectStoreNames.contains("conv_pending") || !db.objectStoreNames.contains("conv_meta")) return;
    for (const id of ids) { try { await warmConv(db, id); } catch { /* skip this one */ } }
  } finally { try { db.close(); } catch { /* */ } }
}

async function applyBadge(status) {
  try {
    if (!self.navigator || typeof self.navigator.setAppBadge !== "function") return;
    // The badge answers one question at a glance: does anything need me. So it counts only agents
    // that are WAITING on input, not agents that are merely busy.
    if (status.idle || !status.waiting) await self.navigator.clearAppBadge();
    else await self.navigator.setAppBadge(status.waiting);
  } catch { /* Badging unsupported here */ }
}
// #endregion

// The page tells us which conversations the user has now read. A status notification names the
// conversations that advanced, so once every one of them has been read it has nothing left to
// announce and should clear itself rather than sit there until it is tapped.
async function clearReadNotifications(readIds) {
  const read = new Set(Array.isArray(readIds) ? readIds : []);
  if (!read.size) return;
  let notes;
  try { notes = await self.registration.getNotifications(); } catch { return; }
  for (const n of notes || []) {
    const d = n.data || {};
    const refs = Array.isArray(d.convs) && d.convs.length ? d.convs : (d.sessionId ? [d.sessionId] : []);
    // Not conversation-scoped (a generic /notify from a script, say) — never auto-dismiss those,
    // the user is the only one who knows whether they have dealt with it.
    if (!refs.length) continue;
    if (refs.every((id) => read.has(id))) { try { n.close(); } catch { /* already gone */ } }
  }
}

// A push arrived from the server (VAPID). Payload is JSON:
// { title, body?, url?, tag?, icon?, requireInteraction?, sessionId? }
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Claude";
  const opts = {
    body: data.body || "",
    badge: BADGE,
    tag: data.tag || undefined,
    // Opt-in, not "any tagged push". A same-tag replacement with renotify:false updates the existing
    // notification with NO sound or vibration, which is what makes the 15s status cadence bearable;
    // the old `!!data.tag` re-alerted on every single one.
    renotify: !!data.renotify,
    silent: !!data.silent,
    requireInteraction: !!data.requireInteraction,
    // `convs` = the conversations this notification is announcing. Kept so it can be cleared
    // automatically once they have all been read (see clearReadNotifications).
    data: {
      url: data.url || "/", sessionId: data.sessionId || null,
      convs: Array.isArray(data.status && data.status.convs) ? data.status.convs
           : Array.isArray(data.convs) ? data.convs : null,
    },
  };
  if (data.icon) opts.icon = data.icon; // only when explicitly provided (avoids the duplicate app icon)
  // Show first, then do the background work. showNotification is what satisfies userVisibleOnly, so it
  // must not be able to lose a race with a slow delta fetch.
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    const status = data.status;
    if (!status) return;
    await applyBadge(status);
    await warmFromStatus(status);
  })());
});

// Clicking a notification: focus an already-open terminal (and tell the overlay
// which session to switch to), or open a fresh window at the target URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try {
        await c.focus();
        c.postMessage({ type: "ct-notification-click", url, sessionId: d.sessionId || null });
        return;
      } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
