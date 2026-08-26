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
import { openSync, fstatSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { sampleCloudCost } from "./cost-collector.ts";
import { sampleExternalPeers } from "./external-collector.ts";

const CONFIG_PATH = process.argv[2] || join(import.meta.dir, "config.json");
const cfg = JSON.parse(await Bun.file(CONFIG_PATH).text());

const OWNER: string = cfg.owner;
const DB_PATH: string = cfg.db;
const extraUsers: Record<string, string[]> = cfg.extraUsers || {};

// message.usage field -> our column name
const TOKEN_KEYS: Record<string, string> = {
  input: "input_tokens",
  output: "output_tokens",
  cache_creation: "cache_creation_input_tokens",
  cache_read: "cache_read_input_tokens",
};

const trackedUsers = [OWNER, ...Object.keys(extraUsers)];

function projDirs(user: string): string[] {
  if (user === OWNER) return [cfg.dataDir];
  return extraUsers[user] || [];
}

function hourKey(iso: string): string {
  let d = new Date(iso);
  if (isNaN(d.getTime())) d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}`;
}

// recursively list *.jsonl under a dir (absolute paths)
function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const db = openDb(DB_PATH);

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

function collectUser(user: string): void {
  const offsets = new Map<string, number>();
  for (const r of getOffsets.all(user) as any[]) offsets.set(r.path, r.offset);

  const metaRow = getMeta.get(user) as any;
  const models = new Set<string>(metaRow ? JSON.parse(metaRow.models || "[]") : []);

  const cumDelta = { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 };
  const hourDelta = new Map<string, { total: number; output: number }>();
  const offsetUpdates = new Map<string, number>();
  const changed = new Set<string>();
  let sessions = 0;

  for (const proj of projDirs(user)) {
    let isDir = false;
    try {
      isDir = statSync(proj).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    // other tracked users' dirs nested UNDER this proj dir -> their transcripts
    // are counted as those users, not this one.
    const nested: string[] = [];
    for (const u2 of trackedUsers) {
      if (u2 === user) continue;
      for (const d of projDirs(u2)) {
        if (d !== proj && d.startsWith(proj.endsWith("/") ? proj : proj + "/")) nested.push(d);
      }
    }
    const underNested = (f: string) => nested.some((n) => f.startsWith(n.endsWith("/") ? n : n + "/"));

    const files = walkJsonl(proj).filter((f) => !underNested(f));
    for (const f of files.sort()) {
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
          const hk = hourKey(rec.timestamp || "");
          const b = hourDelta.get(hk) || { total: 0, output: 0 };
          let lineTotal = 0;
          for (const [name, src] of Object.entries(TOKEN_KEYS)) {
            const v = usage[src];
            if (typeof v !== "number") continue;
            (cumDelta as any)[name] += v;
            lineTotal += v;
            if (name === "output") b.output += v;
          }
          cumDelta.total += lineTotal;
          b.total += lineTotal;
          hourDelta.set(hk, b);
          if (lineTotal) changed.add(hk);
          if (rec.message?.model) models.add(rec.message.model);
        }
        offsetUpdates.set(f, start + consumed.length);
      } finally {
        closeSync(fd);
      }
    }
    sessions += files.length;
  }

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const tx = db.transaction(() => {
    for (const [hk, b] of hourDelta) if (b.total || b.output) upHour.run(user, hk, b.total, b.output);
    if (cumDelta.total)
      upCum.run(user, cumDelta.input, cumDelta.output, cumDelta.cache_creation, cumDelta.cache_read, cumDelta.total);
    for (const [p, off] of offsetUpdates) setOffset.run(user, p, off);
    setMeta.run(user, sessions, JSON.stringify([...models].sort()), changed.size ? nowIso : null);
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

