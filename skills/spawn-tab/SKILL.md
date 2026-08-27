---
name: spawn-tab
description: Use whenever the user asks to "spawn", "open", or "start" a new tab, worker, session, or background task, or says "run this in a new tab / in the background / off to the side". This means a real new claude-terminal browser TAB running a fresh Claude on a prompt, which the user can open and watch — NOT an in-process subagent and NOT the Agent/Task tool. Trigger on the words spawn/worker/tab/session even when phrased loosely.
---

When the user says "spawn a tab" (or worker / session / "run this in a new tab" / "do
that in the background"), they mean: create a new terminal tab in the claude-terminal web
UI running a fresh, detached Claude on a prompt. It is a real tab they can click open and
watch — do NOT interpret this as an in-process subagent.

Do it with `claude-spawn`:

```
claude-spawn --prompt "the task for the new tab's Claude" --cwd /workspace --name short-name
```

- `--prompt` is the task the new tab's Claude starts working on immediately (auto-submits).
- `--cwd` defaults to `/workspace`; set it if the task belongs elsewhere.
- `--name` is an optional short label for the tab.
- Long prompt? use `--prompt-file -` and pipe it in on stdin.

It prints the new session id; tell the user the tab is open (it appears in their tab bar).
Use this to parallelise work or hand a long job to its own tab instead of blocking the
current session.
