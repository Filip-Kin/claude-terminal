/**
 * Upstream login leg: standard OIDC authorization-code + PKCE against Authelia,
 * using a pre-registered confidential client ("homebridge"). We only use this to
 * AUTHENTICATE the human and read their group membership; the token Claude
 * receives is our own, minted here, never Authelia's (no token passthrough).
 */

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { log } from "../log.js";

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

let metadataPromise: Promise<OidcMetadata> | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function metadata(): Promise<OidcMetadata> {
  if (!metadataPromise) {
    const url = config.authelia.issuer + "/.well-known/openid-configuration";
    metadataPromise = fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Authelia discovery ${r.status}`);
        return (await r.json()) as OidcMetadata;
      })
      .catch((err) => {
        metadataPromise = null; // allow retry on next call
        throw err;
      });
  }
  return metadataPromise;
}

export function newVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function buildAuthorizeUrl(params: {
  state: string;
  challenge: string;
  nonce: string;
}): Promise<string> {
  const meta = await metadata();
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", config.authelia.clientId);
  u.searchParams.set("redirect_uri", config.authelia.redirectUri);
  u.searchParams.set("scope", "openid profile email groups");
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface UpstreamIdentity {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
}

export async function exchangeCode(input: {
  code: string;
  verifier: string;
  nonce: string;
}): Promise<UpstreamIdentity> {
  const meta = await metadata();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.authelia.redirectUri,
    client_id: config.authelia.clientId,
    client_secret: config.authelia.clientSecret,
    code_verifier: input.verifier,
  });
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log("authelia token exchange failed", res.status, text.slice(0, 200));
    throw new Error(`Authelia token endpoint ${res.status}`);
  }
  const tok = (await res.json()) as { id_token?: string; access_token?: string };
  if (!tok.id_token) throw new Error("Authelia returned no id_token");

  if (!jwks) jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  const { payload } = await jwtVerify(tok.id_token, jwks, {
    issuer: meta.issuer,
    audience: config.authelia.clientId,
  });
  if (input.nonce && payload.nonce !== input.nonce) {
    throw new Error("Authelia id_token nonce mismatch");
  }

  // Authelia does NOT embed the groups/email/name claims in the id_token by
  // default; they come from the userinfo endpoint (with userinfo_signed_response_alg
  // = none this is plain JSON). The id_token's `sub` stays authoritative.
  let info: Record<string, unknown> = {};
  if (meta.userinfo_endpoint && tok.access_token) {
    const uiRes = await fetch(meta.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (uiRes.ok) {
      info = (await uiRes.json().catch(() => ({}))) as Record<string, unknown>;
    } else {
      log("authelia userinfo failed", uiRes.status);
    }
  }

  const groups = (info.groups as string[] | undefined) ?? (payload.groups as string[] | undefined) ?? [];
  return {
    sub: String(payload.sub),
    email: (info.email as string | undefined) ?? (payload.email as string | undefined),
    name:
      (info.name as string | undefined) ??
      (info.preferred_username as string | undefined) ??
      (payload.name as string | undefined),
    groups,
  };
}
