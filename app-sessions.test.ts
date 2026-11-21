// The /app chat list hides SDK runs not started by /app. A user with no app-sessions file (every
// guest on 2026-11-19) saw zero chats.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOrSeedAppSessions, startCwd, mergeStatus, spawnName, spawnQueryOpts } from "./app-sessions";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ct-appsess-"));
  const dataDir = join(root, "projects");
  mkdirSync(join(dataDir, "-workspace"), { recursive: true });
  mkdirSync(join(dataDir, "-other"), { recursive: true });
  writeFileSync(join(dataDir, "-workspace", "chat-a.jsonl"), "");
  writeFileSync(join(dataDir, "-other", "chat-b.jsonl"), "");
  return { dataDir, file: join(root, "claude-app-sessions.json") };
}
const sorted = (s: Set<string>) => [...s].sort();

test("no file: every existing transcript is a chat, and the file is written", () => {
  const t = setup();
  expect(sorted(readOrSeedAppSessions(t.file, t.dataDir))).toEqual(["chat-a", "chat-b"]);
  expect(JSON.parse(readFileSync(t.file, "utf8")).sort()).toEqual(["chat-a", "chat-b"]);
});

test("existing file: kept as is, a later SDK run stays hidden", () => {
  const t = setup();
  writeFileSync(t.file, JSON.stringify(["chat-a"]));
  writeFileSync(join(t.dataDir, "-other", "email-run.jsonl"), "");
  expect(sorted(readOrSeedAppSessions(t.file, t.dataDir))).toEqual(["chat-a"]);
});

test("corrupt file: reseeded, nothing hidden", () => {
  const t = setup();
  writeFileSync(t.file, "{not json");
  expect(sorted(readOrSeedAppSessions(t.file, t.dataDir))).toEqual(["chat-a", "chat-b"]);
});

// 2026-11-21: the chat page resumed a coc-bot session and sent its own cwd; the process ran in /home/filip.
test("a resumed chat starts in its transcript's cwd, not the page's", () => {
  expect(startCwd({ resume: true, transcriptCwd: "/repo/coc-bot", clientCwd: "/home/filip", defaultCwd: "/home/filip" })).toBe("/repo/coc-bot");
});
test("a new chat takes the page's cwd; a resume with no transcript cwd falls back to it", () => {
  expect(startCwd({ resume: false, transcriptCwd: null, clientCwd: "/work", defaultCwd: "/home/filip" })).toBe("/work");
  expect(startCwd({ resume: true, transcriptCwd: null, clientCwd: "/work", defaultCwd: "/home/filip" })).toBe("/work");
  expect(startCwd({ resume: false, clientCwd: "relative", defaultCwd: "/home/filip" })).toBe("/home/filip");
  expect(startCwd({ resume: false, clientCwd: undefined, defaultCwd: "/home/filip" })).toBe("/home/filip");
});

// 2026-11-21: the server ran a turn of a session a terminal tab also ran. The row said terminal:true,
// so the nightly updater did not count it as a chat a restart would cut.
test("a turn this server runs is marked app, also when a terminal runs the same id", () => {
  expect(mergeStatus({ busy: true, waiting: false }, { busy: true, waiting: false, terminal: true })).toEqual({ busy: true, waiting: false, terminal: true, app: true });
  expect(mergeStatus({ busy: false, waiting: false }, { busy: true, waiting: false, terminal: true })).toEqual({ busy: true, waiting: false, terminal: true, app: false });
  expect(mergeStatus({ busy: false, waiting: true }, undefined)).toEqual({ busy: false, waiting: true, terminal: false, app: true });
});

// 2026-11-21: a spawn was a terminal tab the chat page could not own. A spawn is now an /app chat
// that keeps the two things a tab had: its name and the CLAUDE_SPAWNED_TAB marker.
test("spawn name: sanitised, generated when missing", () => {
  expect(spawnName("coc overhaul!")).toBe("cocoverhaul");
  expect(spawnName("two-procs_bug")).toBe("two-procs_bug");
  expect(spawnName(undefined, new Date(2026, 10, 21, 12, 5, 9), () => 0.5)).toBe("spawn-120509-16384");
  expect(spawnName("!!!", new Date(2026, 10, 21, 1, 2, 3), () => 0)).toBe("spawn-010203-0");
});
test("a spawned chat's process gets the marker on every run and --name on the first", () => {
  expect(spawnQueryOpts("coc-overhaul", false)).toEqual({ env: { CLAUDE_SPAWNED_TAB: "coc-overhaul" }, extraArgs: { name: "coc-overhaul" } });
  expect(spawnQueryOpts("coc-overhaul", true)).toEqual({ env: { CLAUDE_SPAWNED_TAB: "coc-overhaul" } });
  expect(spawnQueryOpts(undefined, false)).toEqual({ env: {} });
});
