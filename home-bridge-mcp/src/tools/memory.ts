/**
 * Read access to the server Claude's persistent memory tree. This is what makes
 * the cloud/mobile Claude actually know about this box: infra, runbooks,
 * conventions (e.g. how the trip field-guide PDFs are built).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function memoryFiles(): string[] {
  if (!existsSync(config.memoryDir)) return [];
  return readdirSync(config.memoryDir).filter((f) => f.endsWith(".md"));
}

/** Resolve a caller-supplied name (slug or filename) to a real file inside the dir. */
function resolveName(name: string): string | null {
  const wanted = basename(name.trim());
  const candidates = [wanted, wanted.endsWith(".md") ? wanted : wanted + ".md"];
  for (const f of memoryFiles()) {
    if (candidates.includes(f)) return f;
    // match on the frontmatter slug / filename stem
    if (f.replace(/\.md$/, "") === wanted.replace(/\.md$/, "")) return f;
  }
  return null;
}

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    "get_memory_index",
    {
      title: "Memory index",
      description:
        "Return MEMORY.md, the one-line-per-memory index of everything the home server's Claude knows " +
        "(infrastructure, services, runbooks, working conventions). Start here, then read_memory the relevant files.",
      inputSchema: {},
    },
    async () => {
      const idx = join(config.memoryDir, "MEMORY.md");
      if (!existsSync(idx)) return fail("MEMORY.md not found");
      return text(readFileSync(idx, "utf8"));
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description:
        "Case-insensitive search across every memory file (filenames + contents). Returns matching files with " +
        "a snippet around each hit. Use read_memory to get a full file.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for, e.g. 'trip field guide' or 'weasyprint'."),
        limit: z.number().int().min(1).max(30).optional().describe("Max files to return. Default 10."),
      },
    },
    async ({ query, limit }) => {
      const q = query.toLowerCase();
      const max = limit ?? 10;
      const hits: string[] = [];
      for (const f of memoryFiles()) {
        const body = readFileSync(join(config.memoryDir, f), "utf8");
        const hay = body.toLowerCase();
        const inName = f.toLowerCase().includes(q);
        const idx = hay.indexOf(q);
        if (!inName && idx < 0) continue;
        let snippet = "";
        if (idx >= 0) {
          const start = Math.max(0, idx - 120);
          const end = Math.min(body.length, idx + 200);
          snippet = (start > 0 ? "..." : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "..." : "");
        } else {
          snippet = body.slice(0, 200).replace(/\s+/g, " ").trim() + "...";
        }
        hits.push(`### ${f}\n${snippet}`);
        if (hits.length >= max) break;
      }
      if (!hits.length) return text(`No memory files matched "${query}".`);
      return text(`${hits.length} match(es) for "${query}":\n\n${hits.join("\n\n")}\n\nUse read_memory("<filename>") for the full file.`);
    },
  );

  server.registerTool(
    "read_memory",
    {
      title: "Read a memory file",
      description: "Return the full contents of one memory file, by filename or slug (e.g. 'project_trip_docs' or 'project_trip_docs.md').",
      inputSchema: {
        name: z.string().min(1).describe("Memory filename or slug."),
      },
    },
    async ({ name }) => {
      const f = resolveName(name);
      if (!f) return fail(`No memory file named "${name}". Try search_memory or get_memory_index.`);
      return text(readFileSync(join(config.memoryDir, f), "utf8"));
    },
  );
}
