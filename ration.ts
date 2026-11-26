// Usage ration: the ONE computation. Two tracks, the shared weekly limit and the Fable model limit.
// A track turns itself on when its limit runs more than 5 points ahead of the planned line, hands
// out the rest of the limit in 6 h periods (unused carries forward), and turns off at or under the
// line or at the window reset. Usage is weighted output tokens on the shared plan.
// Consumers (all read the file this writes): claude-ration-tick (root timer: kills Claude while the
// weekly track is spent), the UserPromptSubmit hook (bin/ct-ration-hook), /app/api/ration + /ration
// (UI bar), /app send refusal.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeModelWeight } from "./model-weights.ts";

// #region types and constants
export type TrackName = "weekly" | "fable";
export type Activation = { start: string; startUtil: number; resetAt: string };
// migrated: config.ration has been seeded once and is never read again.
export type Activations = { weekly?: Activation; fable?: Activation; migrated?: boolean };
export type Reading = { util: number; resetAt: string }; // the limit's current utilization and window reset
export type Track = {
  active: boolean; spent: boolean; used: number; allowance: number; remaining: number;
  nextAt: string | null; nextAtLabel: string | null; util: number; planned: number; ahead: number; tokensPerPct: number | null;
};
export type RationState = { computedAt: string; tracks: { weekly: Track; fable: Track | null } };
export type LegacyRationCfg = { resetAt?: string | null };
type Db = { query: (q: string) => { all: (...a: unknown[]) => unknown[] } };

export const RATION_DIR = "/var/lib/claude-terminal/ration";
export const RATION_FILE = join(RATION_DIR, "ration.json");
export const RATION_LINK = "/var/lib/claude-terminal/ration.json";
export const ACTIVATION_FILE = join(RATION_DIR, "activation.json");

const H = 3600_000;
export const PERIOD_MS = 6 * H;
export const WINDOW_MS = 7 * 24 * H;
export const PLAN_END_BEFORE_RESET_MS = 12 * H;
export const AUTO_ON_POINTS = 5;
export const SAMPLE_LOOKBACK_MS = 48 * H;
// Seed for the weekly track from the hand-written config.ration of the week of 2026-11-25.
export const MIGRATED_WEEKLY = { start: "2026-11-25T21:00:00-05:00", startUtil: 92.58 };

const r2 = (n: number) => Math.round(n * 100) / 100;
const isFable = (s: string) => s.toLowerCase().includes("fable");
export function hhmmDetroit(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Detroit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}
// #endregion

// #region planned line and grid
/** Planned utilization: 0% at the window start (reset - 7 d) rising straight to 100% at reset - 12 h. */
export function plannedPct(resetAt: string, nowMs: number): number {
  const resetMs = Date.parse(resetAt), from = resetMs - WINDOW_MS, to = resetMs - PLAN_END_BEFORE_RESET_MS;
  return Math.min(100, Math.max(0, (100 * (nowMs - from)) / (to - from)));
}

const detroitParts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Detroit", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));

/** Floors a time to the 6 h grid 03:00/09:00/15:00/21:00 America/Detroit. */
export function floorToGrid(ms: number): number {
  const p = detroitParts(ms);
  let c = ms - ((((p.hour - 3) % 6) + 6) % 6) * H - p.minute * 60_000 - p.second * 1000 - (ms % 1000);
  // On a DST night the elapsed hours differ from the wall-clock hours: step back onto the grid.
  const off = (((detroitParts(c).hour - 3) % 6) + 6) % 6;
  if (off) c -= off * H;
  return c;
}
// #endregion

// #region tokens per percent
// seven_day_util (and the Fable utilization) move in whole percent. A tick is a sample whose util
// differs from the previous one; tokens per 1% is the median weighted output per util step between ticks.
export type Sample = { ts: number; util: number; w: number }; // w = cumulative weighted output
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Median weighted tokens per 1% across the samples' util ticks, or null when no step is measurable. */
export function measureTokensPerPct(samples: Sample[]): number | null {
  const ticks: Sample[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].util !== samples[i - 1].util) ticks.push(samples[i]);
  const steps: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const du = ticks[i].util - ticks[i - 1].util, dw = ticks[i].w - ticks[i - 1].w;
    if (du > 0 && dw > 0) steps.push(dw / du);
  }
  return steps.length ? Math.round(median(steps)) : null;
}
// #endregion

// #region database reads
const minuteKey = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * Per-model output on the SHARED limit, optionally from a time on: "<user>_work" rows (another plan:
 * the box work login, or a guest on its own plan, see transcripts.ts accountRouter) never draw on it.
 */
export function sharedModelOutput(db: Db, sinceMs?: number): Record<string, { output: number; total: number }> {
  const out: Record<string, { output: number; total: number }> = {};
  const since = sinceMs == null ? "" : minuteKey(sinceMs);
  for (const r of db.query("SELECT model, SUM(output) AS output, SUM(total) AS total FROM model_usage WHERE user NOT LIKE '%\\_work' ESCAPE '\\' AND minute_utc >= ? GROUP BY model").all(since) as { model: string; output: number; total: number }[])
    out[r.model] = { output: r.output, total: r.total };
  return out;
}

/** Weighted shared output since a time; the Fable track counts only Fable models. */
export function sharedWeightedSince(db: Db, sinceMs: number, modelWeights: Record<string, number>, track: TrackName): number {
  const { modelWeight } = makeModelWeight(modelWeights);
  let w = 0;
  for (const [m, v] of Object.entries(sharedModelOutput(db, sinceMs))) if (track === "weekly" || isFable(m)) w += modelWeight(m) * v.output;
  return w;
}

const fableEntry = (json: string | null): { utilization: number; resets_at: string } | null => {
  try {
    const e = (JSON.parse(json ?? "[]") as { display_name?: string; utilization?: unknown; resets_at?: unknown }[]).find((x) => isFable(String(x?.display_name ?? "")));
    return e && typeof e.utilization === "number" && typeof e.resets_at === "string" ? { utilization: e.utilization, resets_at: e.resets_at } : null;
  } catch { return null; }
};

/** Cumulative weighted output per sample against the track's utilization, using the server's per-model weights. */
export function loadSamples(db: Db, sinceMs: number, modelWeights: Record<string, number> = {}, track: TrackName = "weekly"): Sample[] {
  const { modelWeight } = makeModelWeight(modelWeights);
  const rows = (track === "weekly"
    ? db.query("SELECT ts, seven_day_util u, per_model_output p FROM subscription_samples WHERE ts >= ? AND seven_day_util IS NOT NULL AND per_model_output IS NOT NULL ORDER BY ts").all(sinceMs)
    : db.query("SELECT ts, model_scoped s, per_model_output p FROM subscription_samples WHERE ts >= ? AND model_scoped IS NOT NULL AND per_model_output IS NOT NULL ORDER BY ts").all(sinceMs)) as { ts: number; u?: number; s?: string; p: string }[];
  const out: Sample[] = [];
  for (const r of rows) {
    try {
      const util = track === "weekly" ? r.u! : fableEntry(r.s ?? null)?.utilization;
      if (util == null) continue;
      let w = 0;
      for (const [m, n] of Object.entries(JSON.parse(r.p) as Record<string, number>)) if (track === "weekly" || isFable(m)) w += modelWeight(m) * n;
      out.push({ ts: r.ts, util, w });
    } catch { /* malformed row */ }
  }
  return out;
}

/** The track's limit as of the latest sample; Fable is null when that sample has no Fable entry. */
export function latestReading(db: Db, track: TrackName): Reading | null {
  if (track === "weekly") {
    const r = db.query("SELECT seven_day_util u, seven_day_reset r FROM subscription_samples WHERE seven_day_util IS NOT NULL AND seven_day_reset IS NOT NULL ORDER BY ts DESC LIMIT 1").all()[0] as { u: number; r: string } | undefined;
    return r ? { util: r.u, resetAt: r.r } : null;
  }
  const r = db.query("SELECT model_scoped s FROM subscription_samples ORDER BY ts DESC LIMIT 1").all()[0] as { s: string | null } | undefined;
  const e = fableEntry(r?.s ?? null);
  return e ? { util: e.utilization, resetAt: e.resets_at } : null;
}
// #endregion

// #region activation
/**
 * Seeds the weekly activation once from the hand-written config.ration, so the overspend of the
 * week it covers still counts. Marks the file migrated; config.ration is never read again after that.
 */
export function migrateActivations(a: Activations, cfg: LegacyRationCfg | undefined, r: Reading | null): Activations {
  if (a.migrated) return a;
  if (a.weekly || !cfg) return { ...a, migrated: true };
  const resetAt = cfg.resetAt ?? r?.resetAt;
  if (!resetAt) return a;
  return { ...a, migrated: true, weekly: { start: new Date(MIGRATED_WEEKLY.start).toISOString(), startUtil: MIGRATED_WEEKLY.startUtil, resetAt } };
}

/**
 * Auto off: at or under the planned line, or past the activation's reset. Auto on: more than
 * AUTO_ON_POINTS ahead of the line; start floored to the 6 h grid, startUtil the latest sample's
 * util at or before that start (else the current util).
 */
export function nextActivation(prev: Activation | undefined, r: Reading | null, nowMs: number, samples: Sample[]): Activation | undefined {
  if (prev && nowMs >= Date.parse(prev.resetAt)) prev = undefined;
  if (!r) return prev;
  const planned = plannedPct(r.resetAt, nowMs);
  if (prev) return r.util <= planned ? undefined : prev;
  if (r.util - planned <= AUTO_ON_POINTS || nowMs >= Date.parse(r.resetAt)) return undefined;
  const startMs = floorToGrid(nowMs);
  const before = samples.filter((s) => s.ts <= startMs).at(-1);
  return { start: new Date(startMs).toISOString(), startUtil: before?.util ?? r.util, resetAt: r.resetAt };
}
// #endregion

// #region track
/** Off track carrying only the reading. */
export function offTrack(r: Reading | null, nowMs: number, tokensPerPct: number | null): Track {
  const util = r?.util ?? 0, planned = r ? r2(plannedPct(r.resetAt, nowMs)) : 0;
  return { active: false, spent: false, used: 0, allowance: 0, remaining: 0, nextAt: null, nextAtLabel: null, util, planned, ahead: r2(util - planned), tokensPerPct };
}

/**
 * Ration while active. Used % since start = weighted tokens / tokensPerPct, unless the limit's own
 * movement (util - startUtil) is larger: usage from outside this server is not in the database.
 * Allowance: (100 - startUtil) split over the 6 h periods from start to resetAt - 12 h, one share
 * added at the start of each period.
 */
export function computeTrack(act: Activation | undefined, r: Reading | null, tokensSinceStart: number, tokensPerPct: number | null, nowMs: number): Track {
  const base = offTrack(r, nowMs, tokensPerPct);
  if (!act || !r) return base;
  const startMs = Date.parse(act.start);
  const nPeriods = Math.max(1, Math.ceil((Date.parse(act.resetAt) - PLAN_END_BEFORE_RESET_MS - startMs) / PERIOD_MS));
  const periods = Math.min(nPeriods, Math.max(1, Math.floor((nowMs - startMs) / PERIOD_MS) + 1));
  const allowance = r2((Math.max(0, 100 - act.startUtil) / nPeriods) * periods);
  const pct = r.util - act.startUtil;
  const used = r2(tokensPerPct ? Math.max(tokensSinceStart / tokensPerPct, pct) : pct);
  const remaining = r2(allowance - used);
  const next = periods < nPeriods ? new Date(startMs + periods * PERIOD_MS) : null;
  return { ...base, active: true, spent: remaining <= 0, used, allowance, remaining, nextAt: next?.toISOString() ?? null, nextAtLabel: next ? hhmmDetroit(next) : null };
}

/** One tick: migrate, update both tracks' activations, and compute the state from the database. */
export function computeState(db: Db, prev: Activations, cfg: LegacyRationCfg | undefined, modelWeights: Record<string, number>, nowMs: number): { state: RationState; activations: Activations } {
  const weeklyReading = latestReading(db, "weekly");
  const activations: Activations = { ...migrateActivations(prev, cfg, weeklyReading) };
  const track = (name: TrackName, r: Reading | null): Track => {
    const samples = loadSamples(db, nowMs - SAMPLE_LOOKBACK_MS, modelWeights, name);
    const act = nextActivation(activations[name], r, nowMs, samples);
    if (act) activations[name] = act; else delete activations[name];
    const tokens = act ? sharedWeightedSince(db, Date.parse(act.start), modelWeights, name) : 0;
    return computeTrack(act, r, tokens, measureTokensPerPct(samples), nowMs);
  };
  const weekly = track("weekly", weeklyReading);
  const fableReading = latestReading(db, "fable");
  const fable = track("fable", fableReading);
  return { state: { computedAt: new Date(nowMs).toISOString(), tracks: { weekly, fable: fableReading ? fable : null } }, activations };
}
// #endregion

// #region files
/** Status line for one track. */
export const rationLine = (t: Pick<Track, "spent" | "remaining" | "nextAtLabel">, name = "Ration") =>
  (t.spent ? `${name} spent` : `${name} ${t.remaining.toFixed(2)}% left`) + (t.nextAtLabel ? ` · next at ${t.nextAtLabel}` : "");

const writeJsonAtomic = (path: string, v: unknown) => {
  mkdirSync(RATION_DIR, { recursive: true, mode: 0o755 });
  writeFileSync(path + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o644 });
  renameSync(path + ".tmp", path);
};

/** Read the shared state. Stale (> 10 min) or missing = off, so a dead timer never locks anyone out. */
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

/** Writes ration.json atomically and keeps the legacy symlink pointing at it. */
export function writeRation(s: RationState) {
  writeJsonAtomic(RATION_FILE, s);
  try { if (!existsSync(RATION_LINK) || !lstatSync(RATION_LINK).isSymbolicLink()) { try { unlinkSync(RATION_LINK); } catch {} symlinkSync("ration/ration.json", RATION_LINK); } } catch { /* best effort */ }
}

/** Persisted activations; a missing or unreadable file is no activation. */
export function readActivations(path = ACTIVATION_FILE): Activations {
  try { return JSON.parse(readFileSync(path, "utf8")) as Activations; } catch { return {}; }
}

/** Writes activation.json atomically. */
export function writeActivations(a: Activations) {
  writeJsonAtomic(ACTIVATION_FILE, a);
}
// #endregion
