---
name: agent
description: Pick one or more unfinished /builder:* features from a list and hand them to agents that run each one until it is done — a draft PR with agent walk evidence, or parked with the reason a human is needed. Offers every feature at any step before its PR (written spec, audited, planned, part-built, built, verified) that is not parked; one multi-select, one confirmation, then the /builder:fleet engine runs them in the background, continuing each on its own branch in its own worktree. Use when the user wants agents to take over, finish, or keep working on specs or plans that are already written.
---

# `/builder:agent` — pick the work, let agents finish it

Invocation: **`/builder:agent`**. No arguments; `--help` prints this line and stops.

The engine is `/builder:fleet`'s — `scripts/fleet.mjs` — so everything it promises holds here: a
worktree per feature, builds in parallel, walks one at a time, an agent walk in place of yours,
**draft PRs only**, and nothing that waits on a question. "Done" means a **draft PR** or **parked
with a reason**; your `/builder:signoff` is what marks a draft ready. Resolve `<builder>` per
[REFERENCE](../resume/REFERENCE.md) §The scripts.

## 1. What can be picked

```bash
node <builder>/scripts/list-features.mjs --json
```

A row is offered when `done` is false, it has no `pr`, its `manifest.blocked` is unset or `none`, and
its `state` is one of `spec aligned audited planned building built signed-off verified`. No config
`agent_walk:` block → stop here and name `/builder:init --update`. Nothing offerable → say so, and
name `/builder:brainstorm` for writing a spec. Parked rows are listed underneath as a count with
their reasons, so it's clear why they're missing.

## 2. Pick — one multi-select

One AskUserQuestion with `multiSelect: true`. Each option: the `feature` as the label; its step and
`nextStep` as the description. **More than four offerable** → offer the four most recently touched
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
