// Per-person plans: "shared" (the host's subscription token, injected into a guest's container or
// the host's own login) or any number of connected plans, each the person's own `claude setup-token`
// token under a name the person gives it. Same module on the host and in each guest. State lives in
// the person's home ($HOME):
//   $HOME/plans.json        { plans: [{ id, name }] }
//   $HOME/plan-tokens/<id>  the token, mode 600, never logged
//   $HOME/plan              "shared" | a plan id
// The selection is mirrored to plan.json with the plan names and the period history the collectors
// and the ration timer read on the host: a guest writes /plan (a host-readable bind mount of
// /var/lib/claude-terminal/guest-plan/<user>), the host writes that directory for its own user directly.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PlanId = string; // "shared" or a connected plan's id
export type PlanInfo = { id: string; name: string };
export type Period = { since: number; plan: PlanId };
export type Mirror = { plan: PlanId; plans: PlanInfo[]; periods: Period[] };
export const HOST_PLAN_DIR = "/var/lib/claude-terminal/guest-plan";
export const GUEST_MIRROR_DIR = "/plan";
export const IN_GUEST = existsSync("/opt/google-mcp/src/index.ts");
export const NAME_MAX = 40;

let hostUser: string | null = null;
// The host's own user name (the key its mirror and usage rows go by). Set once at boot on the host.
export function setHostUser(name: string): void { hostUser = /^[a-z0-9_-]+$/i.test(name) ? name : null; }
// Where this process writes its plan mirror: /plan in a guest, the host user's directory on the host.
export function mirrorDirOf(): string | null { return IN_GUEST ? GUEST_MIRROR_DIR : hostUser ? join(HOST_PLAN_DIR, hostUser) : null; }

const SHARED_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN; // the injected shared token, captured at load

// #region guest side
const plansFile = (home: string) => join(home, "plans.json");
const tokenDir = (home: string) => join(home, "plan-tokens");
const tokenFile = (home: string, id: string) => join(tokenDir(home), id);
const selectionFile = (home: string) => join(home, "plan");
const ID_RE = /^[a-z0-9]{8}$/;

// The connected plans, in the order they were added.
export function readPlans(home = homedir()): PlanInfo[] {
  try {
    const d = JSON.parse(readFileSync(plansFile(home), "utf8"));
    return Array.isArray(d.plans) ? d.plans.filter((p: any) => p && ID_RE.test(p.id) && typeof p.name === "string") : [];
  } catch { return []; }
}
function writePlans(plans: PlanInfo[], home: string): void {
  const tmp = join(home, ".plans.json.tmp");
  writeFileSync(tmp, JSON.stringify({ plans }) + "\n");
  renameSync(tmp, plansFile(home));
}
export function planToken(id: string, home = homedir()): string | null {
  if (!ID_RE.test(id)) return null;
  try { return readFileSync(tokenFile(home, id), "utf8").trim() || null; } catch { return null; }
}
export const planName = (id: string, home = homedir()): string | null => readPlans(home).find((p) => p.id === id)?.name ?? null;
// The selected plan: "shared" unless the selection names a listed plan whose token is present.
export function readPlan(home = homedir()): PlanId {
  try {
    const id = readFileSync(selectionFile(home), "utf8").trim();
    if (id !== "shared" && planName(id, home) && planToken(id, home)) return id;
  } catch { /* unset */ }
  return "shared";
}
// A trimmed, valid, unique (ignoring case) plan name, or an error line. exceptId is the plan being renamed.
export function checkName(raw: unknown, home = homedir(), exceptId?: string): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { error: "Name required" };
  if (name.length > NAME_MAX) return { error: "Name too long" };
  const lower = name.toLowerCase();
  if (lower === "shared" || readPlans(home).some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)) return { error: "Name taken" };
  return { name };
}
// Env override for a new Claude process: the selected plan's token and CT_PLAN=<id>, else nothing.
export function planEnv(home = homedir()): Record<string, string> {
  const id = readPlan(home), t = id === "shared" ? null : planToken(id, home);
  return t ? { CLAUDE_CODE_OAUTH_TOKEN: t, CT_PLAN: id } : {};
}
// Make every later child of this process inherit the right token (SDK queries copy process.env).
export function applyPlanEnv(home = homedir()): void {
  const e = planEnv(home);
  if (e.CLAUDE_CODE_OAUTH_TOKEN) { process.env.CLAUDE_CODE_OAUTH_TOKEN = e.CLAUDE_CODE_OAUTH_TOKEN; process.env.CT_PLAN = e.CT_PLAN; return; }
  delete process.env.CT_PLAN;
  if (SHARED_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = SHARED_TOKEN;
  else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}
export function readMirror(dir = GUEST_MIRROR_DIR): Mirror {
  try {
    const d = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    return {
      plan: typeof d.plan === "string" ? d.plan : "shared",
      plans: Array.isArray(d.plans) ? d.plans.filter((p: any) => p && typeof p.id === "string" && typeof p.name === "string") : [],
      periods: Array.isArray(d.periods) ? d.periods.filter((p: any) => p && typeof p.since === "number" && typeof p.plan === "string") : [],
    };
  } catch { return { plan: "shared", plans: [], periods: [] }; }
}
// Writes the mirror for the selected plan: the plan names, and a new period when the plan changed.
// Returns an error line, or null. A null mirror dir (host user not set) is unavailable.
function syncMirror(home: string, mirrorDir: string | null, now: number): string | null {
  if (!mirrorDir) return "Plan sync unavailable";
  if (!existsSync(mirrorDir)) {
    if (IN_GUEST) return "Plan sync unavailable";
    try { mkdirSync(mirrorDir, { recursive: true }); } catch (e) { console.error("[plan] mirror dir failed:", (e as Error).message); return "Plan sync unavailable"; }
  }
  const plan = readPlan(home), periods = readMirror(mirrorDir).periods;
  if ((periods[periods.length - 1]?.plan ?? "shared") !== plan) periods.push({ since: now, plan });
  try {
    const tmp = join(mirrorDir, ".plan.json.tmp");
    writeFileSync(tmp, JSON.stringify({ plan, plans: readPlans(home), periods }) + "\n", { mode: 0o644 });
    renameSync(tmp, join(mirrorDir, "plan.json"));
  } catch (e) { console.error("[plan] mirror write failed:", (e as Error).message); return "Plan sync unavailable"; }
  return null;
}
// Selects "shared" or a connected plan. Returns an error line, or null on success.
export function setPlan(plan: PlanId, home = homedir(), mirrorDir: string | null = mirrorDirOf(), now = Date.now()): string | null {
  if (plan !== "shared" && !(planName(plan, home) && planToken(plan, home))) return "No token";
  const prev = readSelection(home);
  writeFileSync(selectionFile(home), plan + "\n");
  const err = syncMirror(home, mirrorDir, now);
  if (err) { writeFileSync(selectionFile(home), prev + "\n"); return err; }
  applyPlanEnv(home);
  return null;
}
const readSelection = (home: string): string => { try { return readFileSync(selectionFile(home), "utf8").trim() || "shared"; } catch { return "shared"; } };
// An unused id: not a listed plan and not in the mirror's history, so a plan id is never reused.
function newId(home: string, mirrorDir: string | null): string {
  const used = new Set([...readPlans(home).map((p) => p.id), ...(mirrorDir ? readMirror(mirrorDir).periods.map((p) => p.plan) : [])]);
  for (;;) {
    let id = ""; for (let i = 0; i < 8; i++) id += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
    if (!used.has(id)) return id;
  }
}
// Stores a connected plan: its token and name. Not selected. Returns the new id, or an error line.
export function addPlan(rawName: unknown, token: string, home = homedir(), mirrorDir: string | null = mirrorDirOf(), now = Date.now()): { id: string } | { error: string } {
  const n = checkName(rawName, home);
  if ("error" in n) return n;
  const id = newId(home, mirrorDir);
  mkdirSync(tokenDir(home), { recursive: true, mode: 0o700 });
  const f = tokenFile(home, id);
  writeFileSync(f, token.trim() + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  writePlans([...readPlans(home), { id, name: n.name }], home);
  syncMirror(home, mirrorDir, now); // names only; a plan is not in use until selected
  return { id };
}
// Renames a connected plan. Returns an error line, or null.
export function renamePlan(id: string, rawName: unknown, home = homedir(), mirrorDir: string | null = mirrorDirOf(), now = Date.now()): string | null {
  const plans = readPlans(home);
  if (!plans.some((p) => p.id === id)) return "No such plan";
  const n = checkName(rawName, home, id);
  if ("error" in n) return n.error;
  writePlans(plans.map((p) => (p.id === id ? { id, name: n.name } : p)), home);
  syncMirror(home, mirrorDir, now);
  return null;
}
// Disconnects a plan and deletes its token; a selected plan goes back to Shared first. Returns an error line, or null.
export function removePlan(id: string, home = homedir(), mirrorDir: string | null = mirrorDirOf(), now = Date.now()): string | null {
  const plans = readPlans(home);
  if (!plans.some((p) => p.id === id)) return "No such plan";
  if (readSelection(home) === id) { const err = setPlan("shared", home, mirrorDir, now); if (err) return err; }
  writePlans(plans.filter((p) => p.id !== id), home);
  try { unlinkSync(tokenFile(home, id)); } catch { /* already gone */ }
  syncMirror(home, mirrorDir, now);
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
// The plan id ("shared" or a connected plan's id) the periods say was selected at a time.
export function planAt(periods: Period[], ms: number): PlanId {
  let plan: PlanId = "shared";
  for (const p of periods) { if (p.since <= ms) plan = p.plan; else break; }
  return plan;
}
export function hostMirror(user: string, dir = HOST_PLAN_DIR): Mirror {
  return /^[a-z0-9_-]+$/i.test(user) ? readMirror(join(dir, user)) : { plan: "shared", plans: [], periods: [] };
}
export const hostPeriods = (user: string, dir = HOST_PLAN_DIR): Period[] => hostMirror(user, dir).periods;
export const hostPlan = (user: string, dir = HOST_PLAN_DIR): PlanId => planAt(hostPeriods(user, dir), Date.now());

const environOf = (pid: number): string[] => {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; /* gone or unreadable */ }
};
// Whether a process's environ marks it as running on a connected plan: CT_PLAN set to anything but
// "shared" (a child this server started), or GUEST_USER (a guest container, set by add-guest.sh)
// whose mirror says a non-shared plan.
export function ownPlanOfEnviron(environ: string[], dir = HOST_PLAN_DIR): boolean {
  const ct = environ.find((e) => e.startsWith("CT_PLAN="));
  if (ct && ct.slice(8) !== "" && ct.slice(8) !== "shared") return true;
  const kv = environ.find((e) => e.startsWith("GUEST_USER="));
  const user = kv ? kv.slice(11) : "";
  return !!user && hostPlan(user, dir) !== "shared";
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

type Signin = { proc: any; name: string; out: string; wake: (() => void) | null; timer: ReturnType<typeof setTimeout> };
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
// Starts a sign-in for a plan of the given (already checked) name, replacing any running one, and
// returns the link to open, or null.
export async function startSignin(name: string, cmd: string[] = ["claude", "setup-token"], cwd = homedir()): Promise<string | null> {
  cancelSignin();
  const env = { ...(process.env as Record<string, string>), TERM: "xterm-256color" };
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CT_PLAN;
  let s!: Signin;
  try {
    const proc = Bun.spawn(cmd, {
      cwd, env,
      terminal: { cols: 500, rows: 50, data(_t: unknown, d: Uint8Array) { if (signin === s) { s.out = (s.out + new TextDecoder().decode(d)).slice(-64_000); s.wake?.(); } } },
    } as any);
    s = { proc, name, out: "", wake: null, timer: setTimeout(cancelSignin, SIGNIN_MS) };
  } catch (e) { console.error("[plan] sign-in start failed:", (e as Error).message); return null; }
  signin = s;
  void s.proc.exited.then(() => { if (signin === s) { s.wake?.(); } });
  const url = await until(s, () => extractUrl(s.out), 30_000);
  if (!url) cancelSignin();
  return url;
}
// Feeds the pasted code to the running sign-in, waits for the token, checks it and stores it as a
// new plan under the sign-in's name. Returns the new plan's id, or null.
export async function finishSignin(code: string, home = homedir(), mirrorDir: string | null = mirrorDirOf()): Promise<string | null> {
  const s = signin;
  if (!s || !/^[A-Za-z0-9_#.~-]{8,300}$/.test(code.trim())) return null;
  try { s.proc.terminal.write(code.trim() + "\r"); } catch { cancelSignin(); return null; }
  const first = await until(s, () => extractToken(s.out), 60_000);
  if (first) await new Promise((r) => setTimeout(r, 500)); // let a token still being printed finish
  const token = first ? extractToken(s.out) : null;
  cancelSignin();
  if (!token || !(await validateToken(token))) return null;
  const r = addPlan(s.name, token, home, mirrorDir);
  return "id" in r ? r.id : null;
}
// #endregion
