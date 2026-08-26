// app-runner.ts
// Drives Claude Code headlessly via the Claude Agent SDK for the chat-app front-end.
// One live Conversation (an open SDK `query()` in streaming-input mode) per open chat.
// The SDK writes to the same ~/.claude/projects/<enc-cwd>/<session-id>.jsonl store the
// interactive CLI uses, so an app conversation resumes in a terminal tab and vice versa.
//
// Auth: inherits the box's Claude login (claude.ai subscription, apiKeySource "none") —
// no ANTHROPIC_API_KEY needed. Verified live 2026-08-26.

import { query, type SDKMessage, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";

// #region normalized events (one shape for live SDK output AND replayed .jsonl history)
export type AppEvent =
  | { t: "init"; sessionId: string; model: string; cwd: string }
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; content: unknown; isError: boolean }
  | { t: "compact"; trigger: "manual" | "auto" }
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
export interface ConvOpts {
  cwd: string;
  model?: string;
  resume?: string; // existing session id to reattach to
}

export class Conversation {
  id: string; // session id once known; a temp key beforehand
  cwd: string;
  model?: string;
  busy = false;
  lastActivity = Date.now();
  private resume?: string;
  private q?: Query;
  private queue: SDKUserMessage[] = [];
  private waiter?: (v: SDKUserMessage | null) => void;
  private closed = false;
  private subs = new Set<Sub>();
  private log: AppEvent[] = []; // replay buffer so a reconnecting client sees this live run
  private seqCounter = 0; // stable per-conversation sequence so a reconnect can dedupe

  constructor(id: string, opts: ConvOpts) {
    this.id = id;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.resume = opts.resume;
  }

  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    for (const e of this.log) fn(e); // catch the new listener up on this run
    return () => this.subs.delete(fn);
  }

  private emit(e: AppEvent) {
    (e as any)._seq = this.seqCounter++;
    this.log.push(e);
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
    for (const s of this.subs) {
      try { s(e); } catch {}
    }
  }

  hasSubscribers(): boolean { return this.subs.size > 0; }

  send(text: string) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.busy = true;
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

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(null); }
    try { this.q?.close(); } catch {}
    this.emit({ t: "closed" });
  }

  private async *inputGen(first?: string): AsyncGenerator<SDKUserMessage> {
    if (first !== undefined) {
      this.busy = true;
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
        includePartialMessages: false,
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
      case "assistant": {
        const blocks = (anyM.message?.content as any[]) || [];
        for (const b of blocks) {
          if (b?.type === "text") this.emit({ t: "text", text: b.text });
          else if (b?.type === "thinking") this.emit({ t: "thinking", text: b.thinking || "" });
          else if (b?.type === "tool_use") this.emit({ t: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        break;
      }
      case "user": {
        // tool_result blocks come back as a user message
        const c = anyM.message?.content;
        if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_result") this.emit({ t: "tool_result", id: b.tool_use_id, content: b.content, isError: !!b.is_error });
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
        if (toolResults.length) { for (const b of toolResults) out.push({ t: "tool_result", id: b.tool_use_id, content: b.content, isError: !!b.is_error }); continue; }
      }
      const txt = textOfContent(c);
      if (txt.trim() && !txt.startsWith("<")) out.push({ t: "user", text: txt });
    } else if (o.type === "assistant" && msg) {
      const blocks = (msg.content as any[]) || [];
      for (const b of blocks) {
        if (b?.type === "text") out.push({ t: "text", text: b.text });
        else if (b?.type === "thinking") out.push({ t: "thinking", text: b.thinking || "" });
        else if (b?.type === "tool_use") out.push({ t: "tool_use", id: b.id, name: b.name, input: b.input });
      }
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      out.push({ t: "compact", trigger: o.compact_metadata?.trigger || "auto" });
    }
  }
  return out;
}
// #endregion
