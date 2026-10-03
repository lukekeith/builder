---
name: tidy
description: Take the repo back to clean — one table of every local branch and worktree measured against the branch finished features merge into (merge_into, default base_branch, or --into) — merged, ready to merge, running, parked, in progress, unknown, dead — then one confirmation deletes what's merged, removes dead worktrees and stopped features' worktrees, and merges what's verified; every unknown, unfinished or parked branch gets its own question (finish with agents, merge as is, keep, delete). Never pushes, never touches a remote, never loses uncommitted work (it's stashed by name). Use when the user asks to clean up, tidy, prune or merge leftover builder branches and worktrees, asks what's finished or left, or /builder:status or a fleet report ends in a `repo:` line naming /builder:tidy.
---

# `/builder:tidy` — nothing left behind

Invocation: **`/builder:tidy [--into <branch>]`**. `--help` prints this line and stops.

Resolve `<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

## 1. The picture

```bash
node <builder>/scripts/inventory.mjs [--into <branch>]
```

Print it verbatim as markdown: the table, then the `repo:` line. `repo: clean` → say so and stop:

~~~
📍 repo: clean — nothing but <target> and work still running
~~~

## 2. The safe batch — one question

The safe actions, from `tidy.mjs plan --json` (same flags):

- `merged` → `delete-branch` (with its worktree)
- `dead` → `remove-worktree`
- `parked` with a worktree → `remove-worktree` (the branch stays — it holds the work)
- `ready` → `merge`

None of them → skip to §3. Otherwise one AskUserQuestion listing each by name, grouped:
**Do all of it** (recommended) / **Not now**. On **Do all of it**, run them grouped by action:

```bash
node <builder>/scripts/tidy.mjs apply <action> <names…> [--into <branch>]
```

Print each line it prints. A `handed: <features>` line → launch them, detached, as `/builder:fleet` §4
does: `node <builder>/scripts/fleet.mjs <features> --into <target> --detach` — the fleet brings each
up to date with the target, merges it and removes it; say it's running and that `/builder:fleet
--status` follows it.

## 3. The rest — one question each

Every `unknown`, `in-progress` and `parked` branch, up to four per AskUserQuestion (one tab each),
each with its row's facts in the question — commits ahead, last touched, and for a parked one its
*why* and *next* as written:

- **Finish with agents** — a feature branch: `/builder:agent --path <registry>/<feature>` (recommended
  for `in-progress` and `parked`; for parked, only once its *next* step is done — say so).
- **Merge as is** — `tidy.mjs apply merge <branch>`.
- **Keep** — nothing changes; it stays in the picture.
- **Delete** — `tidy.mjs apply force-delete-branch <branch>`; the option's description says how many
  commits are lost (`ahead`) — "N commits not in <target> are lost".

An `unknown` branch's recommendation is **Keep**: builder didn't make it and can't tell what it is.

## 4. Done

Run `inventory.mjs` again and print it. End with one footer:

~~~
📍 repo: clean
📍 <the repo: line> — kept by your choice: <names>
~~~

🔴 It never pushes, never deletes a remote branch, never runs `git stash drop`, and never deletes a
branch with commits not in the target unless that branch's own question was answered **Delete**.
