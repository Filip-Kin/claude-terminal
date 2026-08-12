// Cloud cost-split sampler. Runs on the NAS (as root, so it can `ssh root@<cloud>`),
// takes one snapshot of the DigitalOcean droplet's `docker stats` plus the Coolify
// project/team map, attributes each container to a "fake user" bucket (a Coolify
// project, a guest, or system/infra), and accumulates time-integrated RAM and CPU
// per bucket into cloud_cost.db. The dashboard turns those resource-seconds into
// each bucket's proportional slice of the fixed monthly droplet bill.
//
// One SSH round trip per sample gathers everything (capacity + stats + map + teams).
// A sampling failure is non-fatal by design: this is invoked from the end of the
// usage collector, and must never disturb token-usage collection if the cloud is
// briefly unreachable.
//
// Run standalone for a one-off sample / testing: `bun run cost-collector.ts [configPath]`.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openCostDb } from "./cost-db.ts";

type CostCfg = {
  owner?: string;
  names?: Record<string, string>;
  db: string;
  cloudCostDb?: string;
  cloudHost?: string;
  collectSeconds?: number;
  costSampleClampSeconds?: number;
  costOwnerTeam?: number;
  // owner-team Coolify projects (by id or name) to keep as their own bucket; every
  // other owner project folds into the single owner bucket. [] = merge everything.
  costSeparateProjects?: (number | string)[];
  port?: number;
};

// #region remote sampling
// The union covers every Coolify resource type that maps through project ->
// environment (standalone_dockers has no environment_id, so it is excluded).
const REMOTE_SCRIPT = `
echo '===CAP==='
nproc
grep MemTotal /proc/meminfo | awk '{print $2}'
echo '===STATS==='
docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}'
echo '===MAP==='
docker exec coolify-db psql -U coolify -t -A -F'|' -c "select x.uuid, x.name, p.id, p.name, p.team_id from (select a.uuid, a.name, a.environment_id from applications a union all select s.uuid, s.name, s.environment_id from services s union all select d.uuid, d.name, d.environment_id from standalone_postgresqls d union all select d.uuid, d.name, d.environment_id from standalone_mongodbs d union all select d.uuid, d.name, d.environment_id from standalone_redis d union all select d.uuid, d.name, d.environment_id from standalone_mysqls d union all select d.uuid, d.name, d.environment_id from standalone_mariadbs d union all select d.uuid, d.name, d.environment_id from standalone_keydbs d union all select d.uuid, d.name, d.environment_id from standalone_dragonflies d union all select d.uuid, d.name, d.environment_id from standalone_clickhouses d) x join environments e on e.id=x.environment_id join projects p on p.id=e.project_id"
echo '===TEAMS==='
docker exec coolify-db psql -U coolify -t -A -F'|' -c "select tu.team_id, u.name from team_user tu join users u on u.id=tu.user_id order by tu.team_id, tu.user_id"
echo '===END==='
`;

async function sshSample(host: string, timeoutMs = 45000): Promise<string | null> {
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", host, REMOTE_SCRIPT],
    { stdout: "pipe", stderr: "pipe" },
  );
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (!out.includes("===END===")) {
      const err = (await new Response(proc.stderr).text()).trim();
      console.error("cost sample: incomplete output" + (err ? `: ${err.slice(0, 300)}` : ""));
      return null;
    }
    return out;
  } finally {
    clearTimeout(killer);
  }
}

// "49.32MiB / 7.755GiB" -> bytes used (the part before the slash).
function parseBytes(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMGTP]?i?B)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  const mul: Record<string, number> = {
    b: 1,
    kib: 1024, kb: 1000,
    mib: 1024 ** 2, mb: 1000 ** 2,
    gib: 1024 ** 3, gb: 1000 ** 3,
    tib: 1024 ** 4, tb: 1000 ** 4,
    pib: 1024 ** 5, pb: 1000 ** 5,
  };
  return n * (mul[u] ?? 1);
}

type Sample = {
  vcpus: number;
  memBytes: number;
  containers: { name: string; bytes: number; cores: number }[];
  resources: Map<string, { name: string; projId: number; projName: string; teamId: number }>;
  teamNames: Map<number, string>;
};

function parseSample(out: string): Sample | null {
  const sec: Record<string, string[]> = { CAP: [], STATS: [], MAP: [], TEAMS: [] };
  let cur = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^===(\w+)===$/);
    if (m) { cur = m[1] === "END" ? "" : m[1]; continue; }
    if (cur && sec[cur] && line.length) sec[cur].push(line);
  }
  const vcpus = parseInt(sec.CAP[0] || "0", 10) || 0;
  const memBytes = (parseInt(sec.CAP[1] || "0", 10) || 0) * 1024; // MemTotal is in kB
  const containers = sec.STATS.map((l) => {
    const [name, mem, cpu] = l.split("|");
    return { name, bytes: parseBytes((mem || "").split("/")[0] || ""), cores: (parseFloat(cpu) || 0) / 100 };
  }).filter((c) => c.name);
  const resources = new Map<string, { name: string; projId: number; projName: string; teamId: number }>();
  for (const l of sec.MAP) {
    const [uuid, name, projId, projName, teamId] = l.split("|");
    if (uuid) resources.set(uuid, { name: name || uuid, projId: parseInt(projId, 10), projName: projName || "Project", teamId: parseInt(teamId, 10) });
  }
  const teamNames = new Map<number, string>();
  for (const l of sec.TEAMS) {
    const [teamId, name] = l.split("|");
    if (teamId && !teamNames.has(parseInt(teamId, 10))) teamNames.set(parseInt(teamId, 10), name || `Team ${teamId}`);
  }
  if (!containers.length || !resources.size) return null;
  return { vcpus, memBytes, containers, resources, teamNames };
}
// #endregion

// #region attribution: container -> resource -> bucket
const INFRA_NAMES = new Set(["glances"]);
function isInfra(name: string): boolean {
  return name.startsWith("coolify") || INFRA_NAMES.has(name);
}

// The docker container name is one of <uuid>, <uuid>-<n>, <prefix>-<uuid>-<n>,
// <uuid>-proxy. Split on '-' and return the first token that is a known resource uuid.
function matchUuid(name: string, known: Set<string>): string | null {
  for (const tok of name.split("-")) if (known.has(tok)) return tok;
  return null;
}

type Bucket = { bucket: string; bucketName: string; teamId: number | null };
type BucketOpts = {
  ownerTeam: number;
  ownerName: string;
  // Owner-team projects to keep as their own bucket (e.g. FTA Buddy, The Orange
  // Alliance). Everything else the owner runs folds into the single owner bucket.
  separateIds: Set<number>;
  separateNames: Set<string>;
  teamNames: Map<number, string>;
};
function bucketFor(
  res: { name: string; projId: number; projName: string; teamId: number } | undefined,
  containerName: string,
  o: BucketOpts,
): Bucket {
  if (res) {
    if (res.teamId === o.ownerTeam) {
      const separate = o.separateIds.has(res.projId) || o.separateNames.has(res.projName.toLowerCase());
      if (separate) return { bucket: `proj:${res.projId}`, bucketName: res.projName, teamId: res.teamId };
      // the owner's standard usage: all their other projects under one name
      return { bucket: "owner", bucketName: o.ownerName, teamId: res.teamId };
    }
    // guest team: one bucket per guest person (their project is just "sandbox")
    return { bucket: `guest:${res.teamId}`, bucketName: o.teamNames.get(res.teamId) || res.projName, teamId: res.teamId };
  }
  if (isInfra(containerName)) return { bucket: "system", bucketName: "System / infra", teamId: null };
  return { bucket: "unattributed", bucketName: "Unattributed", teamId: null };
}
// #endregion

// #region accumulate into cloud_cost.db
function utcMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function metaGet(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM cost_meta WHERE key = ?").get(key) as any;
  return r ? r.value : null;
}

function accumulate(db: Database, host: string, s: Sample, opts: BucketOpts, intervalSec: number): void {
  const now = new Date();
  const month = utcMonth(now);
  const nowIso = now.toISOString().replace(/\.\d+Z$/, "+00:00");
  const known = new Set(s.resources.keys());

  // Roll containers up to their resource key, summing replicas + proxy sidecars,
  // so each Coolify resource is one accumulator row.
  type Agg = { bucket: string; bucketName: string; teamId: number | null; name: string; bytes: number; cores: number };
  const agg = new Map<string, Agg>();
  for (const c of s.containers) {
    const uuid = matchUuid(c.name, known);
    const res = uuid ? s.resources.get(uuid) : undefined;
    const rkey = uuid ?? c.name;
    const b = bucketFor(res, c.name, opts);
    const name = res ? res.name : c.name;
    const a = agg.get(rkey);
    if (a) { a.bytes += c.bytes; a.cores += c.cores; }
    else agg.set(rkey, { ...b, name, bytes: c.bytes, cores: c.cores });
  }

  const up = db.prepare(`
    INSERT INTO resource_usage
      (host, rkey, month, bucket, bucket_name, team_id, name, ram_byte_seconds, cpu_core_seconds, wall_seconds, samples, last_ram_bytes, last_cpu_cores, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(host, rkey, month) DO UPDATE SET
      bucket=excluded.bucket, bucket_name=excluded.bucket_name, team_id=excluded.team_id, name=excluded.name,
      ram_byte_seconds=ram_byte_seconds+excluded.ram_byte_seconds,
      cpu_core_seconds=cpu_core_seconds+excluded.cpu_core_seconds,
      wall_seconds=wall_seconds+excluded.wall_seconds,
      samples=samples+1,
      last_ram_bytes=excluded.last_ram_bytes, last_cpu_cores=excluded.last_cpu_cores, last_seen=excluded.last_seen
  `);
  const setMeta = db.prepare("INSERT INTO cost_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");

  const tx = db.transaction(() => {
    for (const [rkey, a] of agg) {
      up.run(host, rkey, month, a.bucket, a.bucketName, a.teamId, a.name,
        a.bytes * intervalSec, a.cores * intervalSec, intervalSec, a.bytes, a.cores, nowIso);
    }
    setMeta.run(`last_sample_at:${host}`, String(now.getTime()));
    setMeta.run(`droplet_mem_bytes:${host}`, String(s.memBytes));
    setMeta.run(`droplet_vcpus:${host}`, String(s.vcpus));
    setMeta.run(`last_seen:${host}`, nowIso);
    if (!metaGet(db, `month_start:${host}:${month}`)) setMeta.run(`month_start:${host}:${month}`, String(now.getTime()));
    setMeta.run(`month_end:${host}:${month}`, String(now.getTime()));
  });
  tx();
}
// #endregion

export async function sampleCloudCost(configPath: string): Promise<boolean> {
  const cfg: CostCfg = JSON.parse(await Bun.file(configPath).text());
  const host = cfg.cloudHost;
  if (!host) return false; // feature off unless a cloud host is configured
  const dbPath = cfg.cloudCostDb || join(cfg.db.replace(/[^/]+$/, ""), "cloud_cost.db");
  const nominal = cfg.collectSeconds || 60;
  const clamp = cfg.costSampleClampSeconds || Math.max(nominal * 2, 150);
  const ownerTeam = cfg.costOwnerTeam ?? 0;
  const owner = cfg.owner || "me";
  const ownerName = cfg.names?.[owner] || owner.charAt(0).toUpperCase() + owner.slice(1);
  const sep = cfg.costSeparateProjects || [];
  const opts: BucketOpts = {
    ownerTeam,
    ownerName,
    separateIds: new Set(sep.filter((x): x is number => typeof x === "number")),
    separateNames: new Set(sep.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())),
    teamNames: new Map(),
  };

  const out = await sshSample(host);
  if (!out) return false;
  const sample = parseSample(out);
  if (!sample) { console.error("cost sample: could not parse stats/map"); return false; }
  opts.teamNames = sample.teamNames;

  const db = openCostDb(dbPath);
  try {
    // The interval only scales absolute resource-seconds; the split is a ratio so it
    // cancels out. Using real elapsed time (clamped) keeps the displayed averages honest
    // and avoids counting a long collector outage as continuous usage.
    const last = Number(metaGet(db, `last_sample_at:cloud`) || 0);
    let interval = last ? (Date.now() - last) / 1000 : nominal;
    if (!(interval > 0) || interval > clamp) interval = Math.min(nominal, clamp);
    accumulate(db, "cloud", sample, opts, interval);
  } finally {
    db.close();
  }

  // Nudge any open dashboard to refetch (same tick channel the usage collector uses).
  try { await fetch(`http://127.0.0.1:${cfg.port || 7682}/internal/tick`, { method: "POST" }); } catch {}
  return true;
}

// Standalone entrypoint (one sample) for testing.
if (import.meta.main) {
  const configPath = process.argv[2] || join(import.meta.dir, "config.json");
  const ok = await sampleCloudCost(configPath);
  console.log(ok ? "cost sample: ok" : "cost sample: skipped/failed");
}
