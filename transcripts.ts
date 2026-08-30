// Shared transcript enumeration for the collectors. Extracted from collector.ts so a second
// pass (model-collector.ts) can walk exactly the same set of files with exactly the same
// nested-directory rules, instead of keeping a second copy of them that can drift.
//
// The nested rule matters: some tracked users' project dirs live UNDER another user's dataDir
// (stonkbot and sleeper both sit inside filip's ~/.claude/projects). Their transcripts must be
// counted as those users, not as the owner, so the owner's walk excludes them.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CollectorConfig {
  owner: string;
  dataDir: string;
  extraUsers?: Record<string, string[]>;
}

export function trackedUsers(cfg: CollectorConfig): string[] {
  return [cfg.owner, ...Object.keys(cfg.extraUsers || {})];
}

export function projDirs(cfg: CollectorConfig, user: string): string[] {
  if (user === cfg.owner) return [cfg.dataDir];
  return (cfg.extraUsers || {})[user] || [];
}

export function hourKey(iso: string): string {
  let d = new Date(iso);
  if (isNaN(d.getTime())) d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}`;
}

// Minute bucket, for the per-model split. Hour buckets are too coarse to attribute tokens to a
// rate-limit window: a window boundary falling mid-hour throws a whole hour in or out, which on
// a 5h window is enough error to swamp the model-mix signal being measured.
export function minuteKey(iso: string): string {
  let d = new Date(iso);
  if (isNaN(d.getTime())) d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

// recursively list *.jsonl under a dir (absolute paths)
export function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// Every transcript belonging to `user`: each of their project dirs walked in turn, sorted within
// the dir, with any other tracked user's nested dir removed. Identical to the enumeration
// collector.ts did inline before this was extracted, including the resulting file count.
export function userTranscripts(cfg: CollectorConfig, user: string): string[] {
  const others = trackedUsers(cfg).filter((u) => u !== user);
  const files: string[] = [];

  for (const proj of projDirs(cfg, user)) {
    let isDir = false;
    try {
      isDir = statSync(proj).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const nested: string[] = [];
    for (const u2 of others) {
      for (const d of projDirs(cfg, u2)) {
        if (d !== proj && d.startsWith(proj.endsWith("/") ? proj : proj + "/")) nested.push(d);
      }
    }
    const underNested = (f: string) => nested.some((n) => f.startsWith(n.endsWith("/") ? n : n + "/"));

    for (const f of walkJsonl(proj).filter((f) => !underNested(f)).sort()) files.push(f);
  }
  return files;
}
