/**
 * OAuth state.
 *
 * Registered clients and refresh tokens are PERSISTED (data/oauth-state.json) so
 * a service restart or redeploy doesn't force every device to re-register and
 * re-login. Authorization codes and in-flight logins are short-lived and stay in
 * memory (a restart mid-login just means the user retries).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

export interface RefreshRecord {
  token: string;
  client_id: string;
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  scope: string;
  resource: string;
  created_at: number;
}

/** A Claude->us authorization code, awaiting exchange at /oauth/token. */
export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string; // S256 challenge from Claude
  resource: string;
  scope: string;
  // Identity resolved from Authelia:
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  expires_at: number;
}

/** An in-flight login: created at /oauth/authorize, consumed at the Authelia callback. */
export interface PendingLogin {
  login_id: string;
  // Original Claude request, replayed after Authelia auth:
  client_id: string;
  redirect_uri: string;
  client_state: string;
  code_challenge: string;
  resource: string;
  scope: string;
  // Our PKCE for the upstream (Authelia) leg:
  authelia_verifier: string;
  nonce: string;
  expires_at: number;
}

const STATE_FILE = join(config.dataDir, "oauth-state.json");
const CODE_TTL_MS = 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

interface Persisted {
  clients: RegisteredClient[];
  refresh: RefreshRecord[];
}

const clients = new Map<string, RegisteredClient>();
const refreshTokens = new Map<string, RefreshRecord>();
const codes = new Map<string, AuthCode>();
const logins = new Map<string, PendingLogin>();

function load(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Persisted;
    for (const c of data.clients ?? []) clients.set(c.client_id, c);
    for (const r of data.refresh ?? []) refreshTokens.set(r.token, r);
  } catch {
    // Corrupt state file: start fresh rather than crash. Devices re-register.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data: Persisted = {
      clients: [...clients.values()],
      refresh: [...refreshTokens.values()],
    };
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  }, 250);
  saveTimer.unref?.();
}

load();

const id = (bytes = 24) => randomBytes(bytes).toString("base64url");

// #region clients
export function registerClient(input: {
  redirect_uris: string[];
  client_name?: string;
}): RegisteredClient {
  const client: RegisteredClient = {
    client_id: "c_" + id(16),
    redirect_uris: input.redirect_uris,
    client_name: input.client_name,
    created_at: Date.now(),
  };
  clients.set(client.client_id, client);
  persist();
  return client;
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return clients.get(clientId);
}
// #endregion

// #region pending logins
export function createLogin(input: Omit<PendingLogin, "login_id" | "expires_at">): PendingLogin {
  const login: PendingLogin = {
    ...input,
    login_id: id(18),
    expires_at: Date.now() + LOGIN_TTL_MS,
  };
  logins.set(login.login_id, login);
  return login;
}

export function takeLogin(loginId: string): PendingLogin | undefined {
  const login = logins.get(loginId);
  if (!login) return undefined;
  logins.delete(loginId);
  if (login.expires_at < Date.now()) return undefined;
  return login;
}
// #endregion

// #region auth codes
export function createCode(input: Omit<AuthCode, "code" | "expires_at">): AuthCode {
  const code: AuthCode = { ...input, code: id(24), expires_at: Date.now() + CODE_TTL_MS };
  codes.set(code.code, code);
  return code;
}

export function takeCode(code: string): AuthCode | undefined {
  const rec = codes.get(code);
  if (!rec) return undefined;
  codes.delete(code); // single-use
  if (rec.expires_at < Date.now()) return undefined;
  return rec;
}
// #endregion

// #region refresh tokens
export function createRefresh(input: Omit<RefreshRecord, "token" | "created_at">): RefreshRecord {
  const rec: RefreshRecord = { ...input, token: "rt_" + id(32), created_at: Date.now() };
  refreshTokens.set(rec.token, rec);
  persist();
  return rec;
}

/** Consume-and-rotate: the old token is invalidated, a new one returned. */
export function rotateRefresh(token: string): RefreshRecord | undefined {
  const rec = refreshTokens.get(token);
  if (!rec) return undefined;
  refreshTokens.delete(token);
  const next = createRefresh({
    client_id: rec.client_id,
    sub: rec.sub,
    email: rec.email,
    name: rec.name,
    groups: rec.groups,
    scope: rec.scope,
    resource: rec.resource,
  });
  return next;
}
// #endregion

// Periodic sweep of expired in-memory entries.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires_at < now) codes.delete(k);
  for (const [k, v] of logins) if (v.expires_at < now) logins.delete(k);
}, 60_000).unref?.();
