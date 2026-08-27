// Chat-app front-end. A Claude-app-style UI that drives Claude Code through the
// headless Agent SDK via the /app* routes in app-server.ts. The terminal stays one
// click away (the "Terminal" link -> "/").
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { VoiceMode, type VoiceBridge, readAloud, stopReadAloud } from "./voice";
import { AskCard } from "./askcard";
import * as offline from "./offline";

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

// Long-press (touch, ~500ms, cancelled on scroll) or right-click (desktop) → open a context menu at
// (x, y). Returns handlers to spread onto the target element.
function longPressBind(open: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sx = 0, sy = 0, fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); open(e.clientX, e.clientY); },
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; sx = t?.clientX || 0; sy = t?.clientY || 0; fired = false; clear(); timer = setTimeout(() => { timer = null; fired = true; open(sx, sy); }, 500); },
    onTouchMove: (e: React.TouchEvent) => { const t = e.touches[0]; if (t && (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10)) clear(); },
    onTouchEnd: (e: React.TouchEvent) => { clear(); if (fired) { e.preventDefault(); fired = false; } }, // swallow the click that a long-press would otherwise fire
    onTouchCancel: clear,
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
  | { t: "compact"; trigger: string; _seq?: number }
  | { t: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; _seq?: number }
  | { t: "ask_done"; askId: string; answer: string; _seq?: number }
  | { t: "user"; text: string; _seq?: number }
  | { t: "result"; subtype: string; sessionId: string; costUsd: number; usage?: TurnUsage; _seq?: number }
  | { t: "notice"; kind: "task" | "peer" | "info"; text: string; from?: string; status?: string; _seq?: number }
  | { t: "busy"; busy: boolean; _seq?: number }
  | { t: "error"; message: string; _seq?: number }
  | { t: "closed"; _seq?: number };

type TurnUsage = { input: number; output: number; thinking: number; cacheCreate: number; cacheRead: number; context: number; total: number; costUsd: number; durationMs: number };

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; usage?: TurnUsage }
  | { kind: "thinking"; text: string; tokens?: number; started?: number; elapsed?: number; _peak?: number; _base?: number }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: unknown; isError?: boolean }
  | { kind: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean; answered?: string }
  | { kind: "notice"; noticeKind: "task" | "peer" | "info"; text: string; from?: string; status?: string }
  | { kind: "compact"; savedTokens?: number; durationMs?: number; pctBefore?: number; pctAfter?: number };
// #endregion

// #region api
const J = (r: Response) => r.json();
const api = {
  models: () => fetch("/app/api/models").then(J),
  convs: (offset = 0) => fetch(`/app/api/conversations?offset=${offset}`).then(J),
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
    case "user": return [...items, { kind: "user", text: e.text }];
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
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

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
  if (!text.startsWith("Attached files:\n")) return { images: [], files: [], body: text };
  const rest = text.slice("Attached files:\n".length);
  const nl = rest.indexOf("\n\n");
  const block = nl >= 0 ? rest.slice(0, nl) : rest;
  const body = nl >= 0 ? rest.slice(nl + 2) : "";
  const paths = block.split("\n").map((s) => s.trim()).filter(Boolean);
  return { images: paths.filter((p) => IMG_RE.test(p)), files: paths.filter((p) => !IMG_RE.test(p)), body };
}

function MessageBlock({ items, i, onAnswer, convId, onMenu }: { items: Item[]; i: number; onAnswer: (askId: string, answer: string) => void; convId: string | null; onMenu?: (x: number, y: number, text: string, kind: "user" | "assistant") => void }) {
  const it = items[i];
  // Messages stay natively selectable (so you can highlight part of one to copy). The copy/edit
  // menu is therefore RIGHT-CLICK only (desktop); a mobile long-press does OS text selection, not
  // our menu. Conversation rows use the full long-press menu instead (they're not selectable).
  // Desktop: right-click opens the menu, text stays selectable. Touch: a long-press opens it (so
  // read-aloud / copy are reachable on mobile), which needs selection off on the bubble so the hold
  // triggers our menu instead of the OS text-selection popup.
  const menuBind = (text: string, kind: "user" | "assistant"): Record<string, unknown> => {
    if (!onMenu) return {};
    if (IS_TOUCH) return { style: { userSelect: "none", WebkitUserSelect: "none" }, ...longPressBind((x, y) => onMenu(x, y, text, kind)) };
    return { onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onMenu(e.clientX, e.clientY, text, kind); } };
  };
  if (it.kind === "user") {
    const { images, files, body } = parseUserText(it.text);
    return (
      <div className="msg">
        <div className="bubble-user" {...menuBind(body || it.text, "user")}>
          {images.map((p, k) => <img key={k} className="msg-img" loading="lazy" src={`/app/api/download?id=${encodeURIComponent(convId || "")}&path=${encodeURIComponent(p)}`} alt="attachment" />)}
          {files.map((p, k) => <div key={k} className="msg-file">📎 {p.split("/").pop()}</div>)}
          {body && <div className="bubble-user-text">{body}</div>}
        </div>
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
  if (it.kind === "tool") return <ToolCard it={it} />;
  if (it.kind === "notice") {
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
      <Assistant text={it.text} convId={convId} />
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
  const [items, setItems] = useState<Item[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(() => localStorage.getItem("ct-app-model") || "");
  const [input, setInput] = useState("");
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
  const [compacting, setCompacting] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [usage5h, setUsage5h] = useState<{ output5h: number; url: string } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, { busy: boolean; waiting: boolean }>>({});
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());
  const lastReadRef = useRef<Record<string, number>>(loadLastRead());
  const [readTick, setReadTick] = useState(0); // bump to re-render unread dots after marking read
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; text: string; kind: "user" | "assistant" } | null>(null);
  const [convMenu, setConvMenu] = useState<{ x: number; y: number; id: string; title: string; fav: boolean } | null>(null);
  const [speakFinalOnly, setSpeakFinalOnly] = useState(() => { try { return localStorage.getItem("ct-voice-final-only") === "1"; } catch { return false; } });
  const setSpeakFinal = (v: boolean) => { setSpeakFinalOnly(v); try { localStorage.setItem("ct-voice-final-only", v ? "1" : "0"); } catch { /* */ } };
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false); // a message is being read aloud (long-press -> Read aloud)
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [queued, setQueued] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const esOpen = useRef(false);
  const lastSeq = useRef(-1);
  const lastEventAt = useRef(Date.now()); // for the stall watchdog: when did the live stream last say anything
  const compactingRef = useRef(false); // mirror of `compacting` for stable callbacks
  const compactQueue = useRef<string[]>([]); // messages typed DURING compaction, sent once it finishes
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const newChatRef = useRef<(() => void) | null>(null); // lets earlier callbacks reset to a blank chat
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<string>("");
  const pendingUser = useRef<string[]>([]); // optimistic user turns awaiting their SSE echo
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
  const refreshConvs = useCallback(() => {
    api.convs(0)
      .then((d) => {
        const list: Conv[] = d.conversations || [];
        const favs: Conv[] = d.favorites || [];
        const merged = dedupeConvs([...favs, ...list]); // favorites always present, even if aged out
        setConvs(merged); offline.cacheList(merged);
        nextOffsetRef.current = typeof d.nextOffset === "number" ? d.nextOffset : list.length;
        setHasMore(!!d.hasMore);
      })
      .catch(async () => { const cached = await offline.getCachedList<Conv[]>(); if (cached) setConvs(cached); }); // offline: serve the last cached list
  }, []);
  const loadMoreConvs = useCallback(() => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    api.convs(nextOffsetRef.current)
      .then((d) => {
        const more: Conv[] = d.conversations || [];
        setConvs((prev) => dedupeConvs([...prev, ...more]));
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
      if (d?.available) { try { localStorage.setItem("ct-app-ctxmax", String(d.max)); } catch { /* */ } setContext({ percentage: d.percentage, total: d.total, max: d.max, estimated: false }); return; }
      const max = Number(localStorage.getItem("ct-app-ctxmax")) || DEFAULT_CTX;
      // Not live in memory: use the REAL context from the last committed turn's usage (stamped on
      // assistant items during replay), so a reopened conversation shows its true last-message context.
      let realCtx = 0;
      for (let k = itemsRef.current.length - 1; k >= 0; k--) { const t = itemsRef.current[k]; if (t.kind === "assistant" && t.usage) { realCtx = t.usage.context; break; } }
      if (realCtx > 0) { setContext({ percentage: Math.min(100, (realCtx / max) * 100), total: realCtx, max, estimated: false }); return; }
      const est = estimateContextTokens(itemsRef.current); // last resort (no usage recorded yet)
      setContext(est > 0 ? { percentage: Math.min(100, (est / max) * 100), total: est, max, estimated: true } : null);
    }).catch(() => { /* keep the last value on a transient error */ });
  }, []);
  const compactStartRef = useRef(0);
  const doCompact = useCallback(async () => {
    if (!activeIdRef.current || compacting) return;
    compactStartRef.current = Date.now();
    setCompacting(true);
    try { await api.compact(activeIdRef.current); } catch { /* */ }
    // Cleared for real by the compact event (handleEvent); this is just a safety net.
    setTimeout(() => { setCompacting(false); compactingRef.current = false; refreshContext(activeIdRef.current); flushCompactRef.current(); }, 45000);
  }, [compacting, refreshContext]);
  // Which conversations have an offline message queued (resume target) — drives the queued indicator
  // on EXISTING conversations, not just brand-new offline chats.
  const refreshQueue = useCallback(async () => {
    const q = await offline.getQueue();
    setQueued(q.length);
    setQueuedIds(new Set(q.map((it: any) => it.body?.resume).filter(Boolean)));
  }, []);
  // Mark a conversation read (its unread dot clears until new activity bumps mtime past this).
  const markRead = useCallback((id: string | null) => {
    if (!id || id.startsWith("pending-")) return;
    lastReadRef.current[id] = Date.now(); saveLastRead(lastReadRef.current); setReadTick((t) => t + 1);
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
    api.models().then((d) => { setModels(d.models || []); setMoreModels(d.moreModels || []); setDefaultCwd(d.defaultCwd || ""); cwdRef.current = d.defaultCwd || ""; setVoiceAvail(!!d.voice); if (!localStorage.getItem("ct-app-model") && d.models?.[0]) setModel(d.models[0].id); }).catch(() => {});
    refreshConvs();
    refreshFavs();
    const c = new URLSearchParams(location.search).get("c");
    if (c) void loadConv(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context-window gauge: refresh for the open conversation on open, when a turn ends (busy flips),
  // and on a slow poll while it's live.
  useEffect(() => { refreshContext(activeId); const t = setInterval(() => refreshContext(activeId), 15000); return () => clearInterval(t); }, [activeId, busy, refreshContext]);
  // Owner's rolling 5h usage for the sidebar chip (slow poll).
  useEffect(() => {
    const pull = () => api.usage().then((d) => setUsage5h(d?.available ? { output5h: d.output5h, url: d.url } : null)).catch(() => {});
    pull(); const t = setInterval(pull, 120000); return () => clearInterval(t);
  }, []);
  // Live conversation statuses (thinking / waiting) for the list indicators + queued-message set.
  useEffect(() => {
    const pull = () => { if (navigator.onLine) api.statuses().then((d) => setStatuses(d?.statuses || {})).catch(() => {}); void refreshQueue(); };
    pull(); const t = setInterval(pull, 4000); return () => clearInterval(t);
  }, [refreshQueue]);
  // Mark the open conversation read on open and whenever its turn finishes (busy flips off).
  useEffect(() => { if (activeId && !busy) markRead(activeId); }, [activeId, busy, markRead]);
  useEffect(() => { itemsRef.current = items; }, [items]); // for the context estimate
  useEffect(() => { compactingRef.current = compacting; }, [compacting]);
  const flushCompactRef = useRef<() => void>(() => {}); // assigned after openStream is defined

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

  const closeStream = () => { esRef.current?.close(); esRef.current = null; esOpen.current = false; };

  const handleEvent = useCallback((e: AppEvent) => {
    lastEventAt.current = Date.now(); // stream is alive
    for (const fn of voiceSinks.current) { try { fn(e); } catch {} } // feed voice mode (streaming text, result, error)
    if (e.t === "init") { setActiveId(e.sessionId); activeIdRef.current = e.sessionId; history.replaceState(null, "", `/app?c=${e.sessionId}`); setTimeout(refreshConvs, 400); return; }
    // user echo: drop it if we already rendered this turn optimistically (match by value, any
    // position), and guard against a stream reopen replaying a turn already at the tail.
    if (e.t === "user") {
      const idx = pendingUser.current.indexOf(e.text);
      if (idx !== -1) { pendingUser.current.splice(idx, 1); return; }
      setItems((it) => { const last = it[it.length - 1]; return last && last.kind === "user" && last.text === e.text ? it : applyEvent(it, e); });
      return;
    }
    if (e.t === "busy") { setBusy(e.busy); return; }
    if (e.t === "compact") {
      // Compaction finished. Capture the before-context (state hasn't refreshed yet) + elapsed, add the
      // compact divider, release any queued messages, then fetch the after-context and stamp the divider
      // with a persistent "freed Nk tokens" record.
      setCompacting(false); compactingRef.current = false;
      const before = contextRef.current;
      const durMs = compactStartRef.current ? Date.now() - compactStartRef.current : 0;
      compactStartRef.current = 0;
      setItems((it) => applyEvent(it, e));
      flushCompactRef.current();
      const id = activeIdRef.current;
      if (id && !id.startsWith("pending-")) {
        api.context(id).then((d) => {
          if (!d?.available) return;
          try { localStorage.setItem("ct-app-ctxmax", String(d.max)); } catch { /* */ }
          setContext({ percentage: d.percentage, total: d.total, max: d.max, estimated: false });
          const saved = before && before.total > d.total ? before.total - d.total : 0;
          if (!saved && !durMs) return;
          setItems((it) => {
            const c = it.slice();
            for (let k = c.length - 1; k >= 0; k--) if (c[k].kind === "compact") { c[k] = { kind: "compact", savedTokens: saved, durationMs: durMs, pctBefore: before?.percentage, pctAfter: d.percentage }; break; }
            return c;
          });
        }).catch(() => { refreshContext(id); });
      } else refreshContext(id);
      return;
    } // compaction finished -> send anything held
    if (e.t === "result") { setBusy(false); setItems((it) => applyEvent(it, e)); setTimeout(refreshConvs, 500); return; } // applyEvent stamps the turn's real token usage
    if (e.t === "error") { setBusy(false); setItems((it) => [...it, { kind: "assistant", text: "\n\n_error: " + e.message + "_" }]); return; }
    if (e.t === "closed") { return; }
    setItems((it) => applyEvent(it, e));
  }, [refreshConvs, refreshContext]);

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

  // Flush messages held during compaction (assigned here so it can use openStream). Called via a ref
  // from doCompact/handleEvent to sidestep declaration order.
  flushCompactRef.current = () => {
    const q = compactQueue.current; compactQueue.current = [];
    if (!q.length) return;
    void (async () => {
      for (const text of q) {
        const body = { text, resume: activeIdRef.current || undefined, model: modelRef.current || undefined, cwd: cwdRef.current || undefined };
        try {
          if (esOpen.current && activeIdRef.current) await api.send({ id: activeIdRef.current, text });
          else { const r = await api.start(body); if (r?.id) { setActiveId(r.id); activeIdRef.current = r.id; openStream(r.id); } }
        } catch { await offline.enqueueSend(body); void refreshQueue(); }
      }
    })();
  };

  // Render one conversation payload (from network or cache) into the view.
  const applyConv = useCallback((id: string, d: any, highlight?: string) => {
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
    if (highlight) highlightRef.current = highlight; else forceBottom.current = true;
    setItems(built); setBusy(!!d.busy); cwdRef.current = d.cwd || defaultCwd;
    if (d.live) openStream(id, true); // reconnect to a live conversation (streams follow-up + ask answers)
  }, [defaultCwd, openStream]);

  const loadConv = useCallback(async (id: string, highlight?: string) => {
    closeStream();
    stopReadAloud(); setSpeaking(false); // don't keep reading a message from the conversation you just left
    setDrawer(false); setBusy(false);
    // Switch INSTANTLY: set active + paint the cached copy right away, then refresh from the network
    // in the background and show a loader until it lands. On a weak link this avoids the long block
    // that made switching feel frozen.
    setActiveId(id); activeIdRef.current = id;
    history.replaceState(null, "", `/app?c=${id}`);
    const cached = await offline.getCachedConversation(id).catch(() => null);
    if (cached) applyConv(id, cached, highlight);
    else setItems([]);
    if (!navigator.onLine) { if (!cached) setItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]); return; }
    setLoadingConv(true);
    try {
      const d = await api.conversation(id);
      offline.cacheConversation(id, d);
      if (activeIdRef.current === id) applyConv(id, d, highlight); // ignore if the user already switched away
    } catch {
      if (!cached && activeIdRef.current === id) setItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]);
    } finally { if (activeIdRef.current === id) setLoadingConv(false); }
  }, [applyConv]);

  const newChat = () => { closeStream(); setItems([]); setActiveId(null); setBusy(false); setAttachments([]); cwdRef.current = defaultCwd; history.replaceState(null, "", "/app"); setDrawer(false); taRef.current?.focus(); };
  newChatRef.current = newChat;
  // View a queued (offline) new chat immediately — show its message + a note, without waiting for it
  // to drain into a real conversation.
  const viewPending = useCallback((c: Conv) => {
    closeStream();
    setActiveId(c.sessionId); activeIdRef.current = c.sessionId;
    setItems([{ kind: "user", text: c.queuedText || c.title }, { kind: "notice", noticeKind: "info", text: "Queued — this sends and starts the conversation as soon as you're back online." }]);
    setBusy(false); setDrawer(false); history.replaceState(null, "", "/app");
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
    if (lastId && (lastId === activeIdRef.current || activeIdRef.current === null)) { setActiveId(lastId); activeIdRef.current = lastId; openStream(lastId); }
  }, [openStream, refreshConvs, refreshQueue]);

  const drainingRef = useRef(false);
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
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
      // Missed the ending (server done but we still show busy) -> resync fast. Otherwise only after a
      // longer silence, so a genuinely long, quiet tool run isn't interrupted.
      if ((serverDone && quietFor > 8000) || quietFor > 30000) { lastEventAt.current = Date.now(); void loadConv(id); }
    }, 5000);
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
  const submitText = useCallback(async (text: string): Promise<string | null> => {
    if (!text.trim()) return null;
    setBusy(true);
    stickBottom.current = true; setAtBottom(true); // sending re-anchors to the bottom so you see your turn + the reply
    pendingUser.current.push(text);
    setItems((it) => applyEvent(it, { t: "user", text }));
    const body = { text, resume: activeIdRef.current || undefined, model: modelRef.current || undefined, cwd: cwdRef.current || undefined };
    const isNewChat = !activeIdRef.current;
    const queue = async () => {
      await offline.enqueueSend(body); offline.requestBackgroundSync(); offline.queueCount().then(setQueued);
      // A chat STARTED offline has no server id yet, so it wouldn't show anywhere. Drop a local
      // placeholder into the sidebar, flagged pending, so it's visible + clearly "waiting to send".
      // refreshConvs() on reconnect (after the queue drains) replaces it with the real conversation.
      if (isNewChat) {
        const firstLine = text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
        const pid = "pending-" + Date.now();
        setConvs((cs) => [{ sessionId: pid, title: firstLine, cwd: cwdRef.current || null, mtime: Date.now(), pending: true, queuedText: text }, ...cs]);
      }
      setBusy(false);
    };
    if (typeof navigator !== "undefined" && !navigator.onLine) { await queue(); return null; } // offline: hold it, send on reconnect
    // During compaction, hold the message (already rendered optimistically) and send it once the
    // compaction finishes, so it isn't lost or racing the /compact turn.
    if (compactingRef.current && activeIdRef.current) { compactQueue.current.push(text); return activeIdRef.current; }
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

  // #region context menus (long-press / right-click): message copy+edit, conversation rename+delete
  const onMsgMenu = useCallback((x: number, y: number, text: string, kind: "user" | "assistant") => setMsgMenu({ x, y, text, kind }), []);
  const copyText = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* */ } };
  const editIntoComposer = (t: string) => { setInput(t); setMsgMenu(null); requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; ta.setSelectionRange(t.length, t.length); } }); };
  const deleteConv = useCallback(async (id: string) => {
    setConvMenu(null);
    setConvs((cs) => cs.filter((c) => c.sessionId !== id)); // optimistic
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
  const favConvs = useMemo(() => convs.filter((c) => favorites.has(c.sessionId)), [convs, favorites]);
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
          {usage5h && (
            <a className="usage-chip" href={usage5h.url} target="_blank" rel="noreferrer" title="Output tokens in the last 5 hours — open the usage dashboard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>
              <span>{fmtTokens(usage5h.output5h)} · 5h</span>
            </a>
          )}
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
              {busy && <span className="working-pill" title="Claude is working"><span className="wp-dot" />Working</span>}
              {activeId && (
                <button className="rename-btn" onClick={startRename} title="Rename conversation" aria-label="Rename">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
              )}
            </div>
          )}
        </div>
        {loadingConv && <div className="load-bar" aria-label="Loading conversation" />}

        {(!online || queued > 0) && (
          <div className={"net-banner" + (online ? " sending" : "")}>
            {!online
              ? (queued > 0 ? `Offline — ${queued} message${queued > 1 ? "s" : ""} queued, will send when you reconnect` : "You're offline — cached conversations available")
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
                for (let i = 0; i < items.length; i++) {
                  if (items[i].kind === "tool") {
                    let j = i; const run: Extract<Item, { kind: "tool" }>[] = [];
                    while (j < items.length && items[j].kind === "tool") { run.push(items[j] as Extract<Item, { kind: "tool" }>); j++; }
                    if (run.length >= 2) { // collapse a run of tools into one accordion
                      nodes.push(<ToolGroup key={"tg" + i} tools={run} live={busy && j === items.length} />);
                      i = j - 1; continue;
                    }
                  }
                  nodes.push(<MessageBlock key={i} items={items} i={i} onAnswer={answerAsk} convId={activeId} onMenu={onMsgMenu} />);
                }
                return nodes;
              })()}
              {compacting && <CompactionBanner start={compactStartRef.current} />}
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
            {activeId && context && <ContextRing pct={context.percentage} total={context.total} max={context.max} onCompact={doCompact} busy={compacting} estimated={context.estimated} />}
          </div>
        </div>
      </main>
      {msgMenu && (
        <>
          <div className="ctx-scrim" onClick={() => setMsgMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMsgMenu(null); }} />
          <div className="ctx-menu" style={{ top: Math.min(msgMenu.y, window.innerHeight - 160), left: Math.min(msgMenu.x, window.innerWidth - 180) }}>
            {speaking ? (
              <button onClick={() => { stopReadAloud(); setMsgMenu(null); }}>Stop reading</button>
            ) : (
              <button onClick={() => { const t = msgMenu.text; setMsgMenu(null); setSpeaking(true); readAloud(t, { useServerTts: voiceAvail && online, onEnd: () => setSpeaking(false) }); }}>Read aloud</button>
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
      <VoiceMode bridge={voiceBridge} open={voiceOpen} onClose={() => setVoiceOpen(false)} pendingAsk={pendingAsk} onAnswer={answerAsk} speakFinalOnly={speakFinalOnly} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
