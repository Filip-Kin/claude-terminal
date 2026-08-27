# claude-terminal

A companion for running [Claude Code](https://claude.com/claude-code) in the browser through
[ttyd](https://github.com/tsl0922/ttyd). A few things in one small Bun project:

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
4. **Spawnable task tabs.** From inside one session you can spin off a NEW tab that runs a fresh
   Claude on a task, detached. It starts working on its own; open the tab whenever you want to
   watch it. There's a `claude-spawn` CLI and a `POST /sessions/spawn` endpoint (see below), so a
   Claude session can hand work to a sibling mid-conversation.

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
| `spawnCwd` | default working dir for a spawned task tab when the request names none (default `$HOME`; set it to an already-trusted root like a files root or `/workspace`) |
| `spawnHelper` | path to the `claude-spawn` script the spawn endpoint shells out to (default: `~/.local/bin/claude-spawn`, else `/usr/local/bin/claude-spawn`) |

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

## Spawning a task into a new tab

You can spin off a NEW tab that runs a fresh, detached Claude on a task. The tab appears in the
tab bar; open it any time to watch, and it keeps working whether or not anyone is looking. Because
each tab is just a tmux session and the ttyd wrapper attaches with `new-session -A`, opening the
tab attaches to the already-running session, it never restarts the work.

There are two ways in, both backed by the same `bin/claude-spawn` script (install it to
`~/.local/bin/claude-spawn`):

```bash
# CLI: from your own shell, or from inside a Claude session via its Bash tool
claude-spawn --prompt "port the auth module to the new API and run the tests"
claude-spawn --name deploy --cwd /srv/app --prompt-file ./task.md
```

```bash
# HTTP: owner-gated, same as the other terminal endpoints. This is what lets it work
# inside guest containers, where the in-container sidecar owns session creation.
curl -s -X POST http://127.0.0.1:7682/sessions/spawn \
  -H 'content-type: application/json' \
  -d '{"prompt":"run the full test suite and fix any failures","name":"tests","cwd":"/srv/app"}'
# -> {"id":"tests"}   (the tab id; open /?arg=tests to watch it)
```

`name` and `cwd` are optional (`name` defaults to a generated `spawn-<time>-<rand>` id; `cwd`
defaults to `spawnCwd`, else `$HOME`). The reply's `id` is registered as a pending tab so the chip
shows instantly.

Two things the script handles that make this reliable:

- **It auto-submits.** `claude "<prompt>"` in an interactive pty submits the prompt on its own
  (it doesn't just pre-fill the input box), so the spawned session starts working with no
  keystroke injection.
- **It pre-seeds workspace trust.** The trust dialog is not skipped in interactive mode, so a cwd
  with no trusted ancestor would otherwise block forever on "Is this a project you trust?". The
  script seeds `hasTrustDialogAccepted` for the cwd in `~/.claude.json` before launching (a no-op
  when the cwd or an ancestor is already trusted). The spawned Claude runs with
  `--dangerously-skip-permissions`, so pre-trusting the cwd is consistent with that autonomy.

The prompt is passed to tmux as a single literal argv element (tmux execs a multi-arg command
directly, no shell), so there's no quoting hazard even for long multi-line prompts, and the pane
command is `/bin/bash -c '…'` (naming the interpreter explicitly) so it works under a `nologin`
runtime user too. PATH is prepended with `~/.local/bin` inside that wrapper so the spawned Claude
finds its own tools, and `claude` is resolved via PATH so the same script works on a host and
inside a container. The tmux socket follows `TMUX_TMPDIR` (default `/tmp`, matching the sidecar).

## Chat app (`/app`)

An optional Claude-app-style chat interface that drives Claude Code through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) in headless
streaming mode, sitting alongside the raw terminal. The terminal stays one click away (a chat
button in the tab bar opens `/app`; the app has a "Terminal" link back). It is owner-only.

What it does: a sidebar of past conversations (read from the same `.jsonl` transcript store the
terminal history uses), a bubble transcript with markdown and collapsible tool cards, a bottom
composer with file attach, a per-conversation model picker, and streaming replies over SSE.
Because the SDK writes to the same `~/.claude/projects/<enc-cwd>/<session-id>.jsonl` store as the
interactive CLI, a chat you start in the app is resumable in a terminal tab (`claude --resume <id>`)
and a terminal conversation opens in the app. It authenticates on the box's existing Claude login
(claude.ai subscription, no `ANTHROPIC_API_KEY`) and runs tools with `permissionMode:
"bypassPermissions"` — treat it with the same trust as `claude --dangerously-skip-permissions`.

Files: `app-runner.ts` (the SDK conversation manager), `app-server.ts` (the `/app*` routes, hooked
into `server.ts` in one line), and the React front-end in `app/` built to `public/app/` with
`bun run build:app`. Config: optional `appModels` (defaults to Opus/Sonnet/Haiku aliases).

Deploy (front door): the sidecar serves `/app*`, but your reverse proxy must route `/app*` to the
sidecar (the built assets fetch absolute `/app/...` paths). For the claude.filipkin.com setup that
is a one-time `claude-router` rule sending `/app` and `/app/*` to the sidecar port. Guests never
get an `/app` route, and the tab-bar chat button hides itself unless the owner-gated
`/app/api/models` probe returns 200.

Shipping updates (the PWA-doesn't-go-stale part): `bun run app/build.ts` (aka `bun run build:app`)
builds `main-<hash>.js` + `styles-<hash>.css`, writes `public/app/version.txt` (the JS content
hash), and regenerates `index.html` pointing at the hashed files. Hashed assets are served
`immutable` (a new deploy is a new URL, so no cache can serve stale JS); `index.html` and
`/app/api/version` are `no-store`. `/app/api/version` reads `version.txt` fresh on each request, so
**a rebuild alone ships the update — no service restart needed**. Any fresh load gets the new
bundle; an already-open tab or installed PWA polls `/app/api/version` every 60s and shows a "Reload"
toast (which clears Cache Storage and reloads — it does not touch the shared push service worker).
This is FTA-Buddy's version-poll + reload-toast pattern, without its cache-first shell precache.

### Hands-free voice mode

The chat app has an optional phone-call-style voice mode: talk to Claude and it talks back,
listening resumes automatically after each reply, and talking over Claude interrupts it (barge-in).
Speech is **fully server-side** so it works identically on iOS Safari (which has no Web Speech API)
and Android: the browser records the mic with `MediaRecorder`, POSTs the clip to a local Whisper
service (`/app/api/stt` → text); that becomes a normal chat turn; Claude's streamed reply is chunked
by sentence and each sentence is sent to a local Kokoro TTS service (`/app/api/tts` → audio) and
played in a queue, so Claude starts speaking before the whole reply is finished.

Two small Python/uv services under `voice/` back this (both bind loopback only; the sidecar proxies
and owner-gates them):

- `voice/stt` — [faster-whisper](https://github.com/SYSTRAN/faster-whisper), `base.en` by default
  (~0.4s per short turn on a modern CPU; set `STT_MODEL=small.en` for more accuracy at ~3× latency).
- `voice/tts` — [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), voice `af_heart`
  (first-audio ~0.37s, ~5× faster than real time on CPU). [Piper](https://github.com/rhasspy/piper)
  is a lighter alternative if you need one.

Set up and run each with `uv` (models download to `~/.cache/huggingface` on first start):

```bash
cd voice/stt && uv sync && uv run uvicorn main:app --host 127.0.0.1 --port 7801
cd voice/tts && uv sync && uv run uvicorn main:app --host 127.0.0.1 --port 7802
```

Example systemd units are in `voice/systemd/`. Then enable voice in `config.json` — either
`"voice": true` (uses the default loopback ports 7801/7802) or point at custom URLs with
`"sttUrl"`/`"ttsUrl"`. When configured, `/app/api/models` reports `voice: true` and the app shows a
mic button; otherwise the button is hidden and the routes return 503, so a vanilla install and guest
sidecars are unaffected. `espeak-ng` is needed for Kokoro's out-of-dictionary word fallback
(`apt install espeak-ng`).

## Importing from a previous setup

`migrate-state.ts` imports legacy per-user JSON buckets into SQLite (preserving byte-offsets so the
collector continues cleanly). Adapt it to your old format if you have one.

## License

MIT.
