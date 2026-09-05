(function () {
  const log = (...a) => console.log("[claude-paste]", ...a);
  log("overlay loaded");

  // #region PWA launch routing — reopen the surface you left off on (terminal vs app).
  // The manifest start_url is "/?home=1"; that marker only appears on a cold PWA launch, so a
  // normal in-app navigation to the terminal never bounces. If the app ("/app") was the last
  // surface, jump there (its default view, NOT a specific conversation). Otherwise stay here.
  try {
    var _sp = new URLSearchParams(location.search);
    var _last = null; try { _last = localStorage.getItem("ct-last-surface"); } catch (e) {}
    var _standalone = false;
    try { _standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; } catch (e) {}
    var _navType = "";
    try { var _nav = performance.getEntriesByType("navigation")[0]; _navType = _nav ? _nav.type : ""; } catch (e) {}
    // Treat this as a cold PWA launch (so honour "reopen last surface") on EITHER signal:
    //  - the start_url marker "?home=1" (a correctly-updated install), or
    //  - a standalone top-level launch with no same-app referrer and not a reload. This covers
    //    OLD installs whose baked start_url predates the marker — Android WebAPK / iOS bake the
    //    start_url at install and rarely refresh it, so the marker alone would miss them. A later
    //    in-app hop to the terminal carries a referrer, and a manual reload reports type "reload",
    //    so neither trips the fallback. (last-surface is also rewritten to "/" below, so once you
    //    are on the terminal a reload can't bounce you away.)
    var _cold = _sp.get("home") === "1" || (_standalone && !document.referrer && _navType !== "reload");
    // Root is the APP now, so a cold launch never lands here by accident and there is nothing to
    // bounce to: the app owns the reopen-last-surface decision (see main.tsx). Kept only for an old
    // install whose baked start_url still points at a terminal URL.
    if (_cold && _last === "/app") { location.replace("/app"); return; }
    if (_sp.get("home") === "1") { try { history.replaceState(null, "", location.pathname); } catch (e) {} } // drop the marker
    try { localStorage.setItem("ct-last-surface", "/terminal"); } catch (e) {} // we're on the terminal now
  } catch (e) {}
  // #endregion

  // #region ttyd WebSocket capture
  // ttyd negotiates with the 'tty' subprotocol. Patch WebSocket so we can
  // grab the live connection and inject input directly (ttyd input frame =
  // '0' + utf8 payload).
  const NativeWS = window.WebSocket;
  let ttydWs = null;

  function PatchedWS(url, protocols) {
    const ws = new NativeWS(url, protocols);
    const protos = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    if (protos.includes("tty")) {
      log("captured ttyd ws", url);
      ttydWs = ws;
    }
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.CONNECTING = NativeWS.CONNECTING;
  PatchedWS.OPEN = NativeWS.OPEN;
  PatchedWS.CLOSING = NativeWS.CLOSING;
  PatchedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = PatchedWS;

  function sendToTerminal(text) {
    if (!ttydWs || ttydWs.readyState !== NativeWS.OPEN) {
      log("sendToTerminal: ttyd ws not ready", ttydWs && ttydWs.readyState);
      return false;
    }
    ttydWs.send("0" + text);
    return true;
  }
  // #endregion

  // #region Shift+Enter -> newline
  // Web xterm sends \r (CR) for both Enter and Shift+Enter, so Shift+Enter just
  // submits. Claude Code (Ink) treats \r and \n as submit; it inserts a newline on
  // meta+return (Option/Alt+Enter), whose byte sequence is ESC + CR ("\x1b\r").
  // Intercept Shift+Enter and send that instead.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (sendToTerminal("\x1b\r")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  }, true);
  // #endregion

  // #region auto-reconnect
  // ttyd only auto-reconnects when the socket closes abnormally AND no WebSocket
  // 'error' fired first — but it disables its own reconnect on ANY error, which is
  // exactly the common sleep/wake and mobile-network-blip case. It then parks on a
  // "Press ⏎ to Reconnect" overlay and waits for a keypress. Watch for that overlay
  // and synthesize the Enter ourselves so it reconnects without user action. ttyd's
  // reconnect handler is a terminal.onKey(Enter) listener, so a keydown dispatched on
  // xterm's hidden textarea drives it. A short backoff means we retry every ~1.5s
  // while offline instead of hammering, and it re-fires each time the overlay
  // reappears after a failed attempt.
  const RECONNECT_RETRY_MS = 1500;
  let reconnectPending = false;
  function waitingToReconnect() {
    // ttyd's overlay is an unclassed absolutely-positioned div appended to .xterm.
    const nodes = document.querySelectorAll(".xterm > div");
    for (const n of nodes) {
      if (/Press\b.*\bReconnect/.test(n.textContent || "")) return true;
    }
    return false;
  }
  function pressEnterInTerminal() {
    const ta = document.querySelector(".xterm-helper-textarea");
    if (!ta) return;
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ta.dispatchEvent(new KeyboardEvent("keydown", opts));
    ta.dispatchEvent(new KeyboardEvent("keyup", opts));
  }
  function checkReconnect() {
    if (reconnectPending || !waitingToReconnect()) return;
    reconnectPending = true;
    log("auto-reconnect: parked on 'Press Enter to Reconnect', retrying in", RECONNECT_RETRY_MS, "ms");
    setTimeout(() => {
      reconnectPending = false;
      if (waitingToReconnect()) {
        log("auto-reconnect: sending Enter");
        pressEnterInTerminal();
      }
    }, RECONNECT_RETRY_MS);
  }
  new MutationObserver(checkReconnect).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  checkReconnect();
  // #endregion

  // #region layout fixes (right gutter + mobile scroll)
  // ttyd defaults leave a wide right gap (5px padding + a permanent overflow:scroll
  // gutter). Trim the right padding, make the scrollbar thin/auto, and keep the
  // screen touch-scrollable on mobile.
  const fixStyle = document.createElement("style");
  fixStyle.textContent = [
    "#terminal-container .terminal{padding:4px 0 4px 4px !important}",
    // Hide the scrollbar entirely so it reserves NO width (kills the right-side
    // gutter that read as a margin). Wheel + the manual touch handler below still scroll.
    ".xterm .xterm-viewport{overflow-y:auto !important;scrollbar-width:none !important}",
    ".xterm .xterm-viewport::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important}",
  ].join("");
  (document.head || document.documentElement).appendChild(fixStyle);
  // reflow so xterm's fit addon recomputes columns for the trimmed padding
  const reflow = () => window.dispatchEvent(new Event("resize"));
  setTimeout(reflow, 300);
  setTimeout(reflow, 1200);
  // #endregion

  // #region mobile touch-scroll -> synthetic wheel
  // tmux runs with `mouse on` (alternate screen), so there is no DOM scrollback to pan;
  // scrolling only happens when a wheel event reaches xterm, which encodes it as a mouse
  // event for tmux copy-mode. Touch emits no wheel events, so convert a vertical touch
  // DRAG into wheel notches on the terminal. A tap or horizontal move is left alone so
  // clicks, cursor placement and selection still pass through to xterm/tmux.
  const NOTCH = 20; // px of finger travel per wheel notch
  // don't hijack touches inside our own UI (the history dialog + the tab bar) — they
  // need native scrolling.
  const inOverlayUi = (el) => !!(el && el.closest && el.closest("#ct-histmodal, #ct-connmodal, #ct-drawer, #claude-tabbar"));
  let tStartX = 0, tStartY = 0, tLastY = 0, tAccum = 0, tScroll = false;
  document.addEventListener("touchstart", (e) => {
    tScroll = false; tAccum = 0;
    if (inOverlayUi(e.target)) return;
    if (e.touches.length === 1) {
      tStartX = e.touches[0].clientX;
      tStartY = tLastY = e.touches[0].clientY;
    }
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (e) => {
    if (inOverlayUi(e.target)) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!tScroll) {
      const dx = Math.abs(t.clientX - tStartX);
      const dy = Math.abs(t.clientY - tStartY);
      if (dy < 8 || dy <= dx) return; // tap / horizontal -> let xterm handle it (clicks pass through)
      tScroll = true; tLastY = t.clientY; tAccum = 0;
    }
    e.preventDefault();
    e.stopPropagation();
    tAccum += t.clientY - tLastY;
    tLastY = t.clientY;
    const el = document.querySelector(".xterm-screen") || document.querySelector(".xterm");
    if (!el) return;
    while (Math.abs(tAccum) >= NOTCH) {
      const up = tAccum > 0; // finger moves down => reveal earlier output => wheel up
      el.dispatchEvent(new WheelEvent("wheel", {
        deltaY: up ? -120 : 120, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: t.clientX, clientY: t.clientY,
      }));
      tAccum += up ? -NOTCH : NOTCH;
    }
  }, { capture: true, passive: false });
  document.addEventListener("touchend", () => { tScroll = false; }, { capture: true, passive: true });
  // #endregion

  // #region toast UI
  let toastEl;
  function showToast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = [
        "position:fixed", "top:12px", "right:12px", "z-index:99999",
        "padding:8px 12px", "border-radius:6px",
        "font:13px/1.4 system-ui,sans-serif", "color:#fff",
        "box-shadow:0 2px 8px rgba(0,0,0,.3)", "pointer-events:none",
        "transition:opacity .2s", "opacity:0", "max-width:60vw",
      ].join(";");
      (document.documentElement || document.body).appendChild(toastEl);
    }
    const colors = { info: "#3b82f6", success: "#16a34a", error: "#dc2626" };
    toastEl.style.background = colors[kind] || colors.info;
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.opacity = "0"; }, 2600);
  }
  // #endregion

  async function uploadImage(blob, filename) {
    const fd = new FormData();
    fd.append("image", blob, filename || "paste.png");
    const r = await fetch("/_ct/upload", { method: "POST", body: fd });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`${r.status} ${body || r.statusText}`);
    }
    return (await r.json()).path;
  }

  async function handleImage(blob, filename) {
    showToast("Uploading image…");
    try {
      const path = await uploadImage(blob, filename);
      if (sendToTerminal(path + " ")) {
        showToast("Pasted: " + path, "success");
      } else {
        try {
          await navigator.clipboard.writeText(path);
          showToast("Copied path → Ctrl+V to paste", "success");
        } catch {
          showToast("Path: " + path, "success");
        }
      }
    } catch (err) {
      showToast("Upload failed: " + err.message, "error");
      console.error("[claude-paste]", err);
    }
  }

  // #region paste / drop handlers
  document.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    const items = cd ? Array.from(cd.items || []) : [];
    const files = cd ? Array.from(cd.files || []) : [];
    log("paste event", "items=", items.map((i) => i.kind + ":" + i.type), "files=", files.map((f) => f.type));
    // image as a clipboard item (screenshots, most browsers)
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          e.stopPropagation();
          handleImage(blob, blob.name);
          return;
        }
      }
    }
    // fallback: image via clipboardData.files (some Firefox paths expose it here only)
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        e.preventDefault();
        e.stopPropagation();
        handleImage(f, f.name);
        return;
      }
    }
  }, true);

  document.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    let handled = false;
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        if (!handled) {
          e.preventDefault();
          e.stopPropagation();
          handled = true;
        }
        handleImage(f, f.name);
      }
    }
  }, true);

  document.addEventListener("dragover", (e) => {
    const items = e.dataTransfer && e.dataTransfer.items;
    if (items && Array.from(items).some((i) => i.kind === "file")) {
      e.preventDefault();
    }
  }, true);
  // #endregion

  // #region session tab bar
  // A browser-bookmarks-style bar across the top of the terminal listing filip's
  // open tmux sessions (in the order they were opened), coloring the one this tab
  // is attached to, with click-to-switch, X-to-close, open-in-new-tab, a "+" to
  // start a session, and a theme toggle. Session data + actions come from the
  // claude-paste sidecar (/_paste/sessions, /_paste/sessions/new|close, /_paste/theme).
  const BAR_H = 34;
  const MAIN_ID = "1"; // main session is always first; closing it just restarts it
  const curId = () => new URLSearchParams(location.search).get("arg") || MAIN_ID;

  // ttyd installs a beforeunload "are you sure you want to leave this page" prompt.
  // Suppress it so switching/closing tabs (which reload the page) never nags. Capture
  // phase + stopImmediatePropagation runs before ttyd's handler and prevents it from
  // setting returnValue, so no dialog appears.
  window.addEventListener("beforeunload", (e) => {
    e.stopImmediatePropagation();
    delete e.returnValue;
  }, true);

  const SVG_OPEN =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const SVG_SUN =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const SVG_MOON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const SVG_USAGE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/></svg>';
  const SVG_REFRESH =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  const SVG_HISTORY =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>';
  const SVG_HAM =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
  const SVG_CHAT =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-9 8.32 8.5 8.5 0 0 1-3.6-.8L3 20l1.3-3.9A8.38 8.38 0 0 1 3.5 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/></svg>';
  const SVG_NET =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg>';
  const SVG_BELL =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const SVG_BELL_OFF =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a1.94 1.94 0 0 1-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0 1 18 8"/><path d="M6.26 6.26A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><path d="m2 2 20 20"/></svg>';

  const barStyle = document.createElement("style");
  barStyle.textContent = [
    // make room for the fixed bar
    "#terminal-container{top:" + BAR_H + "px !important;height:calc(100% - " + BAR_H + "px) !important}",
    // the bar itself (dark defaults; light overrides below via body.theme-light)
    "#claude-tabbar{position:fixed;top:0;left:0;right:0;height:" + BAR_H + "px;z-index:50;display:flex;align-items:stretch;gap:6px;padding:0 8px;box-sizing:border-box;background:#181818;border-bottom:1px solid #2e2e2e;font:12px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#cfcfcf;user-select:none;-webkit-user-select:none}",
    "#claude-tabbar *{box-sizing:border-box}",
    // chips scroll; the + sits right after them (left-aligned, browser-style)
    "#claude-tabbar .ctab-list{display:flex;align-items:stretch;gap:6px;overflow-x:auto;scrollbar-width:none;flex:0 1 auto;min-width:0;-webkit-overflow-scrolling:touch}",
    "#claude-tabbar .ctab-list::-webkit-scrollbar{height:0;display:none}",
    "#claude-tabbar .ctab-spacer{flex:1 1 auto;min-width:8px}",
    "#claude-tabbar .ctab{display:flex;align-items:center;gap:6px;max-width:340px;padding:0 8px;margin:5px 0;border-radius:7px;background:#262626;border:1px solid #333;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}",
    "#claude-tabbar .ctab:hover{background:#303030}",
    "#claude-tabbar .ctab.active{background:#2b3b55;border-color:#3d6cc4;color:#fff}",
    // per-session state dot
    "#claude-tabbar .ctab .ctab-state{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#6b7280}",
    "#claude-tabbar .ctab .ctab-state.thinking{background:#f59e0b}",
    "#claude-tabbar .ctab .ctab-state.waiting{background:#a855f7}",
    "#claude-tabbar .ctab .ctab-state.done{background:#22c55e}",
    "#claude-tabbar .ctab .ctab-state.seen{background:#6b7280}",
    "@media (prefers-reduced-motion:no-preference){#claude-tabbar .ctab .ctab-state.thinking,#claude-tabbar .ctab .ctab-state.waiting{animation:ctabPulse 1.1s ease-in-out infinite}}",
    "@keyframes ctabPulse{0%,100%{opacity:1}50%{opacity:.35}}",
    "#claude-tabbar .ctab .ctab-label{overflow:hidden;text-overflow:ellipsis;max-width:290px}",
    "#claude-tabbar .ctab .ctab-icon{display:flex;align-items:center;opacity:.55;border-radius:4px;padding:2px}",
    "#claude-tabbar .ctab .ctab-icon:hover{opacity:1;background:rgba(255,255,255,.12)}",
    "#claude-tabbar .ctab .ctab-close{font-size:15px;line-height:1;width:16px;height:16px;display:flex;align-items:center;justify-content:center;opacity:.5;border-radius:4px}",
    "#claude-tabbar .ctab .ctab-close:hover{opacity:1;background:rgba(255,80,80,.25);color:#fff}",
    "#claude-tabbar .ctab-btn{display:flex;align-items:center;justify-content:center;width:28px;flex:0 0 auto;margin:5px 0;border-radius:7px;background:#262626;border:1px solid #333;cursor:pointer;color:#cfcfcf}",
    "#claude-tabbar .ctab-btn:hover{background:#333;color:#fff}",
    "#claude-tabbar .ctab-new{font-size:18px;line-height:1}",
    "#claude-tabbar .ctab-usage{width:auto;padding:0 9px;gap:5px}",
    "#claude-tabbar .ctab-usage .ctab-usage-fig{font-size:11px;font-variant-numeric:tabular-nums}",
    // notification bell (green glow when on)
    "#claude-tabbar .ctab-bell.on{color:#22c55e;border-color:#2f6f43}",
    "body.theme-light #claude-tabbar .ctab-bell.on{color:#16a34a;border-color:#8fd0a6}",
    // install prompt banner (mobile)
    "#ct-install{position:fixed;left:12px;right:12px;bottom:14px;z-index:70;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:#201b18;border:1px solid #3a2f28;color:#f0e9e4;box-shadow:0 10px 34px rgba(0,0,0,.5);font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}",
    "#ct-install img{width:40px;height:40px;flex:0 0 auto}",
    "#ct-install .ct-inst-txt{flex:1;min-width:0}",
    "#ct-install .ct-inst-txt b{display:block;font-size:14px;margin-bottom:2px}",
    "#ct-install .ct-inst-txt span{opacity:.75;font-size:12px}",
    "#ct-install .ct-inst-go{flex:0 0 auto;padding:8px 14px;border-radius:9px;background:#D97757;color:#1a1108;font-weight:600;border:none;cursor:pointer;font-size:13px}",
    "#ct-install .ct-inst-go:active{filter:brightness(.92)}",
    "#ct-install .ct-inst-x{flex:0 0 auto;cursor:pointer;opacity:.55;font-size:20px;line-height:1;padding:2px 4px}",
    "#ct-install .ct-inst-x:hover{opacity:1}",
    "#ct-install.ios{align-items:flex-start}",
    // history dialog (resume a past conversation)
    "#ct-histmodal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.5)}",
    "#ct-histmodal .ct-hist{margin-top:" + (BAR_H + 12) + "px;width:min(640px,92vw);max-height:78vh;display:flex;flex-direction:column;background:#1e1e1e;color:#e6e6e6;border:1px solid #383838;border-radius:10px;overflow:hidden;box-shadow:0 12px 44px rgba(0,0,0,.55);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}",
    "#ct-histmodal .ct-hist-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #383838;font-weight:600}",
    "#ct-histmodal .ct-hist-search{margin:8px 10px 2px;padding:7px 10px;border-radius:7px;border:1px solid #3a3a3a;background:#161616;color:#e6e6e6;font:13px system-ui,sans-serif;outline:none}",
    "#ct-histmodal .ct-hist-search:focus{border-color:#3d6cc4}",
    "body.theme-light #ct-histmodal .ct-hist-search{background:#f6f6f6;border-color:#dcdcdc;color:#1f1f1f}",
    "#ct-histmodal .ct-hist-close{cursor:pointer;opacity:.6;font-size:19px;line-height:1;padding:0 4px}",
    "#ct-histmodal .ct-hist-close:hover{opacity:1}",
    "#ct-histmodal .ct-hist-list{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:6px}",
    "#ct-histmodal .ct-hist-row{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:7px;cursor:pointer}",
    "#ct-histmodal .ct-hist-row:hover{background:#2c2c2c}",
    "#ct-histmodal .ct-hist-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#ct-histmodal .ct-hist-sub{font-size:11px;color:#9a9a9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "body.theme-light #ct-histmodal .ct-hist{background:#fff;color:#1f1f1f;border-color:#dcdcdc}",
    "body.theme-light #ct-histmodal .ct-hist-head{border-color:#ececec}",
    "body.theme-light #ct-histmodal .ct-hist-row:hover{background:#f0f0f0}",
    "body.theme-light #ct-histmodal .ct-hist-sub{color:#777}",
    // external-networks modal (shares the histmodal card look)
    "#ct-connmodal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}",
    // applying overlay: covers the dialog with a spinner while a change is being applied
    // (the terminal reconnects behind it, so the list would otherwise flicker/empty out)
    "#ct-connmodal .ct-conn{position:relative}",
    "#ct-connmodal .ct-applying{position:absolute;inset:0;z-index:2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(30,30,30,.82);backdrop-filter:blur(2px);border-radius:10px;text-align:center;padding:20px}",
    "#ct-connmodal.applying .ct-applying{display:flex}",
    "#ct-connmodal .ct-applying .sp{width:34px;height:34px;border-radius:50%;border:3px solid #4a4a4a;border-top-color:#7C3AED;animation:ct-spin .8s linear infinite}",
    "#ct-connmodal .ct-applying .msg{font-size:13px;color:#d6d6d6;max-width:80%}",
    "@keyframes ct-spin{to{transform:rotate(360deg)}}",
    "@media (prefers-reduced-motion: reduce){#ct-connmodal .ct-applying .sp{animation-duration:2s}}",
    "body.theme-light #ct-connmodal .ct-applying{background:rgba(255,255,255,.85)}",
    "body.theme-light #ct-connmodal .ct-applying .msg{color:#333}",
    "#ct-connmodal .ct-conn{margin-top:" + (BAR_H + 12) + "px;width:min(640px,94vw);max-height:82vh;display:flex;flex-direction:column;background:#1e1e1e;color:#e6e6e6;border:1px solid #383838;border-radius:10px;overflow:hidden;box-shadow:0 12px 44px rgba(0,0,0,.55);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}",
    "#ct-connmodal .ct-conn-err{margin:0 0 10px;padding:9px 11px;border-radius:8px;font-size:12.5px;line-height:1.4;color:#fca5a5;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4)}", // ct-connerr
    "#ct-connmodal .ct-conn-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #383838;font-weight:600}",
    "#ct-connmodal .ct-conn-close{cursor:pointer;opacity:.6;font-size:19px;line-height:1;padding:0 4px}",
    "#ct-connmodal .ct-conn-close:hover{opacity:1}",
    "#ct-connmodal .ct-conn-body{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:10px 12px}",
    "#ct-connmodal .ct-conn-note{font-size:11px;color:#9a9a9a;margin:0 0 8px}",
    "#ct-connmodal .ct-tun{border:1px solid #333;border-radius:8px;padding:9px 10px;margin-bottom:8px}",
    "#ct-connmodal .ct-tun-top{display:flex;align-items:center;gap:8px}",
    "#ct-connmodal .ct-tun-name{font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#ct-connmodal .ct-badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:5px;background:#2b2b2b;color:#bbb}",
    "#ct-connmodal .ct-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#6b7280}",
    "#ct-connmodal .ct-dot.up{background:#22c55e}",
    "#ct-connmodal .ct-dot.down{background:#ef4444}",
    "#ct-connmodal .ct-dot.wait{background:#f59e0b}",
    "#ct-connmodal .ct-tun-sub{font-size:11px;color:#9a9a9a;margin-top:5px;word-break:break-word}",
    "#ct-connmodal .ct-tun-sub code{color:#cfcfcf}",
    "#ct-connmodal .ct-ic{cursor:pointer;opacity:.6;padding:3px 6px;border-radius:5px;font-size:12px}",
    "#ct-connmodal .ct-ic:hover{opacity:1;background:rgba(255,255,255,.12)}",
    "#ct-connmodal .ct-login{display:inline-block;margin-top:6px;padding:5px 10px;border-radius:6px;background:#7C3AED;color:#fff;text-decoration:none;font-weight:600}",
    "#ct-connmodal .ct-add-row{display:flex;gap:8px;margin:6px 0 12px}",
    "#ct-connmodal .ct-btn{cursor:pointer;padding:7px 11px;border-radius:7px;border:1px solid #3a3a3a;background:#262626;color:#e6e6e6;font:13px system-ui,sans-serif;font-weight:600}",
    "#ct-connmodal .ct-btn:hover{background:#2f2f2f}",
    "#ct-connmodal .ct-btn.primary{background:#7C3AED;border-color:#7C3AED;color:#fff}",
    "#ct-connmodal .ct-form{border:1px dashed #3a3a3a;border-radius:8px;padding:10px;margin-bottom:12px;display:none}",
    "#ct-connmodal .ct-form.open{display:block}",
    "#ct-connmodal .ct-form label{display:block;font-size:11px;color:#9a9a9a;margin:8px 0 3px}",
    "#ct-connmodal .ct-form input,#ct-connmodal .ct-form textarea{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid #3a3a3a;background:#161616;color:#e6e6e6;font:12px ui-monospace,Menlo,Consolas,monospace;outline:none}",
    "#ct-connmodal .ct-form input:focus,#ct-connmodal .ct-form textarea:focus{border-color:#7C3AED}",
    "#ct-connmodal .ct-form textarea{resize:vertical;min-height:90px}",
    "body.theme-light #ct-connmodal .ct-conn{background:#fff;color:#1f1f1f;border-color:#dcdcdc}",
    "body.theme-light #ct-connmodal .ct-conn-head{border-color:#ececec}",
    "body.theme-light #ct-connmodal .ct-tun{border-color:#e2e2e2}",
    "body.theme-light #ct-connmodal .ct-badge{background:#eee;color:#555}",
    "body.theme-light #ct-connmodal .ct-btn{background:#f2f2f2;border-color:#dcdcdc;color:#1f1f1f}",
    "body.theme-light #ct-connmodal .ct-form input,body.theme-light #ct-connmodal .ct-form textarea{background:#f6f6f6;border-color:#dcdcdc;color:#1f1f1f}",
    // hamburger (mobile only) + left drawer with the full tab list
    "#claude-tabbar .ctab-ham{display:none}",
    "@media (max-width:600px){#claude-tabbar .ctab-ham{display:flex}#claude-tabbar .ctab-list .ctab:not(.active){display:none}#claude-tabbar .ctab{max-width:60vw}#claude-tabbar .ctab .ctab-label{max-width:44vw}}",
    "#ct-drawer{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5)}",
    "#ct-drawer .ct-draw{position:absolute;top:0;left:0;bottom:0;width:min(300px,84vw);background:#1e1e1e;color:#e6e6e6;border-right:1px solid #383838;display:flex;flex-direction:column;box-shadow:2px 0 26px rgba(0,0,0,.5);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}",
    "#ct-drawer .ct-draw-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid #383838;font-weight:600}",
    "#ct-drawer .ct-draw-list{overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:6px}",
    "#ct-drawer .ct-draw-row{display:flex;align-items:center;gap:9px;padding:11px 10px;border-radius:8px;cursor:pointer}",
    "#ct-drawer .ct-draw-row:hover{background:#2c2c2c}",
    "#ct-drawer .ct-draw-row.active{background:#2b3b55}",
    "#ct-drawer .ct-draw-row .lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#ct-drawer .ct-draw-row .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:#6b7280}",
    "#ct-drawer .ct-draw-row .dot.thinking{background:#f59e0b}",
    "#ct-drawer .ct-draw-row .dot.waiting{background:#a855f7}",
    "#ct-drawer .ct-draw-row .dot.done{background:#22c55e}",
    "#ct-drawer .ct-draw-row .dot.seen{background:#6b7280}",
    "#ct-drawer .ct-draw-row .ic{display:flex;align-items:center;opacity:.6;padding:4px;border-radius:5px}",
    "#ct-drawer .ct-draw-row .ic:hover{opacity:1;background:rgba(255,255,255,.14)}",
    "#ct-drawer .ct-draw-row .ic.x{font-size:17px;line-height:1}",
    "#ct-drawer .ct-draw-new{opacity:.85;font-weight:600}",
    "body.theme-light #ct-drawer .ct-draw{background:#fff;color:#1f1f1f;border-color:#dcdcdc}",
    "body.theme-light #ct-drawer .ct-draw-head{border-color:#ececec}",
    "body.theme-light #ct-drawer .ct-draw-row:hover{background:#f0f0f0}",
    "body.theme-light #ct-drawer .ct-draw-row.active{background:#dce8ff}",
    "body.theme-light #ct-drawer .ct-draw-row .ic:hover{background:rgba(0,0,0,.08)}",
    // light theme (ttyd toggles body.theme-light)
    "body.theme-light #claude-tabbar{background:#f3f3f3;border-bottom-color:#dcdcdc;color:#333}",
    "body.theme-light #claude-tabbar .ctab{background:#fff;border-color:#d7d7d7}",
    "body.theme-light #claude-tabbar .ctab:hover{background:#ececec}",
    "body.theme-light #claude-tabbar .ctab.active{background:#dce8ff;border-color:#3d6cc4;color:#12305e}",
    "body.theme-light #claude-tabbar .ctab-btn{background:#fff;border-color:#d7d7d7;color:#444}",
    "body.theme-light #claude-tabbar .ctab-btn:hover{background:#ececec;color:#000}",
    // tighter on small screens; theme toggle folds into the drawer on mobile
    "@media (max-width:600px){#claude-tabbar{gap:4px;padding:0 5px}#claude-tabbar .ctab{max-width:220px}#claude-tabbar .ctab .ctab-label{max-width:170px}#claude-tabbar .ctab-theme,#claude-tabbar .ctab-bell{display:none}}",
    // drawer settings rows (theme + notifications live here on mobile)
    "#ct-drawer .ct-draw-sep{height:1px;margin:6px 10px;background:#333}",
    "body.theme-light #ct-drawer .ct-draw-sep{background:#e2e2e2}",
    "#ct-drawer .ct-draw-row .ic-lead{display:flex;align-items:center;opacity:.8;flex:0 0 auto}",
    "#ct-drawer .ct-draw-row .sub{font-size:11px;opacity:.6;margin-left:auto;flex:0 0 auto}",
    // hide ttyd's own floating theme toggle; we drive it from the bar
    ".theme-toggle{display:none !important}",
  ].join("");
  (document.head || document.documentElement).appendChild(barStyle);

  const bar = document.createElement("div");
  bar.id = "claude-tabbar";
  const listEl = document.createElement("div");
  listEl.className = "ctab-list";
  const newBtn = document.createElement("div");
  newBtn.className = "ctab-btn ctab-new";
  newBtn.textContent = "+";
  newBtn.title = "New session";
  const spacer = document.createElement("div");
  spacer.className = "ctab-spacer";
  const usageBtn = document.createElement("a");
  usageBtn.className = "ctab-btn ctab-usage";
  usageBtn.title = "Claude usage";
  usageBtn.href = "https://users.filipkin.com/usage/";
  usageBtn.target = "_blank";
  usageBtn.rel = "noopener";
  usageBtn.innerHTML = SVG_USAGE;
  const themeBtn = document.createElement("div");
  themeBtn.className = "ctab-btn ctab-theme";
  themeBtn.title = "Toggle light/dark";
  themeBtn.innerHTML = SVG_SUN; // default so it's never blank before the theme loads
  const historyBtn = document.createElement("div");
  historyBtn.className = "ctab-btn ctab-history";
  historyBtn.title = "Conversation history (resume a past chat)";
  historyBtn.innerHTML = SVG_HISTORY;
  const chatBtn = document.createElement("a"); // open the Claude-app-style chat UI (/app)
  chatBtn.className = "ctab-btn ctab-chat";
  chatBtn.title = "Open chat app";
  chatBtn.href = "/app";
  chatBtn.innerHTML = SVG_CHAT;
  chatBtn.style.display = "none"; // shown only for the owner (guests get 403 on the probe)
  const hamBtn = document.createElement("div");
  hamBtn.className = "ctab-btn ctab-ham";
  hamBtn.title = "All tabs";
  hamBtn.innerHTML = SVG_HAM;
  const netBtn = document.createElement("div"); // external networks (VPN / Tailscale)
  netBtn.className = "ctab-btn ctab-net";
  netBtn.title = "External networks (VPN / Tailscale)";
  netBtn.innerHTML = SVG_NET;
  netBtn.style.display = "none"; // shown only if the server reports the feature enabled
  const bellBtn = document.createElement("div"); // desktop only (mobile uses the drawer)
  bellBtn.className = "ctab-btn ctab-bell";
  bellBtn.title = "Enable notifications";
  bellBtn.innerHTML = SVG_BELL_OFF;
  // tabs, then + right after them (left-aligned), spacer pushes the rest right;
  // history sits all the way on the right end.
  bar.appendChild(hamBtn); // mobile-only, leftmost
  bar.appendChild(listEl);
  bar.appendChild(newBtn);
  bar.appendChild(spacer);
  bar.appendChild(bellBtn); // hidden on mobile (moves into the drawer)
  bar.appendChild(netBtn);
  bar.appendChild(chatBtn); // link out to the /app chat UI
  bar.appendChild(historyBtn);
  bar.appendChild(themeBtn); // hidden on mobile (moves into the drawer)
  bar.appendChild(usageBtn);

  function mountBar() {
    // Mount the bar OUTSIDE <body>, as a direct child of <html>. This is THE fix for
    // "the tab bar disappears once ttyd loads": ttyd's client calls
    // render(h(App), document.body), and Preact's reconciler removes any DOM in <body>
    // it doesn't own as "excess" on EVERY (re)render — initial connect, reconnect,
    // title change, resize-overlay toggle. So the bar painted on load was silently
    // evicted the moment ttyd finished mounting, taking the keyboard-shift target with
    // it. document.documentElement is never a Preact render root here, so a
    // fixed-position bar parked there survives every ttyd render. (Both injected <style>
    // blocks already live in <head> for exactly this reason.)
    const root = document.documentElement;
    if (!root) return;
    if (bar.parentNode !== root) root.appendChild(bar);
    setTimeout(reflow, 50);
  }
  // Insurance: if the bar is ever detached from <html> (a future full-document rewrite,
  // some other script), re-mount it on the next tick. childList on documentElement only
  // (no subtree), so this fires on the rare add/remove of a direct child of <html> —
  // never on ttyd's terminal output — keeping it effectively free.
  new MutationObserver(() => {
    if (!bar.isConnected) mountBar();
  }).observe(document.documentElement, { childList: true });

  function switchTo(id) {
    const p = new URLSearchParams(location.search);
    p.set("arg", id);
    location.search = "?" + p.toString();
  }

  async function api(path, opts) {
    return fetch("/_ct/" + path, Object.assign({ credentials: "same-origin" }, opts));
  }

  let lastSessions = [];
  let lastScrolledId = null;
  const CACHE_KEY = "ct-last-sessions";
  async function closeSession(id) {
    const wasCurrent = id === curId();
    // pick where to land: the previous tab in order, else the next, else main
    const order = lastSessions.map((s) => s.id);
    const idx = order.indexOf(id);
    let target = MAIN_ID;
    if (idx > 0) target = order[idx - 1];
    else if (idx === 0 && order[1]) target = order[1];
    try {
      await api("sessions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (e) {
      log("close failed", e);
    }
    if (id === MAIN_ID) {
      // closing main just restarts it (reattaching to ?arg=1 recreates the session)
      if (wasCurrent) switchTo(MAIN_ID);
      else refresh();
    } else if (wasCurrent) {
      switchTo(target);
    } else {
      refresh();
    }
  }

  async function newSession() {
    try {
      const r = await api("sessions/new", { method: "POST" });
      const { id } = await r.json();
      switchTo(id); // open the new session in the CURRENT browser tab
    } catch (e) {
      showToast("Could not create session", "error");
    }
  }

  const STATE_WORD = { thinking: "working", waiting: "waiting for you", done: "done", seen: "idle" };
  const STATES = ["thinking", "waiting", "done", "seen"];
  function renderChip(s, active) {
    const state = STATES.includes(s.state) ? s.state : "seen";
    // Server standard: ai-title once the conversation has one, else "New Tab" for a
    // numeric tab (main "1" or a freshly-opened one), else the named session's name.
    const displayLabel = s.title;

    const chip = document.createElement("div");
    chip.className = "ctab" + (active ? " active" : "");
    chip.title = displayLabel + "  (#" + s.id + " · " + (STATE_WORD[state] || "idle") + ")";

    const dot = document.createElement("span");
    dot.className = "ctab-state " + state;
    chip.appendChild(dot);

    const label = document.createElement("span");
    label.className = "ctab-label";
    label.textContent = displayLabel;
    chip.appendChild(label);

    const open = document.createElement("span");
    open.className = "ctab-icon";
    open.innerHTML = SVG_OPEN;
    open.title = "Open in new browser tab";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open("/?arg=" + encodeURIComponent(s.id), "_blank");
    });
    chip.appendChild(open);

    const close = document.createElement("span");
    if (s.id === MAIN_ID) {
      // main can't really be closed; its button restarts it, so show a refresh icon
      close.className = "ctab-icon ctab-restart";
      close.innerHTML = SVG_REFRESH;
      close.title = "Restart main session";
    } else {
      close.className = "ctab-close";
      close.textContent = "×";
      close.title = "Close session";
    }
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(s.id);
    });
    chip.appendChild(close);

    chip.addEventListener("click", () => {
      if (s.id !== curId()) switchTo(s.id);
    });
    return chip;
  }

  function setTitle(sessions) {
    const cur = sessions.find((s) => s.id === curId());
    if (cur && cur.title) {
      const desired = cur.title;
      if (document.title !== desired) document.title = desired;
      lockedTitle = desired;
    }
  }

  let lockedTitle = null;
  // ttyd/tmux keep re-setting the title from terminal OSC sequences; re-assert ours.
  new MutationObserver(() => {
    if (lockedTitle && document.title !== lockedTitle) document.title = lockedTitle;
  }).observe(document.querySelector("title") || document.head, { childList: true });

  function hideBar() {
    // guests get 403 / no sidecar -> hide the bar and give the terminal its space back
    bar.style.display = "none";
    const tc = document.getElementById("terminal-container");
    if (tc) {
      tc.style.top = "0px";
      tc.style.height = "100%";
    }
    reflow();
  }

  async function refresh() {
    let sessions;
    try {
      const r = await api("sessions");
      // A 403 = the server's allowed() said "you're not the owner". Two very
      // different things produce it: a genuine guest with no sidecar (hide the bar
      // for good), OR — on a long-idle mobile PWA — a transient moment where the
      // Authelia session is renewing and a single poll reaches the sidecar without
      // the owner's Remote-User header. A genuine guest NEVER gets a successful
      // poll, so their tab cache stays empty; the owner always has cached tabs. So
      // only hide when we've never seen owner tabs in this browser; otherwise treat
      // the 403 as a transient blip and keep the bar (it self-heals on the next OK
      // poll). This was the residual "tabs still disappear on mobile" cause: an
      // owner session hiccup was being misread as "guest" and the bar hidden until
      // a full reload + reauth.
      // ANY other failure (network blip on a mobile wake, a 5xx, or an expired auth
      // cookie that 302s us to an HTML login page so .json() throws) is likewise
      // temporary: keep the last-known tabs rather than wiping the bar.
      if (r.status === 403) {
        if (!localStorage.getItem(CACHE_KEY)) { hideBar(); return; }
        log("sessions 403 but owner tabs are cached -> transient auth blip, keeping bar");
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      sessions = await r.json();
    } catch (e) {
      // transient: don't touch the DOM. If we've never rendered tabs, leave the bar
      // as-is (hidden by default); otherwise the existing chips stay put until the
      // next successful poll re-syncs them.
      log("sessions poll failed, keeping last bar", e);
      return;
    }
    // A 200 is not enough to trust the body. Two transient shapes must NOT be allowed
    // to wipe the bar or poison the cache:
    //   1. A non-array (an auth 302 to a login page that still parsed, a proxy hiccup).
    //   2. An EMPTY list. The page you're viewing is itself backed by a live tmux
    //      session, so a real steady state is never zero sessions — an empty list means
    //      tmux was momentarily unqueryable, which is exactly what happens while the
    //      ttyd websocket re-attaches during the reload a tab switch triggers. This was
    //      the residual "tabs disappear when I switch tabs" cause: one contended poll
    //      returned [], we cached [] and repainted to just the main chip, and every
    //      later reload then seeded from that poisoned empty cache.
    // In both cases: keep the last-known bar and the last-known cache; self-heals on
    // the next good poll.
    if (!Array.isArray(sessions)) { log("sessions poll gave non-array -> transient, keeping bar"); return; }
    if (sessions.length === 0) { log("sessions poll empty -> transient tmux blip, keeping bar"); return; }
    // Persist the live tab set so the NEXT page load (every tab switch is a full
    // reload) can paint the bar instantly from cache, before this poll's replacement
    // returns. Without this the bar flashes empty on every switch — the "tabs
    // disappear when I switch tabs" symptom on mobile, where the reload + first poll
    // is slowest.
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(sessions)); } catch (e) {}
    paintBar(sessions, true);
  }

  // Render the bar from a sessions array. live=true means this came from a fresh
  // poll (fold in the pinned main chip, mark the current "done" tab seen); live=false
  // is a cache seed painted on load and must not send any state-changing request.
  function paintBar(sessions, live) {
    bar.style.display = "";
    // guarantee a pinned main chip even if no one is attached to it yet
    if (!sessions.some((s) => s.id === MAIN_ID)) {
      sessions.unshift({ id: MAIN_ID, title: "New Tab", created: 0, attached: false, state: "seen" });
    }
    // Never let the tab you're actually on vanish. If the current ?arg isn't in this
    // list yet — a just-switched-to or just-spawned tab a slow first poll hasn't caught
    // up to, or a stale cache seed — synthesize a chip for it, reusing the last-known
    // title if we have one. Critical on mobile, where CSS shows ONLY the active chip:
    // without this you'd switch to a tab and see the main chip instead until the poll
    // lands. The next poll replaces this with the authoritative row.
    const curArg = curId();
    if (curArg !== MAIN_ID && !sessions.some((s) => s.id === curArg)) {
      const prev = lastSessions.find((s) => s.id === curArg);
      sessions.push(prev || { id: curArg, title: /^\d+$/.test(curArg) ? "New Tab" : curArg, created: 0, attached: true, state: "seen" });
    }
    mountBar();
    lastSessions = sessions;
    // On mobile the CSS hides every non-active chip (only the current tab shows,
    // the rest live in the drawer). If the current ?arg session isn't in this list
    // — a just-spawned tab not yet in the poll, or a stale cache seed — nothing
    // matches and the whole list blanks on phones. Fall back to the always-present
    // main chip so the bar never looks empty; the next poll corrects the highlight.
    const cur = sessions.some((s) => s.id === curId()) ? curId() : MAIN_ID;
    // You're looking at this tab, so a finished-and-unseen "done" (green) becomes
    // "seen" (gray) — you've laid eyes on it. A real "waiting" ask stays purple even
    // while viewed (cleared only when it's answered). Only affects the current tab.
    const curSess = sessions.find((s) => s.id === cur);
    if (curSess && curSess.state === "done") {
      curSess.state = "seen";
      if (live) api("sessions/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cur }),
      }).catch(() => {});
    }
    listEl.innerHTML = "";
    let activeEl = null;
    for (const s of sessions) {
      const chip = renderChip(s, s.id === cur);
      if (s.id === cur) activeEl = chip;
      listEl.appendChild(chip);
    }
    // after a switch/reload, make sure the tab you're now on is visible in the
    // horizontal scroll (matters most on mobile). Only scroll when it changes.
    if (activeEl && lastScrolledId !== cur) {
      lastScrolledId = cur;
      requestAnimationFrame(() => {
        try {
          activeEl.scrollIntoView({ block: "nearest", inline: "center" });
        } catch (e) {
          /* older browsers: ignore */
        }
      });
    }
    setTitle(sessions);
  }

  // Paint the last-known tabs from cache the instant the overlay loads, so a tab
  // switch (which reloads the whole page) never shows an empty bar while the first
  // /sessions poll is in flight. The poll then replaces this with live state.
  function seedFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length) paintBar(cached, false);
    } catch (e) {}
  }

  // #region theme toggle (folds ttyd's native toggle + flips Claude Code's theme)
  const isLight = () => document.body.classList.contains("theme-light");
  function paintThemeBtn() {
    themeBtn.innerHTML = isLight() ? SVG_MOON : SVG_SUN;
  }
  function ttydToggle() {
    const native = document.querySelector(".theme-toggle");
    if (native) native.click();
  }
  async function setTheme(light) {
    if (isLight() !== light) ttydToggle(); // flip the web terminal (xterm + bg)
    try {
      await api("theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: light ? "light" : "dark" }),
      });
    } catch (e) {
      log("theme post failed", e);
    }
    paintThemeBtn();
  }
  themeBtn.addEventListener("click", () => setTheme(!isLight()));
  // On load, make the web terminal match Claude Code's saved theme (source of truth).
  (async () => {
    try {
      const r = await api("theme");
      if (r.ok) {
        const { theme } = await r.json();
        if ((theme === "light") !== isLight()) ttydToggle();
      }
    } catch (e) {
      /* ignore */
    }
    paintThemeBtn();
  })();
  // #endregion

  // #region usage figure (in the usage button)
  function fmtCompact(n) {
    if (n == null || isNaN(n)) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return String(n);
  }
  async function refreshUsage() {
    try {
      const r = await api("usage");
      if (!r.ok) return;
      const u = await r.json();
      const fig = fmtCompact(u.output_5h);
      usageBtn.innerHTML = SVG_USAGE + (fig ? '<span class="ctab-usage-fig">' + fig + "</span>" : "");
      const parts = [];
      if (u.share_usd != null) parts.push("$" + u.share_usd + " this month");
      if (u.output_5h != null) parts.push(fmtCompact(u.output_5h) + " output last 5h");
      usageBtn.title = parts.length ? "Claude usage — " + parts.join(" · ") : "Claude usage";
    } catch (e) {
      /* ignore */
    }
  }
  refreshUsage();
  setInterval(refreshUsage, 60000);
  // #endregion

  // #region conversation history dialog (resume, like /resume)
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return Math.floor(m) + "m ago";
    const h = m / 60; if (h < 24) return Math.floor(h) + "h ago";
    const d = h / 24; if (d < 30) return Math.floor(d) + "d ago";
    return new Date(ms).toLocaleDateString();
  }
  let histEl = null, histEsc = null;
  function closeHistory() {
    if (histEl) { histEl.remove(); histEl = null; }
    if (histEsc) { document.removeEventListener("keydown", histEsc, true); histEsc = null; }
  }
  async function resumeConversation(sessionId, cwd) {
    try {
      const r = await api("sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: sessionId, cwd: cwd || "" }),
      });
      const { id } = await r.json();
      closeHistory();
      switchTo(id); // open the resumed conversation in the current tab
    } catch (e) {
      showToast("Could not resume", "error");
    }
  }
  async function openHistory() {
    if (histEl) { closeHistory(); return; }
    let rows;
    try {
      const r = await api("history");
      if (!r.ok) throw new Error(String(r.status));
      rows = await r.json();
    } catch (e) {
      showToast("Could not load history", "error");
      return;
    }
    histEl = document.createElement("div");
    histEl.id = "ct-histmodal";
    const panel = document.createElement("div");
    panel.className = "ct-hist";
    const head = document.createElement("div");
    head.className = "ct-hist-head";
    const h = document.createElement("span");
    h.textContent = "Resume a conversation";
    const x = document.createElement("span");
    x.className = "ct-hist-close";
    x.textContent = "×";
    x.addEventListener("click", closeHistory);
    head.appendChild(h);
    head.appendChild(x);
    const search = document.createElement("input");
    search.className = "ct-hist-search";
    search.type = "text";
    search.placeholder = "Search conversations…";
    const list = document.createElement("div");
    list.className = "ct-hist-list";
    function renderList(q) {
      q = (q || "").trim().toLowerCase();
      list.innerHTML = "";
      const shown = rows.filter((c) => !q
        || (c.title || c.sessionId).toLowerCase().includes(q)
        || (c.cwd || "").toLowerCase().includes(q));
      if (!shown.length) {
        const e = document.createElement("div");
        e.className = "ct-hist-row";
        e.textContent = rows.length ? "No matches." : "No past conversations found.";
        list.appendChild(e);
        return;
      }
      for (const c of shown) {
        const row = document.createElement("div");
        row.className = "ct-hist-row";
        const t = document.createElement("div");
        t.className = "ct-hist-title";
        t.textContent = c.title || c.sessionId;
        const sub = document.createElement("div");
        sub.className = "ct-hist-sub";
        const where = c.cwd ? " · " + c.cwd.replace(/^\/home\/[^/]+/, "~") : "";
        sub.textContent = ago(c.mtime) + where;
        row.appendChild(t);
        row.appendChild(sub);
        row.title = (c.title || c.sessionId) + (c.cwd ? "  (" + c.cwd + ")" : "");
        row.addEventListener("click", () => resumeConversation(c.sessionId, c.cwd));
        list.appendChild(row);
      }
    }
    search.addEventListener("input", () => renderList(search.value));
    renderList("");
    panel.appendChild(head);
    panel.appendChild(search);
    panel.appendChild(list);
    histEl.appendChild(panel);
    histEl.addEventListener("click", (e) => { if (e.target === histEl) closeHistory(); });
    (document.documentElement || document.body).appendChild(histEl);
    search.focus();
    histEsc = (e) => { if (e.key === "Escape") closeHistory(); };
    document.addEventListener("keydown", histEsc, true);
  }
  historyBtn.addEventListener("click", openHistory);
  // #endregion

  // #region external networks (VPN / Tailscale) modal
  let connEl = null, connEsc = null, connPoll = null;
  let connData = { tunnels: [] };   // latest /connections payload
  let connApply = null;             // {msg, check(data), started} while a change applies
  let connMsgEl = null;             // spinner message element
  function closeConn() {
    if (connPoll) { clearInterval(connPoll); connPoll = null; }
    if (connEl) { connEl.remove(); connEl = null; }
    if (connEsc) { document.removeEventListener("keydown", connEsc, true); connEsc = null; }
    connApply = null;
  }
  // A change (add / toggle / remove) recouples the guest onto the network hub, which
  // restarts the terminal + this sidecar — so the request's response is unreliable and
  // the list would momentarily empty out. Cover the dialog with a spinner and hold it
  // until the polled state actually reflects the change (or a safety timeout).
  function beginApply(msg, check) {
    connApply = { msg, check, started: Date.now() };
    if (connEl) connEl.classList.add("applying");
    if (connMsgEl) connMsgEl.textContent = msg;
  }
  function resolveApply() {
    if (!connApply) return;
    const done = connApply.check(connData) || (Date.now() - connApply.started > 60000);
    if (done) { connApply = null; if (connEl) connEl.classList.remove("applying"); }
  }
  // fire a mutating request but tolerate a dropped response (the recouple kills us mid-flight)
  function fireMutation(method, path, body) {
    api(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
  }
  function dotFor(t) {
    if (t.type === "tailscale") {
      if (t.needsLogin) return ["wait", "needs login"];
      if (t.up) return ["up", "connected" + (t.ip ? " · " + t.ip : "")];
      return ["down", t.state || "off"];
    }
    if (t.enabled === false) return ["down", "disabled"];
    return t.up ? ["up", "up"] : ["down", t.error || "down"];
  }
  function renderTunnels(listEl, data) {
    const st = {};
    for (const s of (data.status && data.status.tunnels) || []) st[s.id] = s;
    listEl.innerHTML = "";
    const tuns = data.tunnels || [];
    // A whole-apply failure (the hub or a tunnel didn't come up) is reported here so it is impossible
    // to miss: the applier restores the session and writes this so the user sees WHAT failed, not a
    // dead page. Per-tunnel reasons still show on each row below. // ct-connerr
    if (data.status && data.status.error) {
      const err = document.createElement("div"); err.className = "ct-conn-err"; err.textContent = data.status.error;
      listEl.appendChild(err);
    }
    if (!tuns.length) {
      const e = document.createElement("div");
      e.className = "ct-conn-note";
      e.textContent = "No connections yet. Add an OpenVPN config or connect Tailscale below.";
      listEl.appendChild(e);
      return;
    }
    for (const t of tuns) {
      const s = st[t.id] || {};
      const merged = Object.assign({}, t, s);
      const [cls, txt] = dotFor(merged);
      const row = document.createElement("div");
      row.className = "ct-tun";
      const top = document.createElement("div");
      top.className = "ct-tun-top";
      const dot = document.createElement("span"); dot.className = "ct-dot " + cls;
      const name = document.createElement("span"); name.className = "ct-tun-name"; name.textContent = t.name;
      const badge = document.createElement("span"); badge.className = "ct-badge"; badge.textContent = t.type === "tailscale" ? "tailscale" : "openvpn";
      const status = document.createElement("span"); status.style.cssText = "font-size:11px;color:#9a9a9a"; status.textContent = txt;
      top.appendChild(dot); top.appendChild(name); top.appendChild(badge); top.appendChild(status);
      if (t.type === "openvpn") {
        const tog = document.createElement("span"); tog.className = "ct-ic";
        tog.textContent = t.enabled ? "disable" : "enable";
        tog.addEventListener("click", () => { beginApply("Updating " + t.name + "…", (d) => { const x = d.tunnels.find((y) => y.id === t.id); return x && x.enabled === !t.enabled; }); fireMutation("POST", "connections/" + t.id + "/enable", { on: !t.enabled }); });
        top.appendChild(tog);
      }
      const del = document.createElement("span"); del.className = "ct-ic"; del.textContent = "×"; del.style.fontSize = "16px";
      del.title = "Remove";
      del.addEventListener("click", () => { if (confirm("Remove " + t.name + "?")) { beginApply("Removing " + t.name + "…", (d) => !d.tunnels.some((y) => y.id === t.id)); fireMutation("DELETE", "connections/" + t.id); } });
      top.appendChild(del);
      row.appendChild(top);
      // detail line: remaps for openvpn, login link for tailscale
      if (merged.needsLogin && merged.loginUrl) {
        const a = document.createElement("a");
        a.className = "ct-login"; a.href = merged.loginUrl; a.target = "_blank"; a.rel = "noopener";
        a.textContent = "Log in to Tailscale ↗";
        row.appendChild(a);
      } else if (t.type === "openvpn") {
        // prefer live remaps from status (auto-detected ones are allocated at connect time)
        const rm = (merged.remaps && merged.remaps.length ? merged.remaps : t.remaps) || [];
        if (rm.length) {
          const sub = document.createElement("div");
          sub.className = "ct-tun-sub";
          sub.innerHTML = "reach via " + rm.map((r) => "<code>" + r.fake + "</code> → " + r.real).join(", ");
          row.appendChild(sub);
        } else if (merged.detected && merged.detected.length) {
          const sub = document.createElement("div"); sub.className = "ct-tun-sub";
          sub.textContent = "detected " + merged.detected.join(", ") + " — mapping…";
          row.appendChild(sub);
        } else if (merged.up) {
          const sub = document.createElement("div"); sub.className = "ct-tun-sub";
          sub.textContent = "up — detecting reachable subnets…";
          row.appendChild(sub);
        }
      }
      listEl.appendChild(row);
    }
  }
  let connListEl = null;
  async function openConnections() {
    if (connEl) { closeConn(); return; }
    try {
      const r = await api("connections");
      connData = await r.json();
      if (!connData.enabled) { showToast("Network connections are not enabled here", "error"); return; }
    } catch (e) { showToast("Could not load connections", "error"); return; }

    connEl = document.createElement("div"); connEl.id = "ct-connmodal";
    const panel = document.createElement("div"); panel.className = "ct-conn";
    const head = document.createElement("div"); head.className = "ct-conn-head";
    const h = document.createElement("span"); h.textContent = "External networks";
    const x = document.createElement("span"); x.className = "ct-conn-close"; x.textContent = "×"; x.addEventListener("click", closeConn);
    head.appendChild(h); head.appendChild(x);
    // spinner overlay shown while a change applies (terminal reconnects behind the blur)
    const applying = document.createElement("div"); applying.className = "ct-applying";
    const sp = document.createElement("div"); sp.className = "sp";
    connMsgEl = document.createElement("div"); connMsgEl.className = "msg"; connMsgEl.textContent = "Applying…";
    applying.appendChild(sp); applying.appendChild(connMsgEl);
    const body = document.createElement("div"); body.className = "ct-conn-body";
    const note = document.createElement("div"); note.className = "ct-conn-note";
    note.textContent = "Reach a remote LAN over your own VPN or Tailscale. Overlapping subnets get a unique local range automatically.";
    connListEl = document.createElement("div");
    renderTunnels(connListEl, connData);

    // add buttons
    const addRow = document.createElement("div"); addRow.className = "ct-add-row";
    const addVpn = document.createElement("button"); addVpn.className = "ct-btn"; addVpn.textContent = "+ OpenVPN";
    const addTs = document.createElement("button"); addTs.className = "ct-btn"; addTs.textContent = "+ Tailscale";
    addRow.appendChild(addVpn); addRow.appendChild(addTs);

    // OpenVPN form. Subnets optional: blank -> auto-detect the routes the server pushes.
    const vf = document.createElement("div"); vf.className = "ct-form";
    vf.innerHTML =
      '<label>Name</label><input class="c-name" placeholder="work vpn">' +
      '<label>Target subnet(s) to reach — comma separated, or leave blank to auto-detect</label><input class="c-subnets" placeholder="auto-detect (or e.g. 192.168.2.0/24, 10.10.0.0/24)">' +
      '<label>.ovpn config (paste, or load a file)</label><input type="file" class="c-file" accept=".ovpn,.conf,text/plain"><textarea class="c-ovpn" placeholder="dev tun\\nremote vpn.example.com 1194\\n..."></textarea>' +
      '<label>Username (if the VPN needs one)</label><input class="c-user" placeholder="optional">' +
      '<label>Password</label><input class="c-pass" type="password" placeholder="optional">';
    const vfAdd = document.createElement("button"); vfAdd.className = "ct-btn primary"; vfAdd.textContent = "Add & connect"; vfAdd.style.marginTop = "10px";
    vf.appendChild(vfAdd);
    vf.querySelector(".c-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const rd = new FileReader(); rd.onload = () => { vf.querySelector(".c-ovpn").value = rd.result; }; rd.readAsText(f);
    });
    vfAdd.addEventListener("click", () => {
      const name = vf.querySelector(".c-name").value.trim();
      const subnets = vf.querySelector(".c-subnets").value.split(",").map((s) => s.trim()).filter(Boolean);
      const ovpn = vf.querySelector(".c-ovpn").value;
      const user = vf.querySelector(".c-user").value.trim();
      const pass = vf.querySelector(".c-pass").value;
      const creds = user ? user + "\n" + pass : "";
      if (!ovpn.trim()) { showToast("Paste or load a .ovpn config", "error"); return; }
      const pre = connData.tunnels.length;
      vf.classList.remove("open"); vf.querySelectorAll("input,textarea").forEach((el) => (el.value = ""));
      beginApply("Connecting " + (name || "VPN") + "… the terminal will reconnect.", (d) => d.tunnels.length > pre);
      fireMutation("POST", "connections/openvpn", { name, subnets, ovpn, creds });
    });

    // Tailscale form. Single "name" = how THIS Claude server appears on your tailnet;
    // the tailnet hostname is auto-generated from it (ct-<slug>).
    const tf = document.createElement("div"); tf.className = "ct-form";
    tf.innerHTML =
      '<label>Name for this Claude sandbox on YOUR Tailscale</label>' +
      '<input class="c-tsname" placeholder="claude-sandbox">' +
      '<div class="ct-tun-sub">This names the Claude server as a device in your own Tailscale account (it appears as <code>ct-&lt;name&gt;</code>). It is not one of your existing devices — you are adding this sandbox to your tailnet.</div>';
    const tfAdd = document.createElement("button"); tfAdd.className = "ct-btn primary"; tfAdd.textContent = "Connect Tailscale"; tfAdd.style.marginTop = "10px";
    tf.appendChild(tfAdd);
    tfAdd.addEventListener("click", () => {
      const name = tf.querySelector(".c-tsname").value.trim();
      const pre = connData.tunnels.length;
      tf.classList.remove("open"); tf.querySelector(".c-tsname").value = "";
      beginApply("Starting Tailscale… a login link will appear once it's up.", (d) => d.tunnels.length > pre);
      fireMutation("POST", "connections/tailscale", { name });
    });

    addVpn.addEventListener("click", () => { tf.classList.remove("open"); vf.classList.toggle("open"); });
    addTs.addEventListener("click", () => { vf.classList.remove("open"); tf.classList.toggle("open"); });

    body.appendChild(note);
    body.appendChild(connListEl);
    body.appendChild(addRow);
    body.appendChild(vf);
    body.appendChild(tf);
    panel.appendChild(head); panel.appendChild(applying); panel.appendChild(body); connEl.appendChild(panel);
    connEl.addEventListener("click", (e) => { if (e.target === connEl && !connApply) closeConn(); });
    (document.documentElement || document.body).appendChild(connEl);
    connEsc = (e) => { if (e.key === "Escape" && !connApply) closeConn(); };
    document.addEventListener("keydown", connEsc, true);

    // live refresh: pull the full state (list + embedded status), re-render, and clear
    // the applying spinner once the change is reflected. Failures (mid-reconnect) are
    // ignored so the spinner holds instead of flashing an empty list.
    async function refresh() {
      try {
        const r = await api("connections");
        const d = await r.json();
        if (d && d.enabled) { connData = d; renderTunnels(connListEl, connData); resolveApply(); }
      } catch {}
    }
    connPoll = setInterval(refresh, 2000);
  }
  netBtn.addEventListener("click", openConnections);
  // reveal the button only when the server reports the feature is enabled
  (async () => {
    try { const r = await api("connections"); const d = await r.json(); if (d && d.enabled) netBtn.style.display = ""; } catch {}
  })();
  // reveal the chat-app button only for the owner (the /app routes are owner-gated)
  (async () => {
    try { const r = await api("app/api/models"); if (r.ok) chatBtn.style.display = ""; } catch {}
  })();
  // #endregion

  // #region mobile tab drawer (hamburger)
  let drawerEl = null, drawerEsc = null;
  function closeDrawer() {
    if (drawerEl) { drawerEl.remove(); drawerEl = null; }
    if (drawerEsc) { document.removeEventListener("keydown", drawerEsc, true); drawerEsc = null; }
  }
  function openDrawer() {
    if (drawerEl) { closeDrawer(); return; }
    drawerEl = document.createElement("div");
    drawerEl.id = "ct-drawer";
    const panel = document.createElement("div"); panel.className = "ct-draw";
    const head = document.createElement("div"); head.className = "ct-draw-head";
    const h = document.createElement("span"); h.textContent = "Sessions";
    const x = document.createElement("span"); x.className = "ct-hist-close"; x.textContent = "×";
    x.addEventListener("click", closeDrawer);
    head.appendChild(h); head.appendChild(x);
    const list = document.createElement("div"); list.className = "ct-draw-list";
    const cur = curId();
    for (const s of lastSessions) {
      const state = STATES.includes(s.state) ? s.state : "seen";
      const label = s.title;
      const row = document.createElement("div"); row.className = "ct-draw-row" + (s.id === cur ? " active" : "");
      const dot = document.createElement("span"); dot.className = "dot " + state;
      const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = label;
      const open = document.createElement("span"); open.className = "ic"; open.innerHTML = SVG_OPEN; open.title = "Open in new tab";
      open.addEventListener("click", (e) => { e.stopPropagation(); window.open("/?arg=" + encodeURIComponent(s.id), "_blank"); });
      const close = document.createElement("span");
      if (s.id === MAIN_ID) { close.className = "ic"; close.innerHTML = SVG_REFRESH; close.title = "Restart main"; }
      else { close.className = "ic x"; close.textContent = "×"; close.title = "Close"; }
      close.addEventListener("click", (e) => { e.stopPropagation(); closeSession(s.id); closeDrawer(); });
      row.appendChild(dot); row.appendChild(lbl); row.appendChild(open); row.appendChild(close);
      row.addEventListener("click", () => { if (s.id !== cur) switchTo(s.id); else closeDrawer(); });
      list.appendChild(row);
    }
    const nrow = document.createElement("div"); nrow.className = "ct-draw-row ct-draw-new";
    const plus = document.createElement("span");
    plus.textContent = "+";
    plus.style.cssText = "width:9px;display:flex;justify-content:center;font-size:17px;flex:0 0 auto";
    const nl = document.createElement("span"); nl.className = "lbl"; nl.textContent = "New session";
    nrow.appendChild(plus); nrow.appendChild(nl);
    nrow.addEventListener("click", () => { closeDrawer(); newSession(); });
    list.appendChild(nrow);

    // settings live here (mobile has no top-bar theme/notification buttons)
    list.appendChild(Object.assign(document.createElement("div"), { className: "ct-draw-sep" }));

    const themeRow = document.createElement("div"); themeRow.className = "ct-draw-row";
    const tIc = document.createElement("span"); tIc.className = "ic-lead"; tIc.innerHTML = isLight() ? SVG_MOON : SVG_SUN;
    const tLbl = document.createElement("span"); tLbl.className = "lbl"; tLbl.textContent = isLight() ? "Dark mode" : "Light mode";
    themeRow.appendChild(tIc); themeRow.appendChild(tLbl);
    themeRow.addEventListener("click", async () => {
      await setTheme(!isLight());
      tIc.innerHTML = isLight() ? SVG_MOON : SVG_SUN;
      tLbl.textContent = isLight() ? "Dark mode" : "Light mode";
    });
    list.appendChild(themeRow);

    const notifRow = document.createElement("div"); notifRow.className = "ct-draw-row"; notifRow.id = "ct-draw-notif";
    const nIc = document.createElement("span"); nIc.className = "ic-lead"; nIc.innerHTML = SVG_BELL_OFF;
    const nLbl = document.createElement("span"); nLbl.className = "lbl"; nLbl.textContent = "Notifications";
    const nSub = document.createElement("span"); nSub.className = "sub"; nSub.textContent = "…";
    notifRow.appendChild(nIc); notifRow.appendChild(nLbl); notifRow.appendChild(nSub);
    if (!pushSupported()) { nSub.textContent = "n/a"; notifRow.style.opacity = ".5"; }
    else {
      paintNotifRow(nIc, nSub);
      notifRow.addEventListener("click", async () => { nSub.textContent = "…"; await toggleNotif(); paintNotifRow(nIc, nSub); });
    }
    list.appendChild(notifRow);

    panel.appendChild(head); panel.appendChild(list); drawerEl.appendChild(panel);
    drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) closeDrawer(); });
    (document.documentElement || document.body).appendChild(drawerEl);
    drawerEsc = (e) => { if (e.key === "Escape") closeDrawer(); };
    document.addEventListener("keydown", drawerEsc, true);
  }
  hamBtn.addEventListener("click", openDrawer);
  // #endregion

  newBtn.addEventListener("click", newSession);

  // #region PWA install + Web Push notifications
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true;
  const isIOS = () =>
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isMobile = () =>
    isIOS() || /Android/i.test(navigator.userAgent) || window.matchMedia("(max-width: 820px)").matches;

  // Make the terminal installable: manifest + apple/mobile meta tags in <head>.
  (function injectPwaHead() {
    const head = document.head || document.documentElement;
    const add = (tag, attrs) => { const el = document.createElement(tag); for (const k in attrs) el.setAttribute(k, attrs[k]); head.appendChild(el); };
    if (!document.querySelector('link[rel="manifest"]')) add("link", { rel: "manifest", href: "/_ct/manifest.webmanifest", crossorigin: "use-credentials" });
    if (!document.querySelector('meta[name="theme-color"]')) add("meta", { name: "theme-color", content: "#181818" });
    add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    add("meta", { name: "mobile-web-app-capable", content: "yes" });
    add("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" });
    add("meta", { name: "apple-mobile-web-app-title", content: "Claude" });
    if (!document.querySelector('link[rel="apple-touch-icon"]')) add("link", { rel: "apple-touch-icon", href: "/_ct/pwa/apple-touch-icon.png?v=6" });
  })();

  // Service worker (root scope) — drives push + installability. Served from /_ct/sw.js
  // with Service-Worker-Allowed: / so it can control the whole terminal.
  let swReg = null;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/_ct/sw.js", { scope: "/" })
      .then((reg) => { swReg = reg; log("sw registered", reg.scope); })
      .catch((e) => log("sw register failed", e));
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data || {};
      if (d.type === "ct-notification-click" && d.sessionId && d.sessionId !== curId()) switchTo(d.sessionId);
    });
  }

  // #region Web Push enable/disable (driven from the drawer's Notifications row)
  function b64ToUint8(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  async function currentSub() {
    try { const reg = swReg || (await navigator.serviceWorker.ready); return await reg.pushManager.getSubscription(); }
    catch { return null; }
  }
  async function notifOn() {
    return pushSupported() && Notification.permission === "granted" && !!(await currentSub());
  }
  async function enableNotifications() {
    if (!pushSupported()) {
      showToast(isIOS() ? "On iOS: install to Home Screen first, then enable" : "Notifications not supported here", "error");
      return;
    }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm !== "granted") { showToast("Notifications blocked in browser settings", "error"); return; }
    try {
      const reg = swReg || (await navigator.serviceWorker.ready);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const kr = await api("vapidPublicKey");
        const { key } = await kr.json();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
      }
      // cadence: this device can take the coalesced status pushes (silent same-tag updates). Android
      // only; iOS would alert on every one of them.
      const subBody = Object.assign({}, sub.toJSON(), { cadence: /Android/i.test(navigator.userAgent), ua: navigator.userAgent });
      await api("subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subBody) });
      showToast("Notifications enabled 🦆", "success");
    } catch (e) {
      log("subscribe failed", e);
      showToast("Could not enable notifications", "error");
    }
  }
  async function disableNotifications() {
    const sub = await currentSub();
    if (sub) {
      await api("unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      try { await sub.unsubscribe(); } catch {}
    }
    showToast("Notifications off", "info");
  }
  async function toggleNotif() {
    if (await notifOn()) await disableNotifications();
    else await enableNotifications();
  }
  async function paintNotifRow(icEl, subEl) {
    const on = await notifOn();
    if (icEl) icEl.innerHTML = on ? SVG_BELL : SVG_BELL_OFF;
    if (subEl) subEl.textContent = on ? "On" : "Off";
  }
  // Desktop top-bar bell (mobile uses the drawer row instead; CSS hides it ≤600px).
  async function paintBell() {
    const on = await notifOn();
    bellBtn.innerHTML = on ? SVG_BELL : SVG_BELL_OFF;
    bellBtn.title = on ? "Notifications on — click to turn off" : "Enable notifications (prompt done / waiting)";
    bellBtn.classList.toggle("on", on);
  }
  if (pushSupported()) {
    bellBtn.addEventListener("click", async () => { await toggleNotif(); paintBell(); });
    paintBell();
  } else {
    bellBtn.style.display = "none";
  }
  // #endregion

  // #region watch heartbeat (suppress pushes for the tab you're actively looking at)
  // While this tab is on screen, tell the server which session it's showing so a
  // prompt-finished/waiting push for that session is suppressed. On mobile the app
  // being visible (foreground) is the signal — document.hasFocus() is unreliable there,
  // which is why notifications weren't being suppressed on the phone. On desktop we also
  // require window focus, so a visible-but-unfocused window still notifies you. When you
  // leave, we simply stop reporting and the server entry goes stale within ~20s.
  function isWatching() {
    if (document.visibilityState !== "visible") return false;
    if (!isMobile() && typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    return true;
  }
  function sendActive() {
    if (!isWatching()) return;
    api("active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: curId() }) }).catch(() => {});
  }
  sendActive();
  setInterval(sendActive, 10000);
  document.addEventListener("visibilitychange", sendActive);
  window.addEventListener("focus", sendActive);
  window.addEventListener("pageshow", sendActive);
  // #endregion

  // #region mobile install prompt
  let deferredPrompt = null;
  let installBanner = null;
  const installDismissed = () => { try { return localStorage.getItem("ct-install-dismissed") === "1"; } catch { return false; } };
  const dismissInstall = () => { try { localStorage.setItem("ct-install-dismissed", "1"); } catch {} hideInstallBanner(); };
  function hideInstallBanner() { if (installBanner) { installBanner.remove(); installBanner = null; } }
  function showInstallBanner(opts) {
    opts = opts || {};
    if (installBanner || isStandalone()) return;
    if (!opts.force && installDismissed()) return;
    installBanner = document.createElement("div");
    installBanner.id = "ct-install";
    installBanner.className = opts.ios ? "ios" : "";
    const icon = document.createElement("img");
    icon.src = "/_ct/pwa/icon-192.png?v=6";
    icon.alt = "";
    const txt = document.createElement("div");
    txt.className = "ct-inst-txt";
    if (opts.ios) {
      txt.innerHTML = "<b>Install Claude Terminal</b><span>Tap the Share button, then “Add to Home Screen” for fullscreen + notifications.</span>";
    } else {
      txt.innerHTML = "<b>Install Claude Terminal</b><span>Add it to your home screen for fullscreen and push notifications.</span>";
    }
    installBanner.appendChild(icon);
    installBanner.appendChild(txt);
    if (!opts.ios) {
      const go = document.createElement("button");
      go.className = "ct-inst-go";
      go.textContent = "Install";
      go.addEventListener("click", async () => {
        if (!deferredPrompt) { hideInstallBanner(); return; }
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        hideInstallBanner();
      });
      installBanner.appendChild(go);
    }
    const x = document.createElement("span");
    x.className = "ct-inst-x";
    x.textContent = "×";
    x.title = "Dismiss";
    x.addEventListener("click", dismissInstall);
    installBanner.appendChild(x);
    (document.documentElement || document.body).appendChild(installBanner);
  }
  // Android/Chromium: the browser offers a real install prompt we can trigger.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (isMobile() && !isStandalone()) showInstallBanner();
  });
  window.addEventListener("appinstalled", () => { deferredPrompt = null; hideInstallBanner(); showToast("Installed 🦆", "success"); });
  // iOS Safari has no beforeinstallprompt — show the add-to-home-screen hint instead.
  if (isIOS() && isMobile() && !isStandalone() && !installDismissed()) {
    setTimeout(() => showInstallBanner({ ios: true }), 1600);
  }
  // #endregion

  // #region mobile keyboard: slide the terminal up (no resize) + key bar + no auto-keyboard
  // When the on-screen keyboard opens, slide the ttyd frame up by the keyboard height
  // so the input line clears the keyboard — a transform, NOT a resize (xterm doesn't
  // reflow), and the fixed tab bar stays put at the top.
  const vv = window.visualViewport;

  // #region soft key bar (arrows + esc) above the on-screen keyboard
  // A row of keys the touch keyboard doesn't offer — Escape and the four arrows —
  // sitting just above the keyboard. It auto shows/hides with the keyboard (driven
  // from applyKeyboardShift: shown only while a keyboard is open, kb > 120px). Keys
  // go straight to the pty via sendToTerminal (ttyd input frame), sending the normal
  // xterm escape sequences, so they work in the shell and in Claude Code. Mounted on
  // <html> like the tab bar so ttyd's Preact render can't evict it, and pointerdown is
  // preventDefault'd so tapping a key never blurs the terminal (the keyboard stays up).
  const KB_BAR_H = 40; // px; the terminal is lifted this much extra so its input line clears the bar
  const KEYSEQ = { esc: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" };
  let keybar = null;
  (function injectKeybarStyle() {
    const s = document.createElement("style");
    s.textContent = [
      "#ct-keybar{position:fixed;left:0;right:0;z-index:48;display:none;align-items:stretch;gap:6px;",
      "padding:5px 8px;box-sizing:border-box;height:" + KB_BAR_H + "px;background:#181818;border-top:1px solid #2e2e2e;",
      "font:15px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#dcdcdc;user-select:none;-webkit-user-select:none;touch-action:manipulation}",
      "#ct-keybar button{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;background:#252525;",
      "border:1px solid #383838;border-radius:7px;color:#e6e6e6;font-size:16px;font-weight:600;line-height:1;padding:0;margin:0;",
      "-webkit-tap-highlight-color:transparent;touch-action:manipulation;cursor:pointer}",
      "#ct-keybar button.ct-esc{flex:0 0 58px;font-size:12px;letter-spacing:.03em;text-transform:uppercase}",
      "#ct-keybar button.ct-press,#ct-keybar button:active{background:#3d3d3d;border-color:#4a4a4a}",
    ].join("");
    (document.head || document.documentElement).appendChild(s);
  })();
  function buildKeybar() {
    const el = document.createElement("div");
    el.id = "ct-keybar";
    el.innerHTML =
      '<button class="ct-esc" data-k="esc" tabindex="-1" aria-label="Escape">esc</button>' +
      '<button data-k="left" tabindex="-1" aria-label="Left">←</button>' +
      '<button data-k="up" tabindex="-1" aria-label="Up">↑</button>' +
      '<button data-k="down" tabindex="-1" aria-label="Down">↓</button>' +
      '<button data-k="right" tabindex="-1" aria-label="Right">→</button>';
    // pointerdown (not click): fire immediately AND preventDefault so focus never leaves
    // the xterm textarea — otherwise the tap would dismiss the on-screen keyboard.
    el.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest && e.target.closest("button[data-k]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const seq = KEYSEQ[btn.dataset.k];
      if (seq) sendToTerminal(seq);
      btn.classList.add("ct-press");
      setTimeout(() => btn.classList.remove("ct-press"), 120);
    });
    return el;
  }
  function ensureKeybar() {
    if (keybar && document.documentElement.contains(keybar)) return;
    keybar = buildKeybar();
    document.documentElement.appendChild(keybar); // <html>, survives ttyd's Preact render
  }
  function positionKeybar(kbHeight) {
    if (!vv) return;
    ensureKeybar();
    if (kbHeight > 120) {
      // sit the bar at the bottom of the visible (visual) viewport, just above the keyboard
      keybar.style.top = Math.round((vv.offsetTop || 0) + vv.height - KB_BAR_H) + "px";
      keybar.style.display = "flex";
    } else {
      keybar.style.display = "none";
    }
  }
  // #endregion

  function applyKeyboardShift() {
    if (!vv) return;
    const tc = document.getElementById("terminal-container");
    if (!tc) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    // lift the terminal by the keyboard height PLUS the key bar so the input line clears both
    const lift = kb > 120 ? kb + KB_BAR_H : 0;
    tc.style.transform = lift ? "translateY(-" + lift + "px)" : "";
    // if the browser scrolled the visual viewport, keep the fixed bar on the visible top
    bar.style.transform = vv.offsetTop ? "translateY(" + Math.round(vv.offsetTop) + "px)" : "";
    positionKeybar(kb);
  }
  if (vv && isMobile()) {
    vv.addEventListener("resize", applyKeyboardShift);
    vv.addEventListener("scroll", applyKeyboardShift);
  }

  // Don't pop the on-screen keyboard on its own: ttyd focuses xterm on load, and a tab
  // switch reloads the page. Blur the terminal input until the user actually taps the
  // terminal — then their tap focuses it and the keyboard opens as expected.
  let userTappedTerminal = false;
  document.addEventListener("touchstart", (e) => {
    if (e.target && e.target.closest && e.target.closest("#terminal-container")) userTappedTerminal = true;
  }, { capture: true });
  function blurTerminalInput() {
    if (userTappedTerminal) return;
    const ta = document.querySelector(".xterm-helper-textarea");
    if (ta) ta.blur();
    const ae = document.activeElement;
    if (ae && ae !== document.body && typeof ae.blur === "function") ae.blur();
  }
  if (isMobile()) {
    [0, 80, 200, 400, 700, 1100].forEach((d) => setTimeout(blurTerminalInput, d));
  }
  // #endregion
  // #endregion

  mountBar(); // <html> always exists, so mount now — no DOMContentLoaded wait (that
              // fired AFTER ttyd's render, which is precisely when the bar got wiped).
  seedFromCache(); // show cached tabs immediately so a switch never blanks the bar
  refresh();
  setInterval(refresh, 3000);
  // #endregion
})();
