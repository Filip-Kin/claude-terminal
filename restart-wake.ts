// restart-wake.ts — wake the chats a service restart interrupted.
//
// A restart kills every chat's CLI process. A chat that was mid-turn stopped where it was, and a
// chat that was idle but holding work (a background task, a watcher, a cron job, a scheduled
// wakeup) silently lost it. Nothing picked either up until someone sent that chat a message, so a
// restart had to wait for every chat to go idle, which on a busy box never happens.
//
// The service keeps a file of the chats in that state, rewritten whenever the set changes, and once
// more on SIGTERM. A file and not just a signal handler: systemd stops the unit with
// KillMode=control-group (the chats' CLIs die at the same moment and can flip a chat to idle before
// a handler runs), a guest container's sidecar is SIGKILLed when the container stops (ttyd is PID
// 1), and a crash or OOM sends no signal at all. On the next start each chat in the file gets a turn
// through the normal start route: RESUME_PROMPT for an interrupted turn, HOLD_PROMPT for lost
// background work. Both open with "The service hosting this conversation restarted", which the
// transcript replay and the live stream render as a notice, not as a message the user typed.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { wakeSnapshot, RESUME_PROMPT, HOLD_PROMPT } from "./app-runner";

type Snap = { convId: string; interrupted: boolean; holds: boolean };
type WakeEntry = Snap & { at: number };

const TICK_MS = 5_000;
const START_DELAY_MS = 8_000;     // let the server finish starting before the first POST
const GAP_MS = 3_000;             // one chat at a time, so N chats do not all start their CLIs at once
const RETRIES = 4;
const RETRY_MS = 30_000;
const MAX_AGE_MS = 6 * 3600_000;  // a snapshot older than this is not "the restart that just happened"
const LOOP_GUARD_MS = 15 * 60_000; // a chat woken this recently is not woken again (a crash loop)

function log(msg: string) { console.log(`[restart-wake] ${msg}`); }

function writeAtomic(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

export function installRestartWake(opts: { file: string; port: number; owner: string }): void {
  const { file, port, owner } = opts;
  const wokenFile = file.replace(/\.json$/, "") + "-woken.json"; // convId -> ms, for the loop guard

  // --- startup: wake whoever the last run left in the file ---
  let entries: WakeEntry[] = [];
  if (existsSync(file)) {
    try { entries = JSON.parse(readFileSync(file, "utf8")) || []; } catch { /* unreadable: nothing to wake */ }
    try { unlinkSync(file); } catch { /* */ }
  }
  let woken: Record<string, number> = {};
  try { woken = JSON.parse(readFileSync(wokenFile, "utf8")) || {}; } catch { /* none */ }
  const now = Date.now();
  for (const k of Object.keys(woken)) if (now - woken[k] > LOOP_GUARD_MS) delete woken[k];
  const skipped = entries.filter((e) => e?.convId && woken[e.convId]);
  entries = entries.filter((e) => e?.convId && now - (e.at || 0) < MAX_AGE_MS && !woken[e.convId]);
  if (skipped.length) log(`not waking ${skipped.map((e) => e.convId.slice(0, 8)).join(" ")}: woken less than ${LOOP_GUARD_MS / 60000} min ago (crash loop guard)`);
  for (const e of entries) woken[e.convId] = now;
  try { writeAtomic(wokenFile, JSON.stringify(woken)); } catch { /* */ }

  if (entries.length) {
    log(`waking ${entries.length} chat(s) interrupted by the restart`);
    const wake = async (e: WakeEntry, attempt = 1): Promise<void> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/app/api/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Remote-User": owner },
          body: JSON.stringify({ resume: e.convId, text: e.interrupted ? RESUME_PROMPT : HOLD_PROMPT, cid: `restart-wake-${e.convId}-${e.at}` }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        log(`woke ${e.convId} (${e.interrupted ? "interrupted turn" : "background work"})`);
      } catch (err) {
        if (attempt < RETRIES) { log(`wake ${e.convId} failed (${err}), retry ${attempt + 1}/${RETRIES}`); setTimeout(() => void wake(e, attempt + 1), RETRY_MS); }
        else console.error(`[restart-wake] gave up on ${e.convId}:`, err);
      }
    };
    entries.forEach((e, i) => setTimeout(() => void wake(e), START_DELAY_MS + i * GAP_MS));
  }

  // --- while running: keep the file equal to who a restart would cut off ---
  // Chats being woken right now count as interrupted until their turn actually starts, so a second
  // restart in the first seconds does not drop them.
  const pending = new Map(entries.map((e) => [e.convId, e]));
  setTimeout(() => pending.clear(), START_DELAY_MS + entries.length * GAP_MS + 60_000);
  let lastBody = "", lastIds = new Set<string>(), shrinkSeen = "";
  const current = (): Snap[] => {
    const m = new Map<string, Snap>();
    for (const e of pending.values()) m.set(e.convId, { convId: e.convId, interrupted: e.interrupted, holds: e.holds });
    for (const x of wakeSnapshot()) { const p = m.get(x.convId); m.set(x.convId, p ? { convId: x.convId, interrupted: p.interrupted || x.interrupted, holds: p.holds || x.holds } : x); }
    return [...m.values()];
  };
  const tick = (force = false) => {
    try {
      const snap = current();
      const body = JSON.stringify(snap.map((s) => ({ ...s, at: 0 })));
      if (!force && body === lastBody) return;
      // Dropping a chat waits for a second tick showing the same: a tick that lands while a SIGTERM
      // is killing the CLIs would otherwise shrink the file just before the handler reads it.
      const ids = new Set(snap.map((x) => x.convId));
      const shrinks = [...lastIds].some((id) => !ids.has(id));
      if (shrinks && !force && shrinkSeen !== body) { shrinkSeen = body; return; }
      shrinkSeen = "";
      lastBody = body; lastIds = ids;
      if (!snap.length) { try { unlinkSync(file); } catch { /* */ } return; }
      const t = Date.now();
      writeAtomic(file, JSON.stringify(snap.map((s) => ({ ...s, at: t })), null, 2));
    } catch (e) { console.error("[restart-wake] snapshot failed", e); }
  };
  setInterval(() => tick(), TICK_MS);
  // The file's `at` must be recent when it is read, so refresh it now and then even if unchanged.
  setInterval(() => tick(true), 10 * 60_000);

  // A deliberate stop: one last write from live state (the interval may be up to TICK_MS old). The
  // previous file is not shrunk here: a chat whose CLI already died from the same SIGTERM may read
  // idle now, so the union with what was last written is kept.
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    try {
      let prev: Snap[] = [];
      try { prev = JSON.parse(readFileSync(file, "utf8")) || []; } catch { /* */ }
      const m = new Map<string, Snap>(prev.map((p) => [p.convId, p]));
      for (const x of current()) { const p = m.get(x.convId); m.set(x.convId, p ? { convId: x.convId, interrupted: p.interrupted || x.interrupted, holds: p.holds || x.holds } : x); }
      const all = [...m.values()];
      if (all.length) writeAtomic(file, JSON.stringify(all.map((s) => ({ ...s, at: Date.now() })), null, 2));
      log(`${sig}: ${all.length} chat(s) to wake on start${all.length ? ": " + all.map((e) => e.convId.slice(0, 8) + (e.interrupted ? "(turn)" : "(hold)")).join(" ") : ""}`);
    } catch (e) { console.error("[restart-wake] final snapshot failed", e); }
    process.exit(0);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}
