// Cloud cost-split report. Reads cloud_cost.db (written by cost-collector.ts) and
// turns accumulated per-bucket RAM/CPU resource-seconds into each "fake user"
// bucket's proportional slice of the fixed monthly droplet bill. Kept in its own
// module so the cost feature stays separate from the token-usage server code; the
// server just calls buildCostReport(cfg) and serves the JSON at /usage/cost/api.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openCostDb } from "./cost-db.ts";

const HOST = "cloud";
const pad = (n: number) => String(n).padStart(2, "0");
function monthLabel(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Largest-remainder split of `pot` cents by each bucket's weight (matches the token
// bill split in server.ts, so the money always adds up to the pot exactly).
function splitCents(weights: Record<string, number>, pot: number): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const cents: Record<string, number> = {};
  if (total <= 0 || pot <= 0) { for (const k in weights) cents[k] = 0; return cents; }
  const exact: Record<string, number> = {};
  for (const k in weights) { exact[k] = (pot * weights[k]) / total; cents[k] = Math.floor(exact[k]); }
  let leftover = pot - Object.values(cents).reduce((a, b) => a + b, 0);
  const order = Object.keys(exact).sort((a, b) => (exact[b] - cents[b]) - (exact[a] - cents[a]));
  for (let i = 0; i < leftover && i < order.length; i++) cents[order[i]]++;
  return cents;
}

export function buildCostReport(cfg: any): any {
  const dbPath: string = cfg.cloudCostDb || join(String(cfg.db).replace(/[^/]+$/, ""), "cloud_cost.db");
  if (!cfg.cloudHost || !existsSync(dbPath)) {
    return { available: false, reason: cfg.cloudHost ? "no samples yet" : "not configured" };
  }
  const monthlyUsd = Number(cfg.dropletMonthlyUsd ?? 60);
  const wRam = Number(cfg.costRamWeight ?? 0.5);
  const wCpu = Number(cfg.costCpuWeight ?? 0.5);
  const wSum = wRam + wCpu || 1;
  const colors: Record<string, string> = cfg.costColors || {};
  const pot = Math.round(monthlyUsd * 100);

  const db = openCostDb(dbPath, true);
  try {
    const meta = (k: string): string | null => {
      const r = db.query("SELECT value FROM cost_meta WHERE key = ?").get(k) as any;
      return r ? r.value : null;
    };
    const memBytes = Number(meta(`droplet_mem_bytes:${HOST}`) || 0);
    const vcpus = Number(meta(`droplet_vcpus:${HOST}`) || 0);
    const lastSeen = meta(`last_seen:${HOST}`);

    const now = new Date();
    const curMonth = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;

    const monthsRows = db.query("SELECT DISTINCT month FROM resource_usage WHERE host = ? ORDER BY month").all(HOST) as any[];
    const rows = db.query(
      `SELECT month, bucket, bucket_name, team_id, name, ram_byte_seconds, cpu_core_seconds, wall_seconds,
              last_ram_bytes, last_cpu_cores, last_seen
       FROM resource_usage WHERE host = ?`,
    ).all(HOST) as any[];

    const months: any[] = [];
    for (const { month } of monthsRows) {
      const mRows = rows.filter((r) => r.month === month);
      const wallSpan = (Number(meta(`month_end:${HOST}:${month}`) || 0) - Number(meta(`month_start:${HOST}:${month}`) || 0)) / 1000 || 1;

      // Aggregate resources into buckets.
      const buckets = new Map<string, any>();
      for (const r of mRows) {
        let b = buckets.get(r.bucket);
        if (!b) { b = { bucket: r.bucket, name: r.bucket_name, team_id: r.team_id, ram: 0, cpu: 0, last_ram: 0, last_cpu: 0, resources: [] as any[] }; buckets.set(r.bucket, b); }
        b.name = r.bucket_name; // freshest label
        b.ram += r.ram_byte_seconds;
        b.cpu += r.cpu_core_seconds;
        b.last_ram += r.last_ram_bytes;
        b.last_cpu += r.last_cpu_cores;
        b.resources.push({ name: r.name, avg_ram_bytes: r.ram_byte_seconds / (r.wall_seconds || 1), avg_cpu_cores: r.cpu_core_seconds / (r.wall_seconds || 1), last_ram_bytes: r.last_ram_bytes });
      }

      const totalRam = [...buckets.values()].reduce((a, b) => a + b.ram, 0) || 1;
      const totalCpu = [...buckets.values()].reduce((a, b) => a + b.cpu, 0) || 1;
      const weights: Record<string, number> = {};
      for (const b of buckets.values()) {
        b.ram_frac = b.ram / totalRam;
        b.cpu_frac = b.cpu / totalCpu;
        weights[b.bucket] = (wRam * b.ram_frac + wCpu * b.cpu_frac) / wSum;
      }
      const cents = splitCents(weights, pot);

      const list = [...buckets.values()].map((b) => {
        b.resources.sort((x: any, y: any) => y.avg_ram_bytes - x.avg_ram_bytes);
        return {
          bucket: b.bucket,
          name: b.name,
          team_id: b.team_id,
          color: colors[b.bucket] || null,
          avg_ram_bytes: b.ram / wallSpan,
          avg_cpu_cores: b.cpu / wallSpan,
          ram_pct: Math.round(1000 * b.ram_frac) / 10,
          cpu_pct: Math.round(1000 * b.cpu_frac) / 10,
          weight_pct: Math.round(1000 * weights[b.bucket]) / 10,
          share_usd: cents[b.bucket] / 100,
          last_ram_bytes: b.last_ram,
          last_cpu_cores: b.last_cpu,
          resources: b.resources.slice(0, 6),
        };
      });
      list.sort((a, b) => b.share_usd - a.share_usd || b.avg_ram_bytes - a.avg_ram_bytes);
      months.push({
        key: month,
        label: monthLabel(month),
        buckets: list,
        avg_ram_bytes: [...buckets.values()].reduce((a, b) => a + b.ram, 0) / wallSpan,
        avg_cpu_cores: [...buckets.values()].reduce((a, b) => a + b.cpu, 0) / wallSpan,
      });
    }

    // "Right now" totals: only resources present in the freshest sample. Summing every
    // current-month resource's last_* folds in containers that have since stopped (their
    // stale last-known RAM/CPU lingers in the row), which pushed the totals past 100%
    // (e.g. RAM 112%, CPU 154%). Every resource written by the same accumulate() call
    // shares the host's last_seen timestamp; anything older stopped before it, so match
    // on last_seen to keep just the live set.
    const live = lastSeen ? rows.filter((r) => r.month === curMonth && r.last_seen === lastSeen) : [];
    const liveRam = live.reduce((a: number, r: any) => a + r.last_ram_bytes, 0);
    const liveCpu = live.reduce((a: number, r: any) => a + r.last_cpu_cores, 0);

    return {
      available: months.length > 0,
      generated_at: now.toISOString().replace(/\.\d+Z$/, "+00:00"),
      current_month: curMonth,
      droplet: {
        desc: cfg.dropletDesc || "DigitalOcean droplet",
        monthly_usd: monthlyUsd,
        note: cfg.dropletNote || null,
        mem_bytes: memBytes,
        vcpus,
        last_seen: lastSeen,
      },
      ram_weight: wRam / wSum,
      cpu_weight: wCpu / wSum,
      live: {
        ram_bytes: liveRam,
        cpu_cores: liveCpu,
        mem_used_pct: memBytes ? Math.round((1000 * liveRam) / memBytes) / 10 : null,
        cpu_used_pct: vcpus ? Math.round((1000 * liveCpu) / vcpus) / 10 : null,
      },
      months,
    };
  } finally {
    db.close();
  }
}
