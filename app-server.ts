// app-server.ts
// HTTP routes for the chat-app front-end (the "looks like the Claude app" interface).
// Kept in its own module so the shared server.ts gains only a one-line hook (same tactic
// as cost.ts). Every route here is owner-gated. Reached at /app* (the router sends /app*
// to this sidecar, and /_ct/app* strips to the same). Returns a Response for an app route,
// or null to let server.ts keep matching its own routes.

import { join } from "path";
import { readdirSync, statSync } from "fs";
import { getOrCreate, get, replayTranscript, type AppEvent, type AskNotifier } from "./app-runner";

export interface AppCtx {
  allowed: (req: Request) => boolean;
  cors: (req: Request) => Record<string, string>;
  publicDir: string; // PUBLIC_DIR; SPA lives in <publicDir>/app
  dataDir: string; // ~/.claude/projects
  historyHide: string[]; // cwds to hide (from cfg.historyHide)
  defaultCwd: string; // cwd for a brand-new chat (cfg.spawnCwd || HOME)
  models: { id: string; label: string }[]; // quick picks
  moreModels: { id: string; label: string }[]; // the "Other…" dialog list
  favoritesFile: string; // JSON array of favorited session ids (server-side so it syncs across devices)
  titlesFile: string; // JSON map {sessionId: customTitle} — user-renamed conversations
  sttUrl?: string; // local Whisper service base URL (loopback); enables hands-free voice in
  ttsUrl?: string; // local Kokoro service base URL (loopback); enables voice out
  notifyAsk?: AskNotifier; // push a PWA notification when Claude asks and no client is watching
}

// #region favorites (starred conversations) — server-side, shared across the owner's devices
let favSet: Set<string> | null = null;
async function loadFavs(file: string): Promise<Set<string>> {
  if (favSet) return favSet;
  try { const arr = JSON.parse(await Bun.file(file).text()); favSet = new Set(Array.isArray(arr) ? arr.map(String) : []); }
  catch { favSet = new Set(); }
  return favSet;
}
async function saveFavs(file: string) { if (favSet) await Bun.write(file, JSON.stringify([...favSet])); }
// #endregion

// #region custom titles (renamed conversations) — server-side map, syncs across devices
let titleMap: Record<string, string> | null = null;
async function loadTitles(file: string): Promise<Record<string, string>> {
  if (titleMap) return titleMap;
  try { const o = JSON.parse(await Bun.file(file).text()); titleMap = o && typeof o === "object" ? o : {}; }
  catch { titleMap = {}; }
  return titleMap;
}
async function saveTitles(file: string) { if (titleMap) await Bun.write(file, JSON.stringify(titleMap)); }
// #endregion

const enc = (s: string) => encodeURIComponent(s);

function jsonRes(body: unknown, ctx: AppCtx, req: Request, status = 200) {
  return Response.json(body, { status, headers: { ...ctx.cors(req), "Cache-Control": "no-store" } });
}

// #region conversation listing (scans the same .jsonl store as the terminal history)
interface ConvRow { sessionId: string; title: string; cwd: string | null; mtime: number; project: string }

function listConversations(ctx: AppCtx): ConvRow[] {
  const rows: { path: string; sessionId: string; project: string; mtime: number }[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(ctx.dataDir); } catch { return []; }
  for (const project of projects) {
    if (project.startsWith("-tmp-")) continue; // scratch/ephemeral cwds
    const pdir = join(ctx.dataDir, project);
    let files: string[] = [];
    try { files = readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(pdir, f);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      rows.push({ path: p, sessionId: f.slice(0, -6), project, mtime });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

// Pull a title + cwd from the head/tail of a transcript (cheap: reads once).
async function convMeta(path: string): Promise<{ title: string | null; cwd: string | null }> {
  let title: string | null = null;
  let cwd: string | null = null;
  let first: string | null = null;
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return { title, cwd }; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === "summary" && o.summary) { title = String(o.summary).slice(0, 100); }
    if (!first && o.type === "user" && o.message) {
      const c = o.message.content;
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";
      if (txt && !txt.startsWith("<")) first = txt.replace(/\s+/g, " ").slice(0, 100);
    }
  }
  return { title: title || first, cwd };
}

function findTranscript(ctx: AppCtx, sessionId: string): { path: string; project: string } | null {
  if (!/^[A-Za-z0-9-]{6,}$/.test(sessionId)) return null;
  let projects: string[] = [];
  try { projects = readdirSync(ctx.dataDir); } catch { return null; }
  for (const project of projects) {
    const p = join(ctx.dataDir, project, sessionId + ".jsonl");
    try { statSync(p); return { path: p, project }; } catch {}
  }
  return null;
}
// #endregion

// #region SSE
function sseStream(conv: ReturnType<typeof getOrCreate>, ctx: AppCtx, req: Request, fromNow = false): Response {
  let unsub = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc2 = new TextEncoder();
      const write = (e: AppEvent) => {
        try { controller.enqueue(enc2.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {}
      };
      controller.enqueue(enc2.encode(`retry: 3000\n\n`));
      unsub = conv.subscribe(write, fromNow); // replays this run's buffer (unless fromNow), then live
      const ping = setInterval(() => { try { controller.enqueue(enc2.encode(`: ping\n\n`)); } catch {} }, 20_000);
      (controller as any)._ping = ping;
    },
    cancel() { unsub(); },
  });
  return new Response(stream, {
    headers: { ...ctx.cors(req), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
// #endregion

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2" };

export async function appRoutes(req: Request, path: string, ctx: AppCtx): Promise<Response | null> {
  // normalize: allow both /app* (router, no strip) and a stray /_ct/app* (prefix strip)
  if (path.startsWith("/_ct/app")) path = path.slice(4);
  if (path !== "/app" && !path.startsWith("/app/")) return null;

  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...ctx.cors(req), "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });

  // Everything below requires the owner.
  if (!ctx.allowed(req)) return new Response("Forbidden", { status: 403, headers: ctx.cors(req) });

  // --- SPA shell + assets ---
  if (req.method === "GET" && (path === "/app" || path === "/app/")) {
    const f = Bun.file(join(ctx.publicDir, "app", "index.html"));
    if (await f.exists()) return new Response(f, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    return new Response("chat app not built yet", { status: 503 });
  }
  if (req.method === "GET" && path.startsWith("/app/assets/")) {
    const rel = path.slice("/app/assets/".length);
    if (rel.includes("..")) return new Response("Not Found", { status: 404 });
    const f = Bun.file(join(ctx.publicDir, "app", "assets", rel));
    if (await f.exists()) {
      const dot = rel.lastIndexOf(".");
      // filenames are content-hashed by app/build.ts, so a given URL never changes content
      return new Response(f, { headers: { "Content-Type": MIME[rel.slice(dot).toLowerCase()] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" } });
    }
    return new Response("Not Found", { status: 404 });
  }

  // Build id the client polls to detect a new deploy (read fresh each call, so a rebuild
  // alone ships an update — no service restart needed).
  if (req.method === "GET" && path === "/app/api/version") {
    let v = "dev";
    try { v = (await Bun.file(join(ctx.publicDir, "app", "version.txt")).text()).trim() || "dev"; } catch {}
    return new Response(v, { headers: { ...ctx.cors(req), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  // --- API ---
  if (req.method === "GET" && path === "/app/api/models") return jsonRes({ models: ctx.models, moreModels: ctx.moreModels, defaultCwd: ctx.defaultCwd, voice: !!(ctx.sttUrl && ctx.ttsUrl) }, ctx, req);

  // --- Voice mode proxies (owner-gated above). Forward to the loopback Whisper/Kokoro
  //     services so the mic audio + synthesized speech never leave the box unproxied. ---
  if (req.method === "POST" && path === "/app/api/stt") {
    if (!ctx.sttUrl) return jsonRes({ error: "stt not configured" }, ctx, req, 503);
    try {
      const body = await req.arrayBuffer(); // multipart form-data with the recorded clip
      const up = await fetch(ctx.sttUrl.replace(/\/$/, "") + "/transcribe", {
        method: "POST",
        headers: { "content-type": req.headers.get("content-type") || "application/octet-stream" },
        body,
      });
      const text = await up.text();
      return new Response(text, { status: up.status, headers: { ...ctx.cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch (e: any) {
      return jsonRes({ error: "stt upstream: " + (e?.message || e) }, ctx, req, 502);
    }
  }
  if (req.method === "POST" && path === "/app/api/tts") {
    if (!ctx.ttsUrl) return jsonRes({ error: "tts not configured" }, ctx, req, 503);
    try {
      const body = await req.arrayBuffer(); // {text, voice?, speed?}
      const up = await fetch(ctx.ttsUrl.replace(/\/$/, "") + "/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!up.ok) { const t = await up.text(); return new Response(t, { status: up.status, headers: { ...ctx.cors(req), "Content-Type": "application/json" } }); }
      return new Response(up.body, { status: 200, headers: { ...ctx.cors(req), "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
    } catch (e: any) {
      return jsonRes({ error: "tts upstream: " + (e?.message || e) }, ctx, req, 502);
    }
  }

  if (req.method === "GET" && path === "/app/api/titles") {
    const t = await loadTitles(ctx.titlesFile);
    return jsonRes({ titles: t }, ctx, req);
  }
  if (req.method === "POST" && path === "/app/api/title") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const id = String(b.id || "");
    if (!id) return jsonRes({ error: "id required" }, ctx, req, 400);
    const t = await loadTitles(ctx.titlesFile);
    const title = String(b.title ?? "").trim().slice(0, 200);
    if (title) t[id] = title; else delete t[id]; // empty title clears the override
    await saveTitles(ctx.titlesFile);
    return jsonRes({ ok: true, title: t[id] || null }, ctx, req);
  }

  if (req.method === "GET" && path === "/app/api/favorites") {
    const f = await loadFavs(ctx.favoritesFile);
    return jsonRes({ favorites: [...f] }, ctx, req);
  }
  if (req.method === "POST" && path === "/app/api/favorites") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const id = String(b.id || "");
    if (!id) return jsonRes({ error: "id required" }, ctx, req, 400);
    const f = await loadFavs(ctx.favoritesFile);
    if (b.fav) f.add(id); else f.delete(id);
    await saveFavs(ctx.favoritesFile);
    return jsonRes({ favorites: [...f] }, ctx, req);
  }

  if (req.method === "GET" && path === "/app/api/conversations") {
    const rows = listConversations(ctx);
    const titles = await loadTitles(ctx.titlesFile);
    const out: ConvRow[] = [];
    for (const r of rows.slice(0, 200)) {
      const meta = await convMeta(r.path);
      if (ctx.historyHide.some((h) => (meta.cwd || "").startsWith(h))) continue;
      const title = titles[r.sessionId] || meta.title; // user rename wins
      if (!title) continue;
      out.push({ sessionId: r.sessionId, title, cwd: meta.cwd, mtime: r.mtime, project: r.project });
      if (out.length >= 100) break;
    }
    return jsonRes({ conversations: out }, ctx, req);
  }

  // Full-text message search across conversations. Title matching is done client-side
  // (instant, offline-friendly); this searches message CONTENT and returns a snippet +
  // match count per conversation so you can find a specific message.
  if (req.method === "GET" && path === "/app/api/search") {
    const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return jsonRes({ results: [], q }, ctx, req);
    const titles = await loadTitles(ctx.titlesFile);
    const rows = listConversations(ctx).slice(0, 200); // recent-first
    const results: { sessionId: string; title: string; cwd: string | null; mtime: number; snippet: string; count: number }[] = [];
    for (const r of rows) {
      let text: string;
      try { text = await Bun.file(r.path).text(); } catch { continue; }
      if (!text.toLowerCase().includes(q)) continue; // cheap reject before per-line parse
      let count = 0, snippet = "";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let o: any; try { o = JSON.parse(line); } catch { continue; }
        if (o.type !== "user" && o.type !== "assistant") continue;
        const c = o.message?.content;
        const msg = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join(" ") : "";
        if (!msg) continue;
        const idx = msg.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        count++;
        if (!snippet) { const s = Math.max(0, idx - 40); snippet = (s > 0 ? "…" : "") + msg.slice(s, idx + q.length + 70).replace(/\s+/g, " ").trim() + "…"; }
      }
      if (!count) continue; // matched only in system/metadata lines
      const meta = await convMeta(r.path);
      if (ctx.historyHide.some((h) => (meta.cwd || "").startsWith(h))) continue;
      results.push({ sessionId: r.sessionId, title: titles[r.sessionId] || meta.title || "(untitled)", cwd: meta.cwd, mtime: r.mtime, snippet, count });
      if (results.length >= 40) break;
    }
    return jsonRes({ results, q }, ctx, req);
  }

  // Replay a past conversation into the normalized event list the UI renders.
  if (req.method === "GET" && path.startsWith("/app/api/conversation/")) {
    const id = decodeURIComponent(path.slice("/app/api/conversation/".length));
    const found = findTranscript(ctx, id);
    if (!found) return jsonRes({ error: "not found" }, ctx, req, 404);
    const events = await replayTranscript(found.path);
    const meta = await convMeta(found.path);
    const live = get(id);
    return jsonRes({ sessionId: id, cwd: meta.cwd, title: meta.title, events, live: !!live, busy: !!live?.busy, pendingAsks: live?.listPendingAsks() || [] }, ctx, req);
  }

  // Start a chat: brand-new (no resume) or resume an existing session id. Kicks the first turn.
  if (req.method === "POST" && path === "/app/api/start") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const text = String(b.text ?? "").trim();
    if (!text) return jsonRes({ error: "empty message" }, ctx, req, 400);
    const resume: string | undefined = b.resume && /^[A-Za-z0-9-]{6,}$/.test(b.resume) ? b.resume : undefined;
    let cwd: string = ctx.defaultCwd;
    if (resume) { const found = findTranscript(ctx, resume); if (found) { const m = await convMeta(found.path); if (m.cwd) cwd = m.cwd; } }
    if (typeof b.cwd === "string" && b.cwd.startsWith("/")) cwd = b.cwd;
    const model: string | undefined = typeof b.model === "string" && b.model ? b.model : undefined;
    // if already live under this session id, just send into it
    const existing = resume ? get(resume) : undefined;
    if (existing) { existing.send(text); return jsonRes({ id: existing.id, resumed: true }, ctx, req); }
    const conv = getOrCreate(resume || null, { cwd, model, resume, notifier: ctx.notifyAsk });
    void conv.run(text);
    return jsonRes({ id: conv.id, cwd, model: model || null }, ctx, req);
  }

  // Follow-up turn into an already-open conversation.
  if (req.method === "POST" && path === "/app/api/send") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (!conv) return jsonRes({ error: "no live conversation for id (start or resume it first)" }, ctx, req, 409);
    const text = String(b.text ?? "").trim();
    if (!text) return jsonRes({ error: "empty message" }, ctx, req, 400);
    conv.send(text);
    return jsonRes({ ok: true, id: conv.id }, ctx, req);
  }

  // Live event stream (SSE). Must already be started (GET can't carry the first turn).
  if (req.method === "GET" && path.startsWith("/app/stream/")) {
    const id = decodeURIComponent(path.slice("/app/stream/".length));
    const conv = get(id);
    if (!conv) return new Response("data: " + JSON.stringify({ t: "error", message: "conversation not open" }) + "\n\n", { status: 404, headers: { ...ctx.cors(req), "Content-Type": "text/event-stream" } });
    // tail=1: reconnecting to a live conversation already rebuilt from transcript + pending
    // asks -> stream only future events so the current turn isn't rendered twice.
    const tail = new URL(req.url).searchParams.get("tail") === "1";
    return sseStream(conv, ctx, req, tail);
  }

  if (req.method === "POST" && path === "/app/api/model") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (!conv) return jsonRes({ error: "no live conversation" }, ctx, req, 409);
    if (typeof b.model !== "string" || !b.model) return jsonRes({ error: "model required" }, ctx, req, 400);
    await conv.setModel(b.model);
    return jsonRes({ ok: true, model: b.model }, ctx, req);
  }

  if (req.method === "POST" && path === "/app/api/interrupt") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (conv) await conv.interrupt();
    return jsonRes({ ok: !!conv }, ctx, req);
  }

  if (req.method === "POST" && path === "/app/api/close") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (conv) conv.close();
    return jsonRes({ ok: !!conv }, ctx, req);
  }

  // The user tapped an option for an ask_user prompt -> unblock the tool + let Claude continue.
  if (req.method === "POST" && path === "/app/api/ask-answer") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    const askId = String(b.askId || "");
    const answer = String(b.answer ?? "");
    if (!conv || !askId) return jsonRes({ error: "id + askId required" }, ctx, req, 400);
    const ok = conv.answerAsk(askId, answer);
    return jsonRes({ ok }, ctx, req);
  }

  // File upload into a conversation's cwd (so Claude can read it next turn).
  if (req.method === "POST" && path === "/app/api/upload") {
    const ct = req.headers.get("content-type") || "";
    if (!ct.startsWith("multipart/form-data")) return jsonRes({ error: "expected multipart/form-data" }, ctx, req, 400);
    const form = await req.formData();
    const file = form.get("file");
    const id = String(form.get("id") || "");
    const conv = id ? get(id) : undefined;
    const cwd = conv?.cwd || ctx.defaultCwd;
    if (!(file instanceof File)) return jsonRes({ error: "no file" }, ctx, req, 400);
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "upload";
    const destDir = join(cwd, "uploads");
    try { await Bun.write(join(destDir, safe), file); } catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 500); }
    return jsonRes({ ok: true, path: join(destDir, safe) }, ctx, req);
  }

  // Download a file from within a conversation's cwd (guard traversal).
  if (req.method === "GET" && path === "/app/api/download") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") || "";
    const rel = u.searchParams.get("path") || "";
    const conv = id ? get(id) : undefined;
    const base = conv?.cwd || ctx.defaultCwd;
    const target = rel.startsWith("/") ? rel : join(base, rel);
    if (!target.startsWith(base + "/") && target !== base) return jsonRes({ error: "path outside conversation" }, ctx, req, 403);
    const f = Bun.file(target);
    if (!(await f.exists())) return jsonRes({ error: "not found" }, ctx, req, 404);
    const name = target.split("/").pop() || "download";
    return new Response(f, { headers: { ...ctx.cors(req), "Content-Disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"` } });
  }

  return new Response("Not Found", { status: 404, headers: ctx.cors(req) });
}
