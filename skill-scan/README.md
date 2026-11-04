# skill-scan

Skills run with the same trust as the agent that loads them, and the Connections panel makes them easy to add. `skill-scan` checks every skill on the box with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) when it appears or changes, and pushes the verdict to your devices through the sidecar's `POST /notify`.

It finds every folder that contains a `SKILL.md` under the watched roots, hashes its contents, and rescans only the skills whose hash changed since the last run. A systemd path unit starts a scan when a skills folder changes, and a timer sweeps every 10 minutes to catch changes the path unit misses, such as edits inside an existing skill.

## Install

Install SkillSpector, for example as a uv tool:

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

Then link the script and the user units:

```bash
ln -s "$PWD/skill-scan/skill-scan" ~/.local/bin/skill-scan
mkdir -p ~/.config/systemd/user
cp skill-scan/skill-scan.{service,path,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now skill-scan.path skill-scan.timer
loginctl enable-linger "$USER"   # keep the units running while you are logged out
```

The script finds `claude-wrapper` next to its own resolved path, so link it rather than copying it.

## The LLM pass

Without a token, scans are static analysis only. To add SkillSpector's LLM analyzers, put a long-lived token from `claude setup-token` in `~/.config/skill-scan/env` (mode 600):

```
CLAUDE_CODE_OAUTH_TOKEN=...
```

The analyzers then run through the local `claude` CLI on `claude-sonnet-5`. Each skill costs a few dozen headless calls. SkillSpector strips unknown environment variables from the `claude` child process, so `skill-scan` writes the token to its private runtime directory and puts a symlink to `claude-wrapper` first on the PATH; the wrapper reads the token back and runs the real CLI.

## Vetting a skill before you install it

Pass paths to scan them now, whatever their state:

```bash
skill-scan --no-llm /tmp/some-new-skill
```

Scans of folders outside the watched roots leave no state behind, so the watcher still scans the skill once it is installed. Read the findings before acting on a `DO_NOT_INSTALL` verdict; rules such as `AE1` (an image or reference the scanner could not fully read) and `LP3` (no `allowed-tools`) fire on many harmless skills.

## Configuration

All settings are environment variables, set in `~/.config/skill-scan/env` for the units.

| Variable | Default |
|---|---|
| `SKILL_SCAN_ROOTS` | `~/.claude/skills:~/.claude/plugins/cache:<repo>/skills` |
| `SKILL_SCAN_PROJECT_DIRS` | empty; for each dir, also scans `*/.claude/skills` and `*/*/.claude/skills` below it |
| `SKILL_SCAN_MODEL` | `claude-sonnet-5` |
| `SKILL_SCAN_NOTIFY_URL` | `http://127.0.0.1:7682/notify`; empty turns pushes off |
| `SKILLSPECTOR` | `skillspector` on the PATH, then `~/.local/bin/skillspector` |

Add a `PathChanged=` line to `skill-scan.path` for each extra root, or rely on the timer for those.

Reports land in `~/.local/share/skill-scan/reports/<skill>-<time>.json`, one JSON line per scan goes to `~/.local/share/skill-scan/scan.log`, and the hashes live in `~/.local/state/skill-scan/state.json`. Delete the state file to rescan everything.
