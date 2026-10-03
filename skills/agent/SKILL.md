---
name: agent
description: Pick one or more unfinished /builder:* features from a list and hand them to agents that run each one until it is done — merged into the branch you ran it from, after an agent walk, an agent sign-off and verify. Conflicts, red gates and failed walks are worked by agents, never parked; a feature parks only when its spec leaves a product decision open. Offers every unshipped feature at any step (written spec, audited, planned, part-built, built, signed off, verified, PR open), parked ones included — picking a parked feature always unparks it and retries, whatever parked it and whichever builder version did, with the old reason handed to the run; each parked one is shown with why it parked and the recommended next step. One multi-select, one confirmation, then the /builder:fleet engine runs them in the background, continuing each on its own branch in its own worktree. Use when the user wants agents to take over, finish, or keep working on specs or plans that are already written, or answers a two-way handoff footer with "2" or "agent".
---

# `/builder:agent` — pick the work, let agents finish it

Invocation: **`/builder:agent [--path <folder>]`**. `--help` prints this line and stops.

**`--path <folder>`** — the feature is already chosen (a two-way footer's `2. agent`, REFERENCE §The
two-way footer): §1 checks that one feature exactly as it checks every row — offerable, or already in
the running fleet, or why not — §2 is skipped, and §3 runs with it as the one pick. Not offerable →
say why in one line and stop; never fall back to the picker.

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

Archived (shipped) features are never offered — they are not in that list. Neither are rows with
`layout: brainstorm` (conversations in progress): they have no spec to build.

A row is offered when `done` is false and its `manifest.state` is one of `spec aligned audited
planned building built signed-off verified` (an open `pr` is fine — agents take it on to merged).
**Parked rows are offered too** — `manifest.blocked` set, or a `.builder/fleet/fleet.json` row
`parked` or `failed`. Picking one unparks it: the fleet clears `blocked:` in a commit and hands the
old reason to the first run, which looks again at whether it still holds (REFERENCE §MANIFEST.md —
the builder, the code or the spec may have changed since it parked). No config `agent_walk:` block
→ stop here and name `/builder:init --update`.

**A fleet may already be running.** `.builder/fleet/lock` holding a pid that `kill -0 <pid>` accepts
means one is: then a row `.builder/fleet/fleet.json` lists with a status other than `parked` or
`failed` is in it already and is **not offered** (say "N already running or queued" in the question);
parked and failed rows stay offerable — picking one unparks and retries it. Picks join the running
fleet's queue (§3) instead of starting a second one.

Nothing offerable → say so, and name `/builder:brainstorm` (an idea) or `/builder:intake` (a written spec). A program child whose
`waitsOn` isn't empty is offered with `after <deps>` in its description: picked together with its
dependencies, the fleet runs the chain in order in one run; picked without them, the dry-run refuses
it and says which to add.

## 2. Pick — one multi-select

**Parked rows first, in plain text above the question** — one block per parked feature, split per
REFERENCE §How a park reads (the reason's last ` — next: ` separates the two; an older line's
` — clears when …` reads as its next step; no next step at all → `/builder:agent — picking it
retries`):

~~~
⛔ <feature> — parked <when, from the manifest's last commit> · <state>
   why:  <why>
   next: <next>
~~~

Relay the why as written, shortened only by dropping commit shas and round-by-round history. If it
is still unreadable — bare codes like "D6 on C-063" — read the SPEC rows it cites and say in one
plain line what behaviour is stuck. Then add one line of your own: whether picking it is the step
you'd recommend over its `next:`.

One AskUserQuestion with `multiSelect: true`. Each option: the `feature` as the label; its
`manifest.state` and `nextStep` as the description — for a parked row, `parked — <why, cut to
fit> · picking it unparks and retries`. **More than four offerable** → offer the four most recently touched
(`updatedAt`), and say in the question that any others can be named with
`/builder:fleet <feature> <feature>…`. Nothing picked → stop.

## 3. Check, confirm, launch

```bash
node <builder>/scripts/fleet.mjs <picked features> --dry-run
```

Print it verbatim. A `✗` pick → say what fixes it (a feature whose branch is checked out in this
folder: switch branches, or just `/builder:resume` it here). If no pick survives, stop.

Then `/builder:fleet` §3 (the one confirmation), §4 (launch detached, `--detach`) and §5 (the report
when it finishes), with the picks as the arguments.

~~~
📍 agents: <n> feature(s) running — next: /builder:fleet --status
~~~

When a fleet is already running, the dry run says `adds to the running fleet (pid N)`: the
confirmation is **Add to the running fleet** / **Not now**, the command runs in the foreground and
returns at once, and the footer is `/builder:fleet` §4's `added` line. The running fleet starts each
pick as a lane frees; `/builder:fleet --status` shows the queue.
