// Per-model token collector: the same transcripts the main collector reads, bucketed by
// UTC minute AND by model.
//
// WHY: the subscription's session limit is not a flat count of tokens. Fitting utilisation
// against undifferentiated output tokens gives a slope that wanders roughly 2x between
// windows (17k to 32k output tokens per 1% of the 5h window, measured over 2026-08-28..30),
// and the spread does NOT track which user was burning: both extremes were owner-only
// windows. Model mix is the obvious remaining covariate, and nothing in usage.db recorded it.
// This table does, so the fit can weight Opus/Sonnet/Haiku separately.
//
// WHY ITS OWN OFFSETS TABLE: model_offsets starts empty, so the first run reads every
// transcript from byte 0 and back-fills all history, while the main collector's `offsets`
// stay where they are. Two independent byte cursors over the same files, neither able to
// double-count the other. After that first catch-up both passes only read the new tail.
//
// Non-fatal by contract: called from collector.ts inside a try/catch, so a failure here
// must never disturb token collection.
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { openDb } from "./db.ts";
import { minuteKey, trackedUsers, userTranscripts, type CollectorConfig } from "./transcripts.ts";

// IF NOT EXISTS so this ships on the next collector tick with no migration and no service
// restart, the same way subscription_samples did.
const ENSURE = `
CREATE TABLE IF NOT EXISTS model_usage (
  user           TEXT NOT NULL,
  minute_utc     TEXT NOT NULL,
  model          TEXT NOT NULL,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, minute_utc, model)
);
CREATE TABLE IF NOT EXISTS model_offsets (
  user   TEXT NOT NULL,
  path   TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, path)
);
CREATE INDEX IF NOT EXISTS model_usage_minute ON model_usage (minute_utc);
`;

// message.usage field -> our column name (the same set the main collector records)
const TOKEN_KEYS: Record<string, string> = {
  input: "input_tokens",
  output: "output_tokens",
  cache_creation: "cache_creation_input_tokens",
  cache_read: "cache_read_input_tokens",
};

type Bucket = { input: number; output: number; cache_creation: number; cache_read: number; total: number };
const zero = (): Bucket => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 });

export async function sampleModelUsage(configPath: string): Promise<void> {
  const cfg: CollectorConfig & { db: string } = JSON.parse(await Bun.file(configPath).text());
  const db = openDb(cfg.db);
  try {
    db.exec(ENSURE);

    const getOffsets = db.prepare("SELECT path, offset FROM model_offsets WHERE user = ?");
    const setOffset = db.prepare("INSERT OR REPLACE INTO model_offsets (user, path, offset) VALUES (?, ?, ?)");
    const upBucket = db.prepare(
      `INSERT INTO model_usage (user, minute_utc, model, input, output, cache_creation, cache_read, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user, minute_utc, model) DO UPDATE SET
         input=input+excluded.input, output=output+excluded.output,
         cache_creation=cache_creation+excluded.cache_creation,
         cache_read=cache_read+excluded.cache_read, total=total+excluded.total`,
    );

    for (const user of trackedUsers(cfg)) {
      const offsets = new Map<string, number>();
      for (const r of getOffsets.all(user) as any[]) offsets.set(r.path, r.offset);

      // key: minute + tab + model, so a model id containing a space cannot split wrong
      const delta = new Map<string, Bucket>();
      const offsetUpdates = new Map<string, number>();

      for (const f of userTranscripts(cfg, user)) {
        let fd: number;
        try {
          fd = openSync(f, "r");
        } catch {
          continue;
        }
        try {
          const size = fstatSync(fd).size;
          let start = offsets.get(f) ?? 0;
          if (start > size) start = 0; // file rewritten or truncated, re-read from the top
          if (start === size) continue;
          const buf = Buffer.allocUnsafe(size - start);
          readSync(fd, buf, 0, size - start, start);
          // Stop at the last complete line; a half-written record is picked up next tick.
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
            const model = String(rec.message?.model || "unknown");
            const key = minuteKey(rec.timestamp || "") + "\t" + model;
            const b = delta.get(key) || zero();
            let lineTotal = 0;
            for (const [name, src] of Object.entries(TOKEN_KEYS)) {
              const v = usage[src];
              if (typeof v !== "number") continue;
              (b as any)[name] += v;
              lineTotal += v;
            }
            b.total += lineTotal;
            delta.set(key, b);
          }
          offsetUpdates.set(f, start + consumed.length);
        } finally {
          closeSync(fd);
        }
      }

      const tx = db.transaction(() => {
        for (const [key, b] of delta) {
          const tab = key.indexOf("\t");
          const mk = key.slice(0, tab);
          const model = key.slice(tab + 1);
          if (b.total) upBucket.run(user, mk, model, b.input, b.output, b.cache_creation, b.cache_read, b.total);
        }
        for (const [p, off] of offsetUpdates) setOffset.run(user, p, off);
      });
      tx();
    }
  } finally {
    db.close();
  }
}
