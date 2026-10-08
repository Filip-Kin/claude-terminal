// Usage collector: incrementally parse Claude Code transcripts into SQLite.
// Faithful port of the ingestion half of the old collect-usage.py (byte-offset
// incremental read, hourly UTC buckets, cumulative token totals, nested-dir
// exclusion), config-driven, with ALL Home Assistant (MQTT + recorder statistics)
// removed. Adds only NEW bytes to existing buckets, so re-runs never double-count.
//
// Reads config.json for: owner + dataDir + extraUsers. Must run as a user that can
// read every configured transcript dir (root, for Filip's 0700 guest dirs).
//
// Usage: bun run collector.ts [configPath]
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { hourKey, trackedUsers as listUsers, userTranscripts, recordLogin, accountRouter } from "./transcripts.ts";
import { sampleModelUsage } from "./model-collector.ts";
import { sampleCloudCost } from "./cost-collector.ts";
import { sampleExternalPeers } from "./external-collector.ts";
import { sampleSubscriptionUsage } from "./subscription-collector.ts";

const CONFIG_PATH = process.argv[2] || join(import.meta.dir, "config.json");
const cfg = JSON.parse(await Bun.file(CONFIG_PATH).text());

const DB_PATH: string = cfg.db;

// message.usage field -> our column name
const TOKEN_KEYS: Record<string, string> = {
  input: "input_tokens",
  output: "output_tokens",
  cache_creation: "cache_creation_input_tokens",
  cache_read: "cache_read_input_tokens",
};

const trackedUsers = listUsers(cfg);

const db = openDb(DB_PATH);
recordLogin(cfg, db as any);
const routeOf = accountRouter(cfg, db as any);
// Start of the first period on an unbilled account: a work row's session count is the number of
// the user's box-login transcripts written since then.
const firstUnbilled = (db.query("SELECT MIN(since_ms) AS t FROM login_periods WHERE email != ?").get(cfg.boxLogin?.billedEmail ?? "") as any)?.t ?? null;

const getOffsets = db.prepare("SELECT path, offset FROM offsets WHERE user = ?");
const getMeta = db.prepare("SELECT models FROM meta WHERE user = ?");
const upHour = db.prepare(
  `INSERT INTO hourly (user, hour_utc, total, output) VALUES (?, ?, ?, ?)
   ON CONFLICT(user, hour_utc) DO UPDATE SET total = total + excluded.total, output = output + excluded.output`,
);
const upCum = db.prepare(
  `INSERT INTO cumulative (user, input, output, cache_creation, cache_read, total) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(user) DO UPDATE SET input=input+excluded.input, output=output+excluded.output,
     cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, total=total+excluded.total`,
);
const setOffset = db.prepare("INSERT OR REPLACE INTO offsets (user, path, offset) VALUES (?, ?, ?)");
const setMeta = db.prepare(
  `INSERT INTO meta (user, sessions, models, last_activity) VALUES (?, ?, ?, ?)
   ON CONFLICT(user) DO UPDATE SET sessions=excluded.sessions, models=excluded.models,
     last_activity=COALESCE(excluded.last_activity, meta.last_activity)`,
);

// Per row (the user, or "<user>_work" for tokens run on an unbilled box login): token deltas,
// hour buckets and models. Offsets stay per user and per file, so routing never re-reads a byte.
type Acc = { cum: { input: number; output: number; cache_creation: number; cache_read: number; total: number }; hours: Map<string, { total: number; output: number }>; models: Set<string>; changed: boolean };
function accFor(accs: Map<string, Acc>, key: string): Acc {
  let a = accs.get(key);
  if (!a) {
    const metaRow = getMeta.get(key) as any;
    a = { cum: { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 }, hours: new Map(), models: new Set(metaRow ? JSON.parse(metaRow.models || "[]") : []), changed: false };
    accs.set(key, a);
  }
  return a;
}

function collectUser(user: string): void {
  const offsets = new Map<string, number>();
  for (const r of getOffsets.all(user) as any[]) offsets.set(r.path, r.offset);

  const accs = new Map<string, Acc>();
  accFor(accs, user); // the user's own row always gets its meta refreshed
  const offsetUpdates = new Map<string, number>();

  // One flat list per user: every project dir walked, other tracked users' nested dirs
  // removed. See transcripts.ts.
  const files = userTranscripts(cfg, user);
  const sessions = files.length;
  for (const f of files) {
    let size: number;
    let fd: number;
    try {
      fd = openSync(f, "r");
    } catch {
      continue;
    }
    try {
      size = fstatSync(fd).size;
      let start = offsets.get(f) ?? 0;
      if (start > size) start = 0;
      if (start === size) continue;
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) continue;
      const consumed = buf.subarray(0, lastNl + 1);
      for (const raw of consumed.toString("utf8").split("\n")) {
        if (!raw.trim()) continue;
        let rec: any;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        const usage = rec.message?.usage;
        if (!usage || typeof usage !== "object") continue;
        const acc = accFor(accs, routeOf(user, f, rec.timestamp || ""));
        const hk = hourKey(rec.timestamp || "");
        const b = acc.hours.get(hk) || { total: 0, output: 0 };
        let lineTotal = 0;
        for (const [name, src] of Object.entries(TOKEN_KEYS)) {
          const v = usage[src];
          if (typeof v !== "number") continue;
          (acc.cum as any)[name] += v;
          lineTotal += v;
          if (name === "output") b.output += v;
        }
        acc.cum.total += lineTotal;
        b.total += lineTotal;
        acc.hours.set(hk, b);
        if (lineTotal) acc.changed = true;
        if (rec.message?.model) acc.models.add(rec.message.model);
      }
      offsetUpdates.set(f, start + consumed.length);
    } finally {
      closeSync(fd);
    }
  }

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const workSessions = () => {
    if (firstUnbilled == null) return 0;
    const root = cfg.dataDir.endsWith("/") ? cfg.dataDir : cfg.dataDir + "/";
    let n = 0;
    for (const f of files) { try { if (f.startsWith(root) && statSync(f).mtimeMs >= firstUnbilled) n++; } catch { /* */ } }
    return n;
  };
  const tx = db.transaction(() => {
    for (const [key, a] of accs) {
      for (const [hk, b] of a.hours) if (b.total || b.output) upHour.run(key, hk, b.total, b.output);
      const c = a.cum;
      if (c.total) upCum.run(key, c.input, c.output, c.cache_creation, c.cache_read, c.total);
      const n = key === user ? sessions : workSessions();
      if (key === user || a.changed) setMeta.run(key, n, JSON.stringify([...a.models].sort()), a.changed ? nowIso : null);
    }
    for (const [p, off] of offsetUpdates) setOffset.run(user, p, off);
  });
  tx();
}

for (const user of trackedUsers) {
  try {
    collectUser(user);
  } catch (e) {
    console.error(`collect ${user} failed:`, e);
  }
}
db.close();

// Per-model split of the same transcripts, into model_usage (own byte cursors, see
// model-collector.ts). Runs before the subscription sample so that sample can snapshot a
// fresh per-model breakdown. Non-fatal: this is analysis data, token collection comes first.
try {
  await sampleModelUsage(CONFIG_PATH);
} catch (e) {
  console.error("model usage sample failed:", e);
}

// Pull usage from any configured external peers (other claude-terminal instances) into
// the external_* tables. Runs BEFORE the tick so the SSE push reflects fresh peer data.
// Non-fatal: an unreachable peer must never disturb local collection. No-ops unless
// externalPeers is configured.
try {
  await sampleExternalPeers(CONFIG_PATH);
} catch (e) {
  console.error("external peers sample failed:", e);
}

// Nudge the server to push a live SSE update to any open dashboard.
const notifyPort = cfg.port || 7682;
try {
  await fetch(`http://127.0.0.1:${notifyPort}/internal/tick`, { method: "POST" });
} catch {
  // server not running / not this deploy -> the page's fallback poll still refreshes
}

// Cloud cost-split sample (separate module + DB). Non-fatal: a slow/unreachable cloud
// host must never disturb token-usage collection. No-ops unless cloudHost is configured.
try {
  await sampleCloudCost(CONFIG_PATH);
} catch (e) {
  console.error("cloud cost sample failed:", e);
}

// Subscription-usage sample: record the claude.ai session (5h) + weekly (7d) rate-limit
// utilisation alongside the concurrent account-wide cumulative output, into the
// subscription_samples table. Runs last (needs the fresh cumulative/meta this tick just wrote)
// and is non-fatal: a stopped service or missing subscription data must never disturb collection.
try {
  await sampleSubscriptionUsage(CONFIG_PATH);
} catch (e) {
  console.error("subscription usage sample failed:", e);
}

