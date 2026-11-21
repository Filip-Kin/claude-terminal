// Which SDK transcripts are /app chats: the stored id list, seeded from every existing transcript
// when there is no usable list. Kept apart from app-server.ts so it loads without the runner.
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

function allTranscriptIds(dataDir: string): string[] {
  const ids: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(dataDir); } catch (e) { console.error("[app-sessions] seed: cannot read", dataDir, e); return ids; }
  for (const project of projects) {
    let files: string[] = [];
    try { files = readdirSync(join(dataDir, project)); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) ids.push(f.slice(0, -6));
  }
  return ids;
}

// No file (a new user, a guest, a lost file) or a corrupt one = seed it with every transcript that
// exists now, so a user's past chats always show. Only SDK runs that start after the seed and not
// from /app are hidden (Filip 2026-11-19: guests lost every chat when the list started empty).
export function readOrSeedAppSessions(file: string, dataDir: string): Set<string> {
  let raw: string | null = null;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[app-sessions] read failed:", e); }
  if (raw !== null) {
    try {
      const a: unknown = JSON.parse(raw);
      if (Array.isArray(a)) return new Set(a.map(String));
      console.error("[app-sessions] not an array, reseeding");
    } catch (e) { console.error("[app-sessions] parse failed, reseeding:", e); }
  }
  const s = new Set(allTranscriptIds(dataDir));
  try { writeFileSync(file, JSON.stringify([...s])); console.log(`[app-sessions] seeded ${s.size} ids`); }
  catch (e) { console.error("[app-sessions] seed write failed:", e); }
  return s;
}

// The directory a chat's process starts in. A resumed chat runs where its transcript says it ran:
// the page sends the cwd of whatever it has selected, and on 2026-11-21 that moved a resumed coc-bot
// session to /home/filip (other project rules, no scratchpad). The page's cwd is for a new chat, and
// for a resume whose transcript names no cwd.
export function startCwd(o: { resume: boolean; transcriptCwd?: string | null; clientCwd?: unknown; defaultCwd: string }): string {
  if (o.resume && o.transcriptCwd) return o.transcriptCwd;
  if (typeof o.clientCwd === "string" && o.clientCwd.startsWith("/")) return o.clientCwd;
  return o.defaultCwd;
}

// One row of /app/api/statuses: this server's own conversation merged with the terminal registry.
// `app` = this server runs a turn of it now, so a backend restart would cut it, also when a terminal
// tab runs the same id (ct-auto-update reads it).
export type LiveStatus = { busy: boolean; waiting: boolean; terminal?: boolean; app?: boolean };
export function mergeStatus(mine: { busy: boolean; waiting: boolean }, cli?: LiveStatus): LiveStatus {
  return { busy: mine.busy || !!cli?.busy, waiting: mine.waiting, terminal: !!cli?.terminal, app: mine.busy || mine.waiting };
}

// #region spawned chats (claude-spawn, POST /sessions/spawn)
// A spawned chat's name: what peers see, what the parent's spawn card links by (spawned.ts), and
// the value of CLAUDE_SPAWNED_TAB. Same charset as before; a missing name gets a generated one.
export function spawnName(raw: unknown, now: Date = new Date(), rand: () => number = Math.random): string {
  const clean = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "";
  if (clean) return clean;
  const p = (n: number) => String(n).padStart(2, "0");
  return `spawn-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${Math.floor(rand() * 32768)}`;
}

// What a spawned chat's process gets on top of an ordinary chat's. CLAUDE_SPAWNED_TAB marks it as
// ordered work nobody watches (hook spawned-ask-stop.py); it is set on every run, resumes included.
// --name goes on the first run only: a resume reads the name back from the transcript.
export function spawnQueryOpts(name: string | undefined, resuming: boolean): { env: Record<string, string>; extraArgs?: Record<string, string | null> } {
  if (!name) return { env: {} };
  return { env: { CLAUDE_SPAWNED_TAB: name }, ...(resuming ? {} : { extraArgs: { name } }) };
}
// #endregion
