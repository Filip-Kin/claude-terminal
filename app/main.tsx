// Chat-app front-end. A Claude-app-style UI that drives Claude Code through the
// headless Agent SDK via the /app* routes in app-server.ts. The terminal stays one
// click away (the "Terminal" link -> "/").
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { VoiceMode, type VoiceBridge, readAloud, stopReadAloud } from "./voice";
import { useDictation } from "./dictation";
import { AskCard } from "./askcard";
import * as offline from "./offline";
import { AssistantContent, ArtifactViewer, type Artifact } from "./artifacts";
import { isAgentTool, AgentToolCard, SpawnedWork, registerTranscriptRenderer } from "./agents";
import { isTodoTool, latestTodos, TodoChecklist } from "./todos";
import { ConnectionsModal } from "./connections";

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
type Model = { id: string; label: string; description?: string };
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
  | { kind: "user"; text: string; queued?: boolean }
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
// Every READ goes through withTimeout. A weak link that HANGS rather than fails never settles a bare
// fetch, so loadConv's await would sit inside setLoadingConv(true) forever and the app looked like it
// was "waiting for the connection" with no way out. Failing fast lets us fall back to the cached view.
// #region Web Push enable/disable (the /app Settings row)
// The terminal overlay has had this for a while, but only there: on mobile its bell is hidden and the
// control lives in the terminal's hamburger drawer. Since the background cache and the status stream
// are /app features, the switch that turns them on belongs in /app too.
const pushSupported = (): boolean =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOSDevice = (): boolean => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Backed by an explicit ArrayBuffer (not the default ArrayBufferLike), because applicationServerKey
// requires a BufferSource over a real ArrayBuffer.
function b64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// cadence marks a device that can take the coalesced 15s status pushes. Android updates a same-tag
// notification silently; iOS would alert on every one, so it never gets the stream.
const cadenceCapable = (): boolean => /Android/i.test(navigator.userAgent);

// navigator.serviceWorker.ready NEVER settles if no worker ever activates (a failed registration, or
// the script 404ing). Awaiting it bare would leave the settings toggle stuck mid-flight with no
// feedback, so it is bounded like every other await in this file.
// Hand the SW the conversations that are now read. Fire-and-forget: bounded via swReady (a bare
// navigator.serviceWorker.ready never settles when no worker activates) and harmless if there is none.
async function notifySwRead(ids: string[]): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const reg = await swReady(2000);
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "ct-read", ids });
  } catch { /* no SW here, or it never activated */ }
}
function swReady(ms = 5000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no active service worker")), ms)),
  ]);
}
async function getPushSub(): Promise<PushSubscription | null> {
  try { const reg = await swReady(); return await reg.pushManager.getSubscription(); } catch { return null; }
}
async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: isIOSDevice() ? "On iOS, install to the Home Screen first" : "Not supported in this browser" };
  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: "Blocked in browser settings" };
  try {
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await withTimeout(fetch("/_ct/vapidPublicKey", { credentials: "same-origin" }).then((r) => r.json()));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
    }
    await withTimeout(fetch("/_ct/subscribe", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(sub.toJSON() as Record<string, unknown>), cadence: cadenceCapable(), ua: navigator.userAgent }),
    }));
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e) }; }
}
async function disablePush(): Promise<void> {
  const sub = await getPushSub();
  if (!sub) return;
  await fetch("/_ct/unsubscribe", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  try { await sub.unsubscribe(); } catch { /* already gone */ }
}
// #endregion

const api = {
  models: () => withTimeout(fetch("/app/api/models").then(J)),
  convs: (offset = 0) => withTimeout(fetch(`/app/api/conversations?offset=${offset}`).then(J)),
  // `since` = the caller's transcript-event cursor; the server replies delta:true with only the events
  // after it. Reopening a long chat costs a few KB instead of the whole transcript.
  // Cursor only, no events. Used to make a live-streamed conversation warmable again without paying
  // for the whole transcript.
  convMeta: (id: string) => withTimeout(fetch(`/app/api/conversation/${encodeURIComponent(id)}?meta=1`).then(J)),
  conversation: (id: string, since?: number) =>
    withTimeout(fetch(`/app/api/conversation/${encodeURIComponent(id)}${since && since > 0 ? `?since=${since}` : ""}`).then(J)),
  start: (b: { text: string; resume?: string; model?: string; cwd?: string; cid?: string; voice?: boolean }) =>
    fetch("/app/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  send: (b: { id: string; text: string; cid?: string }) =>
    fetch("/app/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  edit: (b: { id: string; index: number; text: string; cid?: string; orig?: string; model?: string }) =>
    fetch("/app/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  setModel: (b: { id: string; model: string }) =>
    fetch("/app/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(J),
  interrupt: (id: string) => fetch("/app/api/interrupt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }),
  upload: (id: string | null, file: File) => {
    const fd = new FormData(); fd.append("file", file); if (id) fd.append("id", id);
    return fetch("/app/api/upload", { method: "POST", body: fd }).then(J);
  },
  favorites: () => withTimeout(fetch("/app/api/favorites").then(J)),
  toggleFav: (id: string, fav: boolean) =>
    fetch("/app/api/favorites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, fav }) }).then(J),
  setTitle: (id: string, title: string) =>
    fetch("/app/api/title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title }) }).then(J),
  del: (id: string) => fetch("/app/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then(J),
  context: (id: string) => withTimeout(fetch(`/app/api/context?id=${encodeURIComponent(id)}`).then(J)),
  compact: (id: string) => fetch("/app/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then(J),
  usage: () => withTimeout(fetch("/app/api/usage").then(J)),
  statuses: () => withTimeout(fetch("/app/api/statuses").then(J)),
  search: (q: string) => withTimeout(fetch(`/app/api/search?q=${encodeURIComponent(q)}`).then(J)),
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
    .replace(/\s*<(voice-mode|turn-context)>[\s\S]*?<\/\1>\s*/g, "")
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

// A message sent while a turn is still streaming is QUEUED behind it: the agent cannot see it until
// the current turn ends. It is appended straight away (so you can see it went in) but tagged, and
// everything the live turn produces after that is inserted ABOVE it. Without that, the next
// text_delta finds a user item as the last item, opens a SECOND assistant bubble, and the reply is
// chopped in half at whatever word had arrived. The tag is dropped when the turn ends (`result`),
// after which every item is a plain user turn again and nothing downstream can tell the difference.
const isQueuedUser = (it: Item | undefined): boolean => !!it && it.kind === "user" && !!it.queued;
// Where the LIVE turn ends: the end of the list, minus any messages queued behind it. Equal to
// items.length whenever nothing is queued, which is the overwhelmingly common case.
function liveEnd(items: Item[]): number { let n = items.length; while (n > 0 && isQueuedUser(items[n - 1])) n--; return n; }
// Append at the live end. Identical to [...items, it] when nothing is queued.
function addItem(items: Item[], it: Item): Item[] {
  const n = liveEnd(items);
  return n === items.length ? [...items, it] : [...items.slice(0, n), it, ...items.slice(n)];
}
// The turn is over, so whatever was queued behind it is now the current turn: drop the tags, or the
// next reply's text_delta would skip back over them and grow the PREVIOUS turn's bubble.
function unqueue(items: Item[]): Item[] {
  if (!items.some((it) => it.kind === "user" && it.queued)) return items; // keep the same reference
  return items.map((it) => (it.kind === "user" && it.queued ? { kind: "user", text: it.text } as Item : it));
}

// A background task reporting in, or a message relayed from another session, is ASYNCHRONOUS: it
// arrives when it happens, not at a content-block boundary, so it is not evidence that the model
// finished what it was writing. Every other event in the stream is in-band and does end a block.
const isAsyncNotice = (it: Item | undefined): boolean => !!it && it.kind === "notice" && (it.noticeKind === "task" || it.noticeKind === "peer");
// Index of the block a delta continues: the last item that is not an async notice. Without the skip
// a task card landing mid-sentence became the last item, the next text_delta found no assistant
// bubble to grow, and the paragraph was cut at whatever character had arrived: "...whether those f"
// / task card / "ixes are actually systematic."
function openBlockIdx(items: Item[], end: number): number {
  let i = end - 1;
  while (i >= 0 && isAsyncNotice(items[i])) i--;
  return i;
}

// `queued` = this event arrived while a turn was already streaming (see isQueuedUser). Only the two
// call sites that know the conversation is mid-turn pass it; every replay/fold path leaves it false
// and therefore behaves exactly as it did before.
function applyEvent(items: Item[], e: AppEvent, queued = false): Item[] {
  const end = liveEnd(items); // = items.length unless a message is queued behind the live turn
  const open = openBlockIdx(items, end); // = end - 1 unless an async notice landed mid-block
  // Freeze a live "thinking" block's duration the instant the first non-thinking event lands, so
  // "Thought for Ns" is fixed once the model stops reasoning (and survives reconnects in state).
  // An async notice is not such an event: the model is still thinking, a task just reported in.
  const asyncNoticeEvent = e.t === "notice" && (e.kind === "task" || e.kind === "peer");
  if (e.t !== "thinking" && e.t !== "thinking_delta" && e.t !== "thinking_progress" && !asyncNoticeEvent) {
    const l = items[open];
    if (l && l.kind === "thinking" && l.started && l.elapsed == null) {
      items = items.slice(); items[open] = { ...l, elapsed: Date.now() - l.started };
    }
  }
  const last = items[open];
  switch (e.t) {
    case "user": {
      // A loaded skill arrives as a user message that dumps the whole skill file ("Base directory
      // for this skill: <path>/<name>"). Render a compact card instead. (Also done server-side; this
      // covers transcripts replayed before that backend build ships, so no restart is needed.)
      const sk = skillLoadName(e.text);
      if (sk) return addItem(items, { kind: "notice", noticeKind: "skill", text: sk });
      // Queued turns stack at the very end, in send order. A turn that is NOT queued starts a new
      // turn, so any leftover tag is stale by definition.
      if (queued) return [...items, { kind: "user", text: sanitizeUserText(e.text), queued: true }];
      return [...unqueue(items), { kind: "user", text: sanitizeUserText(e.text) }];
    }
    case "text":
    case "text_delta":
      // Still mid-paragraph: grow the block and leave anything queued pinned below it. Splitting a
      // sentence to slot a message in is the thing we are avoiding.
      if (last && last.kind === "assistant") { const c = items.slice(); c[open] = { ...last, text: last.text + e.text }; return c; }
      // A NEW text block is the clean seam: the previous paragraph is finished and any tool cards are
      // already rendered, so release whatever was queued and let this paragraph land AFTER it. The
      // message ends up between the tool uses and the next part of the reply, instead of staying
      // pinned at the very bottom while the response grew above it.
      return [...unqueue(items), { kind: "assistant", text: e.text }];
    case "thinking_delta":
      if (last && last.kind === "thinking") { const c = items.slice(); c[open] = { ...last, text: last.text + e.text }; return c; }
      return [...unqueue(items), { kind: "thinking", text: e.text, started: Date.now() }];
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
        c[open] = { ...last, _base: nextBase, _peak: nextPeak, tokens: nextBase + nextPeak };
        return c;
      }
      return [...unqueue(items), { kind: "thinking", text: "", tokens: v, _base: 0, _peak: v, started: Date.now() }];
    }
    case "thinking": return [...unqueue(items), { kind: "thinking", text: e.text }];
    // A new tool call is the same clean seam as a new paragraph: whatever the agent was part way
    // through is finished, and the SDK hands a mid-turn message to the agent at a tool boundary, so
    // by the time the NEXT call is issued it has already read it. Release the queue first, or the
    // card for the work the message asked for renders ABOVE the message that asked for it.
    case "tool_use": return [...unqueue(items), { kind: "tool", id: e.id, name: e.name, input: e.input }];
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
      return addItem(items, { kind: "compact", savedTokens: saved || undefined, durationMs: e.durationMs, pctBefore, pctAfter });
    }
    case "notice": return addItem(items, { kind: "notice", noticeKind: e.kind, text: e.text, from: e.from, status: e.status });
    case "result": {
      // The turn is over: release anything queued behind it (see unqueue) BEFORE stamping usage.
      const rel = unqueue(items);
      // Stamp the turn's real token usage onto the most recent assistant block so the summary can
      // show it (output = tokens Claude actually generated, incl. thinking + tool-call args).
      if (!e.usage) return rel;
      for (let i = rel.length - 1; i >= 0; i--) { if (rel[i].kind === "assistant") { const c = rel.slice(); c[i] = { ...(c[i] as Extract<Item, { kind: "assistant" }>), usage: e.usage }; return c; } }
      return rel;
    }
    case "ask": {
      if (items.some((it) => it.kind === "ask" && it.askId === e.askId)) return items; // de-dupe (transcript + live)
      return addItem(items, { kind: "ask", askId: e.askId, question: e.question, options: e.options, multiSelect: e.multiSelect, allowText: e.allowText });
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

// How long an unacknowledged optimistic user turn keeps the conversation "busy" once the SERVER has
// reported idle. Past this it's an orphan (dead turn, or a backend restart) and is dropped.
const ECHO_TTL = 30_000;

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
  evCount = 0;          // transcript events these items were reduced from, ie the delta cursor
  // Live SSE events grow `items` but are NOT transcript events, so they do not advance evCount. Once
  // that has happened the cursor no longer describes what we hold, and asking for events after it would
  // re-deliver everything the stream already rendered (duplicate bubbles). evDirty marks the cursor
  // untrustworthy; it is cleared only by a full reconcile or a clean delta fold.
  evDirty = false;
  touched = Date.now(); // LRU key for evicting idle in-memory stores
  es: EventSource | null = null;
  // Optimistic user turns awaiting their SSE echo. Timestamped, because an echo that never arrives
  // (the turn died, or the backend restarted mid-turn) otherwise pins busy=true through every
  // reconcile below: stuck Stop button, and markRead is gated on !busy so the unread dot sticks too.
  private pendingEcho: { text: string; at: number }[] = [];
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
    this.signal(); // connected flips -> re-render (the Stop button depends on it)
  }
  disconnect() {
    if (!this.es) return;
    try { this.es.onmessage = null; this.es.onerror = null; this.es.close(); } catch { /* */ }
    this.es = null;
    this.signal(); // connected flips -> re-render so a stale Stop button clears
  }
  get connected() { return !!this.es; }

  // ---- event reduction (the single applyEvent per conversation) ----
  ingest(e: AppEvent) {
    if (typeof e._seq === "number") { if (e._seq <= this.seq) return; this.seq = e._seq; }
    this.evDirty = true; // a live event: the transcript cursor no longer matches what we hold
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
        const i = this.pendingEcho.findIndex((p) => p.text === clean);
        if (i !== -1) { this.pendingEcho.splice(i, 1); if (this.sendState === "sending") this.setSendState("delivered"); return; } // our own optimistic turn echoed back = server has it
        const last = this.items[this.items.length - 1];
        if (last && last.kind === "user" && sanitizeUserText(last.text) === clean) return;
        // Someone else's turn (another device, the terminal, a peer agent) landing mid-stream is
        // queued behind the running one exactly like ours, so tag it the same way.
        this.items = applyEvent(this.items, e, this.busy); this.touch(); return;
      }
      case "result":
        this.busy = false; this.items = applyEvent(this.items, e); this.touch();
        this.mgr.hooks?.onResult(this); this.mgr.hooks?.onContext(this); return;
      case "error":
        this.busy = false; this.items = unqueue(addItem(this.items, { kind: "assistant", text: "\n\n_error: " + e.message + "_" })); this.touch(); return;
      case "closed": this.disconnect(); return;
      default: this.items = applyEvent(this.items, e); this.touch(); return;
    }
  }

  // ---- mutations from the UI ----
  // `queued` defaults to "a turn is already running", which is the whole point: the bubble is added
  // now (so the send is visibly acknowledged) but pinned BELOW the reply that is still streaming
  // instead of splitting it. doEdit passes false, because a rewind cancels the running turn and its rerun
  // must appear under the edited bubble, not above it.
  addOptimisticUser(text: string, queued = this.busy) { this.pendingEcho.push({ text, at: Date.now() }); this.items = applyEvent(this.items, { t: "user", text }, queued); this.busy = true; this.setSendState("sending"); this.touch(); }
  // Edit-and-rerun: drop the edited user bubble + everything after it (the forked turn streams in
  // below), and restore the pre-edit view if the server rejects the edit.
  truncateFrom(index: number) { this.items = this.items.slice(0, Math.max(0, index)); this.pendingEcho = []; this.touch(); }
  restore(items: Item[]) { this.items = items; this.pendingEcho = []; this.busy = false; this.setSendState(null); this.touch(); }
  // Delivery ticks for the most-recent sent turn (Google Messages: 1 tick sending -> 2 ticks delivered
  // -> 2 filled ticks when the agent reads/starts). Persists on the turn (no fade); a new send resets it.
  setSendState(s: ConvStore["sendState"]) { this.sendState = s; this.signal(); }
  answerAsk(askId: string, answer: string) { this.items = this.items.map((it) => (it.kind === "ask" && it.askId === askId ? { ...it, answered: answer } : it)); this.touch(); }
  // Put an ask card back to unanswered: the optimistic mark is a lie if the answer never reached the
  // server, and a card that looks answered while the turn is still parked in the tool call is the
  // worst of both worlds (see deliverAsk).
  unanswerAsk(askId: string) { this.items = this.items.map((it) => (it.kind === "ask" && it.askId === askId ? { ...it, answered: undefined } : it)); this.touch(); }
  setBusy(b: boolean) { if (this.busy === b) return; this.busy = b; this.signal(); }
  beginCompact() { this.compacting = true; this.compactStart = Date.now(); this.signal(); }
  endCompactFallback() { if (this.compacting) { this.compacting = false; this.compactStart = 0; this.signal(); } }
  showItems(items: Item[]) { this.items = items; this.signal(); } // transient placeholder view (offline note / queued)
  // The server says idle but our local state still thinks a reply is outstanding, and resyncing has
  // already failed to clear it. Take the server's word rather than resyncing forever. Terminal state
  // of the stall watchdog, not a retry: it drops the orphaned echo and lets the Stop button clear.
  forceIdle() {
    const had = this.pendingEcho.length > 0 || this.busy;
    this.pendingEcho = []; this.busy = false;
    if (this.sendState === "sending" || this.sendState === "delivered") { this.sendState = "read"; this.signal(); return; }
    if (had) this.signal();
  }

  // ---- hydration + reconcile (the cache-vs-network policy) ----
  hydrate(items: Item[], meta: { busy?: boolean; cwd?: string | null; evCount?: number }) {
    this.items = items; this.cachedItems = items; this.hydrated = true;
    if (meta.busy != null) this.busy = meta.busy;
    if (meta.cwd != null) this.cwd = meta.cwd;
    if (meta.evCount != null) { this.evCount = meta.evCount; this.evDirty = meta.evCount <= 0; }
    this.signal();
  }
  // Fold a tail of raw transcript events onto what we already have. Used for the `?since=` catch-up and
  // for the events the service worker parked while the app was closed. Appending, never replacing, so
  // it needs none of reconcile's localAhead protection — but it must still swallow the echo of a turn
  // we rendered optimistically, or the bubble would appear twice.
  applyDelta(events: AppEvent[], evTotal: number, meta?: { busy?: boolean; cwd?: string | null }) {
    const cut = Date.now() - ECHO_TTL;
    this.pendingEcho = this.pendingEcho.filter((p) => p.at > cut);
    let items = this.items;
    for (const e of events) {
      if (e.t === "user") {
        const clean = sanitizeUserText(e.text);
        const i = this.pendingEcho.findIndex((p) => p.text === clean);
        if (i !== -1) { this.pendingEcho.splice(i, 1); continue; }
        const last = items[items.length - 1];
        if (last && last.kind === "user" && sanitizeUserText(last.text) === clean) continue;
      }
      items = applyEvent(items, e);
    }
    this.items = items;
    this.evCount = evTotal;
    this.evDirty = false; // items and cursor were advanced together, so it is trustworthy again
    this.hydrated = true;
    if (meta?.cwd !== undefined) this.cwd = meta.cwd;
    if (meta?.busy != null) this.busy = this.pendingEcho.length > 0 ? true : meta.busy;
    this.touch();
  }
  // Server transcript is truth for committed history. We keep our own tail when it's AHEAD of the
  // server (live tokens, or a just-sent turn not yet in the transcript) so nothing flickers away.
  reconcile(items: Item[], meta: { busy: boolean; cwd: string | null; evCount?: number }) {
    this.cwd = meta.cwd; this.hydrated = true;
    if (meta.evCount != null) { this.evCount = meta.evCount; this.evDirty = false; }
    // Expire orphaned optimistic echoes BEFORE computing localAhead below. The server emits the user
    // echo within a second of accepting a turn, so one this old is never arriving (dead turn, backend
    // restart). Left in place it pins localAhead true forever, and the client then discards the server
    // transcript on every reconcile: the reply is on disk and never rendered until the store is thrown
    // away. That is the "no response until the server rebooted" bug, and it also pinned busy=true,
    // which kept the Stop button up and blocked markRead. Not conditional on meta.busy: an orphan from
    // an earlier turn would otherwise keep discarding the transcript while a later turn runs.
    { const cut = Date.now() - ECHO_TTL; this.pendingEcho = this.pendingEcho.filter((p) => p.at > cut); }
    const localAhead = this.pendingEcho.length > 0 || (this.busy && this.items.length >= items.length);
    if (!localAhead) {
      // Carry over any turn of ours the transcript hasn't got yet (see trailingUnsent) instead of
      // replacing it away. Empty in the normal case, so this is the same wholesale replace it was.
      const unsent = this.trailingUnsent(items);
      const merged = unsent.length ? [...items, ...unsent] : items;
      this.items = merged; this.cachedItems = merged;
    }
    // Trust the server's busy on a fresh reconcile so a stale cached busy clears (otherwise a finished
    // turn keeps the Stop button up). Stay busy only while we hold an unacknowledged optimistic send.
    this.busy = this.pendingEcho.length > 0 ? true : meta.busy;
    this.signal();
  }

  // Turns at the END of our list that the server transcript doesn't have. A message sent while a turn
  // is already streaming sits in the runner's input queue, and only reaches the transcript when the
  // SDK actually starts it — which can be minutes later. In that window the transcript is genuinely
  // missing a turn we know about, so a full replace deletes the bubble while the agent is about to
  // answer it: the message vanishes and the reply appears with nothing above it. Text comparison uses
  // sanitizeUserText, so voice decoration and image tags don't cause a false miss (= a duplicate).
  private trailingUnsent(server: Item[]): Item[] {
    const seen = new Set<string>();
    for (const it of server) if (it.kind === "user") seen.add(sanitizeUserText(it.text));
    const out: Item[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind !== "user") break;                    // only a contiguous tail of user turns
      if (seen.has(sanitizeUserText(it.text))) break;   // committed, and so is everything before it
      out.unshift(it);
    }
    return out;
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
    // 0 means "no trustworthy cursor": the next reader (this app, the prewarm, or the service worker)
    // does one full fetch and re-establishes it, rather than folding a delta onto items that already
    // contain it.
    void offline.saveConvItems(this.id, its, i, { busy: this.busy, cwd: this.cwd, live: this.busy, evCount: this.evDirty ? 0 : this.evCount });
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
  // The local store holding a chat that was STARTED offline. It has no server id yet (new-/pending-),
  // so a drained queue item can only be matched back to it by the text of the turn it is waiting on.
  findQueuedNewChat(text: string): ConvStore | undefined {
    const clean = sanitizeUserText(text);
    for (const s of this.stores.values()) {
      if (!s.id.startsWith("new-") && !s.id.startsWith("pending-")) continue;
      if (s.sendState !== "queued") continue;
      if (s.items.some((it) => it.kind === "user" && sanitizeUserText(it.text) === clean)) return s;
    }
    return undefined;
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
      <div className="compact-row">Compacting conversation to free context… <span className="compact-secs">{secs}s</span></div>
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

function MessageBlockInner({ items, i, onAnswer, convId, onMenu, onOpenArtifact, sendStatus, reading }: { items: Item[]; i: number; onAnswer: (askId: string, answer: string) => void; convId: string | null; onMenu?: (x: number, y: number, text: string, kind: "user" | "assistant", i: number) => void; onOpenArtifact?: (a: Artifact) => void; sendStatus?: ConvStore["sendState"]; reading?: "generating" | "playing" }) {
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
        <div className={"bubble-user" + (it.queued ? " queued" : "")} {...menuBind(body || it.text, "user")}>
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
  if (it.kind === "tool") return isAgentTool(it.name, it.input) ? <div data-agent-id={it.id}><AgentToolCard it={it} /></div> : <ToolCard it={it} />;
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
  // A message QUEUED behind this turn sits below the live reply, so it does not end it. Without that
  // guard, the turn summary would pop in mid-stream the moment you typed a follow-up.
  const turnFinal = isQueuedUser(next) ? false : (!next || next.kind === "user" || next.kind === "compact");
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

// A long conversation is thousands of blocks. Without this, ANY App re-render (every keystroke in
// the composer, every streamed token) reconciles all of them — that was the "typing appears a word
// at a time" lag. A block only depends on its own item plus its immediate neighbours (role label,
// turn-final footer), so compare exactly those: during streaming only the tail item changes
// identity, so only the tail re-renders.
const MessageBlock = React.memo(MessageBlockInner, (a, b) => {
  if (a.i !== b.i || a.convId !== b.convId || a.sendStatus !== b.sendStatus || a.reading !== b.reading) return false;
  if (a.onAnswer !== b.onAnswer || a.onMenu !== b.onMenu || a.onOpenArtifact !== b.onOpenArtifact) return false;
  if (a.items === b.items) return true;
  // isLast (ThinkingCard) and turnFinal both read off the end of the list.
  if (a.items.length !== b.items.length) return false;
  const i = a.i;
  return a.items[i] === b.items[i] && a.items[i - 1] === b.items[i - 1] && a.items[i + 1] === b.items[i + 1];
});
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

// How many trailing blocks the thread mounts at first, and how many more each scroll-up adds.
const VIS_STEP = 60;

// The spawned-work viewer renders a subagent's transcript with the same applyEvent fold and
// MessageBlock the main thread uses. Registered rather than imported because both live in this file;
// a second copy of applyEvent would drift the moment either changed.
registerTranscriptRenderer({
  fold: (events) => (events as AppEvent[]).reduce((a, e) => applyEvent(a, e), [] as Item[]),
  Block: ({ items, i, convId }) => <MessageBlock items={items as Item[]} i={i} convId={convId} onAnswer={() => {}} />,
});

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
  const [connOpen, setConnOpen] = useState(false); // Connections: MCP servers, skills, memory, network
  // null = still checking, so the row shows a neutral state instead of flashing "off" then "on".
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
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
  // Editing a past user turn: its item index + original text. Set by the message "Edit" action;
  // on submit the turn is rewound-and-rerun (full rollback) instead of appended as a new turn.
  const [editing, setEditing] = useState<{ i: number; orig: string } | null>(null);
  // Why an in-flight edit could not be applied. An edit is a server-side rewind, so when it fails the
  // turn must stay in edit mode with the reason shown, never silently fall through to a normal send.
  const [editError, setEditError] = useState<string | null>(null);
  const [convMenu, setConvMenu] = useState<{ x: number; y: number; id: string; title: string; fav: boolean } | null>(null);
  const [speakFinalOnly, setSpeakFinalOnly] = useState(() => { try { return localStorage.getItem("ct-voice-final-only") === "1"; } catch { return false; } });
  const setSpeakFinal = (v: boolean) => { setSpeakFinalOnly(v); try { localStorage.setItem("ct-voice-final-only", v ? "1" : "0"); } catch { /* */ } };
  const [tapToTalk, setTapToTalkState] = useState(() => { try { return localStorage.getItem("ct-voice-ptt") === "1"; } catch { return false; } });
  const setTapToTalk = (v: boolean) => { setTapToTalkState(v); try { localStorage.setItem("ct-voice-ptt", v ? "1" : "0"); } catch { /* */ } };
  const [voiceAvail, setVoiceAvail] = useState(false);
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]); // available Kokoro voices
  const [ttsVoice, setTtsVoiceState] = useState<string>(() => { try { return localStorage.getItem("ct-voice-name") || ""; } catch { return ""; } });
  const setTtsVoice = (v: string) => { setTtsVoiceState(v); try { localStorage.setItem("ct-voice-name", v); } catch { /* */ } };
  const [dictTidy, setDictTidyState] = useState(() => { try { return localStorage.getItem("ct-dictate-tidy") !== "0"; } catch { return true; } });
  const setDictTidy = (v: boolean) => { setDictTidyState(v); try { localStorage.setItem("ct-dictate-tidy", v ? "1" : "0"); } catch { /* */ } };
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
  // Stall-watchdog attempts for the active conversation, so a resync that can't clear the condition
  // gives up instead of reopening the stream on a loop. `settled` = we've already forced it idle.
  const resyncRef = useRef<{ id: string; n: number; settled: boolean }>({ id: "", n: 0, settled: false });
  const compactQueue = useRef<string[]>([]); // messages typed DURING compaction, sent once it finishes
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const newChatRef = useRef<(() => void) | null>(null); // lets earlier callbacks reset to a blank chat
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<string>("");
  const forceBottom = useRef(false); // scroll to the end after opening a conversation
  const stickBottom = useRef(true); // follow new content only while the user is parked at the bottom
  const [atBottom, setAtBottom] = useState(true); // drives the "jump to latest" button while streaming
  // Rendered-history window. A long conversation holds thousands of blocks; mounting them all is what
  // made opening and typing slow. Render the tail, then grow the window as the user scrolls up —
  // straight from the items already in memory, so it is instant (no fetch) while staying cheap.
  const [visible, setVisible] = useState(VIS_STEP);
  const growAnchor = useRef<{ height: number; top: number } | null>(null); // scroll anchor across a grow
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
          // Was: skip anything already cached. That froze the cache at first-write, so the most-used
          // conversations paint instantly with STALE content and you wait for the full refetch to see
          // what actually happened. Now a cached conversation is topped up by delta, which is cheap
          // enough to do for all of them on every pass.
          const cached = await offline.getConv(c.sessionId).catch(() => null);
          const d = await api.conversation(c.sessionId, cached?.evCount || 0);
          const events: AppEvent[] = d.events || [];
          if (d.delta === true && cached) {
            if (!events.length) continue; // already current
            const merged = events.reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), cached.items as Item[]);
            // applyEvent can grow the LAST existing bubble (a text_delta), so rewrite from there.
            await offline.saveConvItems(c.sessionId, merged, Math.max(0, cached.items.length - 1), { busy: !!d.busy, cwd: d.cwd, live: !!d.live, evCount: d.evTotal });
          } else {
            const built = events.reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
            await offline.saveConvItems(c.sessionId, built, 0, { busy: !!d.busy, cwd: d.cwd, live: !!d.live, evCount: d.evTotal });
          }
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
    stickBottom.current = true; forceBottom.current = true; // pin to the bottom so the banner (then the card) is in view
    s.beginCompact(); // optimistic banner; the backend "compacting"/"compact" events keep it honest
    try { await api.compact(s.id); } catch { /* */ }
    // Safety net: if the compact events never arrive (e.g. dropped stream), clear the banner anyway.
    // A real compaction of a full context takes minutes, not seconds (measured: 122s on a 477k-token
    // conversation). At 45s this fired MID-compaction: the banner vanished, the ring refreshed against
    // pre-compaction numbers, and the messages held for the divider were released above it — which is
    // what made the "Compacted" card look like it only turned up after the next message.
    setTimeout(() => { s.endCompactFallback(); refreshContext(s.id); flushCompactRef.current(); }, 300000);
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
  // `list` lets a caller pass the CURRENT convs. Without it this read convsRef, which is synced by
  // an effect declared BELOW the read-marking effect — so on a convs update markRead ran first and
  // always saw the PREVIOUS list. After a turn finished, refreshConvs brought the new mtime, this
  // marked read against the old one, and the conversation you were sat in looked unread the moment
  // you navigated away, clearing only when you came back.
  const markRead = useCallback((id: string | null, list?: Conv[]) => {
    if (!id || id.startsWith("pending-")) return;
    const conv = (list ?? convsRef.current).find((c) => c.sessionId === id);
    const mark = conv ? Math.max(conv.mtime, lastReadRef.current[id] || 0) : (lastReadRef.current[id] || Date.now());
    lastReadRef.current[id] = mark; saveLastRead(lastReadRef.current); setReadTick((t) => t + 1);
    // Tell the service worker what is now read so it can dismiss any tray notification whose
    // conversations have all been read. A "conversation finished" notification otherwise sat there
    // until tapped, even though you had already opened and read it.
    const src = list ?? convsRef.current;
    const readIds = src.filter((c) => (lastReadRef.current[c.sessionId] || 0) >= c.mtime).map((c) => c.sessionId);
    if (readIds.length) void notifySwRead(readIds);
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
  // App-icon badge: how many agents are WAITING on you. Deliberately not "how many are busy" — the
  // badge answers "does anything need me", and a working agent does not. The service worker sets the
  // same badge from a status push while the app is closed, so the two agree.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (typeof nav.setAppBadge !== "function") return;
    const waiting = Object.values(statuses).filter((v) => v?.waiting).length;
    try { void (waiting > 0 ? nav.setAppBadge(waiting) : nav.clearAppBadge?.()); } catch { /* unsupported */ }
  }, [statuses]);

  // Tell the server this device can take the coalesced status pushes. Only Android updates a same-tag
  // notification silently; on iOS the 15s cadence would alert every cycle, so it stays off there. Re-sent
  // on every boot so a subscription made before this flag existed gets upgraded in place.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    void navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const body = { ...(sub.toJSON() as Record<string, unknown>), cadence: /Android/i.test(navigator.userAgent), ua: navigator.userAgent };
      await fetch("/_ct/subscribe", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }).catch(() => { /* not subscribed / offline */ });
  }, []);

  // Re-establish the delta cursor after a turn we watched live. Streaming leaves evDirty set, which
  // stops the service worker topping this conversation up while the app is closed — and "I watched it
  // start, then closed the app" is the exact case the background cache exists for. Costs one tiny
  // meta call, not a transcript. Settles first so the SDK has finished flushing the turn to the jsonl;
  // adopting a count mid-write could leave a duplicate bubble on the next fold.
  useEffect(() => {
    if (busy || !activeId) return;
    const s = activeStoreRef.current;
    if (!s || !s.evDirty || !s.hydrated || s.id.startsWith("pending-") || s.id.startsWith("new-")) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void api.convMeta(s.id).then((d: { evTotal?: number; busy?: boolean }) => {
        // Bail on anything that changed under us: a new turn started, the user switched away, or the
        // store picked up more live events while the request was in flight.
        if (cancelled || activeStoreRef.current !== s || s.busy || d.busy) return;
        if (!(Number(d.evTotal) > 0)) return;
        s.evCount = Number(d.evTotal);
        s.evDirty = false;
        s.flushCache(); // persist the recovered cursor so the SW can use it while we are closed
      }).catch(() => { /* offline: stays dirty and self-heals with a full fetch on next open */ });
    }, 3000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [busy, activeId]);

  // Reflect the real subscription state each time Settings opens: permission can be revoked in browser
  // settings, or the subscription dropped by the browser, with the app none the wiser.
  useEffect(() => {
    if (!settingsOpen) return;
    if (!pushSupported()) { setPushOn(false); return; }
    void getPushSub().then((sub) => setPushOn(Notification.permission === "granted" && !!sub));
  }, [settingsOpen]);

  const togglePush = useCallback(async () => {
    setPushBusy(true); setPushErr(null);
    try {
      if (pushOn) { await disablePush(); setPushOn(false); }
      else {
        const r = await enablePush();
        setPushOn(r.ok);
        if (!r.ok) setPushErr(r.error || "Could not enable");
      }
    } finally { setPushBusy(false); }
  }, [pushOn]);

  // Mark the open conversation read on open and whenever its turn finishes (busy flips off).
  // Re-mark on convs updates too: after a turn finishes, refreshConvs bumps the active conversation's
  // mtime a beat later — without this, switching away right then would show it falsely unread.
  useEffect(() => { if (activeId && !busy) markRead(activeId, convs); }, [activeId, busy, convs, markRead]);
  useEffect(() => { itemsRef.current = items; }, [items]); // for the context estimate
  // Persist the composer draft under the current conversation as it changes (so a switch or reload keeps
  // it). activeIdRef holds the live conversation id; a new chat saves under the "__new__" key.
  useEffect(() => { saveDraft(activeIdRef.current, input); }, [input]);
  // Switching conversation / starting a new chat swaps the composer text programmatically (loadDraft),
  // which doesn't fire the onInput auto-resize. Recompute the textarea height so it fits the new draft
  // and shrinks back down from a tall unsent message left in the previous chat.
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, [activeId]);
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
  // Root serves the app as of 2026-08-31, so the app makes the reopen-last-surface call the terminal
  // overlay used to make. Only a genuine cold PWA launch honours it: an in-app hop carries a referrer
  // and a manual reload reports type "reload", so neither bounces you away mid-use.
  useEffect(() => {
    try {
      const sp = new URLSearchParams(location.search);
      const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || (navigator as any).standalone === true;
      const navType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type || "";
      const cold = sp.get("home") === "1" || (standalone && !document.referrer && navType !== "reload");
      if (cold && localStorage.getItem("ct-last-surface") === "/terminal") { location.replace("/terminal"); return; }
      if (sp.get("home") === "1") history.replaceState(null, "", location.pathname);
      localStorage.setItem("ct-last-surface", "/app");
    } catch { /* */ }
  }, []);

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
      const q = highlightRef.current.toLowerCase();
      let found: Element | null = null;
      for (const n of Array.from(el.querySelectorAll(".thread > *"))) { if ((n.textContent || "").toLowerCase().includes(q)) { found = n; break; } }
      // A search hit can live above the mounted window. Mount the rest and let this effect run again
      // (keeping the pending highlight) rather than silently falling through to the bottom.
      if (!found && visible < items.length) { setVisible(items.length); return; }
      highlightRef.current = "";
      if (found) { (found as HTMLElement).scrollIntoView({ block: "center" }); found.classList.add("hl-flash"); const f = found; setTimeout(() => f.classList.remove("hl-flash"), 2200); }
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (forceBottom.current) { forceBottom.current = false; stickBottom.current = true; setAtBottom(true); el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); return; }
    // Follow new content ONLY while the user is parked at the bottom. The moment they scroll up to
    // read, stickBottom goes false (see onThreadScroll) and we stop yanking them back down.
    if (stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, busy, compacting, visible]);

  // Track whether the user is at the bottom. Programmatic scroll-to-bottom lands here too and
  // (correctly) re-sticks; scrolling up to read un-sticks and shows the jump-to-latest button.
  const onThreadScroll = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickBottom.current = near;
    setAtBottom((v) => (v === near ? v : near));
    // Approaching the top of the mounted window: pull in the previous chunk. The data is already
    // here, so this only mounts more blocks. Record the scroll geometry first — the new blocks are
    // prepended, and without re-anchoring below the viewport would jump backwards.
    if (el.scrollTop < 400) {
      setVisible((v) => {
        if (v >= (activeStoreRef.current?.items.length ?? 0)) return v;
        if (!growAnchor.current) growAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
        return v + VIS_STEP;
      });
    }
  }, []);
  // Scroll to a subagent's card and flash it. Mirrors the search-hit jump: a card can sit above the
  // mounted window, so mount the rest and retry on the next frame rather than silently doing nothing.
  const jumpToAgent = useCallback((id: string) => {
    const find = () => scrollRef.current?.querySelector(`[data-agent-id="${id}"]`) as HTMLElement | null;
    const go = (el: HTMLElement) => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("hl-flash");
      setTimeout(() => el.classList.remove("hl-flash"), 2200);
    };
    const el = find();
    if (el) { go(el); return; }
    setVisible(items.length);                       // card is above the mounted tail -> mount it all
    requestAnimationFrame(() => { const e2 = find(); if (e2) go(e2); });
  }, [items.length]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    stickBottom.current = true; setAtBottom(true); el.scrollTop = el.scrollHeight;
  }, []);

  // Keep the reading position fixed across a window grow: the blocks mounted above added height, so
  // shift scrollTop by exactly that much. Runs before paint, so the user never sees the jump.
  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const a = growAnchor.current;
    if (a) {
      growAnchor.current = null;
      const delta = el.scrollHeight - a.height;
      if (delta > 0) el.scrollTop = a.top + delta;
      return;
    }
    // The window can be shorter than the viewport (short blocks), and then no scroll event can ever
    // fire to grow it — the user would be stranded with no way to reach the earlier history. Top it
    // up until it overflows. Bounded: each pass adds a step and stops at the full list.
    if (visible < items.length && el.scrollHeight <= el.clientHeight) setVisible((v) => v + VIS_STEP);
  }, [visible, items]);

  // A different conversation starts from the tail again (and drops the old one's mounted blocks).
  useEffect(() => { setVisible(VIS_STEP); growAnchor.current = null; }, [activeId]);

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
        // Release messages typed during compaction. Deferred a microtask because onEvent runs BEFORE
        // ingest applies the compact card — this way the queued turns render AFTER the divider.
        if (e.t === "compact") queueMicrotask(() => flushCompactRef.current());
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

  // Messages typed DURING a compaction are held (text only, no optimistic render), then rendered +
  // sent once compaction finishes — the compact event fires onEvent -> here (deferred a microtask so
  // the compact card is already in items, landing these turns BELOW the divider instead of above it).
  flushCompactRef.current = () => {
    const q = compactQueue.current; compactQueue.current = [];
    const s = activeStoreRef.current; if (!q.length || !s) return;
    void (async () => {
      for (const text of q) {
        s.addOptimisticUser(text); // now renders below the compaction divider (card already applied)
        const cid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        const body = { text, cid, resume: s.id.startsWith("new-") ? undefined : s.id, model: modelRef.current || undefined, cwd: cwdRef.current || undefined };
        try { if (s.connected) await api.send({ id: s.id, text, cid }); else { const r = await api.start(body); if (r?.id) { manager.rebind(s, r.id); s.connect(false); } } }
        catch { await offline.enqueueSend(body); void refreshQueue(); }
      }
    })();
  };

  // Open a conversation: point the view at its store, paint instantly from what we already have (memory
  // -> cache), then reconcile from the network once and connect if it's live. The store holds its items
  // continuously, so a switch is a pointer change — no reconnect, no re-fetch when it's already in memory.
  const loadConv = useCallback(async (id: string, highlight?: string) => {
    activeStoreRef.current?.flushCache(); // snapshot the conversation we're leaving so returning is instant
    setEditing(null); setEditError(null); // a stale edit target from another conversation must not carry over
    const switching = activeIdRef.current !== id; // a real switch (not a same-conv reconnect/reload)
    const s = manager.ensure(id);
    setActiveStore(s); activeStoreRef.current = s;
    activeIdRef.current = id;
    if (switching) setInput(loadDraft(id)); // swap the composer to this conversation's saved draft
    setSearch(""); setSearchHits([]); // opening a result clears the search so the full list is back
    stopReadAloud(); setReading(null); // don't keep reading a message from the conversation you just left
    setDrawer(false);
    history.replaceState(null, "", `/app?c=${id}`);
    // Jump to the end only when actually OPENING a different conversation. A same-conversation reload
    // (stall-watchdog resync, stream reconnect, offline-queue drain) must not force-scroll, or it yanks
    // you back to the bottom every few seconds while you're scrolled up reading.
    if (highlight) highlightRef.current = highlight; else if (switching) forceBottom.current = true;
    // Instant paint: if the store isn't already hydrated in memory, fill it from the offline cache.
    if (!s.hydrated && !s.items.length) {
      const cached = await offline.getConv(id).catch(() => null);
      if (cached && activeStoreRef.current === s) s.hydrate(cached.items, { busy: cached.busy, cwd: cached.cwd, evCount: cached.evCount });
    }
    // Fold anything the service worker pulled in while the app was closed. This is the payoff of the
    // background cache: the turns that landed while you were away are already on disk, so they paint
    // with no network at all. Done before the fetch below so the screen is complete immediately.
    if (activeStoreRef.current === s) {
      const parked = await offline.takePendingEvents(id).catch(() => null);
      if (parked && activeStoreRef.current === s) {
        s.applyDelta(parked.events as AppEvent[], parked.evCount);
        s.flushCache();                          // persist the folded result before dropping the parked copy
        void offline.clearPendingEvents(id);
      }
    }
    if (!navigator.onLine) { if (!s.items.length) s.showItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]); return; }
    setLoadingConv(true);
    try {
      const useDelta = s.evCount > 0 && !s.evDirty;
      const d = await api.conversation(id, useDelta ? s.evCount : 0);
      if (activeStoreRef.current !== s) return; // user switched away while we fetched
      // Delta path: the server only sent what we were missing, so fold it instead of rebuilding. Skips
      // reconcile entirely, which is safe because appending can't discard local state the way a full
      // replace can. `delta:false` (no cursor, or a cursor the server couldn't honour) falls through to
      // the original full-replace path below, so a diverged cache always self-heals.
      if (d.delta === true && !(d.live && Array.isArray(d.pendingAsks) && d.pendingAsks.length)) {
        if ((d.events || []).length) s.applyDelta(d.events as AppEvent[], d.evTotal, { busy: !!d.busy, cwd: d.cwd || defaultCwd });
        else s.setBusy(!!d.busy);
        if (d.live) s.connect(true);
        return;
      }
      const serverItems: Item[] = (d.events || []).reduce((acc: Item[], e: AppEvent) => applyEvent(acc, e), [] as Item[]);
      // A live conversation blocked on an ask_user: the transcript's ask id can't unblock the tool, so
      // swap any unanswered asks for the server's real pending asks.
      if (d.live && Array.isArray(d.pendingAsks) && d.pendingAsks.length) {
        for (let i = serverItems.length - 1; i >= 0; i--) if (serverItems[i].kind === "ask" && (serverItems[i] as any).answered === undefined) serverItems.splice(i, 1);
        for (const a of d.pendingAsks) serverItems.push({ kind: "ask", askId: a.askId, question: a.question, options: a.options || [], multiSelect: a.multiSelect, allowText: a.allowText });
      }
      s.reconcile(serverItems, { busy: !!d.busy, cwd: d.cwd || defaultCwd, evCount: d.evTotal });
      if (d.live) s.connect(true); // stream follow-up events; connect() is a no-op if already connected
    } catch {
      if (!s.items.length && activeStoreRef.current === s) s.showItems([{ kind: "assistant", text: "_This conversation isn't cached for offline viewing._" }]);
    } finally { if (activeStoreRef.current === s) setLoadingConv(false); }
  }, [defaultCwd]);

  const newChat = () => { setActiveStore(null); activeStoreRef.current = null; activeIdRef.current = null; setAttachments([]); setEditing(null); setEditError(null); setInput(loadDraft(null)); cwdRef.current = defaultCwd; history.replaceState(null, "", "/app"); setDrawer(false); taRef.current?.focus(); };
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
  // A turn held offline shows the waiting-to-send clock. Sending it is only half the job: without
  // this the store stays on sendState "queued" and the clock never becomes ticks, so a message that
  // went through still reads as stranded. Hand the turn back to the normal delivery path instead.
  const settleQueued = (body: { text: string; resume?: string }, serverId: string) => {
    const s = (body.resume ? manager.get(body.resume) : null) || manager.findQueuedNewChat(body.text);
    if (!s) return;
    const oldId = s.id;                         // rebind mutates s.id, so read it first
    if (oldId !== serverId) {                   // a chat started offline only gets its id now
      manager.rebind(s, serverId);
      if (activeIdRef.current === oldId || activeStoreRef.current === s) activeIdRef.current = serverId;
    }
    s.setBusy(true);                            // the server has taken the turn, so a reply is coming
    s.setSendState("delivered");
    s.connect(false);                           // stream the reply in rather than waiting for a poll
  };

  const drainQueueUI = useCallback(async () => {
    const q = await offline.getQueue();
    if (!q.length) return;
    let lastId: string | null = null;
    for (const it of q.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        const r = await api.start(it.body);
        if (it.qid != null) await offline.removeQueued(it.qid);
        if (r?.id) { lastId = r.id; settleQueued(it.body, r.id); }
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
  // working until you send again (which reopens the stream). While a reply is outstanding, if the
  // stream has gone quiet, resync from the server: reattaches the stream and picks up the ending or
  // the missed events.
  //
  // Deliberately NOT gated on `busy`. Every queue/timeout path in submitText calls setBusy(false), so a
  // turn the server accepted can sit with busy=false and no reply forever, which is the "two ticks then
  // silence" stall. Treat "the server has our turn (ticks) and the last thing on screen is still our own
  // message" as outstanding too, and resync that as well.
  useEffect(() => {
    const t = setInterval(() => {
      const id = activeIdRef.current;
      if (!id || id.startsWith("pending-") || !navigator.onLine) return;
      const s = activeStoreRef.current;
      if (!s) return;
      const last = s.items[s.items.length - 1];
      const awaitingReply = (s.sendState === "delivered" || s.sendState === "read") && last?.kind === "user";
      if (!s.busy && !awaitingReply) { resyncRef.current = { id, n: 0, settled: false }; return; } // idle, or the reply landed
      if (resyncRef.current.id !== id) resyncRef.current = { id, n: 0, settled: false }; // per-conversation attempts
      const quietFor = Date.now() - lastEventAt.current;
      const st = statuses[id];
      const serverDone = st ? !st.busy : false; // server knows this conv and says the turn ended
      // The server says this conversation is idle and resyncing has already failed to clear our local
      // outstanding state, so another resync would do exactly the same thing. Stop, and take the
      // server's word. Without this cap a resync that can't clear the condition reopens the SSE every
      // few seconds forever, which is worse than the stall it was meant to fix.
      if (serverDone && resyncRef.current.n >= 2) {
        if (!resyncRef.current.settled) { resyncRef.current.settled = true; s.forceIdle(); }
        return;
      }
      // Missed the ending (server done but we still show busy) -> resync fast. A live turn resyncs after
      // a shorter silence so a weak-signal stall recovers on its own. A turn with no reply at all waits
      // longer, since nothing has started streaming yet and a slow first token is normal. Drop the
      // (possibly silently-dead) socket first so loadConv's connect() actually reopens it instead of
      // no-opping on a stale one.
      const threshold = serverDone ? 6000 : s.busy ? 15000 : 25000;
      if (quietFor > threshold) { resyncRef.current.n++; lastEventAt.current = Date.now(); s.disconnect(); void loadConv(id); }
    }, 4000);
    return () => clearInterval(t);
  }, [statuses, loadConv]);

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
    // During compaction, hold the message ENTIRELY (no optimistic render yet). flushCompact renders +
    // sends it once the compact card is in place, so it lands BELOW the compaction divider, not above.
    if (s!.compacting && !s!.id.startsWith("new-")) { compactQueue.current.push(text); return s!.id; }
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
    // Clear THIS conversation's saved draft now, keyed by the id we're sending FROM (null = new chat).
    // Doing it here (not only via the input-change effect) avoids a race where a new chat gets its real
    // id before the effect runs, leaving the "__new__" draft set so the next new chat reloads it.
    saveDraft(activeIdRef.current, "");
    setInput(""); setAttachments([]);
    if (taRef.current) taRef.current.style.height = "auto";
    // The composer being emptied is authoritative. Without this, dictation's next poll returns the
    // same server-side transcript and splices the words you just sent back into the empty box, and
    // a tidy pass still running would paste them back a second later. Resetting keeps the mic open,
    // so you can send mid-thought and carry straight on into a clean composer.
    if (dictation.active) { dictation.reset(); dictAnchorRef.current = { prefix: "", suffix: "" }; }
    else dictAnchorRef.current = null;
    // Editing a past turn -> rewind-and-rerun instead of appending. Attachments don't apply to an edit.
    if (editing) {
      const ed = editing;
      setEditing(null); setEditError(null);
      const err = await doEdit(ed, raw);
      // Failed edits stay edits: restore the composer and the banner so it can be retried or cancelled.
      // Falling through to submitText() here is what used to append the edit as a duplicate turn.
      if (err) { setEditing(ed); setEditError(err); setInput(raw); requestAnimationFrame(() => taRef.current?.focus()); }
      return;
    }
    // An unanswered ask_user card blocks the whole turn: the SDK is parked inside the tool call, so
    // a normal send only reaches the runner's input queue, which is not drained until the turn ends.
    // That reads as double grey ticks and no reply, forever. Typing an answer is the obvious thing
    // to do when the last thing on screen is a question, so route the text to the card instead.
    const askStore = activeStoreRef.current;
    const openAsk = attachments.length ? undefined : (askStore?.items.find((it) => it.kind === "ask" && it.answered === undefined) as Extract<Item, { kind: "ask" }> | undefined);
    if (askStore && openAsk) {
      askStore.answerAsk(openAsk.askId, raw);
      void deliverAsk(askStore, openAsk.askId, raw);
      return;
    }
    await submitText(text);
  };

  // #region dictation (composer mic)
  // Text lands where the caret was, so you can dictate into the middle of a half-typed message. The
  // anchor is captured once at the start: everything the transcript grows by is re-spliced between
  // the same prefix and suffix, which is what lets grey partial text be replaced in place.
  const dictAnchorRef = useRef<{ prefix: string; suffix: string } | null>(null);
  const onDictText = useCallback((text: string, done: boolean) => {
    const a = dictAnchorRef.current;
    if (!a) return;
    const sep = a.prefix && !/\s$/.test(a.prefix) ? " " : "";
    const caret = (a.prefix + sep + text).length;
    setInput(a.prefix + sep + text + a.suffix);
    if (done) dictAnchorRef.current = null;
    requestAnimationFrame(() => {
      const ta = taRef.current; if (!ta) return;
      ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
      // Caret to the end of the dictated span, without focus() — on a phone that would throw the
      // keyboard up over the message you just spoke.
      if (done) { try { ta.setSelectionRange(caret, caret); } catch { /* */ } }
    });
  }, []);
  const dictation = useDictation({ onText: onDictText, tidy: dictTidy, enabled: voiceAvail });
  const toggleDictation = () => {
    if (dictation.active) { dictation.stop(); return; }
    const ta = taRef.current;
    const pos = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : input.length;
    dictAnchorRef.current = { prefix: input.slice(0, pos), suffix: input.slice(pos) };
    dictation.start();
  };
  // #endregion

  // Stable bridge handed to voice mode: submit a turn + subscribe to the live event stream.
  const voiceBridge = useMemo<VoiceBridge>(() => ({
    submit: (text: string) => submitText(text, { voice: true }), // flag the turn so the backend adds the brief/TTS directive
    subscribe: (fn) => { voiceSinks.current.add(fn as (e: AppEvent) => void); return () => { voiceSinks.current.delete(fn as (e: AppEvent) => void); }; },
  }), [submitText]);

  const stop = async () => { const s = activeStoreRef.current; if (!s) return; s.setBusy(false); await api.interrupt(s.id); };

  // #region context menus (long-press / right-click): message copy+edit, conversation rename+delete
  const onMsgMenu = useCallback((x: number, y: number, text: string, kind: "user" | "assistant", i: number) => setMsgMenu({ x, y, text, kind, i }), []);
  const copyText = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* */ } };
  // Enter edit mode for a past user turn: prefill the composer and remember which turn, so submit
  // rewinds-and-reruns from there (see doEdit) instead of appending a new turn.
  const startEdit = (i: number, t: string) => { setMsgMenu(null); setEditing({ i, orig: t }); setEditError(null); setInput(t); requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; ta.setSelectionRange(t.length, t.length); } }); };
  const cancelEdit = () => { setEditing(null); setEditError(null); setInput(""); if (taRef.current) taRef.current.style.height = "auto"; };
  // Rewind-and-rerun: drop the edited turn + everything after (optimistically), then ask the server to
  // roll files back to that turn's checkpoint, fork the transcript, and re-run the edited text. The
  // forked session's new id + reply stream back in on the existing socket. Returns null on success or
  // a human reason on failure. It must NEVER fall back to submitText(): an edit that degrades into a
  // plain send leaves the original turn in place and posts the edited text as a second, duplicate turn.
  const doEdit = async (ed: { i: number; orig: string }, text: string): Promise<string | null> => {
    const s = activeStoreRef.current;
    const realId = !!s && !s.id.startsWith("new-") && !s.id.startsWith("pending-");
    if (!s || !realId) return "This chat hasn't started on the server yet, so there's no turn to rewind. Cancel the edit to send it as a new message.";
    if (typeof navigator !== "undefined" && !navigator.onLine) return "You're offline. An edit rewinds the conversation on the server, so unlike a normal message it can't be queued. It will work once you're back online.";
    // 0-based ordinal among user turns up to the edited item — matches the server's user-turn count.
    let uindex = -1; for (let k = 0; k <= ed.i && k < s.items.length; k++) if (s.items[k].kind === "user") uindex++;
    if (uindex < 0) return "Couldn't work out which turn to rewind to. Reload the conversation and try again.";
    stickBottom.current = true; setAtBottom(true);
    const snapshot = s.items;
    s.truncateFrom(ed.i);             // drop the edited bubble + everything after
    s.addOptimisticUser(text, false); // re-render the edited text below; arms the echo dedup
    const cid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    try {
      const r = await withTimeout(api.edit({ id: s.id, index: uindex, text, cid, orig: ed.orig, model: modelRef.current || undefined }), 30000);
      if (r?.error) { s.restore(snapshot); return "Couldn't edit that message: " + r.error; }
      if (s.sendState === "sending") s.setSendState("delivered");
      return null;
    } catch { s.restore(snapshot); return "Couldn't reach the server to edit, so nothing was sent and nothing was duplicated. Try again."; }
  };
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

  // Deliver an ask answer to the server and make sure it actually lands. Two ways it used to vanish
  // without a trace: a dropped request on a weak link (the POST was fire-and-forget), and an askId
  // taken from a transcript-rendered card, which is the tool_use id and does not match the live
  // runner's key, so the server replied {ok:false} and nobody looked at it. Either way the card
  // showed answered while the turn stayed parked inside the tool call, waiting forever. So: retry,
  // re-target whatever ask is genuinely open, and if it still will not land, put the card back.
  const deliverAsk = useCallback(async (s: ConvStore, askId: string, answer: string) => {
    let id = askId;
    const post = async () => { try { const r = await api.answerAsk(s.id, id, answer); return r?.ok === true; } catch { return null; } }; // null = request failed, false = server refused
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await post();
      if (ok === true) return;
      if (ok === false) {
        // The server has no open ask under that id. Either it is already answered (nothing to do) or
        // our id is stale, in which case answer the one the runner is really blocked on.
        try {
          const d = await api.conversation(s.id, s.evCount);
          const open = (d.pendingAsks || [])[0];
          if (!open) return;
          if (open.askId !== id) { id = open.askId; continue; }
        } catch { /* fall through to the backoff */ }
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    s.unanswerAsk(askId);
  }, []);

  // User tapped an ask_user option: mark it chosen locally + tell the server (unblocks Claude).
  const answerAsk = useCallback((askId: string, answer: string) => {
    const s = activeStoreRef.current; if (!s) return;
    s.answerAsk(askId, answer);
    void deliverAsk(s, askId, answer);
  }, [deliverAsk]);

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

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const preview = isImage ? URL.createObjectURL(f) : undefined; // local thumbnail, no server round-trip
      try { const r = await api.upload(activeId, f); if (r?.path) setAttachments((a) => [...a, { name: f.name, path: r.path, isImage, preview }]); }
      catch { if (preview) URL.revokeObjectURL(preview); }
    }
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []); e.target.value = ""; if (!files.length) return;
    await addFiles(files);
  };
  // Paste a screenshot straight into the box. Clipboard images arrive as nameless "image.png" blobs,
  // so give each a readable, unique name. Non-image pastes fall through to the normal text paste.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData?.items || []).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    const stamp = Date.now();
    const files = imgs.map((it, i) => {
      const f = it.getAsFile(); if (!f) return null;
      const named = f.name && f.name !== "image.png";
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return named ? f : new File([f], `pasted-${stamp}${imgs.length > 1 ? "-" + (i + 1) : ""}.${ext}`, { type: f.type });
    }).filter((f): f is File => !!f);
    if (files.length) void addFiles(files);
  };
  // Drag a file (or several) onto the composer to attach it.
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files || []);
    setDragOver(false);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault(); setDragOver(true);
  };

  // Desktop: Enter sends, Shift+Enter is a newline. Touch devices (phone/tablet): Enter is always a
  // newline — sending is the dedicated send button, so the on-screen keyboard's return key composes.
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !IS_TOUCH) { e.preventDefault(); void doSend(); } };
  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInput(e.target.value); const ta = e.target; ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 220) + "px"; };

  const modelLabel = [...models, ...moreModels].find((m) => m.id === model)?.label || model || "Model";
  // Collapsed pill: drop any "(…)" qualifier so it stays short and single-line (e.g. "Default
  // (recommended)" -> "Default"). The dropdown row keeps the full name + description.
  const modelBtnLabel = modelLabel.replace(/\s*\([^)]*\)\s*$/, "").trim() || modelLabel;

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
  // True when this conversation's activity is coming from a TERMINAL tab rather than the app, so the
  // dot can be shown in the terminal's own violet instead of the app's coral.
  const convIsTerminal = (c: Conv): boolean => !!(statuses[c.sessionId] as { terminal?: boolean } | undefined)?.terminal;
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
          ? <span className={"conv-status " + status + (convIsTerminal(c) ? " terminal" : "")} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
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

  // The thread is built here, memoised, so that typing in the composer (which re-renders App on every
  // keystroke) does not rebuild or reconcile it: React skips a subtree whose element is referentially
  // unchanged. Only a real thread input — new/edited items, the window growing, turn state — rebuilds
  // it. Blocks before the window are not mounted at all; scrolling up grows it from memory.
  const sendState = activeStore?.sendState ?? null;
  const threadNodes = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    // Plain tools collapse into an accordion; subagent/workflow (Task) tools stay standalone
    // (rich activity card); TodoWrite is hidden here (the pinned checklist replaces it).
    const isPlainTool = (t: Item) => t.kind === "tool" && !isAgentTool((t as Extract<Item, { kind: "tool" }>).name, (t as Extract<Item, { kind: "tool" }>).input) && !isTodoTool((t as Extract<Item, { kind: "tool" }>).name);
    let lastUserIdx = -1; for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === "user") { lastUserIdx = k; break; }
    // Only the tail is mounted. Blocks still read their neighbours out of the FULL items array, so
    // the role label and turn-final footer stay correct at the window edge.
    const start = Math.max(0, items.length - visible);
    for (let i = start; i < items.length; i++) {
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
      nodes.push(<MessageBlock key={i} items={items} i={i} onAnswer={answerAsk} convId={activeId} onMenu={onMsgMenu} onOpenArtifact={setArtifact} sendStatus={i === lastUserIdx ? sendState : null} reading={reading?.i === i ? reading.phase : undefined} />);
    }
    return nodes;
  }, [items, visible, busy, activeId, sendState, reading, answerAsk, onMsgMenu, setArtifact]);

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
              <div className="settings-section">Notifications</div>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Push notifications</span>
                  <span className="settings-row-desc">
                    {pushSupported()
                      ? "Get told when a turn finishes or an agent needs you, even with the app closed. On Android this also keeps conversations cached in the background, so reopening shows everything straight away with no loading."
                      : isIOSDevice()
                        ? "Install this to your Home Screen first, then come back and turn this on."
                        : "This browser cannot do push notifications."}
                  </span>
                  {pushErr && <span className="settings-row-desc settings-row-err">{pushErr}</span>}
                </span>
                <button
                  role="switch"
                  aria-checked={!!pushOn}
                  disabled={pushBusy || !pushSupported()}
                  className={"toggle" + (pushOn ? " on" : "") + (pushBusy ? " busy" : "")}
                  onClick={() => void togglePush()}
                ><span className="knob" /></button>
              </label>
              <div className="settings-section">Voice</div>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Tidy up dictation</span>
                  <span className="settings-row-desc">When you finish dictating, pass the transcript through Claude Haiku to fix punctuation, drop the ums, and spell project names properly. Adds a second or so; turn it off for raw Whisper output.</span>
                </span>
                <button role="switch" aria-checked={dictTidy} className={"toggle" + (dictTidy ? " on" : "")} onClick={() => setDictTidy(!dictTidy)}><span className="knob" /></button>
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">Skip the running commentary</span>
                  <span className="settings-row-desc">In voice mode, stay quiet while Claude works and read back only the answer. It still reads as the answer streams in, so you hear the first sentence while the rest is still being written.</span>
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
      <ConnectionsModal open={connOpen} onClose={() => setConnOpen(false)} activeId={activeId} />
      <aside className="sidebar">
        <div className="sb-head">
          <span className="brand">Claude</span>
          <button className="sb-gear" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
          <button className="sb-gear" onClick={() => setConnOpen(true)} aria-label="Connections" title="Connections (MCP servers, skills, memory, network)">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2.6" /><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="12" cy="20" r="2" /><path d="M10.2 10.2 6.4 6.4M13.8 10.2l3.8-3.8M12 14.6V18" /></svg>
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
          <a className="term-link" href="/terminal">
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
              {threadNodes}
              {compacting && <CompactionBanner start={activeStore?.compactStart ?? 0} />}
              {busy && !compacting && items[liveEnd(items) - 1]?.kind === "user" && (<div className="msg bubble-assistant"><div className="typing"><span></span><span></span><span></span></div></div>)}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {!atBottom && items.length > 0 && (
            <button className="jump-latest" onClick={jumpToLatest} title="Jump to latest" aria-label="Jump to latest">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            </button>
          )}
          <SpawnedWork items={items} sessionId={activeId} onJump={jumpToAgent} onOpenConversation={loadConv} />
          {todos && <TodoChecklist todos={todos} />}
          {editing && (
            <div className={"edit-banner" + (editError ? " error" : "")} role={editError ? "alert" : undefined}>
              <span>{editError || "Editing your message — this rewinds the chat and reruns from here, undoing any file changes since."}</span>
              <button onClick={cancelEdit} aria-label="Cancel edit">×</button>
            </div>
          )}
          <div className={"composer" + (dragOver ? " drag-over" : "")} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={() => setDragOver(false)}>
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
            <textarea ref={taRef} value={input} onChange={onInput} onKeyDown={onKey} onPaste={onPaste} rows={1} placeholder={pendingAsk ? "Answer the question above…" : "Reply to Claude..."} />
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
              <button className="act-btn" onClick={() => setConnOpen(true)} title="Connections — MCP servers, skills, memory, network">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v3M15 7V4a1 1 0 0 0-1-1M7 7h10l-.6 9a3 3 0 0 1-3 2.8H10.6a3 3 0 0 1-3-2.8L7 7z" /><path d="M12 18v3" /></svg>
              </button>
              <div className="spacer" />
              {dictation.available && (
                <button
                  className={"act-btn dictate-btn" + (dictation.active ? " rec" : "") + (dictation.tidying ? " tidying" : "")}
                  onClick={toggleDictation}
                  style={dictation.active ? ({ "--lvl": String(0.85 + dictation.level * 0.4) } as any) : undefined}
                  title={dictation.active ? "Stop dictating" : dictation.error || "Dictate — speak to type into the message box (does not send)"}
                  aria-label="Dictate"
                  aria-pressed={dictation.active}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" stroke="currentColor" strokeWidth="1.7" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                </button>
              )}
              {voiceAvail && (
                <button className="act-btn voice-open-btn" onClick={() => setVoiceOpen(true)} title="Voice mode — hands-free spoken conversation, Claude talks back">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1" /><path d="M4 13h2.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M20 13h-2.5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1z" /><path d="M18 18v1a2 2 0 0 1-2 2h-3" /></svg>
                </button>
              )}
              {busy && activeStore?.connected && (
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
                <span>{modelBtnLabel}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {menuOpen && (
                <div className="model-menu" onMouseLeave={() => setMenuOpen(false)}>
                  {models.map((m) => (
                    <button key={m.id} className="model-row" onClick={() => onPickModel(m.id)}>
                      <span className="model-line">{m.label}{m.id === model && <span className="dot">●</span>}</span>
                      {m.description && <span className="model-desc">{m.description}</span>}
                    </button>
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
            {msgMenu.kind === "user" && <button onClick={() => startEdit(msgMenu.i, msgMenu.text)}>Edit &amp; rerun</button>}
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
