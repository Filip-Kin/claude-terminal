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

Transcript dirs nested inside another tracked user's dir are automatically excluded from that
outer user, so an agent that runs under your tree counts as itself, not you.

## nginx

Inject the overlay into the ttyd page and route the endpoints to the server (`127.0.0.1:7682`).
See your reverse proxy for specifics; the key pieces are a `sub_filter` that adds
`<script src="…/overlay.js">` before `</head>`, a location that proxies the terminal endpoints
(`/sessions`, `/theme`, `/upload`, `/overlay.js`) with the authenticated user in a `Remote-User`
header, and a public location that proxies `/usage/` (with `proxy_buffering off` for the SSE
stream).

## Importing from a previous setup

`migrate-state.ts` imports legacy per-user JSON buckets into SQLite (preserving byte-offsets so the
collector continues cleanly). Adapt it to your old format if you have one.

## License

MIT.
