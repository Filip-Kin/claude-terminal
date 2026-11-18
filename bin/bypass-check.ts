// bypass-check.ts — prove the agent SDK installed next to this file still runs tools under
// bypassPermissions with no prompt. Used by ct-auto-update before and after an SDK bump.
//
// Copy (or run) this file from a directory whose node_modules holds the SDK under test: bun
// resolves the import from the script's own location, so the scratch copy tests the NEW SDK
// while the service keeps running the old one.
//
// Usage: bun run bypass-check.ts <scratch-dir>
// Exit 0 + "BYPASS_OK <cli-version>" when Bash ran, the marker file exists and nothing was denied.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: bypass-check.ts <scratch-dir>"); process.exit(2); }
const marker = join(dir, "bypass-ok");
rmSync(marker, { force: true });

let version = "?", mode = "?", denials = -1, subtype = "?";
const q = query({
  prompt: `Run exactly this bash command and reply only with its output: touch ${marker} && echo BYPASS_OK`,
  options: { cwd: dir, model: "haiku", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, persistSession: false } as any,
});
const timer = setTimeout(() => { console.error("BYPASS_FAIL timeout"); process.exit(1); }, 120_000);
for await (const m of q as any) {
  if (m.type === "system" && m.subtype === "init") { version = m.claude_code_version; mode = m.permissionMode; }
  if (m.type === "result") { subtype = m.subtype; denials = m.permission_denials?.length ?? 0; }
}
clearTimeout(timer);
const ok = mode === "bypassPermissions" && subtype === "success" && denials === 0 && existsSync(marker);
console.log(`${ok ? "BYPASS_OK" : "BYPASS_FAIL"} ${version} mode=${mode} result=${subtype} denials=${denials} marker=${existsSync(marker)}`);
rmSync(marker, { force: true });
process.exit(ok ? 0 : 1);
