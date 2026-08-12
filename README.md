# claude-terminal

A companion for running [Claude Code](https://claude.com/claude-code) in the browser through
[ttyd](https://github.com/tsl0922/ttyd). Two things in one small Bun project:

1. **A tab bar** across the top of the web terminal. It lists your open `tmux` sessions like
   browser bookmarks: click to switch, `X` to close, `+` for a new one, a per-tab dot showing
   whether Claude is working / waiting for you / done, auto-generated tab names (Claude's own
   `ai-title`), a light/dark toggle that flips Claude Code's real theme, and image paste.
2. **Usage tracking.** A collector tails your Claude Code transcripts into a SQLite database and a
   live dashboard shows output tokens over time, a 5-hour rolling window, and (optionally) a
   monthly cost split across several tracked users.
3. **An installable app (PWA) with notifications.** The terminal ships a web manifest, a service
   worker, and an icon, so you can install it to your home screen / desktop for a fullscreen
   window. A bell in the tab bar turns on Web Push (VAPID, no third-party service), and you get a
   notification when a prompt finishes or is waiting for your input — even when the app is closed.
   The same push channel is a generic notification path any of your own tools can post to.

It is config-driven: a single-person install is a few lines of JSON. You can also track extra
"users" (separate agents, bots, or sandboxed guests) so their usage shows as its own row.

## How it fits together

```
Claude Code (in tmux, in ttyd)
  overlay.js  ── injected into the ttyd page (nginx sub_filter) ── draws the tab bar
      │  fetches /sessions /theme /upload  (served by the server)
server.ts (Bun)  ── terminal API + usage API + hosts the dashboard + SSE live push
      │  reads usage.db
collector.ts (Bun, on a timer)  ── transcripts ──▶ usage.db (SQLite)
      └─ after each run, POSTs /internal/tick so the dashboard updates live
```

Nothing scrapes transcripts except the collector; the server only reads the database.

## Requirements

- [Bun](https://bun.sh)
- ttyd serving Claude Code inside tmux (the tab bar attaches to your tmux sessions)
- nginx (to inject `overlay.js` and route the endpoints)

## Quick start (single person)

```bash
cp config.example.json config.json     # then edit it
sudo mkdir -p /var/lib/claude-terminal  # or wherever your "db" points
bun run server.ts                       # serves the terminal API + dashboard
bun run collector.ts                    # run on a timer (e.g. every minute)
```

Minimal `config.json`:

```json
{ "owner": "me", "dataDir": "/home/me/.claude/projects", "db": "/var/lib/claude-terminal/usage.db" }
```

## config.json

| key | meaning |
| --- | --- |
| `owner` | your username; gates the terminal endpoints (matched against nginx's `Remote-User`) and gets the "host" badge |
| `dataDir` | the owner's Claude transcripts dir (usually `~/.claude/projects`) |
| `db` | path to the SQLite file (keep it off any synced/backed-up-as-text tree) |
| `port` | server listen port (default 7682) |
| `usagePage` | serve the dashboard (default true) |
| `subscriptionUsd` | monthly cost to split across users; `0`/omit disables the split feature |
| `collectSeconds` | collector cadence hint (drive it from your timer) |
| `extraUsers` | `{ name: [transcriptDir, ...] }` — extra tracked "users" (bots, agents, guests) |
| `names` / `hosts` / `colors` | display name, host-vs-sandbox badge, and fixed dot color per user |
| `corsOrigins` | origins allowed to read the usage API cross-site (e.g. a homepage that lists sessions) |
| `appName` / `appShort` | PWA name / short name (default "Claude Terminal" / "Claude") |
| `themeColor` / `bgColor` | PWA theme + background colors |
| `vapidSubject` | `mailto:` contact for the VAPID keypair (push identification) |
| `stateDir` | where the VAPID keypair + push subscriptions are stored (default `~/.claude`) |

VAPID keys are generated on first run into `stateDir/claude-terminal-vapid.json` (keep this — regenerating orphans every subscribed device). Push subscriptions live in `stateDir/claude-terminal-push.json`. Neither belongs in the repo.

Transcript dirs nested inside another tracked user's dir are automatically excluded from that
outer user, so an agent that runs under your tree counts as itself, not you.

## nginx

Route the terminal endpoints to the server (`127.0.0.1:7682`): a location that proxies
`/sessions`, `/theme`, `/upload`, `/overlay.js` with the authenticated user in a `Remote-User`
header, and a public location that proxies `/usage/` (with `proxy_buffering off` for the SSE
stream). See your reverse proxy for specifics.

Getting the overlay `<script>` tag into ttyd's page itself is handled by `ttyd/` (below) now,
not by nginx — no `sub_filter`/response-rewrite needed at the proxy layer at all. If your proxy
can't do the `ttyd/index.html` approach for some reason, the fallback is a `sub_filter` that
inserts `<script src="…/overlay.js"></script>` before `</head>` (that's how this project did it
originally; any reverse proxy with response-body rewriting can reproduce it).

## ttyd overlay injection (`ttyd/index.html`)

ttyd has a native `-I`/`--index` flag: point it at a custom `index.html` and it serves that
instead of its built-in page. `ttyd/index.html` here is ttyd's pristine page (captured via a
loopback `curl` against a real ttyd instance) with one line added — the overlay `<script>` tag
inserted right before `</head>`:

```
<script src="/_ct/overlay.js?v=NN"></script></head>
```

Wire it in with `-I /path/to/ttyd/index.html` on the `ttyd` command line (systemd `ExecStart=`,
or a container `entrypoint.sh`). **Bump the `?v=` query string in this file** (not anywhere
else) whenever `overlay.js` changes, so browsers can't serve a stale cached copy.

Verified empirically (ttyd 1.7.7): `-I` is **read fresh from disk on every request**, not
cached once at process start. On a host where `ttyd/index.html` is live on disk (e.g. mounted
straight from this repo), a version bump takes effect on the next page load — **no ttyd
restart needed**. In a container image where the file is `COPY`'d in at build time, a version
bump still needs an image rebuild + recreate to reach the running container, same as any other
baked-in file.

## Notifications & the app notification path

Once you install the app and click the bell to enable notifications, two things push to you:

- **Prompt finished / waiting for input.** Claude Code hooks (`Stop` → "done", `Notification` →
  "waiting") post the session to `POST /notify/session {id, kind}`. The server suppresses the push
  when you're actively watching that exact tab (the page sends a focus heartbeat to `POST /active`),
  so you're only pinged when you're away or looking at a different session.
- **Anything you build.** Any local tool can send you a notification by posting JSON to the
  server (loopback needs no auth):

  ```bash
  curl -s -X POST http://127.0.0.1:7682/notify \
    -H 'content-type: application/json' \
    -d '{"title":"Deploy finished","body":"stonkbot is live","url":"/"}'
  ```

  Fields: `title` (required), `body`, `url` (opened on click), `tag` (a later push with the same
  tag replaces the earlier one), `requireInteraction`. A tiny wrapper makes it a one-liner:
  `claude-notify "build done" "42 tests passed"`.

Endpoints (all under the terminal prefix; owner-gated except where noted): `GET /manifest.webmanifest`,
`GET /sw.js`, `GET /pwa/<icon>`, `GET /vapidPublicKey`, `POST /subscribe`, `POST /unsubscribe`,
`POST /active`, `POST /notify` (owner **or** loopback), `POST /notify/session` (owner or loopback).

## Importing from a previous setup

`migrate-state.ts` imports legacy per-user JSON buckets into SQLite (preserving byte-offsets so the
collector continues cleanly). Adapt it to your old format if you have one.

## License

MIT.
