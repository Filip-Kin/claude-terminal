// External-peer collector: pull usage from OTHER claude-terminal instances and store
// it locally so it can be shown on this instance's board. A peer is a friend who runs
// their own copy of this app and exposes GET /usage/export (see server.ts), gated by a
// shared token. We fetch that snapshot and REPLACE the peer's rows in the external_*
// tables, so values are absolute (never double-counted) and a peer that goes offline
// just keeps its last snapshot until it comes back.
//
// Peers are deliberately kept OUT of the money split (server.ts flags them `external`
// and gives them no share_usd). This module only ingests; it never touches the local
// collector's offset/delta bookkeeping.
//
// Configured via config.json -> externalPeers: [{ name, url, token }]. No-ops when the
// list is absent or empty, so a vanilla install is unaffected.
import { openDb } from "./db.ts";

type Peer = { name?: string; url?: string; token?: string };

export async function sampleExternalPeers(configPath: string): Promise<void> {
  const cfg = JSON.parse(await Bun.file(configPath).text());
  const peers: Peer[] = Array.isArray(cfg.externalPeers) ? cfg.externalPeers : [];
  if (!peers.length) return;

  const db = openDb(cfg.db); // writable handle; also ensures the external_* tables exist
  const delCum = db.prepare("DELETE FROM external_cum WHERE peer = ?");
  const delHours = db.prepare("DELETE FROM external_hourly WHERE peer = ?");
  const delMeta = db.prepare("DELETE FROM external_meta WHERE peer = ?");
  const insCum = db.prepare(
    `INSERT INTO external_cum (peer, user, name, input, output, cache_creation, cache_read, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insHours = db.prepare(
    "INSERT OR REPLACE INTO external_hourly (peer, user, hour_utc, total, output) VALUES (?, ?, ?, ?, ?)",
  );
  const insMeta = db.prepare(
    `INSERT INTO external_meta (peer, user, sessions, models, last_activity, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const num = (v: any) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);

  for (const p of peers) {
    if (!p?.url) continue;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (p.token) headers.Authorization = `Bearer ${p.token}`;
      const res = await fetch(p.url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.error(`external peer ${p.name || p.url}: HTTP ${res.status}`);
        continue;
      }
      const data: any = await res.json();
      const peerName = p.name || data?.peer;
      if (!peerName) { console.error(`external peer ${p.url}: no name`); continue; }
      const exportUsers: any[] = Array.isArray(data?.users) ? data.users : [];
      const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

      const tx = db.transaction(() => {
        delCum.run(peerName);
        delHours.run(peerName);
        delMeta.run(peerName);
        for (const u of exportUsers) {
          const user = String(u?.user || "").trim();
          if (!user) continue;
          const c = u.cumulative || {};
          insCum.run(
            peerName, user, String(u.name || user),
            num(c.input), num(c.output), num(c.cache_creation), num(c.cache_read), num(c.total),
          );
          const m = u.meta || {};
          const models = typeof m.models === "string" ? m.models : JSON.stringify(m.models || []);
          insMeta.run(peerName, user, num(m.sessions), models, m.last_activity || null, fetchedAt);
          for (const h of Array.isArray(u.hourly) ? u.hourly : []) {
            if (!h?.hour_utc) continue;
            insHours.run(peerName, user, String(h.hour_utc), num(h.total), num(h.output));
          }
        }
      });
      tx();
      console.log(`external peer ${peerName}: ${exportUsers.length} user(s) synced`);
    } catch (e) {
      console.error(`external peer ${p.name || p.url} sample failed:`, e);
    }
  }

  db.close();
}
