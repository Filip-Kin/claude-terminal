// app-mem-skills.ts
// Read/edit the owner's Claude memory files and skills from the chat app's Settings panel.
// Kept in its own module (like app-mcp.ts) so app-server.ts gains only additive routes.
//
// EVERYTHING here is filesystem CRUD confined to ~/.claude. Two safety rails throughout:
//   1. every path is resolved and checked to sit UNDER an allowed root (no `..` escape, no
//      absolute path outside ~/.claude), and
//   2. every overwrite writes a timestamped .bak-<ts> beside the file first (read-then-edit).
//
// Memory lives at <dataDir>/<project>/memory/*.md (+ MEMORY.md index) and the global
// ~/.claude/CLAUDE.md. Skills live at ~/.claude/skills/<name>/SKILL.md. A skill is "disabled"
// by renaming its SKILL.md to SKILL.md.disabled, so the CLI's loader no longer sees it and a
// live reloadSkills() reflects it immediately — this leaves every OTHER skill (including plugin
// skills) untouched, which the SDK's allow-list `skills` option cannot do.

import { join, resolve, sep } from "path";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";

// #region path guard
// True only when `p` resolves to a location inside `root` (or is `root` itself). Blocks `..`
// traversal and absolute paths that point elsewhere.
function underRoot(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

// Resolve a client-supplied path and assert it lives under one of the allowed roots. Throws
// otherwise, so a route can 403 rather than touch anything outside ~/.claude.
function guarded(roots: string[], p: string): string {
  const t = resolve(p);
  if (!roots.some((r) => underRoot(r, t))) throw new Error("path outside ~/.claude");
  return t;
}
// #endregion

// #region config the routes pass in
export interface MemSkillCtx {
  dataDir: string; // ~/.claude/projects — memory files live under <dataDir>/<project>/memory
  claudeDir: string; // ~/.claude — for CLAUDE.md and the skills dir
}
const skillsRoot = (ctx: MemSkillCtx) => join(ctx.claudeDir, "skills");
const globalMemoryPath = (ctx: MemSkillCtx) => join(ctx.claudeDir, "CLAUDE.md");
// The roots any memory/skill path must fall under.
const roots = (ctx: MemSkillCtx) => [ctx.dataDir, ctx.claudeDir];
// #endregion

// #region shared: frontmatter + backup-before-write
function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const lines = m[1].split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim() || /^\s/.test(line)) continue; // blank, or a continuation already consumed below
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    let v = line.slice(i + 1).trim();
    // YAML block scalars: `>`/`>-`/`>+` fold onto one line, `|`/`|-`/`|+` keep the line breaks. Real
    // skills use these for long descriptions, and reading only the first line yielded the literal
    // ">-" as the description. Consume the following more-indented lines as the value.
    const block = /^([|>])([-+]?)$/.exec(v);
    if (block) {
      const body: string[] = [];
      while (n + 1 < lines.length && (!lines[n + 1].trim() || /^\s/.test(lines[n + 1]))) {
        body.push(lines[++n].trim());
      }
      while (body.length && !body[body.length - 1]) body.pop(); // drop trailing blanks
      v = block[1] === ">" ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n");
    } else {
      // A plain value may also continue on indented lines (YAML folds them with a space).
      while (n + 1 < lines.length && lines[n + 1].trim() && /^\s/.test(lines[n + 1])) {
        v += " " + lines[++n].trim();
      }
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// Timestamped backup name. The caller passes `now` (Bun/browser Date is fine server-side).
function backupName(path: string, now: number): string {
  return `${path}.bak-${now}`;
}

// Write `content` to `path`, first copying any existing file to a .bak-<ts>. Returns the backup
// path (or null if the file was new).
async function writeWithBackup(path: string, content: string): Promise<string | null> {
  let backup: string | null = null;
  const f = Bun.file(path);
  if (await f.exists()) {
    backup = backupName(path, Date.now());
    await Bun.write(backup, f);
  }
  await Bun.write(path, content);
  return backup;
}
// #endregion

// #region memory
export interface MemoryProject { id: string; label: string; files: { name: string; path: string; size: number }[] }

// A readable label for an encoded project dir name (`-home-filip-x` -> `/home/filip/x`).
function decodeProject(dir: string): string {
  return dir.replace(/^-/, "/").replace(/-/g, "/");
}

// List every project that has a memory/ dir with .md files, plus a synthetic "global" entry for
// ~/.claude/CLAUDE.md. Sorted by most recently modified memory dir first.
export function listMemory(ctx: MemSkillCtx): MemoryProject[] {
  const projects: (MemoryProject & { mtime: number })[] = [];
  // global CLAUDE.md
  const g = globalMemoryPath(ctx);
  try {
    const st = statSync(g);
    projects.push({ id: "__global__", label: "~/.claude/CLAUDE.md (global)", files: [{ name: "CLAUDE.md", path: g, size: st.size }], mtime: st.mtimeMs });
  } catch {}
  let dirs: string[] = [];
  try { dirs = readdirSync(ctx.dataDir); } catch { dirs = []; }
  for (const d of dirs) {
    const memDir = join(ctx.dataDir, d, "memory");
    let files: string[] = [];
    try { if (!statSync(memDir).isDirectory()) continue; files = readdirSync(memDir); } catch { continue; }
    const md = files.filter((f) => f.endsWith(".md"));
    if (!md.length) continue;
    let mtime = 0;
    const entries = md.map((name) => {
      const p = join(memDir, name);
      let size = 0; try { const st = statSync(p); size = st.size; mtime = Math.max(mtime, st.mtimeMs); } catch {}
      return { name, path: p, size };
    });
    // MEMORY.md index first, then alphabetical
    entries.sort((a, b) => (a.name === "MEMORY.md" ? -1 : b.name === "MEMORY.md" ? 1 : a.name.localeCompare(b.name)));
    projects.push({ id: d, label: decodeProject(d), files: entries, mtime });
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  return projects.map(({ mtime, ...p }) => p);
}

export async function readMemory(ctx: MemSkillCtx, path: string): Promise<{ content: string }> {
  const p = guarded(roots(ctx), path);
  if (!p.endsWith(".md")) throw new Error("only .md files");
  return { content: await Bun.file(p).text() };
}

export async function writeMemory(ctx: MemSkillCtx, path: string, content: string): Promise<{ backup: string | null }> {
  const p = guarded(roots(ctx), path);
  if (!p.endsWith(".md")) throw new Error("only .md files");
  // must be an existing CLAUDE.md, or a file inside some project's memory/ dir (block writing
  // arbitrary .md elsewhere under ~/.claude, e.g. into a plugin).
  const inMemoryDir = p.includes(`${sep}memory${sep}`);
  const isGlobal = p === globalMemoryPath(ctx);
  if (!inMemoryDir && !isGlobal) throw new Error("memory writes limited to a project memory/ dir or CLAUDE.md");
  return { backup: await writeWithBackup(p, content) };
}
// #endregion

// #region skills
export interface SkillRow { name: string; description: string; enabled: boolean; path: string }

// The active SKILL.md path and the disabled variant for a skill dir.
const skillFile = (dir: string) => join(dir, "SKILL.md");
const skillFileDisabled = (dir: string) => join(dir, "SKILL.md.disabled");

// Resolve a skill by name to its dir + whichever SKILL file exists. Guards the name (no path
// separators) and confirms the dir sits under the skills root.
function resolveSkill(ctx: MemSkillCtx, name: string): { dir: string; file: string | null; enabled: boolean } {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name === "." || name === "..") throw new Error("bad skill name");
  const dir = join(skillsRoot(ctx), name);
  guarded([skillsRoot(ctx)], dir);
  const active = skillFile(dir);
  const disabled = skillFileDisabled(dir);
  if (existsSync(active)) return { dir, file: active, enabled: true };
  if (existsSync(disabled)) return { dir, file: disabled, enabled: false };
  return { dir, file: null, enabled: false };
}

export function listSkills(ctx: MemSkillCtx): SkillRow[] {
  const root = skillsRoot(ctx);
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  const rows: SkillRow[] = [];
  for (const name of dirs) {
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const active = skillFile(dir), disabled = skillFileDisabled(dir);
    const file = existsSync(active) ? active : existsSync(disabled) ? disabled : null;
    if (!file) continue;
    let fm: Record<string, string> = {};
    try { fm = frontmatter(readFileSync(file, "utf8")); } catch {}
    rows.push({ name, description: fm.description || "", enabled: file === active, path: file });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export async function readSkill(ctx: MemSkillCtx, name: string): Promise<{ content: string; enabled: boolean }> {
  const s = resolveSkill(ctx, name);
  if (!s.file) throw new Error("skill not found");
  return { content: await Bun.file(s.file).text(), enabled: s.enabled };
}

// Create or overwrite a skill's SKILL.md. Creating makes the dir; overwriting backs up first and
// writes to whichever variant exists (so editing a disabled skill keeps it disabled).
export async function writeSkill(ctx: MemSkillCtx, name: string, content: string, create: boolean): Promise<{ backup: string | null; created: boolean }> {
  const s = resolveSkill(ctx, name);
  if (s.file) return { backup: await writeWithBackup(s.file, content), created: false };
  if (!create) throw new Error("skill not found (pass create:true to make it)");
  const target = skillFile(s.dir);
  guarded([skillsRoot(ctx)], target);
  await Bun.write(target, content); // Bun.write makes parent dirs
  return { backup: null, created: true };
}

// Enable/disable by renaming SKILL.md <-> SKILL.md.disabled. Idempotent.
export async function setSkillEnabled(ctx: MemSkillCtx, name: string, enabled: boolean): Promise<{ enabled: boolean }> {
  const s = resolveSkill(ctx, name);
  if (!s.file) throw new Error("skill not found");
  const active = skillFile(s.dir), disabled = skillFileDisabled(s.dir);
  const { rename } = await import("fs/promises");
  if (enabled && !s.enabled) await rename(disabled, active);
  else if (!enabled && s.enabled) await rename(active, disabled);
  return { enabled };
}
// #endregion
