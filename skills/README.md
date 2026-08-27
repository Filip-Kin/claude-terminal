# Claude Code skills for claude-terminal

These are optional [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) that
teach your Claude how to use claude-terminal's own features. Drop them in and Claude will reach for
them on its own, so you do not have to explain the tab bar or the notification path each session.

## Install

Copy the skill folders into your Claude skills directory:

```
cp -r skills/spawn-tab skills/push-notification ~/.claude/skills/
```

That is per user. To make them available to everyone on a box, put them in a shared skills path
instead (see the Claude Code docs for skill discovery locations).

## What each one does

- **spawn-tab** — when you say "spawn a tab" / "run this in a new tab" / "do that in the
  background", Claude opens a real new terminal tab running a fresh Claude on your prompt (via the
  `claude-spawn` helper), rather than an in-process subagent. Needs `claude-spawn` on the PATH (it
  ships in `bin/`).
- **push-notification** — lets Claude send a Web Push notification to your devices for its own
  events (a long build finishing, a background job needing a decision) via `claude-notify`. Ordinary
  prompt-finished / waiting-for-input pings already fire automatically, so this is only for the
  extra things worth surfacing while you are away.

Both assume the sidecar is running with notifications configured; see the main README.
