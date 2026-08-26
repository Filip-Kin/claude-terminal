/**
 * Our own access tokens. We are both issuer and verifier, so a symmetric HS256
 * secret is sufficient and simpler than publishing a JWKS. The token is
 * audience-bound (RFC 8707): aud == the canonical MCP resource URI, and we
 * reject any token whose audience is not us.
 */

import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

const secret = new TextEncoder().encode(config.tokenSecret);

export interface AccessClaims {
  sub: string; // user subject from Authelia
  email?: string;
  name?: string;
  groups: string[];
  scope: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    groups: claims.groups,
    scope: claims.scope,
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(config.publicUrl)
    .setSubject(claims.sub)
    .setAudience(config.resource)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtl}s`)
    .sign(secret);
}

/** Verify signature, expiry, issuer, and (critically) that the audience is us. */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.publicUrl,
    audience: config.resource,
  });
  return {
    sub: String(payload.sub),
    email: payload.email as string | undefined,
    name: payload.name as string | undefined,
    groups: (payload.groups as string[]) ?? [],
    scope: (payload.scope as string) ?? "",
  };
}
