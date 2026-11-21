// 2026-11-21: claude-spawn started a terminal tab in tmux, and the chat page then ran the same
// session in a second process. claude-spawn must start nothing itself: it asks the server.
import { test, expect } from "bun:test";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "bin", "claude-spawn");
type Body = Record<string, unknown>;

async function run(args: string[], reply: (body: Body) => Response, stdin?: string) {
  const seen: { path: string; user: string | null; body: Body }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Body;
      seen.push({ path: new URL(req.url).pathname, user: req.headers.get("remote-user"), body });
      return reply(body);
    },
  });
  try {
    const proc = Bun.spawn(["bash", SCRIPT, ...args], {
      env: { PATH: process.env.PATH || "", HOME: "/nonexistent", CT_SPAWN_URL: `http://127.0.0.1:${server.port}/sessions/spawn`, CT_OWNER: "filip", TMUX_TMPDIR: "/nonexistent" },
      stdin: stdin === undefined ? "ignore" : new Response(stdin), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { out, err, code, seen };
  } finally { server.stop(true); }
}
const ok = (b: Body) => Response.json({ id: b.name || "spawn-120509-1", sessionId: "c83867b9-f998-46ac-b076-cdd0686105fb" });

test("posts the brief to the server and prints only the name", async () => {
  const brief = 'You are the ORCHESTRATOR "of" $HOME\nline two';
  const r = await run(["--prompt", brief, "--name", "coc-overhaul", "--cwd", "/tmp", "--model", "opus"], ok);
  expect(r.code).toBe(0);
  expect(r.out).toBe("coc-overhaul\n");
  expect(r.seen).toEqual([{ path: "/sessions/spawn", user: "filip", body: { prompt: brief, cwd: "/tmp", name: "coc-overhaul", model: "opus" } }]);
});

test("prompt from stdin, no name: the server's generated name is printed", async () => {
  const r = await run(["--prompt-file", "-", "--cwd", "/tmp"], ok, "long brief\n");
  expect(r.code).toBe(0);
  expect(r.out).toBe("spawn-120509-1\n");
  expect(r.seen[0].body).toEqual({ prompt: "long brief", cwd: "/tmp" });
});

test("a refusal by the server is an error with its reason, and nothing is printed", async () => {
  const r = await run(["--prompt", "x", "--cwd", "/tmp"], () => new Response("cwd is not a directory: /gone", { status: 400 }));
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toContain("spawn refused (HTTP 400): cwd is not a directory: /gone");
});

test("a server that started a terminal tab instead (no sessionId) is an error", async () => {
  const r = await run(["--prompt", "x", "--cwd", "/tmp"], () => Response.json({ id: "spawn-1" }));
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
});

test("no prompt, a missing cwd: refused before any request", async () => {
  const a = await run(["--cwd", "/tmp"], ok);
  expect(a.code).toBe(1);
  expect(a.seen).toEqual([]);
  const b = await run(["--prompt", "x", "--cwd", "/nonexistent/dir"], ok);
  expect(b.code).toBe(1);
  expect(b.seen).toEqual([]);
});

test("the script does not start tmux or claude itself", async () => {
  const text = await Bun.file(SCRIPT).text();
  const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  expect(code).not.toMatch(/\btmux\b/);
  expect(code).not.toMatch(/\bexec claude\b/);
});
