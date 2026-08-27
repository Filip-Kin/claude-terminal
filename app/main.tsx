// Chat-app front-end. A Claude-app-style UI that drives Claude Code through the
// headless Agent SDK via the /app* routes in app-server.ts. The terminal stays one
// click away (the "Terminal" link -> "/").
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { VoiceMode, type VoiceBridge } from "./voice";
import { AskCard } from "./askcard";
import * as offline from "./offline";

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
  | { t: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; _seq?: number }
  | { t: "ask_done"; askId: string; answer: string; _seq?: number }
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
  | { kind: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; answered?: string }
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
  favorites: () => fetch("/app/api/favorites").then(J),
  toggleFav: (id: string, fav: boolean) =>
    fetch("/app/api/favorites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, fav }) }).then(J),
  setTitle: (id: string, title: string) =>
    fetch("/app/api/title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title }) }).then(J),
  search: (q: string) => fetch(`/app/api/search?q=${encodeURIComponent(q)}`).then(J),
  answerAsk: (id: string, askId: string, answer: string) =>
    fetch("/app/api/ask-answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, askId, answer }) }).then(J),
};
// #endregion

// #region search
type SearchHit = { sessionId: string; title: string; snippet: string; count: number; mtime: number; cwd: string | null };
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
    case "ask": {
      if (items.some((it) => it.kind === "ask" && it.askId === e.askId)) return items; // de-dupe (transcript + live)
      return [...items, { kind: "ask", askId: e.askId, question: e.question, options: e.options, multiSelect: e.multiSelect, allowText: e.allowText }];
    }
    case "ask_done": {
      const idx = items.findIndex((it) => it.kind === "ask" && it.askId === e.askId);
      if (idx < 0) return items;
      const c = items.slice(); c[idx] = { ...(c[idx] as Extract<Item, { kind: "ask" }>), answered: e.answer }; return c;
    }
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

function MessageBlock({ items, i, onAnswer }: { items: Item[]; i: number; onAnswer: (askId: string, answer: string) => void }) {
  const it = items[i];
  if (it.kind === "user") return (<div className="msg"><div className="bubble-user">{it.text}</div></div>);
  if (it.kind === "compact") return <div className="compact-div">conversation compacted</div>;
  if (it.kind === "ask") return <AskCard it={it} onAnswer={onAnswer} />;
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
  const [moreModels, setMoreModels] = useState<Model[]>([]);
  const [otherOpen, setOtherOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
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
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [queued, setQueued] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const esOpen = useRef(false);
  const lastSeq = useRef(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<string>("");
  const pendingUser = useRef<string[]>([]); // optimistic user turns awaiting their SSE echo
  const forceBottom = useRef(false); // scroll to the end after opening a conversation
  const highlightRef = useRef<string>(""); // when set, scroll to + flash the first message containing it
  const activeIdRef = useRef<string | null>(null); // latest activeId for stable callbacks (voice)
  const modelRef = useRef<string>(""); // latest model for stable callbacks (voice)
  const voiceSinks = useRef<Set<(e: AppEvent) => void>>(new Set()); // voice-mode event subscribers
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { modelRef.current = model; }, [model]);

  const refreshConvs = useCallback(() => {
    api.convs()
      .then((d) => { const list: Conv[] = d.conversations || []; setConvs(list); offline.cacheList(list); })
      .catch(async () => { const cached = await offline.getCachedList<Conv[]>(); if (cached) setConvs(cached); }); // offline: serve the last cached list
  }, []);
  const refreshFavs = useCallback(() => { api.favorites().then((d) => setFavorites(new Set(d.favorites || []))).catch(() => {}); }, []);
  const toggleFav = useCallback((id: string) => {
    setFavorites((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); void api.toggleFav(id, !s.has(id)).then((d) => { if (d?.favorites) setFavorites(new Set(d.favorites)); }).catch(() => {}); return n; });
  }, []);

  useEffect(() => {
    api.models().then((d) => { setModels(d.models || []); setMoreModels(d.moreModels || []); setDefaultCwd(d.defaultCwd || ""); cwdRef.current = d.defaultCwd || ""; setVoiceAvail(!!d.voice); if (!localStorage.getItem("ct-app-model") && d.models?.[0]) setModel(d.models[0].id); }).catch(() => {});
    refreshConvs();
    refreshFavs();
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

  // Register the shared service worker from the app too — the terminal overlay is the only
  // other place that does, so an /app-only PWA install needs this for offline load + Background
  // Sync. Same script + scope as the terminal, so it's idempotent (no double registration).
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/_ct/sw.js", { scope: "/" }).catch(() => {});
  }, []);

  // Record that the app is the surface to reopen on next PWA launch (see the overlay's launch
  // routing). Deliberately "/app" with no ?c= so a relaunch lands on the default view, not a
  // specific conversation.
  useEffect(() => { try { localStorage.setItem("ct-last-surface", "/app"); } catch { /* */ } }, []);

  // Force the freshest assets. We do NOT unregister the service worker (it's the shared
  // push worker for the whole PWA); clearing Cache Storage + reloading the no-store shell
  // is what actually pulls the new hashed bundle.
  const hardRefresh = async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch {}
    location.reload();
  };

  // autoscroll: jump to the end when a conversation is opened, else follow only if near bottom
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    if (highlightRef.current) {
      const q = highlightRef.current.toLowerCase(); highlightRef.current = "";
      let found: Element | null = null;
      for (const n of Array.from(el.querySelectorAll(".thread > *"))) { if ((n.textContent || "").toLowerCase().includes(q)) { found = n; break; } }
      if (found) { (found as HTMLElement).scrollIntoView({ block: "center" }); found.classList.add("hl-flash"); const f = found; setTimeout(() => f.classList.remove("hl-flash"), 2200); }
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (forceBottom.current) { forceBottom.current = false; el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); return; }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  const closeStream = () => { esRef.current?.close(); esRef.current = null; esOpen.current = false; };

  const handleEvent = useCallback((e: AppEvent) => {
    for (const fn of voiceSinks.current) { try { fn(e); } catch {} } // feed voice mode (streaming text, result, error)
    if (e.t === "init") { setActiveId(e.sessionId); activeIdRef.current = e.sessionId; history.replaceState(null, "", `/app?c=${e.sessionId}`); setTimeout(refreshConvs, 400); return; }
    // user echo: if we already rendered this turn optimistically, drop the echo
    if (e.t === "user") { if (pendingUser.current[0] === e.text) { pendingUser.current.shift(); return; } setItems((it) => applyEvent(it, e)); return; }
    if (e.t === "busy") { setBusy(e.busy); return; }
    if (e.t === "result") { setBusy(false); setTimeout(refreshConvs, 500); return; }
    if (e.t === "error") { setBusy(false); setItems((it) => [...it, { kind: "assistant", text: "\n\n_error: " + e.message + "_" }]); return; }
    if (e.t === "closed") { return; }
    setItems((it) => applyEvent(it, e));
  }, [refreshConvs]);

  const openStream = useCallback((id: string, tail = false) => {
    closeStream();
    lastSeq.current = -1;
    const es = new EventSource(`/app/stream/${encodeURIComponent(id)}${tail ? "?tail=1" : ""}`);
    esRef.current = es; esOpen.current = true;
    es.onmessage = (ev) => {
      let e: AppEvent; try { e = JSON.parse(ev.data); } catch { return; }
      if (typeof e._seq === "number") { if (e._seq <= lastSeq.current) return; lastSeq.current = e._seq; }
      handleEvent(e);
    };
    es.onerror = () => { /* EventSource auto-reconnects; buffer + _seq dedupe keeps us consistent */ };
  }, [handleEvent]);

  const loadConv = useCallback(async (id: string, highlight?: string) => {
    closeStream();
    setDrawer(false); setBusy(false);
    let d: any = null;
    try { d = await api.conversation(id); offline.cacheConversation(id, d); } // cache for offline
    catch { d = await offline.getCachedConversation(id); } // offline: serve from cache
    if (!d) { setItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]); setActiveId(id); history.replaceState(null, "", `/app?c=${id}`); return; }
    let built = (d.events || []).reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
    // Reopening a LIVE conversation (e.g. one blocked on an ask_user while you were away):
    // drop any unanswered ask rebuilt from the transcript (its id can't unblock the tool) and
    // re-add the server's real pending asks, then stream FUTURE events so the reply flows once
    // you answer. tail=1 avoids re-rendering the current turn already built from the transcript.
    if (d.live) {
      const pending: any[] = Array.isArray(d.pendingAsks) ? d.pendingAsks : [];
      if (pending.length) {
        built = built.filter((it: Item) => !(it.kind === "ask" && it.answered === undefined));
        for (const a of pending) built.push({ kind: "ask", askId: a.askId, question: a.question, options: a.options || [], multiSelect: a.multiSelect, allowText: a.allowText });
      }
    }
    if (highlight) highlightRef.current = highlight; else forceBottom.current = true; // jump to the match, else to the end
    setItems(built); setActiveId(id); activeIdRef.current = id;
    setBusy(!!d.busy);
    cwdRef.current = d.cwd || defaultCwd;
    history.replaceState(null, "", `/app?c=${id}`);
    if (d.live) openStream(id, true); // reconnect to a live conversation (streams follow-up + ask answers)
  }, [defaultCwd, openStream]);

  const newChat = () => { closeStream(); setItems([]); setActiveId(null); setBusy(false); setAttachments([]); cwdRef.current = defaultCwd; history.replaceState(null, "", "/app"); setDrawer(false); taRef.current?.focus(); };

  // #region offline: online/offline detection + queued-message drain
  const drainQueueUI = useCallback(async () => {
    const q = await offline.getQueue();
    if (!q.length) return;
    let lastId: string | null = null;
    for (const it of q.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        const r = await api.start(it.body);
        if (it.qid != null) await offline.removeQueued(it.qid);
        if (r?.id) lastId = r.id;
      } catch { break; } // dropped offline again — leave the rest queued
    }
    offline.queueCount().then(setQueued);
    refreshConvs();
    // reconnect the active conversation's stream so a drained message's reply streams in live
    if (lastId && (lastId === activeIdRef.current || activeIdRef.current === null)) { setActiveId(lastId); activeIdRef.current = lastId; openStream(lastId); }
  }, [openStream, refreshConvs]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); void drainQueueUI(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    offline.queueCount().then(setQueued);
    if (navigator.onLine) void drainQueueUI(); // send anything left queued from a previous session
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [drainQueueUI]);
  // #endregion

  // #region search: debounced content search (title filtering is instant + client-side below)
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setSearchHits([]); setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(q).then((d) => { if (!cancelled) { setSearchHits(d.results || []); setSearching(false); } }).catch(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);
  // #endregion

  // Core send used by both the composer and voice mode. Renders the user turn optimistically,
  // starts/resumes the conversation, and returns its session id. Stable (reads refs) so the
  // voice bridge identity never churns.
  const submitText = useCallback(async (text: string): Promise<string | null> => {
    if (!text.trim()) return null;
    setBusy(true);
    pendingUser.current.push(text);
    setItems((it) => applyEvent(it, { t: "user", text }));
    const body = { text, resume: activeIdRef.current || undefined, model: modelRef.current || undefined, cwd: cwdRef.current || undefined };
    const queue = async () => { await offline.enqueueSend(body); offline.requestBackgroundSync(); offline.queueCount().then(setQueued); setBusy(false); };
    if (typeof navigator !== "undefined" && !navigator.onLine) { await queue(); return null; } // offline: hold it, send on reconnect
    try {
      if (esOpen.current && activeIdRef.current) { await api.send({ id: activeIdRef.current, text }); return activeIdRef.current; }
      const r = await api.start(body);
      if (r?.id) { setActiveId(r.id); activeIdRef.current = r.id; openStream(r.id); return r.id; }
      setBusy(false); return null;
    } catch { await queue(); return null; } // network died mid-send -> queue for reconnect
  }, [openStream]);

  const doSend = async () => {
    const raw = input.trim();
    if (!raw && !attachments.length) return; // busy is allowed: the turn queues (processed after the current one)
    let text = raw;
    if (attachments.length) text = "Attached files:\n" + attachments.map((a) => a.path).join("\n") + (raw ? "\n\n" + raw : "");
    setInput(""); setAttachments([]);
    if (taRef.current) taRef.current.style.height = "auto";
    await submitText(text);
  };

  // Stable bridge handed to voice mode: submit a turn + subscribe to the live event stream.
  const voiceBridge = useMemo<VoiceBridge>(() => ({
    submit: submitText,
    subscribe: (fn) => { voiceSinks.current.add(fn as (e: AppEvent) => void); return () => { voiceSinks.current.delete(fn as (e: AppEvent) => void); }; },
  }), [submitText]);

  const stop = async () => { if (activeId) await api.interrupt(activeId); setBusy(false); };

  // User tapped an ask_user option: mark it chosen locally + tell the server (unblocks Claude).
  const answerAsk = useCallback((askId: string, answer: string) => {
    setItems((its) => its.map((it) => (it.kind === "ask" && it.askId === askId ? { ...it, answered: answer } : it)));
    if (activeIdRef.current) api.answerAsk(activeIdRef.current, askId, answer).catch(() => {});
  }, []);

  // Tapping a PWA push (e.g. "Claude has a question") posts this from the service worker;
  // open that conversation so the ask card is right there to answer.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (ev: MessageEvent) => {
      const d: any = ev.data;
      if (d?.type === "ct-notification-click" && d.sessionId) void loadConv(String(d.sessionId));
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [loadConv]);

  // The first unanswered ask — surfaced on top of voice mode (a tappable card can't be used
  // hands-free, but at least it's visible and answerable instead of hidden behind the overlay).
  const pendingAsk = useMemo(() => items.find((it) => it.kind === "ask" && it.answered === undefined) as Extract<Item, { kind: "ask" }> | undefined, [items]);

  const onPickModel = async (m: string) => {
    setModel(m); localStorage.setItem("ct-app-model", m); setMenuOpen(false); setOtherOpen(false);
    if (esOpen.current && activeId) { try { await api.setModel({ id: activeId, model: m }); } catch { /* */ } }
  };

  const startRename = () => { if (!activeId) return; setTitleDraft(convs.find((c) => c.sessionId === activeId)?.title || ""); setEditingTitle(true); };
  const saveTitle = async () => {
    const t = titleDraft.trim();
    setEditingTitle(false);
    if (!activeId) return;
    if (t) setConvs((cs) => cs.map((c) => (c.sessionId === activeId ? { ...c, title: t } : c)));
    try { await api.setTitle(activeId, t); } catch { /* */ }
    setTimeout(refreshConvs, 300);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    try { const r = await api.upload(activeId, f); if (r?.path) setAttachments((a) => [...a, { name: f.name, path: r.path }]); } catch { /* */ }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSend(); } };
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInput(e.target.value); const ta = e.target; ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };

  const modelLabel = [...models, ...moreModels].find((m) => m.id === model)?.label || model || "Model";

  // sidebar grouping — favorites pulled into their own section, the rest grouped by recency
  const favConvs = useMemo(() => convs.filter((c) => favorites.has(c.sessionId)), [convs, favorites]);
  const groups = useMemo(() => {
    const g: { label: string; items: Conv[] }[] = [];
    for (const c of convs) {
      if (favorites.has(c.sessionId)) continue;
      const l = groupLabel(c.mtime); let last = g[g.length - 1]; if (!last || last.label !== l) { last = { label: l, items: [] }; g.push(last); } last.items.push(c);
    }
    return g;
  }, [convs, favorites]);

  const renderConv = (c: Conv) => {
    const fav = favorites.has(c.sessionId);
    return (
      <div key={c.sessionId} className={"conv-item" + (c.sessionId === activeId ? " active" : "")} title={c.title} onClick={() => loadConv(c.sessionId, search.trim() || undefined)}>
        <svg className="conv-ic" width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 11.5a8.5 8.5 0 0 1-9 8.32 8.5 8.5 0 0 1-3.6-.8L3 20l1.3-3.9A8.5 8.5 0 1 1 21 11.5z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="conv-title">{c.title}</span>
        <button className={"conv-star" + (fav ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggleFav(c.sessionId); }} aria-label={fav ? "Unfavorite" : "Favorite"} title={fav ? "Unfavorite" : "Favorite"}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" /></svg>
        </button>
      </div>
    );
  };

  // search view: instant client title matches + server content matches (dedup the ones already title-matched)
  const q = search.trim();
  const titleMatches = q ? convs.filter((c) => (c.title || "").toLowerCase().includes(q.toLowerCase())) : [];
  const titleIds = new Set(titleMatches.map((c) => c.sessionId));
  const contentMatches = searchHits.filter((h) => !titleIds.has(h.sessionId));

  return (
    <div className={"app" + (drawer ? " drawer-open" : "")}>
      {updateAvail && (
        <div className="update-toast" role="status">
          <span>A new version is available.</span>
          <button className="ut-reload" onClick={hardRefresh}>Reload</button>
          <button className="ut-dismiss" onClick={() => setUpdateAvail(false)} aria-label="Dismiss">×</button>
        </div>
      )}
      {otherOpen && (
        <div className="modal-scrim" onClick={() => setOtherOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Choose a model<button className="modal-x" onClick={() => setOtherOpen(false)} aria-label="Close">×</button></div>
            <div className="modal-list">
              {moreModels.map((m) => (
                <button key={m.id} className={m.id === model ? "active" : ""} onClick={() => onPickModel(m.id)}>
                  <span className="mm-label">{m.label}</span>
                  <span className="mm-id">{m.id}</span>
                  {m.id === model && <span className="dot">●</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="scrim" onClick={() => setDrawer(false)} />
      <aside className="sidebar">
        <div className="sb-head"><span className="brand">Claude</span></div>
        <button className="new-chat" onClick={newChat}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          New chat
        </button>
        <div className="sb-search">
          <svg className="sb-search-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats & messages" />
          {search && <button className="sb-search-x" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
        </div>
        <div className="conv-list">
          {q ? (
            <div>
              {titleMatches.length > 0 && (<><div className="conv-group-label">Conversations</div>{titleMatches.map(renderConv)}</>)}
              {(contentMatches.length > 0 || searching) && <div className="conv-group-label">Messages{searching ? " …" : ""}</div>}
              {contentMatches.map((h) => (
                <div key={h.sessionId} className={"conv-item search-hit" + (h.sessionId === activeId ? " active" : "")} title={h.title} onClick={() => loadConv(h.sessionId, q)}>
                  <div className="hit-title">{h.title}{h.count > 1 && <span className="hit-count">{h.count}</span>}</div>
                  <div className="hit-snippet">{h.snippet}</div>
                </div>
              ))}
              {!titleMatches.length && !contentMatches.length && !searching && <div className="conv-group-label">No matches</div>}
            </div>
          ) : (
            <>
              {favConvs.length > 0 && (
                <div>
                  <div className="conv-group-label">Favorites</div>
                  {favConvs.map(renderConv)}
                </div>
              )}
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="conv-group-label">{g.label}</div>
                  {g.items.map(renderConv)}
                </div>
              ))}
              {!convs.length && <div className="conv-group-label">No conversations yet</div>}
            </>
          )}
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
          {editingTitle ? (
            <input className="topbar-title-input" autoFocus value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveTitle(); } else if (e.key === "Escape") setEditingTitle(false); }}
              onBlur={() => void saveTitle()} placeholder="Conversation name" />
          ) : (
            <div className="topbar-title">
              <span className="tt-text">{activeId ? convs.find((c) => c.sessionId === activeId)?.title || "Conversation" : "New chat"}</span>
              {activeId && (
                <button className="rename-btn" onClick={startRename} title="Rename conversation" aria-label="Rename">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
              )}
            </div>
          )}
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
                {moreModels.length > 0 && <button className="model-other" onClick={() => { setMenuOpen(false); setOtherOpen(true); }}>Other versions…</button>}
              </div>
            )}
          </div>
        </div>

        {(!online || queued > 0) && (
          <div className={"net-banner" + (online ? " sending" : "")}>
            {!online
              ? (queued > 0 ? `Offline — ${queued} message${queued > 1 ? "s" : ""} queued, will send when you reconnect` : "You're offline — cached conversations available")
              : `Back online — sending ${queued} queued message${queued > 1 ? "s" : ""}…`}
          </div>
        )}
        <div className="scroll" ref={scrollRef}>
          {items.length === 0 ? (
            <div className="empty">
              <h2>What can I help with?</h2>
              <div>Ask anything. This drives Claude Code in {cwdRef.current || "your project"}.</div>
            </div>
          ) : (
            <div className="thread">
              {items.map((_, i) => <MessageBlock key={i} items={items} i={i} onAnswer={answerAsk} />)}
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
              {voiceAvail && (
                <button className="act-btn voice-open-btn" onClick={() => setVoiceOpen(true)} title="Hands-free voice mode">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" stroke="currentColor" strokeWidth="1.7" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                </button>
              )}
              {busy && (
                <button className="send-btn stop-btn" onClick={stop} title="Stop the current turn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              )}
              <button className="send-btn" onClick={doSend} disabled={!input.trim() && !attachments.length} title={busy ? "Queue this message (sent after the current turn)" : "Send"}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 20V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </div>
          <div className="hint">Claude runs with tools enabled in {cwdRef.current || "the default folder"}. Enter to send, Shift+Enter for a new line.</div>
        </div>
      </main>
      <VoiceMode bridge={voiceBridge} open={voiceOpen} onClose={() => setVoiceOpen(false)} pendingAsk={pendingAsk} onAnswer={answerAsk} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
