// 2026-11-21: session a336eb2d ran in a terminal tab (pid 644535, entrypoint cli). A message typed in
// the chat page made the server resume the same id in an SDK child (pid 1791890). Two processes then
// ran one session and the second restarted the first one's subagents.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sessionHolders, heldMessage, procInfo, type ProcInfo } from "./session-lock";

const SID = "a336eb2d-64fc-4340-be3d-b445c724de35";
const SERVER = 1411667;

function registry(entries: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-sesslock-"));
  for (const e of entries) writeFileSync(join(dir, `${e.pid}.json`), JSON.stringify(e));
  return dir;
}
const procs = (table: Record<number, ProcInfo>) => (pid: number) => table[pid] ?? null;

const tab = { pid: 644535, sessionId: SID, procStart: "153063253", entrypoint: "cli", name: "coc-overhaul", tmux: "coc-overhaul:@42.%42", cwd: "/repo/coc-bot" };
const sdkChild = { pid: 1791890, sessionId: SID, procStart: "153630416", entrypoint: "sdk-ts", name: "coc-overhaul", cwd: "/home/filip" };

test("the fault: a live terminal tab holds the session, so the server must not resume it", () => {
  const dir = registry([tab]);
  const held = sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 644535: { ppid: 2971277, start: "153063253" } }) });
  expect(held.map((h) => h.pid)).toEqual([644535]);
  expect(heldMessage(held[0])).toBe("Send failed: session runs in terminal tab coc-overhaul");
});

test("the server's own SDK child does not block the server (reopen, hung-query recycle)", () => {
  const dir = registry([sdkChild]);
  expect(sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 1791890: { ppid: SERVER, start: "153630416" } }) })).toEqual([]);
});

test("an SDK process of another parent holds the session", () => {
  const dir = registry([sdkChild]);
  const held = sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 1791890: { ppid: 1, start: "153630416" } }) });
  expect(held.map((h) => h.pid)).toEqual([1791890]);
  expect(heldMessage(held[0])).toBe("Send failed: session runs in another process coc-overhaul");
});

test("a dead process leaves its file behind and holds nothing", () => {
  const dir = registry([tab]);
  expect(sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({}) })).toEqual([]);
});

test("a reused pid (other start time) holds nothing", () => {
  const dir = registry([tab]);
  expect(sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 644535: { ppid: 1, start: "999" } }) })).toEqual([]);
});

test("another session id in the registry holds nothing", () => {
  const dir = registry([{ ...tab, sessionId: "f3e657e7-0000-0000-0000-000000000000" }]);
  expect(sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 644535: { ppid: 1, start: "153063253" } }) })).toEqual([]);
});

test("no registry, a corrupt file: nothing held, no throw", () => {
  expect(sessionHolders(SID, { dir: "/nonexistent/ct-sesslock", ownPid: SERVER })).toEqual([]);
  const dir = registry([tab]);
  writeFileSync(join(dir, "1.json"), "{half");
  expect(sessionHolders(SID, { dir, ownPid: SERVER, probe: procs({ 644535: { ppid: 1, start: "153063253" } }) }).length).toBe(1);
});

test("procInfo reads the real /proc: this process is a child of its parent", () => {
  const me = procInfo(process.pid);
  expect(me?.ppid).toBe(process.ppid);
  expect(me?.start).toMatch(/^\d+$/);
  expect(procInfo(2 ** 22 + 7)).toBeNull(); // above pid_max
});

test("with the real /proc: a registry entry for a live foreign process is held, own child is not", () => {
  const info = procInfo(process.pid)!;
  const dir = registry([{ ...tab, pid: process.pid, procStart: info.start }]);
  expect(sessionHolders(SID, { dir, ownPid: SERVER }).map((h) => h.pid)).toEqual([process.pid]);
  expect(sessionHolders(SID, { dir, ownPid: process.ppid })).toEqual([]);
});
