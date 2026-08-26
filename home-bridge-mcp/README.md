# home-bridge-mcp

A private HTTP **MCP server on the home box** that gives Filip's cloud/mobile/desktop
Claude the things only this server has: the **memory tree**, **Nextcloud files**, and
the ability to **delegate a job to the server's own Claude** (which has the local render
toolchain, e.g. trip field-guide PDFs via WeasyPrint/Chromium).

It is its own **OAuth 2.1 authorization-server facade** that delegates the human login
upstream to **Authelia**, checks `group:admins`, and mints its own short-lived,
audience-bound token. This is what makes it work as a Claude.ai remote custom connector
(which requires OAuth 2.1 + Dynamic Client Registration + PKCE + RFC 8707 resource
indicators), without Authelia needing to support DCR.

## Why it exists

The cloud Claude was flying blind about this server: it couldn't see the runbooks or the
conventions (like how the reservation/field-guide PDFs are built) and couldn't run the
local toolchain. This bridge closes that gap.

## Security posture (read this)

`run_claude_task` runs `claude -p ... --dangerously-skip-permissions` as user `filip`.
That is **effectively arbitrary execution / root-equivalent on the home box**, now
reachable from the internet. Mitigations:

- The whole `/mcp` endpoint is **admin-only OAuth** (`BRIDGE_REQUIRED_GROUP=admins`),
  enforced both by the Authelia authorization policy and re-checked here.
- Origin is **DNS-only** (not Cloudflare-proxied) for SSE + long tasks, same as the ITA
  MCP; the trade-off is the origin IP is exposed.
- `run_claude_task` can be disabled entirely with `BRIDGE_ENABLE_CLAUDE_TASK=0` to leave a
  read-only bridge (memory + files).
- Every task invocation is logged.

## Architecture

```
Claude app --OAuth 2.1 (DCR+PKCE+resource)--> bridge.filipkin.com (home nginx, TLS)
                                                  -> 127.0.0.1:7690 (this service, user filip)
   /.well-known/oauth-authorization-server        (RFC 8414 AS metadata)
   /.well-known/oauth-protected-resource[/mcp]     (RFC 9728 PR metadata)
   /oauth/register                                 (RFC 7591 DCR, public client)
   /oauth/authorize   --OIDC redirect-->  Authelia (auth.filipkin.com, client "homebridge")
   /oauth/authelia/callback  (verify id_token, require admins, mint our code)
   /oauth/token       (authz_code + PKCE + resource binding; refresh rotation)
   /mcp               (Streamable HTTP + SSE; Bearer = our HS256 JWT, aud=resource)
```

## Tools

| tool | what |
|------|------|
| `get_memory_index` | returns `MEMORY.md` |
| `search_memory` | case-insensitive search across memory files, with snippets |
| `read_memory` | full contents of one memory file (by slug/filename) |
| `list_files` | list a dir under `ncdata/filip/files` |
| `read_file` | read a text file under the files root (<=512 KB) |
| `write_file` | write a file under the files root (occ scan not automatic) |
| `run_claude_task` | delegate a one-shot job to the server Claude (full box access) |

## Config

Copy `.env.example` to `.env` and fill in. Key values:

- `BRIDGE_PUBLIC_URL=https://bridge.filipkin.com`
- `AUTHELIA_CLIENT_ID=homebridge`, `AUTHELIA_CLIENT_SECRET=<from Authelia>`
- `BRIDGE_REQUIRED_GROUP=admins`
- `BRIDGE_TOKEN_SECRET` — auto-generated to `data/secret.key` if blank (persist it).

## Run

```
bun install
bun run start          # production (auth on)
bun run dev            # BRIDGE_DEV_NO_AUTH=1, loopback only, for local testing
bun run typecheck
```

## Deploy (home box) — the infra steps

These are the environment changes required to go live. They are intentionally NOT
performed by the app.

1. **Authelia client** (`/home/filip/authelia/configuration.yml`): add a `homebridge`
   OIDC client — confidential (client_secret), `authorization_policy` = admins,
   `require_pkce_when_public_clients` not relevant (confidential), scopes
   `openid profile email groups`, redirect_uri
   `https://bridge.filipkin.com/oauth/authelia/callback`, `consent_mode: pre-configured`
   with a long duration so there's no repeated consent screen. Store the plaintext secret
   in `/data/docker/authelia/secrets/homebridge_client_secret`, pbkdf2 hash in the YAML.
   `docker exec authelia authelia validate-config` then `docker restart authelia`
   (Redis-backed sessions survive).
2. **nginx vhost** `bridge.filipkin.com` -> `127.0.0.1:7690`. NO forward-auth include (the
   app does its own OAuth). SSE-friendly: `proxy_buffering off`, `proxy_read_timeout`
   high (>= task timeout), `proxy_http_version 1.1`. TLS cert for the host.
3. **DNS**: `bridge.filipkin.com` pointing at the home WAN the same way
   `claude.filipkin.com` does (CNAME to the hopto host), DNS-only. Not Cloudflare-proxied.
4. **systemd** service `home-bridge-mcp.service` running `bun run src/index.ts` as user
   `filip`, `WorkingDirectory` = this dir, `EnvironmentFile=.env`,
   `Requires=media-nas.mount` (source lives on the NAS mount), `Restart=always`.
5. **Backup + memory**: covered by the home-filip rsync (this dir) once placed; add a
   memory note.

## Connect from a Claude app

Add a custom connector with URL `https://bridge.filipkin.com/mcp`. The app runs DCR +
OAuth automatically; you log in via Authelia and must be in `admins`.
