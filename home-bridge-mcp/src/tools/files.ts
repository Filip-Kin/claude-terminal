/**
 * Scoped file access into Filip's Nextcloud data (ncdata/filip/files). Lets the
 * cloud/mobile Claude pull existing trip folders, read the generation guide, and
 * drop results back. Everything is confined to BRIDGE_FILES_ROOT with a
 * traversal guard.
 *
 * Note: creating files here does NOT make them appear in the Nextcloud web UI
 * until `occ files:scan` runs. For anything nontrivial (rendering a PDF, then
 * chown + scan) prefer run_claude_task, which follows the documented runbook.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, sep, dirname, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const ROOT = resolve(config.filesRoot);

/** Resolve a caller path against ROOT and refuse anything that escapes it. */
function safe(rel: string): string | null {
  const abs = resolve(ROOT, "." + sep + rel.replace(/^[/\\]+/, ""));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

const MAX_READ = 512 * 1024;

/** Trigger a Nextcloud rescan so a freshly-written file appears in the web UI. */
function occScan(abs: string): { ok: boolean; detail: string } {
  const rel = relative(ROOT, abs).split(sep).join("/");
  const ncPath = `/${config.nextcloud.dataUser}/files/${rel}`;
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-u", config.nextcloud.occUser, config.nextcloud.container, "php", "occ", "files:scan", `--path=${ncPath}`],
      { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, detail: out.trim().split("\n").slice(-3).join("\n") || `scanned ${ncPath}` };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, detail: (err.stderr || err.message || "unknown error").toString().trim() };
  }
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: `List entries in a directory under the Nextcloud files root (${config.filesRoot}). Path is relative to that root; "" or "/" lists the top level.`,
      inputSchema: {
        path: z.string().optional().describe("Directory relative to the files root. Default root."),
      },
    },
    async ({ path }) => {
      const abs = safe(path ?? "");
      if (!abs) return fail("Path escapes the files root.");
      if (!existsSync(abs)) return fail(`Not found: ${path ?? "/"}`);
      const st = statSync(abs);
      if (!st.isDirectory()) return fail(`Not a directory: ${path ?? "/"}`);
      const rows = readdirSync(abs)
        .sort()
        .map((name) => {
          const s = statSync(join(abs, name));
          return s.isDirectory() ? `${name}/` : `${name}\t${s.size}b`;
        });
      return text(`${relative(ROOT, abs) || "."}:\n${rows.join("\n") || "(empty)"}`);
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Return the contents of a text file under the Nextcloud files root (up to 512 KB).",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the files root."),
      },
    },
    async ({ path }) => {
      const abs = safe(path);
      if (!abs) return fail("Path escapes the files root.");
      if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`Not a file: ${path}`);
      if (statSync(abs).size > MAX_READ) return fail(`File too large (>512 KB): ${path}`);
      return text(readFileSync(abs, "utf8"));
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a text file under the Nextcloud files root. Parent directories are created as needed. " +
        "Pass scan:true to make it show up in the Nextcloud web UI immediately (runs occ files:scan). For " +
        "PDFs/rendered output prefer run_claude_task.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the files root."),
        content: z.string().describe("Full file contents to write."),
        scan: z.boolean().optional().describe("Run occ files:scan on the path after writing so it appears in the Nextcloud web UI. Default false."),
      },
    },
    async ({ path, content, scan }) => {
      const abs = safe(path);
      if (!abs) return fail("Path escapes the files root.");
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        // ncdata standard: filip:www-data, group-writable so www-data can serve/modify it.
        try {
          chmodSync(abs, 0o664);
        } catch {
          /* non-fatal: setgid parent usually gives the right group already */
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EACCES" || e.code === "EPERM") {
          return fail(
            `Write failed (${e.code}) on ${relative(ROOT, abs)}. That path is likely www-data-owned and not group-writable. ` +
              `Fix per the ncdata standard: chown filip:www-data + chmod g+rwX (setgid) on the parent dir, ` +
              `or use run_claude_task to write it as a www-data group member.`,
          );
        }
        return fail(`Write failed: ${e.message}`);
      }

      let msg = `Wrote ${content.length} bytes to ${relative(ROOT, abs)}.`;
      if (scan) {
        const r = occScan(abs);
        msg += r.ok ? `\nScanned into Nextcloud:\n${r.detail}` : `\nWrote OK, but occ files:scan failed: ${r.detail}`;
      } else {
        msg += " Pass scan:true (or use run_claude_task) if it should appear in the Nextcloud web UI.";
      }
      return text(msg);
    },
  );
}
