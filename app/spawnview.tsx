// spawnview.tsx - the reader for SPAWNED WORK: subagent transcripts, workflow phases and their
// child agents, and spawned terminal tabs.
//
// A chat can start work that runs somewhere other than the main thread, in three shapes:
//   subagent - the Task tool. Runs in-process, and (verified on disk) writes a FULL transcript to
//              <project>/<sessionId>/subagents/agent-<hex>.jsonl. So there is a real conversation to
//              read, not just the summary the parent gets back.
//   workflow - a phased run that spawns child agents; on disk that is
//              <project>/<sessionId>/subagents/workflows/wf_<id>/agent-<hex>.jsonl per child.
//   tab      - `claude-spawn` starts a detached session in its own terminal tab. That one is NOT a
//              viewer case: it is an ordinary conversation, so the right action is to switch to it.
//
// The server side lives behind two routes (built in parallel, so treat them as possibly absent -
// every fetch here degrades to a plain inline message, never a crash or a stuck spinner):
//   GET /app/api/spawned?id=<sessionId>                  -> the unified list
//   GET /app/api/spawned/transcript?id=<sessionId>&key=  -> that item's events, in the SAME
//                                                           normalized AppEvent shape as
//                                                           /app/api/conversation
// Because the transcript arrives in that shape, this module does NOT own a second event reducer. It
// asks main.tsx (via registerTranscriptRenderer) for the real fold + block renderer and uses those,
// so a subagent transcript renders exactly like the main thread. Until that registration happens it
// falls back to SimpleTranscript below, which is deliberately dumb rather than a second copy of
// applyEvent - a forked reducer would drift.
//
// Styles are injected from here under the `sv-` prefix (verified unused elsewhere in app/), reusing
// the styles.css variables. Nothing here imports main.tsx or agents.tsx: the data flows in as props.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

// #region the shape we consume
export type SpawnKind = "subagent" | "workflow" | "tab";

export interface SpawnPhase {
  name: string;
  status?: "pending" | "running" | "done" | "failed";
}

// What the UI needs from ONE piece of spawned work. Deliberately narrow: the server's field names
// are not settled, so normalizeSpawned() below maps a range of plausible names onto this and
// everything optional is treated as "may be missing".
export interface SpawnedEntry {
  key: string;              // stable id for the transcript route (server) or "local:<toolUseId>"
  kind: SpawnKind;
  label: string;            // primary line: description / workflow name / tab name
  sub?: string;             // secondary: subagent type, phase summary, cwd
  toolUseId?: string;       // links back to the inline Task card in the main thread
  sessionId?: string;       // kind "tab" only: the conversation to switch to
  running: boolean;
  failed?: boolean;
  startedAt?: number;       // epoch ms
  durationMs?: number;
  tokens?: number;
  toolUses?: number;
  lastTool?: string;        // live: what the agent is doing right now
  messages?: number;        // transcript length, for "how much is there to read"
  bytes?: number;
  phases?: SpawnPhase[];
  children?: SpawnedEntry[]; // workflow -> its child agents
  brief?: string;            // the task prompt, when we have it locally
  result?: string;           // the final write-up handed back to the parent
  hasTranscript?: boolean;   // server told us a transcript file exists
  statusFrom?: string;       // the server's plain-words reason for `status`, shown as a tooltip
  local?: boolean;           // derived from the in-page conversation, not from the server
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v
    : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v)
    : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

// Epoch ms from either a number (s or ms) or an ISO string.
function when(v: unknown): number | undefined {
  const n = num(v);
  if (n != null) return n < 1e12 ? n * 1000 : n;
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

const KIND_MAP: Record<string, SpawnKind> = {
  subagent: "subagent", agent: "subagent", task: "subagent", sub_agent: "subagent",
  workflow: "workflow", flow: "workflow", wf: "workflow",
  tab: "tab", session: "tab", conversation: "tab", spawn: "tab", spawned_tab: "tab", terminal: "tab",
};

function normKind(v: unknown): SpawnKind {
  const s = (str(v) || "").toLowerCase().replace(/[\s-]+/g, "_");
  return KIND_MAP[s] || "subagent"; // an unknown kind reads as a subagent: it at least has a transcript
}

export function normPhases(v: unknown): SpawnPhase[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpawnPhase[] = [];
  for (const p of v) {
    if (typeof p === "string") { if (p.trim()) out.push({ name: p.trim() }); continue; }
    const o = rec(p);
    const name = str(o.name) ?? str(o.title) ?? str(o.phase) ?? str(o.step) ?? str(o.label);
    if (!name) continue;
    const s = (str(o.status) || "").toLowerCase();
    const status: SpawnPhase["status"] =
      s === "pending" || s === "running" || s === "done" || s === "failed" ? (s as SpawnPhase["status"])
        : s === "completed" || s === "complete" || s === "success" ? "done"
        : s === "error" || s === "failure" ? "failed"
        : s === "active" || s === "in_progress" ? "running"
        : undefined;
    out.push({ name, status });
  }
  return out.length ? out : undefined;
}

// Map ONE server entry onto SpawnedEntry. Tries the documented names first, then the obvious
// alternatives, so a rename on the backend does not blank the UI.
function normEntry(raw: unknown, i: number): SpawnedEntry | null {
  const o = rec(raw);
  if (!Object.keys(o).length) return null;
  const kind = normKind(o.kind ?? o.type ?? o.category);
  const toolUseId = str(o.toolUseId) ?? str(o.tool_use_id) ?? str(o.toolId) ?? str(o.tool_id);
  const sessionId = str(o.sessionId) ?? str(o.session_id) ?? str(o.convId) ?? str(o.conversationId);
  const key = str(o.key) ?? str(o.id) ?? str(o.path) ?? str(o.agentId) ?? str(o.agent_id)
    ?? toolUseId ?? (kind === "tab" ? sessionId : undefined) ?? "idx:" + i;
  const label = str(o.label) ?? str(o.description) ?? str(o.title) ?? str(o.name)
    ?? str(o.subagentType) ?? str(o.subagent_type)
    ?? (kind === "workflow" ? "Workflow" : kind === "tab" ? "Spawned tab" : "Subagent");
  const status = (str(o.status) || "").toLowerCase();
  // "running" is the one field we must not get wrong, so read it several ways before defaulting.
  const running = bool(o.running) ?? bool(o.active) ?? bool(o.busy)
    ?? (status ? status === "running" || status === "active" || status === "in_progress" : undefined)
    // "finished" / "failed" / "unknown" are the server's other status words: all mean not running.
    ?? (bool(o.finished) === true || bool(o.done) === true ? false : undefined)
    ?? false;
  const failed = bool(o.failed) ?? bool(o.isError) ?? bool(o.error)
    ?? (status === "failed" || status === "error" ? true : undefined);
  const startedAt = when(o.startedAt ?? o.started_at ?? o.start ?? o.mtime ?? o.createdAt);
  const endedAt = when(o.endedAt ?? o.ended_at ?? o.finishedAt ?? o.end);
  const durationMs = num(o.durationMs) ?? num(o.duration_ms) ?? num(o.elapsedMs)
    ?? (startedAt && endedAt ? Math.max(0, endedAt - startedAt) : undefined);
  const usage = rec(o.usage);
  // The workflow and tab specifics arrive in their own sub-objects (SpawnedItem.workflow / .tab).
  const wf = rec(o.workflow);
  const tb = rec(o.tab);
  const kids = Array.isArray(o.children) ? o.children
    : Array.isArray(o.agents) ? o.agents
    : Array.isArray(wf.agents) ? (wf.agents as unknown[])
    : Array.isArray(o.tasks) ? o.tasks
    : null;
  // Second line: whatever the server put in `detail`, plus the workflow's own agent tally.
  const agentCount = num(wf.agentCount), agentsDone = num(wf.agentsDone);
  const sub = [
    str(o.detail) ?? str(o.sub) ?? str(o.subagentType) ?? str(o.subagent_type) ?? str(o.agentType)
      ?? str(o.phase) ?? str(o.model) ?? str(tb.cwd) ?? str(o.cwd),
    agentCount ? (agentsDone ?? 0) + "/" + agentCount + " agents" : undefined,
  ].filter(Boolean).join(" · ") || undefined;
  return {
    key, kind, label, sub,
    toolUseId,
    sessionId: sessionId ?? str(tb.sessionId),
    running: !!running,
    failed: failed || undefined,
    startedAt, durationMs,
    tokens: num(o.tokens) ?? num(o.totalTokens) ?? num(wf.totalTokens) ?? num(usage.total) ?? num(usage.totalTokens),
    toolUses: num(o.toolUses) ?? num(o.tool_uses) ?? num(o.toolCalls) ?? num(o.toolCount) ?? num(o.tools) ?? num(wf.totalToolCalls),
    lastTool: str(o.lastTool) ?? str(o.last_tool) ?? str(o.currentTool),
    messages: num(o.messages) ?? num(o.messageCount) ?? num(o.events) ?? num(o.eventCount) ?? num(o.lines) ?? num(o.entries),
    bytes: num(o.bytes) ?? num(o.size) ?? num(o.sizeBytes) ?? num(o.fileSize),
    phases: normPhases(o.phases ?? o.steps ?? wf.phases),
    children: kids ? normalizeSpawned(kids) : undefined,
    brief: str(o.brief) ?? str(o.prompt) ?? str(o.promptPreview) ?? str(o.task),
    result: str(o.result) ?? str(o.resultPreview) ?? str(o.output) ?? str(o.summary) ?? str(wf.summary) ?? str(wf.error),
    hasTranscript: bool(o.hasTranscript) ?? bool(o.transcript) ?? (str(o.transcriptPath) ? true : undefined),
    statusFrom: str(o.statusFrom) ?? str(o.status_from) ?? (str(tb.linkage) ? "tab linkage: " + str(tb.linkage) : undefined),
  };
}

// Accepts the whole response body in any plausible envelope: a bare array, { items }, { spawned },
// { entries }, { agents } or { data }.
export function normalizeSpawned(body: unknown): SpawnedEntry[] {
  const o = rec(body);
  const arr: unknown[] = Array.isArray(body) ? body
    : Array.isArray(o.items) ? (o.items as unknown[])
    : Array.isArray(o.spawned) ? (o.spawned as unknown[])
    : Array.isArray(o.entries) ? (o.entries as unknown[])
    : Array.isArray(o.agents) ? (o.agents as unknown[])
    : Array.isArray(o.data) ? (o.data as unknown[])
    : [];
  const out: SpawnedEntry[] = [];
  arr.forEach((r, i) => { const e = normEntry(r, i); if (e) out.push(e); });
  return out;
}

// The transcript body: a bare array, or { events, note?, synthesized? } like /app/api/conversation
// returns. `note` is the server explaining the view (e.g. a workflow run has no transcript of its
// own, so what you get is built from its run metadata) and is worth showing verbatim.
export interface SpawnTranscriptBody { events: unknown[]; note?: string; synthesized?: boolean; label?: string }

export function normalizeEvents(body: unknown): SpawnTranscriptBody | null {
  if (Array.isArray(body)) return { events: body };
  const o = rec(body);
  const t = rec(o.transcript);
  const events = Array.isArray(o.events) ? (o.events as unknown[])
    : Array.isArray(t.events) ? (t.events as unknown[])
    : null;
  if (!events) return null;
  return { events, note: str(o.note), synthesized: bool(o.synthesized), label: str(o.label) };
}

// Merge what we can see in the page (this conversation's own tool cards) with what the server lists.
// Local entries are authoritative for brief/result/running-right-now (they update every token); the
// server is authoritative for the transcript key and the on-disk metadata. Matched on toolUseId,
// which is the one id both sides can know.
export function mergeSpawned(local: SpawnedEntry[], remote: SpawnedEntry[]): SpawnedEntry[] {
  const out = remote.map((r) => ({ ...r }));
  const byTool = new Map<string, SpawnedEntry>();
  for (const r of out) if (r.toolUseId) byTool.set(r.toolUseId, r);
  // Fallback pairing for a server entry that carries no toolUseId: same kind and same label. Only
  // when that label is UNAMBIGUOUS on both sides, because pairing the wrong two would show one
  // agent's result above another's transcript. An ambiguous case just yields two rows, which is
  // untidy but never wrong.
  const sig = (e: SpawnedEntry) => e.kind + " " + e.label;
  const count = (arr: SpawnedEntry[], pred: (e: SpawnedEntry) => boolean) => {
    const m = new Map<string, number>();
    for (const e of arr) if (pred(e)) m.set(sig(e), (m.get(sig(e)) || 0) + 1);
    return m;
  };
  const rCount = count(out, (e) => !e.toolUseId);
  const lCount = count(local, () => true);
  const byLabel = new Map<string, SpawnedEntry>();
  for (const r of out) if (!r.toolUseId && rCount.get(sig(r)) === 1 && lCount.get(sig(r)) === 1) byLabel.set(sig(r), r);
  const byKey = new Map<string, SpawnedEntry>();
  for (const r of out) byKey.set(r.key, r);
  for (const l of local) {
    const hit = byKey.get(l.key) || (l.toolUseId ? byTool.get(l.toolUseId) : undefined) || byLabel.get(sig(l));
    if (!hit) { out.push(l); continue; }
    hit.toolUseId = hit.toolUseId ?? l.toolUseId;
    hit.sessionId = hit.sessionId ?? l.sessionId;
    hit.brief = hit.brief ?? l.brief;
    hit.result = hit.result ?? l.result;
    hit.phases = hit.phases ?? l.phases;
    hit.sub = hit.sub ?? l.sub;
    hit.label = hit.label || l.label;
    hit.failed = hit.failed ?? l.failed;
    hit.startedAt = hit.startedAt ?? l.startedAt;
    // A real (non-ack) tool_result in the page is proof the agent finished, whatever a file mtime
    // suggests. A TAB is exempt: its Bash call finishing says nothing about the tab's own life, and
    // the server is the only side that can see whether that session is still alive.
    if (!l.running && l.kind !== "tab") hit.running = false;
  }
  // Running first (oldest first, so it reads like the thread), then finished newest first. Entries
  // with no timestamp (anything derived from the page) keep their thread order rather than being
  // shuffled to the top as if they were epoch 0.
  const pos = new Map<SpawnedEntry, number>();
  out.forEach((e, i) => pos.set(e, i));
  const at = (e: SpawnedEntry) => pos.get(e) ?? 0;
  const run = out.filter((e) => e.running).sort((a, b) =>
    a.startedAt != null && b.startedAt != null ? a.startedAt - b.startedAt : at(a) - at(b));
  const fin = out.filter((e) => !e.running).sort((a, b) =>
    a.startedAt != null && b.startedAt != null ? b.startedAt - a.startedAt
      : a.startedAt != null ? -1
      : b.startedAt != null ? 1
      : at(b) - at(a));
  return [...run, ...fin];
}
// #endregion

// #region fetching (always settles; a missing route is a message, not a spinner)
export type SpawnErrCode = "missing" | "network" | "bad";
export interface SpawnErr { code: SpawnErrCode; message: string }

const isSpawnErr = (e: unknown): e is SpawnErr => {
  const c = (e as { code?: unknown } | null)?.code;
  return c === "missing" || c === "network" || c === "bad";
};

const TIMEOUT_MS = 12_000;

async function getJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    // 404/501 = this build's server does not have the route. That is the expected state until the
    // backend change ships, so it gets its own code and its own message.
    if (r.status === 404 || r.status === 501) {
      const err: SpawnErr = { code: "missing", message: "The server has no " + new URL(url, location.href).pathname + " route yet (HTTP " + r.status + ")." };
      throw err;
    }
    if (!r.ok) {
      const err: SpawnErr = { code: "bad", message: "Server returned HTTP " + r.status + "." };
      throw err;
    }
    return await r.json();
  } catch (e: unknown) {
    if (isSpawnErr(e)) throw e;
    const msg = e instanceof Error ? (e.name === "AbortError" ? "Timed out after 12s." : e.message) : String(e);
    const err: SpawnErr = { code: "network", message: "Could not reach the server. " + msg };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSpawnedList(sessionId: string): Promise<SpawnedEntry[]> {
  return normalizeSpawned(await getJson("/app/api/spawned?id=" + encodeURIComponent(sessionId)));
}

// A finished agent's transcript is immutable, so cache it: drilling in and out of a workflow should
// not refetch. Keyed by conversation + item; a running agent is never cached.
const tCache = new Map<string, SpawnTranscriptBody>();

export async function fetchSpawnedTranscript(sessionId: string, key: string, running: boolean): Promise<SpawnTranscriptBody> {
  const ck = sessionId + " " + key;
  if (!running) { const hit = tCache.get(ck); if (hit) return hit; }
  const body = await getJson("/app/api/spawned/transcript?id=" + encodeURIComponent(sessionId) + "&key=" + encodeURIComponent(key));
  const t = normalizeEvents(body);
  if (!t) { const err: SpawnErr = { code: "bad", message: "The transcript response had no events array." }; throw err; }
  if (!running) tCache.set(ck, t);
  return t;
}
// #endregion

// #region the list hook (ONE owner of the server list, shared by the strip and the sheet)
export interface SpawnedListState {
  list: SpawnedEntry[];      // local merged with server
  loading: boolean;
  err: SpawnErr | null;
  reload: () => void;
}

const POLL_MS = 8000;
const MAX_NET_FAILS = 3;

// Keeps the merged list fresh while it matters. `active` gates all network traffic: the strip turns
// it on only while something looks in flight, the sheet turns it on while it is open.
//
// Why poll at all: a subagent's tool_result is a LAUNCH ACK, not a completion (verified: "Async agent
// launched successfully"), and the SDK's completion notification is not correlated to the tool_use id
// on the wire. So the page alone can tell that an agent STARTED but never that it finished. The
// server reads the real completion signal, so the only way the strip can stop saying "running" is to
// ask it. Poll stops for good on a 404 (no route in this build) and backs off after repeated network
// failures, so a missing backend costs exactly one request.
export function useSpawnedList(sessionId: string | null, local: SpawnedEntry[], active: boolean): SpawnedListState {
  const [remote, setRemote] = useState<SpawnedEntry[]>([]);
  const [err, setErr] = useState<SpawnErr | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const dead = useRef(false);   // route missing -> never ask again
  const fails = useRef(0);
  const reload = useCallback(() => { dead.current = false; fails.current = 0; setTick((t) => t + 1); }, []);

  // A new conversation is a clean slate, including the "this build has no route" verdict.
  useEffect(() => { dead.current = false; fails.current = 0; setRemote([]); setErr(null); }, [sessionId]);

  const anyRunning = local.some((e) => e.running);

  useEffect(() => {
    if (!sessionId || !active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      if (!live || dead.current) return;
      setLoading(true);
      try {
        const r = await fetchSpawnedList(sessionId);
        if (!live) return;
        fails.current = 0;
        setRemote(r); setErr(null);
      } catch (e: unknown) {
        if (!live) return;
        const se = isSpawnErr(e) ? e : { code: "bad" as SpawnErrCode, message: String(e) };
        setErr(se);
        if (se.code === "missing") dead.current = true;
        else if (++fails.current >= MAX_NET_FAILS) dead.current = true;
      } finally {
        if (live) setLoading(false);
      }
      // Re-arm only while something is in flight and the tab is actually being looked at.
      if (live && !dead.current && anyRunning && !(typeof document !== "undefined" && document.hidden)) {
        timer = setTimeout(run, POLL_MS);
      }
    };
    run();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sessionId, active, anyRunning, tick]);

  const list = useMemo(() => mergeSpawned(local, remote), [local, remote]);
  return { list, loading, err, reload };
}
// #endregion

// #region transcript rendering - main.tsx's real machinery, injected
export interface TranscriptBlockProps { items: unknown[]; i: number; convId: string | null }

// main.tsx owns applyEvent + MessageBlock (both module-private there). Rather than fork them, it
// hands them over once at startup. See the report for the exact registration snippet.
export interface TranscriptRenderer {
  fold: (events: unknown[]) => unknown[];
  Block: React.ComponentType<TranscriptBlockProps>;
}

let RENDERER: TranscriptRenderer | null = null;

export function registerTranscriptRenderer(r: TranscriptRenderer): void { RENDERER = r; }
export function hasTranscriptRenderer(): boolean { return !!RENDERER; }

const oneLine = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 160) + "..." : s;
};
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c] || c));
const safeMd = (s: string): string => { try { return marked.parse(s) as string; } catch { return escapeHtml(s); } };

// The fallback. NOT a second reducer: it walks the raw events and prints them, with none of
// applyEvent's queueing / thinking-peak / compaction / result-merge logic. It exists only so the
// viewer is readable before the registration lands, and it says so on screen.
function SimpleTranscript({ events }: { events: unknown[] }): React.JSX.Element {
  const rows = useMemo(() => {
    const out: { k: string; text: string; md?: boolean }[] = [];
    // Deltas must NOT be trimmed: the whitespace between two chunks is part of the sentence.
    const raw_text = (e: Record<string, unknown>): string => (typeof e.text === "string" ? e.text : "");
    for (const raw of events) {
      const e = rec(raw);
      const t = str(e.t) ?? str(e.type);
      const prev = out[out.length - 1];
      if (t === "user") out.push({ k: "user", text: raw_text(e) });
      else if (t === "text" || t === "text_delta") {
        if (prev && prev.k === "assistant") prev.text += raw_text(e);
        else out.push({ k: "assistant", text: raw_text(e), md: true });
      } else if (t === "thinking" || t === "thinking_delta") {
        if (prev && prev.k === "thinking") prev.text += raw_text(e);
        else out.push({ k: "thinking", text: raw_text(e) });
      } else if (t === "tool_use") {
        out.push({ k: "tool", text: (str(e.name) || "tool") + " " + oneLine(e.input) });
      } else if (t === "notice" || t === "error") {
        out.push({ k: "notice", text: str(e.text) ?? str(e.message) ?? "" });
      }
    }
    return out.filter((r) => r.text.trim());
  }, [events]);

  return (
    <div className="sv-simple">
      <div className="sv-simple-note">Simple view: the full message renderer is not wired into this build.</div>
      {rows.map((r, i) =>
        r.md
          ? <div key={i} className={"sv-row sv-row-" + r.k} dangerouslySetInnerHTML={{ __html: safeMd(r.text) }} />
          : <div key={i} className={"sv-row sv-row-" + r.k}>{r.text}</div>
      )}
    </div>
  );
}

// Renders a spawned transcript with main.tsx's fold + block when registered, else the simple view.
export function SpawnTranscript({ events, convId }: { events: unknown[]; convId: string | null }): React.JSX.Element {
  // The hook runs unconditionally (RENDERER is set once at module load, so this never reorders).
  const folded = useMemo(() => {
    const r = RENDERER;
    if (!r) return null;
    try { return r.fold(events); } catch { return null; }
  }, [events]);
  const R = RENDERER;
  if (R && folded && folded.length) {
    const Block = R.Block;
    return <>{folded.map((_, i) => <Block key={i} items={folded} i={i} convId={convId} />)}</>;
  }
  if (folded && !folded.length) return <div className="sv-empty">This transcript replayed to nothing.</div>;
  return <SimpleTranscript events={events} />;
}
// #endregion

// #region small presentational bits
const fmtTok = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k" : String(n));
const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " kB" : n + " B";
const fmtSecs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
};

export function spawnMeta(e: SpawnedEntry): string {
  const bits: string[] = [];
  if (e.durationMs) bits.push(fmtSecs(e.durationMs));
  if (e.tokens) bits.push(fmtTok(e.tokens) + " tok");
  if (e.toolUses) bits.push(e.toolUses + (e.toolUses === 1 ? " tool" : " tools"));
  if (e.messages) bits.push(e.messages + " msg");
  else if (e.bytes) bits.push(fmtBytes(e.bytes));
  if (e.running && e.lastTool) bits.push(e.lastTool);
  return bits.join(" · ");
}

export const KIND_LABEL: Record<SpawnKind, string> = { subagent: "Subagent", workflow: "Workflow", tab: "Tab" };

export function KindIcon({ kind }: { kind: SpawnKind }): React.JSX.Element {
  const p = {
    width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (kind === "workflow") return (<svg {...p}><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></svg>);
  if (kind === "tab") return (<svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>);
  return (<svg {...p}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 3h8" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></svg>);
}

function StatusPill({ e }: { e: SpawnedEntry }): React.JSX.Element {
  const s = e.running ? "running" : e.failed ? "failed" : "done";
  return (
    <span className={"sv-pill sv-" + s}>
      {e.running && <span className="sv-spin" />}
      {e.running ? "Running" : e.failed ? "Failed" : "Done"}
    </span>
  );
}

function PhaseList({ phases }: { phases: SpawnPhase[] }): React.JSX.Element {
  return (
    <ol className="sv-phases">
      {phases.map((p, i) => (
        <li key={i} className={"sv-phase sv-phase-" + (p.status || "pending")}>
          <span className={"sv-phase-dot sv-" + (p.status || "pending")} />
          <span className="sv-phase-name">{p.name}</span>
          {p.status && <span className="sv-phase-status">{p.status}</span>}
        </li>
      ))}
    </ol>
  );
}

function ErrorNote({ err, onRetry }: { err: SpawnErr; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className={"sv-note sv-note-" + err.code}>
      <b>{err.code === "missing" ? "Not available in this build" : err.code === "network" ? "Offline or unreachable" : "Unexpected response"}</b>
      <span>{err.message}</span>
      {err.code === "missing" && <span className="sv-note-hint">The route ships with the backend change; restart the service once it is in.</span>}
      {onRetry && <button className="sv-btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

function Spinner({ label }: { label: string }): React.JSX.Element {
  return <div className="sv-loading"><span className="sv-spin" />{label}</div>;
}
// #endregion

// #region transcript pane (own fetch state; remounted per item via key=)
const isLocalKey = (k: string): boolean => k.startsWith("local:");

function TranscriptPane({ sessionId, entry, convId }: { sessionId: string; entry: SpawnedEntry; convId: string | null }): React.JSX.Element {
  const [body, setBody] = useState<SpawnTranscriptBody | null>(null);
  const [err, setErr] = useState<SpawnErr | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const localOnly = isLocalKey(entry.key);

  useEffect(() => {
    // A purely local entry has no server key, so there is nothing to fetch - the brief/result
    // sections above are all there is until the list route lands.
    if (localOnly) { setBody(null); setErr(null); setLoading(false); return; }
    let live = true;
    setLoading(true); setErr(null);
    fetchSpawnedTranscript(sessionId, entry.key, entry.running)
      .then((t) => { if (live) { setBody(t); setLoading(false); } })
      .catch((e: unknown) => { if (live) { setErr(isSpawnErr(e) ? e : { code: "bad", message: String(e) }); setLoading(false); } });
    return () => { live = false; };
  }, [sessionId, entry.key, entry.running, localOnly, tick]);

  if (localOnly) {
    return (
      <div className="sv-note sv-note-missing">
        <b>No transcript link yet</b>
        <span>
          This {KIND_LABEL[entry.kind].toLowerCase()} was read from the chat itself, so there is no on-disk
          key to fetch it by. The brief and result above are what the main thread has.
        </span>
      </div>
    );
  }
  if (loading) return <Spinner label="Loading transcript..." />;
  if (err) return <ErrorNote err={err} onRetry={() => setTick((t) => t + 1)} />;
  if (!body || !body.events.length) return <div className="sv-empty">No transcript entries.</div>;
  return (
    <div className="sv-transcript">
      {body.note && <div className="sv-note sv-note-missing"><b>{body.synthesized ? "Built from run metadata" : "About this view"}</b><span>{body.note}</span></div>}
      <SpawnTranscript events={body.events} convId={convId} />
    </div>
  );
}
// #endregion

// #region rows
export function SpawnRow({ e, onOpen }: { e: SpawnedEntry; onOpen: (e: SpawnedEntry) => void }): React.JSX.Element {
  const meta = spawnMeta(e);
  return (
    <button className={"sv-item sv-item-" + e.kind} onClick={() => onOpen(e)} title={e.label}>
      <span className="sv-item-ic"><KindIcon kind={e.kind} /></span>
      <span className="sv-item-main">
        <span className="sv-item-label">{e.label}</span>
        <span className="sv-item-sub">
          <span className="sv-item-kind">{KIND_LABEL[e.kind]}</span>
          {e.sub ? " · " + e.sub : ""}
          {meta ? " · " + meta : ""}
        </span>
      </span>
      <StatusPill e={e} />
      <svg className="sv-item-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}
// #endregion

// #region the sheet
export interface SpawnSheetProps {
  sessionId: string | null;
  list: SpawnedEntry[];                             // merged local + server (see useSpawnedList)
  loading?: boolean;
  err?: SpawnErr | null;
  onReload?: () => void;
  openKey?: string | null;                          // open straight into this item
  onClose: () => void;
  onJump?: (toolUseId: string) => void;             // scroll the main thread to the inline tool card
  onOpenConversation?: (sessionId: string) => void; // kind "tab" -> switch conversation
}

// Full-height sheet. One history entry for the whole sheet, so the Android back gesture closes it;
// the in-sheet back arrow walks the drill-in stack instead.
// Find an entry by key anywhere in the list, including a workflow's children. Also accepts the
// "local:<toolUseId>" form of a key, which is what the strip hands over before the server list lands.
function findEntry(key: string, pool: SpawnedEntry[]): SpawnedEntry | undefined {
  for (const e of pool) {
    if (e.key === key) return e;
    if (e.toolUseId && ("local:" + e.toolUseId === key || e.toolUseId === key)) return e;
    if (e.children && e.children.length) { const hit = findEntry(key, e.children); if (hit) return hit; }
  }
  return undefined;
}

export function SpawnSheet({ sessionId, list, loading, err, onReload, openKey, onClose, onJump, onOpenConversation }: SpawnSheetProps): React.JSX.Element {
  injectSpawnCss();
  // The drill-in path is held as keys + the entry we had at push time. Every render re-resolves each
  // key against the current list, so an item opened from the strip (key "local:<toolUseId>", no
  // transcript) upgrades itself the moment the server list arrives and supplies the real key.
  const [stack, setStack] = useState<{ key: string; entry: SpawnedEntry }[]>([]);
  const closing = useRef(false);
  const deepOpened = useRef(false);

  // Deep-open: the strip taps a specific item. Matched by key, then by toolUseId, because a strip row
  // known only from the page carries a "local:<toolUseId>" key the server list will not have. Runs
  // once (the list arriving later must not yank the user back out of a drill-in).
  useEffect(() => {
    if (!openKey || deepOpened.current) return;
    const hit = list.find((e) => e.key === openKey)
      || list.find((e) => e.toolUseId && "local:" + e.toolUseId === openKey)
      || list.find((e) => e.toolUseId === openKey);
    if (!hit) return;
    deepOpened.current = true;
    if (hit.kind !== "tab") setStack([{ key: hit.key, entry: hit }]);
  }, [openKey, list]);

  const close = useCallback(() => { closing.current = true; onClose(); }, [onClose]);
  // Close, THEN act. The sheet's unmount pops its own history entry and main.tsx's conversation
  // switch does a replaceState; doing both in one tick leaves a dead entry behind. A jump also needs
  // the thread on screen before it can scroll to a card.
  const closeThen = useCallback((fn: () => void) => { close(); setTimeout(fn, 0); }, [close]);
  const back = useCallback(() => { setStack((s) => (s.length ? s.slice(0, -1) : s)); }, []);

  // Escape (desktop): back one level, or close at the root.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      if (stack.length) back(); else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stack.length, back, close]);

  // One pushed history entry for the sheet, so the Android back gesture closes it instead of leaving
  // the PWA. main.tsx only ever calls replaceState, so this cannot fight it.
  useEffect(() => {
    history.pushState({ svSheet: Date.now() }, "", location.href);
    const onPop = () => { if (!closing.current) { closing.current = true; onClose(); } };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from inside the sheet: drop our entry so the back button does not need two taps.
      const st = history.state as { svSheet?: number } | null;
      if (st && st.svSheet) history.back();
    };
  }, [onClose]);

  // Opening an item: a tab is a conversation switch, everything else drills in.
  const open = useCallback((e: SpawnedEntry) => {
    if (e.kind === "tab") {
      const sid = e.sessionId, tid = e.toolUseId;
      if (sid && onOpenConversation) { closeThen(() => onOpenConversation(sid)); return; }
      if (tid && onJump) { closeThen(() => onJump(tid)); return; }
      setStack((s) => [...s, { key: e.key, entry: e }]); // nothing to switch to -> show what we know
      return;
    }
    setStack((s) => [...s, { key: e.key, entry: e }]);
  }, [closeThen, onJump, onOpenConversation]);

  // Re-resolve the trail against the live list (children included), falling back to the entry as it
  // was pushed so a level can never vanish under the user.
  const trail = useMemo(() => stack.map((s) => findEntry(s.key, list) || s.entry), [stack, list]);
  const cur: SpawnedEntry | undefined = trail[trail.length - 1];
  const running = list.filter((e) => e.running);
  const finished = list.filter((e) => !e.running);
  const jumpId = cur && cur.toolUseId;

  return (
    <div className="sv-sheet" role="dialog" aria-modal="true" aria-label={cur ? cur.label : "Spawned work"}>
      <header className="sv-head">
        {stack.length > 0 ? (
          <button className="sv-icbtn" onClick={back} aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
        ) : (
          <span className="sv-head-ic"><KindIcon kind="subagent" /></span>
        )}
        <div className="sv-head-txt">
          <div className="sv-head-title">{cur ? cur.label : "Spawned work"}</div>
          <div className="sv-head-sub" title={(cur && cur.statusFrom) || undefined}>
            {cur
              ? [KIND_LABEL[cur.kind], cur.sub, spawnMeta(cur)].filter(Boolean).join(" · ")
              : running.length + " running · " + finished.length + " finished"}
          </div>
        </div>
        {jumpId && onJump && (
          <button className="sv-btn sv-btn-ghost" onClick={() => closeThen(() => onJump(jumpId))} title="Show the tool card in the conversation">In chat</button>
        )}
        {cur && <StatusPill e={cur} />}
        <button className="sv-icbtn" onClick={close} aria-label="Close">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      {/* Drill-in trail, so workflow -> child -> back is never a dead end. */}
      {stack.length > 1 && (
        <nav className="sv-crumbs">
          <button className="sv-crumb" onClick={() => setStack([])}>All</button>
          {trail.map((e, i) => (
            <React.Fragment key={e.key + ":" + i}>
              <span className="sv-crumb-sep">/</span>
              {i === trail.length - 1
                ? <span className="sv-crumb sv-crumb-on">{e.label}</span>
                : <button className="sv-crumb" onClick={() => setStack((s) => s.slice(0, i + 1))}>{e.label}</button>}
            </React.Fragment>
          ))}
        </nav>
      )}

      <div className="sv-body">
        {!cur ? (
          <>
            {loading && !list.length && <Spinner label="Loading spawned work..." />}
            {err && <ErrorNote err={err} onRetry={onReload} />}
            {running.length > 0 && (
              <>
                <div className="sv-sec">Running</div>
                {running.map((e) => <SpawnRow key={e.key} e={e} onOpen={open} />)}
              </>
            )}
            {finished.length > 0 && (
              <>
                <div className="sv-sec">Finished</div>
                {finished.map((e) => <SpawnRow key={e.key} e={e} onOpen={open} />)}
              </>
            )}
            {!loading && !err && !list.length && (
              <div className="sv-empty">Nothing spawned in this conversation yet. Subagents, workflows and spawned tabs show up here.</div>
            )}
          </>
        ) : (
          <ItemView entry={cur} sessionId={sessionId} onOpen={open} onRetryList={onReload} />
        )}
      </div>
    </div>
  );
}

// One item: phases and children for a workflow, the brief/result we have locally, then the transcript.
function ItemView({ entry, sessionId, onOpen, onRetryList }: { entry: SpawnedEntry; sessionId: string | null; onOpen: (e: SpawnedEntry) => void; onRetryList?: () => void }): React.JSX.Element {
  const [showBrief, setShowBrief] = useState(false);
  const kids = entry.children || [];
  return (
    <>
      {entry.kind === "tab" && (
        <div className="sv-note sv-note-missing">
          <b>Nothing to open</b>
          <span>This is a separate conversation, but no session id came through for it, so there is nothing to switch to yet.</span>
          {onRetryList && <button className="sv-btn" onClick={onRetryList}>Retry</button>}
        </div>
      )}
      {entry.statusFrom && <div className="sv-why">Status: {entry.statusFrom}</div>}
      {entry.phases && entry.phases.length > 0 && (
        <><div className="sv-sec">Phases</div><PhaseList phases={entry.phases} /></>
      )}
      {kids.length > 0 && (
        <>
          <div className="sv-sec">Agents in this workflow</div>
          {kids.map((k) => <SpawnRow key={k.key} e={k} onOpen={onOpen} />)}
        </>
      )}
      {entry.brief && (
        <>
          <button className="sv-disc" onClick={() => setShowBrief((v) => !v)} aria-expanded={showBrief}>
            <svg className={"sv-disc-chev" + (showBrief ? " on" : "")} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            Task brief
          </button>
          {showBrief && <pre className="sv-pre">{entry.brief}</pre>}
        </>
      )}
      {entry.result && (
        <>
          <div className="sv-sec">{entry.failed ? "Result (error)" : "Result handed back"}</div>
          <div className={"sv-result" + (entry.failed ? " sv-result-err" : "")} dangerouslySetInnerHTML={{ __html: safeMd(entry.result) }} />
        </>
      )}
      {entry.kind !== "tab" && (
        <>
          <div className="sv-sec">Transcript</div>
          {sessionId
            ? <TranscriptPane key={entry.key} sessionId={sessionId} entry={entry} convId={sessionId} />
            : <div className="sv-empty">No conversation open.</div>}
        </>
      )}
    </>
  );
}
// #endregion

// #region injected styles (prefix `sv-`, verified unused elsewhere in app/)
let cssDone = false;
function injectSpawnCss(): void {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const css = `
  .sv-sheet{position:fixed;inset:0;z-index:88;display:flex;flex-direction:column;background:var(--bg,#1a1613);color:var(--text,#ece7e1);font-family:var(--font)}
  .sv-head{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:calc(9px + env(safe-area-inset-top)) 12px 9px;border-bottom:1px solid var(--line-2,#2c2621);background:var(--bg-2,#211c18)}
  .sv-head-ic{flex:0 0 auto;display:inline-flex;color:var(--accent,#d97757)}
  .sv-head-txt{flex:1;min-width:0}
  .sv-head-title{font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sv-head-sub{font-size:11.5px;color:var(--text-3,#8a8078);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sv-icbtn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;border:0;background:transparent;color:var(--text-2,#b8afa5)}
  .sv-icbtn:hover,.sv-icbtn:focus-visible{background:var(--bg-3,#2a2420);color:var(--text,#ece7e1);outline:none}
  .sv-btn{flex:0 0 auto;font:inherit;font-size:12px;font-weight:600;padding:5px 10px;border-radius:8px;border:1px solid var(--line,#3a322c);background:var(--bg-3,#2a2420);color:var(--text-2,#b8afa5)}
  .sv-btn:hover{color:var(--text,#ece7e1);border-color:var(--accent,#d97757)}
  .sv-btn-ghost{background:transparent}
  .sv-crumbs{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 12px;font-size:11.5px;color:var(--text-3,#8a8078);border-bottom:1px solid var(--line-2,#2c2621);overflow-x:auto;white-space:nowrap}
  .sv-crumb{font:inherit;background:transparent;border:0;color:var(--accent-2,#e08a6d);padding:0;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  .sv-crumb-on{color:var(--text-2,#b8afa5)}
  .sv-crumb-sep{opacity:.6}
  .sv-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px calc(18px + env(safe-area-inset-bottom));max-width:860px;width:100%;margin:0 auto}
  .sv-sec{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3,#8a8078);margin:16px 0 7px}
  .sv-sec:first-child{margin-top:4px}
  .sv-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;padding:10px;margin:0 0 6px;border-radius:11px;border:1px solid var(--line-2,#2c2621);background:var(--bg-2,#211c18);color:var(--text,#ece7e1);min-height:52px}
  .sv-item:hover,.sv-item:focus-visible{background:var(--bg-3,#2a2420);border-color:var(--line,#3a322c);outline:none}
  .sv-item-ic{flex:0 0 auto;display:inline-flex;color:var(--accent,#d97757)}
  .sv-item-workflow .sv-item-ic{color:var(--accent-2,#e08a6d)}
  .sv-item-tab .sv-item-ic{color:var(--text-2,#b8afa5)}
  .sv-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .sv-item-label{font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sv-item-sub{font-size:11.5px;color:var(--text-3,#8a8078);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sv-item-kind{font-weight:600}
  .sv-item-chev{flex:0 0 auto;color:var(--text-3,#8a8078)}
  .sv-pill{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line,#3a322c);color:var(--text-3,#8a8078)}
  .sv-pill.sv-running{color:var(--accent,#d97757);border-color:color-mix(in srgb,var(--accent,#d97757) 45%,transparent);background:color-mix(in srgb,var(--accent,#d97757) 12%,transparent)}
  .sv-pill.sv-done{color:var(--success,#10B981);border-color:color-mix(in srgb,var(--success,#10B981) 40%,transparent)}
  .sv-pill.sv-failed{color:var(--danger,#e0685f);border-color:color-mix(in srgb,var(--danger,#e0685f) 45%,transparent)}
  .sv-spin{width:10px;height:10px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 28%,transparent);border-top-color:currentColor;animation:sv-spin .85s linear infinite;display:inline-block;flex:0 0 auto}
  @keyframes sv-spin{to{transform:rotate(360deg)}}
  .sv-loading{display:flex;align-items:center;gap:9px;padding:16px 4px;font-size:13px;color:var(--text-3,#8a8078)}
  .sv-empty{padding:16px 4px;font-size:13px;color:var(--text-3,#8a8078)}
  .sv-note{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px 14px;border-radius:11px;border:1px solid var(--line,#3a322c);background:var(--bg-2,#211c18);font-size:12.5px;color:var(--text-2,#b8afa5);margin:6px 0}
  .sv-note b{color:var(--text,#ece7e1);font-size:13px}
  .sv-note-hint{color:var(--text-3,#8a8078)}
  .sv-note-network{border-color:color-mix(in srgb,var(--warning,#F59E0B) 45%,var(--line,#3a322c))}
  .sv-note-bad{border-color:color-mix(in srgb,var(--danger,#e0685f) 45%,var(--line,#3a322c))}
  .sv-phases{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
  .sv-phase{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;font-size:12.5px;color:var(--text-2,#b8afa5);background:var(--bg-2,#211c18);border:1px solid var(--line-2,#2c2621)}
  .sv-phase-running{border-color:color-mix(in srgb,var(--accent,#d97757) 40%,var(--line-2,#2c2621))}
  .sv-phase-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--line,#3a322c)}
  .sv-phase-dot.sv-running{background:var(--accent,#d97757)}
  .sv-phase-dot.sv-done{background:var(--success,#10B981)}
  .sv-phase-dot.sv-failed{background:var(--danger,#e0685f)}
  .sv-phase-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sv-phase-status{flex:0 0 auto;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3,#8a8078)}
  .sv-phase-done .sv-phase-name{color:var(--text-3,#8a8078)}
  .sv-disc{display:flex;align-items:center;gap:7px;width:100%;font:inherit;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3,#8a8078);background:transparent;border:0;padding:16px 0 7px;text-align:left}
  .sv-disc:hover{color:var(--text-2,#b8afa5)}
  .sv-disc-chev{transition:transform .15s ease}
  .sv-disc-chev.on{transform:rotate(90deg)}
  .sv-pre{background:var(--panel,#17130f);border:1px solid var(--line-2,#2c2621);border-radius:10px;padding:11px 12px;margin:0;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text-2,#b8afa5)}
  .sv-result{font-size:13.5px;line-height:1.55}
  .sv-result>:first-child{margin-top:0}
  .sv-result.sv-result-err{color:var(--danger,#e0685f)}
  .sv-transcript{border-top:1px solid var(--line-2,#2c2621);padding-top:10px}
  .sv-why{font-size:11.5px;color:var(--text-3,#8a8078);margin:8px 0 0}
  .sv-simple-note{font-size:11.5px;color:var(--text-3,#8a8078);margin-bottom:10px}
  .sv-row{font-size:13px;line-height:1.55;padding:8px 11px;margin:0 0 7px;border-radius:10px;background:var(--bg-2,#211c18);border:1px solid var(--line-2,#2c2621);white-space:pre-wrap;word-break:break-word}
  .sv-row-user{background:var(--user-bg,#2c2925);border-color:transparent}
  .sv-row-assistant{background:transparent;border-color:transparent;padding:2px 0;white-space:normal}
  .sv-row-thinking{color:var(--text-3,#8a8078);font-style:italic}
  .sv-row-tool{font-family:var(--mono);font-size:11.5px;color:var(--text-3,#8a8078)}
  .sv-row-notice{color:var(--text-3,#8a8078)}
  @media (max-width:620px){.sv-body{padding-left:10px;padding-right:10px}.sv-head-sub{font-size:11px}}
  @media (prefers-reduced-motion:reduce){.sv-spin{animation-duration:2.4s}.sv-disc-chev{transition:none}}
  `;
  const el = document.createElement("style");
  el.id = "spawnview-css";
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion
