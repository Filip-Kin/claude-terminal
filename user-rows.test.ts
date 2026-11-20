// A user bubble in the /app chat must be a message a person typed. Eleven times (2026-08-27 to
// 2026-11-20) a new kind of automated row rendered as the user's own message because the replay
// matched known machine texts instead of requiring proof of a person. These tests replay one row of
// every automated kind seen in the wild, plus kinds that do not exist yet, and a sweep of the real
// transcripts on this box.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, statSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { replayTranscript } from "./app-runner";

type Row = Record<string, unknown>;
let n = 0;
const user = (content: string, extra: Row = {}): Row => ({ type: "user", uuid: `u${++n}`, timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(), message: { role: "user", content }, ...extra });

async function bubbles(rows: Row[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "ct-userrows-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const ev = await replayTranscript(p);
  return ev.filter((e) => e.t === "user").map((e) => (e as { text: string }).text);
}

const AUTOMATED: Row[] = [
  user("Operation stopped by hook", { isMeta: true, origin: { kind: "task-notification" } }),
  user("Stop hook feedback:\nYour final message gives a finish time", { isMeta: true }),
  user("Another Claude session sent a message: <cross-session-message from=\"uds:/tmp/x\">hi</cross-session-message>", { isMeta: true, origin: { kind: "peer", from: "uds:/tmp/x", name: "coc-war14" } }),
  user("[Your previous response had no visible output. Please continue]", { isMeta: true }),
  user("[Image: original 2924x1506, displayed at 2000x1030.]", { isMeta: true }),
  user("<task-notification><task-id>abc</task-id></task-notification>", { origin: { kind: "task-notification" } }),
  user("[MESSAGE FROM NON-USER SOURCE] something", { isMeta: true, origin: { kind: "unclassified" } }),
  // Kinds that do not exist yet: they must still never become a bubble.
  user("A brand-new hook message nobody has seen", { isMeta: true }),
  user("A brand-new origin kind", { origin: { kind: "observer" } }),
  user("Some future injected text", { origin: { kind: "some-kind-from-2027" } }),
];

test("stamped transcript: only human-origin rows are bubbles", async () => {
  const rows = [
    user("first thing I typed", { origin: { kind: "human" } }),
    ...AUTOMATED,
    // After a human-stamped row, a row with no stamp is automated (restart-wake, [auto], scripts).
    user("The service hosting this conversation restarted. Your last turn had finished"),
    user("[auto] Backend redeployed and healthy."),
    user("ct-auto-update probe: run exactly this bash command"),
    user("second thing I typed", { origin: { kind: "human" } }),
  ];
  expect(await bubbles(rows)).toEqual(["first thing I typed", "second thing I typed"]);
});

test("legacy transcript (no stamps anywhere): automated kinds still never become bubbles", async () => {
  const rows = [user("old message I typed"), ...AUTOMATED, user("[auto] Backend redeployed and healthy.")];
  expect(await bubbles(rows)).toEqual(["old message I typed"]);
});

test("queued mid-turn messages follow the same rule", async () => {
  const q = (prompt: string, origin?: Row, isMeta?: boolean): Row => ({ type: "attachment", uuid: `q${++n}`, attachment: { type: "queued_command", prompt, ...(origin ? { origin } : {}), ...(isMeta ? { isMeta } : {}) } });
  const rows = [
    user("typed", { origin: { kind: "human" } }),
    q("also typed mid-turn", { kind: "human" }),
    q("Another Claude session sent a message: hi", { kind: "peer", name: "x" }, true),
    q("unstamped injected text after stamping started"),
  ];
  expect(await bubbles(rows)).toEqual(["typed", "also typed mid-turn"]);
});

// Every bubble the real transcripts on this box produce must come from a row with no isMeta flag and
// either a human stamp or no origin at all in a transcript that has no stamps yet.
test("real transcripts: no automated row renders as a bubble", async () => {
  const root = join(homedir(), ".claude", "projects");
  const files: { p: string; m: number }[] = [];
  for (const d of readdirSync(root)) {
    let ents: string[] = [];
    try { ents = readdirSync(join(root, d)); } catch { continue; }
    for (const f of ents) if (f.endsWith(".jsonl")) { const p = join(root, d, f); const st = statSync(p); if (st.size < 50_000_000) files.push({ p, m: st.mtimeMs }); }
  }
  files.sort((a, b) => b.m - a.m);
  let checked = 0;
  for (const { p } of files.slice(0, 60)) {
    const allowed = new Set<string>();
    let stamped = false;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o: { type?: string; isMeta?: boolean; origin?: { kind?: string }; message?: { content?: unknown }; attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string }; isMeta?: boolean } };
      try { o = JSON.parse(line); } catch { continue; }
      const isQ = o.type === "attachment" && o.attachment?.type === "queued_command";
      if (o.type !== "user" && !isQ) continue;
      const origin = isQ ? o.attachment?.origin ?? o.origin : o.origin;
      const meta = isQ ? o.attachment?.isMeta ?? o.isMeta : o.isMeta;
      const c = isQ ? o.attachment?.prompt : o.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: { type?: string }) => x?.type === "text").map((x: { text?: string }) => x.text ?? "").join("") : "";
      if (!text) continue;
      if (origin?.kind === "human") stamped = true;
      const ok = origin?.kind === "human" || (!origin && !meta && !stamped);
      if (ok) allowed.add(text.replace(/\s*<(voice-mode|turn-context|title-request)>[\s\S]*?<\/\1>\s*/g, ""));
    }
    for (const b of await bubbles(readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return {}; } }))) {
      if (!allowed.has(b)) console.log("NOT ALLOWED", p, JSON.stringify(b.slice(0, 200)));
      expect(allowed.has(b)).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}, 120_000);
