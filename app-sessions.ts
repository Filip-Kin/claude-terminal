// Which SDK transcripts are /app chats: the stored id list, seeded from every existing transcript
// when there is no usable list. Kept apart from app-server.ts so it loads without the runner.
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

function allTranscriptIds(dataDir: string): string[] {
  const ids: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(dataDir); } catch (e) { console.error("[app-sessions] seed: cannot read", dataDir, e); return ids; }
  for (const project of projects) {
    let files: string[] = [];
    try { files = readdirSync(join(dataDir, project)); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) ids.push(f.slice(0, -6));
  }
  return ids;
}

// No file (a new user, a guest, a lost file) or a corrupt one = seed it with every transcript that
// exists now, so a user's past chats always show. Only SDK runs that start after the seed and not
// from /app are hidden (Filip 2026-11-19: guests lost every chat when the list started empty).
export function readOrSeedAppSessions(file: string, dataDir: string): Set<string> {
  let raw: string | null = null;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[app-sessions] read failed:", e); }
  if (raw !== null) {
    try {
      const a: unknown = JSON.parse(raw);
      if (Array.isArray(a)) return new Set(a.map(String));
      console.error("[app-sessions] not an array, reseeding");
    } catch (e) { console.error("[app-sessions] parse failed, reseeding:", e); }
  }
  const s = new Set(allTranscriptIds(dataDir));
  try { writeFileSync(file, JSON.stringify([...s])); console.log(`[app-sessions] seeded ${s.size} ids`); }
  catch (e) { console.error("[app-sessions] seed write failed:", e); }
  return s;
}
