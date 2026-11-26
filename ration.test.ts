import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { computeState, computeTrack, floorToGrid, lastTickMs, latestReading, measureTokensPerPct, migrateActivations, nextActivation, plannedPct, type Activation, type Sample } from "./ration.ts";

const RESET = "2026-11-30T07:00:00Z";
const T = (iso: string) => Date.parse(iso);
const NOW = T("2026-11-26T13:00:00Z"); // 78 h into a 156 h plan: planned 50%
const H = 3600_000;

test("planned line: 0 at window start, 100 at reset - 12 h", () => {
  expect(plannedPct(RESET, T("2026-11-23T07:00:00Z"))).toBe(0);
  expect(plannedPct(RESET, NOW)).toBe(50);
  expect(plannedPct(RESET, T("2026-11-29T19:00:00Z"))).toBe(100);
  expect(plannedPct(RESET, T("2026-11-30T01:00:00Z"))).toBe(100);
});

test("start floors to the 03/09/15/21 Detroit grid", () => {
  expect(floorToGrid(NOW)).toBe(T("2026-11-26T08:00:00Z")); // 08:00 EST -> 03:00 EST
  expect(floorToGrid(T("2026-11-26T02:30:00Z"))).toBe(T("2026-11-26T02:00:00Z")); // 21:30 EST -> 21:00
  expect(floorToGrid(T("2026-11-26T14:00:00Z"))).toBe(T("2026-11-26T14:00:00Z"));
  expect(floorToGrid(T("2026-11-01T07:30:00Z"))).toBe(T("2026-11-01T01:00:00Z")); // DST night: 02:30 EST -> 21:00 EDT
});

test("tokens per percent: median step, null without steps", () => {
  const s = (h: number, util: number, w: number): Sample => ({ ts: h * H, util, w });
  expect(measureTokensPerPct([])).toBeNull();
  expect(measureTokensPerPct([s(0, 50, 0), s(1, 51, 1000)])).toBeNull();
  expect(measureTokensPerPct([s(0, 50, 0), s(1, 51, 1000), s(2, 52, 2000), s(3, 56, 6000)])).toBe(1000);
});

// #region auto on and off
const noSamples: Sample[] = [];
test("auto on: exactly 5 points ahead stays off, above turns on", () => {
  expect(nextActivation(undefined, { util: 55, resetAt: RESET }, NOW, noSamples)).toBeUndefined();
  const a = nextActivation(undefined, { util: 55.5, resetAt: RESET }, NOW, [{ ts: T("2026-11-26T07:00:00Z"), util: 52, w: 0 }, { ts: T("2026-11-26T09:00:00Z"), util: 53, w: 0 }]);
  expect(a).toEqual({ start: "2026-11-26T08:00:00.000Z", startUtil: 52, resetAt: RESET });
});
test("auto on without a sample before the start uses the current util", () => {
  expect(nextActivation(undefined, { util: 60, resetAt: RESET }, NOW, noSamples)?.startUtil).toBe(60);
});
const act: Activation = { start: "2026-11-26T08:00:00.000Z", startUtil: 60, resetAt: RESET };
test("auto off at or under the line, stays on above it", () => {
  expect(nextActivation(act, { util: 50, resetAt: RESET }, NOW, noSamples)).toBeUndefined();
  expect(nextActivation(act, { util: 51, resetAt: RESET }, NOW, noSamples)).toBe(act);
  expect(nextActivation(act, null, NOW, noSamples)).toBe(act);
});
test("window reset turns the track off and the new window starts off", () => {
  const after = T(RESET) + H;
  expect(nextActivation(act, null, after, noSamples)).toBeUndefined();
  expect(nextActivation(act, { util: 2, resetAt: "2026-12-07T07:00:00Z" }, after, noSamples)).toBeUndefined();
});
// #endregion

// #region track
// act: 08:00Z to plan end 2026-11-29T19:00Z = 83 h = 14 periods of 40/14 = 2.857%
test("carry forward across periods", () => {
  const p1 = computeTrack(act, { util: 61, resetAt: RESET }, 2000, 1000, T(act.start) + H);
  expect(p1).toMatchObject({ active: true, spent: false, used: 2, allowance: 2.86, remaining: 0.86, nextAt: "2026-11-26T14:00:00.000Z", nextAtLabel: "09:00" });
  const p2 = computeTrack(act, { util: 61, resetAt: RESET }, 2000, 1000, T(act.start) + 6 * H);
  expect(p2).toMatchObject({ allowance: 5.71, remaining: 3.71, spent: false });
  const end = computeTrack(act, { util: 99, resetAt: RESET }, 39000, 1000, T(act.start) + 85 * H);
  expect(end).toMatchObject({ allowance: 40, used: 39, remaining: 1, nextAt: null, nextAtLabel: null });
});
test("spent when remaining reaches 0, no cap on the token figure", () => {
  expect(computeTrack(act, { util: 60, resetAt: RESET }, 3000, 1000, T(act.start) + H)).toMatchObject({ used: 3, spent: true, remaining: -0.14 });
  expect(computeTrack(act, { util: 60, resetAt: RESET }, 1999, 1000, T(act.start) + H).used).toBe(2);
});
test("percent correction wins when the limit moved more than the tokens explain", () => {
  expect(computeTrack(act, { util: 63, resetAt: RESET }, 1000, 1000, T(act.start) + H).used).toBe(3);
});
test("tokens per percent unknown: percent figure alone", () => {
  expect(computeTrack(act, { util: 62, resetAt: RESET }, 999999, null, T(act.start) + H)).toMatchObject({ used: 2, tokensPerPct: null });
});
test("off track reports the reading", () => {
  expect(computeTrack(undefined, { util: 53, resetAt: RESET }, 0, 1000, NOW)).toEqual({ active: false, spent: false, used: 0, allowance: 0, remaining: 0, nextAt: null, nextAtLabel: null, util: 53, planned: 50, ahead: 3, tokensPerPct: 1000 });
});
test("Fable at 100 turns on with no allowance: spent", () => {
  const a = nextActivation(undefined, { util: 100, resetAt: RESET }, NOW, noSamples)!;
  expect(computeTrack(a, { util: 100, resetAt: RESET }, 0, null, NOW)).toMatchObject({ active: true, spent: true, allowance: 0, used: 0 });
});
// #endregion

// #region migration
test("migration seeds the weekly track once from config.ration", () => {
  const m = migrateActivations({}, { resetAt: RESET }, null);
  expect(m).toEqual({ migrated: true, weekly: { start: "2026-11-26T02:00:00.000Z", startUtil: 92.58, resetAt: RESET } });
  expect(migrateActivations({ migrated: true }, { resetAt: RESET }, null)).toEqual({ migrated: true });
  expect(migrateActivations({ weekly: act }, { resetAt: RESET }, null)).toEqual({ weekly: act, migrated: true });
  expect(migrateActivations({}, undefined, null)).toEqual({ migrated: true });
  expect(migrateActivations({}, { resetAt: null }, { util: 93, resetAt: RESET }).weekly?.resetAt).toBe(RESET);
  expect(migrateActivations({}, { resetAt: null }, null)).toEqual({});
});
// #endregion

// #region database
function db() {
  const d = new Database(":memory:");
  d.exec("CREATE TABLE subscription_samples (ts INTEGER, seven_day_util REAL, seven_day_reset TEXT, per_model_output TEXT, model_scoped TEXT)");
  d.exec("CREATE TABLE model_usage (user TEXT, minute_utc TEXT, model TEXT, output INTEGER, total INTEGER)");
  return d;
}
const fableScoped = (u: number) => JSON.stringify([{ display_name: "Fable", utilization: u, resets_at: RESET }]);
const addSample = (d: Database, ts: number, util: number, out: Record<string, number>, scoped: string | null) =>
  d.query("INSERT INTO subscription_samples VALUES (?, ?, ?, ?, ?)").run(ts, util, RESET, JSON.stringify(out), scoped);

test("no samples: weekly off at zero, Fable null, nothing activated", () => {
  const { state, activations } = computeState(db(), {}, undefined, {}, NOW);
  expect(state.tracks.weekly).toMatchObject({ active: false, spent: false, util: 0, tokensPerPct: null });
  expect(state.tracks.fable).toBeNull();
  expect(activations).toEqual({ migrated: true });
});

test("Fable null when the latest sample has no Fable entry", () => {
  const d = db();
  addSample(d, NOW - H, 50, {}, fableScoped(10));
  addSample(d, NOW, 50, {}, JSON.stringify([{ display_name: "Other", utilization: 1, resets_at: RESET }]));
  expect(latestReading(d, "fable")).toBeNull();
  expect(computeState(d, { migrated: true }, undefined, {}, NOW).state.tracks.fable).toBeNull();
});

test("end to end: weekly turns on from shared tokens, _work excluded, Fable counted only on its track", () => {
  const d = db();
  addSample(d, NOW - 10 * H, 50, { "claude-sonnet-5": 0 }, fableScoped(20));
  addSample(d, NOW - 8 * H, 51, { "claude-sonnet-5": 1000 }, fableScoped(20));
  addSample(d, NOW - 6 * H, 52, { "claude-sonnet-5": 2000 }, fableScoped(20));
  addSample(d, NOW, 56, { "claude-sonnet-5": 6000 }, fableScoped(20));
  const use = (user: string, minute: string, model: string, out: number) => d.query("INSERT INTO model_usage VALUES (?, ?, ?, ?, ?)").run(user, minute, model, out, out);
  use("filip", "2026-11-26T07:59", "claude-sonnet-5", 50000); // before the start
  use("filip", "2026-11-26T09:00", "claude-sonnet-5", 3000);
  use("guest_work", "2026-11-26T09:00", "claude-sonnet-5", 99999);
  use("filip", "2026-11-26T10:00", "claude-fable-5-2", 100);
  const { state, activations } = computeState(d, { migrated: true }, { resetAt: RESET }, {}, NOW);
  expect(activations.weekly).toEqual({ start: "2026-11-26T08:00:00.000Z", startUtil: 52, resetAt: RESET });
  expect(activations.fable).toBeUndefined();
  // tokens 3000 + 100 * 4.5 = 3450 -> 3.45%, the limit moved 4: percent wins; allowance 48 / 14
  expect(state.tracks.weekly).toMatchObject({ active: true, tokensPerPct: 1000, used: 4, allowance: 3.43, remaining: -0.57, spent: true, util: 56, planned: 50, ahead: 6 });
  expect(state.tracks.fable).toMatchObject({ active: false, util: 20, planned: 50, ahead: -30, tokensPerPct: null });
});
// #endregion

test("tokens since the last whole-percent tick are added on top of the percent figure", () => {
  const act = { start: "2026-11-25T21:00:00-05:00", startUtil: 60, resetAt: "2026-11-30T07:00:00Z" };
  const at = Date.parse(act.start) + 3600_000;
  expect(computeTrack(act, { util: 61, resetAt: act.resetAt }, 500, 1000, at, 400).used).toBe(1.4);
  expect(computeTrack(act, { util: 61, resetAt: act.resetAt }, 2000, 1000, at, 400).used).toBe(2);
  expect(lastTickMs([{ ts: 1, util: 5, w: 0 }, { ts: 2, util: 5, w: 1 }, { ts: 3, util: 6, w: 2 }, { ts: 4, util: 6, w: 3 }])).toBe(3);
  expect(lastTickMs([{ ts: 1, util: 5, w: 0 }])).toBeNull();
});
