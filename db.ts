import { Database } from "bun:sqlite";

// The single SQLite schema shared by the collector and the server. hourly holds
// per-user UTC hour buckets (the historical record imported from the old
// state/*.json files); cumulative holds all-time token totals; offsets are the
// collector's incremental byte positions per transcript; meta is small per-user info.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS hourly (
  user     TEXT NOT NULL,
  hour_utc TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  output   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, hour_utc)
);
CREATE TABLE IF NOT EXISTS cumulative (
  user           TEXT PRIMARY KEY,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS offsets (
  user   TEXT NOT NULL,
  path   TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, path)
);
CREATE TABLE IF NOT EXISTS meta (
  user          TEXT PRIMARY KEY,
  sessions      INTEGER NOT NULL DEFAULT 0,
  models        TEXT NOT NULL DEFAULT '[]',
  last_activity TEXT
);

-- External peers: usage pulled from ANOTHER claude-terminal instance (a friend who
-- runs their own copy and exposes /usage/export). These are snapshots, not deltas:
-- the external collector REPLACEs a peer's rows each pull, so they hold absolute
-- values and never double-count. Kept in their own tables so they never touch the
-- local collector's offset/delta bookkeeping, and so they can be shown on the board
-- while being excluded from the money split. peer = the label from config.
CREATE TABLE IF NOT EXISTS external_cum (
  peer           TEXT NOT NULL,
  user           TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (peer, user)
);
CREATE TABLE IF NOT EXISTS external_hourly (
  peer     TEXT NOT NULL,
  user     TEXT NOT NULL,
  hour_utc TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  output   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (peer, user, hour_utc)
);
CREATE TABLE IF NOT EXISTS external_meta (
  peer          TEXT NOT NULL,
  user          TEXT NOT NULL,
  sessions      INTEGER NOT NULL DEFAULT 0,
  models        TEXT NOT NULL DEFAULT '[]',
  last_activity TEXT,
  fetched_at    TEXT,
  PRIMARY KEY (peer, user)
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}
