// claude-terminal service worker: makes the terminal installable (PWA) and
// delivers Web Push notifications even when the app is fully closed.
// Served from /_paste/sw.js but registered at scope "/" (needs the
// Service-Worker-Allowed: / response header, which server.ts sets).

const ICON = "/_ct/pwa/icon-192.png?v=2";
const BADGE = "/_ct/pwa/favicon-32.png?v=2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

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
    icon: data.icon || ICON,
    badge: BADGE,
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || "/", sessionId: data.sessionId || null },
  };
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
