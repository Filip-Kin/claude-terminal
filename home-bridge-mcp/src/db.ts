/**
 * SQLite store (Bun's built-in bun:sqlite) for two things:
 *
 *  - jobs:     durable metadata for delegated run_claude_task jobs, so status
 *              survives client reconnects and a service restart.
 *  - requests: a debug log of every MCP request that reaches the server (method,
 *              tool, args, who, outcome, duration). This is what lets us tell an
 *              actual server-side failure apart from a client-side "an error
 *              occurred: <request id>" where the app severed the connection
 *              before we ever replied.
 *
 * Live stdout/stderr while a job runs is streamed to files under data/jobs/<id>/
 * (see jobs.ts); the final result and a stderr tail are copied into the jobs
 * table when the job finishes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

const JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let db: Database | undefined;

export function getDb(): Database {
  if (!db) throw new Error("db not initialized — call initDb() first");
  return db;
}

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT,
    session_id    TEXT,
    status        TEXT NOT NULL,
    cwd           TEXT NOT NULL,
    timeout_ms    INTEGER NOT NULL,
    prompt_preview TEXT,
    prompt_chars  INTEGER,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    exit_code     INTEGER,
    result_chars  INTEGER,
    result_text   TEXT,
    stderr_tail   TEXT
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    who         TEXT,
    session_id  TEXT,
    method      TEXT,
    tool        TEXT,
    args        TEXT,
    ok          INTEGER,
    error       TEXT,
    duration_ms INTEGER
  );`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at);");

  const now = Date.now();
  // A job left "running" belonged to a child that died with the previous process.
  const stale = db.query("UPDATE jobs SET status='interrupted', ended_at=$now WHERE status='running'").run({ $now: now });
  // Bound growth.
  db.query("DELETE FROM jobs WHERE started_at < $cut").run({ $cut: now - JOB_TTL_MS });
  db.query("DELETE FROM requests WHERE ts < $cut").run({ $cut: now - REQUEST_TTL_MS });

  log(`db ready at ${config.dbPath} (${stale.changes} running jobs marked interrupted)`);
}

export interface RequestLogRow {
  ts: number;
  who?: string;
  sessionId?: string;
  method?: string;
  tool?: string;
  args?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

/** Record one MCP request. Never throws into the request path. */
export function logRequest(row: RequestLogRow): void {
  if (!db) return;
  try {
    db.query(
      `INSERT INTO requests (ts, who, session_id, method, tool, args, ok, error, duration_ms)
       VALUES ($ts, $who, $sid, $method, $tool, $args, $ok, $error, $dur)`,
    ).run({
      $ts: row.ts,
      $who: row.who ?? null,
      $sid: row.sessionId ?? null,
      $method: row.method ?? null,
      $tool: row.tool ?? null,
      $args: row.args ?? null,
      $ok: row.ok === undefined ? null : row.ok ? 1 : 0,
      $error: row.error ?? null,
      $dur: row.durationMs ?? null,
    });
  } catch (e) {
    log("request log insert failed:", String((e as Error).message));
  }
}
