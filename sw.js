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
const APP_CACHE = "ct-app-shell-v1"; // caches the /app shell + its content-hashed assets

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // drop any stale app-shell caches from a previous SW version
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("ct-app-shell-") && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
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
  if (p === "/app" || p === "/app/") {
    // shell: network-first (so updates flow), cache fallback when offline
    event.respondWith((async () => {
      try { const res = await fetch(req); if (res.ok) (await caches.open(APP_CACHE)).put("/app", res.clone()); return res; }
      catch { return (await caches.match("/app")) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } }); }
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
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || "/", sessionId: data.sessionId || null },
  };
  if (data.icon) opts.icon = data.icon; // only when explicitly provided (avoids the duplicate app icon)
  event.waitUntil(self.registration.showNotification(title, opts));
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
