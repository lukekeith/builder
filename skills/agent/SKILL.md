---
name: agent
description: Pick one or more unfinished /builder:* features from a list and hand them to agents that run each one until it is done — merged, after an agent walk, an agent sign-off, verify and green CI — or parked with the reason a human is needed. Offers every unshipped feature at any step (written spec, audited, planned, part-built, built, signed off, verified, PR open) that is not parked; one multi-select, one confirmation, then the /builder:fleet engine runs them in the background, continuing each on its own branch in its own worktree. Use when the user wants agents to take over, finish, or keep working on specs or plans that are already written.
---

# `/builder:agent` — pick the work, let agents finish it

Invocation: **`/builder:agent`**. No arguments; `--help` prints this line and stops.

The engine is `/builder:fleet`'s — `scripts/fleet.mjs` — so everything it promises holds here: a
worktree per feature, builds in parallel, walks one at a time, an agent walk and an **agent
sign-off** in place of yours, then verify, a PR, CI, the ship commit and the **merge** — and nothing
that waits on a question. "Done" means **merged**, or **parked with a reason**. Every record says the
feature was agent-verified, not human-tested. Resolve `<builder>` per
[REFERENCE](../resume/REFERENCE.md) §The scripts.

## 1. What can be picked

```bash
node <builder>/scripts/list-features.mjs --json
```

A row is offered when `done` is false, its `manifest.blocked` is unset or `none`, its
`waitsOn` is empty, and its `manifest.state` is one of `spec aligned audited planned building built
signed-off verified` (an open `pr` is fine — agents take it on to merged). No config `agent_walk:` block → stop here and name `/builder:init --update`.
Nothing offerable → say so, and name `/builder:brainstorm` for writing a spec. Parked rows are listed
underneath as a count with their reasons, and **waiting** rows — program children whose PROGRAM
§Children *Depends on* entries haven't shipped — with their `nextStep` (`⏳ waits on …`), so it's
clear why they're missing. A chain runs one wave per pick: the next wave is offered once the last
one's PRs have merged.

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
