// app-runner.ts
// Drives Claude Code headlessly via the Claude Agent SDK for the chat-app front-end.
// One live Conversation (an open SDK `query()` in streaming-input mode) per open chat.
// The SDK writes to the same ~/.claude/projects/<enc-cwd>/<session-id>.jsonl store the
// interactive CLI uses, so an app conversation resumes in a terminal tab and vice versa.
//
// Auth: inherits the box's Claude login (claude.ai subscription, apiKeySource "none") —
// no ANTHROPIC_API_KEY needed. Verified live 2026-08-26.

import { query, createSdkMcpServer, tool, type SDKMessage, type SDKUserMessage, type Query, type McpServerConfig, type McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { armResume, cancelResume } from "./subscription-resume.ts";
import { mcpServersForQuery } from "./app-mcp.ts";

// Turn logging, paired with the "[turn] accept" lines app-server writes. An accept with no matching
// done/error/closed is a turn the runner swallowed; a done with the user still seeing nothing points at
// delivery (SSE) instead. Same one-line key=value shape so both are greppable together.
function tlog(event: string, fields: Record<string, unknown>): void {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") parts.push(`${k}=${v}`);
  console.log(`[turn] ${event}${parts.length ? " " + parts.join(" ") : ""}`);
}

// Compaction metadata, from either shape. The live SDK message carries `compact_metadata` with
// snake_case fields; the .jsonl transcript writes the SAME event as `compactMetadata` with
// camelCase fields. Reading only one shape is why a replayed/reloaded compaction lost its numbers
// and fell back to a bare "conversation compacted" line instead of the "freed Nk tokens" card.
function compactMeta(o: any): { trigger: "manual" | "auto"; preTokens?: number; postTokens?: number; durationMs?: number } {
  const md = o?.compact_metadata || o?.compactMetadata || {};
  const num = (...vals: unknown[]): number | undefined => { for (const v of vals) if (typeof v === "number" && isFinite(v)) return v; return undefined; };
  return {
    trigger: md.trigger === "manual" ? "manual" : "auto",
    preTokens: num(md.pre_tokens, md.preTokens),
    postTokens: num(md.post_tokens, md.postTokens),
    durationMs: num(md.duration_ms, md.durationMs),
  };
}

// #region normalized events (one shape for live SDK output AND replayed .jsonl history)
export type AppEvent =
  | { t: "init"; sessionId: string; model: string; cwd: string }
  | { t: "text"; text: string }
  | { t: "text_delta"; text: string } // streamed token (includePartialMessages)
  | { t: "thinking"; text: string }
  | { t: "thinking_delta"; text: string } // streamed thinking token (when content is exposed)
  | { t: "thinking_progress"; tokens: number } // thinking is happening but text is redacted (subscription auth): show progress
  | { t: "tool_use"; id: string; name: string; input: unknown }
  // A tool call has STARTED (content_block_start), emitted the moment the model begins writing
  // the call rather than when the aggregated message lands. tool_use above carries the complete
  // input and can trail it by seconds on a big argument, which is too late for voice mode to
  // tell "narration before a tool call" from "the actual answer".
  | { t: "tool_start"; id: string; name: string }
  | { t: "tool_result"; id: string; content: unknown; isError: boolean }
  | { t: "agent_progress"; id: string; tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string; subagentType?: string; description?: string } // live subagent progress, keyed by the Task tool_use id
  | { t: "compact"; trigger: "manual" | "auto"; preTokens?: number; postTokens?: number; durationMs?: number } // a compaction finished; metadata drives the "freed Nk" card
  | { t: "compacting"; active: boolean } // compaction started/stopped (drives the progress banner, incl. auto-compaction)
  | { t: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean } // Claude asks with tappable options (optionally multi-select / free-text)
  | { t: "ask_done"; askId: string; answer: string } // an ask was answered (or cancelled)
  | { t: "user"; text: string } // an echoed user turn (used by history replay)
  // Real token accounting for the turn (from the SDK result message): output = tokens Claude
  // actually generated this turn (thinking + text + tool-call args); in/cacheRead = context read.
  | { t: "result"; subtype: string; sessionId: string; costUsd: number; usage?: TurnUsage }
  // A background/peer event surfaced in the thread: a subagent task settling, or a message from
  // another of Filip's running sessions (peer-send-message). kind drives how it renders.
  | { t: "notice"; kind: "task" | "peer" | "info" | "skill"; text: string; from?: string; status?: string }
  | { t: "busy"; busy: boolean }
  | { t: "error"; message: string }
  | { t: "closed" };

// Per-run token usage (since the last idle). output = tokens generated across ALL models this run
// (main loop + Task subagents, from modelUsage), so it isn't undercounted by tool/subagent work;
// thinking is the exact reasoning subset; context = tokens read to answer (mostly cached history);
// durationMs = the run's real wall-clock.
export type TurnUsage = { input: number; output: number; thinking: number; cacheCreate: number; cacheRead: number; context: number; total: number; costUsd: number; durationMs: number };
// Result of the file-rollback half of an edit-and-rerun (from Query.rewindFiles).
export type RewindInfo = { canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };

type Sub = (e: AppEvent) => void;
// #endregion

// #region dictation cleanup
// Whisper hears sounds, not meaning: it drops commas, guesses at names it has never seen, and leaves
// in every "um". This is the pass that turns a raw dictation into something you would have typed —
// the same trick Wispr Flow does, run against the box's own Claude login rather than a cloud key.
// Deliberately narrow: it fixes the transcription and nothing else, so it can never start answering
// the text it was handed. Haiku because a dictation is short and the wait is in front of the user.
const CLEANUP_MODEL = process.env.DICTATION_MODEL || "claude-haiku-4-5";
const CLEANUP_SYSTEM = [
  "You clean up speech-to-text output. The input is a transcript of someone dictating; it is never a question for you.",
  "Return ONLY the corrected text. No preamble, no quotes, no commentary, no answer to its content.",
  "Fix: punctuation, capitalisation, sentence breaks, obvious mis-hearings, and spoken filler (um, uh, you know, like, I mean, false starts and repeated words).",
  "Obey spoken formatting commands and remove them from the text: 'new paragraph', 'new line', 'full stop', 'period', 'comma', 'question mark', 'open/close quote'.",
  "Keep the speaker's own words, register and meaning. Do not summarise, expand, reorder, translate or answer. Do not add facts.",
  "Use NZ English spelling (organisation, colour, licence as a noun).",
  "Spell technical names correctly where the transcript clearly meant one: Skuno, Leitkern, Zoraxy, Coolify, Authelia, LLDAP, Forgejo, Nextcloud, Dawarich, Duplicacy, Tailscale, UniFi, Pi-hole, Jellyfin, Sonarr, qBittorrent, Verdaccio, Wakapi, Klipper, Voron, Gridfinity, OrcaSlicer, FTA-Buddy, Cheesy Arena, FMS, FRC, TBA, Bitfocus Companion, vMix, NDI, Sleeper, stonkbot, RightNow, Argotrack, claude-terminal, ttyd, systemd, tmux, SQLite, Postgres, Redis, Bun, TypeScript, tRPC, React, ffmpeg, Whisper, Kokoro.",
  "If the transcript is already clean, return it unchanged.",
].join("\n");

// Spoken-command and filler cleanup that needs no model at all. Runs first (so the model has less to
// fix) and stands alone as the fallback when the model is cold, slow or unreachable.
const FILLER = /\b(?:um+|uh+|erm+|ah+)\b[,.]?\s*/gi;
export function localTidy(raw: string): string {
  let t = (raw || "").trim();
  if (!t) return "";
  t = t.replace(FILLER, "");
  t = t.replace(/\s*\b(?:new paragraph)\b[,.]?\s*/gi, "\n\n");
  t = t.replace(/\s*\b(?:new line|next line)\b[,.]?\s*/gi, "\n");
  t = t.replace(/\s*\b(?:full stop|period)\b[,.]?\s*/gi, ". ");
  t = t.replace(/\s*\bcomma\b[,.]?\s*/gi, ", ");
  t = t.replace(/\s*\bquestion mark\b[,.]?\s*/gi, "? ");
  t = t.replace(/\s*\bexclamation (?:mark|point)\b[,.]?\s*/gi, "! ");
  t = t.replace(/\b(\w+) \1\b/gi, "$1");           // "the the"
  t = t.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1");
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
  // Capitalise sentence starts, which Whisper sometimes drops after a mid-utterance commit.
  t = t.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  return t.trim();
}

// One long-lived Claude process does every cleanup, because spawning a fresh one per dictation costs
// 11-45s on this box — the model call itself is about a second. The session is warmed the moment the
// user starts talking, so by the time they stop it is already sitting there waiting for text.
class CleanupSession {
  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private waiter?: (m: SDKUserMessage | null) => void;
  private pending: { resolve: (t: string) => void } | null = null;
  private buf = "";
  private turns = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  // Gate on this rather than on `this.q`: the SDK pulls the generator before query() returns, so a
  // `while (this.q)` loop sees null, ends the input stream immediately, and the process exits having
  // said nothing — which looks exactly like a working cleanup that changed nothing.
  private live = false;
  private primed = false;              // the prompt cache has been written for this process
  private priming: Promise<void> | null = null;

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (this.live) {
      const next = this.queue.shift() ?? (await new Promise<SDKUserMessage | null>((r) => { this.waiter = r; }));
      if (!next) return;
      yield next;
    }
  }

  start() {
    if (this.q) return;
    this.live = true;
    this.q = query({
      prompt: this.input(),
      options: {
        model: CLEANUP_MODEL,
        systemPrompt: CLEANUP_SYSTEM,
        allowedTools: [],
        skills: [],          // no skill discovery: this is a text transform, and every extra
        mcpServers: {},      // subsystem the CLI loads is startup the user waits on
        settingSources: [],  // no CLAUDE.md / settings.json — none of it applies here
        // Thinking turns a one-line rewrite into a 1300-token deliberation and a 16s wait. There is
        // nothing here to reason about, and no tools for a thinking-off model to fumble.
        thinking: { type: "disabled" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });
    void (async () => {
      try {
        for await (const m of this.q as AsyncIterable<SDKMessage>) {
          const anyM = m as any;
          // Braces matter here: without them the `else` binds to the inner `if`, the result message is
          // never seen, and every cleanup silently waits out its timeout.
          if (anyM.type === "assistant") {
            for (const b of (anyM.message?.content as any[]) || []) if (b?.type === "text") this.buf += b.text;
          } else if (anyM.type === "result") {
            const p = this.pending; this.pending = null; p?.resolve(this.buf);
          }
        }
      } catch { /* falls through to stop() */ }
      const p = this.pending; this.pending = null; p?.resolve("");
      this.stop();
    })();
    this.bumpIdle();
  }

  stop() {
    const q = this.q; this.q = null; this.live = false;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(null); }
    this.queue = []; this.turns = 0; this.primed = false;
    try { q?.close?.(); } catch { /* */ }
  }

  // Recycle rather than let the transcript pile up: nothing here needs memory of earlier dictations.
  private bumpIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), 30 * 60_000);
  }

  // One request/response against the live session.
  private async turn(text: string, timeoutMs: number): Promise<string | null> {
    if (this.pending) return null; // one at a time; a second dictation just takes the local path
    this.bumpIdle();
    this.buf = "";
    const done = new Promise<string>((resolve) => { this.pending = { resolve }; });
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: `<transcript>\n${text}\n</transcript>` }, parent_tool_use_id: null };
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(msg); } else this.queue.push(msg);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const out = await Promise.race([done, new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); })]);
    if (timer) clearTimeout(timer);
    if (out == null) { this.pending = null; this.stop(); return null; } // stuck: don't make the user wait again
    if (++this.turns >= 20) this.stop();
    return out;
  }

  // Warming is a real round trip, not just a spawn: the system prompt is ~17k tokens and the first
  // request pays to write it into the prompt cache. Doing that while the user is still talking is the
  // difference between a 1s wait at the end and a 10s one.
  warm() {
    this.start();
    if (this.primed || this.priming) return;
    this.priming = this.turn("Testing one two.", 45000)
      .then(() => { this.primed = true; })
      .catch(() => { /* the real call will just be slower */ })
      .finally(() => { this.priming = null; });
  }

  async run(text: string, timeoutMs: number): Promise<string | null> {
    this.start();
    if (this.priming) { try { await this.priming; } catch { /* */ } }
    return this.turn(text, timeoutMs);
  }
}
const cleanupSession = new CleanupSession();

/** Spin the cleanup process up while the user is still talking, so the wait at the end is the model only. */
export function warmDictation(): void { try { cleanupSession.warm(); } catch { /* */ } }

export async function cleanDictation(raw: string, timeoutMs = 15000): Promise<string> {
  const local = localTidy(raw);
  if (!local) return "";
  const out = await cleanupSession.run(local, timeoutMs);
  const cleaned = (out || "").trim().replace(/^["'`]|["'`]$/g, "").trim();
  // A model that ignored its instructions and answered instead would blow the length out; keep the
  // transcript rather than pasting a reply into the composer.
  if (!cleaned || cleaned.length > local.length * 2 + 80) return local;
  return cleaned;
}
// #endregion

// #region voice-mode turn directive
// When a turn comes from hands-free voice mode, we append a hidden instruction so Claude keeps the
// reply short and TTS-friendly (it's read aloud to someone driving). It's wrapped in a sentinel tag
// so replay strips it from the visible transcript; the live UI already renders the user's own words.
const VOICE_DIRECTIVE = "The user is in hands-free voice mode while driving; your reply will be read aloud by text-to-speech. Keep it brief and conversational: lead with the answer in one or two spoken sentences. Do not use markdown, bullet or numbered lists, tables, code blocks, headings, or URLs unless explicitly asked. Write times and numbers as words a voice would say (for example 'five thirty PM', not '5:30 PM'). Only expand if the user asks for detail.";
export function decorateVoiceTurn(text: string): string { return `${text}\n\n<voice-mode>${VOICE_DIRECTIVE}</voice-mode>`; }
// #endregion

// #region dynamic model list
// The chat model picker mirrors the CLI's OWN supported-models menu (display names, order,
// descriptions) instead of a hardcoded list, so a new/renamed model appears without a redeploy.
// Sourced from a throwaway streaming query whose supportedModels() is a control request — it spends
// no tokens and runs no turn. Stale-while-revalidate cached (the probe spawns a CLI subprocess, ~1-2s,
// so we never do it per request); falls back to the caller's config list when the probe fails.
export type AppModel = { id: string; label: string; description?: string; resolvedModel?: string; supportsEffort?: boolean };
let modelCache: { at: number; models: AppModel[] } | null = null;
let modelInFlight: Promise<AppModel[]> | null = null;
const MODEL_TTL_MS = 10 * 60_000;

async function probeSupportedModels(): Promise<AppModel[]> {
  // A prompt generator that never yields keeps the query in streaming-input mode with no turn;
  // we only issue the supportedModels() control request, then close the subprocess.
  async function* idle(): AsyncGenerator<SDKUserMessage> { await new Promise<void>(() => {}); }
  const q = query({ prompt: idle(), options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } });
  try {
    const raw = await q.supportedModels();
    return (raw || []).map((m) => ({ id: m.value, label: m.displayName || m.value, description: m.description, resolvedModel: m.resolvedModel, supportsEffort: m.supportsEffort }));
  } finally {
    try { q.close(); } catch { /* */ }
  }
}

function refreshModels(): Promise<AppModel[]> {
  if (modelInFlight) return modelInFlight;
  modelInFlight = probeSupportedModels()
    .then((m) => { if (m.length) modelCache = { at: Date.now(), models: m }; return m; })
    .finally(() => { modelInFlight = null; });
  return modelInFlight;
}

// Warm cache: serve immediately and revalidate in the background when stale. Cold: probe now
// (concurrent callers share one in-flight probe). Returns [] only if a cold probe fails, so the
// endpoint can fall back to its config list.
export async function getSupportedModels(): Promise<AppModel[]> {
  if (modelCache) {
    if (Date.now() - modelCache.at >= MODEL_TTL_MS) void refreshModels().catch(() => {});
    return modelCache.models;
  }
  try { return await refreshModels(); } catch { return []; }
}

// Appended to the Claude Code system prompt for /app chats so Claude actually USES the chat UI's rich
// rendering (it otherwise defaults to terminal-style plain text). The UI renders these inline.
const APP_UI_SYSTEM_APPEND = [
  "You are replying inside a rich chat UI (not a terminal), so use its rendering:",
  "- Images/plots/screenshots you create render inline. Reference a file you wrote under the working",
  "  directory with markdown, e.g. ![chart](chart.png), and it shows in the chat. Prefer this over",
  "  describing an image or dumping base64.",
  "- Files you produce (CSV, PDF, zip, logs) render as download cards when you link them, e.g.",
  "  [results.csv](out/results.csv).",
  "- Fenced code blocks are syntax-highlighted with a copy button. A fenced ```html, ```svg, or",
  "  ```jsx/tsx/react block renders as a LIVE preview in a split-screen artifact panel, so when the",
  "  user asks for a webpage, diagram, chart, SVG, or a small interactive component, return it as one",
  "  of those fenced blocks rather than only describing it.",
  "Keep normal prose in plain markdown; only reach for an artifact when a live preview genuinely helps.",
].join("\n");
const VOICE_STRIP = /\s*<voice-mode>[\s\S]*?<\/voice-mode>\s*$/;
// #endregion

// When Claude loads a skill, its whole body is injected as a user message that starts with
// "Base directory for this skill: <path>/<name>". We render a small "loaded skill" card instead of
// the full text (which otherwise looks like the user pasted the entire skill file). Returns the
// skill's name, or null when the text isn't a skill load.
function skillLoadName(txt: string): string | null {
  if (!txt.startsWith("Base directory for this skill:")) return null;
  const m = /^Base directory for this skill:\s*(.+)$/m.exec(txt);
  if (!m) return null;
  const p = m[1].trim().replace(/[/\\]+$/, "");
  return p.split(/[/\\]/).pop() || p;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "tool_result" ? textOfContent(b.content) : ""))
      .join("");
  }
  return "";
}

// #region live conversation
// Fired when Claude asks a question and no client is streaming this conversation, so the
// owner can be pushed a PWA notification (see server.ts wiring). Kept as a plain callback so
// app-runner stays decoupled from the web-push machinery in server.ts.
export type AskNotifier = (info: { sessionId: string; question: string; multiSelect?: boolean; allowText?: boolean }) => void;

export interface ConvOpts {
  cwd: string;
  model?: string;
  resume?: string; // existing session id to reattach to
  notifier?: AskNotifier; // notify the owner about an unwatched ask_user prompt
  mcpFile?: string; // STATE_DIR/claude-app-mcp.json — persisted MCP servers to connect for this chat
  skills?: string[] | "all"; // which skills this chat may use (the SDK `skills` option); omit for CLI defaults
}

// Metadata for a still-open ask_user prompt, so a reconnecting client can re-render it.
export type PendingAsk = { askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean };

export class Conversation {
  id: string; // session id once known; a temp key beforehand
  cwd: string;
  model?: string;
  busy = false;
  lastActivity = Date.now();
  private resume?: string;
  private notifier?: AskNotifier;
  private mcpFile?: string;
  private skills?: string[] | "all";
  private askServer?: McpServerConfig; // the in-process ask_user SDK server, kept so a live
  // setMcpServers (which replaces ALL dynamic servers) can re-include it rather than drop it.
  private q?: Query;
  private queue: SDKUserMessage[] = [];
  private waiter?: (v: SDKUserMessage | null) => void;
  private closed = false;
  private subs = new Set<Sub>();
  private hooks = new Set<Sub>(); // internal lifecycle listeners (init/closed bookkeeping); do NOT count as client subscribers, or the idle reaper never fires
  private log: AppEvent[] = []; // replay buffer so a reconnecting client sees this live run
  private pendingAsks = new Map<string, (answer: string) => void>(); // ask_user awaiting a tap
  private pendingAskMeta = new Map<string, PendingAsk>(); // question/options for each open ask, so a reconnect can re-render it
  private askCounter = 0;
  private askToolUseIds = new Set<string>(); // tool_use ids of ask_user calls — their raw tool card/result are suppressed (the ask card replaces them)
  lastUsage?: TurnUsage; // most recent turn's real token usage (from the SDK result message)
  private cumModel = { out: 0, in: 0, cr: 0, cc: 0 }; // running modelUsage totals, to delta per run
  private runStart = 0; // index in `log` where the CURRENT turn began — new subscribers only
  // get this turn's events, not the whole multi-turn history (which the client already has
  // from the transcript). Otherwise reopening a live conversation replays every prior turn.
  private seqCounter = 0; // stable per-conversation sequence so a reconnect can dedupe
  private currentTurnText = ""; // text of the in-flight user turn — re-sent if the limit cuts it off
  private pendingRateLimit: { resumeAt: number; type?: string } | null = null; // set when a turn is rejected by the subscription limit
  private forkAt?: string;      // resumeSessionAt for the next (forked) run — the kept history's last entry
  private forkNext = false;     // one-shot: the next run() should fork the session (edit-and-rerun)
  private runGen = 0;           // bumped per run() so a superseded run's finally stays quiet
  private inited = false;       // an init event has been seen (the SDK session is live)

  constructor(id: string, opts: ConvOpts) {
    this.id = id;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.resume = opts.resume;
    this.notifier = opts.notifier;
    this.mcpFile = opts.mcpFile;
    this.skills = opts.skills;
  }

  // fromNow: subscribe to FUTURE events only (no buffer replay). Used when a client reopens a
  // live conversation and has already rebuilt the current turn from the transcript + pending
  // asks, so replaying the buffer would double-render it.
  subscribe(fn: Sub, fromNow = false): () => void {
    this.subs.add(fn);
    // Replay only the CURRENT turn (from the last turn boundary), so a client that reopens
    // an already-live conversation doesn't get every prior turn re-injected. The client has
    // the earlier turns from the transcript, and _seq dedupe covers mid-turn reconnects.
    const from = fromNow ? this.log.length : this.runStart;
    for (let i = from; i < this.log.length; i++) fn(this.log[i]);
    return () => this.subs.delete(fn);
  }

  // Resume after a dropped SSE socket: replay everything newer than the last event the client
  // actually received (its Last-Event-ID), then stay subscribed. Without this, a reconnect asks for
  // "future only" and every event emitted during the gap is lost for good — which is how a one-shot
  // event like the compaction card disappears while the streamed text around it looks fine. Safe to
  // over-deliver: the client drops anything whose _seq it has already seen.
  subscribeSince(fn: Sub, sinceSeq: number): () => void {
    this.subs.add(fn);
    for (const e of this.log) { const s = (e as any)._seq; if (typeof s === "number" && s > sinceSeq) fn(e); }
    return () => this.subs.delete(fn);
  }

  // Internal lifecycle listener (session-id registration, close bookkeeping). Unlike subscribe(),
  // these do NOT count toward hasSubscribers() — otherwise a permanent internal listener would pin
  // every conversation "watched" forever and the idle reaper would never collect its SDK subprocess.
  onEvent(fn: Sub): () => void {
    this.hooks.add(fn);
    return () => this.hooks.delete(fn);
  }

  // Open asks awaiting an answer — lets a reconnecting client re-render them with the correct
  // (server-assigned) askId so its answer actually unblocks the tool.
  listPendingAsks(): PendingAsk[] { return [...this.pendingAskMeta.values()]; }

  private emit(e: AppEvent) {
    (e as any)._seq = this.seqCounter++;
    this.lastActivity = Date.now(); // any output counts as activity: a long turn with no attached
    // client must not look idle to the sweeper (it only used to be bumped on send()).
    this.log.push(e);
    if (this.log.length > 5000) { const drop = this.log.length - 5000; this.log.splice(0, drop); this.runStart = Math.max(0, this.runStart - drop); }
    for (const s of this.subs) {
      try { s(e); } catch {}
    }
    for (const s of this.hooks) {
      try { s(e); } catch {}
    }
  }

  hasSubscribers(): boolean { return this.subs.size > 0; }
  // Monotonic "has anything happened" counter. The status coalescer polls it to decide whether a
  // conversation actually advanced since the last push, so a long-running turn that is quiet does not
  // spend a push (and a radio wake) every cycle just for being busy.
  get activitySeq(): number { return this.seqCounter; }
  // Live status for the conversation-list indicators: generating vs waiting on a tappable question.
  statusInfo(): { busy: boolean; waiting: boolean } { return { busy: this.busy && !this.closed, waiting: this.pendingAsks.size > 0 }; }

  send(text: string) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.busy = true;
    this.currentTurnText = text; // remember it so a subscription-limit rejection can re-run this turn
    // The user is actively driving this conversation, so any auto-resume we had queued for it is
    // no longer wanted (this counts as the "easy cancel" for the default-on behaviour).
    try { cancelResume(this.id); } catch { /* */ }
    this.runStart = this.log.length; // a new turn begins here (replay boundary for late subscribers)
    this.emit({ t: "user", text });
    this.emit({ t: "busy", busy: true });
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(msg); }
    else this.queue.push(msg);
  }

  async setModel(model: string) {
    this.model = model;
    if (this.q) { try { await this.q.setModel(model); } catch (e: any) { this.emit({ t: "error", message: "setModel: " + (e?.message || e) }); } }
  }

  async interrupt() { try { await (this.q as any)?.interrupt?.(); } catch {} }

  // Live status of every MCP server connected to this conversation (connected / failed /
  // needs-auth / pending / disabled), including the in-process ask_user server. Empty if not running.
  async mcpStatus(): Promise<McpServerStatus[]> {
    try { return (await this.q?.mcpServerStatus?.()) ?? []; } catch { return []; }
  }

  // Apply a new persisted MCP set to THIS already-running conversation without restarting it.
  // setMcpServers replaces the whole dynamic set, so we always re-include the ask_user server.
  // Returns which servers were added/removed and any connection errors (or null if not running).
  async applyMcpServers(stored: Record<string, McpServerConfig>) {
    if (!this.q?.setMcpServers) return null;
    const payload = { ...stored, ...(this.askServer ? { "app-ui": this.askServer } : {}) };
    try { return await this.q.setMcpServers(payload); }
    catch (e: any) { this.emit({ t: "error", message: "setMcpServers: " + (e?.message || e) }); return null; }
  }

  // Re-read skills from disk for this running conversation (after a skill file was created or
  // edited from the Settings panel). Returns the refreshed skill list, or null if not running.
  async reloadSkills() {
    if (!this.q?.reloadSkills) return null;
    try { return await this.q.reloadSkills(); }
    catch (e: any) { this.emit({ t: "error", message: "reloadSkills: " + (e?.message || e) }); return null; }
  }

  // Boot the SDK query for a conversation that isn't live yet (resume, no turn), so an edit-and-rerun
  // has a query to call rewindFiles on. Waits until the session reports init.
  async bootForRewind(): Promise<void> {
    if (this.q) return;
    this.closed = false;
    void this.run();
    await this.waitForInit();
  }

  private waitForInit(ms = 8000): Promise<void> {
    if (this.inited) return Promise.resolve();
    return new Promise<void>((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(to); off(); res(); };
      const to = setTimeout(finish, ms);
      const off = this.subscribe((e) => { if (e.t === "init") finish(); }, true);
    });
  }

  // Edit an earlier user turn and re-run from there. (1) Roll files back to that turn's checkpoint
  // (best-effort — only sessions that ran with checkpointing have one). (2) Fork the transcript so
  // the edited turn and everything after it are dropped, then run the edited text on the new forked
  // session. forkAtUuid = the kept history's last transcript entry (null when editing the very first
  // turn -> start a fresh session). rewindToUuid = the edited user message's uuid (files restore to
  // its pre-turn state). The forked session's new id arrives on the next init event, which re-keys
  // the map and rebinds the client automatically.
  async editTurn(forkAtUuid: string | null, rewindToUuid: string | null, text: string): Promise<RewindInfo> {
    let rewind: RewindInfo = {};
    if (rewindToUuid && this.q) {
      try {
        const r = await (this.q as any).rewindFiles?.(rewindToUuid);
        if (r) rewind = { canRewind: r.canRewind, error: r.error, filesChanged: r.filesChanged, insertions: r.insertions, deletions: r.deletions };
      } catch (e: any) { rewind = { canRewind: false, error: String(e?.message || e) }; }
    }
    const oldQ = this.q;
    this.queue = [];
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(null); } // release the old input generator
    if (forkAtUuid) { this.resume = this.id; this.forkAt = forkAtUuid; this.forkNext = true; }
    else { this.resume = undefined; this.forkAt = undefined; this.forkNext = false; } // editing the first turn -> fresh session
    this.closed = false;
    void this.run(text);                         // bumps runGen, starts the forked query, emits the edited user turn
    try { oldQ?.close(); } catch { /* the old run's finally is superseded (older gen) -> stays silent */ }
    return rewind;
  }

  // The user tapped an option (or dismissed) for an ask_user prompt.
  answerAsk(askId: string, answer: string): boolean {
    const resolve = this.pendingAsks.get(askId);
    if (!resolve) return false;
    this.pendingAsks.delete(askId);
    this.pendingAskMeta.delete(askId);
    this.emit({ t: "ask_done", askId, answer });
    resolve(answer);
    return true;
  }

  // In-process MCP server exposing an `ask_user` tool so Claude can ask with tappable options.
  // The handler emits an `ask` event to the client and blocks until answerAsk() resolves it.
  private makeAskServer() {
    return createSdkMcpServer({
      name: "app-ui",
      tools: [
        tool(
          "ask_user",
          "Ask the user a question and let them answer in the UI. PREFER this over asking in plain prose whenever you are offering a choice between a small set of options (yes/no, pick one of N, which approach, etc.). By default the user picks ONE tappable option; set multiSelect to let them choose several, and/or allowText to let them type a free-text answer (options may be omitted for a pure free-text prompt). Returns the user's answer as text.",
          {
            question: z.string().describe("The question to ask the user"),
            options: z.array(z.object({ label: z.string().describe("Short option label the user taps"), description: z.string().optional().describe("Optional one-line clarification") })).max(6).optional().describe("Up to 6 tappable options. Required unless allowText is true (a pure free-text prompt)."),
            multiSelect: z.boolean().optional().describe("Let the user select multiple options, then submit. The answer comes back as the chosen labels, comma-separated."),
            allowText: z.boolean().optional().describe("Show a free-text field so the user can type an answer instead of, or in addition to, tapping an option."),
          },
          async (args: { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean }) => {
            if (this.closed) return { content: [{ type: "text" as const, text: "(conversation closed)" }] };
            const options = args.options ?? [];
            if (!options.length && !args.allowText) return { content: [{ type: "text" as const, text: "(ask_user needs at least one option, or allowText: true)" }] };
            const askId = `${this.id}-ask-${this.askCounter++}`;
            const meta: PendingAsk = { askId, question: args.question, options, multiSelect: args.multiSelect, allowText: args.allowText };
            const answer = await new Promise<string>((resolve) => {
              this.pendingAsks.set(askId, resolve);
              this.pendingAskMeta.set(askId, meta);
              this.emit({ t: "ask", askId, question: args.question, options, multiSelect: args.multiSelect, allowText: args.allowText });
              // No one is streaming this conversation -> ping the owner so the turn doesn't hang unseen.
              if (!this.hasSubscribers()) { try { this.notifier?.({ sessionId: this.id, question: args.question, multiSelect: args.multiSelect, allowText: args.allowText }); } catch {} }
            });
            return { content: [{ type: "text" as const, text: answer }] };
          },
        ),
      ],
    });
  }

  // Live context-window usage (for the pie + compaction hint). Null if the SDK build lacks the
  // control method or the query isn't running yet.
  async contextUsage(): Promise<any | null> {
    try { return this.q ? await (this.q as any).getContextUsage() : null; } catch { return null; }
  }

  // Trigger a manual compaction. The CLI treats a "/compact" prompt as the compact command; the
  // resulting compact_boundary streams back as a normal compact event.
  compact() {
    if (this.closed) return;
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null } as any;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(msg); } else this.queue.push(msg);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(null); }
    for (const [, resolve] of this.pendingAsks) resolve("(the user did not answer)"); // unblock any pending ask
    this.pendingAsks.clear();
    this.pendingAskMeta.clear();
    try { this.q?.close(); } catch {}
    this.emit({ t: "closed" });
  }

  private async *inputGen(first?: string): AsyncGenerator<SDKUserMessage> {
    if (first !== undefined) {
      this.busy = true;
      this.currentTurnText = first; // re-sent if the subscription limit cuts this opening turn off
      this.runStart = this.log.length; // first turn's replay boundary
      this.emit({ t: "user", text: first });
      this.emit({ t: "busy", busy: true });
      yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
    }
    while (!this.closed) {
      const next = this.queue.shift() ?? (await new Promise<SDKUserMessage | null>((res) => { this.waiter = res; }));
      if (next === null || this.closed) return;
      yield next;
    }
  }

  // Start the SDK query. `first` is the opening user turn for a brand-new chat;
  // omit it when resuming (the client sends the next turn via send()).
  async run(first?: string) {
    // A refork tears down the current query and starts a fresh one; each run() gets a generation
    // token so the OLD run's finally (fired when its query ends) knows it was superseded and stays
    // quiet — otherwise it would emit a spurious closed/busy:false that drops the client's stream.
    const myGen = ++this.runGen;
    // Fork options for an edit-and-rerun: resume the current session but truncate at forkAt (drop
    // the edited turn + everything after) into a new forked session. One-shot: cleared after use.
    const forkOpts = this.forkNext ? { ...(this.forkAt ? { resumeSessionAt: this.forkAt } : {}), forkSession: true } : {};
    this.forkNext = false; this.forkAt = undefined;
    this.askServer = this.makeAskServer(); // cache so a live setMcpServers can re-include it
    // Persisted MCP servers (managed from the Settings panel) connect alongside the always-present
    // in-process ask_user server. A missing/empty file just yields {}.
    let stored: Record<string, McpServerConfig> = {};
    if (this.mcpFile) { try { stored = await mcpServersForQuery(this.mcpFile); } catch {} }
    this.q = query({
      prompt: this.inputGen(first),
      options: {
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.resume ? { resume: this.resume } : {}),
        ...forkOpts,
        ...(this.skills ? { skills: this.skills } : {}), // which skills this chat may use
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true, // stream text + thinking tokens live
        thinking: { type: "adaptive" }, // let Claude think; we render it streaming
        autoCompactEnabled: true, // compact automatically before the context window fills (default, set explicit)
        enableFileCheckpointing: true, // back up files before edits so an edit-and-rerun can roll them back (Query.rewindFiles)
        systemPrompt: { type: "preset", preset: "claude_code", append: APP_UI_SYSTEM_APPEND }, // keep Claude Code's prompt + teach it the chat UI's inline images/artifacts
        mcpServers: { ...stored, "app-ui": this.askServer }, // ask_user + any managed MCP servers
      },
    });
    try {
      for await (const m of this.q) this.handle(m);
    } catch (e: any) {
      if (myGen === this.runGen) { tlog("error", { conv: this.id, msg: JSON.stringify(String(e?.message || e).slice(0, 200)) }); this.emit({ t: "error", message: String(e?.message || e) }); }
      this.armRateLimitedResume(); // backstop: the query threw while rate-limited -> still auto-resume
    } finally {
      // Superseded by a refork -> stay silent; the new run owns the stream now.
      if (myGen === this.runGen) {
        this.busy = false;
        tlog("closed", { conv: this.id, listeners: this.subs.size });
        this.emit({ t: "busy", busy: false });
        this.emit({ t: "closed" });
      }
    }
  }

  // Reset time (unix ms) for a rate-limit rejection: prefer the event's own resetsAt (epoch s or
  // ms), else fall back to the cached subscription snapshot's matching window.
  private resetAtFrom(info: any): number | null {
    const raw = info?.resetsAt;
    if (typeof raw === "number" && isFinite(raw) && raw > 0) return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
    const snap = getSubscriptionUsage();
    const iso = String(info?.rateLimitType || "").startsWith("seven_day") ? snap?.sevenDay?.resetsAt : snap?.fiveHour?.resetsAt;
    const t = iso ? Date.parse(iso) : NaN;
    return isFinite(t) ? t : null;
  }

  // If the turn just ended was rejected by the subscription limit, queue it to auto-resume at reset.
  private armRateLimitedResume(): void {
    const rl = this.pendingRateLimit;
    this.pendingRateLimit = null;
    if (!rl || !this.currentTurnText || !this.id) return;
    try {
      armResume({ convId: this.id, text: this.currentTurnText, resumeAt: rl.resumeAt, rateLimitType: rl.type, createdAt: Date.now() });
      const when = new Date(rl.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.emit({ t: "notice", kind: "info", text: `Subscription limit reached — this turn will auto-resume around ${when} when the limit resets.` });
    } catch { /* */ }
  }

  private handle(m: SDKMessage) {
    const anyM = m as any;
    if (anyM.session_id && anyM.session_id !== this.id) this.id = anyM.session_id;
    switch (m.type) {
      case "system":
        if (anyM.subtype === "init") { this.inited = true; this.emit({ t: "init", sessionId: anyM.session_id || this.id, model: anyM.model, cwd: anyM.cwd }); }
        else if (anyM.subtype === "compact_boundary") {
          const md = compactMeta(anyM);
          this.emit({ t: "compacting", active: false });
          this.emit({ t: "compact", trigger: md.trigger, preTokens: md.preTokens, postTokens: md.postTokens, durationMs: md.durationMs });
          // The one line that says a compaction actually reached the clients: without it a missing
          // "Compacted" card can't be told apart from a compaction that never emitted a boundary.
          tlog("compact", { conv: this.id, trigger: md.trigger, pre: md.preTokens, post: md.postTokens, ms: md.durationMs, listeners: this.subs.size });
        }
        // This SDK build reports compaction progress via a status message (compacting -> null with a
        // compact_result), THEN the compact_boundary above. Drive the banner from it so auto-compaction
        // shows progress too, and surface a failed compaction instead of a silently stuck banner.
        else if (anyM.subtype === "status" && (anyM.status === "compacting" || anyM.compact_result)) {
          if (anyM.status === "compacting") this.emit({ t: "compacting", active: true });
          else if (anyM.compact_result === "failed") { this.emit({ t: "compacting", active: false }); this.emit({ t: "notice", kind: "info", text: "Compaction failed: " + (anyM.compact_error || "unknown") }); }
        }
        // Background subagent activity + cross-session messages, surfaced inline so the thread
        // shows work spun off to other agents (Claude Code's task/notification stream).
        else if (anyM.subtype === "task_progress" && anyM.tool_use_id) {
          const u = anyM.usage || {};
          this.emit({ t: "agent_progress", id: String(anyM.tool_use_id), tokens: u.total_tokens, toolUses: u.tool_uses, durationMs: u.duration_ms, lastTool: anyM.last_tool_name, subagentType: anyM.subagent_type, description: anyM.description });
        }
        else if (anyM.subtype === "task_started") this.emit({ t: "notice", kind: "task", text: String(anyM.description || "background task"), status: "started" });
        else if (anyM.subtype === "task_notification") {
          const extra = anyM.usage ? ` (${anyM.usage.total_tokens || 0} tokens, ${anyM.usage.tool_uses || 0} tools)` : "";
          this.emit({ t: "notice", kind: "task", text: String(anyM.summary || "background task") + extra, status: String(anyM.status || "done") });
        }
        else if (anyM.subtype === "notification") {
          const isPeer = anyM.triggeredBy === "peer-send-message" || anyM.provenance === "peer-send-message";
          this.emit({ t: "notice", kind: isPeer ? "peer" : "info", text: String(anyM.text || ""), from: anyM.from || anyM.sender });
        }
        break;
      case "stream_event": {
        // live token streaming (includePartialMessages): text + thinking deltas
        const ev = anyM.event;
        // A tool_use block opening = the text just before it was narration, not the final answer.
        if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          this.emit({ t: "tool_start", id: ev.content_block.id, name: ev.content_block.name });
        }
        if (ev?.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "text_delta" && d.text) this.emit({ t: "text_delta", text: d.text });
          else if (d?.type === "thinking_delta") {
            // subscription auth redacts the thinking text (d.thinking === ""); we still get
            // estimated_tokens progress, so surface a live "thinking" indicator either way.
            if (d.thinking) this.emit({ t: "thinking_delta", text: d.thinking });
            else this.emit({ t: "thinking_progress", tokens: d.estimated_tokens || 0 });
          }
        }
        break;
      }
      case "assistant": {
        // text + thinking are streamed above via stream_event; from the aggregated
        // message we only need tool_use (its input is complete here).
        const blocks = (anyM.message?.content as any[]) || [];
        for (const b of blocks) {
          if (b?.type !== "tool_use") continue;
          if (b.name === "mcp__app-ui__ask_user") { this.askToolUseIds.add(b.id); continue; } // the ask card renders this, not a raw tool card
          this.emit({ t: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        break;
      }
      case "user": {
        // tool_result blocks come back as a user message
        const c = anyM.message?.content;
        if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_result") { if (this.askToolUseIds.has(b.tool_use_id)) continue; this.emit({ t: "tool_result", id: b.tool_use_id, content: b.content, isError: !!b.is_error }); }
        // A loaded skill is injected as a user text message ("Base directory for this skill: ...");
        // surface it as a compact card instead of dumping the whole skill file into the thread.
        const sk = skillLoadName(textOfContent(c));
        if (sk) this.emit({ t: "notice", kind: "skill", text: sk });
        break;
      }
      // claude.ai subscription rate-limit signal. A 'rejected' status means this turn was blocked
      // because the shared 5h/7d limit is exhausted; remember it so the turn auto-resumes at reset.
      case "rate_limit_event": {
        const info = anyM.rate_limit_info || {};
        if (info.status === "rejected") {
          const resumeAt = this.resetAtFrom(info);
          if (resumeAt) this.pendingRateLimit = { resumeAt, type: info.rateLimitType };
        }
        break;
      }
      case "result": {
        this.busy = false;
        tlog("done", { conv: this.id, subtype: anyM.subtype, ms: anyM.duration_ms || 0, listeners: this.subs.size });
        this.armRateLimitedResume(); // if this turn was rejected by the limit, queue an auto-resume
        const u = anyM.usage || {};
        const input = u.input_tokens || 0;
        const cacheCreate = u.cache_creation_input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0;
        const thinking = u.output_tokens_details?.thinking_tokens || 0; // exact reasoning tokens (subset of output)
        const context = input + cacheCreate + cacheRead; // tokens read to answer (mostly cached history)
        // Output SINCE THE LAST IDLE across every model (main loop + subagents), via the cumulative
        // modelUsage delta — so a run with tool/subagent work isn't undercounted by the main-loop-only
        // usage field. Falls back to the per-turn output when modelUsage is absent.
        const mu = anyM.modelUsage || {};
        let cOut = 0, cIn = 0, cCr = 0, cCc = 0;
        for (const k in mu) { const v = mu[k] || {}; cOut += v.outputTokens || 0; cIn += v.inputTokens || 0; cCr += v.cacheReadInputTokens || 0; cCc += v.cacheCreationInputTokens || 0; }
        const output = Object.keys(mu).length ? Math.max(0, cOut - this.cumModel.out) : (u.output_tokens || 0);
        this.cumModel = { out: cOut, in: cIn, cr: cCr, cc: cCc };
        const usage: TurnUsage = { input, output, thinking, cacheCreate, cacheRead, context, total: context + output, costUsd: anyM.total_cost_usd || 0, durationMs: anyM.duration_ms || 0 };
        this.lastUsage = usage;
        this.emit({ t: "result", subtype: anyM.subtype, sessionId: anyM.session_id || this.id, costUsd: usage.costUsd, usage });
        this.emit({ t: "busy", busy: false });
        break;
      }
    }
  }
}
// #endregion

// #region registry (one Conversation per session id / new-chat key)
const conversations = new Map<string, Conversation>();
let tmpCounter = 0;

// Open (or reattach to) a conversation. For a brand-new chat pass resume=undefined and
// a `first` turn to run(); we return the temp key immediately and the real session id
// arrives on the init event. For an existing chat pass its session id as both key+resume.
export function getOrCreate(key: string | null, opts: ConvOpts): Conversation {
  if (key && conversations.has(key)) {
    const c = conversations.get(key)!;
    c.lastActivity = Date.now();
    return c;
  }
  const id = key || `new-${Date.now().toString(36)}-${tmpCounter++}`;
  const c = new Conversation(id, opts);
  conversations.set(id, c);
  // once the SDK assigns a real session id, register the conversation under it too
  const unsub = c.onEvent((e) => {
    if (e.t === "init" && e.sessionId && !conversations.has(e.sessionId)) conversations.set(e.sessionId, c);
    if (e.t === "closed") setTimeout(() => reapIfIdle(c), 60_000);
  });
  void unsub;
  return c;
}

export function get(key: string): Conversation | undefined { return conversations.get(key); }

// A conversation can also be driven from a TERMINAL tab by the CLI, which this process knows nothing
// about — it only tracks its own /app conversations. Those CLI sessions publish their own state to
// ~/.claude/sessions/<pid>.json ({sessionId, status:"busy"|"idle", entrypoint}), and without reading it
// the sidebar had no idea they were working: a tmux session churning through tool calls advanced its
// transcript mtime, fell through to the unread test, and showed an unread dot instead of "thinking".
// (Measured: three busy worktree tabs reported status "busy" here while /app reported nothing at all
// for two of them and busy=false for the third.)
export type LiveStatus = { busy: boolean; waiting: boolean; terminal?: boolean };
const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
let sessCache: { at: number; map: Record<string, LiveStatus> } = { at: 0, map: {} };
function cliSessionStatuses(): Record<string, LiveStatus> {
  // The client polls every 4s; a 2s cache keeps that to one directory scan per poll at most.
  if (Date.now() - sessCache.at < 2000) return sessCache.map;
  const map: Record<string, LiveStatus> = {};
  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      let o: any;
      try { o = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8")); } catch { continue }
      const sid = typeof o?.sessionId === "string" ? o.sessionId : null;
      if (!sid || !o.pid) continue;
      // A crashed session leaves its last state on disk forever, so only trust a live pid.
      if (!existsSync(`/proc/${o.pid}`)) continue;
      const busy = o.status === "busy" || o.status === "thinking";
      // `waiting` from this registry is DELIBERATELY IGNORED. The hook writes it on a notification
      // and nothing reliably clears it, so it goes stale: a tab was reported waiting for 34 minutes
      // with nothing actually waiting, which is a worse signal than none — it sends you to a
      // terminal to answer a question that is not there. Only `busy` is trusted, and `terminal`
      // marks the row as terminal-driven so the UI can colour it as such.
      const prev = map[sid];
      map[sid] = { busy: busy || !!prev?.busy, waiting: false, terminal: true };
    }
  } catch { /* no registry on this box */ }
  sessCache = { at: Date.now(), map };
  return map;
}

// Live status for every in-memory conversation, keyed by session id (for the list indicators),
// merged with the CLI session registry so terminal-driven conversations are not reported idle.
export function liveStatuses(): Record<string, LiveStatus> {
  const out: Record<string, LiveStatus> = { ...cliSessionStatuses() };
  for (const c of new Set(conversations.values())) {
    const mine = c.statusInfo();
    const cli = out[c.id];
    // OR them: this process is authoritative for its own turn, but a CLI tab on the same session id
    // can be mid-tool while we have nothing running.
    out[c.id] = { busy: mine.busy || !!cli?.busy, waiting: mine.waiting, terminal: !!cli?.terminal };
  }
  return out;
}

// Same set as liveStatuses, plus the activity counter, for the status-push coalescer. Kept separate
// so the existing /app/api/statuses shape (consumed by the client list indicators) does not change.
export function liveActivity(): { id: string; busy: boolean; waiting: boolean; activitySeq: number }[] {
  const out: { id: string; busy: boolean; waiting: boolean; activitySeq: number }[] = [];
  for (const c of new Set(conversations.values())) {
    const s = c.statusInfo();
    out.push({ id: c.id, busy: s.busy, waiting: s.waiting, activitySeq: c.activitySeq });
  }
  return out;
}

function reapIfIdle(c: Conversation) {
  if (c.hasSubscribers()) return;
  for (const [k, v] of conversations) if (v === c) conversations.delete(k);
}

// Idle sweeper: close conversations no client has watched for a while.
setInterval(() => {
  const now = Date.now();
  for (const c of new Set(conversations.values())) {
    // Never collect a conversation that is still working, or one parked on an unanswered question:
    // close() kills the SDK query and answers pending asks with "(the user did not answer)", which
    // would throw away a real turn just because the phone dropped its stream.
    const s = c.statusInfo();
    if (s.busy || s.waiting) continue;
    if (!c.hasSubscribers() && now - c.lastActivity > 30 * 60_000) c.close();
  }
}, 5 * 60_000);
// #endregion

// #region historical transcript -> the same AppEvent stream (for opening a past chat)
// Parses a session .jsonl into the normalized events the front-end already renders.
export async function replayTranscript(path: string): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  const askToolIds = new Set<string>(); // tool_use ids of ask_user calls -> render as ask cards, not raw tool cards
  // Per-turn accumulators so the reloaded footer matches the live one: a turn can span several
  // assistant API responses (text -> tool -> text -> ...), each with its own usage. The live path
  // reports the run-total (modelUsage delta); on replay we sum output/thinking across the turn and
  // take context from the last response. Reset at each user/compact boundary. turnStartTs powers a
  // real "Worked for" from transcript timestamps (live has duration_ms; replay doesn't).
  let turnOut = 0, turnThink = 0, turnStartTs = 0;
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (o.type === "user" && msg) {
      // The compaction summary is a synthesized user message (isCompactSummary) carrying the whole
      // "This session is being continued…" recap. It's context, not a turn to show: the
      // compact_boundary below already renders the "Compacted" divider card, so skip the summary.
      if (o.isCompactSummary) continue;
      const c = msg.content;
      if (Array.isArray(c)) {
        const toolResults = c.filter((b: any) => b?.type === "tool_result");
        if (toolResults.length) {
          for (const b of toolResults) {
            if (askToolIds.has(b.tool_use_id)) out.push({ t: "ask_done", askId: b.tool_use_id, answer: textOfContent(b.content) }); // the answer to an ask_user
            else out.push({ t: "tool_result", id: b.tool_use_id, content: b.content, isError: !!b.is_error });
          }
          continue;
        }
      }
      const txt = textOfContent(c).replace(VOICE_STRIP, ""); // hide the appended voice-mode directive
      const sk = skillLoadName(txt);
      if (sk) out.push({ t: "notice", kind: "skill", text: sk }); // loaded skill -> compact card, not the raw file
      else if (txt.trim() && !txt.startsWith("<")) {
        // New user turn -> reset the per-turn token/duration accumulators.
        turnOut = 0; turnThink = 0; turnStartTs = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
        out.push({ t: "user", text: txt });
      }
    } else if (o.type === "assistant" && msg) {
      const blocks = (msg.content as any[]) || [];
      for (const b of blocks) {
        if (b?.type === "text") out.push({ t: "text", text: b.text });
        else if (b?.type === "thinking") out.push({ t: "thinking", text: b.thinking || "" });
        else if (b?.type === "tool_use" && b.name === "mcp__app-ui__ask_user") {
          // reconstruct the ask card from the tool input (askId = tool_use id); a matching
          // tool_result later becomes its ask_done. Avoids a raw, resultless tool card.
          const inp: any = b.input || {};
          askToolIds.add(b.id);
          out.push({ t: "ask", askId: b.id, question: String(inp.question || ""), options: Array.isArray(inp.options) ? inp.options : [], multiSelect: !!inp.multiSelect, allowText: !!inp.allowText });
        } else if (b?.type === "tool_use") out.push({ t: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      // Stamp the turn's token usage from the transcript so historical turns show the same footer as
      // live ones (last usage before the next user turn wins, i.e. the turn total).
      const u = msg.usage;
      if (u && (u.output_tokens || u.input_tokens)) {
        const input = u.input_tokens || 0;
        const cacheCreate = u.cache_creation_input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0;
        turnOut += u.output_tokens || 0; // run-total output since this turn's user message
        turnThink += u.output_tokens_details?.thinking_tokens || 0;
        const context = input + cacheCreate + cacheRead; // last response of the turn wins -> full context read
        const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
        const durationMs = turnStartTs && ts > turnStartTs ? ts - turnStartTs : 0;
        // output/thinking = cumulative turn totals so the footer matches what was shown live.
        out.push({ t: "result", subtype: "success", sessionId: "", costUsd: 0, usage: { input, output: turnOut, thinking: turnThink, cacheCreate, cacheRead, context, total: context + turnOut, costUsd: 0, durationMs } });
      }
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      turnOut = 0; turnThink = 0; turnStartTs = 0; // compaction is a fresh turn boundary
      const md = compactMeta(o); // transcript spells it compactMetadata/camelCase, the live SDK compact_metadata/snake_case
      out.push({ t: "compact", trigger: md.trigger, preTokens: md.preTokens, postTokens: md.postTokens, durationMs: md.durationMs });
    }
  }
  return out;
}

// Resolve the fork points for editing the user turn at ordinal `userIndex` (0-based, counting only
// real user prompts — the same turns the UI renders as `user` bubbles). Returns the edited turn's
// transcript uuid (rewindTo, for the file rollback), the uuid of the kept history's last chain entry
// (forkAt, for resumeSessionAt — null when editing the first turn), and the original prompt text (so
// the caller can guard against a stale index). Mirrors replayTranscript's notion of a "user turn".
export async function resolveEditPoints(path: string, userIndex: number): Promise<{ rewindToUuid: string; forkAtUuid: string | null; promptText: string } | null> {
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return null; }
  const entries: { uuid: string; isPrompt: boolean; isSidechain: boolean; text: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.uuid) continue;
    const isSidechain = !!o.isSidechain;
    let isPrompt = false, ptext = "";
    if (o.type === "user" && o.message && !o.isCompactSummary && !isSidechain) {
      const c = o.message.content;
      const hasToolResult = Array.isArray(c) && c.some((b: any) => b?.type === "tool_result");
      if (!hasToolResult) {
        const t = textOfContent(c).replace(VOICE_STRIP, "");
        if (t.trim() && !t.startsWith("<") && !skillLoadName(t)) { isPrompt = true; ptext = t; }
      }
    }
    entries.push({ uuid: o.uuid, isPrompt, isSidechain, text: ptext });
  }
  const prompts = entries.filter((e) => e.isPrompt);
  const target = prompts[userIndex];
  if (!target) return null;
  const pos = entries.indexOf(target);
  // Fork at the last MAIN-chain (non-sidechain) entry before the edited turn: that's the kept
  // history's tail. Subagent (sidechain) entries aren't valid main-chain fork points.
  let forkAtUuid: string | null = null;
  for (let i = pos - 1; i >= 0; i--) { if (!entries[i].isSidechain) { forkAtUuid = entries[i].uuid; break; } }
  return { rewindToUuid: target.uuid, forkAtUuid, promptText: target.text };
}
// #endregion

// #region subscription usage (claude.ai subscription rate-limit windows — the data behind `/usage`)
// A single long-lived control query, opened lazily, purely to call the SDK usage API. It never
// sends a turn (no tokens spent) and runs in a /tmp cwd whose `-tmp-*` project the conversation
// list already excludes, so it never pollutes the sidebar. getSubscriptionUsage() is non-blocking:
// it returns the cached snapshot immediately and refreshes it in the background when stale.
export interface SubscriptionWindow { utilization: number | null; resetsAt: string | null }
export interface SubscriptionUsage { available: boolean; subscription: string | null; fiveHour: SubscriptionWindow | null; sevenDay: SubscriptionWindow | null; fetchedAt: number }

const SUB_CWD = "/tmp/ct-usage"; // -tmp-ct-usage project -> excluded from the conversation list
const SUB_TTL = 90_000; // a rate-limit window moves slowly; 90s is plenty fresh
let ctrlQuery: any = null;
let ctrlReady: Promise<void> | null = null;
let subCache: SubscriptionUsage | null = null;
let subRefreshing = false;

function startControlQuery() {
  try { mkdirSync(SUB_CWD, { recursive: true }); } catch { /* */ }
  let release = () => {};
  const gen = (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise<void>((r) => { release = r; }); })();
  const q: any = query({ prompt: gen, options: { cwd: SUB_CWD, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } });
  ctrlQuery = q;
  ctrlReady = new Promise<void>((resolve) => {
    (async () => {
      try { for await (const m of q) { if ((m as any)?.type === "system" && (m as any)?.subtype === "init") resolve(); } }
      catch { /* control query died */ }
      finally { if (ctrlQuery === q) { ctrlQuery = null; ctrlReady = null; } release(); resolve(); }
    })();
  });
}

async function refreshSubscriptionUsage(): Promise<void> {
  if (subRefreshing) return;
  subRefreshing = true;
  try {
    if (!ctrlQuery) startControlQuery();
    await Promise.race([ctrlReady, new Promise((r) => setTimeout(r, 8000))]);
    if (!ctrlQuery) return;
    const u: any = await ctrlQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const rl = u?.rate_limits || {};
    const win = (w: any): SubscriptionWindow | null => (w ? { utilization: typeof w.utilization === "number" ? w.utilization : null, resetsAt: w.resets_at || null } : null);
    subCache = { available: !!u?.rate_limits_available, subscription: u?.subscription_type || null, fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), fetchedAt: Date.now() };
  } catch { /* keep the last snapshot */ }
  finally { subRefreshing = false; }
}

// Non-blocking: returns whatever we have now and kicks a background refresh when the snapshot is
// missing or stale. The first-ever call returns null; the value lands on a subsequent poll.
export function getSubscriptionUsage(): SubscriptionUsage | null {
  if (!subCache || Date.now() - subCache.fetchedAt > SUB_TTL) void refreshSubscriptionUsage();
  return subCache;
}
// #endregion
