// Chat-app front-end. A Claude-app-style UI that drives Claude Code through the
// headless Agent SDK via the /app* routes in app-server.ts. The terminal stays one
// click away (the "Terminal" link -> "/").
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { VoiceMode, type VoiceBridge, readAloud, stopReadAloud } from "./voice";
import { AskCard } from "./askcard";
import * as offline from "./offline";
import { AssistantContent, ArtifactViewer, type Artifact } from "./artifacts";
import { isAgentTool, AgentToolCard } from "./agents";
import { isTodoTool, latestTodos, TodoChecklist } from "./todos";

marked.setOptions({ gfm: true, breaks: true });

// Coarse pointer + no hover ≈ phone/tablet. Drives the Enter-to-send vs Enter-newline behaviour.
const IS_TOUCH = typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

// Favorites are server-stored, but cache them locally so they show offline and survive a reload,
// and queue offline toggles (id -> desired fav) to replay on reconnect. Fixes favourites vanishing
// or not sticking when offline.
const FAV_LS = "ct-app-favorites", FAV_PENDING_LS = "ct-app-fav-pending";
const loadFavsLocal = (): Set<string> => { try { const a = JSON.parse(localStorage.getItem(FAV_LS) || "[]"); return new Set(Array.isArray(a) ? a.map(String) : []); } catch { return new Set(); } };
const saveFavsLocal = (s: Set<string>) => { try { localStorage.setItem(FAV_LS, JSON.stringify([...s])); } catch { /* */ } };
const loadFavPending = (): Record<string, boolean> => { try { const o = JSON.parse(localStorage.getItem(FAV_PENDING_LS) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
const saveFavPending = (m: Record<string, boolean>) => { try { localStorage.setItem(FAV_PENDING_LS, JSON.stringify(m)); } catch { /* */ } };

// Per-conversation "last read" timestamps (local) — a conversation whose mtime later exceeds this
// shows an unread indicator. Only conversations you've opened get an entry, so the backlog doesn't
// all light up as unread.
const LASTREAD_LS = "ct-app-lastread";
const loadLastRead = (): Record<string, number> => { try { const o = JSON.parse(localStorage.getItem(LASTREAD_LS) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
const saveLastRead = (m: Record<string, number>) => { try { localStorage.setItem(LASTREAD_LS, JSON.stringify(m)); } catch { /* */ } };
// Per-conversation composer drafts: an unsent message is kept under its conversation id (null = the new
// chat) so switching conversations swaps the draft in the box, and a reload keeps it.
const draftKey = (id: string | null) => "ct-draft:" + (id || "__new__");
const loadDraft = (id: string | null): string => { try { return localStorage.getItem(draftKey(id)) || ""; } catch { return ""; } };
const saveDraft = (id: string | null, v: string) => { try { if (v.trim()) localStorage.setItem(draftKey(id), v); else localStorage.removeItem(draftKey(id)); } catch { /* */ } };

// Long-press (touch, ~500ms, cancelled on scroll) or right-click (desktop) → open a context menu at
// (x, y). Returns handlers to spread onto the target element.
function longPressBind(open: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sx = 0, sy = 0, fired = false, firedAt = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); open(e.clientX, e.clientY); },
    // 600ms hold, cancelled by any real movement (a scroll or a normal tap never opens the menu).
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; sx = t?.clientX || 0; sy = t?.clientY || 0; fired = false; clear(); timer = setTimeout(() => { timer = null; fired = true; firedAt = Date.now(); open(sx, sy); }, 600); },
    onTouchMove: (e: React.TouchEvent) => { const t = e.touches[0]; if (t && (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8)) clear(); },
    onTouchEnd: (e: React.TouchEvent) => { clear(); if (fired) e.preventDefault(); },
    onTouchCancel: clear,
    // Swallow the click the browser fires after a long-press so the row doesn't ALSO navigate/open.
    onClickCapture: (e: React.MouseEvent) => { if (fired || Date.now() - firedAt < 700) { e.preventDefault(); e.stopPropagation(); fired = false; } },
  };
}

// #region types
type Model = { id: string; label: string };
type Conv = { sessionId: string; title: string; cwd: string | null; mtime: number; pending?: boolean; queuedText?: string };
type AppEvent =
  | { t: "init"; sessionId: string; model: string; cwd: string; _seq?: number }
  | { t: "text"; text: string; _seq?: number }
  | { t: "text_delta"; text: string; _seq?: number }
  | { t: "thinking"; text: string; _seq?: number }
  | { t: "thinking_delta"; text: string; _seq?: number }
  | { t: "thinking_progress"; tokens: number; _seq?: number }
  | { t: "tool_use"; id: string; name: string; input: unknown; _seq?: number }
  | { t: "tool_result"; id: string; content: unknown; isError: boolean; _seq?: number }
  | { t: "agent_progress"; id: string; tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string; subagentType?: string; description?: string; _seq?: number }
  | { t: "compact"; trigger: string; preTokens?: number; postTokens?: number; durationMs?: number; _seq?: number }
  | { t: "compacting"; active: boolean; _seq?: number }
  | { t: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; _seq?: number }
  | { t: "ask_done"; askId: string; answer: string; _seq?: number }
  | { t: "user"; text: string; _seq?: number }
  | { t: "result"; subtype: string; sessionId: string; costUsd: number; usage?: TurnUsage; _seq?: number }
  | { t: "notice"; kind: "task" | "peer" | "info" | "skill"; text: string; from?: string; status?: string; _seq?: number }
  | { t: "busy"; busy: boolean; _seq?: number }
  | { t: "error"; message: string; _seq?: number }
  | { t: "closed"; _seq?: number };

type TurnUsage = { input: number; output: number; thinking: number; cacheCreate: number; cacheRead: number; context: number; total: number; costUsd: number; durationMs: number };

// claude.ai subscription rate-limit windows (the real "session limit"), from the SDK /usage API.
type SubscriptionWin = { utilization: number | null; resetsAt: string | null };
type Subscription = { available: boolean; subscription: string | null; fiveHour: SubscriptionWin | null; sevenDay: SubscriptionWin | null } | null;

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; usage?: TurnUsage }
  | { kind: "thinking"; text: string; tokens?: number; started?: number; elapsed?: number; _peak?: number; _base?: number }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: unknown; isError?: boolean; progress?: { tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string } }
  | { kind: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; answered?: string }
  | { kind: "notice"; noticeKind: "task" | "peer" | "info" | "skill"; text: string; from?: string; status?: string }
  | { kind: "compact"; savedTokens?: number; durationMs?: number; pctBefore?: number; pctAfter?: number };
// #endregion

// #region api
const J = (r: Response) => r.json();
// Reject a request that hasn't resolved within `ms`. A hung POST on a weak link never rejects on its
// own, so without this a send would sit "sending" forever and never fall back to the offline queue.
function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const api = {
  models: () => fetch("/app/api/models").then(J),
  convs: (offset = 0) => fetch(`/app/api/conversations?offset=${offset}`).then(J),
  conversation: (id: string) => fetch(`/app/api/conversation/${encodeURIComponent(id)}`).then(J),
  start: (b: { text: string; resume?: string; model?: string; cwd?: string; cid?: string; voice?: boolean }) =>
    fetch("/app/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  send: (b: { id: string; text: string; cid?: string }) =>
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
  del: (id: string) => fetch("/app/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then(J),
  context: (id: string) => fetch(`/app/api/context?id=${encodeURIComponent(id)}`).then(J),
  compact: (id: string) => fetch("/app/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then(J),
  usage: () => fetch("/app/api/usage").then(J),
  statuses: () => fetch("/app/api/statuses").then(J),
  search: (q: string) => fetch(`/app/api/search?q=${encodeURIComponent(q)}`).then(J),
  answerAsk: (id: string, askId: string, answer: string) =>
    fetch("/app/api/ask-answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, askId, answer }) }).then(J),
};
// #endregion

// #region search
type SearchHit = { sessionId: string; title: string; snippet: string; count: number; mtime: number; cwd: string | null };
// #endregion

// Strip machine-added noise from a user turn before it's shown or compared: the hidden voice-mode
// directive we append to voice turns, and the harness's "[Image: original …]" attachment note. Done
// on the client so the directive never leaks into a bubble and so optimistic vs echoed turns match
// for dedup, regardless of whether the server build already strips them.
function sanitizeUserText(t: string): string {
  return (t || "")
    .replace(/\s*<voice-mode>[\s\S]*?<\/voice-mode>\s*/g, "")
    .replace(/\s*\[Image[^\]]*\]\s*/g, " ")
    .trim();
}

// A loaded skill is injected as a user message starting with "Base directory for this skill:
// <path>/<name>". Pull the skill name out so we can show a small card instead of the raw file.
function skillLoadName(txt: string): string | null {
  if (!txt || !txt.startsWith("Base directory for this skill:")) return null;
  const m = /^Base directory for this skill:\s*(.+)$/m.exec(txt);
  if (!m) return null;
  const p = m[1].trim().replace(/[/\\]+$/, "");
  return p.split(/[/\\]/).pop() || p;
}

// Context window size (tokens) cached PER CONVERSATION. The window is a property of the model, so a
// single global value was wrong: reopening a 200k chat after a 1M one divided the real tokens by the
// stale 1M window and badly under-read the ring (e.g. 17% for a chat that was ~88% full). We cache
// the real window (from getContextUsage) per session id, and fall back to the default window — never
// to another conversation's max. A legacy bare-number value parses to a non-object and is ignored.
const CTXMAX_KEY = "ct-app-ctxmax";
function ctxMaxMap(): Record<string, number> {
  try { const p = JSON.parse(localStorage.getItem(CTXMAX_KEY) || "{}"); return p && typeof p === "object" ? p : {}; } catch { return {}; }
}
function ctxMaxGet(id?: string | null): number {
  if (id) { const v = ctxMaxMap()[id]; if (v) return Number(v) || DEFAULT_CTX; }
  return DEFAULT_CTX;
}
function ctxMaxSet(id: string, max: number): void {
  if (!id || !max) return;
  try {
    const m = ctxMaxMap(); m[id] = max;
    const keys = Object.keys(m); if (keys.length > 200) delete m[keys[0]]; // bound the map
    localStorage.setItem(CTXMAX_KEY, JSON.stringify(m));
  } catch { /* */ }
}
// The active conversation's real window, so a compaction card (reduced in applyEvent, which has no
// conversation id in scope) shows a sensible percentage. Updated whenever the active gauge refreshes.
let activeCtxMax = DEFAULT_CTX;

function applyEvent(items: Item[], e: AppEvent): Item[] {
  // Freeze a live "thinking" block's duration the instant the first non-thinking event lands, so
  // "Thought for Ns" is fixed once the model stops reasoning (and survives reconnects in state).
  if (e.t !== "thinking" && e.t !== "thinking_delta" && e.t !== "thinking_progress") {
    const l = items[items.length - 1];
    if (l && l.kind === "thinking" && l.started && l.elapsed == null) {
      items = items.slice(); items[items.length - 1] = { ...l, elapsed: Date.now() - l.started };
    }
  }
  const last = items[items.length - 1];
  switch (e.t) {
    case "user": {
      // A loaded skill arrives as a user message that dumps the whole skill file ("Base directory
      // for this skill: <path>/<name>"). Render a compact card instead. (Also done server-side; this
      // covers transcripts replayed before that backend build ships, so no restart is needed.)
      const sk = skillLoadName(e.text);
      if (sk) return [...items, { kind: "notice", noticeKind: "skill", text: sk }];
      return [...items, { kind: "user", text: sanitizeUserText(e.text) }];
    }
    case "text":
    case "text_delta":
      if (last && last.kind === "assistant") { const c = items.slice(); c[c.length - 1] = { kind: "assistant", text: last.text + e.text }; return c; }
      return [...items, { kind: "assistant", text: e.text }];
    case "thinking_delta":
      if (last && last.kind === "thinking") { const c = items.slice(); c[c.length - 1] = { ...last, text: last.text + e.text }; return c; }
      return [...items, { kind: "thinking", text: e.text, started: Date.now() }];
    case "thinking_progress": {
      // estimated_tokens resets across thinking sub-segments (goes up, then drops back on a new
      // segment). Track the running peak per segment and carry a base of prior peaks so the
      // displayed count is a monotonic total for the whole block, not the instantaneous reading.
      const v = e.tokens || 0;
      if (last && last.kind === "thinking") {
        const peak = last._peak || 0;
        const base = last._base || 0;
        const nextBase = v < peak ? base + peak : base; // reset detected -> bank the last peak
        const nextPeak = v < peak ? v : v;
        const c = items.slice();
        c[c.length - 1] = { ...last, _base: nextBase, _peak: nextPeak, tokens: nextBase + nextPeak };
        return c;
      }
      return [...items, { kind: "thinking", text: "", tokens: v, _base: 0, _peak: v, started: Date.now() }];
    }
    case "thinking": return [...items, { kind: "thinking", text: e.text }];
    case "tool_use": return [...items, { kind: "tool", id: e.id, name: e.name, input: e.input }];
    case "agent_progress": {
      // Attach live subagent progress to its Task tool card (matched by tool_use id).
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.id === e.id) { const c = items.slice(); c[i] = { ...it, progress: { tokens: e.tokens, toolUses: e.toolUses, durationMs: e.durationMs, lastTool: e.lastTool } }; return c; }
      }
      return items; // the Task tool_use card hasn't arrived yet -> ignore
    }
    case "tool_result": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.id === e.id && it.result === undefined) {
          const c = items.slice(); c[i] = { ...it, result: e.content, isError: e.isError }; return c;
        }
      }
      return items;
    }
    case "compact": {
      // Build the persistent "freed Nk tokens" card straight from the SDK's compact_metadata (works
      // for manual AND auto compaction, live or replayed — no fragile post-hoc context diffing).
      const saved = e.preTokens != null && e.postTokens != null ? Math.max(0, e.preTokens - e.postTokens) : 0;
      const max = activeCtxMax;
      const pctBefore = max && e.preTokens != null ? (e.preTokens / max) * 100 : undefined;
      const pctAfter = max && e.postTokens != null ? (e.postTokens / max) * 100 : undefined;
      return [...items, { kind: "compact", savedTokens: saved || undefined, durationMs: e.durationMs, pctBefore, pctAfter }];
    }
    case "notice": return [...items, { kind: "notice", noticeKind: e.kind, text: e.text, from: e.from, status: e.status }];
    case "result": {
      // Stamp the turn's real token usage onto the most recent assistant block so the summary can
      // show it (output = tokens Claude actually generated, incl. thinking + tool-call args).
      if (!e.usage) return items;
      for (let i = items.length - 1; i >= 0; i--) { if (items[i].kind === "assistant") { const c = items.slice(); c[i] = { ...(c[i] as Extract<Item, { kind: "assistant" }>), usage: e.usage }; return c; } }
      return items;
    }
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

// #region conversation stores — ONE owner of items + SSE socket + cache, per conversation
// Every conversation the app touches this session is a ConvStore, held by the ConvManager in a Map
// keyed by id. A store is the single source of truth for that conversation's messages, its live/busy
// flag, its cache writer, and its ONE EventSource. Because connect() is guarded and there is one
// store per id, there is never more than one socket per conversation. Switching conversations just
// re-points the view at another store (no copy, no reconnect); background streaming is simply "a
// busy non-view store stays connected". React renders the active store via useSyncExternalStore.

const EMPTY_ITEMS: Item[] = []; // stable identity for the no-conversation view

export interface StoreHooks {
  onInit: (store: ConvStore, sessionId: string) => void; // a new-chat temp id learned its real session id
  onResult: (store: ConvStore) => void;                  // a turn finished (reorder the sidebar)
  onEvent: (store: ConvStore, e: AppEvent) => void;      // raw event tap (voice mode + stall clock)
  onContext: (store: ConvStore) => void;                 // refresh the context gauge
}

class ConvStore {
  id: string;
  items: Item[] = [];
  version = 0;           // bumped on any change — the useSyncExternalStore snapshot
  seq = -1;             // last _seq seen (dedupe across auto-reconnects)
  busy = false;
  cwd: string | null = null;
  compacting = false;
  compactStart = 0;
  hydrated = false;     // items loaded from cache or network at least once
  touched = Date.now(); // LRU key for evicting idle in-memory stores
  es: EventSource | null = null;
  private pendingEcho: string[] = []; // optimistic user turns awaiting their SSE echo
  sendState: "sending" | "delivered" | "read" | "queued" | "failed" | null = null; // delivery of the latest sent turn (Google-Messages-style ticks)
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedItems: Item[] = [];   // tail-diff baseline for the cache writer
  private lastWrite = 0;
  private subs = new Set<() => void>();
  private mgr: ConvManager;
  constructor(id: string, mgr: ConvManager) { this.id = id; this.mgr = mgr; }

  subscribe = (l: () => void) => { this.subs.add(l); return () => { this.subs.delete(l); }; };
  signal() { this.version++; for (const l of this.subs) l(); }            // notify view only
  private touch() { this.version++; this.touched = Date.now(); for (const l of this.subs) l(); this.scheduleCache(); } // notify + cache

  // ---- the one and only EventSource ----
  connect(tail = false) {
    if (this.es) return; // already the single socket for this conversation
    let es: EventSource;
    try { es = new EventSource(`/app/stream/${encodeURIComponent(this.id)}${tail ? "?tail=1" : ""}`); } catch { return; }
    this.es = es;
    es.onmessage = (ev) => { let e: AppEvent; try { e = JSON.parse(ev.data); } catch { return; } this.ingest(e); };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) this.disconnect(); }; // 404/fatal -> drop; transient -> browser retries the same socket
  }
  disconnect() {
    if (!this.es) return;
    try { this.es.onmessage = null; this.es.onerror = null; this.es.close(); } catch { /* */ }
    this.es = null;
  }
  get connected() { return !!this.es; }

  // ---- event reduction (the single applyEvent per conversation) ----
  ingest(e: AppEvent) {
    if (typeof e._seq === "number") { if (e._seq <= this.seq) return; this.seq = e._seq; }
    this.mgr.hooks?.onEvent(this, e);
    // The agent has "read" our turn the moment it starts producing (fills the delivery ticks).
    if ((this.sendState === "sending" || this.sendState === "delivered") && (e.t === "text" || e.t === "text_delta" || e.t === "thinking" || e.t === "thinking_delta" || e.t === "thinking_progress" || e.t === "tool_use")) this.setSendState("read");
    switch (e.t) {
      case "init":
        if (e.sessionId && e.sessionId !== this.id) this.mgr.rebind(this, e.sessionId);
        this.mgr.hooks?.onInit(this, e.sessionId);
        return;
      case "busy": this.busy = e.busy; this.signal(); return;
      case "compacting":
        this.compacting = e.active; this.compactStart = e.active ? (this.compactStart || Date.now()) : 0; this.signal(); return;
      case "compact":
        this.compacting = false; this.compactStart = 0;
        this.items = applyEvent(this.items, e); this.touch(); this.mgr.hooks?.onContext(this); return;
      case "user": {
        const clean = sanitizeUserText(e.text);
        const i = this.pendingEcho.indexOf(clean);
        if (i !== -1) { this.pendingEcho.splice(i, 1); if (this.sendState === "sending") this.setSendState("delivered"); return; } // our own optimistic turn echoed back = server has it
        const last = this.items[this.items.length - 1];
        if (last && last.kind === "user" && sanitizeUserText(last.text) === clean) return;
        this.items = applyEvent(this.items, e); this.touch(); return;
      }
      case "result":
        this.busy = false; this.items = applyEvent(this.items, e); this.touch();
        this.mgr.hooks?.onResult(this); this.mgr.hooks?.onContext(this); return;
      case "error":
        this.busy = false; this.items = [...this.items, { kind: "assistant", text: "\n\n_error: " + e.message + "_" }]; this.touch(); return;
      case "closed": this.disconnect(); return;
      default: this.items = applyEvent(this.items, e); this.touch(); return;
    }
  }

  // ---- mutations from the UI ----
  addOptimisticUser(text: string) { this.pendingEcho.push(text); this.items = applyEvent(this.items, { t: "user", text }); this.busy = true; this.setSendState("sending"); this.touch(); }
  // Delivery ticks for the most-recent sent turn (Google Messages: 1 tick sending -> 2 ticks delivered
  // -> 2 filled ticks when the agent reads/starts). Persists on the turn (no fade); a new send resets it.
  setSendState(s: ConvStore["sendState"]) { this.sendState = s; this.signal(); }
  answerAsk(askId: string, answer: string) { this.items = this.items.map((it) => (it.kind === "ask" && it.askId === askId ? { ...it, answered: answer } : it)); this.touch(); }
  setBusy(b: boolean) { if (this.busy === b) return; this.busy = b; this.signal(); }
  beginCompact() { this.compacting = true; this.compactStart = Date.now(); this.signal(); }
  endCompactFallback() { if (this.compacting) { this.compacting = false; this.compactStart = 0; this.signal(); } }
  showItems(items: Item[]) { this.items = items; this.signal(); } // transient placeholder view (offline note / queued)

  // ---- hydration + reconcile (the cache-vs-network policy) ----
  hydrate(items: Item[], meta: { busy?: boolean; cwd?: string | null }) {
    this.items = items; this.cachedItems = items; this.hydrated = true;
    if (meta.busy != null) this.busy = meta.busy;
    if (meta.cwd != null) this.cwd = meta.cwd;
    this.signal();
  }
  // Server transcript is truth for committed history. We keep our own tail when it's AHEAD of the
  // server (live tokens, or a just-sent turn not yet in the transcript) so nothing flickers away.
  reconcile(items: Item[], meta: { busy: boolean; cwd: string | null }) {
    this.cwd = meta.cwd; this.hydrated = true;
    const localAhead = this.pendingEcho.length > 0 || (this.busy && this.items.length >= items.length);
    if (!localAhead) { this.items = items; this.cachedItems = items; }
    this.busy = meta.busy || this.busy;
    this.signal();
  }

  // ---- cache (tail-diff, ≤1/s, event-driven) ----
  private cacheable() { return !!this.id && !this.id.startsWith("pending-") && !this.id.startsWith("new-"); }
  private scheduleCache() {
    if (!this.cacheable() || this.cacheTimer) return;
    const since = Date.now() - this.lastWrite;
    const run = () => { this.cacheTimer = null; this.lastWrite = Date.now(); this.writeCache(); };
    if (since >= 1000) run(); else this.cacheTimer = setTimeout(run, 1000 - since);
  }
  flushCache() { if (this.cacheTimer) { clearTimeout(this.cacheTimer); this.cacheTimer = null; } if (this.cacheable()) { this.lastWrite = Date.now(); this.writeCache(); } }
  private writeCache() {
    const its = this.items; if (!its.length) return;
    const prev = this.cachedItems, n = Math.min(prev.length, its.length);
    let i = 0; while (i < n && its[i] === prev[i]) i++;
    this.cachedItems = its;
    void offline.saveConvItems(this.id, its, i, { busy: this.busy, cwd: this.cwd, live: this.busy });
  }

  teardown() { this.disconnect(); this.flushCache(); this.subs.clear(); }
}

class ConvManager {
  stores = new Map<string, ConvStore>();
  hooks: StoreHooks | null = null;
  private CAP = 20; // in-memory stores kept for instant switching; idle ones past this are evicted
  ensure(id: string): ConvStore { let s = this.stores.get(id); if (!s) { s = new ConvStore(id, this); this.stores.set(id, s); } s.touched = Date.now(); return s; }
  get(id: string) { return this.stores.get(id); }
  rebind(store: ConvStore, newId: string) {
    if (store.id === newId) return;
    this.stores.delete(store.id);
    this.stores.set(newId, store); store.id = newId; store.hydrated = true; store.signal();
  }
  // Background pool: keep busy, non-active conversations streaming into cache, capped by bandwidth.
  reconcileBackground(statuses: Record<string, { busy: boolean }>, activeId: string | null, budget: number) {
    const busyIds = Object.keys(statuses).filter((id) => statuses[id]?.busy && id !== activeId && !id.startsWith("pending-"));
    const want = new Set(budget > 0 ? busyIds.slice(0, budget) : []);
    for (const id of want) { const s = this.ensure(id); if (!s.connected) { s.connect(true); void this.seed(s); } }
    for (const [id, s] of this.stores) { if (id !== activeId && s.connected && !want.has(id)) s.disconnect(); }
    this.evict(activeId);
  }
  private async seed(s: ConvStore) {
    if (s.hydrated || s.items.length) return;
    try { const d = await api.conversation(s.id); if (!s.hydrated && !s.items.length) s.hydrate((d.events || []).reduce((a: Item[], e: AppEvent) => applyEvent(a, e), [] as Item[]), { busy: d.busy, cwd: d.cwd }); } catch { /* live events still build it */ }
  }
  private evict(activeId: string | null) {
    if (this.stores.size <= this.CAP) return;
    const drop = [...this.stores.values()].filter((s) => s.id !== activeId && !s.connected && !s.busy).sort((a, b) => a.touched - b.touched);
    let over = this.stores.size - this.CAP;
    for (const s of drop) { if (over-- <= 0) break; s.teardown(); this.stores.delete(s.id); }
  }
  closeAll() { for (const s of this.stores.values()) s.teardown(); }
}
const manager = new ConvManager();
// #endregion

// #region small components
// Rough token estimate for a tool (its call args + returned result). The SDK doesn't attribute
// tokens per tool, but tool RESULTS are what fill the context, so ~chars/4 gives a useful sense of
// which tools are expensive. Clearly labelled "~".
function estToolTokens(it: Extract<Item, { kind: "tool" }>): number {
  let n = 0;
  try { n += (contentToText(it.input) || "").length; } catch { /* */ }
  try { if (it.result !== undefined) n += (contentToText(it.result) || "").length; } catch { /* */ }
  return Math.round(n / 4);
}

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
  const est = it.result !== undefined ? estToolTokens(it) : 0;
  return (
    <div className="tool">
      <button className={"tool-head" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="tname">{it.name}</span>
        <span className={"tsum" + (it.isError ? " terr" : "")}>{summary}</span>
        {est > 0 && <span className="tool-tok" title="Estimated tokens (call + result)">~{fmtTokens(est)} tokens</span>}
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

// A run of consecutive tool uses, collapsed into one accordion: "Used N tools · ~Xk tokens" (counts
// up live). Open it to see each tool card. Single tools render on their own (no accordion).
function ToolGroup({ tools, live }: { tools: Extract<Item, { kind: "tool" }>[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const n = tools.length;
  const est = tools.reduce((a, it) => a + estToolTokens(it), 0);
  return (
    <div className={"tool-group" + (open ? " open" : "")}>
      <button className="tool-group-head" onClick={() => setOpen((o) => !o)}>
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="tg-label">{live ? `Using ${n} tools…` : `Used ${n} tools`}</span>
        {est > 0 && <span className="tg-tok" title="Estimated total tokens across these tools">~{fmtTokens(est)} tokens</span>}
      </button>
      {open && <div className="tool-group-body">{tools.map((it, k) => <ToolCard key={k} it={it} />)}</div>}
    </div>
  );
}

// Rewrite local file references Claude produces (images it wrote, files it saved) to the download
// route so they preview inline / are downloadable. Remote (http/data/blob) URLs are left alone.
function rewriteLocalRefs(html: string, convId: string | null): string {
  const dl = (p: string) => `/app/api/download?id=${encodeURIComponent(convId || "")}&path=${encodeURIComponent(p)}`;
  return html
    .replace(/<img([^>]*?)\ssrc="([^"]+)"([^>]*)>/g, (m, pre, src, post) => /^(https?:|data:|blob:|\/app\/api\/)/i.test(src) ? `<img${pre} src="${src}"${post} loading="lazy">` : `<img${pre} src="${dl(src)}"${post} loading="lazy">`)
    .replace(/<a([^>]*?)\shref="([^"]+)"([^>]*)>/g, (m, pre, href, post) => /^(https?:|mailto:|#|\/app\/api\/)/i.test(href) ? m : `<a${pre} href="${dl(href)}"${post} target="_blank" rel="noreferrer" download>`);
}

function Assistant({ text, convId }: { text: string; convId?: string | null }) {
  const html = useMemo(() => rewriteLocalRefs(marked.parse(text || "") as string, convId ?? null), [text, convId]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Context-window gauge (like the real Claude app): a donut of how full the context is, green→amber
// →red, click to compact. Sits in the topbar next to the model picker.
function ContextRing({ pct, total, max, onCompact, busy, estimated }: { pct: number; total: number; max: number; onCompact: () => void; busy: boolean; estimated?: boolean }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const r = 9, C = 2 * Math.PI * r;
  const color = p >= 80 ? "var(--error, #EF4444)" : p >= 50 ? "var(--warning, #F59E0B)" : "var(--success, #10B981)";
  return (
    <button className={"ctx-ring" + (estimated ? " est" : "")} onClick={onCompact} disabled={busy || estimated} title={`Context ${estimated ? "~" : ""}${p}% full (${(total / 1000).toFixed(0)}k / ${(max / 1000).toFixed(0)}k tokens)${estimated ? " (estimated — send a message for the exact figure)" : p >= 60 ? " — click to compact" : ""}`}>
      <svg width="22" height="22" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
        <circle cx="12" cy="12" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - p / 100)} transform="rotate(-90 12 12)" />
      </svg>
      <span className="ctx-pct">{p}%</span>
    </button>
  );
}

// Human "resets in 3h 12m" from an ISO reset timestamp.
function fmtResetIn(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso); if (!t) return "";
  const ms = t - Date.now(); if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

// Subscription session-limit chip: how much of the claude.ai 5-hour rate-limit window is used, plus
// when it resets. Colour is status-only feedback (amber ≥80%, red ≥95%). Weekly window in the tooltip.
function SubscriptionChip({ sub, url }: { sub: Subscription; url?: string }) {
  if (!sub?.available || !sub.fiveHour || sub.fiveHour.utilization == null) return null;
  const u = Math.round(sub.fiveHour.utilization);
  const cls = u >= 95 ? " crit" : u >= 80 ? " warn" : "";
  const resetIn = fmtResetIn(sub.fiveHour.resetsAt);
  const weekU = sub.sevenDay?.utilization != null ? Math.round(sub.sevenDay.utilization) : null;
  const weekReset = fmtResetIn(sub.sevenDay?.resetsAt);
  const title = `Subscription session limit (5-hour window): ${u}% used${resetIn ? `, resets in ${resetIn}` : ""}`
    + (weekU != null ? `\nWeekly limit: ${weekU}% used${weekReset ? `, resets in ${weekReset}` : ""}` : "")
    + "\nOpen the usage dashboard";
  const body = (
    <>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
      <span>{u}%</span>
      {resetIn && <i className="sub-reset">{resetIn}</i>}
    </>
  );
  return url
    ? <a className={"sub-chip" + cls} href={url} target="_blank" rel="noreferrer" title={title}>{body}</a>
    : <span className={"sub-chip" + cls} title={title}>{body}</span>;
}

// Shown while a compaction runs (manual click or the /compact turn). The SDK doesn't expose an
// ETA, so this is an elapsed timer + indeterminate progress rather than a fake estimate.
function CompactionBanner({ start }: { start: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.round((now - start) / 1000));
  return (
    <div className="compact-banner">
      <div className="compact-row"><span className="spin" />Compacting conversation to free context… <span className="compact-secs">{secs}s</span></div>
      <div className="compact-bar" />
    </div>
  );
}

const DEFAULT_CTX = 200_000; // fallback window for the estimated context gauge
// Rough context-token estimate from the loaded transcript (~chars/4), for conversations that aren't
// live in memory so getContextUsage() has no real number yet.
function estimateContextTokens(items: Item[]): number {
  let chars = 0;
  for (const it of items) {
    if (it.kind === "user" || it.kind === "assistant" || it.kind === "thinking") chars += (it.text || "").length;
    else if (it.kind === "tool") { try { chars += JSON.stringify(it.input || "").length + (typeof it.result === "string" ? it.result.length : JSON.stringify(it.result ?? "").length); } catch { /* */ } }
  }
  return Math.round(chars / 4);
}

const fmtDur = (secs: number) => (secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
// The single token-count formatter, matching the terminal's usage button (overlay.js fmtCompact):
// millions past ~1M ("1.2M"), thousands below ("42k"), exact under 1k. Used everywhere (5h usage,
// tool-use estimates, thinking, turn footer) so every count reads the same.
const fmtTokens = (n: number) => {
  if (n == null || isNaN(n)) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
};

// Sum the thinking time + tokens for the turn that ends at assistant block `i` (walk back to the
// previous user/compact = turn start). Powers the Claude-Code-style summary under the final reply.
function turnThinkingTotals(items: Item[], i: number): { ms: number; tokens: number } | null {
  let start = 0;
  for (let k = i - 1; k >= 0; k--) { if (items[k].kind === "user" || items[k].kind === "compact") { start = k + 1; break; } }
  let ms = 0, tokens = 0, any = false;
  for (let k = start; k <= i; k++) {
    const it = items[k];
    if (it.kind !== "thinking") continue;
    any = true;
    if (it.elapsed != null) ms += it.elapsed; else if (it.started) ms += Math.max(0, Date.now() - it.started);
    if (it.tokens) tokens += it.tokens;
  }
  return any ? { ms, tokens } : null;
}

// Thinking indicator. LIVE: "Thinking… 12s · ~340 tokens" ticking each second. When done we hide
// the standalone indicator (the turn summary under the final reply carries the totals), unless the
// platform actually exposed the reasoning text — then we show that.
function ThinkingCard({ it, isLast }: { it: Extract<Item, { kind: "thinking" }>; isLast: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLast) return; // only the live block ticks
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isLast]);
  if (!isLast) {
    // finished: only worth showing if the reasoning text is exposed (usually redacted on subscription auth)
    return it.text ? (<div className="thinking"><div className="think-label">Thought process</div>{it.text}</div>) : null;
  }
  const secs = it.started ? Math.max(0, Math.round((now - it.started) / 1000)) : null;
  const meta = [secs == null ? "" : fmtDur(secs), it.tokens ? `~${it.tokens} tokens` : ""].filter(Boolean).join(" · ");
  return (
    <div className="thinking-live">
      <span className="think-dots"><span></span><span></span><span></span></span>
      <span className="think-label">Thinking</span>
      {meta && <span className="think-tok">{meta}</span>}
      {it.text && <div className="think-text">{it.text}</div>}
    </div>
  );
}

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg|avif)$/i;
// A user turn that carried attachments is stored as "Attached files:\n<path>\n...\n\n<message>".
// Split it back out so image paths render as thumbnails and the typed message shows on its own.
function parseUserText(text: string): { images: string[]; files: string[]; body: string } {
  if (!text.startsWith("Attached files:\n")) return { images: [], files: [], body: sanitizeUserText(text) };
  const rest = text.slice("Attached files:\n".length);
  const nl = rest.indexOf("\n\n");
  const block = nl >= 0 ? rest.slice(0, nl) : rest;
  const body = nl >= 0 ? sanitizeUserText(rest.slice(nl + 2)) : "";
  const paths = block.split("\n").map((s) => s.trim()).filter(Boolean);
  return { images: paths.filter((p) => IMG_RE.test(p)), files: paths.filter((p) => !IMG_RE.test(p)), body };
}

// Inter-agent messages arrive as a raw <cross-session-message from-name="…">…</cross-session-message>
// turn (another Claude session messaging this one). Pull out the sender and the message body so we can
// render a tidy card instead of the raw XML. The harness prose around the tag ("Another Claude session
// sent a message:" / the "this came from another session" note) sits OUTSIDE the tag, so taking the
// inner body drops it. Returns null for an ordinary user turn.
function parseAgentMessage(text: string): { from: string; body: string } | null {
  const m = text.match(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/);
  if (!m) return null;
  const name = (m[1] || "").match(/from-name="([^"]*)"/);
  return { from: (name?.[1] || "another session").trim(), body: m[2].trim() };
}

// Google-Messages-style delivery ticks, shown only under the bottom-most turn you sent: one tick while
// sending, two ticks once the server has it, two FILLED (accent) ticks once the agent reads it + starts.
function SendTicks({ state }: { state: ConvStore["sendState"] }) {
  if (!state) return null;
  if (state === "queued") return <span className="ticks queued" title="Waiting to send" aria-label="Waiting to send">🕘</span>;
  if (state === "failed") return <span className="ticks failed" title="Not sent — will retry" aria-label="Not sent">!</span>;
  const dbl = state === "delivered" || state === "read";
  const title = state === "sending" ? "Sending" : state === "delivered" ? "Delivered" : "Read";
  return (
    <span className={"ticks" + (state === "read" ? " read" : "")} title={title} aria-label={title}>
      <svg width={dbl ? 19 : 13} height="12" viewBox={dbl ? "0 0 19 12" : "0 0 13 12"} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 6.5L4.3 10L11 2.5" />
        {dbl && <path d="M7 6.5L10.3 10L17 2.5" />}
      </svg>
    </span>
  );
}

function MessageBlock({ items, i, onAnswer, convId, onMenu, onOpenArtifact, sendStatus, reading }: { items: Item[]; i: number; onAnswer: (askId: string, answer: string) => void; convId: string | null; onMenu?: (x: number, y: number, text: string, kind: "user" | "assistant", i: number) => void; onOpenArtifact?: (a: Artifact) => void; sendStatus?: ConvStore["sendState"]; reading?: "generating" | "playing" }) {
  const it = items[i];
  // Read-aloud feedback for THIS message: a "generating voice…" spinner from the tap until the first
  // audio actually plays (Kokoro TTS can take a moment), then a subtle "playing" state until it ends.
  const raPill = reading ? (
    <div className={"ra-status ra-" + reading}>
      {reading === "generating"
        ? <><span className="ra-spin" /> Generating voice…</>
        : <><span className="ra-eq"><i /><i /><i /></span> Playing…</>}
    </div>
  ) : null;
  // Messages stay natively selectable (so you can highlight part of one to copy). The copy/edit
  // menu is therefore RIGHT-CLICK only (desktop); a mobile long-press does OS text selection, not
  // our menu. Conversation rows use the full long-press menu instead (they're not selectable).
  // Desktop: right-click opens the menu, text stays selectable. Touch: a long-press opens it (so
  // read-aloud / copy are reachable on mobile), which needs selection off on the bubble so the hold
  // triggers our menu instead of the OS text-selection popup.
  const menuBind = (text: string, kind: "user" | "assistant"): Record<string, unknown> => {
    if (!onMenu) return {};
    if (IS_TOUCH) return { style: { userSelect: "none", WebkitUserSelect: "none" }, ...longPressBind((x, y) => onMenu(x, y, text, kind, i)) };
    return { onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onMenu(e.clientX, e.clientY, text, kind, i); } };
  };
  if (it.kind === "user") {
    // A message from another Claude session -> a tidy card, not the raw XML tag.
    const agent = parseAgentMessage(it.text);
    if (agent) {
      return (
        <div className="msg">
          <div className="agent-msg" {...menuBind(agent.body, "user")}>
            <div className="agent-msg-head">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 8l4 4-4 4" /><path d="M7 8l-4 4 4 4" /><path d="M14 4l-4 16" /></svg>
              <span>{agent.from}</span>
            </div>
            <AssistantContent text={agent.body} convId={convId} onOpenArtifact={onOpenArtifact} />
          </div>
          {raPill}
        </div>
      );
    }
    const { images, files, body } = parseUserText(it.text);
    return (
      <div className="msg">
        <div className="bubble-user" {...menuBind(body || it.text, "user")}>
          {images.map((p, k) => <img key={k} className="msg-img" loading="lazy" src={`/app/api/download?id=${encodeURIComponent(convId || "")}&path=${encodeURIComponent(p)}`} alt="attachment" />)}
          {files.map((p, k) => <div key={k} className="msg-file">📎 {p.split("/").pop()}</div>)}
          {body && <div className="bubble-user-text">{body}</div>}
        </div>
        {raPill}
        {sendStatus && <div className="send-ticks-row"><SendTicks state={sendStatus} /></div>}
      </div>
    );
  }
  if (it.kind === "compact") {
    // After a live compaction we know how long it took and how much context it freed — keep that as a
    // persistent record. Historical/auto compactions (no timing captured) fall back to the plain line.
    if (it.savedTokens || it.durationMs) {
      const bits: string[] = ["Compacted"];
      if (it.durationMs) bits.push(`in ${fmtDur(Math.round(it.durationMs / 1000))}`);
      if (it.savedTokens) bits.push(`· freed ${fmtTokens(it.savedTokens)} tokens`);
      if (it.pctBefore != null && it.pctAfter != null) bits.push(`(${Math.round(it.pctBefore)}% → ${Math.round(it.pctAfter)}% context)`);
      return <div className="compact-div compact-done"><span className="compact-check">✓</span> {bits.join(" ")}</div>;
    }
    return <div className="compact-div">conversation compacted</div>;
  }
  if (it.kind === "ask") return <AskCard it={it} onAnswer={onAnswer} />;
  if (it.kind === "thinking") return <ThinkingCard it={it} isLast={i === items.length - 1} />;
  if (it.kind === "tool") return isAgentTool(it.name, it.input) ? <AgentToolCard it={it} /> : <ToolCard it={it} />;
  if (it.kind === "notice") {
    if (it.noticeKind === "skill") {
      return (
        <div className="skill-card" title={`Skill "${it.text}" loaded`}>
          <span className="skill-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg></span>
          <span className="skill-text">Loaded skill <b>{it.text}</b></span>
        </div>
      );
    }
    const icon = it.noticeKind === "peer" ? "⇄" : it.noticeKind === "task" ? "⛭" : "ⓘ";
    return (
      <div className={"notice notice-" + it.noticeKind} title={it.from ? `from ${it.from}` : undefined}>
        <span className="notice-ic">{icon}</span>
        <span className="notice-text">{it.noticeKind === "peer" ? (it.from ? `${it.from}: ` : "Agent: ") : ""}{it.text}{it.status ? ` · ${it.status}` : ""}</span>
      </div>
    );
  }
  // assistant — show a role label only when it opens an assistant run
  const prev = items[i - 1];
  const showRole = !prev || prev.kind === "user" || prev.kind === "compact";
  // Turn-final assistant block? Show a Claude-Code-style footer: thinking time + the turn's REAL
  // token usage (output = what Claude generated this turn, from the SDK result message).
  const next = items[i + 1];
  const turnFinal = !next || next.kind === "user" || next.kind === "compact";
  const think = turnFinal ? turnThinkingTotals(items, i) : null;
  const usage = it.usage;
  const parts: string[] = [];
  // Real run wall-clock from the result (duration_ms); fall back to the measured thinking time.
  const secs = usage?.durationMs ? Math.round(usage.durationMs / 1000) : think ? Math.round(think.ms / 1000) : 0;
  if (secs > 0) parts.push(`Worked for ${fmtDur(secs)}`);
  // Output tokens generated since the last idle (all models), not the visible text only.
  const toks = usage?.output ?? (think ? think.tokens : 0);
  if (toks) parts.push(`${fmtTokens(toks)} output tokens`);
  const summary = turnFinal && parts.length ? parts.join(" · ") : "";
  // Hover: the full picture — output (incl. the exact thinking subset), the context read (mostly
  // cached history, so the big number), the grand total processed, and cost.
  const tip = usage ? `output ${usage.output}${usage.thinking ? ` (thinking ${usage.thinking})` : ""} · context ${usage.context.toLocaleString()} · total ${usage.total.toLocaleString()} · $${usage.costUsd.toFixed(4)}` : undefined;
  return (
    <div className="msg bubble-assistant" {...menuBind(it.text, "assistant")}>
      {showRole && <div className="role">Claude</div>}
      <AssistantContent text={it.text} convId={convId} onOpenArtifact={onOpenArtifact} />
      {raPill}
      {summary && <div className="turn-think" title={tip}>{summary}</div>}
    </div>
  );
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
  // The visible conversation is a ConvStore (the single owner of its items/SSE/cache); React renders
  // it via useSyncExternalStore and everything below derives from it. Switching = point at another store.
  const [activeStore, setActiveStore] = useState<ConvStore | null>(null);
  const activeStoreRef = useRef<ConvStore | null>(null);
  useEffect(() => { activeStoreRef.current = activeStore; }, [activeStore]);
  const subscribe = useCallback((cb: () => void) => (activeStore ? activeStore.subscribe(cb) : () => {}), [activeStore]);
  useSyncExternalStore(subscribe, () => activeStore?.version ?? 0);
  const items = activeStore ? activeStore.items : EMPTY_ITEMS;
  const activeId = activeStore?.id ?? null;
  const busy = activeStore?.busy ?? false;
  const todos = useMemo(() => latestTodos(items), [items]); // current task checklist (latest TodoWrite), pinned above the composer
  const compacting = activeStore?.compacting ?? false;
  const [model, setModel] = useState<string>(() => localStorage.getItem("ct-app-model") || "");
  const [input, setInput] = useState<string>(() => { try { return loadDraft(new URLSearchParams(location.search).get("c")); } catch { return ""; } });
  const [attachments, setAttachments] = useState<{ name: string; path: string; isImage?: boolean; preview?: string }[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateAvail, setUpdateAvail] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavsLocal()); // seed from cache so it shows instantly + offline
  const [hasMore, setHasMore] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [context, setContext] = useState<{ percentage: number; total: number; max: number; estimated?: boolean } | null>(null);
  const contextRef = useRef<typeof context>(null); // mirror, so the compact handler can read the pre-compaction context
  useEffect(() => { contextRef.current = context; }, [context]);
  const itemsRef = useRef<Item[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [usage5h, setUsage5h] = useState<{ output5h: number; url: string } | null>(null);
  const [subscription, setSubscription] = useState<Subscription>(null);
  // Shared subscription session-limit warning toast (5h limit high AND the box is contended).
  const [limitToast, setLimitToast] = useState<{ left: number; resetIn: string; n: number } | null>(null);
  const limitDismissed = useRef(false);
  const [statuses, setStatuses] = useState<Record<string, { busy: boolean; waiting: boolean }>>({});
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());
  const lastReadRef = useRef<Record<string, number>>(loadLastRead());
  const [readTick, setReadTick] = useState(0); // bump to re-render unread dots after marking read
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; text: string; kind: "user" | "assistant"; i: number } | null>(null);
  const [convMenu, setConvMenu] = useState<{ x: number; y: number; id: string; title: string; fav: boolean } | null>(null);
  const [speakFinalOnly, setSpeakFinalOnly] = useState(() => { try { return localStorage.getItem("ct-voice-final-only") === "1"; } catch { return false; } });
  const setSpeakFinal = (v: boolean) => { setSpeakFinalOnly(v); try { localStorage.setItem("ct-voice-final-only", v ? "1" : "0"); } catch { /* */ } };
  const [tapToTalk, setTapToTalkState] = useState(() => { try { return localStorage.getItem("ct-voice-ptt") === "1"; } catch { return false; } });
  const setTapToTalk = (v: boolean) => { setTapToTalkState(v); try { localStorage.setItem("ct-voice-ptt", v ? "1" : "0"); } catch { /* */ } };
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]); // available Kokoro voices
  const [ttsVoice, setTtsVoiceState] = useState<string>(() => { try { return localStorage.getItem("ct-voice-name") || ""; } catch { return ""; } });
  const setTtsVoice = (v: string) => { setTtsVoiceState(v); try { localStorage.setItem("ct-voice-name", v); } catch { /* */ } };
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Which message (item index) is being read aloud + whether we're still generating the voice (Kokoro
  // TTS latency) or actually playing it. Drives the per-message "generating voice…" / "playing" pill.
  const [reading, setReading] = useState<{ i: number; phase: "generating" | "playing" } | null>(null);
  const speaking = reading !== null; // a message is being read aloud (long-press -> Read aloud)
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  // navigator.onLine lies on flaky mobile (says "online" with no working link). `reachable` is the
  // truth from an actual 4s request heartbeat: false when requests are failing, which lets the banner
  // show "connection unstable" even while the browser insists it's online.
  const [reachable, setReachable] = useState(true);
  const [queued, setQueued] = useState(0);
  const [artifact, setArtifact] = useState<Artifact | null>(null); // the artifact open in the split-screen / sheet viewer
  const [artifactW, setArtifactW] = useState<number>(() => { const v = Number(localStorage.getItem("ct-artifact-w")); return v >= 360 && v <= 1400 ? v : 560; }); // desktop split panel width (px), draggable + persisted
  const artifactDrag = useRef<{ startX: number; startW: number } | null>(null);
  const onArtifactResizeDown = (e: React.PointerEvent) => { e.preventDefault(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ } artifactDrag.current = { startX: e.clientX, startW: artifactW }; };
  const onArtifactResizeMove = (e: React.PointerEvent) => { if (!artifactDrag.current) return; const dx = artifactDrag.current.startX - e.clientX; setArtifactW(Math.max(360, Math.min(window.innerWidth - 320, artifactDrag.current.startW + dx))); }; // drag left = wider right panel
  const onArtifactResizeUp = () => { if (artifactDrag.current) { artifactDrag.current = null; try { localStorage.setItem("ct-artifact-w", String(Math.round(artifactW))); } catch { /* */ } } };

  const lastEventAt = useRef(Date.now()); // for the stall watchdog: when did the active stream last speak
  const compactQueue = useRef<string[]>([]); // messages typed DURING compaction, sent once it finishes
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const newChatRef = useRef<(() => void) | null>(null); // lets earlier callbacks reset to a blank chat
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<string>("");
  const forceBottom = useRef(false); // scroll to the end after opening a conversation
  const stickBottom = useRef(true); // follow new content only while the user is parked at the bottom
  const [atBottom, setAtBottom] = useState(true); // drives the "jump to latest" button while streaming
  const highlightRef = useRef<string>(""); // when set, scroll to + flash the first message containing it
  const activeIdRef = useRef<string | null>(null); // latest activeId for stable callbacks (voice)
  const modelRef = useRef<string>(""); // latest model for stable callbacks (voice)
  const voiceSinks = useRef<Set<(e: AppEvent) => void>>(new Set()); // voice-mode event subscribers
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { modelRef.current = model; }, [model]);

  const nextOffsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  // Merge conversation pages, keeping the first row seen per session id (favorites, prepended on
  // page 0, win over a later recency-page duplicate).
  const dedupeConvs = (list: Conv[]) => { const seen = new Set<string>(); const out: Conv[] = []; for (const c of list) { if (seen.has(c.sessionId)) continue; seen.add(c.sessionId); out.push(c); } return out; };
  // Background cache warming: after the list loads, quietly fetch + cache the top conversations that
  // aren't cached yet, one at a time and gently, so switching to any of them is instant (paints from
  // cache) instead of showing a loader. Skips the active chat, backs off during a live turn.
  const prewarmedRef = useRef(false);
  const prewarmCache = useCallback((list: Conv[]) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const targets = list.filter((c) => !c.pending && !c.sessionId.startsWith("pending-")).slice(0, 12);
    void (async () => {
      for (const c of targets) {
        if (c.sessionId === activeIdRef.current) continue;
        if (busyRef.current) return; // don't compete with a live turn for bandwidth
        try {
          if (await offline.hasConv(c.sessionId)) continue; // already cached
          const d = await api.conversation(c.sessionId);
          const built = (d.events || []).reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
          await offline.saveConvItems(c.sessionId, built, 0, { busy: !!d.busy, cwd: d.cwd, live: !!d.live });
        } catch { /* skip this one */ }
        await new Promise((r) => setTimeout(r, 500)); // gentle on a weak link
      }
    })();
  }, []);
  const refreshConvs = useCallback(() => {
    api.convs(0)
      .then((d) => {
        const list: Conv[] = d.conversations || [];
        const favs: Conv[] = d.favorites || [];
        const merged = dedupeConvs([...favs, ...list]).sort((a, b) => b.mtime - a.mtime); // most-recent first
        setConvs(merged); offline.cacheList(merged);
        nextOffsetRef.current = typeof d.nextOffset === "number" ? d.nextOffset : list.length;
        setHasMore(!!d.hasMore);
        if (!prewarmedRef.current && merged.length) { prewarmedRef.current = true; setTimeout(() => prewarmCache(merged), 1500); }
      })
      .catch(async () => { const cached = await offline.getCachedList<Conv[]>(); if (cached) setConvs(cached); }); // offline: serve the last cached list
  }, [prewarmCache]);
  const loadMoreConvs = useCallback(() => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    api.convs(nextOffsetRef.current)
      .then((d) => {
        const more: Conv[] = d.conversations || [];
        setConvs((prev) => dedupeConvs([...prev, ...more]).sort((a, b) => b.mtime - a.mtime));
        nextOffsetRef.current = typeof d.nextOffset === "number" ? d.nextOffset : nextOffsetRef.current;
        setHasMore(!!d.hasMore);
      })
      .catch(() => {})
      .finally(() => { loadingMoreRef.current = false; });
  }, [hasMore]);
  const refreshFavs = useCallback(() => {
    api.favorites().then((d) => {
      const srv = new Set<string>((d.favorites || []).map((x: any) => String(x)));
      const pend = loadFavPending();
      const ids = Object.keys(pend);
      // apply not-yet-synced offline toggles on top of the server truth, then push them
      for (const id of ids) { if (pend[id]) srv.add(id); else srv.delete(id); }
      setFavorites(srv); saveFavsLocal(srv);
      for (const id of ids) api.toggleFav(id, pend[id]).then(() => { const p = loadFavPending(); delete p[id]; saveFavPending(p); }).catch(() => { /* still offline */ });
    }).catch(() => { setFavorites(loadFavsLocal()); }); // offline: keep the cached set
  }, []);
  const refreshContext = useCallback((id: string | null) => {
    if (!id || id.startsWith("pending-")) { setContext(null); return; }
    api.context(id).then((d) => {
      if (d?.available) { ctxMaxSet(id, d.max); activeCtxMax = d.max; setContext({ percentage: d.percentage, total: d.total, max: d.max, estimated: false }); return; }
      const max = ctxMaxGet(id); // THIS conversation's window (from when it was last live), not a global
      activeCtxMax = max;
      // Not live in memory: use the REAL context from the last committed turn's usage (stamped on
      // assistant items during replay), so a reopened conversation shows its true last-message context.
      let realCtx = 0;
      for (let k = itemsRef.current.length - 1; k >= 0; k--) { const t = itemsRef.current[k]; if (t.kind === "assistant" && t.usage) { realCtx = t.usage.context; break; } }
      if (realCtx > 0) { setContext({ percentage: Math.min(100, (realCtx / max) * 100), total: realCtx, max, estimated: false }); return; }
      const est = estimateContextTokens(itemsRef.current); // last resort (no usage recorded yet)
      setContext(est > 0 ? { percentage: Math.min(100, (est / max) * 100), total: est, max, estimated: true } : null);
    }).catch(() => { /* keep the last value on a transient error */ });
  }, []);
  const doCompact = useCallback(async () => {
    const s = activeStoreRef.current;
    if (!s || s.compacting) return;
    s.beginCompact(); // optimistic banner; the backend "compacting"/"compact" events keep it honest
    try { await api.compact(s.id); } catch { /* */ }
    // Safety net: if the compact events never arrive (e.g. dropped stream), clear the banner anyway.
    setTimeout(() => { s.endCompactFallback(); refreshContext(s.id); flushCompactRef.current(); }, 45000);
  }, [refreshContext]);
  // Which conversations have an offline message queued (resume target) — drives the queued indicator
  // on EXISTING conversations, not just brand-new offline chats.
  const refreshQueue = useCallback(async () => {
    const q = await offline.getQueue();
    setQueued(q.length);
    setQueuedIds(new Set(q.map((it: any) => it.body?.resume).filter(Boolean)));
  }, []);
  // Mark a conversation read. Store the conversation's OWN mtime (the NAS file clock, same source the
  // unread check compares against) — NOT Date.now(), whose phone clock can lag the NAS and leave the
  // dot stuck "unread" forever. max() so a stale local mtime never lowers the marker.
  const markRead = useCallback((id: string | null) => {
    if (!id || id.startsWith("pending-")) return;
    const conv = convsRef.current.find((c) => c.sessionId === id);
    const mark = conv ? Math.max(conv.mtime, lastReadRef.current[id] || 0) : (lastReadRef.current[id] || Date.now());
    lastReadRef.current[id] = mark; saveLastRead(lastReadRef.current); setReadTick((t) => t + 1);
  }, []);
  const toggleFav = useCallback((id: string) => {
    setFavorites((s) => {
      const fav = !s.has(id);
      const n = new Set(s); if (fav) n.add(id); else n.delete(id);
      saveFavsLocal(n); // durable immediately, so a reload/offline keeps it
      const pend = loadFavPending(); pend[id] = fav; saveFavPending(pend); // remember intent until the server acks
      api.toggleFav(id, fav).then((d) => {
        if (d?.favorites) { const srv = new Set<string>((d.favorites as any[]).map(String)); setFavorites(srv); saveFavsLocal(srv); }
        const p = loadFavPending(); if (p[id] === fav) { delete p[id]; saveFavPending(p); } // acked
      }).catch(() => { /* offline: stays in pending, replayed by refreshFavs on reconnect */ });
      return n;
    });
  }, []);

  useEffect(() => {
    // Paint the last cached conversation list INSTANTLY (before any network), so a cold open on a slow
    // or flaky link shows your chats immediately instead of an empty sidebar until the network answers.
    // refreshConvs() then reconciles it. Only fills if we don't already have rows (network won a race).
    void offline.getCachedList<Conv[]>().then((cached) => { if (cached?.length) setConvs((prev) => (prev.length ? prev : cached)); }).catch(() => {});
    api.models().then((d) => { setModels(d.models || []); setMoreModels(d.moreModels || []); setDefaultCwd(d.defaultCwd || ""); cwdRef.current = d.defaultCwd || ""; setVoiceAvail(!!d.voice); setVoices(d.voices || []); if (!localStorage.getItem("ct-voice-name") && d.defaultVoice) setTtsVoiceState(d.defaultVoice); if (!localStorage.getItem("ct-app-model") && d.models?.[0]) setModel(d.models[0].id); }).catch(() => {});
    refreshConvs();
    refreshFavs();
    const c = new URLSearchParams(location.search).get("c");
    if (c) void loadConv(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context-window gauge: refresh for the open conversation on open, when a turn ends (busy flips),
  // and on a slow poll while it's live.
  useEffect(() => { refreshContext(activeId); const t = setInterval(() => refreshContext(activeId), 15000); return () => clearInterval(t); }, [activeId, busy, refreshContext]);
  // Owner's rolling 5h usage + the claude.ai plan session limit for the composer footer (slow poll).
  // The plan figure is null on the first response (the server fetches it in the background), so a quick
  // second pull picks it up without waiting a whole interval.
  useEffect(() => {
    const pull = () => api.usage().then((d) => {
      setUsage5h(d?.available ? { output5h: d.output5h, url: d.url } : null);
      const s = d?.subscription?.available ? d.subscription : null;
      setSubscription(s);
      // Warn the person currently using the app when the SHARED 5h session limit is high and the
      // box is contended. activeUsers is null on a guest sidecar (no DB) -> treat as contended so
      // guests still see it. Shows once per episode; re-arms when the condition clears.
      const warnPct = typeof d?.warnPct === "number" ? d.warnPct : 70;
      const n: number | null = typeof d?.activeUsers === "number" ? d.activeUsers : null;
      const contended = n == null ? true : n >= 2;
      const u = s?.fiveHour?.utilization;
      if (typeof u === "number" && u >= warnPct && contended) {
        if (!limitDismissed.current) {
          setLimitToast({ left: Math.max(0, 100 - Math.round(u)), resetIn: fmtResetIn(s!.fiveHour!.resetsAt), n: n ?? 0 });
        }
      } else {
        limitDismissed.current = false;
        setLimitToast(null);
      }
    }).catch(() => {});
    pull(); const t = setInterval(pull, 60000); const t2 = setTimeout(pull, 5000);
    return () => { clearInterval(t); clearTimeout(t2); };
  }, []);
  // Live conversation statuses (thinking / waiting) for the list indicators + queued-message set.
  useEffect(() => {
    const pull = () => {
      if (navigator.onLine) api.statuses()
        .then((d) => { setStatuses(d?.statuses || {}); setReachable(true); })   // a real response = link works
        .catch(() => setReachable(false));                                       // request failed = link is down despite navigator.onLine
      void refreshQueue();
    };
    pull(); const t = setInterval(pull, 4000); return () => clearInterval(t);
  }, [refreshQueue]);
  // Mark the open conversation read on open and whenever its turn finishes (busy flips off).
  // Re-mark on convs updates too: after a turn finishes, refreshConvs bumps the active conversation's
  // mtime a beat later — without this, switching away right then would show it falsely unread.
  useEffect(() => { if (activeId && !busy) markRead(activeId); }, [activeId, busy, convs, markRead]);
  useEffect(() => { itemsRef.current = items; }, [items]); // for the context estimate
  // Persist the composer draft under the current conversation as it changes (so a switch or reload keeps
  // it). activeIdRef holds the live conversation id; a new chat saves under the "__new__" key.
  useEffect(() => { saveDraft(activeIdRef.current, input); }, [input]);
  const convsRef = useRef<Conv[]>([]);
  useEffect(() => { convsRef.current = convs; }, [convs]); // latest list for read-marking / lookups
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // Each store caches itself (tail-diff, ≤1/s) as its items change — no app-level cache writer. We
  // only force a flush the instant the page is hidden (phone lock / app switch), before JS freezes.
  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") activeStoreRef.current?.flushCache(); };
    const flushNow = () => activeStoreRef.current?.flushCache();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flushNow);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", flushNow); };
  }, []);
  const flushCompactRef = useRef<() => void>(() => {}); // assigned once the stores/hooks are wired

  // PWA update check: poll the server build id; if it changed since load, offer a reload.
  // Content-hashed assets + no-store index mean the reload gets everything fresh.
  useEffect(() => {
    let baseline: string | null = null;
    let stop = false;
    const check = async (foreground = false) => {
      try {
        const v = (await (await fetch("/app/api/version", { cache: "no-store" })).text()).trim();
        if (!v) return;
        if (baseline === null) { baseline = v; return; }
        if (v !== baseline) {
          // Cache the NEW build's shell + assets NOW (before the reload) so the post-update launch is
          // offline-safe too, not just the build we loaded with.
          try { navigator.serviceWorker?.ready.then((reg) => (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "ct-precache" })).catch(() => {}); } catch { /* */ }
          // On returning to the foreground (app was backgrounded/asleep), auto-update immediately —
          // unless there's an unsent draft, in which case just offer the reload toast.
          if (foreground && !(taRef.current?.value || "").trim()) { void hardRefresh(); return; }
          setUpdateAvail(true);
        }
      } catch { /* offline / transient — ignore */ }
    };
    check();
    const iv = setInterval(() => { if (!stop) check(); }, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") void check(true); }; // check the moment it's reopened
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Register the shared service worker from the app too — the terminal overlay is the only
  // other place that does, so an /app-only PWA install needs this for offline load + Background
  // Sync. Same script + scope as the terminal, so it's idempotent (no double registration).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/_ct/sw.js", { scope: "/" }).catch(() => {});
    // Ask the SW to (re)cache THIS build's shell + assets now that we've loaded, so a later cold
    // offline launch always opens. The SW also precaches on activate, but an already-active worker
    // won't re-run activate for a new build — this ping covers that.
    navigator.serviceWorker.ready.then((reg) => { (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "ct-precache" }); }).catch(() => {});
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

  // Edge-swipe to open the sidebar (right from the left edge) and swipe-left to close it. Only
  // horizontal gestures act; vertical scrolls and stationary long-presses are ignored.
  const swipe = useRef<{ x: number; y: number; fromLeft: boolean; done: boolean } | null>(null);
  const onAppTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]; if (!t) return;
    // Start in the left ~45% of the screen counts as an "open" candidate. (Not the very edge only —
    // iOS reserves the extreme edge for its own back-swipe, so that never reaches us.)
    swipe.current = { x: t.clientX, y: t.clientY, fromLeft: t.clientX < window.innerWidth * 0.45, done: false };
  };
  const onAppTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current, t = e.touches[0]; if (!s || s.done || !t) return;
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) < 12) return; // wait for a clear horizontal intent
    if (Math.abs(dx) <= Math.abs(dy) * 1.2) { s.done = true; return; } // it's a vertical scroll, bail
    if (!drawer && s.fromLeft && dx > 45) { setDrawer(true); s.done = true; }
    else if (drawer && dx < -45) { setDrawer(false); s.done = true; }
  };
  const onAppTouchEnd = () => { swipe.current = null; };

  // autoscroll: jump to the end when a conversation is opened, else follow only if near bottom.
  // useLayoutEffect (pre-paint) so a cache->network reconcile re-pins to the bottom BEFORE the browser
  // paints — otherwise the reconcile paints near the top and this yanks it down a second time (the
  // visible "scrolls from the top again" jump when opening a cached conversation).
  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return;
    if (highlightRef.current) {
      const q = highlightRef.current.toLowerCase(); highlightRef.current = "";
      let found: Element | null = null;
      for (const n of Array.from(el.querySelectorAll(".thread > *"))) { if ((n.textContent || "").toLowerCase().includes(q)) { found = n; break; } }
      if (found) { (found as HTMLElement).scrollIntoView({ block: "center" }); found.classList.add("hl-flash"); const f = found; setTimeout(() => f.classList.remove("hl-flash"), 2200); }
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (forceBottom.current) { forceBottom.current = false; stickBottom.current = true; setAtBottom(true); el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); return; }
    // Follow new content ONLY while the user is parked at the bottom. The moment they scroll up to
    // read, stickBottom goes false (see onThreadScroll) and we stop yanking them back down.
    if (stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  // Track whether the user is at the bottom. Programmatic scroll-to-bottom lands here too and
  // (correctly) re-sticks; scrolling up to read un-sticks and shows the jump-to-latest button.
  const onThreadScroll = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickBottom.current = near;
    setAtBottom((v) => (v === near ? v : near));
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    stickBottom.current = true; setAtBottom(true); el.scrollTop = el.scrollHeight;
  }, []);

  // App-level hooks the stores call: URL + list refresh when a new chat gets its real id, sidebar
  // reorder when a turn finishes, the voice tap + stall clock on every ACTIVE-store event, and the
  // context-gauge refresh. Only the active store drives the view side effects.
  useEffect(() => {
    manager.hooks = {
      onInit: (store, sid) => {
        if (store === activeStoreRef.current) { activeIdRef.current = sid; history.replaceState(null, "", `/app?c=${sid}`); }
        setTimeout(refreshConvs, 400);
      },
      onResult: () => setTimeout(refreshConvs, 500),
      onEvent: (store, e) => {
        if (store !== activeStoreRef.current) return;
        lastEventAt.current = Date.now(); // stall watchdog: the active stream is alive
        for (const fn of voiceSinks.current) { try { fn(e); } catch {} } // feed voice mode
        if (e.t === "compact") flushCompactRef.current(); // release messages typed during compaction
      },
      onContext: (store) => { if (store === activeStoreRef.current) refreshContext(store.id); },
    };
    return () => { manager.hooks = null; };
  }, [refreshConvs, refreshContext]);

  const [netTick, setNetTick] = useState(0); // bumped on connection change to re-evaluate the budget
  // How many conversations to stream in the BACKGROUND, from connection quality alone (stable, so the
  // pool doesn't churn): 0 on save-data / 2g; 1 on 3g / slow links; up to 2 on good 4g.
  const bgBudget = useCallback((): number => {
    void netTick;
    const c: any = (navigator as any).connection;
    if (c) {
      if (c.saveData) return 0;
      const et = c.effectiveType;
      if (et === "slow-2g" || et === "2g") return 0;
      if (et === "3g") return 1;
      if (typeof c.downlink === "number" && c.downlink > 0 && c.downlink < 1) return 1;
      if (typeof c.rtt === "number" && c.rtt > 600) return 1;
      return 2;
    }
    return 1; // no Network Information API (e.g. iOS Safari) -> conservative
  }, [netTick]);

  // Background pool: the manager keeps busy, non-active conversations streaming into cache (capped by
  // bandwidth). One owned socket per conversation, so this only opens missing streams / closes
  // unwanted ones — no churn. Re-runs on the 5s status poll, switch, connectivity, or bandwidth change.
  useEffect(() => {
    if (!online) { for (const s of manager.stores.values()) if (s.id !== activeId) s.disconnect(); return; }
    manager.reconcileBackground(statuses, activeId, bgBudget());
  }, [statuses, activeId, online, netTick, bgBudget]);
  useEffect(() => {
    const c: any = (navigator as any).connection;
    if (!c?.addEventListener) return;
    const onChange = () => setNetTick((n) => n + 1);
    c.addEventListener("change", onChange);
    return () => c.removeEventListener("change", onChange);
  }, []);
  useEffect(() => () => manager.closeAll(), []); // close every socket on unmount

  // Messages typed DURING a compaction are held (submitText renders them optimistically, then queues
  // the text), and sent once compaction finishes — the compact event fires onEvent -> here.
  flushCompactRef.current = () => {
    const q = compactQueue.current; compactQueue.current = [];
    const s = activeStoreRef.current; if (!q.length || !s) return;
    void (async () => {
      for (const text of q) {
        const body = { text, resume: s.id.startsWith("new-") ? undefined : s.id, model: modelRef.current || undefined, cwd: cwdRef.current || undefined };
        try { if (s.connected) await api.send({ id: s.id, text }); else { const r = await api.start(body); if (r?.id) { manager.rebind(s, r.id); s.connect(false); } } }
        catch { await offline.enqueueSend(body); void refreshQueue(); }
      }
    })();
  };

  // Open a conversation: point the view at its store, paint instantly from what we already have (memory
  // -> cache), then reconcile from the network once and connect if it's live. The store holds its items
  // continuously, so a switch is a pointer change — no reconnect, no re-fetch when it's already in memory.
  const loadConv = useCallback(async (id: string, highlight?: string) => {
    activeStoreRef.current?.flushCache(); // snapshot the conversation we're leaving so returning is instant
    const switching = activeIdRef.current !== id; // a real switch (not a same-conv reconnect/reload)
    const s = manager.ensure(id);
    setActiveStore(s); activeStoreRef.current = s;
    activeIdRef.current = id;
    if (switching) setInput(loadDraft(id)); // swap the composer to this conversation's saved draft
    setSearch(""); setSearchHits([]); // opening a result clears the search so the full list is back
    stopReadAloud(); setReading(null); // don't keep reading a message from the conversation you just left
    setDrawer(false);
    history.replaceState(null, "", `/app?c=${id}`);
    if (highlight) highlightRef.current = highlight; else forceBottom.current = true;
    // Instant paint: if the store isn't already hydrated in memory, fill it from the offline cache.
    if (!s.hydrated && !s.items.length) {
      const cached = await offline.getConv(id).catch(() => null);
      if (cached && activeStoreRef.current === s) s.hydrate(cached.items, { busy: cached.busy, cwd: cached.cwd });
    }
    if (!navigator.onLine) { if (!s.items.length) s.showItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]); return; }
    setLoadingConv(true);
    try {
      const d = await api.conversation(id);
      if (activeStoreRef.current !== s) return; // user switched away while we fetched
      const serverItems: Item[] = (d.events || []).reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
      // A live conversation blocked on an ask_user: the transcript's ask id can't unblock the tool, so
      // swap any unanswered asks for the server's real pending asks.
      if (d.live && Array.isArray(d.pendingAsks) && d.pendingAsks.length) {
        for (let i = serverItems.length - 1; i >= 0; i--) if (serverItems[i].kind === "ask" && (serverItems[i] as any).answered === undefined) serverItems.splice(i, 1);
        for (const a of d.pendingAsks) serverItems.push({ kind: "ask", askId: a.askId, question: a.question, options: a.options || [], multiSelect: a.multiSelect, allowText: a.allowText });
      }
      s.reconcile(serverItems, { busy: !!d.busy, cwd: d.cwd || defaultCwd });
      if (d.live) s.connect(true); // stream follow-up events; connect() is a no-op if already connected
    } catch {
      if (!s.items.length && activeStoreRef.current === s) s.showItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]);
    } finally { if (activeStoreRef.current === s) setLoadingConv(false); }
  }, [defaultCwd]);

  const newChat = () => { setActiveStore(null); activeStoreRef.current = null; activeIdRef.current = null; setAttachments([]); setInput(loadDraft(null)); cwdRef.current = defaultCwd; history.replaceState(null, "", "/app"); setDrawer(false); taRef.current?.focus(); };
  newChatRef.current = newChat;
  // View a queued (offline) new chat immediately — show its message + a note, without waiting for it
  // to drain into a real conversation. A pending- store never caches or connects.
  const viewPending = useCallback((c: Conv) => {
    const s = manager.ensure(c.sessionId);
    setActiveStore(s); activeStoreRef.current = s; activeIdRef.current = c.sessionId;
    s.showItems([{ kind: "user", text: c.queuedText || c.title }, { kind: "notice", noticeKind: "info", text: "Queued — this sends and starts the conversation as soon as you're back online." }]);
    setDrawer(false); history.replaceState(null, "", "/app");
  }, []);

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
    await refreshQueue();
    refreshConvs();
    // reconnect the active conversation's stream so a drained message's reply streams in live
    if (lastId && (lastId === activeIdRef.current || activeIdRef.current === null)) { const s = manager.ensure(lastId); setActiveStore(s); activeStoreRef.current = s; activeIdRef.current = lastId; s.connect(false); }
  }, [refreshConvs, refreshQueue]);

  const drainingRef = useRef(false);
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      prewarmedRef.current = false; // re-warm the cache once we're back on a connection
      void (async () => {
        await drainQueueUI();
        refreshFavs(); // flush favourite toggles made while offline
        // Reload the open conversation: while offline it may have shown a partial/uncached view,
        // and a fresh server fetch pulls the full history now that we're back.
        const id = activeIdRef.current;
        if (id && !id.startsWith("pending-")) void loadConv(id);
      })();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    void refreshQueue();
    if (navigator.onLine) void drainQueueUI(); // send anything left queued from a previous session
    // Keep trying to drain while ONLINE too: on a weak-but-connected link a send can fail and queue
    // without an offline->online transition ever firing, which used to strand the queue (and the
    // "sending N queued" banner) forever. Retry every 8s until it's empty.
    const t = setInterval(() => { if (navigator.onLine && !drainingRef.current) { drainingRef.current = true; void drainQueueUI().finally(() => { drainingRef.current = false; }); } }, 8000);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); clearInterval(t); };
  }, [drainQueueUI, loadConv, refreshFavs, refreshQueue]);
  // #endregion

  // Stall watchdog: on a weak link the SSE can die silently mid-turn, so it LOOKS like Claude stopped
  // working until you send again (which reopens the stream). While "working", if the stream has gone
  // quiet, resync from the server: reattaches the stream and picks up the ending or the missed events.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      const id = activeIdRef.current;
      if (!id || id.startsWith("pending-") || !navigator.onLine) return;
      const quietFor = Date.now() - lastEventAt.current;
      const st = statuses[id];
      const serverDone = st ? !st.busy : false; // server knows this conv and says the turn ended
      // Missed the ending (server done but we still show busy) -> resync fast. Otherwise resync after a
      // shorter silence so a weak-signal stall recovers on its own. Drop the (possibly silently-dead)
      // socket first so loadConv's connect() actually reopens it instead of no-opping on a stale one.
      if ((serverDone && quietFor > 6000) || quietFor > 15000) { lastEventAt.current = Date.now(); activeStoreRef.current?.disconnect(); void loadConv(id); }
    }, 4000);
    return () => clearInterval(t);
  }, [busy, statuses, loadConv]);

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
  const submitText = useCallback(async (text: string, opts?: { voice?: boolean }): Promise<string | null> => {
    if (!text.trim()) return null;
    stickBottom.current = true; setAtBottom(true); // sending re-anchors to the bottom so you see your turn + the reply
    // Ensure there's a store to send into (a brand-new chat gets a temp store, promoted to its real id
    // when the server assigns one). addOptimisticUser renders the turn + flips busy immediately.
    let s = activeStoreRef.current;
    const isNewChat = !s || s.id.startsWith("pending-");
    if (isNewChat) { s = manager.ensure("new-" + Date.now().toString(36) + Math.floor(performance.now())); setActiveStore(s); activeStoreRef.current = s; }
    s!.addOptimisticUser(text); // renders the turn, flips busy, sets sendState "sending"
    // Stable client id so a redelivery (offline queue OR a timeout requeue) is deduped server-side
    // instead of posting the same turn twice.
    const cid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    const body = { text, cid, resume: s!.id.startsWith("new-") ? undefined : s!.id, model: modelRef.current || undefined, cwd: cwdRef.current || undefined, voice: opts?.voice || undefined };
    const queue = async () => {
      await offline.enqueueSend(body); offline.requestBackgroundSync(); offline.queueCount().then(setQueued);
      // A chat STARTED offline has no server id yet, so it wouldn't show anywhere. Drop a local
      // placeholder into the sidebar, flagged pending, so it's visible + clearly "waiting to send".
      if (isNewChat) {
        const firstLine = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
        const pid = "pending-" + Date.now();
        setConvs((cs) => [{ sessionId: pid, title: firstLine, cwd: cwdRef.current || null, mtime: Date.now(), pending: true, queuedText: text }, ...cs]);
      }
      s!.setBusy(false); s!.setSendState("queued"); // visibly waiting to send, not lost
    };
    if (typeof navigator !== "undefined" && !navigator.onLine) { await queue(); return null; } // offline: hold it, send on reconnect
    // During compaction, hold the message (already rendered optimistically) and send it once the
    // compaction finishes, so it isn't lost or racing the /compact turn.
    if (s!.compacting && !s!.id.startsWith("new-")) { compactQueue.current.push(text); return s!.id; }
    try {
      // withTimeout so a hung request on a weak link fails fast into the queue instead of sitting
      // "sending" forever. A redelivery is deduped by cid, so the timeout can't double-send.
      if (s!.connected && !s!.id.startsWith("new-")) { await withTimeout(api.send({ id: s!.id, text, cid })); if (s!.sendState === "sending") s!.setSendState("delivered"); return s!.id; }
      const r = await withTimeout(api.start(body));
      if (r?.id) { manager.rebind(s!, r.id); activeIdRef.current = r.id; s!.connect(false); if (s!.sendState === "sending") s!.setSendState("delivered"); return r.id; }
      s!.setBusy(false); return null;
    } catch { await queue(); return null; } // network died / timed out mid-send -> queue for reconnect
  }, []);

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
    submit: (text: string) => submitText(text, { voice: true }), // flag the turn so the backend adds the brief/TTS directive
    subscribe: (fn) => { voiceSinks.current.add(fn as (e: AppEvent) => void); return () => { voiceSinks.current.delete(fn as (e: AppEvent) => void); }; },
  }), [submitText]);

  const stop = async () => { const s = activeStoreRef.current; if (!s) return; s.setBusy(false); await api.interrupt(s.id); };

  // #region context menus (long-press / right-click): message copy+edit, conversation rename+delete
  const onMsgMenu = useCallback((x: number, y: number, text: string, kind: "user" | "assistant", i: number) => setMsgMenu({ x, y, text, kind, i }), []);
  const copyText = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* */ } };
  const editIntoComposer = (t: string) => { setInput(t); setMsgMenu(null); requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; ta.setSelectionRange(t.length, t.length); } }); };
  const deleteConv = useCallback(async (id: string) => {
    setConvMenu(null);
    setConvs((cs) => cs.filter((c) => c.sessionId !== id)); // optimistic
    void offline.deleteConvCache(id); // drop its cached messages too
    try { await api.del(id); } catch { refreshConvs(); return; }
    if (activeIdRef.current === id) newChatRef.current?.();
  }, [refreshConvs]);
  const renameConv = async (id: string, current: string) => {
    setConvMenu(null);
    const next = (typeof window !== "undefined" ? window.prompt("Rename conversation", current) : null);
    if (next == null) return;
    const t = next.trim();
    setConvs((cs) => cs.map((c) => (c.sessionId === id ? { ...c, title: t || c.title } : c)));
    try { await api.setTitle(id, t); } catch { /* */ }
  };
  // #endregion

  // User tapped an ask_user option: mark it chosen locally + tell the server (unblocks Claude).
  const answerAsk = useCallback((askId: string, answer: string) => {
    const s = activeStoreRef.current; if (!s) return;
    s.answerAsk(askId, answer);
    api.answerAsk(s.id, askId, answer).catch(() => {});
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
    if (activeStoreRef.current?.connected && activeId) { try { await api.setModel({ id: activeId, model: m }); } catch { /* */ } }
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
    const files = Array.from(e.target.files || []); e.target.value = ""; if (!files.length) return;
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const preview = isImage ? URL.createObjectURL(f) : undefined; // local thumbnail, no server round-trip
      try { const r = await api.upload(activeId, f); if (r?.path) setAttachments((a) => [...a, { name: f.name, path: r.path, isImage, preview }]); }
      catch { if (preview) URL.revokeObjectURL(preview); }
    }
  };

  // Desktop: Enter sends, Shift+Enter is a newline. Touch devices (phone/tablet): Enter is always a
  // newline — sending is the dedicated send button, so the on-screen keyboard's return key composes.
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !IS_TOUCH) { e.preventDefault(); void doSend(); } };
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInput(e.target.value); const ta = e.target; ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };

  const modelLabel = [...models, ...moreModels].find((m) => m.id === model)?.label || model || "Model";

  // sidebar grouping — favorites pulled into their own section, the rest grouped by recency
  const favConvs = useMemo(() => convs.filter((c) => favorites.has(c.sessionId)).sort((a, b) => b.mtime - a.mtime), [convs, favorites]);
  const groups = useMemo(() => {
    const g: { label: string; items: Conv[] }[] = [];
    for (const c of convs) {
      if (favorites.has(c.sessionId)) continue;
      const l = groupLabel(c.mtime); let last = g[g.length - 1]; if (!last || last.label !== l) { last = { label: l, items: [] }; g.push(last); } last.items.push(c);
    }
    return g;
  }, [convs, favorites]);

  // Per-conversation status for the sidebar dot: queued > thinking > waiting-for-input > unread.
  const convStatus = (c: Conv): "queued" | "thinking" | "waiting" | "unread" | null => {
    if (c.pending || queuedIds.has(c.sessionId)) return "queued";
    const st = statuses[c.sessionId];
    if (st?.busy) return "thinking";
    if (st?.waiting) return "waiting";
    void readTick; // re-read lastRead when it bumps
    const lr = lastReadRef.current[c.sessionId];
    if (c.sessionId !== activeId && lr != null && c.mtime > lr) return "unread";
    return null;
  };
  const STATUS_LABEL: Record<string, string> = { queued: "Queued — will send", thinking: "Thinking…", waiting: "Waiting for your input", unread: "Unread activity" };
  const renderConv = (c: Conv) => {
    const fav = favorites.has(c.sessionId);
    const status = convStatus(c);
    if (c.pending) {
      // Started offline, not sent yet: clock icon + muted, not openable until it drains.
      return (
        <div key={c.sessionId} className={"conv-item pending" + (c.sessionId === activeId ? " active" : "")} title={"Queued — tap to view. " + c.title} onClick={() => viewPending(c)}>
          <svg className="conv-ic" width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="conv-title">{c.title}</span>
          <span className="conv-pending-tag">Queued</span>
        </div>
      );
    }
    return (
      <div key={c.sessionId} className={"conv-item" + (c.sessionId === activeId ? " active" : "")} title={c.title} onClick={() => loadConv(c.sessionId, search.trim() || undefined)} {...longPressBind((x, y) => setConvMenu({ x, y, id: c.sessionId, title: c.title, fav }))}>
        {status
          ? <span className={"conv-status " + status} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
          : <svg className="conv-ic" width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 11.5a8.5 8.5 0 0 1-9 8.32 8.5 8.5 0 0 1-3.6-.8L3 20l1.3-3.9A8.5 8.5 0 1 1 21 11.5z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        <span className={"conv-title" + (status === "unread" ? " unread" : "")}>{c.title}</span>
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
    <div className={"app" + (drawer ? " drawer-open" : "")} onTouchStart={onAppTouchStart} onTouchMove={onAppTouchMove} onTouchEnd={onAppTouchEnd}>
      {updateAvail && (
        <div className="update-toast" role="status">
          <span>A new version is available.</span>
          <button className="ut-reload" onClick={hardRefresh}>Reload</button>
          <button className="ut-dismiss" onClick={() => setUpdateAvail(false)} aria-label="Dismiss">×</button>
        </div>
      )}
      {limitToast && (
        <div className="limit-toast" role="status">
          <svg className="lt-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
          <span>
            Close to the session limit — about {limitToast.left}% left{limitToast.resetIn && limitToast.resetIn !== "now" ? `, resets in ${limitToast.resetIn}` : ""}.
            {limitToast.n >= 2 ? ` ${limitToast.n} people are sharing it right now.` : ""}
          </span>
          <button className="ut-dismiss" onClick={() => { limitDismissed.current = true; setLimitToast(null); }} aria-label="Dismiss">×</button>
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
      {settingsOpen && (
        <div className="modal-scrim" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Settings<button className="modal-x" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button></div>
            <div className="settings-body">
              <div className="settings-section">Voice</div>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Speak only the final response</span>
                  <span className="settings-row-desc">In voice mode, stay quiet while Claude works and read back just the finished answer, not the running commentary.</span>
                </span>
                <button role="switch" aria-checked={speakFinalOnly} className={"toggle" + (speakFinalOnly ? " on" : "")} onClick={() => setSpeakFinal(!speakFinalOnly)}><span className="knob" /></button>
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Tap to talk</span>
                  <span className="settings-row-desc">Open the mic only when you tap, instead of listening the whole time. Better in the car: the phone stays off the hands-free call profile between turns, so replies play as loud media and your music can duck and resume.</span>
                </span>
                <button role="switch" aria-checked={tapToTalk} className={"toggle" + (tapToTalk ? " on" : "")} onClick={() => setTapToTalk(!tapToTalk)}><span className="knob" /></button>
              </label>
              {voices.length > 0 && (
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Voice</span>
                    <span className="settings-row-desc">Which text-to-speech voice reads replies aloud (voice mode and read-aloud).</span>
                  </span>
                  <select className="settings-select" value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
                    {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="scrim" onClick={() => setDrawer(false)} />
      <aside className="sidebar">
        <div className="sb-head">
          <span className="brand">Claude</span>
          <button className="sb-gear" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
        </div>
        <button className="new-chat" onClick={newChat}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          New chat
        </button>
        <div className="sb-search">
          <svg className="sb-search-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats & messages" />
          {search && <button className="sb-search-x" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
        </div>
        <div className="conv-list" onScroll={(e) => {
          if (q) return; // search view isn't paginated
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) loadMoreConvs();
        }}>
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
              {hasMore && <div className="conv-group-label conv-more" onClick={loadMoreConvs}>Load more…</div>}
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
        </div>
        {loadingConv && <div className="load-bar" aria-label="Loading conversation" />}

        {(!online || !reachable || queued > 0) && (
          <div className={"net-banner" + (!online ? "" : !reachable ? " warn" : " sending")}>
            {!online
              ? (queued > 0 ? `Offline — ${queued} message${queued > 1 ? "s" : ""} queued, will send when you reconnect` : "You're offline — cached conversations available")
              : !reachable
                ? (queued > 0 ? `Connection unstable — retrying ${queued} queued message${queued > 1 ? "s" : ""}…` : "Connection unstable — retrying…")
                : `Sending ${queued} queued message${queued > 1 ? "s" : ""}…`}
          </div>
        )}
        <div className="scroll" ref={scrollRef} onScroll={onThreadScroll}>
          {items.length === 0 ? (
            <div className="empty">
              <h2>What can I help with?</h2>
              <div>Ask anything. This drives Claude Code in {cwdRef.current || "your project"}.</div>
            </div>
          ) : (
            <div className="thread">
              {(() => {
                const nodes: React.ReactNode[] = [];
                // Plain tools collapse into an accordion; subagent/workflow (Task) tools stay standalone
                // (rich activity card); TodoWrite is hidden here (the pinned checklist replaces it).
                const isPlainTool = (t: Item) => t.kind === "tool" && !isAgentTool((t as Extract<Item, { kind: "tool" }>).name, (t as Extract<Item, { kind: "tool" }>).input) && !isTodoTool((t as Extract<Item, { kind: "tool" }>).name);
                let lastUserIdx = -1; for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === "user") { lastUserIdx = k; break; }
                for (let i = 0; i < items.length; i++) {
                  const cur = items[i];
                  if (cur.kind === "tool" && isTodoTool((cur as Extract<Item, { kind: "tool" }>).name)) continue; // pinned checklist replaces the inline card
                  if (isPlainTool(items[i])) {
                    let j = i; const run: Extract<Item, { kind: "tool" }>[] = [];
                    while (j < items.length && isPlainTool(items[j])) { run.push(items[j] as Extract<Item, { kind: "tool" }>); j++; }
                    if (run.length >= 2) { // collapse a run of tools into one accordion
                      nodes.push(<ToolGroup key={"tg" + i} tools={run} live={busy && j === items.length} />);
                      i = j - 1; continue;
                    }
                  }
                  nodes.push(<MessageBlock key={i} items={items} i={i} onAnswer={answerAsk} convId={activeId} onMenu={onMsgMenu} onOpenArtifact={setArtifact} sendStatus={i === lastUserIdx ? (activeStore?.sendState ?? null) : null} reading={reading?.i === i ? reading.phase : undefined} />);
                }
                return nodes;
              })()}
              {compacting && <CompactionBanner start={activeStore?.compactStart ?? 0} />}
              {busy && !compacting && items[items.length - 1]?.kind === "user" && (<div className="msg bubble-assistant"><div className="typing"><span></span><span></span><span></span></div></div>)}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {!atBottom && items.length > 0 && (
            <button className="jump-latest" onClick={jumpToLatest} title="Jump to latest" aria-label="Jump to latest">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            </button>
          )}
          {todos && <TodoChecklist todos={todos} />}
          <div className="composer">
            {attachments.length > 0 && (
              <div className="attach-row">
                {attachments.map((a, i) => (
                  <span key={i} className={"chip" + (a.isImage ? " chip-img" : "")}>
                    {a.isImage && a.preview ? <img className="chip-thumb" src={a.preview} alt={a.name} /> : "📎 "}
                    <span className="chip-name">{a.name}</span>
                    <button onClick={() => { const rem = attachments[i]; if (rem?.preview) URL.revokeObjectURL(rem.preview); setAttachments((x) => x.filter((_, j) => j !== i)); }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <textarea ref={taRef} value={input} onChange={onInput} onKeyDown={onKey} rows={1} placeholder="Reply to Claude..." />
            <div className="composer-actions">
              {/* Photo/gallery picker: accept=image/* makes Android/iOS open the photo library (with a
                  camera option), not the file browser. The paperclip stays for any-file attachments. */}
              <label className="act-btn" title="Add photo">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" /><circle cx="8.5" cy="10" r="1.6" fill="currentColor" /><path d="M4 17l5-4 4 3 3-2 4 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onFile} />
              </label>
              <label className="act-btn" title="Attach file">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.3 3.3 0 014.7 4.7l-9.2 9.2a1.6 1.6 0 01-2.3-2.3l8.5-8.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <input type="file" multiple style={{ display: "none" }} onChange={onFile} />
              </label>
              <button className="act-btn" onClick={() => setSettingsOpen(true)} title="Connections & tools (MCP servers, memory, skills)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v3M15 7V4a1 1 0 0 0-1-1M7 7h10l-.6 9a3 3 0 0 1-3 2.8H10.6a3 3 0 0 1-3-2.8L7 7z" /><path d="M12 18v3" /></svg>
              </button>
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
          <div className="composer-foot">
            <div className="model-picker up">
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
            <div className="cf-spacer" />
            {activeId && context && <span className="cf-convtok" title="Total tokens in this conversation right now">{fmtTokens(context.total)}</span>}
            {usage5h && (
              <a className="usage-chip" href={usage5h.url} target="_blank" rel="noreferrer" title="Output tokens in the last 5 hours — open the usage dashboard">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>
                <span>{fmtTokens(usage5h.output5h)}</span>
              </a>
            )}
            <SubscriptionChip sub={subscription} url={usage5h?.url} />
            {activeId && context && <ContextRing pct={context.percentage} total={context.total} max={context.max} onCompact={doCompact} busy={compacting} estimated={context.estimated} />}
          </div>
        </div>
      </main>
      {artifact && (
        window.matchMedia("(max-width: 820px)").matches
          ? <ArtifactViewer artifact={artifact} mode="sheet" onClose={() => setArtifact(null)} />
          : <div className="artifact-panel" style={{ flex: `0 0 ${artifactW}px` }}>
              <div className="artifact-resizer" onPointerDown={onArtifactResizeDown} onPointerMove={onArtifactResizeMove} onPointerUp={onArtifactResizeUp} onPointerCancel={onArtifactResizeUp} title="Drag to resize" aria-label="Resize artifact panel" />
              <ArtifactViewer artifact={artifact} mode="panel" onClose={() => setArtifact(null)} />
            </div>
      )}
      {msgMenu && (
        <>
          <div className="ctx-scrim" onClick={() => setMsgMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMsgMenu(null); }} />
          <div className="ctx-menu" style={{ top: Math.min(msgMenu.y, window.innerHeight - 160), left: Math.min(msgMenu.x, window.innerWidth - 180) }}>
            {speaking ? (
              <button onClick={() => { stopReadAloud(); setReading(null); setMsgMenu(null); }}>Stop reading</button>
            ) : (
              <button onClick={() => {
                const t = msgMenu.text, mi = msgMenu.i; setMsgMenu(null);
                setReading({ i: mi, phase: "generating" }); // show the spinner on this message from the tap
                readAloud(t, {
                  useServerTts: voiceAvail && online,
                  voice: ttsVoice || undefined,
                  onStart: () => setReading((r) => (r && r.i === mi ? { i: mi, phase: "playing" } : r)), // first audio -> clear the spinner
                  onEnd: () => setReading((r) => (r && r.i === mi ? null : r)),
                });
              }}>Read aloud</button>
            )}
            <button onClick={() => { copyText(msgMenu.text); setMsgMenu(null); }}>Copy text</button>
            {msgMenu.kind === "user" && <button onClick={() => editIntoComposer(msgMenu.text)}>Edit</button>}
          </div>
        </>
      )}
      {convMenu && (
        <>
          <div className="ctx-scrim" onClick={() => setConvMenu(null)} onContextMenu={(e) => { e.preventDefault(); setConvMenu(null); }} />
          <div className="ctx-menu" style={{ top: Math.min(convMenu.y, window.innerHeight - 160), left: Math.min(convMenu.x, window.innerWidth - 180) }}>
            <button onClick={() => renameConv(convMenu.id, convMenu.title)}>Rename</button>
            <button onClick={() => { toggleFav(convMenu.id); setConvMenu(null); }}>{convMenu.fav ? "Unfavorite" : "Favorite"}</button>
            <button className="ctx-danger" onClick={() => deleteConv(convMenu.id)}>Delete</button>
          </div>
        </>
      )}
      <VoiceMode bridge={voiceBridge} open={voiceOpen} onClose={() => setVoiceOpen(false)} pendingAsk={pendingAsk} onAnswer={answerAsk} speakFinalOnly={speakFinalOnly} ttsVoice={ttsVoice || undefined} tapToTalk={tapToTalk} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
