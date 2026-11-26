import { test, expect } from "bun:test";
import { computeRation, type RationCfg } from "./ration.ts";
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
