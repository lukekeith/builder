---
name: fleet
description: Take a batch of written specs through the whole /builder:* pipeline unattended — one worktree and branch per spec, a parallel build lane, a one-at-a-time walk lane through the shared dev environment, an agent walk in place of the human one, verify, and a DRAFT PR per feature; anything that would ask a question takes its recommendation or parks the feature with a reason. Launches scripts/fleet.mjs in the background and reports its table. Use when the user wants several specs built unattended, overnight, or "sent to an orchestrator"; --status shows the last run.
---

# `/builder:fleet` — many specs, no one watching

Invocation: **`/builder:fleet [--all | <feature|folder>…] [--parallel N] [--dry-run] [--status]`**.

The work is `scripts/fleet.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

**What it will do, per spec:** a worktree at `<agent_walk.worktrees>/<feature>` on a new branch
`builder/<feature>` (or the branch it is already underway on); `claude -p "/builder:resume --path <spec> --agent-walk"` runs until the feature
is a **draft PR** or **parked** (resume §`--agent-walk`). It **pushes branches and opens draft PRs**.
It never marks a PR ready, never merges, never signs off for a human.

## 1. `--status`

`node <builder>/scripts/fleet.mjs --status` — print it verbatim and stop.

## 2. Always dry-run first

```bash
node <builder>/scripts/fleet.mjs <the same arguments> --dry-run
```

Print it verbatim. For every `✗` line, say what fixes it in a few words. The script refusing the whole
batch (no `agent_walk:` block, no `claude_args`) → name `/builder:init --update` and stop. `--dry-run`
was asked for → stop here.

## 3. Confirm once

One AskUserQuestion — **Start the fleet** / **Not now** — whose question restates: how many specs, the
worktree root, the permission args (`claude <claude_args>`), and "pushes branches and opens draft PRs".
This is the only question the fleet ever asks.

## 4. Launch

Run with the Bash tool's `run_in_background`:

```bash
node <builder>/scripts/fleet.mjs <the same arguments>
```

Then say, in two lines: it's running, `/builder:fleet --status` shows where it stands, and a run that
must outlive this session goes in a terminal instead:
`nohup node <absolute builder path>/scripts/fleet.mjs <arguments> > .builder/fleet/fleet.out 2>&1 &`.

## 5. When it finishes

Print `.builder/fleet/STATUS.md` verbatim. Then, briefly:

- **done** — each draft PR, and: review it, walk what you want, then in its worktree
  `cd <worktree> && claude` → `/builder:signoff --path <spec>`; the next `/builder:resume` marks it ready.
- **parked** — the reason; delete the `blocked:` line in the worktree's manifest once it's settled, and
  re-run `/builder:fleet` — it resumes, and retries only what you cleared.
- **failed** — the log path.

~~~
📍 fleet: <n> done · <m> parked · <k> failed — next: review the draft PRs; /builder:signoff in each worktree
~~~
