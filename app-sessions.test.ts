// The /app chat list hides SDK runs not started by /app. A user with no app-sessions file (every
// guest on 2026-11-19) saw zero chats.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOrSeedAppSessions } from "./app-sessions";

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
