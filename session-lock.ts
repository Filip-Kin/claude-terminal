// One process per session id. Every Claude Code process (a terminal tab's CLI, an SDK child of this
// server, any other SDK run) writes ~/.claude/sessions/<pid>.json with the session id it runs. Before
// this server resumes a session id it asks here whether another live process already runs it.
//
// 2026-11-21: the chat page sent a message into a session a terminal tab was running. The server
// resumed the id in a second process, which took the first for dead ("3 background agents didn't
// finish before the previous session ended") and started its subagents a second time.
//
// Kept apart from app-runner.ts so it loads without the SDK.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionHolder = { pid: number; entrypoint: string; name?: string; tmux?: string; cwd?: string };
export type ProcInfo = { ppid: number; start: string };
export type LockOpts = {
  dir?: string;                               // the session registry
  ownPid?: number;                            // this server; its own children never block it
  probe?: (pid: number) => ProcInfo | null;   // null = no such process
};

// Read at call time, the way server.ts resolves HOME, so a test can point it at its own registry.
export const sessionsDir = (): string => join(process.env.HOME || homedir(), ".claude", "sessions");

// ppid and start time (clock ticks since boot) from /proc/<pid>/stat. The command name sits in
// brackets and may hold spaces or brackets itself, so the fields are counted from the last ")".
export function procInfo(pid: number): ProcInfo | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; }
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // rest[0] = state (field 3)
  const ppid = Number(rest[1]);
  const start = rest[19]; // field 22
  if (!Number.isInteger(ppid) || !start) return null;
  return { ppid, start };
}

// Live processes, other than this server's own children, that run `sessionId` now.
export function sessionHolders(sessionId: string, opts: LockOpts = {}): SessionHolder[] {
  const dir = opts.dir ?? sessionsDir();
  const ownPid = opts.ownPid ?? process.pid;
  const probe = opts.probe ?? procInfo;
  const out: SessionHolder[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[session-lock] cannot read", dir, e);
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>; } catch { continue; } // half-written or gone
    if (o.sessionId !== sessionId) continue;
    const pid = Number(o.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === ownPid) continue;
    const info = probe(pid);
    if (!info) continue;                                   // a crashed session leaves its file behind
    if (typeof o.procStart === "string" && o.procStart !== info.start) continue; // the pid now belongs to another process
    if (info.ppid === ownPid) continue;                    // this server's own SDK child (a recycle or a reopen)
    out.push({
      pid,
      entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : "unknown",
      ...(typeof o.name === "string" ? { name: o.name } : {}),
      ...(typeof o.tmux === "string" ? { tmux: o.tmux } : {}),
      ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
    });
  }
  return out;
}

// The one line the chat page shows when a send is refused.
export function heldMessage(h: SessionHolder): string {
  const where = h.entrypoint === "cli" ? "terminal tab" : "another process";
  return `Send failed: session runs in ${where} ${h.name || "pid " + h.pid}`;
}
