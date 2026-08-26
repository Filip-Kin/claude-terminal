/**
 * Job registry for delegated Claude tasks.
 *
 * run_claude_task can run for minutes. A synchronous MCP tool call has its
 * connection severed client-side (the Claude app's per-call timeout) long before
 * nginx's 3600s ceiling, so long tasks used to die with an opaque
 * "an error occurred: <request id>". Instead, tasks now run as detached jobs:
 * the tool returns a job id immediately and the caller polls get_task_status /
 * get_task_result.
 *
 * Durable metadata lives in SQLite (see db.ts) so status survives client
 * reconnects and a service restart. Live stdout/stderr is streamed to files
 * under data/jobs/<id>/ while a job runs; on completion the parsed result and a
 * stderr tail are copied into the jobs table.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../log.js";
import { getDb } from "../db.js";

export type JobStatus = "running" | "completed" | "failed" | "timed_out" | "interrupted";

export interface JobMeta {
  id: string;
  /** Set when this job resumes another job's Claude session. */
  parentId?: string;
  /** Claude session id, captured from --output-format json. Enables resume. */
  sessionId?: string;
  status: JobStatus;
  cwd: string;
  timeoutMs: number;
  /** First chars of the prompt, for list_tasks readability. */
  promptPreview: string;
  promptChars: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** Length of the parsed result text once finished. */
  resultChars?: number;
}

const JOBS_DIR = join(config.dataDir, "jobs");
/** Live children of THIS process, so we can still read partial output while running. */
const live = new Map<string, ChildProcess>();

function jobDir(id: string): string {
  return join(JOBS_DIR, id);
}
export function outPath(id: string): string {
  return join(jobDir(id), "out.log");
}
export function errPath(id: string): string {
  return join(jobDir(id), "err.log");
}

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

interface JobRow {
  id: string;
  parent_id: string | null;
  session_id: string | null;
  status: JobStatus;
  cwd: string;
  timeout_ms: number;
  prompt_preview: string | null;
  prompt_chars: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  result_chars: number | null;
  result_text: string | null;
  stderr_tail: string | null;
}

function rowToMeta(r: JobRow): JobMeta {
  return {
    id: r.id,
    parentId: r.parent_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    status: r.status,
    cwd: r.cwd,
    timeoutMs: r.timeout_ms,
    promptPreview: r.prompt_preview ?? "",
    promptChars: r.prompt_chars ?? 0,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    exitCode: r.exit_code ?? undefined,
    resultChars: r.result_chars ?? undefined,
  };
}

/** claude --output-format json prints one JSON object on stdout. Pull out the useful bits. */
function parseClaudeJson(raw: string): { sessionId?: string; resultText?: string; isError?: boolean } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
      resultText: typeof obj.result === "string" ? obj.result : undefined,
      isError:
        obj.is_error === true ||
        obj.subtype === "error_max_turns" ||
        obj.subtype === "error_during_execution",
    };
  } catch {
    return {};
  }
}

export interface StartJobOpts {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** Resume this Claude session instead of starting fresh. */
  resumeSessionId?: string;
  /** The job this one resumes, recorded for lineage. */
  parentId?: string;
}

/** Spawn a claude task as a detached job and return its metadata immediately. */
export function startJob(opts: StartJobOpts): JobMeta {
  const id = randomUUID();
  mkdirSync(jobDir(id), { recursive: true });

  const meta: JobMeta = {
    id,
    parentId: opts.parentId,
    status: "running",
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    promptPreview: opts.prompt.slice(0, 200),
    promptChars: opts.prompt.length,
    startedAt: Date.now(),
  };

  getDb()
    .query(
      `INSERT INTO jobs (id, parent_id, status, cwd, timeout_ms, prompt_preview, prompt_chars, started_at)
       VALUES ($id, $parent, 'running', $cwd, $timeout, $preview, $chars, $started)`,
    )
    .run({
      $id: id,
      $parent: opts.parentId ?? null,
      $cwd: opts.cwd,
      $timeout: opts.timeoutMs,
      $preview: meta.promptPreview,
      $chars: meta.promptChars,
      $started: meta.startedAt,
    });

  const args = ["-p", opts.prompt, "--dangerously-skip-permissions", "--output-format", "json"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  const child = spawn(config.claude.bin, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.set(id, child);

  child.stdout.pipe(createWriteStream(outPath(id)));
  child.stderr.pipe(createWriteStream(errPath(id)));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, opts.timeoutMs);

  const finalize = (status: JobStatus, exitCode: number) => {
    live.delete(id);
    const raw = readIfExists(outPath(id));
    const parsed = parseClaudeJson(raw);
    const resultText = parsed.resultText ?? (status === "completed" ? raw : "");
    const finalStatus: JobStatus = status === "completed" && parsed.isError ? "failed" : status;
    getDb()
      .query(
        `UPDATE jobs SET status=$status, ended_at=$ended, exit_code=$exit, session_id=$sid,
           result_text=$result, result_chars=$rchars, stderr_tail=$stderr WHERE id=$id`,
      )
      .run({
        $status: finalStatus,
        $ended: Date.now(),
        $exit: exitCode,
        $sid: parsed.sessionId ?? null,
        $result: resultText || null,
        $rchars: resultText ? resultText.length : null,
        $stderr: readIfExists(errPath(id)).slice(-4000) || null,
        $id: id,
      });
    log("job", id, finalStatus, `(exit ${exitCode})`);
  };

  child.on("close", (code) => {
    clearTimeout(timer);
    finalize(timedOut ? "timed_out" : code === 0 ? "completed" : "failed", code ?? -1);
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    log("job", id, "spawn error", e.message);
    try {
      createWriteStream(errPath(id), { flags: "a" }).end(`\nspawn error: ${e.message}\n`);
    } catch {
      /* best effort */
    }
    finalize("failed", -1);
  });

  return meta;
}

export function getJob(id: string): JobMeta | undefined {
  const row = getDb().query("SELECT * FROM jobs WHERE id = $id").get({ $id: id }) as JobRow | null;
  return row ? rowToMeta(row) : undefined;
}

export function listJobs(limit = 25): JobMeta[] {
  const rows = getDb()
    .query("SELECT * FROM jobs ORDER BY started_at DESC LIMIT $limit")
    .all({ $limit: limit }) as JobRow[];
  return rows.map(rowToMeta);
}

/**
 * Result text for a finished job (from the DB); for a still-running job, the
 * partial stdout captured so far on disk.
 */
export function readResultText(id: string): string {
  const row = getDb().query("SELECT status, result_text FROM jobs WHERE id = $id").get({ $id: id }) as
    | { status: JobStatus; result_text: string | null }
    | null;
  if (!row) return "";
  if (row.status === "running") {
    const raw = readIfExists(outPath(id));
    return parseClaudeJson(raw).resultText ?? raw;
  }
  return row.result_text ?? "";
}

export function readStderrTail(id: string, chars = 2000): string {
  const row = getDb().query("SELECT status, stderr_tail FROM jobs WHERE id = $id").get({ $id: id }) as
    | { status: JobStatus; stderr_tail: string | null }
    | null;
  if (!row) return "";
  if (row.status === "running") return readIfExists(errPath(id)).slice(-chars);
  return (row.stderr_tail ?? "").slice(-chars);
}

/**
 * Wait until a job leaves "running" or the deadline passes. Lets run_claude_task
 * optionally return an inline result for quick tasks.
 */
export function waitForJob(id: string, maxMs: number): Promise<JobMeta | undefined> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + maxMs;
    const tick = () => {
      const job = getJob(id);
      if (!job || job.status !== "running" || Date.now() >= deadline) return resolvePromise(job);
      setTimeout(tick, 250).unref();
    };
    tick();
  });
}
