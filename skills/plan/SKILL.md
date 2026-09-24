---
name: plan
description: Turn an audited feature spec into a committed implementation plan at the feature folder's PLAN.md — dependency-ordered phases, ONE APP PER PHASE with the producer before its consumers (contract + migrations → producer → consumers in parallel → tools → the cross-app E2E walk last), each task naming its app, its phase, the recipe skill to read first, its files and interfaces, and bite-sized steps carrying the actual code and tests. SPEC §Plan becomes a one-line-per-task index pointing at PLAN.md. Runs only after /builder:audit, with no OPEN decisions and no blocked findings. Ends by taking the build go-ahead and recording it on the manifest. Use when the user asks to plan a spec's implementation.
---

# `/builder:plan` — the audited spec becomes phases

Invocation: **`/builder:plan --path <folder> [--ticket <id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — **ignore any flag this step does not use rather than
erroring on it**.

**Load these three before writing anything**, and cite them rather than restate them:
[`PLAN-FORMAT.md`](PLAN-FORMAT.md) (the shape of the file this step writes) · REFERENCE (§Sizes for
the phase counts · §Contract and the contract freeze, which the phase ORDER exists to protect ·
§MANIFEST.md · §Branch and ticket) · **`.claude/builder.md`** (§Quality gates for every `Gates` cell,
§Global constraints for the plan's header block, §Companion skills for every `Recipe:` line).

Input: `<folder>/SPEC.md` + `MANIFEST.md`. Output: `<folder>/PLAN.md`, the §Plan index appended to
that SPEC, the manifest at `state: planned`, and the go-ahead taken in the same turn. **No app code
is written here.**

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `audited`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `state: spec` or `aligned` | not audited yet. One line naming the state, hand back, stop |
| `state: audited` **and** §Decisions has an OPEN row | the decisions gate owns it. Name the OPEN rows, hand back, stop |
| `state: audited` **and** §Findings has a `blocked:` row | name the row and the clearer it carries, hand back, stop |
| `state: audited`, no OPEN row, no `blocked:` row | run |
| `state:` `planned` or further along | already planned. Say so naming the state, hand back, stop |

```
📍 <feature>: <manifest state> — not planned: <reason> — next: <the command the row names>
```

⛔ **A §Findings row marked `build-time risk` is not a blocker and never a reason for another audit
pass** — the cap is spent. Each names the phase or task that settles it; **copy the note onto that
task** so it arrives with the work.

## What the plan is

One committed file, `<folder>/PLAN.md`, holding the tasks **and the code they carry** — the human
reads it at the go-ahead, a reviewer sees it in the PR, and the sign-off condense deletes it with
`git log` keeping it. The plan is never inside the SPEC: the SPEC gets a §Plan index only.

**Its shape is [`PLAN-FORMAT.md`](PLAN-FORMAT.md)** — write what that file specifies, reading it
there. In short: the header (Goal · Architecture · Tech Stack · Spec) · `## Global Constraints`
copied verbatim from the config · the `## Phases` table (`Phase · App · Tasks · Goal · Gates`) ·
then flat `### Task N` blocks carrying `App:`, `Phase:`, `Recipe:`, **Files**, **Interfaces** and
bite-sized `- [ ]` steps with the actual code, the run command and the commit.

- **Task numbering runs across the whole plan** — `task-brief` keys on the literal `Task N` heading.
- **Every task names the recipe skill to read FIRST** on its `Recipe:` line (the config's §Companion
  skills) **and ships the tests that belong to it**. Tests are never a later task or phase.
- **The `Gates` cell is that phase's app's fast set** from the config — never another app's, never the
  deep set, never the cross-app walk.
- **A phase must fit one session.** Above that, split it.

## 🔴 One app per phase, the producer before its consumers

**The binding rule of this pipeline's phase derivation.** A phase names exactly one app on every
task's `App:` line and in the table's `App` column. Two reasons, both load-bearing:

1. **Each app's gates are different commands.** A phase touching two apps cannot be gated — one app's
   typecheck says nothing about the other's. A phase whose gates cannot close is a phase that closes
   on a feeling.
2. **The contract freezes when the producer's phase verifies.** Consumers built against a moving
   contract are how one of them ships broken — and where the config marks an app
   `released_artifact: true`, that one cannot be hot-fixed.

The order that follows, from the config's `apps:` roles:

| Order | Role | Why it is here |
|---|---|---|
| 1 | **contract + migrations** | the schema/interface changes, in the Data plan's ordering. Its own phase when there are several; folded into the producer's phase when there is one |
| 2 | **producer** | produces the contract; nothing consumes it yet. 🔴 **Its close is the freeze** — record `contract: frozen <date>` on the manifest at that phase close |
| 3 | **consumers** | code against the frozen contract, **parallelizable when they don't import each other**. Order them by risk: a `released_artifact` consumer first, since its findings are the expensive ones |
| 4 | **tools** | read the consumers, so they come after them |
| 5 | **the cross-app E2E walk (LAST)** | 🔴 authored here and run only by `/builder:verify`. Never an E2E task or gate in an earlier phase |

A single-app feature has one or two phases and none of this bites. It bites on every feature that
doesn't.

## Deriving the phases

Within the app order above, the skeleton per app comes from **that app's §House rules in the
config** — its layers, its state shape, its test policy — not from a list this plugin could guess.
Read the config's section for the app, and order the phase's tasks the way that app's own
architecture demands: the thing that owns the logic before the thing that exposes it, state before
the screens that read it, tests inside the task that earns them.

**Prototype mode uses the same order**, and its tasks come from the spec rather than from re-reading
the app: the producer phase from §Findings' `T#` rows and §Schema & API changes, the consumer phases
from their §<App> sections and §Contract, and a **repoint + retire phase per app** from §Findings'
`repoint:` rows — each already tagged with its owning app by the audit. That phase's tasks are: one
per `repoint:` row with its `file:line` sites listed; **the retirement list as its own task and its
own commit**; §Prototype's frozen paths respected absolutely; then a **residual-sweep task** per app
— re-grep every retired string and import to **zero hits**, with behavioural test guards on a retired
surface **ported, not deleted**. A `repoint:` row with no sites still gets its task: the task is the
re-grep that proves it.

Where the spec owes a **new shared component**, it is the plan's **first** phase and blocks every
consumer phase below it — or, where the project has a design registry, the first task is routing it to
the command that owns that registry, not building it inline.

## Size dials

**`size: md` → 2–4 phases; `size: lg` → 4–7.** Merge adjacent phases **of the same app** until the
plan lands inside the dial, and split a phase that outgrows one session. 🔴 **Merging never crosses an
app boundary**, whatever the dial says. A four-app feature therefore has at least four phases, and
that is correct — a four-app `md` sitting at 5 phases is not oversized, it is a monorepo.

**Phases are renumbered 1..n sequentially** once merging is done. `PLAN.md` carries **no `Phase N`
heading at any level**: any heading between two task blocks is swept into the earlier task's brief.

**A plan landing at 9+ phases is a feature that should be two.** Present the split before taking any
go-ahead — by delivery slice or by domain — and proceed only on the split, or on an explicit "build
it whole". **`--auto` does not decide this**: a split creates feature folders, which is a scope
change and outside autopilot's remit; present it and stop.

## Writing the plan

1. **Derive the phases** from the SPEC in the app order above, merged and split to the dials. This
   settles the phase list, each phase's app, its goal and its gates *before* any task is written.
2. **Write the file** per [`PLAN-FORMAT.md`](PLAN-FORMAT.md), header and `## Phases` table first,
   then the task blocks in order.
3. **The checks before anything is committed:**
   - every `### Task N` block opens with an `App:` line and a `Phase:` line matching its table row;
   - every block carries a `Recipe:` line from the config's §Companion skills — or, for work with no
     recipe skill, the REFERENCE section that governs it;
   - every `## Phases` row's `Gates` cell is **that row's app's** fast set from the config;
   - 🔴 **verify the one-app rule mechanically**: no task block's `Files` list crosses two of the
     config's app paths. A task that does is split in two, one per app, and the phases re-derived;
   - the tests a task owes are in **that** task — its steps, its commit — not a later one;
   - every §Findings row marked `build-time risk` is **copied onto the task that settles it**;
   - **the producer phase's last task records the freeze** — a step writing `contract: frozen <date>`
     to the manifest, so no consumer task starts against an open contract;
   - then PLAN-FORMAT's own §No placeholders scan and §Self-review, run over the finished file.

🔴 **Nothing follows the last task block** — no footer, no closing section, no summary, no separator.
`task-brief` reads the last task from its heading to **end of file**. The resume footer at the end of
this step is printed **in chat only** — never into `PLAN.md`.

## Hand off

**Two files.** `<folder>/PLAN.md`; and **one SPEC edit** — §Plan appended **immediately after
§Findings & risks**, an **index, not the plan**: a pointer to `PLAN.md`, then one line per task
reading `Phase N · Task M · <name>` and nothing else. Condense strips §Plan by heading, so nothing
reads it by position. Never per-phase docs.

**The manifest:** `state: planned`, `head`, `branch`, `next: /builder:resume --path <folder>`. Commit
`PLAN.md`, the SPEC and the manifest together: `docs(<ticket-or-feature>): plan <feature>`.

**Then take the go-ahead, in the same turn.** Present `PLAN.md`'s `## Phases` table as it stands —
`Phase · App · Tasks · Goal · Gates` — with the totals, the path to read the plan at, and what rides
along: the tasks carrying a `build-time risk`, **which phase freezes the contract**, and anything
deferred with a decider. Take **one explicit approval** through plan mode's `ExitPlanMode`. That
approval covers the whole build; no later phase re-asks.

- **Yes** → write `go-ahead: <name YYYY-MM-DD>` and commit:
  `chore(<ticket-or-feature>): <feature> — go-ahead`. Under `--auto` the table is presented and the
  run proceeds, recorded as `go-ahead: auto (recommended) YYYY-MM-DD`.
- **No** → leave `go-ahead: none`; `state: planned` stands. A scope objection routes to
  `/builder:brainstorm --path <folder>`; a changed requirement or reversed ruling routes to
  `/builder:revise --path <folder> <the change>`.

**Nothing here creates a branch, a worktree or a ticket.** Given `--ticket`, check the branch name
carries the key and warn once if not.

```
📍 <feature>: planned, <n> phases across <apps>, <m> tasks, go-ahead <recorded|none> — next: /builder:resume --path <folder>
```
