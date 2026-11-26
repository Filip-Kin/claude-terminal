// Per-person plan: "shared" (the host's subscription token, injected into a guest's container or
// the host's own login) or "own" (the person's own `claude setup-token` token). Same module on the
// host and in each guest. State lives in the person's home ($HOME):
//   $HOME/plan       "shared" | "own"
//   $HOME/own-token  the token, mode 660, never logged
// The plan is mirrored to plan.json with the period history the collectors and the ration timer
// read on the host: a guest writes /plan (a host-readable bind mount of
// /var/lib/claude-terminal/guest-plan/<user>), the host writes that directory for its own user directly.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Plan = "shared" | "own";
export type Period = { since: number; plan: Plan };
export const HOST_PLAN_DIR = "/var/lib/claude-terminal/guest-plan";
export const GUEST_MIRROR_DIR = "/plan";
export const IN_GUEST = existsSync("/opt/google-mcp/src/index.ts");

let hostUser: string | null = null;
// The host's own user name (the key its mirror and usage rows go by). Set once at boot on the host.
export function setHostUser(name: string): void { hostUser = /^[a-z0-9_-]+$/i.test(name) ? name : null; }
// Where this process writes its plan mirror: /plan in a guest, the host user's directory on the host.
export function mirrorDirOf(): string | null { return IN_GUEST ? GUEST_MIRROR_DIR : hostUser ? join(HOST_PLAN_DIR, hostUser) : null; }

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
// Env override for a new Claude process: the own token and CT_PLAN=own when the plan is own, else nothing.
export function planEnv(home = homedir()): Record<string, string> {
  const t = readPlan(home) === "own" ? ownToken(home) : null;
  return t ? { CLAUDE_CODE_OAUTH_TOKEN: t, CT_PLAN: "own" } : {};
}
// Make every later child of this process inherit the right token (SDK queries copy process.env).
export function applyPlanEnv(home = homedir()): void {
  const e = planEnv(home);
  if (e.CLAUDE_CODE_OAUTH_TOKEN) { process.env.CLAUDE_CODE_OAUTH_TOKEN = e.CLAUDE_CODE_OAUTH_TOKEN; process.env.CT_PLAN = "own"; return; }
  delete process.env.CT_PLAN;
  if (SHARED_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = SHARED_TOKEN;
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
export function removeToken(home = homedir()): void {
  try { unlinkSync(tokenFile(home)); } catch { /* already gone */ }
}
// Returns an error line, or null on success. A null mirror dir (host user not set) is unavailable.
export function setPlan(plan: Plan, home = homedir(), mirrorDir: string | null = mirrorDirOf(), now = Date.now()): string | null {
  if (plan === "own" && !ownToken(home)) return "No token";
  if (!mirrorDir) return "Plan sync unavailable";
  if (!existsSync(mirrorDir)) {
    if (IN_GUEST) return "Plan sync unavailable";
    try { mkdirSync(mirrorDir, { recursive: true }); } catch (e) { console.error("[plan] mirror dir failed:", (e as Error).message); return "Plan sync unavailable"; }
  }
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

const environOf = (pid: number): string[] => {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; /* gone or unreadable */ }
};
// Whether a process's environ marks it as running on its owner's own plan: CT_PLAN=own (a child
// this server started), or GUEST_USER (a guest container, set by add-guest.sh) whose mirror says own.
export function ownPlanOfEnviron(environ: string[], dir = HOST_PLAN_DIR): boolean {
  if (environ.includes("CT_PLAN=own")) return true;
  const kv = environ.find((e) => e.startsWith("GUEST_USER="));
  const user = kv ? kv.slice(11) : "";
  return !!user && hostPlan(user, dir) === "own";
}
export const ownPlanPid = (pid: number, dir = HOST_PLAN_DIR): boolean => ownPlanOfEnviron(environOf(pid), dir);
// #endregion

// #region sign-in
// `claude setup-token` prints a sign-in link, waits for the pasted code and prints the token. It
// needs a terminal, so it runs in a pty (Bun.Terminal).
export const signinMode = (): "flow" | "token" => (typeof (Bun as any).Terminal === "function" ? "flow" : "token");
const SIGNIN_MS = 10 * 60_000;
const ANSI = /\x1b\[[0-9;?>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");
export function extractUrl(raw: string): string | null {
  const osc = /\x1b\]8;[^;\x07]*;(https:\/\/[^\x07\x1b\s]+)/.exec(raw);
  if (osc) return osc[1];
  return /https:\/\/claude\.ai\/oauth\/authorize\S+/.exec(stripAnsi(raw))?.[0] ?? null;
}
export const extractToken = (raw: string): string | null => /sk-ant-[A-Za-z0-9_-]{20,}/.exec(stripAnsi(raw))?.[0] ?? null;

type Signin = { proc: any; out: string; wake: (() => void) | null; timer: ReturnType<typeof setTimeout> };
let signin: Signin | null = null;

// Kill the running sign-in child and forget it. Safe to call with none running.
export function cancelSignin(): void {
  const s = signin; signin = null;
  if (!s) return;
  clearTimeout(s.timer);
  try { s.proc.kill(); } catch { /* exited */ }
  try { s.proc.terminal?.close?.(); } catch { /* closed */ }
}
// Wait until check() yields a value, the child exits, or ms pass.
async function until<T>(s: Signin, check: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (signin !== s || Date.now() >= end) return null;
    await new Promise<void>((r) => { s.wake = r; setTimeout(r, 250); });
  }
}
// Starts a sign-in (replacing any running one) and returns the link to open, or null.
export async function startSignin(cmd: string[] = ["claude", "setup-token"], cwd = homedir()): Promise<string | null> {
  cancelSignin();
  const env = { ...(process.env as Record<string, string>), TERM: "xterm-256color" };
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CT_PLAN;
  let s!: Signin;
  try {
    const proc = Bun.spawn(cmd, {
      cwd, env,
      terminal: { cols: 500, rows: 50, data(_t: unknown, d: Uint8Array) { if (signin === s) { s.out = (s.out + new TextDecoder().decode(d)).slice(-64_000); s.wake?.(); } } },
    } as any);
    s = { proc, out: "", wake: null, timer: setTimeout(cancelSignin, SIGNIN_MS) };
  } catch (e) { console.error("[plan] sign-in start failed:", (e as Error).message); return null; }
  signin = s;
  void s.proc.exited.then(() => { if (signin === s) { s.wake?.(); } });
  const url = await until(s, () => extractUrl(s.out), 30_000);
  if (!url) cancelSignin();
  return url;
}
// Feeds the pasted code to the running sign-in, waits for the token, checks it and stores it.
export async function finishSignin(code: string, home = homedir()): Promise<boolean> {
  const s = signin;
  if (!s || !/^[A-Za-z0-9_#.~-]{8,300}$/.test(code.trim())) return false;
  try { s.proc.terminal.write(code.trim() + "\r"); } catch { cancelSignin(); return false; }
  const first = await until(s, () => extractToken(s.out), 60_000);
  if (first) await new Promise((r) => setTimeout(r, 500)); // let a token still being printed finish
  const token = first ? extractToken(s.out) : null;
  cancelSignin();
  if (!token || !(await validateToken(token))) return false;
  writeToken(token, home);
  return true;
}
// #endregion
