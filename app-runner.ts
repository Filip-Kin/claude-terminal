// app-runner.ts
// Drives Claude Code headlessly via the Claude Agent SDK for the chat-app front-end.
// One live Conversation (an open SDK `query()` in streaming-input mode) per open chat.
// The SDK writes to the same ~/.claude/projects/<enc-cwd>/<session-id>.jsonl store the
// interactive CLI uses, so an app conversation resumes in a terminal tab and vice versa.
//
// Auth: inherits the box's Claude login (claude.ai subscription, apiKeySource "none") —
// no ANTHROPIC_API_KEY needed. Verified live 2026-08-26.

import { query, createSdkMcpServer, tool, type SDKMessage, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// #region normalized events (one shape for live SDK output AND replayed .jsonl history)
export type AppEvent =
  | { t: "init"; sessionId: string; model: string; cwd: string }
  | { t: "text"; text: string }
  | { t: "text_delta"; text: string } // streamed token (includePartialMessages)
  | { t: "thinking"; text: string }
  | { t: "thinking_delta"; text: string } // streamed thinking token (when content is exposed)
  | { t: "thinking_progress"; tokens: number } // thinking is happening but text is redacted (subscription auth): show progress
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; content: unknown; isError: boolean }
  | { t: "compact"; trigger: "manual" | "auto" }
  | { t: "ask"; askId: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; allowText?: boolean } // Claude asks with tappable options (optionally multi-select / free-text)
  | { t: "ask_done"; askId: string; answer: string } // an ask was answered (or cancelled)
  | { t: "user"; text: string } // an echoed user turn (used by history replay)
  | { t: "result"; subtype: string; sessionId: string; costUsd: number }
  | { t: "busy"; busy: boolean }
  | { t: "error"; message: string }
  | { t: "closed" };

type Sub = (e: AppEvent) => void;
// #endregion

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
  private q?: Query;
  private queue: SDKUserMessage[] = [];
  private waiter?: (v: SDKUserMessage | null) => void;
  private closed = false;
  private subs = new Set<Sub>();
  private log: AppEvent[] = []; // replay buffer so a reconnecting client sees this live run
  private pendingAsks = new Map<string, (answer: string) => void>(); // ask_user awaiting a tap
  private pendingAskMeta = new Map<string, PendingAsk>(); // question/options for each open ask, so a reconnect can re-render it
  private askCounter = 0;
  private askToolUseIds = new Set<string>(); // tool_use ids of ask_user calls — their raw tool card/result are suppressed (the ask card replaces them)
  private runStart = 0; // index in `log` where the CURRENT turn began — new subscribers only
  // get this turn's events, not the whole multi-turn history (which the client already has
  // from the transcript). Otherwise reopening a live conversation replays every prior turn.
  private seqCounter = 0; // stable per-conversation sequence so a reconnect can dedupe

  constructor(id: string, opts: ConvOpts) {
    this.id = id;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.resume = opts.resume;
    this.notifier = opts.notifier;
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

  // Open asks awaiting an answer — lets a reconnecting client re-render them with the correct
  // (server-assigned) askId so its answer actually unblocks the tool.
  listPendingAsks(): PendingAsk[] { return [...this.pendingAskMeta.values()]; }

  private emit(e: AppEvent) {
    (e as any)._seq = this.seqCounter++;
    this.log.push(e);
    if (this.log.length > 5000) { const drop = this.log.length - 5000; this.log.splice(0, drop); this.runStart = Math.max(0, this.runStart - drop); }
    for (const s of this.subs) {
      try { s(e); } catch {}
    }
  }

  hasSubscribers(): boolean { return this.subs.size > 0; }

  send(text: string) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.busy = true;
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
    this.q = query({
      prompt: this.inputGen(first),
      options: {
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.resume ? { resume: this.resume } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true, // stream text + thinking tokens live
        thinking: { type: "adaptive" }, // let Claude think; we render it streaming
        mcpServers: { "app-ui": this.makeAskServer() }, // ask_user tool -> tappable options in the UI
      },
    });
    try {
      for await (const m of this.q) this.handle(m);
    } catch (e: any) {
      this.emit({ t: "error", message: String(e?.message || e) });
    } finally {
      this.busy = false;
      this.emit({ t: "busy", busy: false });
      this.emit({ t: "closed" });
    }
  }

  private handle(m: SDKMessage) {
    const anyM = m as any;
    if (anyM.session_id && anyM.session_id !== this.id) this.id = anyM.session_id;
    switch (m.type) {
      case "system":
        if (anyM.subtype === "init") this.emit({ t: "init", sessionId: anyM.session_id || this.id, model: anyM.model, cwd: anyM.cwd });
        else if (anyM.subtype === "compact_boundary") this.emit({ t: "compact", trigger: anyM.compact_metadata?.trigger || "auto" });
        break;
      case "stream_event": {
        // live token streaming (includePartialMessages): text + thinking deltas
        const ev = anyM.event;
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
        break;
      }
      case "result":
        this.busy = false;
        this.emit({ t: "result", subtype: anyM.subtype, sessionId: anyM.session_id || this.id, costUsd: anyM.total_cost_usd || 0 });
        this.emit({ t: "busy", busy: false });
        break;
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
  const unsub = c.subscribe((e) => {
    if (e.t === "init" && e.sessionId && !conversations.has(e.sessionId)) conversations.set(e.sessionId, c);
    if (e.t === "closed") setTimeout(() => reapIfIdle(c), 60_000);
  });
  void unsub;
  return c;
}

export function get(key: string): Conversation | undefined { return conversations.get(key); }

function reapIfIdle(c: Conversation) {
  if (c.hasSubscribers()) return;
  for (const [k, v] of conversations) if (v === c) conversations.delete(k);
}

// Idle sweeper: close conversations no client has watched for a while.
setInterval(() => {
  const now = Date.now();
  for (const c of new Set(conversations.values())) {
    if (!c.hasSubscribers() && now - c.lastActivity > 30 * 60_000) c.close();
  }
}, 5 * 60_000);
// #endregion

// #region historical transcript -> the same AppEvent stream (for opening a past chat)
// Parses a session .jsonl into the normalized events the front-end already renders.
export async function replayTranscript(path: string): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  const askToolIds = new Set<string>(); // tool_use ids of ask_user calls -> render as ask cards, not raw tool cards
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (o.type === "user" && msg) {
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
      const txt = textOfContent(c);
      if (txt.trim() && !txt.startsWith("<")) out.push({ t: "user", text: txt });
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
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      out.push({ t: "compact", trigger: o.compact_metadata?.trigger || "auto" });
    }
  }
  return out;
}
// #endregion
