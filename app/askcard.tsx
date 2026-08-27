// ask_user card — shared by the chat thread (main.tsx) and the voice overlay (voice.tsx),
// so both render the same widget. Supports single-select (tap to answer), multi-select
// (toggle several, then submit), and/or a free-text field. Kept in its own module to avoid a
// circular import between main.tsx and voice.tsx.
import React, { useState } from "react";

export type AskItem = {
  kind: "ask";
  askId: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  allowText?: boolean;
  answered?: string;
};

export function AskCard({ it, onAnswer }: { it: AskItem; onAnswer: (askId: string, answer: string) => void }) {
  const answered = it.answered !== undefined;
  const multi = !!it.multiSelect;
  const allowText = !!it.allowText;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");

  const compose = (): string => {
    const parts: string[] = [];
    if (selected.size) parts.push([...selected].join(", "));
    const t = text.trim();
    if (t) parts.push(t);
    return parts.join("; ");
  };
  const canSubmit = multi ? selected.size > 0 || text.trim().length > 0 : text.trim().length > 0;
  const submit = () => { const a = multi ? compose() : text.trim(); if (a) onAnswer(it.askId, a); };
  const toggle = (label: string) => setSelected((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n; });
  const showSubmit = !answered && (multi || allowText);

  return (
    <div className="ask-card">
      <div className="ask-q">{it.question}</div>
      {it.options.length > 0 && (
        <div className="ask-opts">
          {it.options.map((o, k) => (
            <button key={k}
              className={"ask-opt" + (answered ? " done" : "") + (answered && it.answered === o.label ? " chosen" : "") + (!answered && multi && selected.has(o.label) ? " sel" : "")}
              disabled={answered}
              onClick={() => (multi ? toggle(o.label) : onAnswer(it.askId, o.label))}>
              {multi && !answered && <span className="ask-check">{selected.has(o.label) ? "✓" : ""}</span>}
              <span className="ask-opt-label">{o.label}</span>
              {o.description && <span className="ask-opt-desc">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
      {!answered && allowText && (
        <input className="ask-text" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={it.options.length ? "Or type your own answer…" : "Type your answer…"}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (canSubmit) submit(); } }} />
      )}
      {showSubmit && (
        <div className="ask-actions">
          <button className="ask-submit" disabled={!canSubmit} onClick={submit}>{multi ? "Submit" : "Send"}</button>
        </div>
      )}
      {answered && (multi || allowText) && <div className="ask-answered">{it.answered}</div>}
    </div>
  );
}
