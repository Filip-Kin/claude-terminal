// Battery diagnostics. Android bills an installed PWA's work to Chrome, so the battery screen cannot
// tell us what this app does once it leaves the screen. This counts it from inside the page, split
// into "v" (visible) and "h" (hidden): requests and bytes per route, SSE messages, ttyd WebSocket
// frames, setInterval fires per delay, long tasks (a CPU proxy), freeze/resume, and the battery level.
// Counters go to POST /_ct/bstats on every visibility change, on pagehide, and every 5 min; the
// server keeps them in bstats.db and GET /_ct/bstats/report sums them.
//
// Loaded first by the chat app (import in app/main.tsx) and prepended to /overlay.js by the server for
// the terminal page, so it must patch WebSocket/EventSource/setInterval before anything else runs.
(function () {
  if (typeof window === "undefined" || window.__ctBstats) return;
  window.__ctBstats = true;

  const page = location.pathname.startsWith("/terminal") ? "term" : "app";
  const cid = Math.random().toString(36).slice(2, 10);
  const nativeSetInterval = window.setInterval.bind(window);
  const mk = () => ({ ms: 0, reqN: 0, reqB: 0, req: {}, sseOpen: 0, sseErr: 0, sseN: 0, sseB: 0,
    wsOpen: 0, wsN: 0, wsB: 0, wsOut: 0, iv: {}, longN: 0, longMs: 0, freeze: 0, frozenMs: 0 });
  let cur = { v: mk(), h: mk() };
  let t0 = Date.now();
  let visState = document.visibilityState === "visible" ? "v" : "h";
  let since = Date.now();
  let frozenAt = 0;
  const bucket = () => cur[document.visibilityState === "visible" ? "v" : "h"];

  // Collapse ids out of a path so routes group: /app/api/conversation/<uuid> -> /app/api/conversation/:id
  function route(u) {
    try {
      const url = new URL(u, location.href);
      if (url.origin !== location.origin) return url.host;
      return url.pathname.split("/").map((s) => (s.length > 16 || /^\d+$/.test(s) ? ":id" : s)).join("/");
    } catch { return "?"; }
  }

  try {
    performance.setResourceTimingBufferSize(1000);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const k = route(e.name);
        if (k.startsWith("/_ct/bstats")) continue; // our own beacons
        const b = bucket(), sz = e.transferSize || 0;
        const r = b.req[k] || (b.req[k] = [0, 0]);
        r[0]++; r[1] += sz; b.reqN++; b.reqB += sz;
      }
    }).observe({ type: "resource" });
  } catch { /* no Resource Timing */ }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { const b = bucket(); b.longN++; b.longMs += e.duration; }
    }).observe({ type: "longtask" });
  } catch { /* no Long Tasks API (Firefox, Safari) */ }

  const NativeES = window.EventSource;
  if (NativeES) {
    window.EventSource = class extends NativeES {
      constructor(u, o) {
        super(u, o);
        this.addEventListener("open", () => { bucket().sseOpen++; });
        this.addEventListener("error", () => { bucket().sseErr++; });
        this.addEventListener("message", (e) => { const b = bucket(); b.sseN++; b.sseB += (e.data || "").length; });
      }
    };
  }

  const NativeWS = window.WebSocket;
  if (NativeWS) {
    const size = (d) => (typeof d === "string" ? d.length : d.byteLength ?? d.size ?? 0);
    function CountedWS(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      ws.addEventListener("open", () => { bucket().wsOpen++; });
      ws.addEventListener("message", (e) => { const b = bucket(); b.wsN++; b.wsB += size(e.data); });
      const send = ws.send;
      ws.send = function (d) { bucket().wsOut++; return send.call(this, d); };
      return ws;
    }
    CountedWS.prototype = NativeWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) CountedWS[k] = NativeWS[k];
    window.WebSocket = CountedWS;
  }

  window.setInterval = function (fn, ms, ...a) {
    if (typeof fn !== "function") return nativeSetInterval(fn, ms, ...a);
    const k = String(ms | 0);
    return nativeSetInterval(function () { const b = bucket(); b.iv[k] = (b.iv[k] || 0) + 1; return fn.apply(this, arguments); }, ms, ...a);
  };

  let battery = null;
  try { navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {}); } catch { /* */ }

  function settle() {
    const now = Date.now();
    cur[visState].ms += now - since;
    since = now;
  }

  function flush(reason) {
    settle();
    const now = Date.now();
    const body = {
      cid, page, reason, t0, t1: now,
      ua: navigator.userAgent.slice(0, 160),
      standalone: matchMedia("(display-mode: standalone)").matches,
      battery: battery ? { level: battery.level, charging: battery.charging } : null,
      v: cur.v, h: cur.h,
    };
    let ok = false;
    try { ok = navigator.sendBeacon("/_ct/bstats", new Blob([JSON.stringify(body)], { type: "application/json" })); } catch { /* */ }
    if (ok) { cur = { v: mk(), h: mk() }; t0 = now; }
  }

  document.addEventListener("visibilitychange", () => {
    flush(visState === "v" ? "hide" : "show");
    visState = document.visibilityState === "visible" ? "v" : "h";
  });
  window.addEventListener("pagehide", () => flush("pagehide"));
  document.addEventListener("freeze", () => { frozenAt = Date.now(); bucket().freeze++; flush("freeze"); });
  document.addEventListener("resume", () => {
    if (frozenAt) { bucket().frozenMs += Date.now() - frozenAt; frozenAt = 0; }
  });
  nativeSetInterval(() => flush("tick"), 300000);
})();
