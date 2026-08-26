/**
 * home-bridge-mcp entrypoint.
 *
 * A single plain-HTTP origin (behind nginx TLS) that is BOTH an OAuth 2.1
 * authorization-server facade (delegating login to Authelia) AND the protected
 * MCP resource. Claude apps connect as a remote custom connector.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { createServer } from "./mcp-server.js";
import { handleOAuth } from "./oauth/router.js";
import { verifyAccessToken } from "./oauth/jwt.js";
import { sendJson, sendText, readJsonBody } from "./http-util.js";
import { initDb, logRequest } from "./db.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  lastSeen: number;
  who: string;
}

const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS) {
      s.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60_000).unref();

/** 401 that tells the client where to discover how to authenticate (RFC 9728). */
function challenge(res: http.ServerResponse, detail = "authorization required"): void {
  const metaUrl = config.publicUrl + "/.well-known/oauth-protected-resource";
  res.writeHead(401, {
    "WWW-Authenticate": `Bearer resource_metadata="${metaUrl}", error="invalid_token", error_description="${detail}"`,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: "invalid_token", error_description: detail }));
}

/**
 * Record every MCP request to the SQLite debug log so a real server-side failure
 * can be told apart from a client-side "an error occurred: <request id>" (where
 * the app cut the connection before we replied). One row per JSON-RPC message;
 * tool-call args are captured (truncated) for tools/call.
 */
function recordRequests(
  body: unknown,
  who: string,
  sessionId: string | undefined,
  ok: boolean,
  error: string | undefined,
  durationMs: number,
): void {
  if (body === undefined || body === null) return;
  const msgs = Array.isArray(body) ? body : [body];
  const now = Date.now();
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const method = (m as any).method as string | undefined;
    if (!method) continue;
    const isToolCall = method === "tools/call";
    const tool = isToolCall ? ((m as any).params?.name as string | undefined) : undefined;
    let args: string | undefined;
    if (isToolCall) {
      try {
        args = JSON.stringify((m as any).params?.arguments ?? {});
      } catch {
        args = "[unserializable]";
      }
      if (args && args.length > 4000) args = args.slice(0, 4000) + "…";
    }
    logRequest({ ts: now, who, sessionId, method, tool, args, ok, error, durationMs });
  }
}

async function authenticate(req: http.IncomingMessage): Promise<{ who: string } | null> {
  if (config.devNoAuth) return { who: "dev" };
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  try {
    const claims = await verifyAccessToken(m[1]!);
    return { who: claims.email || claims.sub };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Liveness probe.
  if (url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", sessions: sessions.size });
  }

  // DNS-rebinding guard.
  if (config.allowedHosts.length) {
    const host = (String(req.headers.host || "").split(":")[0] || "").toLowerCase();
    if (!config.allowedHosts.includes(host)) {
      log("rejected Host header:", host);
      return sendText(res, 403, "Forbidden");
    }
  }

  // OAuth + discovery routes.
  try {
    if (await handleOAuth(req, res, url)) return;
  } catch (err) {
    log("oauth route error", String((err as Error)?.message));
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    return;
  }

  if (url.pathname !== config.mcpPath) return sendText(res, 404, "Not found");

  // CORS for browser-based MCP clients.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID, Mcp-Protocol-Version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

  // Every MCP request must carry a valid token.
  const auth = await authenticate(req);
  if (!auth) return challenge(res);

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId)!;
      s.lastSeen = Date.now();
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const t0 = Date.now();
      try {
        await s.transport.handleRequest(req, res, body);
        recordRequests(body, s.who, sessionId, true, undefined, Date.now() - t0);
      } catch (err) {
        recordRequests(body, s.who, sessionId, false, String((err as Error)?.message || err), Date.now() - t0);
        throw err;
      }
      return;
    }
    if (sessionId) {
      return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Unknown session. Reconnect." }, id: null });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Expected POST to initialize." }, id: null });
    }

    const body = await readJsonBody<any>(req);
    const isInit = body && (Array.isArray(body) ? body : [body]).some((m: any) => m?.method === "initialize");
    if (!isInit) {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Send initialize first." }, id: null });
    }

    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcp, lastSeen: Date.now(), who: auth.who });
        log("session opened", id, "for", auth.who, `(${sessions.size} active)`);
      },
    });
    await mcp.connect(transport);

    // The SDK installs its own onclose during connect(); chain ours after.
    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      if (transport.sessionId && sessions.delete(transport.sessionId)) {
        log("session closed", transport.sessionId, `(${sessions.size} active)`);
      }
    };

    const t0 = Date.now();
    try {
      await transport.handleRequest(req, res, body);
      recordRequests(body, auth.who, transport.sessionId, true, undefined, Date.now() - t0);
    } catch (err) {
      recordRequests(body, auth.who, transport.sessionId, false, String((err as Error)?.message || err), Date.now() - t0);
      throw err;
    }
  } catch (err) {
    log("mcp request failed:", String((err as Error)?.stack || (err as Error)?.message || err));
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    else res.end();
  }
});

initDb();

server.listen(config.port, config.host, () => {
  log(`listening on ${config.host}:${config.port}`);
  log(`public: ${config.publicUrl}  resource: ${config.resource}`);
  if (config.devNoAuth) log("WARNING: BRIDGE_DEV_NO_AUTH=1 — auth is bypassed. Dev only.");
  if (!config.authelia.clientSecret && !config.devNoAuth) log("WARNING: AUTHELIA_CLIENT_SECRET is empty — login will fail until set.");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    for (const s of sessions.values()) s.transport.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
