/**
 * OAuth 2.1 authorization-server facade.
 *
 * Claude talks OAuth to US (DCR + PKCE + resource indicator). We delegate the
 * actual human login to Authelia, verify group membership, then mint our own
 * audience-bound token. Returns true if it handled the route.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { log } from "../log.js";
import { sendJson, sendHtml, redirect, readJsonBody, readFormBody, esc } from "../http-util.js";
import * as store from "./store.js";
import * as authelia from "./authelia.js";
import { signAccessToken } from "./jwt.js";

function cors(res: ServerResponse, req: IncomingMessage): void {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function statusPage(res: ServerResponse, code: number, title: string, body: string): void {
  sendHtml(
    res,
    code,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.4rem}code{background:#eee;padding:.1em .35em;border-radius:.25em}</style>
<h1>${esc(title)}</h1>${body}`,
  );
}

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;

  // #region discovery metadata
  if (p === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: config.publicUrl,
      authorization_endpoint: config.publicUrl + "/oauth/authorize",
      token_endpoint: config.publicUrl + "/oauth/token",
      registration_endpoint: config.publicUrl + "/oauth/register",
      scopes_supported: ["mcp", "offline_access"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
    return true;
  }

  // RFC 9728. Claude may request the bare path or a resource-suffixed variant.
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource" + config.mcpPath) {
    sendJson(res, 200, {
      resource: config.resource,
      authorization_servers: [config.publicUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
    return true;
  }
  // #endregion

  // #region dynamic client registration (RFC 7591)
  if (p === "/oauth/register") {
    cors(res, req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "invalid_request", error_description: "POST required" });
      return true;
    }
    try {
      const body = await readJsonBody<{ redirect_uris?: string[]; client_name?: string }>(req);
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
      if (!redirectUris.length) {
        sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris required" });
        return true;
      }
      for (const u of redirectUris) {
        if (!/^https:\/\//.test(u) && !/^http:\/\/localhost/.test(u) && !/^http:\/\/127\.0\.0\.1/.test(u)) {
          sendJson(res, 400, { error: "invalid_redirect_uri", error_description: `insecure redirect_uri: ${u}` });
          return true;
        }
      }
      const client = store.registerClient({ redirect_uris: redirectUris, client_name: body.client_name });
      log("registered client", client.client_id, client.client_name ?? "");
      sendJson(res, 201, {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(client.created_at / 1000),
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    } catch (err) {
      sendJson(res, 400, { error: "invalid_request", error_description: String((err as Error).message) });
    }
    return true;
  }
  // #endregion

  // #region /oauth/authorize -> Authelia
  if (p === "/oauth/authorize") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = store.getClient(clientId);

    // Errors before we trust redirect_uri must be shown to the user, not redirected.
    if (!client) {
      statusPage(res, 400, "Unknown client", "<p>This connector is not registered. Remove and re-add it.</p>");
      return true;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      statusPage(res, 400, "Bad redirect", "<p>The redirect URI does not match this client's registration.</p>");
      return true;
    }
    const clientState = q.get("state") ?? "";
    const codeChallenge = q.get("code_challenge") ?? "";
    const method = q.get("code_challenge_method") ?? "";
    const resource = q.get("resource") ?? config.resource;
    const scope = q.get("scope") ?? "mcp";

    // From here on, protocol errors go back to the client's redirect_uri.
    const bounce = (error: string, desc: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", desc);
      if (clientState) u.searchParams.set("state", clientState);
      redirect(res, u.toString());
    };
    if (q.get("response_type") !== "code") return bounce("unsupported_response_type", "only code is supported"), true;
    if (!codeChallenge || method !== "S256") return bounce("invalid_request", "S256 PKCE required"), true;

    const { verifier, challenge } = authelia.newVerifier();
    const nonce = createHash("sha256").update(verifier + ":n").digest("base64url");
    const login = store.createLogin({
      client_id: clientId,
      redirect_uri: redirectUri,
      client_state: clientState,
      code_challenge: codeChallenge,
      resource,
      scope,
      authelia_verifier: verifier,
      nonce,
    });
    try {
      const authorizeUrl = await authelia.buildAuthorizeUrl({ state: login.login_id, challenge, nonce });
      redirect(res, authorizeUrl);
    } catch (err) {
      log("authorize -> authelia failed", String((err as Error).message));
      statusPage(res, 502, "Login unavailable", "<p>Could not reach the login server. Try again shortly.</p>");
    }
    return true;
  }
  // #endregion

  // #region Authelia callback
  if (p === "/oauth/authelia/callback") {
    const q = url.searchParams;
    const loginId = q.get("state") ?? "";
    const login = store.takeLogin(loginId);
    if (!login) {
      statusPage(res, 400, "Login expired", "<p>This login attempt expired or was already used. Start again from Claude.</p>");
      return true;
    }
    if (q.get("error")) {
      const u = new URL(login.redirect_uri);
      u.searchParams.set("error", q.get("error")!);
      if (login.client_state) u.searchParams.set("state", login.client_state);
      redirect(res, u.toString());
      return true;
    }
    const code = q.get("code") ?? "";
    try {
      const identity = await authelia.exchangeCode({
        code,
        verifier: login.authelia_verifier,
        nonce: login.nonce,
      });
      if (!identity.groups.includes(config.requiredGroup)) {
        log("access denied (group)", identity.sub, identity.email ?? "");
        statusPage(
          res,
          403,
          "Access denied",
          `<p>Your account (<code>${esc(identity.email ?? identity.sub)}</code>) is not in the <code>${esc(config.requiredGroup)}</code> group, which this connector requires.</p>`,
        );
        return true;
      }
      const authCode = store.createCode({
        client_id: login.client_id,
        redirect_uri: login.redirect_uri,
        code_challenge: login.code_challenge,
        resource: login.resource,
        scope: login.scope,
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
        groups: identity.groups,
      });
      const u = new URL(login.redirect_uri);
      u.searchParams.set("code", authCode.code);
      if (login.client_state) u.searchParams.set("state", login.client_state);
      log("issued auth code for", identity.email ?? identity.sub);
      redirect(res, u.toString());
    } catch (err) {
      log("callback failed", String((err as Error).message));
      statusPage(res, 502, "Login failed", "<p>The login could not be completed. Please try again.</p>");
    }
    return true;
  }
  // #endregion

  // #region /oauth/token
  if (p === "/oauth/token") {
    cors(res, req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "invalid_request" });
      return true;
    }
    const form = await readFormBody(req);
    const grant = form.get("grant_type");

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const clientId = form.get("client_id") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const resource = form.get("resource") ?? "";
      const rec = store.takeCode(code);
      if (!rec) return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown or expired code" }), true;
      if (rec.client_id !== clientId) return sendJson(res, 400, { error: "invalid_grant", error_description: "client mismatch" }), true;
      if (rec.redirect_uri !== redirectUri) return sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" }), true;
      // PKCE
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || computed !== rec.code_challenge) {
        return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" }), true;
      }
      // Audience binding (RFC 8707): if the client sends a resource, it must be ours.
      if (resource && resource.replace(/\/$/, "") !== rec.resource.replace(/\/$/, "")) {
        return sendJson(res, 400, { error: "invalid_target", error_description: "resource mismatch" }), true;
      }
      const claims = { sub: rec.sub, email: rec.email, name: rec.name, groups: rec.groups, scope: rec.scope };
      const accessToken = await signAccessToken(claims);
      const refresh = store.createRefresh({ ...claims, client_id: rec.client_id, resource: rec.resource });
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: config.tokenTtl,
        refresh_token: refresh.token,
        scope: rec.scope,
      });
      return true;
    }

    if (grant === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const next = store.rotateRefresh(token);
      if (!next) return sendJson(res, 400, { error: "invalid_grant", error_description: "invalid refresh token" }), true;
      const claims = { sub: next.sub, email: next.email, name: next.name, groups: next.groups, scope: next.scope };
      const accessToken = await signAccessToken(claims);
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: config.tokenTtl,
        refresh_token: next.token,
        scope: next.scope,
      });
      return true;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }
  // #endregion

  return false;
}
