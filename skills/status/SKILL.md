---
name: status
description: The dashboard of in-progress /builder:* work in this repo — one table of every open feature and program, most recently touched first, each with what it is, the step last completed, the step to do next, when it last moved, and the exact command to copy and paste to pick it up; plus which branch to switch to and any feature that can't be resumed as it stands. Read-only and fast — it reads manifests, never specs, and writes nothing. Use when the user asks where their work stands, what's in progress, what they were working on, what to pick up next, or for a status/overview of builder features.
---

# `/builder:status` — where every piece of in-progress work stands

Invocation: **`/builder:status`**. `--help` prints this line and stops.

**Read-only.** It writes nothing, commits nothing, and never starts the next step — that is the
command in the table's last column, which the user runs when they choose.

## 1. Run it

Resolve the plugin's scripts as [REFERENCE](../resume/REFERENCE.md) §The scripts does
(`$CLAUDE_PLUGIN_ROOT` first), then:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/list-features.mjs" --status
```

The script does all of the work — it reads each feature's `MANIFEST.md` (or the condensed SPEC
header), maps its `state:` to the step last done and the step next, dates it from `git log`, and
prints a finished markdown table. **Do not open any SPEC, PLAN or manifest yourself** to add to it;
the manifest is the record, and a status view that reads specs is slow and drifts from what
`/builder:resume` will actually do.

No `.claude/builder.md` → the script says so; relay it and name **`/builder:init`**.

## 2. Show it

Print the script's output **verbatim, as markdown** — the table, then any branch-switch and
needs-attention lines under it. Don't re-sort it, re-word the steps, or summarise it into prose: the
user copies commands straight out of the last column.

Then, at most one line of your own, and only when it earns its place:

- a row is 🛑 held or flagged under **Needs attention** → say which, in a few words;
- otherwise → nothing. Don't recommend what to work on unless the user asks.

**Stop there.** Don't pick a row, don't run a command, don't offer a picker — the user reads the
table and pastes the command for the one they want.
