---
name: push-notification
description: Use to push a phone/desktop notification to the user when a long-running job finishes, a background task needs attention, or something is worth surfacing while they are away from the terminal (deploys, builds, agents, alerts). Do NOT use it for ordinary "prompt finished" or "waiting for input" pings — those already fire automatically.
---

You can push a Web Push notification to the user's devices (delivered even when the
terminal tab is closed) through the tab-bar sidecar:

```
claude-notify "Title" "body text" ["https://open-on-click.example"]
```

The third argument is an optional URL opened when the notification is tapped.

Important: the terminal ALREADY notifies the user automatically when a prompt finishes or
when Claude is waiting for input — you do NOT need to send those yourself. Use this skill
only for your own events that wouldn't otherwise ping them: a long build or deploy
completing, a background job that needs a decision, an agent finishing, or an alert worth
their attention while they're away.
