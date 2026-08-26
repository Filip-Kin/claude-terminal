/**
 * Central configuration, read once from the environment.
 *
 * The bridge is deliberately a single origin that is BOTH the OAuth 2.1
 * authorization server AND the protected resource (the MCP endpoint). That keeps
 * the metadata simple: issuer == resource origin.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

// Runtime state (SQLite db, secret.key, oauth-state.json, jobs/) lives OUTSIDE the
// ncdata-synced source tree by default in prod (BRIDGE_DATA_DIR) so the Nextcloud
// desktop client never tries to sync a live-mutating DB or replicate secrets to a laptop.
const DATA_DIR = env("BRIDGE_DATA_DIR", join(HERE, "..", "data"));

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** HS256 secret for our own access tokens. Persisted so restarts don't invalidate tokens. */
function loadTokenSecret(): string {
  const fromEnv = env("BRIDGE_TOKEN_SECRET");
  if (fromEnv) return fromEnv;
  const keyFile = join(DATA_DIR, "secret.key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  const generated = randomBytes(48).toString("base64url");
  writeFileSync(keyFile, generated + "\n", { mode: 0o600 });
  return generated;
}

const PUBLIC_URL = stripTrailingSlash(env("BRIDGE_PUBLIC_URL", "http://127.0.0.1:7690"));
const MCP_PATH = "/" + env("BRIDGE_MCP_PATH", "/mcp").replace(/^\/+/, "");

export const config = {
  dataDir: DATA_DIR,

  // Public identity
  publicUrl: PUBLIC_URL,
  mcpPath: MCP_PATH,
  /** RFC 8707 canonical resource identifier this server binds tokens to. */
  resource: PUBLIC_URL + MCP_PATH,

  // Listening
  port: Number(env("PORT", "7690")),
  host: env("HOST", "127.0.0.1"),
  allowedHosts: env("BRIDGE_ALLOWED_HOSTS")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  // Upstream Authelia OIDC
  authelia: {
    issuer: stripTrailingSlash(env("AUTHELIA_ISSUER", "https://auth.filipkin.com")),
    clientId: env("AUTHELIA_CLIENT_ID", "homebridge"),
    clientSecret: env("AUTHELIA_CLIENT_SECRET"),
    /** Our redirect back from Authelia. */
    redirectUri: PUBLIC_URL + "/oauth/authelia/callback",
  },
  requiredGroup: env("BRIDGE_REQUIRED_GROUP", "admins"),

  // Our own tokens
  tokenSecret: loadTokenSecret(),
  tokenTtl: Number(env("BRIDGE_TOKEN_TTL", "3600")),

  // SQLite store for jobs + request log (Bun's built-in bun:sqlite).
  dbPath: env("BRIDGE_DB_PATH", join(DATA_DIR, "bridge.db")),

  // Tool roots
  memoryDir: env("BRIDGE_MEMORY_DIR", "/home/filip/.claude/projects/-home-filip/memory"),
  filesRoot: env("BRIDGE_FILES_ROOT", "/media/nas/filip/ncdata/filip/files"),

  // run_claude_task
  claude: {
    enabled: env("BRIDGE_ENABLE_CLAUDE_TASK", "1") !== "0",
    bin: env("BRIDGE_CLAUDE_BIN", "/home/filip/.local/bin/claude"),
    cwd: env("BRIDGE_CLAUDE_CWD", "/home/filip"),
    timeoutMs: Number(env("BRIDGE_CLAUDE_TIMEOUT", "600")) * 1000,
    /** Ceiling for the caller-supplied timeout_seconds. Tasks run async, so this can be generous. */
    timeoutMaxMs: Number(env("BRIDGE_CLAUDE_TIMEOUT_MAX", "7200")) * 1000,
  },

  // Nextcloud (for write_file's optional occ files:scan via docker exec).
  nextcloud: {
    container: env("BRIDGE_NC_CONTAINER", "nextcloud-aio-nextcloud"),
    occUser: env("BRIDGE_NC_OCC_USER", "www-data"),
    /** Nextcloud user whose files/ tree BRIDGE_FILES_ROOT maps to. */
    dataUser: env("BRIDGE_NC_DATA_USER", "filip"),
  },

  // Dev escape hatch
  devNoAuth: env("BRIDGE_DEV_NO_AUTH") === "1",
} as const;

export type Config = typeof config;
