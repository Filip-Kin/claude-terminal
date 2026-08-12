// claude-terminal server (Bun). Two roles, path-routed by nginx:
//   - Terminal sidecar (owner-gated): /overlay.js, /upload, /sessions*, /theme, /usage (figure)
//     mounted by nginx at claude.<domain>/_ct/*  (strip prefix)
//   - Usage dashboard (public): /usage/ (page), /usage/api (JSON from SQLite), /usage/stream (SSE)
//     mounted by nginx at users.<domain>/usage/*
// Config-driven via config.json. Reads usage.db (written by collector.ts); never scrapes
// transcripts itself. HOME-relative for the per-instance terminal bits (tab-registry, settings,
// tmux), so the same binary runs for the host owner and inside each guest container.
import { mkdir, rename, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { watch, readdirSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import webpush from "web-push";

const CONFIG_PATH = process.argv[2] || join(import.meta.dir, "config.json");
const cfg = JSON.parse(await Bun.file(CONFIG_PATH).text());
const OWNER: string = cfg.owner;
const DB_PATH: string = cfg.db;
const PORT = Number(process.env.PORT || cfg.port || 7682);
// 127.0.0.1 on the host (nginx is local); guests set "0.0.0.0" so docker port
// publishing can reach the in-container sidecar.
const HOST = cfg.host || "127.0.0.1";

// Terminal-only mode (no usage tracking) = per-guest sidecars: they serve the tab bar
// + paste for one isolated container and don't open a usage DB or serve the dashboard.
const USAGE_PAGE = cfg.usagePage !== false;
const GATE = cfg.gateTerminal !== false; // guests are per-container isolated -> can disable
const HOME = process.env.HOME || `/home/${OWNER}`;
const REG_DIR = join(HOME, ".claude", "tab-registry");
const COUNTER_FILE = join(REG_DIR, ".counter");
const SETTINGS = join(HOME, ".claude", "settings.json");
const UPLOAD_DIR = "/tmp/claude-paste";
const MAX_BYTES = 20 * 1024 * 1024;
const PUBLIC_DIR = join(import.meta.dir, "public");
const overlayPath = join(import.meta.dir, "overlay.js");

// #region PWA + Web Push config
const APP_NAME: string = cfg.appName || "Claude Terminal";
const APP_SHORT: string = cfg.appShort || "Claude";
const THEME_COLOR: string = cfg.themeColor || "#D97757";
const BG_COLOR: string = cfg.bgColor || "#1a1613";
const VAPID_SUBJECT: string = cfg.vapidSubject || "mailto:admin@localhost";
// runtime state (VAPID keypair + push subscriptions) lives OUTSIDE the repo,
// HOME-relative so the same binary works on the host and inside a guest container.
const STATE_DIR: string = cfg.stateDir || join(HOME, ".claude");
const VAPID_FILE = join(STATE_DIR, "claude-terminal-vapid.json");
const SUBS_FILE = join(STATE_DIR, "claude-terminal-push.json");
const PWA_DIR = join(import.meta.dir, "pwa");
const swPath = join(import.meta.dir, "sw.js");
const PWA_MIME: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
// #endregion

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
};

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(REG_DIR, { recursive: true });

// read-only handle on the collector-written DB (WAL, so it sees committed writes)
const db: Database | null = USAGE_PAGE ? new Database(DB_PATH, { readonly: true }) : null;
if (db) db.exec("PRAGMA busy_timeout = 5000;");

// #region usage leaderboard (SQLite -> the leaderboard.json shape the page already consumes)
const ROLLING_HOURS = 5, GAUGE_MAX = 5_000_000, HOURLY_HOURS = 168, SPARK_HOURS = 48;
const ACTIVE_MS = 15 * 60 * 1000;
const SUBSCRIPTION_USD = Number(cfg.subscriptionUsd || 0);

const pad = (n: number) => String(n).padStart(2, "0");
const hourKeyOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthLabel = (mk: string) => {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

function rolling(hours: Map<string, any>, metric: string, now: Date, n = ROLLING_HOURS): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const b = hours.get(hourKeyOf(new Date(now.getTime() - i * 3600e3)));
    if (b) t += b[metric] || 0;
  }
  return t;
}
function sparkSeries(hours: Map<string, any>, now: Date, n: number): number[] {
  const vals: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const b = hours.get(hourKeyOf(new Date(now.getTime() - i * 3600e3)));
    vals.push(b ? b.output || 0 : 0);
  }
  return vals;
}
function splitCents(amounts: Record<string, number>, pot: number): Record<string, number> {
  const total = Object.values(amounts).reduce((a, b) => a + b, 0);
  const cents: Record<string, number> = {};
  if (total <= 0) { for (const k in amounts) cents[k] = 0; return cents; }
  const exact: Record<string, number> = {};
  for (const k in amounts) { exact[k] = (pot * amounts[k]) / total; cents[k] = Math.floor(exact[k]); }
  let leftover = pot - Object.values(cents).reduce((a, b) => a + b, 0);
  const order = Object.keys(exact).sort((a, b) => exact[b] - cents[b] - (exact[a] - cents[a]));
  for (let i = 0; i < leftover; i++) cents[order[i]]++;
  return cents;
}

const qUsers = db?.query("SELECT user FROM cumulative ORDER BY user") as any;
const qHours = db?.query("SELECT hour_utc, total, output FROM hourly WHERE user = ?") as any;
const qCum = db?.query("SELECT * FROM cumulative WHERE user = ?") as any;
const qMeta = db?.query("SELECT * FROM meta WHERE user = ?") as any;

function buildLeaderboard() {
  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  const hour0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const hour_ms: number[] = [];
  for (let i = 0; i < HOURLY_HOURS; i++) hour_ms.push(hour0.getTime() - (HOURLY_HOURS - 1 - i) * 3600e3);

  const byMonth: Record<string, Record<string, number>> = {};
  const users: any[] = [];
  for (const { user } of qUsers.all() as any[]) {
    const hours = new Map<string, any>();
    for (const r of qHours.all(user) as any[]) {
      hours.set(r.hour_utc, { total: r.total, output: r.output });
      const mk = r.hour_utc.slice(0, 7);
      (byMonth[mk] ??= {})[user] = (byMonth[mk][user] || 0) + r.output;
    }
    const cum = (qCum.get(user) as any) || { output: 0, total: 0 };
    const meta = (qMeta.get(user) as any) || {};
    const last = meta.last_activity || null;
    let active = false;
    if (last) { const t = Date.parse(last); if (!isNaN(t)) active = now.getTime() - t <= ACTIVE_MS; }
    let monthOutput = 0;
    for (const [hk, b] of hours) if (hk.slice(0, 7) === monthPrefix) monthOutput += b.output;
    users.push({
      user,
      name: cfg.names?.[user] || titleCase(user),
      host: (cfg.hosts || []).includes(user),
      output_5h: rolling(hours, "output", now),
      output_total: cum.output,
      tokens_total: cum.total,
      sessions: meta.sessions || 0,
      models: JSON.parse(meta.models || "[]").filter((m: string) => !String(m).startsWith("<")),
      last_used: last,
      active,
      spark: sparkSeries(hours, now, SPARK_HOURS),
      hourly: sparkSeries(hours, now, HOURLY_HOURS),
      month_output: monthOutput,
    });
  }

  const allUsers = users.map((u) => u.user);
  const nameOf = Object.fromEntries(users.map((u) => [u.user, u.name]));
  const pot = SUBSCRIPTION_USD * 100;
  const months: any[] = [];
  for (const mk of Object.keys(byMonth).sort()) {
    const outs: Record<string, number> = {};
    for (const u of allUsers) outs[u] = byMonth[mk][u] || 0;
    const total = Object.values(outs).reduce((a, b) => a + b, 0);
    const cents = splitCents(outs, pot);
    const rows = allUsers.map((u) => ({
      user: u, name: nameOf[u], output: outs[u],
      pct: total ? Math.round((1000 * outs[u]) / total) / 10 : 0,
      share_usd: cents[u] / 100,
    }));
    rows.sort((a, b) => b.output - a.output);
    months.push({ key: mk, label: monthLabel(mk), total, rows });
  }

  const cur: Record<string, number> = {};
  for (const u of allUsers) cur[u] = byMonth[monthPrefix]?.[u] || 0;
  const curTotal = Object.values(cur).reduce((a, b) => a + b, 0);
  const curCents = splitCents(cur, pot);
  for (const u of users) {
    u.share_usd = curCents[u.user] / 100;
    u.month_pct = curTotal ? Math.round((1000 * cur[u.user]) / curTotal) / 10 : 0;
  }
  users.sort((a, b) => b.month_output - a.month_output || b.output_total - a.output_total);

  return {
    generated_at: now.toISOString().replace(/\.\d+Z$/, "+00:00"),
    window_hours: ROLLING_HOURS, gauge_max: GAUGE_MAX, subscription_usd: SUBSCRIPTION_USD,
    month_label: monthLabel(monthPrefix), current_month: monthPrefix,
    months, hour_ms, spark_hours: SPARK_HOURS, users,
  };
}

function ownerFigure() {
  if (!db) return { output_5h: null, share_usd: null, month_label: null };
  const lb = buildLeaderboard();
  const me = lb.users.find((u: any) => u.user === OWNER) || {};
  return { output_5h: me.output_5h ?? null, share_usd: me.share_usd ?? null, month_label: lb.month_label };
}
// #endregion

// #region SSE live stream (push when the collector updates the DB)
const sseClients = new Set<ReadableStreamDefaultController>();
function broadcast() {
  const enc = new TextEncoder();
  for (const c of sseClients) { try { c.enqueue(enc.encode("data: tick\n\n")); } catch {} }
}
let watchTimer: any = null;
if (USAGE_PAGE) {
  try {
    // WAL writes land in usage.db-wal, so watch the whole DB directory, debounced.
    watch(dirname(DB_PATH), () => { clearTimeout(watchTimer); watchTimer = setTimeout(broadcast, 300); });
  } catch (e) { console.error("db watch failed", e); }
}
// #endregion

// #region Web Push (VAPID) — generic notification path for the owner + local services
// Load or mint a VAPID keypair (persisted; regenerating would orphan every device).
let vapid: { publicKey: string; privateKey: string };
try {
  vapid = JSON.parse(await Bun.file(VAPID_FILE).text());
  if (!vapid?.publicKey || !vapid?.privateKey) throw new Error("bad vapid file");
} catch {
  vapid = webpush.generateVAPIDKeys();
  await Bun.write(VAPID_FILE, JSON.stringify(vapid, null, 2));
  try { await chmod(VAPID_FILE, 0o600); } catch {}
  console.log("generated VAPID keypair ->", VAPID_FILE);
}
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

type PushSub = { endpoint: string; keys?: { p256dh: string; auth: string } };
let subs: PushSub[] = [];
try { const s = JSON.parse(await Bun.file(SUBS_FILE).text()); if (Array.isArray(s)) subs = s; } catch {}
let subsSaveTimer: any = null;
function saveSubs() { clearTimeout(subsSaveTimer); subsSaveTimer = setTimeout(() => { Bun.write(SUBS_FILE, JSON.stringify(subs)).catch(() => {}); }, 200); }
function addSub(s: PushSub) { if (!s?.endpoint) return; if (!subs.some((x) => x.endpoint === s.endpoint)) { subs.push(s); saveSubs(); } }
function removeSub(endpoint: string) { const n = subs.length; subs = subs.filter((x) => x.endpoint !== endpoint); if (subs.length !== n) saveSubs(); }

type NotifPayload = { title: string; body?: string; url?: string; tag?: string; icon?: string; requireInteraction?: boolean; sessionId?: string };
async function pushAll(payload: NotifPayload): Promise<{ sent: number; pruned: number }> {
  const data = JSON.stringify(payload);
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s as any, data, { TTL: 120 }); }
    catch (e: any) { const c = e?.statusCode; if (c === 404 || c === 410) dead.push(s.endpoint); }
  }));
  for (const d of dead) removeSub(d);
  return { sent: subs.length, pruned: dead.length };
}

// Focus heartbeat: the overlay POSTs the session it is actively watching so we can
// suppress a redundant prompt-finished push for the tab already on your screen.
let activeId: string | null = null;
let activeAt = 0;
const ACTIVE_WINDOW_MS = 40000;

// Local services (loopback, no Remote-User header) and the authenticated owner may
// trigger notifications; a different authenticated user (guest via nginx) may not.
function notifyAllowed(req: Request): boolean {
  if (!GATE) return true;
  const hdr = req.headers.get("remote-user");
  return !hdr || hdr === OWNER;
}
// #endregion

// #region terminal sidecar helpers (unchanged behaviour, owner-gated)
type SessionRow = { id: string; created: number; attached: boolean };
async function runTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { env: { ...process.env, TMUX_TMPDIR: "/tmp" }, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}
async function tmuxSessions(): Promise<SessionRow[]> {
  let out = "";
  try { out = await runTmux(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}"]); }
  catch { return []; }
  const rows: SessionRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, created, attached] = line.split("\t");
    rows.push({ id: name, created: parseInt(created, 10) || 0, attached: attached === "1" });
  }
  return rows;
}
async function lastAiTitle(tp: string): Promise<string | null> {
  try {
    const f = Bun.file(tp); const size = f.size; const TAIL = 1024 * 1024;
    const text = await f.slice(size > TAIL ? size - TAIL : 0).text();
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"type":"ai-title"')) {
        try { const o = JSON.parse(lines[i]); if (o.aiTitle) return String(o.aiTitle); } catch {}
      }
    }
  } catch {}
  return null;
}
async function titleForSession(name: string): Promise<string | null> {
  try {
    const meta = await Bun.file(join(REG_DIR, `${name}.json`)).json();
    if (meta?.transcript_path) { const t = await lastAiTitle(meta.transcript_path); if (t) return t; }
  } catch {}
  return null;
}
async function stateForSession(name: string): Promise<string> {
  try {
    const s = (await Bun.file(join(REG_DIR, `${name}.state`)).text()).trim();
    if (s === "thinking" || s === "waiting" || s === "done" || s === "seen") return s;
  } catch {}
  return "seen";
}
// #region conversation history (like /resume) — list the owner's past transcripts
function listTranscripts(): { path: string; sessionId: string; project: string; mtime: number }[] {
  const base = cfg.dataDir;
  const out: any[] = [];
  // Automation/agents (stonkbot, sleeper, ...) run their own `claude --print` under
  // these dirs; exclude them so history shows only the owner's interactive chats.
  const exclude: string[] = [];
  for (const dirs of Object.values(cfg.extraUsers || {})) for (const d of dirs as string[]) exclude.push(d);
  let projs;
  try { projs = readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const p of projs) {
    if (!p.isDirectory()) continue;
    if (p.name.startsWith("-tmp-")) continue; // skip scratch/ephemeral cwds
    const pdir = join(base, p.name);
    if (exclude.some((d) => pdir === d || pdir.startsWith(d + "/"))) continue;
    let files;
    try { files = readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = join(pdir, f);
      let st;
      try { st = statSync(fp); } catch { continue; }
      out.push({ path: fp, sessionId: f.slice(0, -6), project: p.name, mtime: st.mtimeMs });
    }
  }
  return out;
}

// Pull a display title (Claude's ai-title, else the first real user message) and the
// session's original cwd from a transcript.
async function convMeta(path: string): Promise<{ title: string | null; cwd: string | null }> {
  const title = await lastAiTitle(path);
  let cwd: string | null = null;
  let first: string | null = null;
  try {
    const head = await Bun.file(path).slice(0, 65536).text();
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (!cwd && d.cwd) cwd = d.cwd;
      if (!first && d.type === "user") {
        const c = d.message?.content;
        let txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
        txt = (txt || "").trim();
        if (txt && !txt.startsWith("<")) first = txt.replace(/\s+/g, " ").slice(0, 100);
      }
      if (cwd && first) break;
    }
  } catch {}
  return { title: title || first, cwd };
}
// #endregion

async function allocateId(): Promise<number> {
  let counter = 1;
  try { counter = parseInt(await Bun.file(COUNTER_FILE).text(), 10) || 1; } catch {}
  let maxNum = 1;
  for (const s of await tmuxSessions()) { const n = parseInt(s.id, 10); if (String(n) === s.id && n > maxNum) maxNum = n; }
  const next = Math.max(counter, maxNum) + 1;
  await Bun.write(COUNTER_FILE, String(next));
  return next;
}
async function readTheme(): Promise<string> {
  try { const t = (await Bun.file(SETTINGS).json()).theme; return t === "light" ? "light" : "dark"; } catch { return "dark"; }
}
async function writeTheme(theme: string): Promise<void> {
  const obj = JSON.parse(await Bun.file(SETTINGS).text());
  obj.theme = theme;
  const tmp = SETTINGS + ".tmp";
  await Bun.write(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, SETTINGS);
}
// Newly-minted tabs: the id is allocated before the browser reattaches and tmux
// actually creates the session, so /sessions wouldn't list it for a few seconds.
// Track pending ids so the chip shows instantly, then hand off to the real session.
const PENDING_TTL_MS = 45000;
const pending = new Map<string, number>(); // id -> created (unix seconds)

// Strict: require nginx's Remote-User to equal the owner. nginx sets it per-user on
// every /_paste route, but a direct cross-container request has no such header, so
// guests can't reach each other's sidecars on the shared docker bridge.
function allowed(req: Request): boolean { return !GATE || req.headers.get("remote-user") === OWNER; }
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  for (const o of cfg.corsOrigins || []) if (origin === o) return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
  return {};
}
// #endregion

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;

    // Deterministic live push: the collector POSTs here after it commits usage.db.
    // The server binds 127.0.0.1 only, so this is inherently localhost-only.
    // The tab bar's usage figure. Always answers; terminal-only guests get nulls.
    if (req.method === "GET" && path === "/usage") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      return Response.json(ownerFigure(), { headers: cors(req) });
    }

    // #region usage dashboard (public) — only when this instance hosts it
    if (USAGE_PAGE) {
      if (req.method === "POST" && path === "/internal/tick") { broadcast(); return new Response("ok"); }
      if (req.method === "GET" && path === "/usage/api") {
        return Response.json(buildLeaderboard(), { headers: { "Cache-Control": "no-store", ...cors(req) } });
      }
      if (req.method === "GET" && path === "/usage/stream") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            controller.enqueue(new TextEncoder().encode("retry: 5000\ndata: hello\n\n"));
          },
          cancel() {},
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
      }
      if (req.method === "GET" && path === "/usage/") {
        return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && path.startsWith("/usage/")) {
        const rel = path.slice("/usage/".length);
        if (rel && !rel.includes("..") && !rel.includes("/")) {
          const f = Bun.file(join(PUBLIC_DIR, rel));
          if (await f.exists()) return new Response(f);
        }
        return new Response("Not Found", { status: 404 });
      }
    }
    // #endregion

    // #region terminal sidecar (owner-gated where noted)
    if (req.method === "GET" && path === "/overlay.js") {
      return new Response(Bun.file(overlayPath), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // #region PWA (installable app) — manifest, service worker, icons. Ungated
    // (non-sensitive static assets; the vhost is already behind Authelia).
    if (req.method === "GET" && path === "/manifest.webmanifest") {
      return Response.json({
        name: APP_NAME, short_name: APP_SHORT, id: "/",
        start_url: "/", scope: "/",
        display: "standalone", display_override: ["standalone", "fullscreen", "minimal-ui"],
        orientation: "any", background_color: BG_COLOR, theme_color: THEME_COLOR,
        icons: [
          { src: "/_ct/pwa/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/_ct/pwa/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/_ct/pwa/icon-maskable-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/_ct/pwa/icon-maskable-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }, { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (req.method === "GET" && path === "/sw.js") {
      // Registered at scope "/", so it must advertise the wider scope. nginx passes
      // this response header through unchanged.
      return new Response(Bun.file(swPath), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" } });
    }
    if (req.method === "GET" && path.startsWith("/pwa/")) {
      const rel = path.slice("/pwa/".length);
      if (rel && !rel.includes("..") && !rel.includes("/")) {
        const f = Bun.file(join(PWA_DIR, rel));
        if (await f.exists()) {
          const dot = rel.lastIndexOf(".");
          const mime = PWA_MIME[rel.slice(dot).toLowerCase()] || "application/octet-stream";
          return new Response(f, { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" } });
        }
      }
      return new Response("Not Found", { status: 404 });
    }
    // #endregion

    // #region Web Push subscription + notification endpoints
    if (req.method === "GET" && path === "/vapidPublicKey") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      return Response.json({ key: vapid.publicKey }, { headers: cors(req) });
    }
    if (req.method === "POST" && path === "/subscribe") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      if (!body?.endpoint) return new Response("Bad subscription", { status: 400 });
      addSub(body);
      return Response.json({ ok: true, subscribed: subs.length }, { headers: cors(req) });
    }
    if (req.method === "POST" && path === "/unsubscribe") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      if (body?.endpoint) removeSub(String(body.endpoint));
      return Response.json({ ok: true, subscribed: subs.length }, { headers: cors(req) });
    }
    if (req.method === "POST" && path === "/active") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      activeId = body?.id != null ? String(body.id) : null;
      activeAt = Date.now();
      return Response.json({ ok: true }, { headers: cors(req) });
    }
    // Generic: anything the owner (or a local service like stonkbot) wants to push.
    // { title, body?, url?, tag?, icon?, requireInteraction?, sessionId? }
    if (req.method === "POST" && path === "/notify") {
      if (!notifyAllowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      const title = String(body.title ?? body.message ?? "").slice(0, 120) || "Claude";
      const payload: NotifPayload = {
        title,
        body: body.body != null ? String(body.body).slice(0, 500) : "",
        url: body.url ? String(body.url) : "/",
        tag: body.tag ? String(body.tag) : undefined,
        icon: body.icon ? String(body.icon) : undefined,
        requireInteraction: !!body.requireInteraction,
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
      };
      const res = await pushAll(payload);
      return Response.json({ ok: true, ...res }, { headers: cors(req) });
    }
    // Hook-driven prompt-finished / waiting-for-input push. Suppressed when you are
    // actively watching that exact tab (focus heartbeat), so you only get pinged
    // when you're away or looking at a different session.
    if (req.method === "POST" && path === "/notify/session") {
      if (!notifyAllowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      const id = String(body.id || "");
      const kind = String(body.kind || "done");
      if (!id) return new Response("Missing id", { status: 400 });
      if (activeId === id && Date.now() - activeAt < ACTIVE_WINDOW_MS) {
        return Response.json({ ok: true, suppressed: true });
      }
      const t = (await titleForSession(id)) || `Session ${id}`;
      const title = kind === "waiting" ? "⏳ Waiting for input" : "✅ Turn finished";
      const res = await pushAll({
        title, body: t, url: "/?arg=" + encodeURIComponent(id),
        tag: "sess-" + id, sessionId: id, requireInteraction: kind === "waiting",
      });
      return Response.json({ ok: true, ...res });
    }
    // #endregion
    if (req.method === "POST" && path === "/upload") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("multipart/form-data")) return new Response("Expected multipart/form-data", { status: 400 });
      const form = await req.formData();
      const file = form.get("image");
      if (!(file instanceof File)) return new Response("Missing 'image' field", { status: 400 });
      if (file.size > MAX_BYTES) return new Response("File too large", { status: 413 });
      const ext = MIME_EXT[file.type];
      if (!ext) return new Response(`Unsupported type: ${file.type}`, { status: 415 });
      const savePath = join(UPLOAD_DIR, `${randomUUID()}.${ext}`);
      await Bun.write(savePath, file);
      return Response.json({ path: savePath });
    }
    if (req.method === "GET" && path === "/sessions") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      const rows = await tmuxSessions();
      // Fold in pending (just-created) tabs that tmux hasn't materialised yet; drop
      // any that have since gone live or timed out (opened tab was abandoned).
      const liveIds = new Set(rows.map((r) => r.id));
      const nowSec = Math.floor(Date.now() / 1000);
      for (const [pid, created] of [...pending]) {
        if (liveIds.has(pid) || (nowSec - created) * 1000 > PENDING_TTL_MS) { pending.delete(pid); continue; }
        rows.push({ id: pid, created, attached: false });
      }
      // Title standard: use Claude's ai-title once the conversation has one; until
      // then a numeric tab (main "1" or a freshly-opened one) reads "New Tab", and a
      // named session falls back to its name.
      const withTitles = await Promise.all(rows.map(async (r) => {
        const ai = await titleForSession(r.id);
        const title = ai || (/^\d+$/.test(r.id) ? "New Tab" : r.id);
        return { id: r.id, title, state: await stateForSession(r.id), created: r.created, attached: r.attached };
      }));
      withTitles.sort((a, b) => a.created - b.created);
      withTitles.sort((a, b) => (a.id === "1" ? -1 : b.id === "1" ? 1 : 0));
      return Response.json(withTitles, { headers: cors(req) });
    }
    if (req.method === "GET" && path === "/history") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      const all = listTranscripts().sort((a, b) => b.mtime - a.mtime).slice(0, 60);
      const rows = await Promise.all(all.map(async (t) => {
        const m = await convMeta(t.path);
        return { sessionId: t.sessionId, title: m.title, cwd: m.cwd, mtime: Math.floor(t.mtime) };
      }));
      const hide: string[] = cfg.historyHide || [];
      return Response.json(
        rows.filter((r) => r.title && !hide.some((h) => (r.cwd || "").startsWith(h))),
        { headers: cors(req) },
      );
    }

    if (req.method === "POST" && path === "/sessions/new") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {};
      try { body = await req.json(); } catch {}
      const id = String(await allocateId());
      if (body.resume) {
        // the ttyd wrapper consumes this to run `claude --resume <id>` in the right cwd
        const line = `${String(body.resume)}\t${String(body.cwd || "")}`;
        try { await Bun.write(join(REG_DIR, `${id}.resume`), line); } catch {}
      }
      pending.set(id, Math.floor(Date.now() / 1000)); // show it immediately
      return Response.json({ id }, { headers: cors(req) });
    }
    if (req.method === "POST" && path === "/sessions/close") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      const id = String(body.id || "");
      if (!id) return new Response("Missing id", { status: 400 });
      await runTmux(["kill-session", "-t", id]);
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && path === "/sessions/seen") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      const id = String(body.id || "");
      if (id) {
        try { const sf = join(REG_DIR, `${id}.state`); const cur = (await Bun.file(sf).text()).trim(); if (cur === "done") await Bun.write(sf, "seen"); } catch {}
      }
      return Response.json({ ok: true });
    }
    if (req.method === "GET" && path === "/theme") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      return Response.json({ theme: await readTheme() }, { headers: cors(req) });
    }
    if (req.method === "POST" && path === "/theme") {
      if (!allowed(req)) return new Response("Forbidden", { status: 403 });
      let body: any = {}; try { body = await req.json(); } catch {}
      const theme = String(body.theme || "");
      if (theme !== "dark" && theme !== "light") return new Response("Bad theme", { status: 400 });
      await writeTheme(theme);
      return Response.json({ ok: true, theme });
    }
    // #endregion

    return new Response("Not Found", { status: 404 });
  },
  error(err) { console.error("server error", err); return new Response("Internal error", { status: 500 }); },
});

// prune dead SSE controllers periodically (enqueue throws on closed ones)
setInterval(() => {
  const enc = new TextEncoder();
  for (const c of [...sseClients]) { try { c.enqueue(enc.encode(": ping\n\n")); } catch { sseClients.delete(c); } }
}, 25000);

console.log(`claude-terminal listening on http://${server.hostname}:${server.port} (owner=${OWNER}, db=${DB_PATH})`);
