(function () {
  const log = (...a) => console.log("[claude-paste]", ...a);
  log("overlay loaded");

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
  const inOverlayUi = (el) => !!(el && el.closest && el.closest("#ct-histmodal, #claude-tabbar"));
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
      document.body.appendChild(toastEl);
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
    const r = await fetch("/_paste/upload", { method: "POST", body: fd });
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
    // light theme (ttyd toggles body.theme-light)
    "body.theme-light #claude-tabbar{background:#f3f3f3;border-bottom-color:#dcdcdc;color:#333}",
    "body.theme-light #claude-tabbar .ctab{background:#fff;border-color:#d7d7d7}",
    "body.theme-light #claude-tabbar .ctab:hover{background:#ececec}",
    "body.theme-light #claude-tabbar .ctab.active{background:#dce8ff;border-color:#3d6cc4;color:#12305e}",
    "body.theme-light #claude-tabbar .ctab-btn{background:#fff;border-color:#d7d7d7;color:#444}",
    "body.theme-light #claude-tabbar .ctab-btn:hover{background:#ececec;color:#000}",
    // tighter on small screens
    "@media (max-width:600px){#claude-tabbar{gap:4px;padding:0 5px}#claude-tabbar .ctab{max-width:220px}#claude-tabbar .ctab .ctab-label{max-width:170px}}",
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
  // tabs, then + right after them (left-aligned), spacer pushes the rest right;
  // history sits all the way on the right end.
  bar.appendChild(listEl);
  bar.appendChild(newBtn);
  bar.appendChild(spacer);
  bar.appendChild(historyBtn);
  bar.appendChild(themeBtn);
  bar.appendChild(usageBtn);

  function mountBar() {
    if (!document.body) return;
    if (!bar.isConnected) document.body.appendChild(bar);
    setTimeout(reflow, 50);
  }

  function switchTo(id) {
    const p = new URLSearchParams(location.search);
    p.set("arg", id);
    location.search = "?" + p.toString();
  }

  async function api(path, opts) {
    return fetch("/_paste/" + path, Object.assign({ credentials: "same-origin" }, opts));
  }

  let lastSessions = [];
  let lastScrolledId = null;
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
    const displayLabel = s.id === MAIN_ID && s.title === s.id ? "main" : s.title;

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

  async function refresh() {
    let sessions;
    try {
      const r = await api("sessions");
      if (!r.ok) throw new Error(String(r.status));
      sessions = await r.json();
    } catch (e) {
      // guests get 403 / no sidecar -> hide the bar and give the terminal its space back
      bar.style.display = "none";
      const tc = document.getElementById("terminal-container");
      if (tc) {
        tc.style.top = "0px";
        tc.style.height = "100%";
      }
      reflow();
      return;
    }
    bar.style.display = "";
    // guarantee a pinned main chip even if no one is attached to it yet
    if (!sessions.some((s) => s.id === MAIN_ID)) {
      sessions.unshift({ id: MAIN_ID, title: "main", created: 0, attached: false, state: "seen" });
    }
    mountBar();
    lastSessions = sessions;
    const cur = curId();
    // You're looking at this tab, so a finished-and-unseen "done" (green) becomes
    // "seen" (gray) — you've laid eyes on it. A real "waiting" ask stays purple even
    // while viewed (cleared only when it's answered). Only affects the current tab.
    const curSess = sessions.find((s) => s.id === cur);
    if (curSess && curSess.state === "done") {
      curSess.state = "seen";
      api("sessions/seen", {
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
    document.body.appendChild(histEl);
    search.focus();
    histEsc = (e) => { if (e.key === "Escape") closeHistory(); };
    document.addEventListener("keydown", histEsc, true);
  }
  historyBtn.addEventListener("click", openHistory);
  // #endregion

  newBtn.addEventListener("click", newSession);

  if (document.body) mountBar();
  else document.addEventListener("DOMContentLoaded", mountBar);
  refresh();
  setInterval(refresh, 3000);
  // #endregion
})();
