import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRouter } from "./transcripts.ts";
import { loadSamples, sharedModelOutput } from "./ration.ts";
import { ownPlanOfEnviron, setHostUser, mirrorDirOf, setPlan, readPlan, readPlans, addPlan, renamePlan, removePlan, checkName, planAt, planEnv, extractUrl, extractToken, readMirror } from "./plan.ts";

const T0 = Date.parse("2026-11-26T12:00:00Z");
function planDir(user: string, periods: { since: number; plan: string }[]) {
  const d = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(d, user));
  writeFileSync(join(d, user, "plan.json"), JSON.stringify({ plan: periods.at(-1)?.plan, periods }));
  return d;
}

test("own-plan output is excluded from the ration sample weights", () => {
  const dir = planDir("michel", [{ since: T0, plan: "abcd1234" }]);
  const route = accountRouter({ dataDir: "/x" } as never, { query: () => ({ all: () => [], get: () => null, run: () => null }) }, dir);
  const db = new Database(":memory:");
  db.exec("CREATE TABLE model_usage (user TEXT, minute_utc TEXT, model TEXT, output INTEGER, total INTEGER)");
  db.exec("CREATE TABLE subscription_samples (ts INTEGER, seven_day_util REAL, per_model_output TEXT)");
  const add = (user: string, iso: string, out: number) =>
    db.query("INSERT INTO model_usage VALUES (?, ?, 'claude-sonnet-5', ?, ?)").run(route(user, "/f", iso), iso, out, out);
  add("michel", "2026-11-26T11:00:00Z", 1000); // before the switch: shared
  add("michel", "2026-11-26T13:00:00Z", 5000); // own plan: unbilled row
  add("filip", "2026-11-26T13:00:00Z", 200);
  const shared = sharedModelOutput(db);
  expect(shared["claude-sonnet-5"].output).toBe(1200);
  db.query("INSERT INTO subscription_samples VALUES (?, ?, ?)").run(1, 50, JSON.stringify(Object.fromEntries(Object.entries(shared).map(([m, v]) => [m, v.output]))));
  const w = loadSamples(db, 0, { "claude-sonnet-5": 1 });
  expect(w[0].w).toBe(1200);
});

const TOK = "sk-ant-oat01-test";
const newHome = () => mkdtempSync(join(tmpdir(), "home-"));
const mustAdd = (name: string, home: string, mirror: string | null) => { const r = addPlan(name, TOK, home, mirror); if ("error" in r) throw new Error(r.error); return r.id; };

test("ownPlanPid: CT_PLAN other than empty or shared, or a guest container whose mirror says a plan", () => {
  const dir = planDir("michel", [{ since: 1, plan: "abcd1234" }]);
  mkdirSync(join(dir, "ian")); writeFileSync(join(dir, "ian", "plan.json"), JSON.stringify({ plan: "shared", periods: [{ since: 1, plan: "shared" }] }));
  expect(ownPlanOfEnviron(["PATH=/bin", "CT_PLAN=abcd1234"], dir)).toBe(true);
  expect(ownPlanOfEnviron(["CT_PLAN=shared"], dir)).toBe(false);
  expect(ownPlanOfEnviron(["CT_PLAN="], dir)).toBe(false);
  expect(ownPlanOfEnviron(["GUEST_USER=michel"], dir)).toBe(true);
  expect(ownPlanOfEnviron(["GUEST_USER=ian"], dir)).toBe(false);
  expect(ownPlanOfEnviron(["PATH=/bin"], dir)).toBe(false);
  expect(ownPlanOfEnviron([], dir)).toBe(false);
});

test("planAt: the plan id at a time, shared before the first period", () => {
  const ps = [{ since: 5, plan: "aaaaaaaa" }, { since: 9, plan: "shared" }, { since: 12, plan: "bbbbbbbb" }];
  expect(planAt(ps, 4)).toBe("shared");
  expect(planAt(ps, 5)).toBe("aaaaaaaa");
  expect(planAt(ps, 11)).toBe("shared");
  expect(planAt(ps, 99)).toBe("bbbbbbbb");
  expect(planAt([], 1)).toBe("shared");
});

test("host plan: no host user means no mirror; the mirror path is HOST_PLAN_DIR/<user>", () => {
  expect(mirrorDirOf()).toBeNull();
  const home = newHome();
  const id = mustAdd("Work", home, null);
  expect(setPlan(id, home)).toBe("Plan sync unavailable");
  expect(readPlan(home)).toBe("shared");
  setHostUser("filip");
  expect(mirrorDirOf()).toBe("/var/lib/claude-terminal/guest-plan/filip");
  setHostUser("bad/../name");
  expect(mirrorDirOf()).toBeNull();
});

test("host mirror is written directly into a missing directory", () => {
  const home = newHome(), mirror = join(mkdtempSync(join(tmpdir(), "mirror-")), "filip");
  const id = mustAdd("Work", home, mirror);
  expect(setPlan(id, home, mirror, 7)).toBeNull();
  const m = readMirror(mirror);
  expect(m.plan).toBe(id);
  expect(m.plans).toEqual([{ id, name: "Work" }]);
  expect(m.periods).toEqual([{ since: 7, plan: id }]);
  expect(setPlan("shared", home, mirror, 8)).toBeNull();
  expect(removePlan(id, home, mirror)).toBeNull();
  expect(readPlan(home)).toBe("shared");
  expect(planEnv(home)).toEqual({});
});

test("sign-in output: link from the OSC 8 target, token from stripped text", () => {
  const raw = "\x1b[2Jopen\r\n\x1b]8;id=a;https://claude.ai/oauth/authorize?abc_DEF-1\x07https://claude.ai/oauth/authorize?abc_DEF-1\x1b]8;;\x07\r\n";
  expect(extractUrl(raw)).toBe("https://claude.ai/oauth/authorize?abc_DEF-1");
  expect(extractUrl("\x1b[1mhttps://claude.ai/oauth/authorize?zz\x1b[0m")).toBe("https://claude.ai/oauth/authorize?zz");
  expect(extractToken("Your token:\r\n\x1b[32msk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv\x1b[0m\r\n")).toBe("sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv");
  expect(extractToken("no token here")).toBeNull();
});

test("storage: plans.json, a mode 600 token per id, selection falls back to shared without a token", () => {
  const home = newHome(), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  expect(setPlan("abcd1234", home, mirror)).toBe("No token");
  const id = mustAdd("  Work  ", home, mirror);
  expect(id).toMatch(/^[a-z0-9]{8}$/);
  expect(readPlans(home)).toEqual([{ id, name: "Work" }]);
  expect(JSON.parse(readFileSync(join(home, "plans.json"), "utf8"))).toEqual({ plans: [{ id, name: "Work" }] });
  expect((statSync(join(home, "plan-tokens", id)).mode & 0o777).toString(8)).toBe("600");
  expect(readPlan(home)).toBe("shared"); // added, not selected
  expect(setPlan(id, home, mirror, 5)).toBeNull();
  expect(readPlan(home)).toBe(id);
  expect(planEnv(home)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOK, CT_PLAN: id });
  writeFileSync(join(home, "plan-tokens", id), "");
  expect(readPlan(home)).toBe("shared");
  expect(planEnv(home)).toEqual({});
  writeFileSync(join(home, "plan-tokens", id), TOK + "\n");
  writeFileSync(join(home, "plans.json"), JSON.stringify({ plans: [] }));
  expect(readPlan(home)).toBe("shared");
});

test("mirror keeps periods across switches and carries the plan names", () => {
  const home = newHome(), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  const a = mustAdd("Work", home, mirror), b = mustAdd("Side", home, mirror);
  expect(setPlan(a, home, mirror, 5)).toBeNull();
  expect(setPlan(a, home, mirror, 6)).toBeNull(); // same plan: no new period
  expect(setPlan(b, home, mirror, 7)).toBeNull();
  expect(setPlan("shared", home, mirror, 9)).toBeNull();
  const m = readMirror(mirror);
  expect(m.periods).toEqual([{ since: 5, plan: a }, { since: 7, plan: b }, { since: 9, plan: "shared" }]);
  expect(m.plans).toEqual([{ id: a, name: "Work" }, { id: b, name: "Side" }]);
});

test("name rules: trimmed, 1 to 40 characters, unique ignoring case, not Shared", () => {
  const home = newHome(), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  const id = mustAdd("Work", home, mirror);
  expect(checkName("   ", home)).toEqual({ error: "Name required" });
  expect(checkName(undefined, home)).toEqual({ error: "Name required" });
  expect(checkName("x".repeat(41), home)).toEqual({ error: "Name too long" });
  expect(checkName("x".repeat(40), home)).toEqual({ name: "x".repeat(40) });
  expect(checkName("WORK", home)).toEqual({ error: "Name taken" });
  expect(checkName("shared", home)).toEqual({ error: "Name taken" });
  expect(addPlan("work ", TOK, home, mirror)).toEqual({ error: "Name taken" });
  expect(checkName("WORK", home, id)).toEqual({ name: "WORK" }); // renaming a plan to its own name in another case
});

test("rename updates the list and the mirror; disconnect of the selected plan goes back to shared first", () => {
  const home = newHome(), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  const a = mustAdd("Work", home, mirror), b = mustAdd("Side", home, mirror);
  expect(renamePlan(a, "Side", home, mirror)).toBe("Name taken");
  expect(renamePlan("zzzzzzzz", "X", home, mirror)).toBe("No such plan");
  expect(setPlan(a, home, mirror, 5)).toBeNull();
  expect(renamePlan(a, "Client", home, mirror)).toBeNull();
  expect(readMirror(mirror).plans.find((p) => p.id === a)?.name).toBe("Client");
  expect(removePlan(a, home, mirror, 8)).toBeNull();
  expect(readPlan(home)).toBe("shared");
  expect(readPlans(home)).toEqual([{ id: b, name: "Side" }]);
  expect(readMirror(mirror).periods).toEqual([{ since: 5, plan: a }, { since: 8, plan: "shared" }]);
  expect(planEnv(home)).toEqual({});
  expect(statSync(join(home, "plan-tokens")).isDirectory()).toBe(true);
  expect(() => statSync(join(home, "plan-tokens", a))).toThrow();
});

test("plan ids are never reused, including ids only the mirror history still holds", () => {
  const home = newHome(), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  const ids = new Set<string>();
  for (let i = 0; i < 30; i++) { const id = mustAdd("p" + i, home, mirror); expect(ids.has(id)).toBe(false); ids.add(id); }
});
