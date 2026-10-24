// Battery diagnostics store. bstats-client.js posts what each open page did while visible and hidden;
// the server adds what it did to the phone from its side (push sends, service-worker delta pulls).
// GET /bstats/report sums a window so "is the PWA what drains Chrome" gets a measured answer.
import { Database } from "bun:sqlite";

const KEEP_MS = 14 * 86400_000;
const NUM_KEYS = ["ms", "reqN", "reqB", "sseOpen", "sseErr", "sseN", "sseB", "wsOpen", "wsN", "wsB", "wsOut", "longN", "longMs", "freeze", "frozenMs"];

let db: Database | null = null;

export function initBstats(file: string) {
  db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, cid TEXT, page TEXT, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
    CREATE TABLE IF NOT EXISTS server_events (hour TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour, kind));
  `);
  const prune = () => {
    const cut = Date.now() - KEEP_MS;
    db!.run("DELETE FROM samples WHERE at < ?", [cut]);
    db!.run("DELETE FROM server_events WHERE hour < ?", [new Date(cut).toISOString().slice(0, 13)]);
  };
  prune();
  setInterval(prune, 86400_000);
}

export function recordSample(body: any) {
  if (!db || !body || typeof body !== "object") return;
  const s = JSON.stringify(body);
  if (s.length > 64_000) return;
  db.run("INSERT INTO samples (at, cid, page, data) VALUES (?, ?, ?, ?)", [Date.now(), String(body.cid || ""), String(body.page || ""), s]);
}

export function countEvent(kind: string, n = 1) {
  if (!db || n <= 0) return;
  const hour = new Date().toISOString().slice(0, 13);
  db.run("INSERT INTO server_events (hour, kind, n) VALUES (?, ?, ?) ON CONFLICT(hour, kind) DO UPDATE SET n = n + excluded.n", [hour, kind, n]);
}

function addInto(dst: any, src: any) {
  for (const k of NUM_KEYS) dst[k] = (dst[k] || 0) + (Number(src?.[k]) || 0);
  for (const [r, [n, b]] of Object.entries<any>(src?.req || {})) {
    const d = dst.req[r] || (dst.req[r] = [0, 0]);
    d[0] += n; d[1] += b;
  }
  for (const [k, n] of Object.entries<any>(src?.iv || {})) dst.iv[k] = (dst.iv[k] || 0) + n;
}

export function buildReport(hours: number) {
  if (!db) return { available: false };
  const from = Date.now() - hours * 3600_000;
  const rows = db.query("SELECT at, page, data FROM samples WHERE at >= ? ORDER BY at").all(from) as any[];
  const pages: Record<string, any> = {};
  const battery: any[] = [];
  for (const r of rows) {
    let d: any; try { d = JSON.parse(r.data); } catch { continue; }
    const p = pages[r.page] || (pages[r.page] = { samples: 0, clients: new Set(), v: { req: {}, iv: {} }, h: { req: {}, iv: {} } });
    p.samples++; p.clients.add(d.cid);
    addInto(p.v, d.v); addInto(p.h, d.h);
    if (d.battery) battery.push({ at: new Date(r.at).toISOString(), page: r.page, reason: d.reason, level: d.battery.level, charging: d.battery.charging });
  }
  for (const p of Object.values<any>(pages)) {
    p.clients = p.clients.size;
    for (const side of [p.v, p.h]) {
      side.req = Object.fromEntries(Object.entries<any>(side.req).sort((a, b) => b[1][0] - a[1][0]));
      // Rates per hour spent in this state, so a hidden hour and a visible hour compare directly.
      const hrs = side.ms / 3600_000;
      side.perHour = hrs > 0 ? { req: Math.round(side.reqN / hrs), kb: Math.round(side.reqB / 1024 / hrs), sse: Math.round(side.sseN / hrs), ws: Math.round(side.wsN / hrs), wsKb: Math.round(side.wsB / 1024 / hrs), longMs: Math.round(side.longMs / hrs) } : null;
    }
  }
  const server = db.query("SELECT kind, SUM(n) AS n FROM server_events WHERE hour >= ? GROUP BY kind ORDER BY n DESC").all(new Date(from).toISOString().slice(0, 13));
  return { available: true, hours, pages, server, battery };
}
