---
name: spawn-tab
description: Use whenever the user asks to "spawn", "open", or "start" a new tab, worker, session, or background task, or says "run this in a new tab / in the background / off to the side". This means a real new claude-terminal browser TAB running a fresh Claude on a prompt, which the user can open and watch — NOT an in-process subagent and NOT the Agent/Task tool. Trigger on the words spawn/worker/tab/session even when phrased loosely.
---

When the user says "spawn a tab" (or worker / session / "run this in a new tab" / "do
that in the background"), they mean: create a new terminal tab in the claude-terminal web
UI running a fresh, detached Claude on a prompt. It is a real tab they can click open and
watch — do NOT interpret this as an in-process subagent.

Spawn means `claude-spawn` into a real tab (in a worktree for code work), never the Agent tool.

Do it with `claude-spawn`:

```
claude-spawn --prompt "the task for the new tab's Claude" --cwd /workspace --name short-name --model opus
```

- `--prompt` is the task the new tab's Claude starts working on immediately (auto-submits).
- `--cwd` defaults to `/workspace`; set it if the task belongs elsewhere.
- `--name` is an optional short label for the tab.
- `--model` picks the spawned Claude's model: a CLI alias (`opus`, `sonnet`, `haiku`, `fable`) or a
  full id (`claude-fable-5-1`). Leave it out to keep the default. Pass it when the user names a
  model, or when the job is bulk/mechanical and a cheaper model will do.
- Long prompt? use `--prompt-file -` and pipe it in on stdin.

The brief is an order. Nobody watches the tab, so it does the task to the end and reports.
No approval step Filip did not ask for: hook `spawn-brief-gate.py` refuses a brief with one, and
`spawned-ask-stop.py` sends the tab back to work if it ends a turn on "Go ahead?". If Filip himself
asked to see something first, quote him on its own line: `Gate (Filip's words): "<his words>"`.
The tab then stops there and his phone gets a push.

It prints the new session id; tell the user the tab is open (it appears in their tab bar).
Use this to parallelise work or hand a long job to its own tab instead of blocking the
current session.
