import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRouter } from "./transcripts.ts";
import { loadSamples, sharedModelOutput } from "./ration.ts";
import { ownPlanOfEnviron, setHostUser, mirrorDirOf, setPlan, readPlan, writeToken, planEnv, extractUrl, extractToken, removeToken } from "./plan.ts";

const T0 = Date.parse("2026-11-26T12:00:00Z");
function planDir(user: string, periods: { since: number; plan: string }[]) {
  const d = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(d, user));
  writeFileSync(join(d, user, "plan.json"), JSON.stringify({ plan: periods.at(-1)?.plan, periods }));
  return d;
}

test("own-plan output is excluded from the ration sample weights", () => {
  const dir = planDir("michel", [{ since: T0, plan: "own" }]);
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

test("ownPlanPid: CT_PLAN=own, or a guest container whose mirror says own", () => {
  const dir = planDir("michel", [{ since: 1, plan: "own" }]);
  mkdirSync(join(dir, "ian")); writeFileSync(join(dir, "ian", "plan.json"), JSON.stringify({ plan: "shared", periods: [{ since: 1, plan: "shared" }] }));
  expect(ownPlanOfEnviron(["PATH=/bin", "CT_PLAN=own"], dir)).toBe(true);
  expect(ownPlanOfEnviron(["GUEST_USER=michel"], dir)).toBe(true);
  expect(ownPlanOfEnviron(["GUEST_USER=ian"], dir)).toBe(false);
  expect(ownPlanOfEnviron(["PATH=/bin"], dir)).toBe(false);
  expect(ownPlanOfEnviron([], dir)).toBe(false);
});

test("host plan: no host user means no mirror; the mirror path is HOST_PLAN_DIR/<user>", () => {
  expect(mirrorDirOf()).toBeNull();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  writeToken("sk-ant-oat01-test", home);
  expect(setPlan("own", home)).toBe("Plan sync unavailable");
  setHostUser("filip");
  expect(mirrorDirOf()).toBe("/var/lib/claude-terminal/guest-plan/filip");
  setHostUser("bad/../name");
  expect(mirrorDirOf()).toBeNull();
});

test("host mirror is written directly into a missing directory", () => {
  const home = mkdtempSync(join(tmpdir(), "home-")), mirror = join(mkdtempSync(join(tmpdir(), "mirror-")), "filip");
  writeToken("sk-ant-oat01-test", home);
  expect(setPlan("own", home, mirror, 7)).toBeNull();
  expect(JSON.parse(require("node:fs").readFileSync(join(mirror, "plan.json"), "utf8")).periods).toEqual([{ since: 7, plan: "own" }]);
  expect(setPlan("shared", home, mirror, 8)).toBeNull();
  removeToken(home);
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

test("guest plan: own needs a token, switch applies to the env, mirror keeps periods", () => {
  const home = mkdtempSync(join(tmpdir(), "home-")), mirror = mkdtempSync(join(tmpdir(), "mirror-"));
  expect(setPlan("own", home, mirror)).toBe("No token");
  writeToken("sk-ant-oat01-test", home);
  expect(setPlan("own", home, mirror, 5)).toBeNull();
  expect(readPlan(home)).toBe("own");
  expect(planEnv(home)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test", CT_PLAN: "own" });
  expect(setPlan("shared", home, mirror, 9)).toBeNull();
  expect(planEnv(home)).toEqual({});
  expect(JSON.parse(require("node:fs").readFileSync(join(mirror, "plan.json"), "utf8")).periods).toEqual([{ since: 5, plan: "own" }, { since: 9, plan: "shared" }]);
  expect((require("node:fs").statSync(join(home, "own-token")).mode & 0o777).toString(8)).toBe("660");
});
