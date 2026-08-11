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
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}
