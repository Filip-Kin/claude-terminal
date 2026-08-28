// todos.tsx — self-contained "task tracking" checklist for the /app chat surface.
//
// Claude Code's TodoWrite tool arrives in the conversation as a normal tool item
// ({ kind: "tool"; name: "TodoWrite"; input: { todos: [...] } }). Each call REPLACES the whole
// list, so the most recent TodoWrite item is the current task state. Instead of rendering that as a
// raw tool card, main.tsx suppresses it (see isTodoTool) and drops a single <TodoChecklist> just
// above the composer — a compact, pinned checklist that updates as Claude works, mirroring the todo
// panel in the Claude Code TUI.
//
// Self-contained on purpose: the only coupling to main.tsx is the exports below. All styles are
// injected from here (like voice.tsx / artifacts.tsx), reusing the styles.css variables.
import React, { useEffect, useState } from "react";

// #region types + parsing (the contract main.tsx wires against)
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// True for the TodoWrite tool, so main.tsx can SUPPRESS its inline tool card (the pinned panel below
// replaces it), the same way ask_user tool cards are suppressed.
export function isTodoTool(name: string): boolean {
  return name === "TodoWrite";
}

// Scan the item list from the end for the most recent TodoWrite tool item and return its todos.
// Returns null when there is no TodoWrite yet, or its list is empty/malformed — so main.tsx can
// render nothing rather than an empty panel.
export function latestTodos(items: { kind: string; name?: string; input?: unknown }[]): Todo[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "tool" || !it.name || !isTodoTool(it.name)) continue;
    const raw = (it.input as { todos?: unknown } | null | undefined)?.todos;
    if (!Array.isArray(raw)) return null;
    const todos: Todo[] = [];
    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      const o = t as { content?: unknown; status?: unknown; activeForm?: unknown };
      const content = typeof o.content === "string" ? o.content : "";
      const status = o.status === "in_progress" || o.status === "completed" ? o.status : "pending";
      if (!content) continue;
      todos.push({ content, status, activeForm: typeof o.activeForm === "string" ? o.activeForm : undefined });
    }
    return todos.length ? todos : null;
  }
  return null;
}
// #endregion

// #region collapsed state (persisted; sensible default on small screens)
const COLLAPSED_LS = "ct-todos-collapsed";
const isSmallScreen = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(max-width: 640px)").matches;

function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSED_LS);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch { /* */ }
  return isSmallScreen(); // no stored preference yet -> start collapsed on phones, open on desktop
}
function saveCollapsed(v: boolean) {
  try { localStorage.setItem(COLLAPSED_LS, v ? "1" : "0"); } catch { /* */ }
}
// #endregion

// #region status glyphs
function TodoGlyph({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return (
      <svg className="td-ic td-ic-done" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="var(--success, #10B981)" opacity="0.16" />
        <path d="M8 12.5l2.5 2.5L16 9" stroke="var(--success, #10B981)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg className="td-ic td-ic-run" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="var(--warning, #F59E0B)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="14 40" />
      </svg>
    );
  }
  return (
    <svg className="td-ic td-ic-pend" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="var(--line)" strokeWidth="2" />
    </svg>
  );
}
// #endregion

// The pinned checklist. Header (title + progress + chevron, with the live activeForm as a subtitle
// while a task runs), a height-capped scrolling list, and a subtle "All done" state. Returns null
// for an empty list so main.tsx can render it unconditionally.
export function TodoChecklist({ todos }: { todos: Todo[] }): JSX.Element | null {
  injectTodoCss();
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  useEffect(() => { saveCollapsed(collapsed); }, [collapsed]);

  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const allDone = done === total;
  const active = todos.find((t) => t.status === "in_progress");
  const subtitle = !collapsed ? "" : allDone ? "All done" : active ? active.activeForm || active.content : "";

  return (
    <section className={"td-panel" + (collapsed ? " collapsed" : "") + (allDone ? " td-alldone" : "")} aria-label="Tasks">
      <button
        type="button"
        className="td-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-controls="td-list"
        title={collapsed ? "Show tasks" : "Hide tasks"}
      >
        <svg className="td-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="td-title">Tasks</span>
        <span className={"td-progress" + (allDone ? " done" : "")}>{done}/{total}</span>
        {subtitle && <span className="td-sub">{subtitle}</span>}
      </button>
      {!collapsed && (
        <ul id="td-list" className="td-list">
          {todos.map((t, i) => (
            <li key={i} className={"td-item td-" + t.status}>
              <TodoGlyph status={t.status} />
              <span className="td-text">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// #region injected styles (kept out of styles.css so this is a drop-in module)
let cssDone = false;
function injectTodoCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const css = `
  .td-panel{margin:0 0 8px;background:var(--bg-2);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-family:var(--font)}
  .td-panel.td-alldone{opacity:.85}
  .td-head{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:transparent;border:0;cursor:pointer;color:var(--text);text-align:left;font-family:inherit}
  .td-head:hover{background:var(--bg-3)}
  .td-chev{flex:0 0 auto;color:var(--text-3);transition:transform .15s ease}
  .td-panel:not(.collapsed) .td-chev{transform:rotate(90deg)}
  .td-title{flex:0 0 auto;font-size:13px;font-weight:600;color:var(--text)}
  .td-progress{flex:0 0 auto;font-size:12px;font-weight:600;color:var(--text-3);font-variant-numeric:tabular-nums}
  .td-progress.done{color:var(--success,#10B981)}
  .td-sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-3)}
  .td-list{list-style:none;margin:0;padding:2px 6px 8px;max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid var(--line-2)}
  .td-item{display:flex;align-items:flex-start;gap:9px;padding:6px 8px;border-radius:8px;font-size:13.5px;line-height:1.45;color:var(--text-2)}
  .td-ic{flex:0 0 auto;margin-top:2px}
  .td-ic-run{animation:tdspin 1s linear infinite}
  @keyframes tdspin{to{transform:rotate(360deg)}}
  .td-text{min-width:0;word-break:break-word}
  .td-in_progress{color:var(--text);font-weight:500}
  .td-in_progress .td-text{color:var(--text)}
  .td-completed .td-text{text-decoration:line-through;color:var(--text-3)}
  @media (prefers-reduced-motion:reduce){.td-ic-run{animation:none}.td-chev{transition:none}}
  `;
  const el = document.createElement("style");
  el.id = "todos-css";
  el.textContent = css;
  document.head.appendChild(el);
}
// #endregion
