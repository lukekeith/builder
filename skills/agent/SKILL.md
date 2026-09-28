---
name: agent
description: Pick one or more unfinished /builder:* features from a list and hand them to agents that run each one until it is done — merged into the branch you ran it from, after an agent walk, an agent sign-off and verify. Conflicts, red gates and failed walks are worked by agents, never parked; a feature parks only when its spec leaves a product decision open. Offers every unshipped feature at any step (written spec, audited, planned, part-built, built, signed off, verified, PR open) that is not parked; one multi-select, one confirmation, then the /builder:fleet engine runs them in the background, continuing each on its own branch in its own worktree. Use when the user wants agents to take over, finish, or keep working on specs or plans that are already written.
---

# `/builder:agent` — pick the work, let agents finish it

Invocation: **`/builder:agent`**. No arguments; `--help` prints this line and stops.

The engine is `/builder:fleet`'s — `scripts/fleet.mjs` — so everything it promises holds here: a
worktree per feature, builds in parallel, walks one at a time, an agent walk and an **agent
sign-off** in place of yours, then verify, the ship commit and a **merge into the branch you're on
now** — one merge commit per feature, so the whole batch lands in one place for you to test — and
nothing that waits on a question. "Done" means **merged**. A feature parks only when its spec leaves
a product decision open (or the config reserves a step to you) — a merge conflict, a red gate or a
failed walk is work the agents do, not a reason to stop. Nothing is
pushed. Every record says the feature was agent-verified, not human-tested. Resolve `<builder>` per
[REFERENCE](../resume/REFERENCE.md) §The scripts.

## 1. What can be picked

```bash
node <builder>/scripts/list-features.mjs --json
```

A row is offered when `done` is false, its `manifest.blocked` is unset or `none`, and its `manifest.state` is one of `spec aligned audited planned building built
signed-off verified` (an open `pr` is fine — agents take it on to merged). No config `agent_walk:` block → stop here and name `/builder:init --update`.

**A fleet may already be running.** `.builder/fleet/lock` holding a pid that `kill -0 <pid>` accepts
means one is: then a row `.builder/fleet/fleet.json` lists with a status other than `parked` or
`failed` is in it already and is **not offered** (say "N already running or queued" in the question);
parked and failed rows stay offerable — picking one retries it. Picks join the running fleet's queue
(§3) instead of starting a second one.

Nothing offerable → say so, and name `/builder:brainstorm` for writing a spec. Parked rows are listed
underneath as a count with their reasons, so it's clear why they're missing. A program child whose
`waitsOn` isn't empty is offered with `after <deps>` in its description: picked together with its
dependencies, the fleet runs the chain in order in one run; picked without them, the dry-run refuses
it and says which to add.

## 2. Pick — one multi-select

One AskUserQuestion with `multiSelect: true`. Each option: the `feature` as the label; its
`manifest.state` and `nextStep` as the description. **More than four offerable** → offer the four most recently touched
(`updatedAt`), and say in the question that any others can be named with
`/builder:fleet <feature> <feature>…`. Nothing picked → stop.

## 3. Check, confirm, launch

```bash
node <builder>/scripts/fleet.mjs <picked features> --dry-run
```

Print it verbatim. A `✗` pick → say what fixes it (a feature whose branch is checked out in this
folder: switch branches, or just `/builder:resume` it here). If no pick survives, stop.

Then `/builder:fleet` §3 (the one confirmation), §4 (launch in the background) and §5 (the report
when it finishes), with the picks as the arguments.

~~~
📍 agents: <n> feature(s) running — next: /builder:fleet --status
~~~

When a fleet is already running, the dry run says `adds to the running fleet (pid N)`: the
confirmation is **Add to the running fleet** / **Not now**, the command runs in the foreground and
returns at once, and the footer is `/builder:fleet` §4's `added` line. The running fleet starts each
pick as a lane frees; `/builder:fleet --status` shows the queue.
