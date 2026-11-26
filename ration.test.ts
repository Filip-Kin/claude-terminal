import { test, expect } from "bun:test";
import { computeRation, estimateFraction, type RationCfg, type Sample } from "./ration.ts";
const c: RationCfg = { start: "2026-11-26T01:50:00Z", startUtil: 93, resetAt: "2026-11-30T07:00:00Z", perPeriodPct: 0.5, periodHours: 6 };
const at = (h: number) => Date.parse(c.start) + h * 3600_000;
test("first period", () => {
  const s = computeRation(c, 93.2, at(0.1));
  expect(s).toMatchObject({ active: true, allowance: 0.5, used: 0.2, remaining: 0.3, spent: false, nextAtLabel: "02:50" });
});
test("carry forward and boundary", () => {
  expect(computeRation(c, 93.1, at(5.99)).allowance).toBe(0.5);
  const s = computeRation(c, 93.1, at(6));
  expect(s.allowance).toBe(1); expect(s.remaining).toBe(0.9); expect(s.periods).toBe(2);
});
test("spent at zero", () => {
  expect(computeRation(c, 93.5, at(1)).spent).toBe(true);
  expect(computeRation(c, 93.7, at(1)).remaining).toBe(-0.2);
});
test("off before start, after reset, no data", () => {
  expect(computeRation(c, 95, at(-1)).active).toBe(false);
  expect(computeRation(c, 95, Date.parse(c.resetAt!) + 1).active).toBe(false);
  expect(computeRation(c, null, at(1)).active).toBe(false);
});

const S = (h: number, util: number, w: number): Sample => ({ ts: Date.parse(c.start) + h * 3600_000, util, w });
// ticks at h=-30 (91), -20 (92, +1000), -10 (93, +1000): outputPerPct 1000
const hist = [S(-40, 90, 0), S(-30, 91, 500), S(-20, 92, 1500), S(-10, 93, 2500)];
test("no tick yet, output growing: bar moves", () => {
  const e = estimateFraction([...hist, S(-5, 93, 2600), S(0.5, 93, 2900)], Date.parse(c.start) - 3600_000 * 11);
  expect(e.outputPerPct).toBe(1000);
  expect(e.fraction).toBeCloseTo(0.4, 5);
  expect(computeRation(c, 93, at(0.5), e).used).toBe(0.4);
});
test("estimate capped at 0.99", () => {
  const e = estimateFraction([...hist, S(1, 93, 99999)], 0);
  expect(e.fraction).toBe(0.99);
  expect(computeRation(c, 93, at(1), e).used).toBe(0.99);
});
test("new tick resets the fraction", () => {
  const e = estimateFraction([...hist, S(1, 93, 3300), S(2, 94, 3400), S(2.5, 94, 3500)], 0);
  expect(e.fraction).toBeCloseTo(0.1, 5);
  expect(e.lastTickTs).toBe(S(2, 94, 0).ts);
  expect(computeRation(c, 94, at(2.5), e).used).toBe(1.1);
});
test("output before the ration start never counts", () => {
  const e = estimateFraction([...hist, S(0.5, 93, 2900)], Date.parse(c.start));
  expect(e.fraction).toBe(0);
});
