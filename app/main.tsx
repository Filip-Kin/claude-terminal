// Chat-app front-end. A Claude-app-style UI that drives Claude Code through the
// headless Agent SDK via the /app* routes in app-server.ts. The terminal stays one
// click away (the "Terminal" link -> "/").
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

// #region types
type Model = { id: string; label: string };
type Conv = { sessionId: string; title: string; cwd: string | null; mtime: number };
type AppEvent =
  | { t: "init"; sessionId: string; model: string; cwd: string; _seq?: number }
  | { t: "text"; text: string; _seq?: number }
  | { t: "text_delta"; text: string; _seq?: number }
  | { t: "thinking"; text: string; _seq?: number }
  | { t: "thinking_delta"; text: string; _seq?: number }
  | { t: "thinking_progress"; tokens: number; _seq?: number }
  | { t: "tool_use"; id: string; name: string; input: unknown; _seq?: number }
  | { t: "tool_result"; id: string; content: unknown; isError: boolean; _seq?: number }
  | { t: "compact"; trigger: string; _seq?: number }
  | { t: "user"; text: string; _seq?: number }
  | { t: "result"; subtype: string; sessionId: string; costUsd: number; _seq?: number }
  | { t: "busy"; busy: boolean; _seq?: number }
  | { t: "error"; message: string; _seq?: number }
  | { t: "closed"; _seq?: number };

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string; tokens?: number }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: unknown; isError?: boolean }
  | { kind: "compact" };
// #endregion

// #region api
const J = (r: Response) => r.json();
const api = {
  models: () => fetch("/app/api/models").then(J),
  convs: () => fetch("/app/api/conversations").then(J),
  conversation: (id: string) => fetch(`/app/api/conversation/${encodeURIComponent(id)}`).then(J),
  start: (b: { text: string; resume?: string; model?: string; cwd?: string }) =>
    fetch("/app/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  send: (b: { id: string; text: string }) =>
    fetch("/app/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  setModel: (b: { id: string; model: string }) =>
    fetch("/app/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  interrupt: (id: string) => fetch("/app/api/interrupt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }),
  upload: (id: string | null, file: File) => {
    const fd = new FormData(); fd.append("file", file); if (id) fd.append("id", id);
    return fetch("/app/api/upload", { method: "POST", body: fd }).then(J);
  },
};
// #endregion

function applyEvent(items: Item[], e: AppEvent): Item[] {
  const last = items[items.length - 1];
  switch (e.t) {
    case "user": return [...items, { kind: "user", text: e.text }];
    case "text":
    case "text_delta":
      if (last && last.kind === "assistant") { const c = items.slice(); c[c.length - 1] = { kind: "assistant", text: last.text + e.text }; return c; }
      return [...items, { kind: "assistant", text: e.text }];
    case "thinking_delta":
      if (last && last.kind === "thinking") { const c = items.slice(); c[c.length - 1] = { ...last, text: last.text + e.text }; return c; }
      return [...items, { kind: "thinking", text: e.text }];
    case "thinking_progress":
      if (last && last.kind === "thinking") { const c = items.slice(); c[c.length - 1] = { ...last, tokens: e.tokens }; return c; }
      return [...items, { kind: "thinking", text: "", tokens: e.tokens }];
    case "thinking": return [...items, { kind: "thinking", text: e.text }];
    case "tool_use": return [...items, { kind: "tool", id: e.id, name: e.name, input: e.input }];
    case "tool_result": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.id === e.id && it.result === undefined) {
          const c = items.slice(); c[i] = { ...it, result: e.content, isError: e.isError }; return c;
        }
      }
      return items;
    }
    case "compact": return [...items, { kind: "compact" }];
    default: return items;
  }
}

const contentToText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? b.text : b?.text || "")).join("\n") : c == null ? "" : JSON.stringify(c, null, 2);

// #region small components
function ToolCard({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => {
    const inp: any = it.input || {};
    if (it.name === "Bash") return inp.command || "";
    if (inp.file_path) return inp.file_path;
    if (inp.path) return inp.path;
    if (inp.pattern) return inp.pattern;
    try { return JSON.stringify(inp).slice(0, 120); } catch { return ""; }
  }, [it]);
  return (
    <div className="tool">
      <button className={"tool-head" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="tname">{it.name}</span>
        <span className={"tsum" + (it.isError ? " terr" : "")}>{summary}</span>
        {it.result === undefined && <span className="typing"><span></span><span></span><span></span></span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Input</div>
          <pre>{contentToText(it.input)}</pre>
          {it.result !== undefined && (<><div className="tool-label">Output{it.isError ? " (error)" : ""}</div><pre>{contentToText(it.result)}</pre></>)}
        </div>
      )}
    </div>
  );
}

function Assistant({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text || "") as string, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MessageBlock({ items, i }: { items: Item[]; i: number }) {
  const it = items[i];
  if (it.kind === "user") return (<div className="msg"><div className="bubble-user">{it.text}</div></div>);
  if (it.kind === "compact") return <div className="compact-div">conversation compacted</div>;
  if (it.kind === "thinking") {
    const isLast = i === items.length - 1;
    if (it.text) return (<div className="thinking"><div className="think-label">Thought process</div>{it.text}</div>);
    // subscription auth redacts the reasoning text; show a live indicator with token progress
    return (
      <div className={"thinking think-progress" + (isLast ? " live" : "")}>
        <span className="think-label">{isLast ? "Thinking" : "Thought"}</span>
        {isLast && <span className="think-ellipsis">…</span>}
        {it.tokens ? <span className="think-tok">~{it.tokens} tokens</span> : null}
      </div>
    );
  }
  if (it.kind === "tool") return <ToolCard it={it} />;
  // assistant — show a role label only when it opens an assistant run
  const prev = items[i - 1];
  const showRole = !prev || prev.kind === "user" || prev.kind === "compact";
  return (<div className="msg bubble-assistant">{showRole && <div className="role">Claude</div>}<Assistant text={it.text} /></div>);
}
// #endregion

function groupLabel(mtime: number): string {
  const d = new Date(mtime), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "Previous 7 days";
  if (diff <= 30) return "Previous 30 days";
  return "Older";
}

function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [defaultCwd, setDefaultCwd] = useState<string>("");
  const [convs, setConvs] = useState<Conv[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(() => localStorage.getItem("ct-app-model") || "");
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateAvail, setUpdateAvail] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const esOpen = useRef(false);
  const lastSeq = useRef(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<string>("");
  const pendingUser = useRef<string[]>([]); // optimistic user turns awaiting their SSE echo

  const refreshConvs = useCallback(() => { api.convs().then((d) => setConvs(d.conversations || [])).catch(() => {}); }, []);

  useEffect(() => {
    api.models().then((d) => { setModels(d.models || []); setDefaultCwd(d.defaultCwd || ""); cwdRef.current = d.defaultCwd || ""; if (!localStorage.getItem("ct-app-model") && d.models?.[0]) setModel(d.models[0].id); }).catch(() => {});
    refreshConvs();
    const c = new URLSearchParams(location.search).get("c");
    if (c) void loadConv(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PWA update check: poll the server build id; if it changed since load, offer a reload.
  // Content-hashed assets + no-store index mean the reload gets everything fresh.
  useEffect(() => {
    let baseline: string | null = null;
    let stop = false;
    const check = async () => {
      try {
        const v = (await (await fetch("/app/api/version", { cache: "no-store" })).text()).trim();
        if (!v) return;
        if (baseline === null) baseline = v;
        else if (v !== baseline) setUpdateAvail(true);
      } catch { /* offline / transient — ignore */ }
    };
    check();
    const iv = setInterval(() => { if (!stop) check(); }, 60_000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  // Force the freshest assets. We do NOT unregister the service worker (it's the shared
  // push worker for the whole PWA); clearing Cache Storage + reloading the no-store shell
  // is what actually pulls the new hashed bundle.
  const hardRefresh = async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch {}
    location.reload();
  };

  // autoscroll if near the bottom
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  const closeStream = () => { esRef.current?.close(); esRef.current = null; esOpen.current = false; };

  const handleEvent = useCallback((e: AppEvent) => {
    if (e.t === "init") { setActiveId(e.sessionId); history.replaceState(null, "", `/app?c=${e.sessionId}`); setTimeout(refreshConvs, 400); return; }
    // user echo: if we already rendered this turn optimistically, drop the echo
    if (e.t === "user") { if (pendingUser.current[0] === e.text) { pendingUser.current.shift(); return; } setItems((it) => applyEvent(it, e)); return; }
    if (e.t === "busy") { setBusy(e.busy); return; }
    if (e.t === "result") { setBusy(false); setTimeout(refreshConvs, 500); return; }
    if (e.t === "error") { setBusy(false); setItems((it) => [...it, { kind: "assistant", text: "\n\n_error: " + e.message + "_" }]); return; }
    if (e.t === "closed") { return; }
    setItems((it) => applyEvent(it, e));
  }, [refreshConvs]);

  const openStream = useCallback((id: string) => {
    closeStream();
    lastSeq.current = -1;
    const es = new EventSource(`/app/stream/${encodeURIComponent(id)}`);
    esRef.current = es; esOpen.current = true;
    es.onmessage = (ev) => {
      let e: AppEvent; try { e = JSON.parse(ev.data); } catch { return; }
      if (typeof e._seq === "number") { if (e._seq <= lastSeq.current) return; lastSeq.current = e._seq; }
      handleEvent(e);
    };
    es.onerror = () => { /* EventSource auto-reconnects; buffer + _seq dedupe keeps us consistent */ };
  }, [handleEvent]);

  const loadConv = useCallback(async (id: string) => {
    closeStream();
    setDrawer(false); setBusy(false);
    try {
      const d = await api.conversation(id);
      const built = (d.events || []).reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
      setItems(built); setActiveId(id);
      cwdRef.current = d.cwd || defaultCwd;
      history.replaceState(null, "", `/app?c=${id}`);
    } catch { /* ignore */ }
  }, [defaultCwd]);

  const newChat = () => { closeStream(); setItems([]); setActiveId(null); setBusy(false); setAttachments([]); cwdRef.current = defaultCwd; history.replaceState(null, "", "/app"); setDrawer(false); taRef.current?.focus(); };

  const doSend = async () => {
    const raw = input.trim();
    if ((!raw && !attachments.length) || busy) return;
    let text = raw;
    if (attachments.length) text = "Attached files:\n" + attachments.map((a) => a.path).join("\n") + (raw ? "\n\n" + raw : "");
    setInput(""); setAttachments([]); setBusy(true);
    if (taRef.current) taRef.current.style.height = "auto";
    // render the user's message immediately; the server's SSE echo is deduped in handleEvent
    pendingUser.current.push(text);
    setItems((it) => applyEvent(it, { t: "user", text }));
    try {
      if (esOpen.current && activeId) { await api.send({ id: activeId, text }); }
      else {
        const r = await api.start({ text, resume: activeId || undefined, model: model || undefined, cwd: cwdRef.current || undefined });
        if (r?.id) { setActiveId(r.id); openStream(r.id); } else { setBusy(false); }
      }
    } catch { setBusy(false); }
  };

  const stop = async () => { if (activeId) await api.interrupt(activeId); setBusy(false); };

  const onPickModel = async (m: string) => {
    setModel(m); localStorage.setItem("ct-app-model", m); setMenuOpen(false);
    if (esOpen.current && activeId) { try { await api.setModel({ id: activeId, model: m }); } catch { /* */ } }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    try { const r = await api.upload(activeId, f); if (r?.path) setAttachments((a) => [...a, { name: f.name, path: r.path }]); } catch { /* */ }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSend(); } };
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInput(e.target.value); const ta = e.target; ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };

  const modelLabel = models.find((m) => m.id === model)?.label || model || "Model";

  // sidebar grouping
  const groups = useMemo(() => {
    const g: { label: string; items: Conv[] }[] = [];
    for (const c of convs) { const l = groupLabel(c.mtime); let last = g[g.length - 1]; if (!last || last.label !== l) { last = { label: l, items: [] }; g.push(last); } last.items.push(c); }
    return g;
  }, [convs]);

  return (
    <div className={"app" + (drawer ? " drawer-open" : "")}>
      {updateAvail && (
        <div className="update-toast" role="status">
          <span>A new version is available.</span>
          <button className="ut-reload" onClick={hardRefresh}>Reload</button>
          <button className="ut-dismiss" onClick={() => setUpdateAvail(false)} aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="scrim" onClick={() => setDrawer(false)} />
      <aside className="sidebar">
        <div className="sb-head"><span className="brand">Claude</span></div>
        <button className="new-chat" onClick={newChat}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          New chat
        </button>
        <div className="conv-list">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="conv-group-label">{g.label}</div>
              {g.items.map((c) => (
                <button key={c.sessionId} className={"conv-item" + (c.sessionId === activeId ? " active" : "")} title={c.title} onClick={() => loadConv(c.sessionId)}>
                  <svg className="conv-ic" width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 11.5a8.5 8.5 0 0 1-9 8.32 8.5 8.5 0 0 1-3.6-.8L3 20l1.3-3.9A8.5 8.5 0 1 1 21 11.5z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span className="conv-title">{c.title}</span>
                </button>
              ))}
            </div>
          ))}
          {!convs.length && <div className="conv-group-label">No conversations yet</div>}
        </div>
        <div className="sb-foot">
          <a className="term-link" href="/">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4z" stroke="currentColor" strokeWidth="1.6" /><path d="M8 10l2.5 2L8 14M12.5 14H16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Terminal
          </a>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setDrawer((d) => !d)} aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <div className="topbar-title">{activeId ? convs.find((c) => c.sessionId === activeId)?.title || "Conversation" : "New chat"}</div>
          <div className="model-picker">
            <button className="model-btn" onClick={() => setMenuOpen((o) => !o)}>
              {modelLabel}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {menuOpen && (
              <div className="model-menu" onMouseLeave={() => setMenuOpen(false)}>
                {models.map((m) => (
                  <button key={m.id} onClick={() => onPickModel(m.id)}>{m.label}{m.id === model && <span className="dot">●</span>}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="scroll" ref={scrollRef}>
          {items.length === 0 ? (
            <div className="empty">
              <h2>What can I help with?</h2>
              <div>Ask anything. This drives Claude Code in {cwdRef.current || "your project"}.</div>
            </div>
          ) : (
            <div className="thread">
              {items.map((_, i) => <MessageBlock key={i} items={items} i={i} />)}
              {busy && items[items.length - 1]?.kind === "user" && (<div className="msg bubble-assistant"><div className="typing"><span></span><span></span><span></span></div></div>)}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((a, i) => (<span key={i} className="chip">📎 {a.name}<button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>×</button></span>))}
              </div>
            )}
            <textarea ref={taRef} value={input} onChange={onInput} onKeyDown={onKey} rows={1} placeholder="Reply to Claude..." />
            <div className="composer-actions">
              <label className="act-btn" title="Attach file">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.3 3.3 0 014.7 4.7l-9.2 9.2a1.6 1.6 0 01-2.3-2.3l8.5-8.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <input type="file" style={{ display: "none" }} onChange={onFile} />
              </label>
              <div className="spacer" />
              {busy ? (
                <button className="send-btn stop-btn" onClick={stop} title="Stop">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              ) : (
                <button className="send-btn" onClick={doSend} disabled={!input.trim() && !attachments.length} title="Send">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 20V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            </div>
          </div>
          <div className="hint">Claude runs with tools enabled in {cwdRef.current || "the default folder"}. Enter to send, Shift+Enter for a new line.</div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
