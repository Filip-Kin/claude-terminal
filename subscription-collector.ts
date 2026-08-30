// Subscription-usage collector: sample the claude.ai subscription rate-limit windows (the real
// "session limit" = rolling 5-hour, plus the 7-day weekly limit) over time, alongside the
// concurrent account-wide cumulative output tokens. This is the dataset to later fit
// "utilisation vs output tokens", so resources can eventually be shared fairly across the guest
// Claudes (who all burn Filip's ONE subscription limit via the shared OAuth token).
//
// WHY A SEPARATE MODULE, and how it gets the data without an SDK query of its own:
// the rate-limit numbers only exist inside the running claude-terminal.service (app-runner's
// getSubscriptionUsage() keeps a single long-lived SDK control query and caches the snapshot
// ~90s). The 60s collector is a fresh short-lived process with no such query, so it just READS the
// service's already-computed snapshot over loopback (GET /app/api/usage). That call also nudges
// the service to refresh when stale, so polling here keeps the snapshot fresh for free.
//
// Non-fatal by contract: a stopped service / missing subscription data must never disturb token
// collection. No-ops quietly when the snapshot is unavailable.
import { openDb } from "./db.ts";

// Kept in a sibling table inside usage.db. IF NOT EXISTS so the collector creates it on its
// next tick with no migration and no service restart.
const ENSURE = `
CREATE TABLE IF NOT EXISTS subscription_samples (
  ts               INTEGER PRIMARY KEY,   -- unix ms when this row was sampled
  fetched_at       INTEGER,               -- unix ms the SDK snapshot itself was measured (lets us
                                          -- tell a fresh reading from a repeat of the cached one)
  subscription     TEXT,                  -- 'team' | 'max' | 'pro' | ...
  five_hour_util   REAL,                  -- rolling 5h window: percent used 0-100, or NULL
  five_hour_reset  TEXT,                  -- ISO 8601 when the 5h window resets
  seven_day_util   REAL,                  -- 7-day window: percent used 0-100, or NULL
  seven_day_reset  TEXT,                  -- ISO 8601 when the 7-day window resets
  cum_output       INTEGER,               -- account-wide cumulative output tokens (sum of all
                                          -- LOCAL users; they all share the one subscription limit)
  cum_total        INTEGER,               -- account-wide cumulative total tokens (incl cache)
  active_users     INTEGER,               -- local users active within the recent window
  per_user_output  TEXT,                  -- JSON { user: cumulativeOutput } snapshot, for later
                                          -- attribution of who was burning during this sample
  per_model_output TEXT,                  -- JSON { model: cumulativeOutput } account-wide, from
                                          -- model_usage. The model-mix covariate: a window's
                                          -- delta per model is what lets the fit weight Opus
                                          -- against Haiku instead of averaging them away.
  per_model_total  TEXT,                  -- JSON { model: cumulativeTotal }, same shape
  five_hour_window INTEGER,               -- reset epoch ms rounded to 5 min = a STABLE window id.
                                          -- five_hour_reset itself is recomputed per response and
                                          -- jitters by ~1s, so grouping on it splits one real
                                          -- window into hundreds of keys (826 keys for 7 windows).
  seven_day_window INTEGER,               -- same, for the 7-day window
  available        INTEGER,               -- rate_limits_available: 1 real reading, 0 not offered
  cum_input        INTEGER,               -- account-wide cumulative input tokens
  cum_cache_creation INTEGER,             -- account-wide cumulative cache-creation tokens. Fitting
                                          -- output ALONE leaves 7.25pp RMS error on the 5h window;
                                          -- output + cache_creation cuts that to 4.95pp, with a
                                          -- cache-creation token costing ~1/14th of an output one.
                                          -- Recorded here, not just derived from model_usage, so
                                          -- the series survives transcripts being rotated away.
  cum_cache_read   INTEGER                -- account-wide cumulative cache-read tokens
);`;

// Columns added after the table shipped. SQLite has no ADD COLUMN IF NOT EXISTS, so check
// first; each is nullable, so old rows simply carry NULL and the fit ignores them.
const ADDED_COLUMNS: Record<string, string> = {
  per_model_output: "TEXT",
  per_model_total: "TEXT",
  five_hour_window: "INTEGER",
  seven_day_window: "INTEGER",
  available: "INTEGER",
  cum_cache_read: "INTEGER",
  cum_cache_creation: "INTEGER",
  cum_input: "INTEGER",
};

function ensureColumns(db: any): void {
  const have = new Set((db.query("PRAGMA table_info(subscription_samples)").all() as any[]).map((r) => r.name));
  for (const [col, type] of Object.entries(ADDED_COLUMNS)) {
    if (!have.has(col)) db.exec(`ALTER TABLE subscription_samples ADD COLUMN ${col} ${type}`);
  }
}

// A window id that survives the per-response jitter in resets_at. 5 min is far wider than the
// jitter (~1s) and far narrower than the gap between real windows (5h).
const WINDOW_BUCKET_MS = 5 * 60_000;
function windowId(resetsAt: string | null | undefined): number | null {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  return isFinite(t) ? Math.round(t / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS : null;
}

type SubWindow = { utilization: number | null; resetsAt: string | null } | null;
type SubUsage = {
  available?: boolean;
  subscription?: string | null;
  fiveHour?: SubWindow;
  sevenDay?: SubWindow;
  fetchedAt?: number;
} | null;

export async function sampleSubscriptionUsage(configPath: string): Promise<void> {
  const cfg = JSON.parse(await Bun.file(configPath).text());
  const port = cfg.port || 7682;
  const owner = cfg.owner || "filip";
  // How recently a local user must have produced tokens to count as "active right now".
  const activeWindowMs = (Number(cfg.subscriptionActiveWindowMin) || 10) * 60_000;

  // Read the service's current subscription snapshot over loopback. The route is owner-gated on the
  // Remote-User header, which on loopback we set ourselves (same trust model as /internal/tick).
  let sub: SubUsage = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/app/api/usage`, {
      headers: { "Remote-User": owner, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`subscription sample: /app/api/usage HTTP ${res.status}`);
      return;
    }
    const body: any = await res.json();
    sub = body?.subscription || null;
  } catch (e) {
    console.error("subscription sample: fetch failed:", e);
    return;
  }

  // Nothing to record until the service has a real rate-limit reading (null on the very first
  // poll after a restart, or for a non-subscriber session). Skip quietly; the next tick retries.
  if (!sub || sub.available === false) return;
  const five = sub.fiveHour || null;
  const seven = sub.sevenDay || null;
  if (!five && !seven) return;

  const db = openDb(cfg.db); // also ensures the base schema; writable root handle
  try {
    db.exec(ENSURE);
    ensureColumns(db);

    // Account-wide cumulative output = sum over LOCAL users only (external peers are a different
    // account/box and are kept in their own tables, so they never enter this sum).
    const totals = db
      .query(
        `SELECT COALESCE(SUM(output),0) AS output, COALESCE(SUM(total),0) AS total,
                COALESCE(SUM(input),0) AS input, COALESCE(SUM(cache_creation),0) AS cacheCreation,
                COALESCE(SUM(cache_read),0) AS cacheRead FROM cumulative`,
      )
      .get() as { output: number; total: number; input: number; cacheCreation: number; cacheRead: number };

    const perUser: Record<string, number> = {};
    for (const r of db.query("SELECT user, output FROM cumulative").all() as any[]) {
      perUser[r.user] = r.output;
    }

    // Account-wide per-model breakdown, from the table model-collector.ts maintains. Its
    // absolute totals do NOT match cum_output (model_usage is rebuilt from transcripts only,
    // while cumulative also carries the 2026-08-26 claude.ai estimate merge); the fit uses
    // per-window DELTAS, which are consistent.
    const perModelOutput: Record<string, number> = {};
    const perModelTotal: Record<string, number> = {};
    try {
      for (const r of db
        .query("SELECT model, SUM(output) AS output, SUM(total) AS total FROM model_usage GROUP BY model")
        .all() as any[]) {
        perModelOutput[r.model] = r.output;
        perModelTotal[r.model] = r.total;
      }
    } catch {
      /* model_usage not created yet on the very first tick after deploy */
    }

    // Active = local users whose last recorded activity is within the window. meta.last_activity
    // is refreshed earlier in this same collector run, so it reflects the current minute.
    const cutoff = Date.now() - activeWindowMs;
    let active = 0;
    for (const r of db.query("SELECT last_activity FROM meta").all() as any[]) {
      const t = r.last_activity ? Date.parse(r.last_activity) : NaN;
      if (isFinite(t) && t >= cutoff) active++;
    }

    db.query(
      `INSERT OR REPLACE INTO subscription_samples
       (ts, fetched_at, subscription, five_hour_util, five_hour_reset,
        seven_day_util, seven_day_reset, cum_output, cum_total, active_users, per_user_output,
        per_model_output, per_model_total, five_hour_window, seven_day_window, available,
        cum_input, cum_cache_creation, cum_cache_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      typeof sub.fetchedAt === "number" ? sub.fetchedAt : null,
      sub.subscription ?? null,
      five?.utilization ?? null,
      five?.resetsAt ?? null,
      seven?.utilization ?? null,
      seven?.resetsAt ?? null,
      totals.output,
      totals.total,
      active,
      JSON.stringify(perUser),
      JSON.stringify(perModelOutput),
      JSON.stringify(perModelTotal),
      windowId(five?.resetsAt),
      windowId(seven?.resetsAt),
      sub.available === false ? 0 : 1,
      totals.input,
      totals.cacheCreation,
      totals.cacheRead,
    );
    console.log(
      `subscription sample: 5h=${five?.utilization ?? "?"}% 7d=${seven?.utilization ?? "?"}% ` +
        `output=${totals.output} active=${active} models=${Object.keys(perModelOutput).length}`,
    );
  } finally {
    db.close();
  }
}
