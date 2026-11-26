// Ration tick (root, every minute via claude-ration.timer): compute the state, write ration.json,
// and while spent kill every Claude model process on the host (guest containers, sleeper-coach,
// pit-server, cron). Never touches claude-terminal.service, ttyd, claude-router, phone/stt/tts or bun.
// Flags: --dry-run (list pids only), --force-spent (pretend spent; with --dry-run never writes state).
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeRation, writeRation, rationLine, type RationCfg } from "./ration.ts";

const dry = process.argv.includes("--dry-run");
const force = process.argv.includes("--force-spent");
const CONFIG = join(import.meta.dir, "config.json");
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const rc = cfg.ration as RationCfg | undefined;
if (!rc) { console.log("ration: not configured"); process.exit(0); }

const db = new Database(cfg.db, { readonly: true });
const startMs = Date.parse(rc.start);
// First sample at or after start: record its util and reset once.
if (rc.startUtil == null && Date.now() >= startMs && !dry) {
  const f = db.query("SELECT seven_day_util u, seven_day_reset r FROM subscription_samples WHERE ts >= ? AND seven_day_util IS NOT NULL ORDER BY ts LIMIT 1").get(startMs) as { u: number; r: string } | null;
  if (f) { rc.startUtil = f.u; rc.resetAt = f.r; writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n"); }
}
const cur = db.query("SELECT seven_day_util u FROM subscription_samples ORDER BY ts DESC LIMIT 1").get() as { u: number } | null;
let state = computeRation(rc, cur?.u ?? null, Date.now());
if (force) state = { ...state, active: true, spent: true, remaining: -0.1, nextAtLabel: state.nextAtLabel ?? "00:00" };
if (!dry) writeRation(state);
console.log(rationLine({ spent: state.spent, remaining: state.remaining, nextAtLabel: state.nextAtLabel }), state.active ? "" : "(off)");
if (!state.spent) process.exit(0);

// Claude model processes: comm "claude" (CLI and the Agent SDK child binary), not zombies.
const ps = Bun.spawnSync(["ps", "-eo", "pid=,stat=,comm=,args="]).stdout.toString().split("\n");
const targets: { pid: number; args: string }[] = [];
for (const l of ps) {
  const m = l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) continue;
  const [, pid, stat, comm, args] = m;
  if (comm !== "claude" || stat.startsWith("Z") || Number(pid) === process.pid) continue;
  targets.push({ pid: Number(pid), args: args.slice(0, 90) });
}
for (const t of targets) {
  if (dry) { console.log(`WOULD KILL ${t.pid} claude ${t.args}`); continue; }
  try { process.kill(t.pid, "SIGKILL"); console.log(`killed ${t.pid}`); } catch (e) { console.log(`kill ${t.pid} failed: ${e}`); }
}
