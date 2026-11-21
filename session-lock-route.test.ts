// The 2026-11-21 fault at the route: the chat page posts start {resume} for a session that a live
// process outside this server runs. The server must answer 409 and start nothing.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { procInfo } from "./session-lock";

const SID = "a336eb2d-64fc-4340-be3d-b445c724de35";

test("start {resume} of a session a live terminal process runs: 409, no conversation, no process", async () => {
  // HOME is set before the server modules load, so they read this registry and nothing of the user's.
  const home = mkdtempSync(join(tmpdir(), "ct-lockroute-"));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "-repo"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "-repo", SID + ".jsonl"), "");
  const holder = process.ppid; // alive, and not a child of this process
  writeFileSync(join(home, ".claude", "sessions", holder + ".json"),
    JSON.stringify({ pid: holder, sessionId: SID, procStart: procInfo(holder)!.start, entrypoint: "cli", name: "coc-overhaul", tmux: "coc-overhaul:@42.%42" }));
  process.env.HOME = home;
  const { appRoutes } = await import("./app-server");
  const runner = await import("./app-runner");
  const ctx = { allowed: () => true, cors: () => ({}), dataDir: join(home, ".claude", "projects"), defaultCwd: home, historyHide: [], hideProjectDirs: [], downloadRoots: [], models: [], mcpFile: join(home, ".claude", "claude-app-mcp.json") } as unknown as Parameters<typeof appRoutes>[2];

  const post = (path: string, body: unknown) => appRoutes(new Request("http://x" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path, ctx);

  const res = await post("/app/api/start", { resume: SID, text: "Status overall?", cid: "c66b4d92", human: true });
  expect(res?.status).toBe(409);
  expect(await res!.json()).toEqual({ error: "Send failed: session runs in terminal tab coc-overhaul", code: "held", pid: holder });
  expect(runner.get(SID)).toBeUndefined();

  // The runner refuses by itself too, for callers that do not come through the route.
  const conv = runner.getOrCreate(SID, { cwd: home, resume: SID });
  const events: { t: string; message?: string }[] = [];
  conv.onEvent((e) => { events.push(e as { t: string; message?: string }); });
  await conv.run("Status overall?");
  expect(events.find((e) => e.t === "error")?.message).toBe("Send failed: session runs in terminal tab coc-overhaul");
  expect(runner.runningConversations().length).toBe(0);
  runner.discard(SID);
});
