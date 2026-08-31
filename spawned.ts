// spawned.ts
// The three kinds of SPAWNED WORK a chat can start, unified into one list the /app UI can
// render, plus a reader that replays any one of them into the SAME normalized AppEvent array
// /app/api/conversation returns (so the front-end reuses its renderer wholesale).
//
// The three kinds, and where each actually lives on disk (all verified against real files,
// CLI 2.1.2xx):
//
//   1. SUBAGENT (the Agent tool). Full transcript per agent:
//        <dataDir>/<project>/<sessionId>/subagents/agent-<agentId>.jsonl
//      with a tiny sidecar written at launch time:
//        agent-<agentId>.meta.json = {agentType, description, toolUseId, spawnDepth}
//      `toolUseId` is the id of the Agent tool_use in the PARENT transcript, which is what
//      links an entry to its inline card in the chat.
//
//   2. WORKFLOW (the Workflow tool). TWO locations, both used:
//        <dataDir>/<project>/<sessionId>/workflows/wf_<runId>.json
//          One JSON blob written when the run TERMINATES (status completed|failed) holding
//          the script, phases, per-agent progress rows and totals. Its absence while the run
//          dir below exists is exactly how we know a run is still going.
//        <dataDir>/<project>/<sessionId>/subagents/workflows/wf_<runId>/
//          journal.jsonl  -> {"type":"started"|"result", key, agentId, result?} appended LIVE
//          agent-<agentId>.jsonl + agent-<agentId>.meta.json  -> a real per-agent transcript
//      So a workflow's agents ARE individually readable; the workflow "run" itself is not a
//      conversation, so we synthesize one from the run file (see workflowRunEvents).
//
//   3. SPAWNED TAB (`claude-spawn`, which runs `claude --name`). An ordinary top-level session:
//        <dataDir>/<project>/<its own sessionId>.jsonl
//      plus ~/.claude/sessions/<pid>.json ({sessionId, cwd, name, nameSource, tmux, status,...}).
//      NOTHING on disk records which session spawned it. The only link that exists is DERIVED:
//      the parent transcript contains the Bash tool_use whose command ran `claude-spawn`, and
//      the tab name it printed. We surface that and say so; we do not invent a parent field.
//
// STATUS, and exactly how it is inferred (this matters, because the obvious signal is wrong):
//   A subagent's and a workflow's tool_result arrives IMMEDIATELY with
//   `status: "async_launched"` -- it is a launch ack, NOT a completion. The real completion
//   signal is a <task-notification> block in the parent transcript (as a `queue-operation`
//   entry, and later an `attachment`/`user` entry once delivered) carrying
//   <task-id> (= agentId for a subagent, = the workflow taskId), <tool-use-id> and <status>.
//   We key off that, and fall back to file mtime freshness when no notification exists yet.

import { join, resolve, sep, dirname, basename } from "path";
import { readdirSync, statSync, existsSync, realpathSync, readFileSync } from "fs";
import { replayTranscript, type AppEvent } from "./app-runner";

// #region path guard
// Same approach as app-mem-skills.ts (resolve + under-root test), hardened with a realpath
// check because these paths are assembled from client-supplied ids: a symlink planted inside
// the transcript store must not be able to point back out of it.
function underRoot(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

// Resolve a path and assert it stays inside `root`, both literally and after following
// symlinks. Throws (route answers 400/403) rather than touching anything outside the store.
function guarded(root: string, p: string): string {
  const t = resolve(p);
  if (!underRoot(root, t)) throw new Error("path outside the transcript store");
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = resolve(root); }
  let real: string;
  try {
    real = realpathSync(t); // exists: resolve it fully
  } catch {
    // does not exist yet (or is a broken link): resolve its PARENT and re-append the leaf, so
    // a symlinked directory still cannot smuggle the target out of the root.
    try { real = join(realpathSync(dirname(t)), basename(t)); } catch { real = t; }
  }
  if (!underRoot(realRoot, real)) throw new Error("path escapes the transcript store via a symlink");
  return t;
}

// Every id that ever becomes a path component is validated BEFORE it is joined, so the guard
// above is the second line of defence rather than the only one.
const RE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/; // session uuid (also used for project scan)
const RE_AGENT = /^[A-Za-z0-9]{4,64}$/;                // agentId, e.g. a28ab0e7090d027c1
const RE_RUN = /^wf_[A-Za-z0-9-]{3,48}$/;              // workflow runId, e.g. wf_9c04bd9b-a52
const RE_NAME = /^[A-Za-z0-9_-]{1,64}$/;               // claude-spawn tab name (its own charset)
const RE_PROJECT = /^[A-Za-z0-9._-]{1,255}$/;          // encoded cwd dir name under dataDir
// #endregion

// #region caps
// A single item's transcript we are willing to read whole. replayTranscript() reads the entire
// file, so this is checked with stat() BEFORE any read. Observed real sizes: subagent 260-610 KB,
// workflow agent ~35 KB, so 16 MB is generous headroom, not a real limit.
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
// Events returned for one item. Beyond this we keep the TAIL (the interesting end) and prepend a
// notice. Truncation disables the ?since= delta (see below).
const MAX_EVENTS = 4000;
// Parent transcript bytes scanned for status/linkage. Parents run to ~8 MB; above the cap we scan
// only the last CAP bytes and flag it.
const MAX_PARENT_SCAN_BYTES = 32 * 1024 * 1024;
// Workflow run files are 5-110 KB in practice; refuse an absurd one rather than block the list.
const MAX_WF_JSON_BYTES = 8 * 1024 * 1024;
// How many workflow run files we parse for one list call.
const MAX_WORKFLOWS = 60;
// A jsonl untouched for THIS long, with no completion notification in the parent, is treated as
// stalled rather than running. Generous on purpose: the completion notification is the real signal,
// and an agent can legitimately go many minutes without appending (a long build, a slow Bash call,
// a big think). This only catches work whose process died before it could notify.
const STALE_MS = 15 * 60_000;
// #endregion

export interface SpawnedCtx {
  dataDir: string; // ~/.claude/projects
  claudeDir: string; // ~/.claude  (sessions/*.json for spawned-tab identification)
}

// #region types the route returns
export type SpawnedKind = "subagent" | "workflow" | "tab";
export type SpawnedStatus = "running" | "finished" | "failed" | "unknown";

export interface SpawnedAgentRow {
  key: string; // opaque; feed straight back to the transcript route
  agentId: string;
  label: string;
  phase: string | null;
  phaseIndex: number | null;
  state: string | null; // the run file's own word for it ("done", ...)
  status: SpawnedStatus;
  model: string | null;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  lastTool: string | null;
  promptPreview: string | null;
  resultPreview: string | null;
  bytes: number; // transcript size, 0 = no transcript on disk
  hasTranscript: boolean;
  mtime: number;
}

export interface SpawnedItem {
  key: string; // stable + path-safe: "sub:<agentId>" | "wf:<runId>" | "wf:<runId>:<agentId>" | "tab:<name>"
  kind: SpawnedKind;
  label: string; // what to show in the list
  detail: string | null; // second line (agent type, workflow script name, tab cwd)
  toolUseId: string | null; // links to the inline tool card in the parent chat, when one exists
  status: SpawnedStatus;
  statusFrom: string; // plain-words explanation of WHICH signal produced `status`
  startedAt: number | null; // ms epoch
  endedAt: number | null;
  durationMs: number | null;
  mtime: number; // last write to the item's own data
  bytes: number; // transcript bytes (subagent/tab) or run-file bytes (workflow)
  hasTranscript: boolean; // false -> the transcript route will 404 / synthesize only
  resultPreview: string | null; // first ~400 chars of the reported result, when known
  // workflow only
  workflow?: {
    runId: string;
    workflowName: string | null;
    scriptPath: string | null;
    summary: string | null;
    phases: { index: number; title: string }[];
    agentCount: number | null;
    agentsDone: number;
    agentsRunning: number;
    totalTokens: number | null;
    totalToolCalls: number | null;
    error: string | null;
    result: unknown;
    agents: SpawnedAgentRow[]; // each has its own `key` -> readable transcript
    live: boolean; // still running (no terminal run file yet)
  };
  // tab only
  tab?: {
    name: string;
    sessionId: string | null; // resolved via ~/.claude/sessions/*.json; null = tab gone
    tmuxSession: string | null;
    cwd: string | null;
    pid: number | null;
    pidAlive: boolean;
    nameSource: string | null;
    linkage: string; // how we decided this tab came from this chat
  };
}

export interface SpawnedList {
  sessionId: string;
  items: SpawnedItem[];
  counts: { subagent: number; workflow: number; tab: number };
  warnings: string[]; // things we could NOT determine, said plainly
}
// #endregion

// #region session/transcript location
function projectDirs(ctx: SpawnedCtx): string[] {
  // "." / ".." can never come out of readdir, but reject them anyway: this name becomes a path
  // component, and the guard should not be the only thing standing between it and an escape.
  try { return readdirSync(ctx.dataDir).filter((d) => d !== "." && d !== ".." && RE_PROJECT.test(d)); } catch { return []; }
}

// The top-level transcript for a session id, and the per-session sidecar dir beside it. The scan is
// a stat() per project dir, so the guard runs once on the match rather than 160-odd times.
function locate(ctx: SpawnedCtx, sessionId: string): { project: string; transcript: string; sessionDir: string } | null {
  if (!RE_SESSION.test(sessionId)) return null;
  for (const project of projectDirs(ctx)) {
    const p = join(ctx.dataDir, project, sessionId + ".jsonl");
    try { statSync(p); } catch { continue; }
    return { project, transcript: guarded(ctx.dataDir, p), sessionDir: guarded(ctx.dataDir, join(ctx.dataDir, project, sessionId)) };
  }
  return null;
}
const statOr = (p: string) => { try { return statSync(p); } catch { return null; } };
// #endregion

// #region parent-transcript scan (linkage + the real completion signal)
interface Notif { taskId: string; toolUseId: string | null; status: string; summary: string | null; result: string | null; ts: number }
interface SpawnCall { toolUseId: string; name: string | null; cwd: string | null; ts: number; printed: string | null }
interface Scan {
  size: number;
  scanned: number; // bytes of complete lines already folded in
  partial: boolean; // we skipped the head of an oversized parent
  agents: Map<string, { toolUseId: string; description: string | null; model: string | null; ts: number }>; // agentId ->
  workflows: Map<string, { toolUseId: string; taskId: string; workflowName: string | null; summary: string | null; ts: number }>; // runId ->
  notifs: Map<string, Notif>; // task-id -> LAST notification (a resumed agent notifies again)
  spawns: SpawnCall[];
  spawnByToolUse: Map<string, SpawnCall[]>;
}

const scanCache = new Map<string, Scan>();

function newScan(): Scan {
  return { size: 0, scanned: 0, partial: false, agents: new Map(), workflows: new Map(), notifs: new Map(), spawns: [], spawnByToolUse: new Map() };
}

const RX_TASK_ID = /<task-id>([^<]*)<\/task-id>/;
const RX_TOOL_USE_ID = /<tool-use-id>([^<]*)<\/tool-use-id>/;
const RX_STATUS = /<status>([^<]*)<\/status>/;
const RX_SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const RX_RESULT = /<result>([\s\S]*?)<\/result>/;
// A shell command that really RUNS claude-spawn, as opposed to one that merely mentions it (this
// project's own dev sessions cp/grep/md5sum the script constantly). Two conditions, both required:
// the name appears in command position followed by an option, and a prompt option is present --
// claude-spawn refuses to run without one, so a real invocation always has it.
// The `/` in the class covers an absolute invocation (~/.local/bin/claude-spawn, which is how it
// is usually called). `(?=\s+-)` keeps it in command position without consuming the option.
const RX_SPAWN_INVOKE = /(?:^|[\s;&|(){}=$"'`\/])claude-spawn(?=\s+-)/g;
const RX_SPAWN_PROMPT = /(?:^|\s)(?:--prompt|--prompt-file|-p|-f)(?:[=\s])/;
// The tab id claude-spawn prints when no --name was given. Only this exact shape is trusted from
// stdout; anything else would be some other command's output on the same line.
const RE_GENERATED_NAME = /^spawn-\d{6}-\d{1,8}$/;

// `--name x` / `-n x` / `--cwd x` / `-c x` in a shell command, quoted or bare.
function shellOpt(cmd: string, long: string, short: string): string | null {
  const rx = new RegExp(`(?:--${long}|-${short})[=\\s]+(?:"([^"]*)"|'([^']*)'|([^\\s;|&]+))`);
  const m = rx.exec(cmd);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
}

// Every claude-spawn invocation inside one Bash command. One tool call often launches several
// tabs in a row, so this returns a list rather than the first match.
function spawnInvocations(cmd: string): { name: string | null; cwd: string | null }[] {
  const out: { name: string | null; cwd: string | null }[] = [];
  RX_SPAWN_INVOKE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RX_SPAWN_INVOKE.exec(cmd))) {
    const start = m.index + m[0].length;
    // One invocation runs to the end of its line, following `\` continuations.
    let end = start;
    for (;;) {
      let nl = cmd.indexOf("\n", end);
      if (nl < 0) { end = cmd.length; break; }
      end = nl;
      if (cmd[nl - 1] !== "\\") break;
      end = nl + 1;
    }
    const seg = cmd.slice(start, end);
    RX_SPAWN_INVOKE.lastIndex = end;
    if (!RX_SPAWN_PROMPT.test(seg)) continue; // claude-spawn cannot run without a prompt option
    out.push({ name: shellOpt(seg, "name", "n"), cwd: shellOpt(seg, "cwd", "c") });
  }
  return out;
}

function foldLine(scan: Scan, line: string): void {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;

  // A <task-notification> can ride on a queue-operation (.content), an attachment
  // (.attachment.prompt) or a delivered user message. Take the string that has it.
  if (line.includes("<task-notification>")) {
    const cands: unknown[] = [o.content, o.attachment?.prompt];
    const mc = o.message?.content;
    if (typeof mc === "string") cands.push(mc);
    else if (Array.isArray(mc)) for (const b of mc) if (b?.type === "text") cands.push(b.text);
    for (const c of cands) {
      if (typeof c !== "string" || !c.includes("<task-notification>")) continue;
      const id = RX_TASK_ID.exec(c)?.[1];
      if (!id) continue;
      const prev = scan.notifs.get(id);
      const n: Notif = {
        taskId: id,
        toolUseId: RX_TOOL_USE_ID.exec(c)?.[1] || null,
        status: (RX_STATUS.exec(c)?.[1] || "").trim() || "unknown",
        summary: (RX_SUMMARY.exec(c)?.[1] || "").trim() || null,
        result: (RX_RESULT.exec(c)?.[1] || "").trim() || null,
        ts,
      };
      if (!prev || n.ts >= prev.ts) scan.notifs.set(id, n); // last notification wins
      break;
    }
  }

  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "Bash") {
        const cmd = String(b.input?.command ?? "");
        const invs = cmd.includes("claude-spawn") ? spawnInvocations(cmd) : [];
        if (invs.length) {
          const calls = invs.map((iv) => ({ toolUseId: String(b.id), name: iv.name, cwd: iv.cwd, ts, printed: null as string | null }));
          for (const c of calls) scan.spawns.push(c);
          scan.spawnByToolUse.set(String(b.id), calls);
        }
      }
    }
  }

  if (o.type === "user") {
    // The launch ack for an async Agent / Workflow carries the linkage we want. NOT a completion:
    // its status is "async_launched" and it lands the instant the tool is called.
    const tur = o.toolUseResult;
    const trIds: string[] = [];
    if (Array.isArray(o.message?.content)) for (const b of o.message.content) if (b?.type === "tool_result" && b.tool_use_id) trIds.push(String(b.tool_use_id));
    if (tur && typeof tur === "object") {
      const toolUseId = trIds[0] || "";
      if (typeof tur.agentId === "string" && tur.agentId && !tur.runId) {
        scan.agents.set(tur.agentId, { toolUseId, description: typeof tur.description === "string" ? tur.description : null, model: typeof tur.resolvedModel === "string" ? tur.resolvedModel : null, ts });
      }
      if (typeof tur.runId === "string" && RE_RUN.test(tur.runId)) {
        scan.workflows.set(tur.runId, { toolUseId, taskId: String(tur.taskId || ""), workflowName: typeof tur.workflowName === "string" ? tur.workflowName : null, summary: typeof tur.summary === "string" ? tur.summary : null, ts });
      }
    }
    // Attach a claude-spawn Bash call's stdout (it prints the tmux session name = the tab id).
    for (const id of trIds) {
      const calls = scan.spawnByToolUse.get(id);
      if (!calls || calls.every((c) => c.printed || c.name)) continue;
      let out = "";
      if (Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b?.type !== "tool_result" || b.tool_use_id !== id) continue;
          const c = b.content;
          out = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : "")).join("\n") : "";
        }
      }
      // claude-spawn prints ONLY the session name on success. Trust stdout for the GENERATED
      // shape only (--name, when given, is already the authoritative id), so an unrelated word
      // printed by the same command can never be mistaken for a tab. Generated names are handed
      // out in invocation order to the calls that had no --name.
      const printed = out.split("\n").map((x) => x.trim()).filter((x) => RE_GENERATED_NAME.test(x));
      let pi = 0;
      for (const c of calls) if (!c.name && !c.printed && pi < printed.length) c.printed = printed[pi++];
    }
  }
}

// Scan the parent transcript, incrementally. Transcripts are append-only in normal operation, so
// a grown file only needs its new bytes folded in (the fold is order-independent for everything we
// collect). A SHRUNK file means the transcript was rewound (the /app edit-and-fork path does that),
// so we rescan from scratch.
async function scanParent(path: string): Promise<Scan> {
  const st = statOr(path);
  if (!st) return newScan();
  const size = st.size;
  let scan = scanCache.get(path);
  if (!scan || size < scan.size) { scan = newScan(); }
  if (size === scan.scanned) return scan;
  let from = scan.scanned;
  if (size - from > MAX_PARENT_SCAN_BYTES) { from = size - MAX_PARENT_SCAN_BYTES; scan = newScan(); scan.partial = true; }
  let text = "";
  try { text = await Bun.file(path).slice(from, size).text(); } catch { return scan; }
  if (from > scan.scanned) {
    const nl = text.indexOf("\n"); // we started mid-line: drop the partial head
    text = nl < 0 ? "" : text.slice(nl + 1);
    from += nl < 0 ? text.length : nl + 1;
  }
  const lastNl = text.lastIndexOf("\n"); // only fold COMPLETE lines; a half-written tail waits
  const complete = lastNl < 0 ? "" : text.slice(0, lastNl);
  for (const line of complete.split("\n")) if (line.trim()) foldLine(scan, line);
  scan.scanned = from + (lastNl < 0 ? 0 : lastNl + 1);
  scan.size = size;
  scanCache.set(path, scan);
  return scan;
}
// #endregion

// #region ~/.claude/sessions/*.json  (the only place a spawned tab's own identity is recorded)
interface SessionRec { pid: number; sessionId: string; cwd: string | null; name: string | null; nameSource: string | null; tmux: string | null; status: string | null; startedAt: number | null }

function readSessions(ctx: SpawnedCtx): SessionRec[] {
  const dir = join(ctx.claudeDir, "sessions");
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return []; }
  const out: SessionRec[] = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue; // <pid>.json only; ignore the .key siblings
    let o: any;
    try { o = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!o || typeof o.sessionId !== "string") continue;
    out.push({
      pid: Number(o.pid) || 0,
      sessionId: o.sessionId,
      cwd: typeof o.cwd === "string" ? o.cwd : null,
      name: typeof o.name === "string" ? o.name : null,
      nameSource: typeof o.nameSource === "string" ? o.nameSource : null,
      tmux: typeof o.tmux === "string" ? o.tmux : null,
      status: typeof o.status === "string" ? o.status : null,
      startedAt: Number(o.startedAt) || null,
    });
  }
  return out;
}

// claude-spawn's tmux session name IS the tab id AND the spawned Claude's --name, so either
// field can carry it. Newest match wins (a name can be reused after a tab is closed).
function findSessionByName(recs: SessionRec[], name: string): SessionRec | null {
  let best: SessionRec | null = null;
  for (const r of recs) {
    const tmuxName = r.tmux ? r.tmux.split(":")[0] : null;
    if (r.name !== name && tmuxName !== name) continue;
    if (!best || (r.startedAt || 0) > (best.startedAt || 0)) best = r;
  }
  return best;
}
const pidAlive = (pid: number) => pid > 0 && existsSync(`/proc/${pid}`);
// #endregion

// #region status inference
// One place, so the route and the report agree. `notif` is the authoritative signal; mtime is the
// fallback while a notification has not been written yet.
function inferStatus(notif: Notif | undefined, mtime: number, now: number, hasData: boolean): { status: SpawnedStatus; from: string } {
  if (notif) {
    const s = notif.status.toLowerCase();
    if (s === "completed" || s === "success" || s === "done") return { status: "finished", from: `parent transcript task-notification status=${notif.status}` };
    if (s === "running" || s === "in_progress") return { status: "running", from: `parent transcript task-notification status=${notif.status}` };
    return { status: "failed", from: `parent transcript task-notification status=${notif.status}` };
  }
  if (!hasData) return { status: "running", from: "launched (meta sidecar written) but nothing appended yet" };
  const mins = Math.round((now - mtime) / 60000);
  if (now - mtime < STALE_MS) return { status: "running", from: `no completion notification in the parent transcript yet, and the transcript was written ${Math.round((now - mtime) / 1000)}s ago` };
  return { status: "unknown", from: `no completion notification in the parent transcript, and no write for ${mins} min (interrupted, or the parent never recorded the result)` };
}
const cut = (s: unknown, n = 400) => { const t = typeof s === "string" ? s.trim() : ""; return t ? (t.length > n ? t.slice(0, n) + "…" : t) : null; };
// #endregion

// #region list
export async function listSpawned(ctx: SpawnedCtx, sessionId: string): Promise<SpawnedList | { error: string }> {
  if (!RE_SESSION.test(sessionId)) return { error: "bad session id" };
  const loc = locate(ctx, sessionId);
  if (!loc) return { error: "not found" };
  const now = Date.now();
  const warnings: string[] = [];
  const scan = await scanParent(loc.transcript);
  if (scan.partial) warnings.push("the parent transcript is larger than the scan cap, so only its most recent 32 MB was scanned for linkage and completion signals; very old spawned work may be missing");
  const items: SpawnedItem[] = [];

  // --- 1. subagents: driven by the tiny .meta.json sidecars + stat(). The transcripts themselves
  //        (260-610 KB each) are never opened here.
  const subDir = join(loc.sessionDir, "subagents");
  let subFiles: string[] = [];
  try { subFiles = readdirSync(subDir); } catch { subFiles = []; }
  for (const f of subFiles) {
    const m = /^agent-([A-Za-z0-9]{4,64})\.meta\.json$/.exec(f);
    if (!m) continue;
    const agentId = m[1];
    let meta: any = {};
    try { meta = JSON.parse(await Bun.file(guarded(ctx.dataDir, join(subDir, f))).text()); } catch { meta = {}; }
    const jsonl = guarded(ctx.dataDir, join(subDir, `agent-${agentId}.jsonl`));
    const stJ = statOr(jsonl);
    const stM = statOr(join(subDir, f));
    const notif = scan.notifs.get(agentId);
    const mtime = stJ?.mtimeMs ?? stM?.mtimeMs ?? 0;
    const inf = inferStatus(notif, mtime, now, !!stJ && stJ.size > 0);
    const startedAt = stM?.mtimeMs ?? null; // the sidecar is written at launch
    const endedAt = inf.status === "finished" || inf.status === "failed" ? notif?.ts || mtime : null;
    items.push({
      key: `sub:${agentId}`,
      kind: "subagent",
      label: String(meta.description || scan.agents.get(agentId)?.description || `agent ${agentId.slice(0, 8)}`),
      detail: String(meta.agentType || "subagent"),
      toolUseId: (typeof meta.toolUseId === "string" && meta.toolUseId) || scan.agents.get(agentId)?.toolUseId || null,
      status: inf.status,
      statusFrom: inf.from,
      startedAt,
      endedAt,
      durationMs: startedAt && endedAt && endedAt > startedAt ? endedAt - startedAt : null,
      mtime,
      bytes: stJ?.size ?? 0,
      hasTranscript: !!stJ && stJ.size > 0,
      resultPreview: cut(notif?.result || notif?.summary),
    });
  }

  // --- 2. workflows: the union of terminal run files and live run dirs. A run dir with no
  //        wf_<runId>.json is a run still in flight.
  const wfJsonDir = join(loc.sessionDir, "workflows");
  const wfRunRoot = join(loc.sessionDir, "subagents", "workflows");
  const runIds = new Set<string>();
  try { for (const f of readdirSync(wfJsonDir)) { const m = /^(wf_[A-Za-z0-9-]{3,48})\.json$/.exec(f); if (m) runIds.add(m[1]); } } catch {}
  try { for (const d of readdirSync(wfRunRoot)) if (RE_RUN.test(d)) runIds.add(d); } catch {}
  let wfSeen = 0;
  for (const runId of [...runIds].sort()) {
    if (++wfSeen > MAX_WORKFLOWS) { warnings.push(`more than ${MAX_WORKFLOWS} workflow runs in this session; the rest were not listed`); break; }
    const item = await workflowItem(ctx, loc.sessionDir, runId, scan, now, warnings);
    if (item) items.push(item);
  }

  // --- 3. spawned tabs: derived from claude-spawn Bash calls in THIS transcript, then matched
  //        against ~/.claude/sessions/*.json by name. Nothing on disk stores the parent link.
  const recs = scan.spawns.length ? readSessions(ctx) : [];
  const seenTabs = new Set<string>();
  for (const call of scan.spawns) {
    // --name wins (it IS the tab id claude-spawn used); stdout covers the no-name case.
    const name = (call.name && RE_NAME.test(call.name) ? call.name : null) || (call.printed && RE_NAME.test(call.printed) ? call.printed : null);
    if (!name || seenTabs.has(name)) continue;
    seenTabs.add(name);
    const rec = findSessionByName(recs, name);
    const alive = rec ? pidAlive(rec.pid) : false;
    let bytes = 0, mtime = call.ts;
    if (rec) { const t = locate(ctx, rec.sessionId); const st = t ? statOr(t.transcript) : null; if (st) { bytes = st.size; mtime = st.mtimeMs; } }
    items.push({
      key: `tab:${name}`,
      kind: "tab",
      label: name,
      detail: rec?.cwd || call.cwd || null,
      toolUseId: call.toolUseId,
      status: rec ? (alive ? "running" : "finished") : "unknown",
      statusFrom: rec
        ? alive
          ? `~/.claude/sessions/${rec.pid}.json exists and /proc/${rec.pid} is alive${rec.status ? ` (session status=${rec.status})` : ""}`
          : `~/.claude/sessions/${rec.pid}.json exists but the process is gone (tab exited or was closed)`
        : "no ~/.claude/sessions entry matches this tab name, so it is no longer running and its session id could not be recovered",
      startedAt: rec?.startedAt ?? call.ts ?? null,
      endedAt: null,
      durationMs: null,
      mtime,
      bytes,
      hasTranscript: !!rec,
      resultPreview: null,
      tab: {
        name,
        sessionId: rec?.sessionId ?? null,
        tmuxSession: rec?.tmux ? rec.tmux.split(":")[0] : name,
        cwd: rec?.cwd || call.cwd || null,
        pid: rec?.pid ?? null,
        pidAlive: alive,
        nameSource: rec?.nameSource ?? null,
        linkage: "derived: this chat ran `claude-spawn` in a Bash tool call (tool_use " + call.toolUseId + "); nothing on disk records a parent session, so the match is by tab name",
      },
    });
  }
  if (!scan.spawns.length) warnings.push("no spawned tab is attributed to this chat: nothing on disk records which session spawned a tab, so the only link is a `claude-spawn` Bash call in this transcript, and there is none. A tab started any other way (the tab bar, POST /sessions/spawn from the UI) cannot be attributed to a chat at all.");

  // running first, then most recently active
  const rank = (s: SpawnedStatus) => (s === "running" ? 0 : s === "failed" ? 1 : s === "unknown" ? 2 : 3);
  items.sort((a, b) => rank(a.status) - rank(b.status) || b.mtime - a.mtime);
  const counts = { subagent: 0, workflow: 0, tab: 0 };
  for (const i of items) counts[i.kind]++;
  return { sessionId, items, counts, warnings };
}

async function workflowItem(ctx: SpawnedCtx, sessionDir: string, runId: string, scan: Scan, now: number, warnings: string[]): Promise<SpawnedItem | null> {
  if (!RE_RUN.test(runId)) return null;
  const jsonPath = guarded(ctx.dataDir, join(sessionDir, "workflows", `${runId}.json`));
  const runDir = guarded(ctx.dataDir, join(sessionDir, "subagents", "workflows", runId));
  const stJson = statOr(jsonPath);
  let run: any = null;
  if (stJson) {
    if (stJson.size > MAX_WF_JSON_BYTES) warnings.push(`workflow ${runId} run file is ${stJson.size} bytes, over the ${MAX_WF_JSON_BYTES} byte cap, so its phases and per-agent rows were not read`);
    else { try { run = JSON.parse(await Bun.file(jsonPath).text()); } catch { warnings.push(`workflow ${runId} run file did not parse as JSON`); } }
  }
  // journal.jsonl is appended live: one "started" per agent, one "result" per completion.
  const journal = guarded(ctx.dataDir, join(runDir, "journal.jsonl"));
  const started = new Set<string>();
  const results = new Map<string, string>();
  const stJ = statOr(journal);
  if (stJ) {
    try {
      for (const line of (await Bun.file(journal).text()).split("\n")) {
        if (!line.trim()) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (typeof o.agentId !== "string") continue;
        if (o.type === "started") started.add(o.agentId);
        else if (o.type === "result") results.set(o.agentId, typeof o.result === "string" ? o.result : JSON.stringify(o.result ?? null));
      }
    } catch {}
  }
  const link = scan.workflows.get(runId);
  const notif = link?.taskId ? scan.notifs.get(link.taskId) : undefined;
  const stDir = statOr(runDir);
  const mtime = Math.max(stJson?.mtimeMs ?? 0, stJ?.mtimeMs ?? 0, stDir?.mtimeMs ?? 0);

  // The run file is only written when the run TERMINATES, so its presence is itself the signal.
  let status: SpawnedStatus, from: string;
  if (run && typeof run.status === "string") {
    status = run.status === "completed" ? "finished" : "failed";
    from = `${runId}.json exists with status=${run.status} (that file is only written when the run terminates)`;
  } else if (stJson) {
    status = "unknown";
    from = `${runId}.json exists but could not be read, so its terminal status is unknown`;
  } else {
    const inf = inferStatus(notif, mtime, now, started.size > 0);
    status = inf.status;
    from = `no ${runId}.json yet (it is written only at the end of a run), so: ${inf.from}`;
  }

  const progress: any[] = Array.isArray(run?.workflowProgress) ? run.workflowProgress : [];
  const phaseRows = progress.filter((p) => p?.type === "workflow_phase").map((p) => ({ index: Number(p.index) || 0, title: String(p.title || "") }));
  const phases = phaseRows.length ? phaseRows : (Array.isArray(run?.phases) ? run.phases.map((p: any, i: number) => ({ index: i + 1, title: String(p?.title || "") })) : []);
  const rows: SpawnedAgentRow[] = [];
  const addRow = (agentId: string, p: any) => {
    if (!RE_AGENT.test(agentId)) return;
    const aj = guarded(ctx.dataDir, join(runDir, `agent-${agentId}.jsonl`));
    const sa = statOr(aj);
    const done = results.has(agentId) || p?.state === "done";
    rows.push({
      key: `wf:${runId}:${agentId}`,
      agentId,
      label: String(p?.label || `agent ${agentId.slice(0, 8)}`),
      phase: p?.phaseTitle ? String(p.phaseTitle) : null,
      phaseIndex: p?.phaseIndex != null ? Number(p.phaseIndex) : null,
      state: p?.state ? String(p.state) : done ? "done" : started.has(agentId) ? "running" : null,
      status: done ? "finished" : started.has(agentId) ? "running" : "unknown",
      model: p?.model ? String(p.model) : null,
      tokens: p?.tokens != null ? Number(p.tokens) : null,
      toolCalls: p?.toolCalls != null ? Number(p.toolCalls) : null,
      durationMs: p?.durationMs != null ? Number(p.durationMs) : null,
      lastTool: p?.lastToolName ? String(p.lastToolName) : null,
      promptPreview: cut(p?.promptPreview, 600),
      resultPreview: cut(p?.resultPreview ?? results.get(agentId), 600),
      bytes: sa?.size ?? 0,
      hasTranscript: !!sa && sa.size > 0,
      mtime: sa?.mtimeMs ?? 0,
    });
  };
  const seen = new Set<string>();
  for (const p of progress) {
    if (p?.type !== "workflow_agent" || typeof p.agentId !== "string") continue;
    seen.add(p.agentId); addRow(p.agentId, p);
  }
  // A live run has no run file yet, so the journal (and the agent-*.jsonl files) are all we have.
  for (const a of started) if (!seen.has(a)) { seen.add(a); addRow(a, null); }
  try { for (const f of readdirSync(runDir)) { const m = /^agent-([A-Za-z0-9]{4,64})\.jsonl$/.exec(f); if (m && !seen.has(m[1])) { seen.add(m[1]); addRow(m[1], null); } } } catch {}
  rows.sort((a, b) => (a.phaseIndex ?? 0) - (b.phaseIndex ?? 0) || a.label.localeCompare(b.label));

  const agentsDone = rows.filter((r) => r.status === "finished").length;
  const startedAt = Number(run?.startTime) || (stDir?.birthtimeMs || null) || link?.ts || null;
  const durationMs = Number(run?.durationMs) || null;
  return {
    key: `wf:${runId}`,
    kind: "workflow",
    label: String(run?.summary || link?.summary || run?.workflowName || link?.workflowName || runId),
    detail: String(run?.workflowName || link?.workflowName || "workflow"),
    toolUseId: link?.toolUseId || notif?.toolUseId || null,
    status,
    statusFrom: from,
    startedAt,
    endedAt: startedAt && durationMs ? startedAt + durationMs : null,
    durationMs,
    mtime,
    bytes: stJson?.size ?? 0,
    hasTranscript: true, // synthesized from the run file + journal (see workflowRunEvents)
    resultPreview: cut(run?.error || (run?.result != null ? JSON.stringify(run.result) : null) || notif?.summary),
    workflow: {
      runId,
      workflowName: run?.workflowName ? String(run.workflowName) : link?.workflowName || null,
      scriptPath: run?.scriptPath ? String(run.scriptPath) : null,
      summary: run?.summary ? String(run.summary) : link?.summary || null,
      phases,
      agentCount: run?.agentCount != null ? Number(run.agentCount) : rows.length || null,
      agentsDone,
      agentsRunning: rows.filter((r) => r.status === "running").length,
      totalTokens: run?.totalTokens != null ? Number(run.totalTokens) : null,
      totalToolCalls: run?.totalToolCalls != null ? Number(run.totalToolCalls) : null,
      error: run?.error ? String(run.error) : null,
      result: run?.result ?? null,
      agents: rows,
      live: !stJson,
    },
  };
}
// #endregion

// #region transcript: any one spawned item -> the SAME AppEvent array /app/api/conversation returns
export interface SpawnedTranscript {
  sessionId: string;
  key: string;
  kind: SpawnedKind;
  label: string;
  detail: string | null;
  cwd: string | null;
  events: AppEvent[];
  delta: boolean;
  evTotal: number; // length of the FULL (post-cap) array, i.e. the cursor to send back as ?since=
  truncated: boolean; // the head was dropped at MAX_EVENTS; ?since= is disabled while true
  bytes: number;
  synthesized: boolean; // true = built from run metadata, not a real transcript (workflow runs only)
  note: string | null; // anything the caller should tell the user about this view
  linkedSessionId?: string | null; // spawned tabs: the ordinary conversation id, so the UI can deep-link
}

// Parse a key into validated parts. Rejects anything that is not one of the four shapes, so no
// client string ever reaches join() unchecked.
function parseKey(key: string): { kind: SpawnedKind; agentId?: string; runId?: string; name?: string } | null {
  let m = /^sub:([A-Za-z0-9]{4,64})$/.exec(key);
  if (m) return { kind: "subagent", agentId: m[1] };
  m = /^wf:(wf_[A-Za-z0-9-]{3,48}):([A-Za-z0-9]{4,64})$/.exec(key);
  if (m) return { kind: "workflow", runId: m[1], agentId: m[2] };
  m = /^wf:(wf_[A-Za-z0-9-]{3,48})$/.exec(key);
  if (m) return { kind: "workflow", runId: m[1] };
  m = /^tab:([A-Za-z0-9_-]{1,64})$/.exec(key);
  if (m) return { kind: "tab", name: m[1] };
  return null;
}

// Apply the event cap. We keep the TAIL because that is where the answer is, and prepend a notice
// so the UI never silently shows a partial conversation.
function capEvents(events: AppEvent[]): { events: AppEvent[]; truncated: boolean } {
  if (events.length <= MAX_EVENTS) return { events, truncated: false };
  const dropped = events.length - MAX_EVENTS;
  return {
    events: [{ t: "notice", kind: "info", text: `${dropped} earlier events were dropped: this transcript is longer than the ${MAX_EVENTS}-event view cap. Showing the most recent ${MAX_EVENTS}.` } as AppEvent, ...events.slice(dropped)],
    truncated: true,
  };
}

// Read one .jsonl through the shared replayTranscript(), with the size cap enforced by stat()
// BEFORE any read (replayTranscript reads the whole file).
async function readJsonl(path: string): Promise<{ events: AppEvent[]; bytes: number }> {
  const st = statOr(path);
  if (!st) return { events: [{ t: "error", message: "no transcript file on disk for this item" } as AppEvent], bytes: 0 };
  if (st.size > MAX_TRANSCRIPT_BYTES) {
    return { events: [{ t: "error", message: `transcript is ${(st.size / 1048576).toFixed(1)} MB, over the ${MAX_TRANSCRIPT_BYTES / 1048576} MB read cap` } as AppEvent], bytes: st.size };
  }
  return { events: await replayTranscript(path), bytes: st.size };
}

// A workflow RUN is not a conversation, so there is no transcript to replay. Everything below comes
// straight out of wf_<runId>.json + journal.jsonl, mapped onto the events the UI already renders:
// each agent becomes an Agent tool_use + tool_result pair (its promptPreview / resultPreview) plus an
// agent_progress event carrying its real token/tool/duration numbers. Nothing is invented: a field
// the run file does not have is simply absent. Drill into an agent with its own `wf:<runId>:<id>` key
// for that agent's REAL transcript.
function workflowRunEvents(item: SpawnedItem): AppEvent[] {
  const w = item.workflow!;
  const ev: AppEvent[] = [];
  const head = [
    w.summary || w.workflowName || w.runId,
    w.scriptPath ? `script: ${w.scriptPath}` : null,
    `run: ${w.runId}${w.live ? " (still running)" : ""}`,
  ].filter(Boolean).join("\n");
  ev.push({ t: "user", text: head });
  if (w.live) ev.push({ t: "notice", kind: "info", text: "This run has not finished, so only the live journal is available: phase titles, totals and per-agent progress numbers are written to wf_<runId>.json when the run ends." });
  const byPhase = new Map<number, SpawnedAgentRow[]>();
  for (const a of w.agents) { const k = a.phaseIndex ?? 0; if (!byPhase.has(k)) byPhase.set(k, []); byPhase.get(k)!.push(a); }
  const phaseTitle = (i: number) => w.phases.find((p) => p.index === i)?.title || (i ? `Phase ${i}` : "Agents");
  for (const i of [...byPhase.keys()].sort((a, b) => a - b)) {
    const rows = byPhase.get(i)!;
    ev.push({ t: "notice", kind: "info", text: `${phaseTitle(i)} — ${rows.length} agent${rows.length === 1 ? "" : "s"}` });
    for (const a of rows) {
      const id = `wfagent_${a.agentId}`;
      ev.push({ t: "tool_use", id, name: "Agent", input: { description: a.label, subagent_type: "workflow-subagent", model: a.model, prompt: a.promptPreview || "" } });
      ev.push({ t: "agent_progress", id, tokens: a.tokens ?? undefined, toolUses: a.toolCalls ?? undefined, durationMs: a.durationMs ?? undefined, lastTool: a.lastTool ?? undefined, subagentType: "workflow-subagent", description: a.label });
      if (a.resultPreview != null) ev.push({ t: "tool_result", id, content: a.resultPreview, isError: false });
      else if (a.status === "running") ev.push({ t: "notice", kind: "task", text: `${a.label}: still running` });
      else ev.push({ t: "tool_result", id, content: "(no result recorded in the run file or journal)", isError: false });
    }
  }
  if (w.error) ev.push({ t: "error", message: w.error });
  const tail: string[] = [];
  if (w.agentCount != null) tail.push(`${w.agentsDone}/${w.agentCount} agents done`);
  if (w.totalTokens != null) tail.push(`${w.totalTokens.toLocaleString()} tokens`);
  if (w.totalToolCalls != null) tail.push(`${w.totalToolCalls} tool calls`);
  if (item.durationMs) tail.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (w.result != null) tail.push(`result ${JSON.stringify(w.result).slice(0, 300)}`);
  if (tail.length) ev.push({ t: "text", text: tail.join(" · ") });
  return ev;
}

export async function getSpawnedTranscript(ctx: SpawnedCtx, sessionId: string, key: string, since: number | null): Promise<SpawnedTranscript | { error: string; status?: number }> {
  if (!RE_SESSION.test(sessionId)) return { error: "bad session id", status: 400 };
  const parsed = parseKey(key);
  if (!parsed) return { error: "bad key", status: 400 };
  const loc = locate(ctx, sessionId);
  if (!loc) return { error: "not found", status: 404 };

  let events: AppEvent[] = [];
  let bytes = 0, synthesized = false, note: string | null = null, linkedSessionId: string | null | undefined;
  let label = key, detail: string | null = null, cwd: string | null = null;

  if (parsed.kind === "subagent") {
    const dir = join(loc.sessionDir, "subagents");
    const p = guarded(ctx.dataDir, join(dir, `agent-${parsed.agentId}.jsonl`));
    let meta: any = {};
    try { meta = JSON.parse(readFileSync(guarded(ctx.dataDir, join(dir, `agent-${parsed.agentId}.meta.json`)), "utf8")); } catch {}
    label = String(meta.description || `agent ${parsed.agentId!.slice(0, 8)}`);
    detail = String(meta.agentType || "subagent");
    const r = await readJsonl(p); events = r.events; bytes = r.bytes;
  } else if (parsed.kind === "workflow" && parsed.agentId) {
    const dir = guarded(ctx.dataDir, join(loc.sessionDir, "subagents", "workflows", parsed.runId!));
    const p = guarded(ctx.dataDir, join(dir, `agent-${parsed.agentId}.jsonl`));
    let meta: any = {};
    try { meta = JSON.parse(readFileSync(guarded(ctx.dataDir, join(dir, `agent-${parsed.agentId}.meta.json`)), "utf8")); } catch {}
    detail = String(meta.agentType || "workflow-subagent");
    label = `${parsed.runId} · agent ${parsed.agentId!.slice(0, 8)}`;
    // The readable label lives in the run file's progress rows, not the agent's meta sidecar.
    const list = await listSpawned(ctx, sessionId);
    if (!("error" in list)) {
      const wf = list.items.find((i) => i.key === `wf:${parsed.runId}`);
      const row = wf?.workflow?.agents.find((a) => a.agentId === parsed.agentId);
      if (row) label = row.label;
    }
    const r = await readJsonl(p); events = r.events; bytes = r.bytes;
  } else if (parsed.kind === "workflow") {
    const list = await listSpawned(ctx, sessionId);
    if ("error" in list) return { error: list.error, status: 404 };
    const item = list.items.find((i) => i.key === key);
    if (!item || !item.workflow) return { error: "workflow run not found for this session", status: 404 };
    label = item.label; detail = item.detail; bytes = item.bytes; synthesized = true;
    note = "A workflow run has no transcript of its own. This view is built from wf_<runId>.json and journal.jsonl: agent labels, prompt/result previews and per-agent token, tool and duration counts. Open an individual agent for its full transcript.";
    events = workflowRunEvents(item);
  } else {
    // tab: resolve the name to a live session record, then replay its ORDINARY transcript.
    const rec = findSessionByName(readSessions(ctx), parsed.name!);
    label = parsed.name!;
    if (!rec) return { error: `no running session named "${parsed.name}"; a spawned tab is only linkable while its ~/.claude/sessions entry exists, and nothing on disk records which chat spawned it`, status: 404 };
    linkedSessionId = rec.sessionId;
    cwd = rec.cwd; detail = rec.cwd;
    const t = locate(ctx, rec.sessionId);
    if (!t) return { error: "the tab's session has no transcript yet", status: 404 };
    const r = await readJsonl(t.transcript); events = r.events; bytes = r.bytes;
    note = "This is an ordinary conversation; it also appears in the normal conversation list under session id " + rec.sessionId + ".";
  }

  const capped = capEvents(events);
  // ?since= is a plain fold over an append-only file, so events[0..N] are stable and sending the
  // tail is equivalent to sending everything. It is NOT valid once the head has been dropped by the
  // event cap (indices shift as the file grows) or for a synthesized workflow view (rebuilt each
  // call, not append-only), so both force a full send with delta:false.
  const canDelta = !capped.truncated && !synthesized;
  const delta = canDelta && since != null && Number.isInteger(since) && since >= 0 && since <= capped.events.length;
  return {
    sessionId, key, kind: parsed.kind, label, detail, cwd,
    events: delta ? capped.events.slice(since!) : capped.events,
    delta, evTotal: capped.events.length, truncated: capped.truncated,
    bytes, synthesized, note, linkedSessionId,
  };
}
// #endregion
