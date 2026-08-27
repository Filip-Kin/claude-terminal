# Findings: management panels inside the /app chat UI

Research spike on adding two management surfaces to the claude-terminal chat app (`/app`):

1. MCP servers plus connection management (the MCP servers the Agent SDK `query()` uses for the LLM, not the VPN/Tailscale "Connections" in `connections.ts`).
2. Memory plus skills management (view/edit `~/.claude` memory files and `~/.claude/skills`, toggle/enable skills, create/edit from the app).

Done on branch `feature/app-mgmt-panels`, worktree `Projects/claude-terminal-mgmt`. Nothing on main or the live checkout was touched. Not deployed. SDK version in the tree is `@anthropic-ai/claude-agent-sdk` 0.3.246.

Status: this began as a research spike and is now IMPLEMENTED on the branch (both MCP and memory/skills), rebased onto current `origin/main`. The rest of this document is the original feasibility write-up, which still matches the built design. What shipped: `app-mcp.ts` and `app-mem-skills.ts` modules, additive `/app/api/*` routes in `app-server.ts`, MCP + skills wiring in `app-runner.ts`, two `AppCtx` fields in `server.ts`, and a self-contained `app/manage.tsx` embedded in the existing Settings modal. Skills enable/disable is a disk toggle (`SKILL.md` <-> `SKILL.md.disabled`) reflected live via `reloadSkills()`, chosen over the SDK allow-list because it disables one user skill without excluding plugin skills.

## Verdict

Both are feasible and low-risk to add, because the app is already owner-gated and already runs `query()` with `bypassPermissions`, so a management panel grants Filip nothing he cannot already do from the chat. The MCP panel is the stronger first feature: the SDK has a purpose-built runtime API for it, including live mid-session changes. Memory and skills are mostly plain filesystem CRUD with a thin SDK reload hook, so they are feasible but carry more "you are editing global behaviour" risk and less obvious payoff.

This spike ships a working proof of concept for part 1 (MCP list/add/remove behind a sidebar Settings entry) and a design for part 2.

## How query() is wired today (recap)

`app-runner.ts` holds one `Conversation` per open chat. Each opens an SDK `query()` in streaming-input mode. The only MCP server wired today is the in-process `app-ui` SDK server that provides the `ask_user` tool (built with `createSdkMcpServer` plus `tool(...)`, passed as `mcpServers: { "app-ui": makeAskServer() }`). `app-server.ts` holds every `/app*` route and is owner-gated; `server.ts` builds the `AppCtx` and adds one hook line. State files (favorites, titles) live in `STATE_DIR` (`~/.claude`), outside the repo, and ride the existing home backup.

## Part 1: MCP servers — feasible, strong fit

### What the SDK gives us

The `query()` options type accepts `mcpServers?: Record<string, McpServerConfig>`, where `McpServerConfig` is a union of:

- `McpStdioServerConfig` — `{ type?: 'stdio', command, args?, env?, timeout? }` (a local process)
- `McpSSEServerConfig` — `{ type: 'sse', url, headers?, timeout? }`
- `McpHttpServerConfig` — `{ type: 'http', url, headers?, timeout? }`
- `McpSdkServerConfigWithInstance` — the in-process instance (not serializable; this is what `app-ui` is)

The three process-based transports are plain serializable JSON, so they can be persisted to a file and re-loaded.

The live `Query` object exposes a full runtime MCP control surface (confirmed in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

- `setMcpServers(servers): Promise<{ added, removed, errors }>` — replace the dynamically-added set mid-session. Connects new servers, disconnects removed ones. Handles both process and SDK servers.
- `toggleMcpServer(name, enabled): Promise<void>` — enable/disable one by name.
- `reconnectMcpServer(name): Promise<void>` — reconnect one.
- `mcpServerStatus(): Promise<McpServerStatus[]>` — per-server status (`connected` | `failed` | `needs-auth` | `pending` | `disabled`), plus `serverInfo`, `error`, `scope`, and the list of `tools` each server exposes.

So yes: MCP config can change mid-session, not only at chat start.

### Important semantics and gotchas

- `setMcpServers` **replaces the whole dynamically-added set**. The `app-ui` ask_user server was itself added via the initial `mcpServers` option, which counts as dynamic, so every `setMcpServers` call must re-include it or the ask_user tool disappears. The prototype does this (it caches the ask server instance and always re-adds it).
- `setMcpServers` does **not** touch servers configured via settings files, and does not remove plugin-owned servers. It only manages the set we added. That is exactly what we want: our managed set stays isolated from anything in `~/.claude.json` or plugins.
- `alwaysLoad` exists per server. By default MCP tools are deferred behind tool-search; `alwaysLoad: true` forces them into the turn-1 prompt but blocks startup until the server connects (5s cap). Leave it off for the MVP.
- stdio servers run **arbitrary local commands**. This is the main risk (below).
- `env`/`headers` may hold secrets (API keys/tokens). They must be stored outside the repo. The prototype writes them to `STATE_DIR/claude-app-mcp.json` (same place as favorites/titles), never the working tree.

### API surface built in this spike

New module `app-mcp.ts`: load/save/validate/normalize a persisted `{name: config}` map at `STATE_DIR/claude-app-mcp.json`. Validation rejects bad names, the reserved name `app-ui`, non-http(s) urls, stdio without a command, and unknown transports; normalize strips any keys the SDK does not read.

New routes in `app-server.ts` (all owner-gated like the rest):

- `GET  /app/api/mcp[?id=<session>]` — list persisted servers; if `id` names a live conversation, also return that conversation's live `mcpServerStatus()`.
- `POST /app/api/mcp` — add/update `{ name, config, applyTo? }`. Persists; if `applyTo` names a live conversation, also pushes the new set live via `setMcpServers`.
- `POST /app/api/mcp/delete` — remove `{ name, applyTo? }`, same apply semantics.
- `POST /app/api/mcp/apply` — push the current persisted set live into `{ id }` without restarting the chat.

`app-runner.ts` changes: `ConvOpts.mcpFile`; `run()` loads the persisted servers and merges them into the `mcpServers` option alongside `app-ui`; new `Conversation.mcpStatus()` and `Conversation.applyMcpServers()` (which always re-includes `app-ui`). `server.ts` gains one line: `mcpFile: join(STATE_DIR, "claude-app-mcp.json")`.

Front end: `app/settings.tsx`, a self-contained Settings modal (injects its own CSS, so `styles.css` is untouched, same pattern as `voice.tsx`). It lists servers with a status dot and tool count, has an add form (stdio command+args, or http/sse url), and a remove button. `app/main.tsx` gains only an import, one state flag, a Settings gear button in the sidebar footer, and the `<SettingsModal>` render.

### Behaviour

New servers take effect on the next new chat automatically (via the merged `mcpServers` option). When a chat is open, add/remove also pushes live into that conversation via `setMcpServers`, and the panel shows real connection status for it. Persisted config survives restarts and syncs across Filip's devices (server-side file), matching favorites/titles.

## Part 2: Memory plus skills — feasible, mostly filesystem

### Memory

Memory is plain Markdown on disk, no SDK needed to read or write:

- Per-project memories: `~/.claude/projects/<enc-cwd>/memory/*.md` plus a `MEMORY.md` index. The encoded cwd is the same scheme the app already uses to find transcripts (`dataDir`), so a conversation's cwd maps directly to its memory dir.
- Global user instructions: `~/.claude/CLAUDE.md`.

A memory panel is filesystem CRUD: list the `.md` files for a project (or global), read one, edit and write it back, create/delete. It is owner-gated like everything else. There is no "toggle" concept for memory; a file either exists or not. `MEMORY.md` is the index the model loads, so the panel should keep its one-line pointer in sync when files are added or removed (or just let Filip edit both, since it is his own memory format).

Risks: memory files are loaded into every future session's context, so editing them changes behaviour broadly, and a careless edit to `MEMORY.md` or `CLAUDE.md` is felt everywhere. Path traversal must be guarded (resolve under the memory dir, reject `..`), the same guard the existing `/app/api/download` route already uses. Changes are picked up on the next session start; there is no live memory-reload hook, and none is needed for an editor.

### Skills

Skills live at `~/.claude/skills/<name>/SKILL.md` (user scope), plus project `.claude/skills`, plus plugin-provided skills. The SDK offers:

- `skills?: string[] | 'all'` query option — the single lever to choose which skills a session sees. `'all'` enables every discovered skill; a string array enables only the named ones. This is a **context filter set at query() init**, not a live per-session switch. It is a filter, not a sandbox: unlisted skill files still exist on disk and are reachable via Read/Bash, so do not treat hiding a skill as a security boundary.
- `supportedCommands(): Promise<SlashCommand[]>` — lists the skills/commands available to a live session (name, description, argumentHint, aliases).
- `reloadSkills(): Promise<{ skills }>` — re-reads skills from disk and returns the refreshed list, so a newly created or edited skill is picked up mid-session.
- There is `toggleMcpServer` for MCP but **no equivalent live `toggleSkill`**. Enable/disable of a skill is therefore done by maintaining our own enabled-list file and passing it as the `skills` option on the next new chat (live toggle would need a query restart, which we can offer as "apply to this chat = reopen it").

So skills management breaks into two feasible pieces:

- View/create/edit skills: filesystem CRUD on `SKILL.md` (list dirs, read/write frontmatter+body, create a new skill folder). `reloadSkills()` makes new ones live in the open chat.
- Enable/disable skills: persist an allow-list (or `'all'`) to a state file, pass it as the `skills` option in `app-runner.run()` (same plumbing as `mcpFile`). Takes effect on new chats.

Risks: editing a skill changes what the model will do in future sessions; a broken `SKILL.md` frontmatter can make a skill fail to load. Skill files are not a secret store (the `skills` filter does not hide them from Read/Bash). Creating skills from the app is powerful but is the same authority Filip already has via the shell.

## Recommended MVP and phasing

1. **MCP list/add/remove (built here).** Highest payoff, cleanest SDK support, live status and live apply. Ship this first. It is self-contained and additive.
2. **Skills enable/disable plus read-only list.** Reuse the `mcpFile` plumbing pattern for a `skillsFile` allow-list passed as the `skills` option; list via `supportedCommands()` or a `~/.claude/skills` scan. Low effort once the Settings shell exists.
3. **Memory viewer/editor.** A tab in the same Settings modal: pick a project (or global), list `.md`, edit with the traversal guard. Straightforward but the highest "changes global behaviour" risk, so gate the destructive actions (delete, `MEMORY.md`/`CLAUDE.md` edits) behind a confirm.
4. **Skill create/edit and MCP live toggle/reconnect.** Nice-to-haves: `reloadSkills()` after a create, and `toggleMcpServer`/`reconnectMcpServer` buttons on each MCP row.

Keep every new surface as one tab in the single Settings modal, self-contained with injected CSS, so `main.tsx` and `styles.css` churn stays near zero and merges with the concurrent chat-app work stay clean.

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| stdio MCP server = arbitrary local command execution | Medium | Owner-gated; Filip already has a bypassPermissions shell in the same app, so no new authority. Validation blocks malformed configs. |
| Secrets in MCP `env`/`headers` | Medium | Persisted to `STATE_DIR` outside the repo; never written to the working tree or logs. |
| `setMcpServers` drops the ask_user tool | Low | Prototype always re-includes the cached `app-ui` instance in every live apply. |
| Editing memory/`CLAUDE.md` changes behaviour everywhere | Medium | Confirm on destructive edits; show which file is global vs project-scoped. |
| Path traversal in memory/skill file editors | Medium | Resolve under the target dir and reject `..`, reusing the existing `/app/api/download` guard. |
| Hiding a skill is not a security boundary | Low | Document that the `skills` filter is context-only; do not store secrets in skill files. |
| Merge conflict with the concurrent chat-app session | Low | Kept to a new module plus additive routes plus a self-contained component; `main.tsx` edits are four small insertions. |

## Testing done

- Backend transpiles: `bun build server.ts` succeeds with the new imports.
- Type check: `tsc` shows only the pre-existing `@types/node` noise (`path`/`fs`/`ConvRow`), identical on pristine main; none of the new or edited code adds an error.
- SPA builds: `bun run build:app` emits a fresh hashed bundle including `settings.tsx`.
- Routes: a self-contained harness drove `appRoutes` against a temp `mcpFile` through 12 assertions (empty list, add stdio/http, reject reserved/bad-name/bad-url/no-command, strip unknown keys, list, delete, apply-to-missing-conv 409, on-disk persistence). All passed.
- Not tested live: a real MCP server connecting inside a running `query()` (would need to start a chat against Filip's Claude auth). The connect path is standard SDK behaviour and status is surfaced via `mcpServerStatus()`; worth a one-off manual check before any deploy.

## How to run this branch

```
cd Projects/claude-terminal-mgmt
# node_modules is symlinked to the sibling checkout for building; bun install also works
bun run build:app
```

The Settings gear appears in the sidebar footer next to Terminal. To exercise it live, run the sidecar from this worktree on a spare port with an owner Remote-User header (do not restart the live service). Persisted config lands in `STATE_DIR/claude-app-mcp.json`.
