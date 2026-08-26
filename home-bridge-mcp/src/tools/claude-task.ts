/**
 * Delegate a job to the home server's Claude. This is the tool that actually
 * unlocks work that needs THIS box: the memory tree, the Nextcloud data, and the
 * local render toolchain (WeasyPrint v66, headless Chromium) for trip field
 * guides. The cloud/mobile Claude gathers the facts, then hands off a concrete
 * instruction here.
 *
 * These tasks can run for minutes, which a synchronous MCP tool call cannot
 * survive (the client severs the connection long before the work finishes). So
 * run_claude_task is ASYNCHRONOUS: it spawns the work as a detached job and
 * returns a job id immediately. Poll get_task_status, then get_task_result.
 * resume_task continues a finished job's Claude session for follow-ups.
 *
 * Runs `claude -p` non-interactively as user filip. It is effectively arbitrary
 * execution on this host, which is why the whole endpoint is admin-only OAuth.
 * Every invocation is logged (and recorded in the requests table).
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { log } from "../log.js";
import {
  startJob,
  getJob,
  listJobs,
  readResultText,
  readStderrTail,
  waitForJob,
  type JobMeta,
} from "./jobs.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function elapsed(job: JobMeta): number {
  return Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
}

/** One-line status summary shared by run_claude_task's inline path and get_task_status. */
function statusLine(job: JobMeta): string {
  const bits = [`job ${job.id}`, `status=${job.status}`, `elapsed=${elapsed(job)}s`];
  if (job.exitCode !== undefined && job.status !== "running") bits.push(`exit=${job.exitCode}`);
  if (job.sessionId) bits.push(`session=${job.sessionId}`);
  if (job.parentId) bits.push(`resumed_from=${job.parentId}`);
  return bits.join("  ");
}

/** Render a finished job's outcome, naming the failure class instead of hiding it. */
function outcome(job: JobMeta): ReturnType<typeof text> {
  if (job.status === "completed") {
    const body = readResultText(job.id);
    return text(body || "(task produced no output)");
  }
  if (job.status === "running") {
    return text(`${statusLine(job)}\n\nStill running. Poll get_task_status, then get_task_result.`);
  }
  const label =
    job.status === "timed_out"
      ? `Task timed out after ${Math.round(job.timeoutMs / 1000)}s.`
      : job.status === "interrupted"
        ? "Task was interrupted (the bridge restarted while it ran)."
        : `Task failed (exit ${job.exitCode}).`;
  const partial = readResultText(job.id);
  const errTail = readStderrTail(job.id);
  return fail(
    `${label}\n${statusLine(job)}\n\n` +
      `Partial output:\n${partial || "(none)"}\n\n` +
      `Stderr tail:\n${errTail || "(none)"}`,
  );
}

/** Resolve a prompt from an inline string and/or a prompt_file (file appended to prompt if both given). */
function resolvePrompt(prompt: string | undefined, promptFile: string | undefined): { prompt?: string; error?: string } {
  if (promptFile) {
    const abs = isAbsolute(promptFile) ? promptFile : resolve(config.filesRoot, promptFile);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { error: `prompt_file not found: ${abs}` };
    try {
      const body = readFileSync(abs, "utf8");
      return { prompt: prompt ? `${prompt}\n\n${body}` : body };
    } catch (e) {
      return { error: `prompt_file unreadable: ${(e as Error).message}` };
    }
  }
  if (prompt) return { prompt };
  return { error: "Provide prompt or prompt_file." };
}

function resolveCwd(working_dir: string | undefined): { cwd?: string; error?: string } {
  if (!working_dir) return { cwd: config.claude.cwd };
  if (!existsSync(working_dir) || !statSync(working_dir).isDirectory()) {
    return { error: `working_dir not found or not a directory: ${working_dir}` };
  }
  return { cwd: working_dir };
}

export function registerClaudeTaskTool(server: McpServer): void {
  if (!config.claude.enabled) {
    log("run_claude_task disabled (BRIDGE_ENABLE_CLAUDE_TASK=0)");
    return;
  }

  const maxTimeout = config.claude.timeoutMaxMs / 1000;

  server.registerTool(
    "run_claude_task",
    {
      title: "Delegate a task to the home server Claude",
      description:
        "Run a Claude task ON the home server, with full access to the memory tree, Nextcloud data, and the local " +
        "toolchain (e.g. rendering trip field-guide PDFs with WeasyPrint/Chromium). ASYNC: returns a job id " +
        "immediately; poll get_task_status then fetch get_task_result. Set wait_seconds to block briefly and get " +
        "the result inline for quick tasks. Give a complete, self-contained instruction (or point at one with " +
        "prompt_file). Use dry_run to preview what would run without executing.",
      inputSchema: {
        prompt: z.string().optional().describe("A complete instruction for the server Claude. Optional if prompt_file is given (then this is prepended to the file)."),
        prompt_file: z.string().optional().describe("Path to a file holding the instruction (absolute, or relative to the Nextcloud files root). Use for large briefs instead of stuffing them in prompt."),
        working_dir: z.string().optional().describe("Absolute directory to run in. Defaults to the server home so ~/.claude memory loads."),
        timeout_seconds: z.number().int().min(10).max(maxTimeout).optional().describe(`Max run time before the job is killed. Default ${config.claude.timeoutMs / 1000}, ceiling ${maxTimeout}.`),
        wait_seconds: z.number().int().min(0).max(60).optional().describe("Block up to this long for the task to finish and return its result inline. 0 (default) returns the job id immediately."),
        dry_run: z.boolean().optional().describe("Return the resolved plan (cwd, prompt size/preview, timeout) without executing."),
      },
    },
    async ({ prompt, prompt_file, working_dir, timeout_seconds, wait_seconds, dry_run }) => {
      const p = resolvePrompt(prompt, prompt_file);
      if (p.error) return fail(p.error);
      const c = resolveCwd(working_dir);
      if (c.error) return fail(c.error);

      const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.claude.timeoutMs;

      if (dry_run) {
        return text(
          "DRY RUN — nothing executed.\n" +
            `cwd: ${c.cwd}\n` +
            `timeout: ${timeoutMs / 1000}s\n` +
            `prompt: ${p.prompt!.length} chars\n` +
            `command: ${config.claude.bin} -p <prompt> --dangerously-skip-permissions --output-format json\n\n` +
            `Preview:\n${p.prompt!.slice(0, 500)}${p.prompt!.length > 500 ? "\n…(truncated)" : ""}`,
        );
      }

      const started = startJob({ prompt: p.prompt!, cwd: c.cwd!, timeoutMs });
      log("run_claude_task", `job ${started.id} (${p.prompt!.length} chars, cwd=${c.cwd}, timeout=${timeoutMs / 1000}s)`);

      if (wait_seconds && wait_seconds > 0) {
        const settled = await waitForJob(started.id, wait_seconds * 1000);
        if (settled && settled.status !== "running") return outcome(settled);
      }
      return text(
        `Started ${statusLine(getJob(started.id)!)}\n\n` +
          `Running in the background. Poll get_task_status("${started.id}"), then get_task_result("${started.id}").`,
      );
    },
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Check a delegated task",
      description: "Report the status of a run_claude_task job (running / completed / failed / timed_out / interrupted) with elapsed time and exit code.",
      inputSchema: { job_id: z.string().min(1).describe("The job id returned by run_claude_task.") },
    },
    async ({ job_id }) => {
      const job = getJob(job_id);
      if (!job) return fail(`Unknown job id: ${job_id}`);
      return text(statusLine(job));
    },
  );

  server.registerTool(
    "get_task_result",
    {
      title: "Fetch a delegated task's result",
      description: "Return the output of a run_claude_task job. For finished jobs returns the result (or names the failure with a stderr tail); for running jobs reports that it is still going.",
      inputSchema: { job_id: z.string().min(1).describe("The job id returned by run_claude_task.") },
    },
    async ({ job_id }) => {
      const job = getJob(job_id);
      if (!job) return fail(`Unknown job id: ${job_id}`);
      return outcome(job);
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List recent delegated tasks",
      description: "List recent run_claude_task jobs (most recent first) with status, elapsed time, and prompt preview.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many jobs to list. Default 25.") },
    },
    async ({ limit }) => {
      const rows = listJobs(limit ?? 25);
      if (!rows.length) return text("No jobs yet.");
      return text(
        rows
          .map((j) => `${j.id}  ${j.status.padEnd(11)} ${elapsed(j)}s  ${j.promptPreview.replace(/\s+/g, " ").slice(0, 80)}`)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "resume_task",
    {
      title: "Resume a delegated task",
      description:
        "Continue a previous run_claude_task's Claude session with a follow-up instruction — useful when a render " +
        "needs a fix or a job left partial output. Requires the original job to have captured a session id. Returns " +
        "a new job id; poll it like run_claude_task.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job id to resume."),
        prompt: z.string().optional().describe("Follow-up instruction. Optional if prompt_file is given."),
        prompt_file: z.string().optional().describe("File holding the follow-up instruction (absolute or relative to the files root)."),
        timeout_seconds: z.number().int().min(10).max(maxTimeout).optional().describe(`Max run time. Default ${config.claude.timeoutMs / 1000}.`),
      },
    },
    async ({ job_id, prompt, prompt_file, timeout_seconds }) => {
      const parent = getJob(job_id);
      if (!parent) return fail(`Unknown job id: ${job_id}`);
      if (!parent.sessionId) return fail(`Job ${job_id} has no captured session id, so it cannot be resumed. Start a fresh run_claude_task instead.`);
      const p = resolvePrompt(prompt, prompt_file);
      if (p.error) return fail(p.error);
      const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.claude.timeoutMs;
      const started = startJob({ prompt: p.prompt!, cwd: parent.cwd, timeoutMs, resumeSessionId: parent.sessionId, parentId: parent.id });
      log("resume_task", `job ${started.id} resuming ${parent.id} (session ${parent.sessionId})`);
      return text(
        `Started ${statusLine(getJob(started.id)!)}\n\n` +
          `Resuming session from job ${parent.id}. Poll get_task_status("${started.id}"), then get_task_result("${started.id}").`,
      );
    },
  );
}
