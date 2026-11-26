// Per-guest plan: "shared" (Filip's subscription token, injected into the container) or "own"
// (the guest's own `claude setup-token` token). State lives in the guest's /config ($HOME):
//   $HOME/plan       "shared" | "own"
//   $HOME/own-token  the token, mode 660, never logged
// The sidecar mirrors the plan to /plan/plan.json (a host-readable bind mount,
// /var/lib/claude-terminal/guest-plan/<user>) with the period history the collectors and the
// ration timer read on the host. Same module on both sides.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Plan = "shared" | "own";
export type Period = { since: number; plan: Plan };
export const HOST_PLAN_DIR = "/var/lib/claude-terminal/guest-plan";
export const GUEST_MIRROR_DIR = "/plan";
export const IN_GUEST = existsSync("/opt/google-mcp/src/index.ts");

const SHARED_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN; // the injected shared token, captured at load

// #region guest side
const planFile = (home: string) => join(home, "plan");
const tokenFile = (home: string) => join(home, "own-token");

export function ownToken(home = homedir()): string | null {
  try { return readFileSync(tokenFile(home), "utf8").trim() || null; } catch { return null; }
}
export function readPlan(home = homedir()): Plan {
  try { if (readFileSync(planFile(home), "utf8").trim() === "own" && ownToken(home)) return "own"; } catch { /* unset */ }
  return "shared";
}
// Env override for a new Claude process: the own token when the plan is own, else nothing.
export function planEnv(home = homedir()): Record<string, string> {
  const t = readPlan(home) === "own" ? ownToken(home) : null;
  return t ? { CLAUDE_CODE_OAUTH_TOKEN: t } : {};
}
// Make every later child of this process inherit the right token (SDK queries copy process.env).
export function applyPlanEnv(home = homedir()): void {
  const e = planEnv(home);
  if (e.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = e.CLAUDE_CODE_OAUTH_TOKEN;
  else if (SHARED_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = SHARED_TOKEN;
  else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}
export function readMirror(dir = GUEST_MIRROR_DIR): Period[] {
  try { const d = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")); return Array.isArray(d.periods) ? d.periods : []; } catch { return []; }
}
export function writeToken(token: string, home = homedir()): void {
  const f = tokenFile(home);
  writeFileSync(f, token.trim() + "\n", { mode: 0o660 });
  chmodSync(f, 0o660);
}
// Returns an error line, or null on success.
export function setPlan(plan: Plan, home = homedir(), mirrorDir = GUEST_MIRROR_DIR, now = Date.now()): string | null {
  if (plan === "own" && !ownToken(home)) return "No token";
  if (!existsSync(mirrorDir)) { if (IN_GUEST) return "Plan sync unavailable"; mkdirSync(mirrorDir, { recursive: true }); }
  const periods = readMirror(mirrorDir);
  if ((periods[periods.length - 1]?.plan ?? "shared") !== plan) periods.push({ since: now, plan });
  try {
    const tmp = join(mirrorDir, ".plan.json.tmp");
    writeFileSync(tmp, JSON.stringify({ plan, periods }) + "\n", { mode: 0o644 });
    renameSync(tmp, join(mirrorDir, "plan.json"));
  } catch (e) { console.error("[plan] mirror write failed:", (e as Error).message); return "Plan sync unavailable"; }
  writeFileSync(planFile(home), plan + "\n");
  applyPlanEnv(home);
  return null;
}
// One real call with the token; non-zero exit means the token does not work.
export async function validateToken(token: string, cwd = homedir()): Promise<boolean> {
  try {
    const p = Bun.spawn(["claude", "-p", "ok", "--model", "haiku", "--no-session-persistence", "--output-format", "json"], {
      cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...(process.env as Record<string, string>), CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    const kill = setTimeout(() => p.kill(), 90_000);
    const code = await p.exited; clearTimeout(kill);
    if (code !== 0) return false;
    const out = JSON.parse(await new Response(p.stdout).text());
    return out && out.is_error !== true;
  } catch (e) { console.error("[plan] token check failed:", (e as Error).message); return false; }
}
// #endregion

// #region host side
export function isOwnAt(periods: Period[], ms: number): boolean {
  let own = false;
  for (const p of periods) { if (p.since <= ms) own = p.plan === "own"; else break; }
  return own;
}
export function hostPeriods(user: string, dir = HOST_PLAN_DIR): Period[] {
  if (!/^[a-z0-9_-]+$/i.test(user)) return [];
  return readMirror(join(dir, user));
}
export const hostPlan = (user: string, dir = HOST_PLAN_DIR): Plan => (isOwnAt(hostPeriods(user, dir), Date.now()) ? "own" : "shared");

// user of a container process, from its environ (GUEST_USER is set by add-guest.sh); null on the host.
export function guestUserOfPid(pid: number): string | null {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) if (kv.startsWith("GUEST_USER=")) return kv.slice(11) || null;
  } catch { /* gone or unreadable */ }
  return null;
}
// Kill list minus processes of containers on their own plan.
export function skipOwnPlan<T extends { pid: number }>(targets: T[], userOf: (pid: number) => string | null, planOf: (user: string) => Plan): { keep: T[]; skipped: { t: T; user: string }[] } {
  const keep: T[] = [], skipped: { t: T; user: string }[] = [];
  for (const t of targets) {
    const u = userOf(t.pid);
    if (u && planOf(u) === "own") skipped.push({ t, user: u }); else keep.push(t);
  }
  return { keep, skipped };
}
// #endregion
