// agents.tsx — self-contained "subagent & workflow activity" card for the /app chat surface.
//
// When Claude spawns a subagent (the Agent tool) or launches a Workflow, the plain tool card is a
// poor fit: the interesting bits are the agent's type + brief, whether it is still running, and its
// final write-up. This module detects those tool calls and renders a richer, collapsible activity
// card that visually matches the existing .tool-* cards. It imports only React + marked so it can be
// dropped in without touching the rest of the app, and injects its own CSS (like voice.tsx does).
//
// Data available today, all verified against real transcripts on this box (CLI 2.1.2xx):
//   * a subagent is a `tool_use` named "Agent" (NOT "Task" — that was wrong, and it meant none of
//     this ever rendered) with input { subagent_type, description, prompt }.
//   * a workflow is a `tool_use` named "Workflow" with input { description?, script | scriptPath,
//     args? }. There are no phases in the input; the phase list comes from the server.
//   * both are ASYNC. The paired `tool_result` is a LAUNCH ACK that arrives immediately
//     ("Async agent launched successfully… agentId: <hex>" / "Workflow launched in background.
//     Task ID: … Transcript dir: …/wf_<runId>"), so "the result arrived" does NOT mean finished.
//     parseLaunchAck below reads the ack for the agentId / runId, which is also the server's
//     transcript key, and keeps the item in the running state.
//   * completion arrives as a system task_notification, surfaced by app-runner as a `notice` event
//     that is NOT correlated to the tool_use id. So the page can see that an agent started but
//     never that it finished — that is what /app/api/spawned is for (see spawnview.tsx).

import React, { useCallback, useMemo, useState } from "react";
import { marked } from "marked";
import {
  SpawnSheet, useSpawnedList, KindIcon, KIND_LABEL, spawnMeta, normPhases,
  registerTranscriptRenderer,
  type SpawnedEntry, type SpawnKind, type SpawnPhase, type TranscriptRenderer, type TranscriptBlockProps,
} from "./spawnview";

// Re-exported so main.tsx has ONE import for this feature.
export { registerTranscriptRenderer };
export type { SpawnedEntry, SpawnKind, SpawnPhase, TranscriptRenderer, TranscriptBlockProps };

// #region detection
// A tool_use as the chat store holds it. Structurally a superset of main.tsx's
// `Extract<Item, { kind: "tool" }>`, so a tool item can be passed straight through.
export interface AgentToolUse {
  id?: string;
  name: string;
  input: unknown;
}

// The paired tool_result. main.tsx merges the result onto the same tool item, so the convenience
// wrapper below reads it from there; the raw card also accepts it split out.
export interface AgentToolResult {
  content: unknown;
  isError?: boolean;
}

export type AgentKind = "task" | "workflow";

export interface TaskFields {
  kind: "task";
  subagentType?: string;
  description?: string;
  prompt?: string;
}

export interface WorkflowPhase {
  name: string;
  status?: "pending" | "running" | "done" | "failed";
}

export interface WorkflowFields {
  kind: "workflow";
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

export type AgentFields = TaskFields | WorkflowFields;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// True for the subagent tool. This build of Claude Code names it "Agent"; "Task" is the older name
// and still accepted so old transcripts render the same way.
function isTaskTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

// A Workflow launch: a tool named "Workflow" (any casing / mcp prefix) whose input carries
// workflow-shaped fields. Kept deliberately narrow so ordinary tools never masquerade as workflows.
function isWorkflowTool(name: string, input: unknown): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  if (!/(^|_)workflow($|_|s?$)/i.test(bare)) return false;
  const o = asRecord(input);
  // A real Workflow call carries `script` or `scriptPath` (+ optional args/description). The older
  // phases/steps/name shapes stay accepted.
  return "script" in o || "scriptPath" in o || "args" in o
    || "phases" in o || "steps" in o || "workflow" in o || "workflow_name" in o || "name" in o;
}

// Classify a tool_use. Returns the agent kind, or null for an ordinary tool (render the plain card).
export function isAgentTool(name: string, input: unknown): AgentKind | null {
  if (isTaskTool(name)) return "task";
  if (isWorkflowTool(name, input)) return "workflow";
  return null;
}

// Pull the display fields out of the tool input. Safe on unknown/missing shapes.
export function parseAgentTool(name: string, input: unknown): AgentFields | null {
  const kind = isAgentTool(name, input);
  if (!kind) return null;
  const o = asRecord(input);
  if (kind === "task") {
    return { kind, subagentType: str(o.subagent_type) ?? str(o.subagentType), description: str(o.description), prompt: str(o.prompt) };
  }
  const rawPhases = Array.isArray(o.phases) ? o.phases : Array.isArray(o.steps) ? o.steps : [];
  const phases: WorkflowPhase[] = rawPhases
    .map((p): WorkflowPhase | null => {
      if (typeof p === "string") return p.trim() ? { name: p } : null;
      const po = asRecord(p);
      const nm = str(po.name) ?? str(po.title) ?? str(po.phase) ?? str(po.step);
      if (!nm) return null;
      const s = str(po.status);
      const status = s === "pending" || s === "running" || s === "done" || s === "failed" ? s : undefined;
      return { name: nm, status };
    })
    .filter((p): p is WorkflowPhase => p != null);
  return {
    kind,
    name: str(o.workflow_name) ?? str(o.name) ?? str(o.workflow) ?? scriptName(o),
    description: str(o.description),
    phases,
  };
}
// The workflow script is a JS module opening with `export const meta = { name: '...' }`; that name is
// the only human label a scriptPath-only call has. Falls back to the file name.
function scriptName(o: Record<string, unknown>): string | undefined {
  const src = str(o.script);
  const m = src && src.match(/name\s*:\s*["'`]([^"'`]{1,80})["'`]/);
  if (m) return m[1];
  const path = str(o.scriptPath);
  if (path) { const base = path.replace(/\/+$/, "").split("/").pop(); if (base) return base.replace(/\.[jt]s$/, ""); }
  return undefined;
}
// #endregion

// #region helpers
// Mirror of main.tsx's contentToText so this module stays standalone (no cross-import).
function contentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : asRecord(b).type === "text" ? String(asRecord(b).text ?? "") : String(asRecord(b).text ?? ""))).join("\n");
  if (c == null) return "";
  return JSON.stringify(c, null, 2);
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

// Rough token estimate from prompt + result length (no per-subagent usage is on the wire).
function estTokens(prompt: string, result: string): number {
  return Math.round((prompt.length + result.length) / 4);
}

// Cheap markdown sniff: render as rich text only when it clearly looks like markdown, else <pre>.
function looksLikeMarkdown(s: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)/.test(s) || /\*\*[^*]+\*\*/.test(s) || /\[[^\]]+\]\([^)]+\)/.test(s);
}

const CHEV = (
  <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function AgentIcon({ workflow }: { workflow: boolean }) {
  if (workflow) {
    // stacked layers = a multi-phase workflow
    return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></svg>);
  }
  // little robot = a subagent
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 3h8" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></svg>);
}
// #endregion

// #region launch acks
// Both async launches answer immediately with a metadata blob, not a result. Reading it gives the
// two things the UI needs: proof the thing is RUNNING (not done), and the id the server uses as the
// transcript key. Exact strings, from real transcripts:
//   "Async agent launched successfully. …\nagentId: a9bf911346dd0f235 (internal ID - do not mention…"
//   "Workflow launched in background. Task ID: wev6umjyi\nSummary: …\nTranscript dir: …/wf_4daa6edd-3fe"
// The agentId is internal, so it is used ONLY as a lookup key and never rendered.
export interface LaunchAck {
  agentId?: string;   // subagent -> server key "sub:<agentId>"
  runId?: string;     // workflow -> server key "wf:<runId>"
  summary?: string;   // workflow's own one-line summary
}

export function parseLaunchAck(text: string): LaunchAck | null {
  if (!text) return null;
  if (/^Async agent launched/i.test(text) || /\bagentId:\s*[0-9a-f]{8,}/i.test(text)) {
    const m = text.match(/\bagentId:\s*([0-9a-zA-Z]{8,64})/);
    return { agentId: m ? m[1] : undefined };
  }
  if (/^Workflow launched/i.test(text) || /\bTranscript dir:.*\bwf_/i.test(text)) {
    const run = text.match(/\b(wf_[A-Za-z0-9-]{3,48})/);
    const sum = text.match(/^Summary:\s*(.+)$/m);
    return { runId: run ? run[1] : undefined, summary: sum ? sum[1].trim() : undefined };
  }
  return null;
}
// #endregion

// #region card
export interface AgentProgress { tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string }
export interface AgentActivityCardProps {
  toolUse: AgentToolUse;
  toolResult?: AgentToolResult;
  running?: boolean; // explicit override; defaults to "no result yet"
  defaultOpen?: boolean;
  progress?: AgentProgress; // live subagent progress (real tokens/tools/duration) when available
}

// The rich activity card. Header: agent/workflow icon, type + description (or workflow name), a
// status pill (Running… / Done / Failed) and an estimated token count. Body (collapsible): the task
// prompt, an optional phase list, and the final result output (markdown-rendered when it looks like
// markdown, else preformatted).
export function AgentActivityCard({ toolUse, toolResult, running, defaultOpen, progress }: AgentActivityCardProps) {
  injectAgentCss();
  const fields = useMemo(() => parseAgentTool(toolUse.name, toolUse.input), [toolUse.name, toolUse.input]);
  const [open, setOpen] = useState(!!defaultOpen);

  // Fallback: not actually an agent tool (defensive) — nothing to enrich.
  if (!fields) return null;

  const rawResult = toolResult !== undefined ? contentToText(toolResult.content) : "";
  // The ack is internal launch metadata, not output: the agent is still working, and pasting the blob
  // (it carries an id it explicitly asks us not to surface) would be worse than useless.
  const ack = parseLaunchAck(rawResult);
  const isRunning = running ?? (toolResult === undefined || !!ack);
  const failed = !isRunning && !!toolResult?.isError;
  const status: "running" | "done" | "failed" = isRunning ? "running" : failed ? "failed" : "done";
  const statusLabel = isRunning ? "Running" : failed ? "Failed" : "Done";

  const isWorkflow = fields.kind === "workflow";
  const title = isWorkflow ? fields.name || "Workflow" : fields.subagentType || "subagent";
  const subtitle = fields.description || (ack && ack.summary) || "";
  const prompt = fields.kind === "task" ? fields.prompt || "" : "";
  const resultText = ack ? "" : rawResult;
  const est = resultText || prompt ? estTokens(prompt, resultText) : 0;

  const resultHtml = useMemo(() => {
    if (!resultText || !looksLikeMarkdown(resultText)) return null;
    try { return marked.parse(resultText) as string; } catch { return null; }
  }, [resultText]);

  const phases = fields.kind === "workflow" ? fields.phases : [];

  return (
    <div className={"agent-card" + (open ? " open" : "") + (isWorkflow ? " agent-wf" : "")}>
      <button className="agent-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {CHEV}
        <span className="agent-ic"><AgentIcon workflow={isWorkflow} /></span>
        <span className="agent-kind">{isWorkflow ? "Workflow" : "Subagent"}</span>
        <span className="agent-title">{title}</span>
        {subtitle && <span className="agent-sub">{subtitle}</span>}
        <span className={"agent-pill agent-" + status}>
          {isRunning && <span className="agent-spin" />}
          {statusLabel}
        </span>
        {progress && (progress.tokens || progress.toolUses)
          ? <span className="agent-tok" title="Live: tokens · tools · elapsed">{fmtTokens(progress.tokens || 0)}{progress.toolUses ? ` · ${progress.toolUses} tools` : ""}{progress.durationMs ? ` · ${Math.round(progress.durationMs / 1000)}s` : ""}</span>
          : est > 0 ? <span className="agent-tok" title="Estimated tokens (brief + result)">~{fmtTokens(est)}</span> : null}
      </button>
      {open && (
        <div className="agent-body">
          {prompt && (<><div className="agent-label">Task brief</div><pre className="agent-pre">{prompt}</pre></>)}
          {phases.length > 0 && (
            <><div className="agent-label">Phases</div>
              <ol className="agent-phases">
                {phases.map((p, k) => {
                  const ps = p.status ?? "pending";
                  return (
                    <li key={k} className={"agent-phase agent-phase-" + ps}>
                      <span className={"agent-phase-dot agent-" + ps} />
                      <span className="agent-phase-name">{p.name}</span>
                      {p.status && <span className="agent-phase-status">{p.status}</span>}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {toolResult !== undefined && !ack ? (
            <>
              <div className="agent-label">{failed ? "Result (error)" : "Result"}</div>
              {resultHtml ? (
                <div className={"agent-result md" + (failed ? " agent-result-err" : "")} dangerouslySetInnerHTML={{ __html: resultHtml }} />
              ) : (
                <pre className={"agent-pre" + (failed ? " agent-pre-err" : "")}>{resultText || "(no output)"}</pre>
              )}
            </>
          ) : (
            <div className="agent-waiting">
              <span className="agent-spin" />
              {ack ? "Launched — running in the background. Open it from the strip above the composer to read its transcript." : "Working…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// #endregion

// #region convenience wrapper for main.tsx
// A tool item as main.tsx holds it: tool_use and its tool_result merged onto one object
// (result === undefined while the subagent is still running). Structurally matches
// `Extract<Item, { kind: "tool" }>`.
export interface MergedToolItem {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  progress?: AgentProgress; // live subagent progress merged on by main.tsx (agent_progress event)
}

// Drop-in replacement for <ToolCard> when the tool is a subagent/workflow. main.tsx can, in its
// item-render switch, check isAgentTool(it.name, it.input) and render this instead of <ToolCard>.
export function AgentToolCard({ it }: { it: MergedToolItem }) {
  const toolResult = it.result === undefined ? undefined : { content: it.result, isError: it.isError };
  // `running` is left to the card: it knows a launch ack is not a result.
  return <AgentActivityCard toolUse={{ id: it.id, name: it.name, input: it.input }} toolResult={toolResult} progress={it.progress} />;
}
// #endregion

// #region injected styles (kept out of styles.css so this stays a drop-in module; reuses the app vars)
let cssDone = false;
function injectAgentCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const css = `
  .agent-card{border:1px solid var(--line-2);background:var(--bg-2);border-radius:11px;margin:0 0 12px;overflow:hidden}
  .agent-card.agent-wf{border-color:color-mix(in srgb,var(--accent) 40%,var(--line-2))}
  .agent-head{display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;background:transparent;border:none;color:var(--text-2);font-size:13px;text-align:left;cursor:pointer}
  .agent-head:hover{background:var(--bg-3)}
  .agent-head .chev{transition:transform .15s;color:var(--text-3);flex:0 0 auto}
  .agent-card.open .agent-head .chev{transform:rotate(90deg)}
  .agent-ic{flex:0 0 auto;display:inline-flex;color:var(--accent)}
  .agent-kind{flex:0 0 auto;font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3)}
  .agent-title{flex:0 0 auto;font-family:var(--mono);font-weight:600;color:var(--text);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .agent-sub{color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .agent-pill{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
  .agent-pill.agent-running{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
  .agent-pill.agent-done{color:var(--success,#10B981);border-color:color-mix(in srgb,var(--success,#10B981) 45%,transparent);background:color-mix(in srgb,var(--success,#10B981) 12%,transparent)}
  .agent-pill.agent-failed{color:var(--danger,#EF4444);border-color:color-mix(in srgb,var(--danger,#EF4444) 45%,transparent);background:color-mix(in srgb,var(--danger,#EF4444) 12%,transparent)}
  .agent-tok{flex:0 0 auto;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}
  .agent-spin{width:10px;height:10px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:agent-spin .8s linear infinite;display:inline-block}
  @keyframes agent-spin{to{transform:rotate(360deg)}}
  .agent-body{padding:0 12px 12px}
  .agent-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin-top:10px}
  .agent-pre{background:#120f0c;border:1px solid var(--line-2);border-radius:9px;padding:10px 12px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:6px 0 0}
  .agent-pre-err{border-color:color-mix(in srgb,var(--danger,#EF4444) 55%,var(--line-2));color:var(--danger,#EF4444)}
  .agent-result{margin:6px 0 0;font-size:13.5px;line-height:1.55;color:var(--text)}
  .agent-result.agent-result-err{color:var(--danger,#EF4444)}
  .agent-result>:first-child{margin-top:0}
  .agent-result>:last-child{margin-bottom:0}
  .agent-waiting{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--text-3)}
  .agent-phases{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
  .agent-phase{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12.5px;color:var(--text-2)}
  .agent-phase-running{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  .agent-phase-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--text-3)}
  .agent-phase-dot.agent-running{background:var(--accent)}
  .agent-phase-dot.agent-done{background:var(--success,#10B981)}
  .agent-phase-dot.agent-failed{background:var(--danger,#EF4444)}
  .agent-phase-dot.agent-pending{background:var(--line)}
  .agent-phase-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .agent-phase-status{flex:0 0 auto;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)}
  .agent-phase-done .agent-phase-name{color:var(--text-3)}
  @media (prefers-reduced-motion:reduce){.agent-spin{animation:none}}
  `;
  const el = document.createElement("style");
  el.id = "agent-css";
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion

// #region live agents (kept for the older strip API)
export interface LiveAgent {
  id: string;                    // the tool_use id
  label: string;                 // description, or the subagent type, or a workflow name
  sub?: string;                  // secondary line (subagent type / phase summary)
  progress?: AgentProgress;
}

// The running subagents/workflows in a conversation. Now a thin view over localSpawned, so there is
// exactly one place that decides what "running" means (a launch ack is NOT a finish).
export function liveAgents(items: readonly unknown[]): LiveAgent[] {
  return localSpawned(items)
    .filter((e) => e.running && e.kind !== "tab")
    .map((e) => ({
      id: e.toolUseId || e.key,
      label: e.label,
      sub: e.sub,
      progress: { tokens: e.tokens, toolUses: e.toolUses, durationMs: e.durationMs, lastTool: e.lastTool },
    }));
}

// Back-compat shim: the original LiveAgent-based strip, now drawn by SpawnStrip so there is only one
// row renderer. New code should mount <SpawnedWork>, which wires the strip to the viewer.
export function AgentStatusStrip({ agents, onJump }: { agents: LiveAgent[]; onJump?: (id: string) => void }): React.JSX.Element | null {
  const entries = useMemo<SpawnedEntry[]>(() => agents.map((a) => ({
    key: "local:" + a.id, kind: "subagent" as SpawnKind, label: a.label, sub: a.sub,
    toolUseId: a.id, running: true, local: true,
    durationMs: a.progress?.durationMs, tokens: a.progress?.tokens, toolUses: a.progress?.toolUses, lastTool: a.progress?.lastTool,
  })), [agents]);
  return <SpawnStrip entries={entries} onOpen={onJump ? (e) => onJump(e.toolUseId || e.key) : undefined} />;
}
// #endregion

// #region local (in-page) discovery of every kind of spawned work
// Everything the OPEN CONVERSATION can tell us on its own, with no server round trip: the Task and
// Workflow tool cards, and the `claude-spawn` Bash calls that create a new terminal tab. This is
// what makes the strip work the instant a turn starts, and what keeps the viewer useful even when
// /app/api/spawned is not in the running build yet.
const CLAUDE_SPAWN_RE = /(^|[\s;&|(])claude-spawn(\s|$)/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// `claude-spawn --prompt "..." --name x --cwd y` prints the new tmux session name (= the terminal
// tab id) on stdout. Pull a readable label out of the command line, and a conversation id out of the
// output only if it really is one — the tab's /app session id is the server's job to resolve.
function parseSpawnTab(it: MergedToolItem): SpawnedEntry | null {
  const cmd = str(asRecord(it.input).command);
  if (!cmd || !CLAUDE_SPAWN_RE.test(cmd)) return null;
  const name = cmd.match(/(?:^|\s)(?:--name|-n)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const prompt = cmd.match(/(?:^|\s)(?:--prompt|-p)(?:=|\s+)(?:"([^"]*)"|'([^']*)')/);
  const cwd = cmd.match(/(?:^|\s)(?:--cwd|-c)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const label = (name && (name[1] || name[2] || name[3]))
    || (prompt && (prompt[1] || prompt[2]) ? (prompt[1] || prompt[2]).slice(0, 80) : undefined)
    || "Spawned tab";
  const out = it.result === undefined ? "" : contentToText(it.result).trim();
  const uuid = out.match(UUID_RE);
  const tabName = !uuid && out && out.length < 80 ? out.split(/\s+/).pop() : undefined;
  return {
    key: "local:" + it.id,
    kind: "tab",
    label,
    sub: [tabName, cwd && (cwd[1] || cwd[2] || cwd[3])].filter(Boolean).join(" · ") || undefined,
    toolUseId: it.id,
    sessionId: uuid ? uuid[0] : undefined,
    running: false, // the Bash call only STARTS the tab; the tab's own life is not this card's status
    failed: it.isError || undefined,
    brief: prompt ? prompt[1] || prompt[2] || undefined : undefined,
    local: true,
  };
}

// One SpawnedEntry per piece of spawned work in `items`, finished ones included, in the order they
// appear in the thread.
export function localSpawned(items: readonly unknown[]): SpawnedEntry[] {
  const out: SpawnedEntry[] = [];
  for (const raw of items) {
    const it = raw as MergedToolItem & { kind?: string };
    if (!it || it.kind !== "tool" || !it.name || !it.id) continue;
    const f = parseAgentTool(it.name, it.input);
    if (!f) {
      if (it.name === "Bash") { const tab = parseSpawnTab(it); if (tab) out.push(tab); }
      continue;
    }
    const resultText = it.result === undefined ? "" : contentToText(it.result);
    const ack = parseLaunchAck(resultText);
    // Launched but not yet reported = running. Only the server sees the completion signal, so this is
    // the page's best answer and the merge with /app/api/spawned is what corrects it.
    const running = it.result === undefined || !!ack;
    // Use the server's own key format when the ack gave us the id, so the transcript is readable
    // without waiting for the list, and the two sides merge on an exact key.
    const key = ack && ack.agentId ? "sub:" + ack.agentId
      : ack && ack.runId ? "wf:" + ack.runId
      : "local:" + it.id;
    const base = {
      key,
      toolUseId: it.id,
      running,
      failed: (!ack && it.isError) || undefined,
      durationMs: it.progress?.durationMs,
      tokens: it.progress?.tokens,
      toolUses: it.progress?.toolUses,
      lastTool: it.progress?.lastTool,
      result: (!ack && resultText) || undefined,
      local: true,
    };
    if (f.kind === "task") {
      out.push({ ...base, kind: "subagent", label: f.description || f.subagentType || "Subagent", sub: f.description ? f.subagentType : undefined, brief: f.prompt });
    } else {
      const done = f.phases.filter((p) => p.status === "done").length;
      out.push({
        ...base, kind: "workflow",
        label: f.name || f.description || (ack && ack.summary) || "Workflow",
        sub: f.phases.length ? `${done}/${f.phases.length} phases` : f.description,
        phases: normPhases(f.phases),
      });
    }
  }
  return out;
}
// #endregion

// #region the pinned strip (entry point) + the whole feature in one mountable component
// Running work gets a row each, with live duration/tokens/tools. Finished work is NOT expanded here
// on purpose: the pinned area sits directly above the composer on a phone, so it stays as small as
// it can while still being a door to everything. When nothing is running the whole strip collapses to
// a single "N spawned · review" line; the full list, running and finished, lives in the sheet, which
// is where you would be reading a transcript anyway.
// "2 agents running" / "1 tab running" / "3 spawned running" — say what they actually are, since a
// spawned tab is not an agent and a workflow is not either.
function runningLabel(running: SpawnedEntry[]): string {
  const kinds = new Set(running.map((e) => e.kind));
  const noun = kinds.size !== 1 ? "spawned" : [...kinds][0] === "tab" ? "tab" : [...kinds][0] === "workflow" ? "workflow" : "agent";
  return running.length === 1 ? `1 ${noun} running` : `${running.length} ${noun === "spawned" ? noun : noun + "s"} running`;
}

function SpawnStrip({ entries, onOpen, onOpenIndex }: { entries: SpawnedEntry[]; onOpen?: (e: SpawnedEntry) => void; onOpenIndex?: () => void }): React.JSX.Element | null {
  injectAgentStripCss();
  const running = entries.filter((e) => e.running);
  const rest = entries.length - running.length;
  if (!entries.length) return null;

  const row = (e: SpawnedEntry) => {
    const meta = spawnMeta(e);
    const body = (
      <>
        <span className={"as-ic as-ic-" + e.kind} aria-hidden="true"><KindIcon kind={e.kind} /></span>
        <span className="as-label" title={e.label}>{e.label}</span>
        {e.sub && <span className="as-sub">{e.sub}</span>}
        {meta && <span className="as-meta">{meta}</span>}
        {onOpen && <span className="as-chev" aria-hidden="true">›</span>}
      </>
    );
    const hint = e.kind === "tab" ? `Switch to this conversation — ${e.label}` : `Open this ${KIND_LABEL[e.kind].toLowerCase()} — ${e.label}`;
    return onOpen
      ? <button className="as-row as-tap" key={e.key} onClick={() => onOpen(e)} title={hint}>{body}</button>
      : <div className="as-row" key={e.key}>{body}</div>;
  };

  // Nothing in flight: render NOTHING. The idle "N spawned · review" line sat above the composer
  // permanently for any conversation that had ever used an agent, which is clutter in the one place
  // that has to stay small on a phone. Finished work is still reachable: the strip appears while
  // agents run and its header button opens the full-screen view, which lists finished items too.
  if (!running.length) return null;

  return (
    <div className="as-strip" role="status" aria-live="polite">
      {onOpenIndex ? (
        <button className="as-head as-head-tap" onClick={onOpenIndex} title="Open the full spawned-work view">
          <span className="as-spin" aria-hidden="true" />
          <span className="as-head-label">{runningLabel(running)}</span>
          {rest > 0 && <span className="as-sub">{rest} finished</span>}
          <span className="as-chev" aria-hidden="true">›</span>
        </button>
      ) : (
        <div className="as-head">
          <span className="as-spin" aria-hidden="true" />
          {runningLabel(running)}
        </div>
      )}
      {running.map(row)}
    </div>
  );
}

export interface SpawnedWorkProps {
  items: readonly unknown[];                        // the open conversation's items (main.tsx `items`)
  sessionId: string | null;                         // the open conversation id, for the API calls
  onJump?: (toolUseId: string) => void;             // scroll the thread to the inline Task card
  onOpenConversation?: (sessionId: string) => void; // a spawned tab IS a conversation: switch to it
}

// The whole feature, so main.tsx mounts one element: the pinned strip, plus the full-height viewer it
// opens. Kind decides what a tap does — subagent and workflow open the sheet (transcript / phases +
// children), a tab switches conversation and never opens a viewer.
export function SpawnedWork({ items, sessionId, onJump, onOpenConversation }: SpawnedWorkProps): React.JSX.Element | null {
  const local = useMemo(() => localSpawned(items), [items]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  // The server list is asked for only when it can change something: while work is in flight (so a
  // launched agent can stop saying "running"), or while the sheet is open. One owner, shared by both.
  const anyRunning = local.some((e) => e.running);
  const { list, loading, err, reload } = useSpawnedList(sessionId, local, sheet || anyRunning);

  const onOpen = useCallback((e: SpawnedEntry) => {
    if (e.kind === "tab") {
      if (e.sessionId && onOpenConversation) { onOpenConversation(e.sessionId); return; }
      // No conversation id for it yet -> open the sheet so the user sees why, rather than nothing.
    }
    setOpenKey(e.key);
    setSheet(true);
  }, [onOpenConversation]);

  const openIndex = useCallback(() => { setOpenKey(null); setSheet(true); }, []);
  const close = useCallback(() => { setSheet(false); setOpenKey(null); }, []);

  // The strip shows the merged list, so a finished agent stops spinning as soon as the server says so,
  // and a spawned tab that is still alive gets a row you can tap straight into.
  if (!list.length && !sheet) return null;
  return (
    <>
      <SpawnStrip entries={list} onOpen={onOpen} onOpenIndex={openIndex} />
      {sheet && (
        <SpawnSheet
          sessionId={sessionId}
          list={list}
          loading={loading}
          err={err}
          onReload={reload}
          openKey={openKey}
          onClose={close}
          onJump={onJump}
          onOpenConversation={onOpenConversation}
        />
      )}
    </>
  );
}

// #endregion

// #region injected strip styles (prefix `as-`; the sheet's own `sv-` styles live in spawnview.tsx)
let stripCssDone = false;
function injectAgentStripCss() {
  if (stripCssDone || typeof document === "undefined") return;
  stripCssDone = true;
  const css = `
  .as-strip{max-width:760px;margin:0 auto 8px;padding:9px 12px;background:var(--bg-2,#211c18);border:1px solid var(--line,#3a322c);border-radius:11px;font-size:12.5px}
  .as-head{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--text-2,#b8afa5);margin-bottom:6px}
  .as-head-tap{width:100%;background:transparent;border:0;font:inherit;font-weight:600;color:var(--text-2,#b8afa5);text-align:left;cursor:pointer;padding:2px 6px;margin:0 -6px 4px;border-radius:7px;min-height:32px}
  .as-head-tap:hover,.as-head-tap:focus-visible{background:var(--bg-3,#2a2420);outline:none}
  .as-head-label{flex:1;min-width:0}
  .as-spin{width:11px;height:11px;border-radius:50%;border:2px solid var(--line,#3a322c);border-top-color:var(--accent,#d97757);animation:as-spin .9s linear infinite;flex:0 0 auto}
  @keyframes as-spin{to{transform:rotate(360deg)}}
  .as-row{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0;width:100%}
  .as-tap{background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:5px 6px;margin:0 -6px;border-radius:7px;min-height:32px}
  .as-tap:hover,.as-tap:focus-visible{background:var(--bg-3,#2a2420);outline:none}
  .as-dot{width:6px;height:6px;border-radius:50%;background:var(--accent,#d97757);flex:0 0 auto}
  .as-ic{display:inline-flex;flex:0 0 auto;color:var(--accent,#d97757)}
  .as-ic-workflow{color:var(--accent-2,#e08a6d)}
  .as-ic-tab{color:var(--text-2,#b8afa5)}
  .as-label{color:var(--text,#ece7e1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
  .as-sub{color:var(--text-3,#8a8078);flex:0 0 auto}
  .as-meta{color:var(--text-3,#8a8078);font-variant-numeric:tabular-nums;flex:0 0 auto}
  .as-chev{color:var(--text-3,#8a8078);flex:0 0 auto;font-size:15px;line-height:1}
  /* Idle: the whole strip IS the one review row, so it takes a single line above the composer. */
  .as-strip.as-idle{display:flex;align-items:center;gap:8px;font:inherit;font-size:12.5px;text-align:left;cursor:pointer;padding:8px 12px;min-height:38px;color:var(--text,#ece7e1)}
  .as-strip.as-idle .as-label{flex:1;color:var(--text-2,#b8afa5)}
  .as-strip.as-idle:hover,.as-strip.as-idle:focus-visible{background:var(--bg-3,#2a2420);outline:none}
  .as-more{display:block;width:100%;text-align:left;color:var(--text-3,#8a8078);font-size:12px;font-weight:600;margin-top:2px}
  .as-more:hover,.as-more:focus-visible{color:var(--text-2,#b8afa5)}
  @media (max-width:620px){.as-sub{display:none}}
  @media (prefers-reduced-motion: reduce){.as-spin{animation-duration:2.4s}}
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion
