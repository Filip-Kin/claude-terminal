// Who wrote a user-role row in a transcript.
//
// A user-role row is shown as the user's bubble only when a person typed it. The test is an
// allow-list, never a list of known machine texts: from 2026-08-27 to 2026-11-20 eleven kinds of
// automated text (skill files, compaction recaps, image notes, restart turns, hook stops, Stop hook
// feedback, peer messages, ...) showed as the user's own message because each new kind was missing
// from the list of known ones. A new kind of automated row now falls to "notice", never to "user".
//
// The proof that a person typed a row is stamped into the row itself, so there is nothing to seed:
//  - /app turns: the browser sends `human: true`, the runner sends the SDK message with
//    origin {kind:"human"}, and the CLI writes that origin into the transcript row.
//  - Terminal tabs: the CLI stamps origin {kind:"human"} on what is typed.
// Rows written before stamping existed ("legacy") have no origin on any row. Once a transcript has
// one human-stamped row, every later row without that stamp is automated.

export type RowVerdict =
  | { kind: "user" }                 // a person typed it: render as their bubble
  | { kind: "notice"; text: string } // automated: one grey line
  | { kind: "skip" };                // automated and has its own rendering elsewhere, or is noise

export type RowState = { stamped: boolean };

type Origin = { kind?: string; name?: string; from?: string } | null | undefined;

// The CLI's note after the model reads an image. Pure noise to the reader.
const IMAGE_NOTE_RE = /^\[Image: original \d+x\d+/;
// notify-hold.py holds a background notification with {"continue": false}; the CLI records the held
// notification as this text. The hold is meant to be invisible.
const HOOK_HOLD_TEXT = "Operation stopped by hook";
// Legacy rows only: machine turns this server sent before stamping existed.
const LEGACY_MACHINE_RE = /^(The service hosting this conversation restarted|\[auto\])/;

export function noticeText(raw: string): string {
  const line = raw.trim().split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > 140 ? t.slice(0, 139) + "…" : t;
}

function peerNotice(origin: Origin): string {
  const who = origin?.name || "another session";
  return `Message from ${who}`;
}

// `txt` is the row's text with hidden directives already stripped. `origin` and `isMeta` come from
// the row (or from a queued_command attachment).
export function classifyUserRow(txt: string, origin: Origin, isMeta: boolean, state: RowState): RowVerdict {
  const t = txt.trim();
  if (origin?.kind === "human") {
    state.stamped = true;
    return t ? { kind: "user" } : { kind: "skip" };
  }
  if (!t) return { kind: "skip" };
  if (origin?.kind === "peer") return { kind: "notice", text: peerNotice(origin) };
  // Task notifications render from their own system rows and tool cards.
  if (origin?.kind === "task-notification") return t === HOOK_HOLD_TEXT || t.startsWith("<") ? { kind: "skip" } : { kind: "notice", text: noticeText(t) };
  if (origin) return { kind: "notice", text: noticeText(t) };
  if (isMeta) {
    if (IMAGE_NOTE_RE.test(t) || t === HOOK_HOLD_TEXT) return { kind: "skip" };
    if (t.startsWith("<")) return { kind: "skip" };
    return { kind: "notice", text: noticeText(t) };
  }
  // No origin, not meta.
  if (t.startsWith("<")) return { kind: "skip" }; // CLI wrappers: task notifications, slash-command echoes
  if (state.stamped) return { kind: "notice", text: noticeText(t) };
  // Legacy transcript: nothing on disk says who wrote it. Keep the old rendering for history.
  if (LEGACY_MACHINE_RE.test(t)) return { kind: "notice", text: "Resumed after a service restart." };
  return { kind: "user" };
}
