// One-shot history rescue: import the legacy per-user state/*.json buckets into
// SQLite. This is MANDATORY before anything old is deleted — for several users
// (ian/kate/michel) the transcripts are already rotated away and these state files
// are the ONLY surviving copy of their usage history.
//
// Preserves the collector's byte-offsets verbatim so the new collector resumes from
// the same positions and never re-reads (which would double-count).
//
// Usage: bun run migrate-state.ts [stateDir] [dbPath]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";

const STATE_DIR = process.argv[2] || "/home/filip/guest-claude/usage/state";
const DB_PATH = process.argv[3] || "/var/lib/claude-terminal/usage.db";

const db = openDb(DB_PATH);

const insHour = db.prepare(
  "INSERT OR REPLACE INTO hourly (user, hour_utc, total, output) VALUES (?, ?, ?, ?)",
);
const insCum = db.prepare(
  "INSERT OR REPLACE INTO cumulative (user, input, output, cache_creation, cache_read, total) VALUES (?, ?, ?, ?, ?, ?)",
);
const insOff = db.prepare(
  "INSERT OR REPLACE INTO offsets (user, path, offset) VALUES (?, ?, ?)",
);
const insMeta = db.prepare(
  "INSERT OR REPLACE INTO meta (user, sessions, models, last_activity) VALUES (?, ?, ?, ?)",
);

const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
let grandOutput = 0;

for (const f of files) {
  const user = f.replace(/\.json$/, "");
  const s = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
  const hours = s.hours || {};
  const cum = s.cumulative || {};
  const offs = s.offsets || {};

  const tx = db.transaction(() => {
    for (const [hk, b] of Object.entries<any>(hours)) {
      insHour.run(user, hk, b.total || 0, b.output || 0);
    }
    insCum.run(
      user,
      cum.input || 0,
      cum.output || 0,
      cum.cache_creation || 0,
      cum.cache_read || 0,
      cum.total || 0,
    );
    for (const [p, off] of Object.entries<any>(offs)) {
      insOff.run(user, p, off as number);
    }
    insMeta.run(
      user,
      s.sessions || 0,
      JSON.stringify(s.models || []),
      s.last_activity || null,
    );
  });
  tx();

  grandOutput += cum.output || 0;
  console.log(
    `imported ${user.padEnd(10)} hours=${Object.keys(hours).length
      .toString()
      .padStart(4)}  cum.output=${cum.output || 0}  offsets=${Object.keys(offs).length}`,
  );
}

console.log(`\ntotal cum.output across all users = ${grandOutput}`);
db.close();
