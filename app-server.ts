// app-server.ts
// HTTP routes for the chat-app front-end (the "looks like the Claude app" interface).
// Kept in its own module so the shared server.ts gains only a one-line hook (same tactic
// as cost.ts). Every route here is owner-gated. Reached at /app* (the router sends /app*
// to this sidecar, and /_ct/app* strips to the same). Returns a Response for an app route,
// or null to let server.ts keep matching its own routes.

import { join, resolve } from "path";
import { readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { loadMcp, upsertServer, removeServer, mcpServersForQuery } from "./app-mcp";
import { listMemory, readMemory, writeMemory, listSkills, readSkill, writeSkill, setSkillEnabled, type MemSkillCtx } from "./app-mem-skills";
import { listSpawned, getSpawnedTranscript, type SpawnedCtx } from "./spawned";
import { getOrCreate, get, liveStatuses, replayTranscript, decorateVoiceTurn, cleanDictation, warmDictation, getSubscriptionUsage, getSupportedModels, resolveEditPoints, type AppEvent, type AskNotifier } from "./app-runner";

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
  downloadRoots: string[]; // extra roots /app/api/download may read from, on top of the chat's own
  // cwd. Claude routinely writes to a path outside the directory the chat was started in (a render
  // into a project folder while the chat sits in $HOME), and restricting reads to the cwd made every
  // one of those a 403: inline images rendered as a broken box with alt text, download cards 404'd.
  models: { id: string; label: string }[]; // quick picks
  moreModels: { id: string; label: string }[]; // the "Other…" dialog list
  favoritesFile: string; // JSON array of favorited session ids (server-side so it syncs across devices)
  titlesFile: string; // JSON map {sessionId: customTitle} — user-renamed conversations
  mcpFile: string; // JSON map {name: McpServerConfig} — MCP servers the SDK connects for /app chats
  claudeDir: string; // ~/.claude — for memory (CLAUDE.md) + skills management
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

// #region turn logging
// One line per turn transition, keyed by the client-generated `cid`, so a stalled turn can be traced
// end to end in the journal: an "accept" with no matching "done" is a turn the server took and never
// finished, and an accept+done with the user still seeing nothing is a delivery (SSE) problem instead.
// Without this a stall left no trace anywhere and could only be guessed at from the client.
function tlog(event: string, fields: Record<string, unknown>): void {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") parts.push(`${k}=${v}`);
  console.log(`[turn] ${event}${parts.length ? " " + parts.join(" ") : ""}`);
}
const shortCid = (c: unknown) => (typeof c === "string" && c ? c.slice(0, 8) : "none");
// #endregion

// #region SSE
// Bound every stream's lifetime. A browser that goes away without closing cleanly leaves a
// subscriber that never gets cancel(), and the keepalive enqueue does NOT throw on a dead socket, so
// nothing detects it. Bun's 10s default idleTimeout used to reap those by accident; raising it to
// stop the reconnect churn removed the only reaper, and one night produced 409 stream opens against
// 275 closes, one conversation up to 116 listeners (every event written 116 times) and conversations
// that were never reaped because hasSubscribers() never went false. Closing on a timer bounds a leak
// to one cycle: EventSource reconnects by itself after `retry`, and subscribeSince() hands back the
// gap, which is exactly the resume path any dropped connection already uses.
const MAX_STREAM_MS = 10 * 60_000;

function sseStream(conv: ReturnType<typeof getOrCreate>, ctx: AppCtx, req: Request, fromNow = false): Response {
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | null = null;
  let life: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (ping) { clearInterval(ping); ping = null; }
    if (life) { clearTimeout(life); life = null; }
    unsub(); unsub = () => {};
  };
  // EventSource replays its own last id on an automatic reconnect. The URL can't change between
  // retries, so a `tail=1` stream used to come back asking for future events only and silently drop
  // everything emitted while the socket was down. With the id echoed on every event we can hand back
  // exactly the gap instead. The client already ignores any _seq it has seen, so this can't duplicate.
  // Where to resume from, in order of trust: the browser's own Last-Event-ID (an automatic retry of
  // the same socket), then the client's `since` cursor IF it belongs to this log's epoch. A fresh
  // EventSource sends no Last-Event-ID, which is why a deliberate reconnect used to lose every event
  // emitted while the socket was down: the client knew its cursor and never sent it. A cursor from a
  // different epoch means the runner restarted; the client is told to reload rather than fold a tail
  // onto history that this log never saw.
  const url = new URL(req.url);
  const lastIdRaw = parseInt(req.headers.get("last-event-id") || "", 10);
  const sinceRaw = parseInt(url.searchParams.get("since") || "", 10);
  const epochParam = url.searchParams.get("epoch") || "";
  const sameEpoch = epochParam === conv.epoch;
  const resync = !!epochParam && !sameEpoch;
  const resumeFrom = Number.isInteger(lastIdRaw) && lastIdRaw >= 0 ? lastIdRaw
    : sameEpoch && Number.isInteger(sinceRaw) && sinceRaw >= -1 ? sinceRaw
    : null;
  const stream = new ReadableStream({
    start(controller) {
      const enc2 = new TextEncoder();
      const write = (e: AppEvent) => {
        const seq = (e as { _seq?: number })._seq;
        const id = typeof seq === "number" ? `id: ${seq}\n` : "";
        try { controller.enqueue(enc2.encode(`${id}data: ${JSON.stringify(e)}\n\n`)); } catch {}
      };
      controller.enqueue(enc2.encode(`retry: 3000\n\n`));
      // First frame: which log this is and its current cursor, so the client can resume exactly next
      // time, and whether its cursor was stale. Not logged, no _seq.
      write({ t: "hello", epoch: conv.epoch, seq: conv.seq, resync });
      write(conv.statusEvent()); // current phase straight away, not whenever it next changes
      tlog("stream-open", { conv: conv.id, tail: fromNow ? 1 : 0, resume: resumeFrom ?? undefined, epoch: epochParam ? (sameEpoch ? "same" : "stale") : undefined, busy: conv.busy ? 1 : 0 });
      // replays the gap (resume), this run's buffer (fromNow=false), or nothing — then live. A stale
      // epoch streams future-only: the client is about to reload the whole thing anyway.
      unsub = resumeFrom != null ? conv.subscribeSince(write, resumeFrom) : conv.subscribe(write, fromNow || resync);
      // Heartbeat as a DATA frame. It used to be an SSE comment, which EventSource never surfaces to
      // JavaScript, so the client could not tell a quiet stream from a dead one and guessed with a
      // timer. If the client is gone the enqueue throws (caught) and the stream is torn down.
      ping = setInterval(() => { try { controller.enqueue(enc2.encode(`data: {"t":"hb"}\n\n`)); } catch { cleanup(); } }, 15_000);
      // Bun aborts the request signal when it does notice the client is gone. cancel() covers the
      // clean case; this covers the ones it misses, and costs nothing when both fire.
      // Both of these close the controller themselves, so cancel() never runs and would not log the
      // close. Log it here or the open/close counter goes blind, which is the metric this whole
      // problem was found with.
      const shut = (why: string) => { tlog("stream-close", { conv: conv.id, why, busy: conv.busy ? 1 : 0 }); cleanup(); try { controller.close(); } catch {} };
      try { req.signal.addEventListener("abort", () => shut("abort"), { once: true }); } catch { /* no signal on this runtime */ }
      // Retire the stream on schedule so a socket we cannot prove is dead cannot leak forever.
      life = setTimeout(() => shut("expired"), MAX_STREAM_MS);
    },
    cancel() { tlog("stream-close", { conv: conv.id, busy: conv.busy ? 1 : 0 }); cleanup(); },
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

  // --- MCP server management (the tools the LLM can call in /app chats) ---
  // List persisted servers; if ?id=<session> names a LIVE conversation, also return its live
  // per-server status (connected / failed / needs-auth / pending / disabled) + tools.
  if (req.method === "GET" && path === "/app/api/mcp") {
    const servers = await loadMcp(ctx.mcpFile);
    const id = new URL(req.url).searchParams.get("id") || "";
    const live = id ? get(id) : undefined;
    const status = live ? await live.mcpStatus() : [];
    return jsonRes({ servers, status, live: !!live }, ctx, req);
  }
  // Add or update a server: { name, config, applyTo? }. Takes effect on the next new chat; pass
  // applyTo=<id> to also push it live into that running conversation via setMcpServers.
  if (req.method === "POST" && path === "/app/api/mcp") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const res = await upsertServer(ctx.mcpFile, String(b.name || ""), b.config);
    if (!res.ok) return jsonRes({ error: res.error }, ctx, req, 400);
    let applied: unknown = null;
    if (b.applyTo) { const live = get(String(b.applyTo)); if (live) applied = await live.applyMcpServers(await mcpServersForQuery(ctx.mcpFile)); }
    return jsonRes({ ok: true, servers: res.servers, applied }, ctx, req);
  }
  // Remove a server by name: { name, applyTo? }.
  if (req.method === "POST" && path === "/app/api/mcp/delete") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const name = String(b.name || "");
    if (!name) return jsonRes({ error: "name required" }, ctx, req, 400);
    const servers = await removeServer(ctx.mcpFile, name);
    let applied: unknown = null;
    if (b.applyTo) { const live = get(String(b.applyTo)); if (live) applied = await live.applyMcpServers(await mcpServersForQuery(ctx.mcpFile)); }
    return jsonRes({ ok: true, servers, applied }, ctx, req);
  }
  // Push the current persisted set live into a running conversation without restarting it.
  if (req.method === "POST" && path === "/app/api/mcp/apply") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const live = b.id ? get(String(b.id)) : undefined;
    if (!live) return jsonRes({ error: "no live conversation for id" }, ctx, req, 409);
    const applied = await live.applyMcpServers(await mcpServersForQuery(ctx.mcpFile));
    return jsonRes({ ok: true, applied }, ctx, req);
  }

  // --- Memory management (~/.claude memory files) — all paths guarded to ~/.claude ---
  const msCtx: MemSkillCtx = { dataDir: ctx.dataDir, claudeDir: ctx.claudeDir };
  const spawnCtx: SpawnedCtx = { dataDir: ctx.dataDir, claudeDir: ctx.claudeDir };
  if (req.method === "GET" && path === "/app/api/memory") {
    return jsonRes({ projects: listMemory(msCtx) }, ctx, req);
  }
  if (req.method === "GET" && path === "/app/api/memory/file") {
    const p = new URL(req.url).searchParams.get("path") || "";
    try { return jsonRes(await readMemory(msCtx, p), ctx, req); }
    catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }
  if (req.method === "POST" && path === "/app/api/memory/file") {
    let b: any = {}; try { b = await req.json(); } catch {}
    try { const r = await writeMemory(msCtx, String(b.path || ""), String(b.content ?? "")); return jsonRes({ ok: true, ...r }, ctx, req); }
    catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }

  // --- Skills management (~/.claude/skills) ---
  // Enable/disable is a disk toggle (SKILL.md <-> SKILL.md.disabled) so a live reloadSkills()
  // reflects it and every other (incl. plugin) skill is untouched.
  if (req.method === "GET" && path === "/app/api/skills") {
    return jsonRes({ skills: listSkills(msCtx) }, ctx, req);
  }
  if (req.method === "GET" && path === "/app/api/skill") {
    const name = new URL(req.url).searchParams.get("name") || "";
    try { return jsonRes(await readSkill(msCtx, name), ctx, req); }
    catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }
  if (req.method === "POST" && path === "/app/api/skill") {
    let b: any = {}; try { b = await req.json(); } catch {}
    try {
      const r = await writeSkill(msCtx, String(b.name || ""), String(b.content ?? ""), !!b.create);
      if (b.reloadId) { const live = get(String(b.reloadId)); if (live) await live.reloadSkills(); } // pick up the change live
      return jsonRes({ ok: true, ...r }, ctx, req);
    } catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }
  if (req.method === "POST" && path === "/app/api/skill/enabled") {
    let b: any = {}; try { b = await req.json(); } catch {}
    try {
      const r = await setSkillEnabled(msCtx, String(b.name || ""), !!b.enabled);
      if (b.reloadId) { const live = get(String(b.reloadId)); if (live) await live.reloadSkills(); }
      return jsonRes({ ok: true, ...r }, ctx, req);
    } catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }

  // --- Spawned work (subagents / workflows / spawned tabs started BY a chat) ---
  // One list per conversation, and a reader that replays any single item into the same
  // normalized AppEvent array /app/api/conversation returns, so the UI reuses its renderer.
  // Every path is assembled from validated ids and guarded to ~/.claude/projects inside spawned.ts.
  if (req.method === "GET" && path === "/app/api/spawned") {
    const id = new URL(req.url).searchParams.get("id") || "";
    try {
      const r = await listSpawned(spawnCtx, id);
      if ("error" in r) return jsonRes(r, ctx, req, r.error === "not found" ? 404 : 400);
      return jsonRes(r, ctx, req);
    } catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
  }
  if (req.method === "GET" && path === "/app/api/spawned/transcript") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") || "";
    const key = u.searchParams.get("key") || "";
    const sinceRaw = u.searchParams.get("since");
    const since = sinceRaw == null ? null : parseInt(sinceRaw, 10);
    try {
      const r = await getSpawnedTranscript(spawnCtx, id, key, Number.isInteger(since as number) ? (since as number) : null);
      if ("error" in r) return jsonRes({ error: r.error }, ctx, req, r.status || 400);
      return jsonRes(r, ctx, req);
    } catch (e: any) { return jsonRes({ error: String(e?.message || e) }, ctx, req, 400); }
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
  // Live dictation: raw PCM16 chunks with a session id, running transcript back. Query string is
  // forwarded as-is (sid + final) so the STT service owns all the segmenting state.
  if (req.method === "POST" && path === "/app/api/stt/live") {
    if (!ctx.sttUrl) return jsonRes({ error: "stt not configured" }, ctx, req, 503);
    try {
      const u = new URL(req.url);
      const body = await req.arrayBuffer();
      const up = await fetch(ctx.sttUrl.replace(/\/$/, "") + "/live" + u.search, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      const text = await up.text();
      return new Response(text, { status: up.status, headers: { ...ctx.cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch (e: any) {
      return jsonRes({ error: "stt upstream: " + (e?.message || e) }, ctx, req, 502);
    }
  }
  // Tidy a finished dictation: punctuation, filler, spoken commands, project names. Falls back to
  // the raw transcript on any failure, so the composer always ends up with the user's words.
  if (req.method === "POST" && path === "/app/api/stt/cleanup") {
    try {
      const b: any = await req.json();
      // Fired when the mic opens, not when it closes: the cleanup process is slow to start and fast
      // to answer, so it starts while the user is still speaking.
      if (b?.warm) { warmDictation(); return jsonRes({ ok: true }, ctx, req); }
      const raw = String(b?.text || "");
      if (!raw.trim()) return jsonRes({ text: "" }, ctx, req);
      const text = await cleanDictation(raw);
      return jsonRes({ text }, ctx, req);
    } catch (e: any) {
      return jsonRes({ error: "cleanup: " + (e?.message || e) }, ctx, req, 500);
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
    // Delta fetch: `?since=N` returns only the events after the caller's cursor. The transcript is
    // append-only, so events[0..N] are stable and folding the tail onto the caller's already-reduced
    // items gives the same result as reducing the whole thing (it is a plain fold). Reopening a long
    // chat then costs a few KB instead of the whole transcript, which is what makes it survive a weak
    // link. Out-of-range or absent cursor falls back to a full send with delta:false, so a client that
    // has diverged (or a legacy cache with no cursor) always self-heals.
    // `?meta=1` answers with the cursor and nothing else. A conversation the app streamed live has an
    // untrustworthy cursor (live events are not transcript events), and re-establishing it by pulling
    // the whole transcript would cost hundreds of KB on exactly the link we are trying to protect.
    // This costs about 20 bytes instead.
    if (new URL(req.url).searchParams.get("meta") === "1") {
      return jsonRes({ sessionId: id, cwd: meta.cwd, title: meta.title, evTotal: events.length, live: !!live, busy: !!live?.busy, epoch: live?.epoch ?? null, seq: live?.seq ?? -1 }, ctx, req);
    }
    const sinceRaw = new URL(req.url).searchParams.get("since");
    const since = sinceRaw == null ? -1 : parseInt(sinceRaw, 10);
    const delta = Number.isInteger(since) && since >= 0 && since <= events.length;
    return jsonRes({
      sessionId: id, cwd: meta.cwd, title: meta.title,
      events: delta ? events.slice(since) : events,
      delta, evTotal: events.length,
      live: !!live, busy: !!live?.busy, pendingAsks: live?.listPendingAsks() || [],
      epoch: live?.epoch ?? null, seq: live?.seq ?? -1, phase: live?.phase ?? "idle", model: live?.model ?? null,
    }, ctx, req);
  }

  // Start a chat: brand-new (no resume) or resume an existing session id. Kicks the first turn.
  if (req.method === "POST" && path === "/app/api/start") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const rawText = String(b.text ?? "").trim();
    if (!rawText) return jsonRes({ error: "empty message" }, ctx, req, 400);
    const dup = dedupSeen(b.cid); // a redelivery of an already-processed turn -> ack, do not send again
    if (dup) { tlog("dedup", { route: "start", conv: dup.id, cid: shortCid(b.cid) }); return jsonRes({ id: dup.id, deduped: true }, ctx, req); }
    const text = b.voice ? decorateVoiceTurn(rawText) : rawText; // voice mode -> append the brief/TTS directive
    const resume: string | undefined = b.resume && /^[A-Za-z0-9-]{6,}$/.test(b.resume) ? b.resume : undefined;
    let cwd: string = ctx.defaultCwd;
    if (resume) { const found = findTranscript(ctx, resume); if (found) { const m = await convMeta(found.path); if (m.cwd) cwd = m.cwd; } }
    if (typeof b.cwd === "string" && b.cwd.startsWith("/")) cwd = b.cwd;
    const model: string | undefined = typeof b.model === "string" && b.model ? b.model : undefined;
    // if already live under this session id, just send into it
    const existing = resume ? get(resume) : undefined;
    if (existing) { tlog("accept", { route: "start", conv: existing.id, cid: shortCid(b.cid), chars: text.length, mode: "resumed-live" }); existing.send(text, typeof b.cid === "string" ? b.cid : undefined); dedupRecord(b.cid, existing.id); return jsonRes({ id: existing.id, resumed: true }, ctx, req); }
    const conv = getOrCreate(resume || null, { cwd, model, resume, notifier: ctx.notifyAsk, mcpFile: ctx.mcpFile });
    tlog("accept", { route: "start", conv: conv.id, cid: shortCid(b.cid), chars: text.length, mode: resume ? "resume" : "new" });
    void conv.run(text, typeof b.cid === "string" ? b.cid : undefined);
    dedupRecord(b.cid, conv.id);
    return jsonRes({ id: conv.id, cwd, model: model || null, epoch: conv.epoch }, ctx, req);
  }

  // Follow-up turn into an already-open conversation.
  if (req.method === "POST" && path === "/app/api/send") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const conv = b.id ? get(String(b.id)) : undefined;
    if (!conv) return jsonRes({ error: "no live conversation for id (start or resume it first)" }, ctx, req, 409);
    const rawText = String(b.text ?? "").trim();
    if (!rawText) return jsonRes({ error: "empty message" }, ctx, req, 400);
    if (dedupSeen(b.cid)) { tlog("dedup", { route: "send", conv: conv.id, cid: shortCid(b.cid) }); return jsonRes({ ok: true, id: conv.id, deduped: true }, ctx, req); } // redelivery -> ack, don't re-send
    tlog("accept", { route: "send", conv: conv.id, cid: shortCid(b.cid), chars: rawText.length });
    conv.send(b.voice ? decorateVoiceTurn(rawText) : rawText, typeof b.cid === "string" ? b.cid : undefined); // voice mode -> append the brief/TTS directive
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
    if (!conv) { conv = getOrCreate(id, { cwd: meta.cwd || ctx.defaultCwd, model: b.model || undefined, resume: id, notifier: ctx.notifyAsk, mcpFile: ctx.mcpFile }); await conv.bootForRewind(); }
    const text = b.voice ? decorateVoiceTurn(rawText) : rawText;
    tlog("accept", { route: "edit", conv: conv.id, cid: shortCid(b.cid), chars: text.length, index });
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
    const target = resolve(rel.startsWith("/") ? rel : join(base, rel)); // resolve() so a ".." in the path cannot walk out of a root
    // Traversal guard. The chat's own cwd always counts; the configured roots cover the rest of the
    // owner's filesystem, so a file Claude wrote outside the directory the chat happens to sit in
    // still resolves. A guest container ships no roots, so it keeps the old cwd-only behaviour.
    const under = (root: string) => target === root || target.startsWith(root.replace(/\/+$/, "") + "/");
    if (!under(base) && !ctx.downloadRoots.some(under)) return jsonRes({ error: "path outside conversation" }, ctx, req, 403);
    const f = Bun.file(target);
    if (!(await f.exists())) return jsonRes({ error: "not found" }, ctx, req, 404);
    const name = target.split("/").pop() || "download";
    // Images are usually rendered inline in the chat rather than saved, and "attachment" makes
    // opening one in a new tab download it instead of showing it. Everything else stays an
    // attachment so a click on a file card is still a download.
    const inline = /^image\//.test(f.type || "");
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(f, { headers: { ...ctx.cors(req), "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"` } });
  }

  return new Response("Not Found", { status: 404, headers: ctx.cors(req) });
}
