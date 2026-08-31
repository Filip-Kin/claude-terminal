// app-mcp.ts
// Persisted MCP-server configuration for the chat app, kept in its own module (same tactic as
// cost.ts / app-server.ts) so server.ts and app-runner.ts each gain only a one-line hook.
//
// These are the MCP servers the Agent SDK query() connects for /app conversations — the tools
// the LLM can call. This is DISTINCT from the terminal's "Connections" concept (VPN/Tailscale in
// connections.ts + net-sidecar), which is about network reachability, not model tools.
//
// Only the SERIALIZABLE transports are persisted here (stdio / sse / http). The in-process SDK
// server ("app-ui", the ask_user tool) is added live by app-runner and is never stored on disk.
//
// The file is a plain JSON map {name: config}, written to STATE_DIR/claude-app-mcp.json (sits
// beside claude-app-favorites.json / claude-app-titles.json), so it rides the same ~/.claude
// backup rsync as the rest of the app state and never lands in the repo.

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

// The persisted subset: everything McpServerConfig allows EXCEPT the in-process SDK instance
// (which can't be serialized). Matches McpServerConfigForProcessTransport.
export type StoredMcpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; timeout?: number }
  | { type: "sse"; url: string; headers?: Record<string, string>; timeout?: number }
  | { type: "http"; url: string; headers?: Record<string, string>; timeout?: number };

export type StoredMcpMap = Record<string, StoredMcpServer>;

// Names must be simple so they compose cleanly into the mcp__<server>__<tool> tool ids.
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The in-process ask_user server name is reserved — a stored server may never shadow it.
const RESERVED = new Set(["app-ui"]);

// #region persistence (single in-process cache, mirrors loadFavs/loadTitles in app-server.ts)
let cache: StoredMcpMap | null = null;
let cacheFile = "";

export async function loadMcp(file: string): Promise<StoredMcpMap> {
  if (cache && cacheFile === file) return cache;
  cacheFile = file;
  try {
    const o = JSON.parse(await Bun.file(file).text());
    cache = o && typeof o === "object" && !Array.isArray(o) ? (o as StoredMcpMap) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function saveMcp(file: string, map: StoredMcpMap) {
  cache = map;
  cacheFile = file;
  await Bun.write(file, JSON.stringify(map, null, 2));
  // 0600 — this file can hold MCP env/header secrets (API keys/tokens), so keep it owner-only.
  try { const { chmod } = await import("fs/promises"); await chmod(file, 0o600); } catch {}
}
// #endregion

// #region validation — reject anything the SDK couldn't use, with a human-readable reason
export function validateServer(name: string, cfg: any): string | null {
  if (!NAME_RE.test(name)) return "name must be 1-64 chars of letters, digits, _ or -";
  if (RESERVED.has(name)) return `"${name}" is reserved`;
  if (!cfg || typeof cfg !== "object") return "config must be an object";
  const type = cfg.type || "stdio";
  if (type === "stdio") {
    if (typeof cfg.command !== "string" || !cfg.command.trim()) return "stdio server needs a command";
    if (cfg.args != null && !(Array.isArray(cfg.args) && cfg.args.every((a: any) => typeof a === "string"))) return "args must be an array of strings";
    if (cfg.env != null && typeof cfg.env !== "object") return "env must be an object";
    return null;
  }
  if (type === "sse" || type === "http") {
    if (typeof cfg.url !== "string" || !/^https?:\/\//.test(cfg.url)) return `${type} server needs an http(s) url`;
    if (cfg.headers != null && typeof cfg.headers !== "object") return "headers must be an object";
    return null;
  }
  return `unknown type "${type}" (use stdio, sse or http)`;
}

// Normalize a validated config down to just the fields the SDK reads (drops any extra keys).
export function normalizeServer(cfg: any): StoredMcpServer {
  const type = cfg.type || "stdio";
  if (type === "sse" || type === "http") {
    const out: any = { type, url: String(cfg.url) };
    if (cfg.headers && typeof cfg.headers === "object") out.headers = cfg.headers;
    if (typeof cfg.timeout === "number") out.timeout = cfg.timeout;
    return out;
  }
  const out: any = { type: "stdio", command: String(cfg.command) };
  if (Array.isArray(cfg.args)) out.args = cfg.args.map(String);
  if (cfg.env && typeof cfg.env === "object") out.env = cfg.env;
  if (typeof cfg.timeout === "number") out.timeout = cfg.timeout;
  return out;
}
// #endregion

// #region mutations
export async function upsertServer(file: string, name: string, cfg: any): Promise<{ ok: boolean; error?: string; servers?: StoredMcpMap }> {
  const err = validateServer(name, cfg);
  if (err) return { ok: false, error: err };
  const map = { ...(await loadMcp(file)) };
  map[name] = normalizeServer(cfg);
  await saveMcp(file, map);
  return { ok: true, servers: map };
}

export async function removeServer(file: string, name: string): Promise<StoredMcpMap> {
  const map = { ...(await loadMcp(file)) };
  delete map[name];
  await saveMcp(file, map);
  return map;
}
// #endregion

// The stored map, ready to hand to the SDK's mcpServers option / setMcpServers (identical shape —
// StoredMcpServer is a subset of McpServerConfig). Kept as a helper so callers don't cast.
export async function mcpServersForQuery(file: string): Promise<Record<string, McpServerConfig>> {
  return (await loadMcp(file)) as unknown as Record<string, McpServerConfig>;
}
