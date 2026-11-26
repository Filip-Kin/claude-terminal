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
  active: boolean; spent: boolean; remaining: number; allowance: number; used: number;
  nextAt: string | null; nextAtLabel: string | null; periods: number; computedAt: string;
};

export const RATION_DIR = "/var/lib/claude-terminal/ration";
export const RATION_FILE = join(RATION_DIR, "ration.json");
export const RATION_LINK = "/var/lib/claude-terminal/ration.json";

const r2 = (n: number) => Math.round(n * 100) / 100;
export function hhmmDetroit(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Detroit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export function computeRation(c: RationCfg, util: number | null, nowMs: number): RationState {
  const off = (): RationState => ({ active: false, spent: false, remaining: 0, allowance: 0, used: 0, nextAt: null, nextAtLabel: null, periods: 0, computedAt: new Date(nowMs).toISOString() });
  const startMs = Date.parse(c.start);
  if (util == null || c.startUtil == null || nowMs < startMs) return off();
  if (c.resetAt && nowMs >= Date.parse(c.resetAt)) return off(); // weekly window reset: rationing over
  const periodMs = c.periodHours * 3600_000;
  const periods = Math.floor((nowMs - startMs) / periodMs) + 1;
  const allowance = r2(c.perPeriodPct * periods);
  const used = r2(util - c.startUtil);
  const remaining = r2(allowance - used);
  const next = new Date(startMs + periods * periodMs);
  return { active: true, spent: remaining <= 0, remaining, allowance, used, nextAt: next.toISOString(), nextAtLabel: hhmmDetroit(next), periods, computedAt: new Date(nowMs).toISOString() };
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
