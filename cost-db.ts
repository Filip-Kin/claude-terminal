import { Database } from "bun:sqlite";

// Schema for the cloud cost-split feature. Lives in its own SQLite file
// (cloud_cost.db, sibling to usage.db) so it stays fully separate from the
// Claude token-usage tracking. cost-collector.ts writes it (root, since it SSHes
// to the cloud host); server.ts reads it read-only.
//
// resource_usage accumulates, per (resource, UTC month), the time-integrated
// RAM and CPU a container drew on the DigitalOcean droplet. A "resource" is a
// Coolify app/service/database, keyed by its uuid; several docker containers
// (main + <uuid>-proxy, replicas) roll up to the same uuid. Infra containers
// with no uuid (coolify*, glances) key on their container name.
//
// The bucket is the "fake user" a resource is billed to: a Coolify project for
// the owner's team (FTA Buddy, The Orange Alliance, Personal, ...), the guest's
// person for guest teams, or the system/unattributed catch-alls.
export const COST_SCHEMA = `
CREATE TABLE IF NOT EXISTS resource_usage (
  host             TEXT NOT NULL DEFAULT 'cloud',  -- which server drew the resources
  rkey             TEXT NOT NULL,   -- uuid (matched) or container base name (infra)
  month            TEXT NOT NULL,   -- 'YYYY-MM' (UTC)
  bucket           TEXT NOT NULL,   -- 'proj:<id>' | 'guest:<team>' | 'system' | 'unattributed'
  bucket_name      TEXT NOT NULL,   -- display name for the bucket
  team_id          INTEGER,         -- owning Coolify team, null for infra/unattributed
  name             TEXT NOT NULL,   -- resource display name (or container name)
  ram_byte_seconds REAL NOT NULL DEFAULT 0,
  cpu_core_seconds REAL NOT NULL DEFAULT 0,
  wall_seconds     REAL NOT NULL DEFAULT 0,  -- seconds this resource was observed running
  samples          INTEGER NOT NULL DEFAULT 0,
  last_ram_bytes   REAL NOT NULL DEFAULT 0,  -- most recent sample, for a "right now" view
  last_cpu_cores   REAL NOT NULL DEFAULT 0,
  last_seen        TEXT,
  PRIMARY KEY (host, rkey, month)
);
CREATE INDEX IF NOT EXISTS idx_resource_usage_month ON resource_usage(host, month);

-- small key/value store: last_sample_at, per-month first/last sample timestamps,
-- droplet capacity snapshot (mem_bytes, vcpus), etc.
CREATE TABLE IF NOT EXISTS cost_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openCostDb(path: string, readonly = false): Database {
  const db = new Database(path, readonly ? { readonly: true } : { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(COST_SCHEMA);
  }
  return db;
}
