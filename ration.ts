// Weekly-limit ration: the ONE computation. 0.5% of weekly usage per 6 h period, unused carries forward.
// Consumers (all read the file this writes): claude-ration-tick (root timer: kills Claude when spent),
// the UserPromptSubmit hook (bin/ct-ration-hook), /app/api/ration + /ration (UI bar), /app send refusal.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type RationCfg = {
  start: string;          // ISO, first period begins here
  startUtil: number | null; // seven_day_util at the first sample >= start
  resetAt?: string | null;  // seven_day_reset of that sample; rationing ends here
  perPeriodPct: number;
  periodHours: number;
};
export type RationState = {
  outputPerPct: number | null; fraction: number; lastTick: string | null; // output-based estimate between whole-percent ticks
  active: boolean; spent: boolean; remaining: number; allowance: number; used: number;
  nextAt: string | null; nextAtLabel: string | null; periods: number; computedAt: string;
};

export const RATION_DIR = "/var/lib/claude-terminal/ration";
export const RATION_FILE = join(RATION_DIR, "ration.json");
export const RATION_LINK = "/var/lib/claude-terminal/ration.json";

import { makeModelWeight } from "./model-weights.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;
export function hhmmDetroit(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Detroit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// #region output estimate between ticks
// seven_day_util only moves in whole percent. ASSUMED: the integer is a floor (true value is
// util + [0,1)), so a tick is the moment the true value crossed that integer. Between ticks the
// fraction is estimated from weighted output since the tick / median weighted output per 1% step.
export type Sample = { ts: number; util: number; w: number }; // w = cumulative weighted output
export type Est = { outputPerPct: number | null; fraction: number; lastTickTs: number | null };
export const FRACTION_CAP = 0.99;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// samples: ascending ts, last 48 h. startMs: output before the ration start never counts.
export function estimateFraction(samples: Sample[], startMs: number): Est {
  if (!samples.length) return { outputPerPct: null, fraction: 0, lastTickTs: null };
  // ticks = samples whose util differs from the previous sample (first sample is a baseline, not a tick)
  const ticks: Sample[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].util !== samples[i - 1].util) ticks.push(samples[i]);
  const steps: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const du = ticks[i].util - ticks[i - 1].util, dw = ticks[i].w - ticks[i - 1].w;
    if (du > 0 && dw > 0) steps.push(dw / du);
  }
  const outputPerPct = steps.length ? Math.round(median(steps)) : null;
  // start of the current integer: first sample of the final run of equal util, but not before the ration start
  let k = samples.length - 1;
  while (k > 0 && samples[k - 1].util === samples[k].util) k--;
  let base = samples[k];
  if (base.ts < startMs) base = samples.find((x) => x.ts >= startMs) ?? samples[samples.length - 1];
  const dw = Math.max(0, samples[samples.length - 1].w - base.w);
  const fraction = outputPerPct ? Math.min(FRACTION_CAP, dw / outputPerPct) : 0;
  return { outputPerPct, fraction, lastTickTs: base.ts };
}

// Cumulative weighted output per sample, using the same per-model weights server.ts uses.
export function loadSamples(db: { query: (q: string) => { all: (...a: unknown[]) => unknown[] } }, sinceMs: number, modelWeights: Record<string, number> = {}): Sample[] {
  const { modelWeight } = makeModelWeight(modelWeights);
  const rows = db.query("SELECT ts, seven_day_util u, per_model_output p FROM subscription_samples WHERE ts >= ? AND seven_day_util IS NOT NULL AND per_model_output IS NOT NULL ORDER BY ts").all(sinceMs) as { ts: number; u: number; p: string }[];
  const out: Sample[] = [];
  for (const r of rows) {
    try {
      let w = 0;
      for (const [m, n] of Object.entries(JSON.parse(r.p) as Record<string, number>)) w += modelWeight(m) * n;
      out.push({ ts: r.ts, util: r.u, w });
    } catch { /* malformed row */ }
  }
  return out;
}
// #endregion

export function computeRation(c: RationCfg, util: number | null, nowMs: number, est: Est = { outputPerPct: null, fraction: 0, lastTickTs: null }): RationState {
  const off = (): RationState => ({ outputPerPct: est.outputPerPct, fraction: 0, lastTick: null, active: false, spent: false, remaining: 0, allowance: 0, used: 0, nextAt: null, nextAtLabel: null, periods: 0, computedAt: new Date(nowMs).toISOString() });
  const startMs = Date.parse(c.start);
  if (util == null || c.startUtil == null || nowMs < startMs) return off();
  if (c.resetAt && nowMs >= Date.parse(c.resetAt)) return off(); // weekly window reset: rationing over
  const periodMs = c.periodHours * 3600_000;
  const periods = Math.floor((nowMs - startMs) / periodMs) + 1;
  const allowance = r2(c.perPeriodPct * periods);
  const used = r2(util - c.startUtil + est.fraction);
  const remaining = r2(allowance - used);
  const next = new Date(startMs + periods * periodMs);
  return { outputPerPct: est.outputPerPct, fraction: r2(est.fraction), lastTick: est.lastTickTs ? new Date(est.lastTickTs).toISOString() : null, active: true, spent: remaining <= 0, remaining, allowance, used, nextAt: next.toISOString(), nextAtLabel: hhmmDetroit(next), periods, computedAt: new Date(nowMs).toISOString() };
}

export const rationLine = (s: Pick<RationState, "spent" | "remaining" | "nextAtLabel">) =>
  s.spent ? `Ration spent · +0.5% at ${s.nextAtLabel}` : `Ration ${s.remaining.toFixed(2)}% left · +0.5% at ${s.nextAtLabel}`;

// Read the shared state. Stale (> 10 min) or missing = off, so a dead timer never locks anyone out.
export function readRation(nowMs = Date.now()): RationState | null {
  for (const p of [RATION_FILE, RATION_LINK]) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as RationState;
      if (nowMs - Date.parse(s.computedAt) > 600_000) return null;
      return s;
    } catch { /* try next */ }
  }
  return null;
}

export function writeRation(s: RationState) {
  mkdirSync(RATION_DIR, { recursive: true, mode: 0o755 });
  const tmp = RATION_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, RATION_FILE);
  try { if (!existsSync(RATION_LINK) || !lstatSync(RATION_LINK).isSymbolicLink()) { try { unlinkSync(RATION_LINK); } catch {} symlinkSync("ration/ration.json", RATION_LINK); } } catch { /* best effort */ }
}
