// agents.tsx — self-contained "subagent & workflow activity" card for the /app chat surface.
//
// When Claude spawns a subagent (the Task tool) or launches a Workflow, the plain tool card is a
// poor fit: the interesting bits are the agent's type + brief, whether it is still running, and its
// final write-up. This module detects those tool calls and renders a richer, collapsible activity
// card that visually matches the existing .tool-* cards. It imports only React + marked so it can be
// dropped in without touching the rest of the app, and injects its own CSS (like voice.tsx does).
//
// Data available today (see app-runner.ts): a subagent shows up as a `tool_use` event with
// name "Task" and input { subagent_type, description, prompt }, and its result as a paired
// `tool_result` (content + isError). Claude Code ALSO emits system task_started / task_notification
// messages, surfaced by app-runner as `notice` events (kind: "task") carrying token/tool counts —
// but those are not correlated to the tool_use id, so this card derives status purely from whether
// the paired result has arrived yet. There is no per-phase workflow progress on the wire today; see
// the report notes on the app-runner change that would surface it.

import React, { useMemo, useState } from "react";
import { marked } from "marked";

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

// True for the Task subagent tool. The Claude Agent SDK names it exactly "Task".
function isTaskTool(name: string): boolean {
  return name === "Task";
}

// Heuristic for a Workflow launch. There is no first-party workflow tool in the SDK today, so we
// match a tool named "Workflow" (any casing / mcp prefix) whose input carries workflow-shaped
// fields. Kept deliberately narrow so ordinary tools never masquerade as workflows.
function isWorkflowTool(name: string, input: unknown): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  if (!/(^|_)workflow($|_|s?$)/i.test(bare)) return false;
  const o = asRecord(input);
  return "phases" in o || "steps" in o || "workflow" in o || "workflow_name" in o || "name" in o;
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
  return { kind, name: str(o.workflow_name) ?? str(o.name) ?? str(o.workflow), description: str(o.description), phases };
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

// #region card
export interface AgentActivityCardProps {
  toolUse: AgentToolUse;
  toolResult?: AgentToolResult;
  running?: boolean; // explicit override; defaults to "no result yet"
  defaultOpen?: boolean;
}

// The rich activity card. Header: agent/workflow icon, type + description (or workflow name), a
// status pill (Running… / Done / Failed) and an estimated token count. Body (collapsible): the task
// prompt, an optional phase list, and the final result output (markdown-rendered when it looks like
// markdown, else preformatted).
export function AgentActivityCard({ toolUse, toolResult, running, defaultOpen }: AgentActivityCardProps) {
  injectAgentCss();
  const fields = useMemo(() => parseAgentTool(toolUse.name, toolUse.input), [toolUse.name, toolUse.input]);
  const [open, setOpen] = useState(!!defaultOpen);

  // Fallback: not actually an agent tool (defensive) — nothing to enrich.
  if (!fields) return null;

  const isRunning = running ?? toolResult === undefined;
  const failed = !isRunning && !!toolResult?.isError;
  const status: "running" | "done" | "failed" = isRunning ? "running" : failed ? "failed" : "done";
  const statusLabel = isRunning ? "Running" : failed ? "Failed" : "Done";

  const isWorkflow = fields.kind === "workflow";
  const title = isWorkflow ? fields.name || "Workflow" : fields.subagentType || "subagent";
  const subtitle = fields.description || (isWorkflow ? "" : "");
  const prompt = fields.kind === "task" ? fields.prompt || "" : "";
  const resultText = toolResult !== undefined ? contentToText(toolResult.content) : "";
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
        {est > 0 && <span className="agent-tok" title="Estimated tokens (brief + result)">~{fmtTokens(est)}</span>}
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
          {toolResult !== undefined ? (
            <>
              <div className="agent-label">{failed ? "Result (error)" : "Result"}</div>
              {resultHtml ? (
                <div className={"agent-result md" + (failed ? " agent-result-err" : "")} dangerouslySetInnerHTML={{ __html: resultHtml }} />
              ) : (
                <pre className={"agent-pre" + (failed ? " agent-pre-err" : "")}>{resultText || "(no output)"}</pre>
              )}
            </>
          ) : (
            <div className="agent-waiting"><span className="agent-spin" /> Working…</div>
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
}

// Drop-in replacement for <ToolCard> when the tool is a subagent/workflow. main.tsx can, in its
// item-render switch, check isAgentTool(it.name, it.input) and render this instead of <ToolCard>.
export function AgentToolCard({ it }: { it: MergedToolItem }) {
  const toolResult = it.result === undefined ? undefined : { content: it.result, isError: it.isError };
  return <AgentActivityCard toolUse={{ id: it.id, name: it.name, input: it.input }} toolResult={toolResult} running={it.result === undefined} />;
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
