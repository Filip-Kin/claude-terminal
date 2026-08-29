// app-server.ts
// HTTP routes for the chat-app front-end (the "looks like the Claude app" interface).
// Kept in its own module so the shared server.ts gains only a one-line hook (same tactic
// as cost.ts). Every route here is owner-gated. Reached at /app* (the router sends /app*
// to this sidecar, and /_ct/app* strips to the same). Returns a Response for an app route,
// or null to let server.ts keep matching its own routes.

import { join } from "path";
import { readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { getOrCreate, get, liveStatuses, replayTranscript, decorateVoiceTurn, getSubscriptionUsage, getSupportedModels, resolveEditPoints, type AppEvent, type AskNotifier } from "./app-runner";

// Curated Kokoro voices (validated against the local TTS sidecar). Default af_heart matches the
// sidecar's own default. The picker in Settings lets the user switch male/female/accent.
const TTS_VOICES = [
  { id: "af_heart", label: "Female · Heart (default)" },
  { id: "af_bella", label: "Female · Bella" },
  { id: "af_nicole", label: "Female · Nicole" },
  { id: "am_michael", label: "Male · Michael" },
  { id: "am_adam", label: "Male · Adam" },
  { id: "am_fenrir", label: "Male · Fenrir" },
  { id: "bf_emma", label: "British female · Emma" },
  { id: "bm_george", label: "British male · George" },
];

export interface AppCtx {
  allowed: (req: Request) => boolean;
  cors: (req: Request) => Record<string, string>;
  publicDir: string; // PUBLIC_DIR; SPA lives in <publicDir>/app
  dataDir: string; // ~/.claude/projects
  historyHide: string[]; // cwds to hide (from cfg.historyHide)
  hideProjectDirs: string[]; // absolute project-dir paths to exclude wholesale (agents billed to
  // extraUsers, e.g. stonkbot/sleeper). Matched on the DIR, not the transcript, so their thousands
  // of automated runs never even get read — cheap, and they can't swamp the recent window.
  defaultCwd: string; // cwd for a brand-new chat (cfg.spawnCwd || HOME)
  models: { id: string; label: string }[]; // quick picks
  moreModels: { id: string; label: string }[]; // the "Other…" dialog list
  favoritesFile: string; // JSON array of favorited session ids (server-side so it syncs across devices)
  titlesFile: string; // JSON map {sessionId: customTitle} — user-renamed conversations
  sttUrl?: string; // local Whisper service base URL (loopback); enables hands-free voice in
  ttsUrl?: string; // local Kokoro service base URL (loopback); enables voice out
  notifyAsk?: AskNotifier; // push a PWA notification when Claude asks and no client is watching
  ownerUsage?: () => { output5h: number; url: string } | null; // rolling 5h output + link to the usage page
  activeUsers?: () => number | null; // local users active on this box in the last ~15 min (null = unknown, e.g. guest sidecar with no DB)
  subscriptionWarnPct?: number; // 5-hour utilisation at/above which the shared-limit toast fires (config.subscriptionWarnPct)
}

// #region send idempotency — dedupe a retried/redelivered turn by its client-supplied cid, so a flaky
// link (a timeout requeue, the offline drain, or Background Sync) can never post the same message
// twice. In-memory + short TTL: a redelivery only races within a few seconds of the original.
const seenSends = new Map<string, { at: number; id: string }>();
const SEND_DEDUP_TTL_MS = 2 * 60 * 1000;
function dedupSeen(cid: unknown): { id: string } | null {
  if (typeof cid !== "string" || !cid) return null;
  const now = Date.now();
  for (const [k, v] of seenSends) if (now - v.at > SEND_DEDUP_TTL_MS) seenSends.delete(k); // prune stale
  const hit = seenSends.get(cid);
  return hit ? { id: hit.id } : null;
}
function dedupRecord(cid: unknown, id: string) { if (typeof cid === "string" && cid) seenSends.set(cid, { at: Date.now(), id }); }
// #endregion

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

// A conversation's "last activity" is the timestamp of its last user/assistant message — NOT the
// file's mtime. An idle Claude Code session keeps rewriting trailing bookkeeping entries
// (stop_hook_summary / turn_duration / away_summary) into its transcript, which bumps the file mtime
// (and only the mtime — same size, no new message) long after the real conversation ended. Trusting
// mtime made those idle sessions float to the top, group under "Today", and read as permanently
// unread. So for recently-touched files we read the tail and recover the real last-message time;
// older files (never touched again once their session ended) keep their mtime, which already matches.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const activityCache = new Map<string, { size: number; ts: number }>();

async function lastActivityMs(path: string, size: number, fallbackMtimeMs: number): Promise<number> {
  // Cache by (path,size): an idle bump doesn't change the size, so subsequent polls are free.
  const cached = activityCache.get(path);
  if (cached && cached.size === size) return cached.ts;
  let ts = 0;
  try {
    // The last real message sits just before the small trailing bookkeeping entries, so a bounded
    // tail is enough. The slice may begin mid-line; scanning from the end skips that partial line.
    const start = Math.max(0, size - 262144);
    const text = await Bun.file(path).slice(start).text();
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if ((o.type === "user" || o.type === "assistant") && o.timestamp) {
        const t = Date.parse(o.timestamp);
        if (t) { ts = t; break; }
      }
    }
  } catch {}
  if (!ts) ts = fallbackMtimeMs; // no parseable message in the tail — fall back to the file clock
  activityCache.set(path, { size, ts });
  return ts;
}

async function listConversations(ctx: AppCtx): Promise<{ path: string; sessionId: string; project: string; mtime: number }[]> {
  const rows: { path: string; sessionId: string; project: string; mtime: number; size: number; statMtime: number }[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(ctx.dataDir); } catch { return []; }
  for (const project of projects) {
    if (project.startsWith("-tmp-")) continue; // scratch/ephemeral cwds
    const pdir = join(ctx.dataDir, project);
    // Skip whole agent/automation project dirs (billed to a non-owner extraUser). This is the same
    // exclusion the terminal /history drawer already applies, mirrored here for the chat app.
    if (ctx.hideProjectDirs.some((d) => pdir === d || pdir.startsWith(d + "/"))) continue;
    let files: string[] = [];
    try { files = readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(pdir, f);
      let st; try { st = statSync(p); } catch { continue; }
      rows.push({ path: p, sessionId: f.slice(0, -6), project, mtime: st.mtimeMs, size: st.size, statMtime: st.mtimeMs });
    }
  }
  // Only recently-touched files can be misdated by an idle bump (bumps move mtime forward, never
  // back), so only those need a tail read; the rest keep their mtime. Cache-misses read in parallel.
  const now = Date.now();
  await Promise.all(rows.map(async (r) => {
    if (now - r.statMtime < RECENT_MS) r.mtime = await lastActivityMs(r.path, r.size, r.statMtime);
  }));
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
  let ping: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => { if (ping) { clearInterval(ping); ping = null; } unsub(); unsub = () => {}; };
  const stream = new ReadableStream({
    start(controller) {
      const enc2 = new TextEncoder();
      const write = (e: AppEvent) => {
        try { controller.enqueue(enc2.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {}
      };
      controller.enqueue(enc2.encode(`retry: 3000\n\n`));
      unsub = conv.subscribe(write, fromNow); // replays this run's buffer (unless fromNow), then live
      // Keepalive ping. If the client is gone the enqueue throws (caught); when it does, tear the whole
      // stream down so neither the interval nor the subscriber outlives the connection (was a leak).
      ping = setInterval(() => { try { controller.enqueue(enc2.encode(`: ping\n\n`)); } catch { cleanup(); } }, 20_000);
    },
    cancel() { cleanup(); },
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
  if (req.method === "GET" && path === "/app/api/models") {
    // Prefer the CLI's live supported-models menu; fall back to the config list if the probe fails.
    // A dynamic list is already the curated menu, so there's no separate "Other…" list.
    let models = ctx.models, moreModels = ctx.moreModels;
    try { const dyn = await getSupportedModels(); if (dyn.length) { models = dyn; moreModels = []; } } catch { /* keep config fallback */ }
    return jsonRes({ models, moreModels, defaultCwd: ctx.defaultCwd, voice: !!(ctx.sttUrl && ctx.ttsUrl), voices: ctx.ttsUrl ? TTS_VOICES : [], defaultVoice: "af_heart" }, ctx, req);
  }

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

  // Live context-window usage (for the pie + compaction hint). available:false when the chat isn't
  // live in memory or the SDK build lacks getContextUsage.
  if (req.method === "GET" && path === "/app/api/context") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const conv = id ? get(id) : undefined;
    if (!conv) return jsonRes({ available: false }, ctx, req);
    const cu = await conv.contextUsage();
    if (!cu) return jsonRes({ available: false }, ctx, req);
    return jsonRes({ available: true, total: cu.total_tokens, max: cu.raw_max_tokens, percentage: cu.percentage, categories: cu.categories, overLimit: cu.over_limit || null }, ctx, req);
  }
  // Manually compact the live conversation (frees context). No-op if the chat isn't live.
  if (req.method === "POST" && path === "/app/api/compact") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (!conv) return jsonRes({ error: "no live conversation to compact" }, ctx, req, 400);
    conv.compact();
    return jsonRes({ ok: true }, ctx, req);
  }
  // Live per-conversation status (thinking / waiting-for-input) for the sidebar indicators.
  if (req.method === "GET" && path === "/app/api/statuses") {
    return jsonRes({ statuses: liveStatuses() }, ctx, req);
  }
  // Owner's rolling 5-hour output tokens + a link to the full usage page (terminal-side dashboard),
  // plus the claude.ai subscription rate-limit windows (the real "session limit" — 5-hour + weekly),
  // sourced live from the SDK /usage API. `subscription` is null until the first background fetch lands.
  if (req.method === "GET" && path === "/app/api/usage") {
    const u = ctx.ownerUsage?.();
    const subscription = getSubscriptionUsage();
    const activeUsers = ctx.activeUsers?.() ?? null;
    const warnPct = ctx.subscriptionWarnPct ?? 70;
    return jsonRes({ ...(u ? { available: true, ...u } : { available: false }), subscription, activeUsers, warnPct }, ctx, req);
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
    // Paginated (infinite scroll). ?offset=N walks the mtime-sorted row list; ?limit caps the
    // page. Rows without a usable title are skipped, so nextOffset tracks rows CONSUMED (not
    // items emitted) and the client feeds it straight back for the next page.
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const rows = await listConversations(ctx);
    const titles = await loadTitles(ctx.titlesFile);
    const out: ConvRow[] = [];
    let i = offset;
    for (; i < rows.length && out.length < limit; i++) {
      const r = rows[i];
      const meta = await convMeta(r.path);
      if (ctx.historyHide.some((h) => (meta.cwd || "").startsWith(h))) continue;
      const title = titles[r.sessionId] || meta.title; // user rename wins
      if (!title) continue;
      out.push({ sessionId: r.sessionId, title, cwd: meta.cwd, mtime: r.mtime, project: r.project });
    }
    const hasMore = i < rows.length;
    // First page always carries the favorited conversations too — even if a starred chat has aged
    // out of the recent window it must never vanish from the Favorites section.
    let favorites: ConvRow[] = [];
    if (offset === 0) {
      const favIds = await loadFavs(ctx.favoritesFile);
      const present = new Set(out.map((o) => o.sessionId));
      for (const id of favIds) {
        if (present.has(id)) continue;
        const t = findTranscript(ctx, id);
        if (!t) continue;
        const meta = await convMeta(t.path);
        const title = titles[id] || meta.title;
        if (!title) continue;
        let mtime = 0;
        try {
          const st = statSync(t.path);
          mtime = Date.now() - st.mtimeMs < RECENT_MS ? await lastActivityMs(t.path, st.size, st.mtimeMs) : st.mtimeMs;
        } catch {}
        favorites.push({ sessionId: id, title, cwd: meta.cwd, mtime, project: t.project });
      }
    }
    return jsonRes({ conversations: out, favorites, nextOffset: i, hasMore }, ctx, req);
  }

  // Delete a conversation: remove its transcript (+ any subagents sidecar dir) and drop it from
  // favorites/titles. Guarded to the data dir and refuses agent/automation dirs.
  if (req.method === "POST" && path === "/app/api/delete") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const id = String(b.id || "");
    if (!/^[A-Za-z0-9-]{6,}$/.test(id)) return jsonRes({ error: "bad id" }, ctx, req, 400);
    const t = findTranscript(ctx, id);
    if (!t) return jsonRes({ error: "not found" }, ctx, req, 404);
    const pdir = join(ctx.dataDir, t.project);
    if (ctx.hideProjectDirs.some((d) => pdir === d || pdir.startsWith(d + "/"))) return jsonRes({ error: "forbidden" }, ctx, req, 403);
    try { get(id)?.close(); } catch {} // stop a live session first
    try { unlinkSync(t.path); } catch {}
    try { rmSync(join(pdir, id), { recursive: true, force: true }); } catch {} // subagents/<id> sidecar dir
    const favs = await loadFavs(ctx.favoritesFile); if (favs.delete(id)) await saveFavs(ctx.favoritesFile);
    const titles = await loadTitles(ctx.titlesFile); if (titles[id]) { delete titles[id]; await saveTitles(ctx.titlesFile); }
    return jsonRes({ ok: true }, ctx, req);
  }

  // Full-text message search across conversations. Title matching is done client-side
  // (instant, offline-friendly); this searches message CONTENT and returns a snippet +
  // match count per conversation so you can find a specific message.
  if (req.method === "GET" && path === "/app/api/search") {
    const q = (new URL(req.url).searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return jsonRes({ results: [], q }, ctx, req);
    const titles = await loadTitles(ctx.titlesFile);
    const rows = (await listConversations(ctx)).slice(0, 200); // recent-first
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
    const rawText = String(b.text ?? "").trim();
    if (!rawText) return jsonRes({ error: "empty message" }, ctx, req, 400);
    const dup = dedupSeen(b.cid); // a redelivery of an already-processed turn -> ack, do not send again
    if (dup) return jsonRes({ id: dup.id, deduped: true }, ctx, req);
    const text = b.voice ? decorateVoiceTurn(rawText) : rawText; // voice mode -> append the brief/TTS directive
    const resume: string | undefined = b.resume && /^[A-Za-z0-9-]{6,}$/.test(b.resume) ? b.resume : undefined;
    let cwd: string = ctx.defaultCwd;
    if (resume) { const found = findTranscript(ctx, resume); if (found) { const m = await convMeta(found.path); if (m.cwd) cwd = m.cwd; } }
    if (typeof b.cwd === "string" && b.cwd.startsWith("/")) cwd = b.cwd;
    const model: string | undefined = typeof b.model === "string" && b.model ? b.model : undefined;
    // if already live under this session id, just send into it
    const existing = resume ? get(resume) : undefined;
    if (existing) { existing.send(text); dedupRecord(b.cid, existing.id); return jsonRes({ id: existing.id, resumed: true }, ctx, req); }
    const conv = getOrCreate(resume || null, { cwd, model, resume, notifier: ctx.notifyAsk });
    void conv.run(text);
    dedupRecord(b.cid, conv.id);
    return jsonRes({ id: conv.id, cwd, model: model || null }, ctx, req);
  }

  // Follow-up turn into an already-open conversation.
  if (req.method === "POST" && path === "/app/api/send") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (!conv) return jsonRes({ error: "no live conversation for id (start or resume it first)" }, ctx, req, 409);
    const rawText = String(b.text ?? "").trim();
    if (!rawText) return jsonRes({ error: "empty message" }, ctx, req, 400);
    if (dedupSeen(b.cid)) return jsonRes({ ok: true, id: conv.id, deduped: true }, ctx, req); // redelivery -> ack, don't re-send
    conv.send(b.voice ? decorateVoiceTurn(rawText) : rawText); // voice mode -> append the brief/TTS directive
    dedupRecord(b.cid, conv.id);
    return jsonRes({ ok: true, id: conv.id }, ctx, req);
  }

  // Edit an earlier user turn and re-run from there (full rollback): roll files back to that turn's
  // checkpoint, fork the transcript so the turn and everything after it are dropped, then run the
  // edited text. index = 0-based ordinal among user turns (matches the UI's user bubbles). The new
  // forked session id arrives on the stream (init), which rebinds the client automatically.
  if (req.method === "POST" && path === "/app/api/edit") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const id = String(b.id || "");
    const index = Number(b.index);
    const rawText = String(b.text ?? "").trim();
    if (!id || !Number.isInteger(index) || index < 0 || !rawText) return jsonRes({ error: "id, index (>=0) and text required" }, ctx, req, 400);
    if (dedupSeen(b.cid)) return jsonRes({ ok: true, id, deduped: true }, ctx, req);
    const found = findTranscript(ctx, id);
    if (!found) return jsonRes({ error: "no transcript for id" }, ctx, req, 404);
    const points = await resolveEditPoints(found.path, index);
    if (!points) return jsonRes({ error: "could not resolve the edited turn (reload and retry)" }, ctx, req, 409);
    // Guard against a stale client view: if the client told us the original text, it must still match
    // the turn at that index, or we'd fork at the wrong place.
    if (typeof b.orig === "string" && b.orig.trim() && points.promptText.trim() !== String(b.orig).trim())
      return jsonRes({ error: "conversation changed — reload and retry" }, ctx, req, 409);
    const meta = await convMeta(found.path);
    let conv = get(id);
    if (!conv) { conv = getOrCreate(id, { cwd: meta.cwd || ctx.defaultCwd, model: b.model || undefined, resume: id, notifier: ctx.notifyAsk }); await conv.bootForRewind(); }
    const text = b.voice ? decorateVoiceTurn(rawText) : rawText;
    const rewind = await conv.editTurn(points.forkAtUuid, points.rewindToUuid, text);
    dedupRecord(b.cid, conv.id);
    return jsonRes({ ok: true, id: conv.id, rewind }, ctx, req);
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
    let base = conv?.cwd || undefined;
    // Not live in memory (a historical conversation)? Recover its cwd from the transcript so
    // image previews in the chat log still resolve.
    if (!base && /^[A-Za-z0-9-]{6,}$/.test(id)) { const t = findTranscript(ctx, id); if (t) base = (await convMeta(t.path)).cwd || undefined; }
    base = base || ctx.defaultCwd;
    const target = rel.startsWith("/") ? rel : join(base, rel);
    if (!target.startsWith(base + "/") && target !== base) return jsonRes({ error: "path outside conversation" }, ctx, req, 403);
    const f = Bun.file(target);
    if (!(await f.exists())) return jsonRes({ error: "not found" }, ctx, req, 404);
    const name = target.split("/").pop() || "download";
    return new Response(f, { headers: { ...ctx.cors(req), "Content-Disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"` } });
  }

  return new Response("Not Found", { status: 404, headers: ctx.cors(req) });
}
