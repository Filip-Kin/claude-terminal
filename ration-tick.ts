// Ration tick (root, every minute via claude-ration.timer): compute both tracks, write activation.json
// and ration.json, and while the weekly track is spent kill every Claude model process on the host
// (guest containers, sleeper-coach, pit-server, cron). The Fable track never kills. Never touches
// claude-terminal.service, ttyd, claude-router, phone/stt/tts or bun.
// Flags: --dry-run (list pids only, never writes state), --force-spent (pretend the weekly track is spent).
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownPlanPid } from "./plan.ts";
import { computeState, readActivations, writeActivations, writeRation, rationLine } from "./ration.ts";

const dry = process.argv.includes("--dry-run");
const force = process.argv.includes("--force-spent");
const cfg = JSON.parse(readFileSync(join(import.meta.dir, "config.json"), "utf8"));

const db = new Database(cfg.db, { readonly: true });
const { state, activations } = computeState(db, readActivations(), cfg.ration, cfg.modelWeights || {}, Date.now());
if (force) state.tracks.weekly = { ...state.tracks.weekly, active: true, spent: true, remaining: -0.1, nextAtLabel: state.tracks.weekly.nextAtLabel ?? "00:00" };
if (!dry) { writeActivations(activations); writeRation(state); }
const { weekly, fable } = state.tracks;
console.log(rationLine(weekly), weekly.active ? "" : "(off)");
if (fable) console.log(rationLine(fable, "Fable ration"), fable.active ? "" : "(off)");
if (!weekly.spent) process.exit(0);

// Claude model processes: comm "claude" (CLI and the Agent SDK child binary), not zombies.
const ps = Bun.spawnSync(["ps", "-eo", "pid=,stat=,comm=,args="]).stdout.toString().split("\n");
for (const l of ps) {
  const m = l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) continue;
  const [, p, stat, comm, args] = m;
  const pid = Number(p);
  if (comm !== "claude" || stat.startsWith("Z") || pid === process.pid) continue;
  // A process on its own plan does not draw on the shared limit: leave it alone.
  if (ownPlanPid(pid)) { console.log(`SKIP ${pid} own plan`); continue; }
  if (dry) { console.log(`WOULD KILL ${pid} claude ${args.slice(0, 90)}`); continue; }
  try { process.kill(pid, "SIGKILL"); console.log(`killed ${pid}`); } catch (e) { console.log(`kill ${pid} failed: ${e}`); }
}
