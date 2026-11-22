// Phone self-setup: claude.filipkin.com/_phone/. The router has already authenticated the request
// with Authelia and stamps Remote-User, the same trust the sidecars rely on. A signed-in user links
// their own number and opens an enrolment call; nobody can touch another user's entry.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e164, linkNumber, saveConfigKey, sidecarFor, type PhoneConfig } from "./lib";

export const LABELS = ["phone", "watch", "speaker"] as const;
export const ENROLL_WINDOW_MS = 15 * 60_000;

type Opts = { state: string; port: number; owner: string; guestsTsv: string; origin: string; cfg: () => PhoneConfig; reload: () => void };

export function armEnrollment(state: string, user: string, label: string): number {
  const until = Date.now() + ENROLL_WINDOW_MS;
  mkdirSync(join(state, "enroll"), { recursive: true });
  writeFileSync(join(state, "enroll", user), `${until}\t${label}\n`);
  return until;
}

function armed(state: string, user: string): { until: number; label: string } | null {
  const f = join(state, "enroll", user);
  if (!existsSync(f)) return null;
  const [until, label] = readFileSync(f, "utf8").trim().split("\t");
  return Date.now() < Number(until) ? { until: Number(until), label: label || "phone" } : null;
}

export function startSetup(o: Opts) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const fail = (error: string, status = 400) => json({ error }, status);

  async function me(user: string) {
    const cfg = o.cfg();
    const prints = (await fetch(cfg.speakerUrl + "/users", { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({}))) as Record<string, Record<string, number>>;
    return {
      user, claudeNumber: cfg.from, number: cfg.users.find((u) => u.name === user)?.numbers[0] ?? null,
      voiceprint: prints[user] ?? {}, enrolment: armed(o.state, user), labels: LABELS,
    };
  }

  return Bun.serve({
    hostname: "127.0.0.1", port: o.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/_phone/, "") || "/";
      const user = req.headers.get("remote-user") || "";
      const sidecar = /^[a-z0-9_-]{1,32}$/.test(user) ? sidecarFor(user, o.owner, o.guestsTsv) : null;
      if (!sidecar) return fail("No Claude environment for this account", 401);

      if (req.method === "GET" && path === "/") return new Response(Bun.file(join(import.meta.dir, "setup.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (req.method === "GET" && path === "/api/me") return json(await me(user));
      if (req.method !== "POST") return fail("Not found", 404);

      // A cross-site form cannot send JSON or this Origin, so another site cannot act for the user.
      const origin = req.headers.get("origin");
      if ((origin && origin !== o.origin) || !(req.headers.get("content-type") || "").startsWith("application/json")) return fail("Request refused: wrong origin", 403);
      const body = (await req.json().catch(() => ({}))) as { number?: unknown; label?: unknown };
      const file = join(o.state, "config.json");

      if (path === "/api/number") {
        const r = linkNumber(o.cfg(), user, sidecar, String(body.number ?? ""));
        if (!r.ok) return fail(r.why === "in-use" ? "Number in use" : r.why === "own-number" ? "Number is the Claude line" : "Not a phone number");
        saveConfigKey(file, "users", r.users); o.reload();
        console.log("setup", user, "number", e164(String(body.number)));
        return json(await me(user));
      }
      if (path === "/api/remove") {
        saveConfigKey(file, "users", o.cfg().users.filter((u) => u.name !== user)); o.reload();
        rmSync(join(o.state, "enroll", user), { force: true });
        await fetch(o.cfg().speakerUrl + "/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user }) });
        console.log("setup", user, "removed");
        return json(await me(user));
      }
      if (path === "/api/enroll") {
        const label = String(body.label ?? "phone");
        if (!(LABELS as readonly string[]).includes(label)) return fail("Device unknown");
        if (!o.cfg().users.some((u) => u.name === user)) return fail("Phone number missing");
        armEnrollment(o.state, user, label);
        console.log("setup", user, "enrolment open", label);
        return json(await me(user));
      }
      return fail("Not found", 404);
    },
  });
}
