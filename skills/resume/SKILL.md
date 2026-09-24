---
name: resume
description: Where a feature stands and the one next step — reads the feature's MANIFEST.md and drives the family from there: align → audit → the decisions gate → plan → the go-ahead → build (one app per phase) → 🔒 the walk → signoff → verify → ship, pausing only at real human decisions. Invoked without --path it is the picker over every in-flight feature and program, and it is what converts a folder left by an earlier pipeline. Never sizes or designs new work — that is /builder:brainstorm — and never creates a branch, worktree or ticket, or opens a PR before the human has personally tested the feature. Resumable after any /clear. Use only when explicitly invoked via /builder:resume.
disable-model-invocation: true
---

# `/builder:resume` — where a feature stands, and the next step

Invocation: **`/builder:resume [--path <folder|file>] [--ticket <id>] [--auto] [--help]`**. Flags:
[REFERENCE](REFERENCE.md) §Flags — flags first, and **ignore any flag this step does not use rather
than erroring on it**.

**`--help` first.** If present, render the `builder:help` card (`../help/SKILL.md`) and stop — no
picker, nothing written.

**Read `.claude/builder.md` before anything else.** It is the only place this pipeline learns what
your project is (REFERENCE §The project's own rules). No config → say so in one line, name
`/builder:init`, and stop.

**This command never sizes or designs anything.** New work — free text, a `--size`, a design ref with
no folder behind it — is `/builder:brainstorm`'s: hand it there verbatim, flags included, and stop.
`/builder:resume` picks up a feature that already has a folder: it reads the manifest, names the
state, runs the next step, and keeps going until a human gate. Formats, gates, house rules and every
shape a step writes live in [REFERENCE.md](REFERENCE.md) — **this file is the flow, REFERENCE is the
facts, and the config is the project.**

🔴 **Building the feature outranks recording it** (REFERENCE §The first principle).

## The order (md and lg)

```
design → (align) → audit → [decisions] → plan → [go-ahead] → build → 🔒 walk + sign-off → verify → ship
              ↑ prototype mode only     one app per phase, the producer before its consumers ↑
```

**Why the walk precedes verify:** the deep pass needs every in-scope app up at once — the most
expensive thing the pipeline runs — and a human spots in seconds what it takes the deep pass twenty
minutes to discover. So the expensive pass runs once, on a build they have already accepted.

**Why one app per phase:** each app's gates are different commands, so a two-app phase cannot be
gated; and consumers built against an unverified contract are how one of them ships broken
(REFERENCE §Contract and the contract freeze).

## Step 1 — Detect state

Read **`<folder>/MANIFEST.md` and nothing else on entry except the SPEC sections the table names**
(REFERENCE §MANIFEST.md) — §Decisions for an OPEN row, §Findings & risks for a `blocked:` row, and
`## Fixes` for an open `- [ ]`, each read only when the row it keys reaches them. It is ~12 lines, it
commits at every transition, and it outranks anything remembered from the session; trust its `next:`
line and spot-verify that line against the artifact it names. `--path` may point at the folder, its
`SPEC.md` or its `PROGRAM.md`. **Free text alongside `--path` is a change to an existing feature**,
not a new design: it takes the table's last row.

**No `MANIFEST.md`** → REFERENCE §Condense, *Legacy layouts* decides which of four shapes it is, and
only one of them converts. `<builder>/scripts/list-features.mjs` marks a convertible row in its
`next:` column.

| The manifest says | Next |
|---|---|
| SPEC header `✅ SHIPPED`, or a README header opening `SHIPPED` | ⛔ **DONE — run no step.** Print the header line; follow-on work is a new feature: `/builder:brainstorm --size md <the new thing>` |
| **no manifest, and build state on disk** (phase docs, a `STATUS.md`) | §Converting a folder from an earlier pipeline — the one action offered |
| **no manifest, no build state** | not a feature yet — analysis that feeds a design conversation. Hand to `/builder:brainstorm --path <folder> <what you want built>` |
| **a `SPEC.md` with no manifest** | half-written, or a half-finished conversion. Write the missing manifest from what the SPEC records, then re-enter this table |
| `tier: program` | §Programs — route on its `child:` lines |
| `state: spec` **and** the design key carries a ref | `/builder:align --path <folder>` |
| `state: spec` with no design ref, or `state: aligned` | `/builder:audit --path <folder>` |
| `state: audited` **and** §Decisions has an OPEN row | §The decisions gate |
| `state: audited` **and** §Findings & risks has a `blocked:` row | ⛔ name each row and the clearer it carries; the plan step refuses until they are gone. A `build-time risk` row is not a blocker |
| `state: audited`, no OPEN row, no `blocked:` row | `/builder:plan --path <folder>` |
| `state: planned` **and** `go-ahead: none` | §The go-ahead |
| `state: planned` with a go-ahead, or `state: building` | `/builder:build --path <folder>` — it resumes from the ledger, not from memory |
| `state: built` **and** SPEC `## Fixes` has an open `- [ ]` | the walk found problems — §Working `## Fixes`, then re-walk what changed. A PROBLEMS or PARTIAL verdict moves neither `state:` nor `walk:`, so the open task IS the signal |
| `state: built`, `walk: none`, no open `## Fixes` row | 🔒 stop — §The walk |
| `state: signed-off` **and** `verify: none` | `/builder:verify --path <folder>` |
| `verify: INCOMPLETE` | §Working `## Fixes`, then `/builder:verify --path <folder>` again — scoped |
| `verify: READY` **and** the manifest's `head` is already an ancestor of the remote base branch | it shipped inside someone else's PR — **no second PR**. §Ship's first check |
| `verify: READY`, `hold: none`, `pr: none` | §Ship |
| `hold:` set | 🛑 **parked** — local gates only. Nothing pushes; the hold is the human's to lift |
| `pr: #N` open, SPEC header not yet `SHIPPED` | `/builder:ship --path <folder>` **on the open PR**, then watch CI. Merging is the user's call |
| **a requirement changed · a ruling reversed · a conflict surfaced** — at any state | `/builder:revise --path <folder> <the change>` first, then re-enter this table |

`pr:` is written **here**, by §Ship, once the PR is open. `hold:` and the sign-off header are
`/builder:signoff`'s alone; this command never writes either.

## Converting a folder from an earlier pipeline

A folder with no `MANIFEST.md` but **build state on disk** was driven by something before this. **It
is not broken and its analysis is not wasted**: the conversion writes the two files this pipeline
reads and leaves every existing doc where it is.

Follow **REFERENCE §Condense, *Legacy layouts*** — the four-step recipe there is the procedure, cited
rather than restated so a fix lands in one place.

🔴 **Two things that recipe insists on, because getting them wrong is expensive:** do not rewrite or
delete the existing docs, and **do not translate a prior pipeline's "verified" into a sign-off**.
The walk here comes *before* the deep pass, so a pre-walk verdict is not one of ours — write
`walk: none`, say plainly in the SPEC that nobody has exercised it, and let the human spend the gate.

Present the conversion, take one explicit approval — it changes how the folder is driven from now on
— then re-enter Step 1 on the converted folder in the same turn.

```
📍 <feature>: converted to SPEC.md + MANIFEST.md (<n> existing docs left in place) — next: /builder:resume --path <folder>
```

## The decisions gate (human, unconditional)

Present every OPEN row from SPEC §Decisions in **one AskUserQuestion** — recommendation first,
related rows folded into the same message. **Translate each answer into an implementable statement**
before it becomes the row's Ruling; REFERENCE §SPEC.md's §Decisions comment block says what that
means. An answer given as "yes, do that", or one carrying an "etc.", is not yet a ruling: write the
version a later session can check code against, and read it back when the translation added anything
that was not said. 🔴 **Never quote the user's words as the ruling** — operationalize them into a
closed list, a measured value or an enumerated set of deviations. Then apply the consequences to the
SPEC sections the ruling touches, fill `Who / date`, and move on. A ruling is never deleted — it is
superseded in place, with a date. Under `--auto` this gate takes recommendations (§`--auto`).

**The internal letters are internal.** `D#`, `T#`, `SC#`, `S#`, `N#` exist so rows never collide and
the scripts can grep them. When rows are put to the user they are renumbered 1, 2, 3… in display
order and the ledger id becomes a trailing note. A reader should never have to learn what `N` means
to answer a question.

## The go-ahead (human, unconditional)

One approval covers the whole build, and it belongs to the plan step: `/builder:plan` ends by
presenting `PLAN.md`'s `## Phases` table — `Phase · App · Tasks · Goal · Gates` — with the totals,
the path to read the plan at, and anything riding along as a named risk, and takes the approval
through plan mode's `ExitPlanMode`. A manifest left at `state: planned` with `go-ahead: none` is
picked up by **`/builder:build`**, which presents that same table itself before its first dispatch.
**This command never presents a phase table of its own** — one artifact, one approval. A human may
also record it by typing `/builder:signoff --path <folder>`, which labels it GO-AHEAD (build) and
touches neither the SPEC header nor the PR lock.

## 🔒 The walk (before the deep pass)

1. **Fast gates only, for the apps the build touched** (the config's §Quality gates) — ⛔ not the
   cross-app walk, not the full deep set. The build ran them at the last phase close; re-run what a
   commit since then can turn red.
2. **Print the walk script.** The build wrote it to `walk.md` in the workspace
   (`<builder>/scripts/workspace <feature>` prints the directory; re-resolve it inline in every
   command). Missing → write it now: **per app**, since a multi-app feature is walked in more than
   one place — where to go, what to do, what to look for **newest-first**, and the local facts the
   human needs, taken from the config's §Environment landmines.
3. **Wait.** Say plainly what has and has not been human-tested, and on which app.
4. The verdict is recorded by **`/builder:signoff --path <folder> <your words>`** — the human types
   it, and a sign-off written by an agent is void. PASS condenses the folder and unlocks verify;
   PASS with `--hold "<reason>"` records the sign-off and parks the PR; problems become `## Fixes`
   tasks and the lock stays closed.

## Working `## Fixes`

`## Fixes` is the SPEC's last section and holds the `- [ ]` tasks a PROBLEMS walk, a verify
INCOMPLETE, a review or a declined re-walk left behind. Each is worked like a build task — its recipe
skill read first, its test shipping with it, one commit each — in the main context: the build step
runs only at `state: planned` or `building`. **Each fix names its app**, and a fix crossing an app
boundary is not a fix: it is a contract change and goes through `/builder:revise` first.

🔴 **The craft skills bind here too, and this is where they are most often skipped** — the work is in
the main context, with no implementer brief to carry them. A row that came from a review is read
through [`receiving-code-review`](../receiving-code-review/SKILL.md) before it is acted on; a row
describing a symptom is a [`systematic-debugging`](../systematic-debugging/SKILL.md) job before it is
a code change; each fix ships its failing test first
([`test-driven-development`](../test-driven-development/SKILL.md)); and a row is ticked only on
evidence run in that message
([`verification-before-completion`](../verification-before-completion/SKILL.md)). 🔴 A fix in
an app the config marks `commit: manual` is staged and left for the human, like any other commit
there.

**Where it goes back to depends on which list it came from.** Tasks from a PROBLEMS or PARTIAL walk
(`state: built`, no sign-off yet) end with the human re-walking what changed and typing
`/builder:signoff` — tick each `- [ ]` as it lands, so the row that routed you here stops firing.
Tasks from a verify INCOMPLETE (already signed off) end at `/builder:verify --path <folder>` again —
**scoped**, per its §A re-verify is SCOPED — plus a re-walk of any signed-off surface the fix changed.

## Programs (`tier: program`)

A program manifest tracks one `child: <name> — <state>` line per child instead of a state of its own.

**Pick the child the way the picker picks a feature.** Present the `child:` lines in one
AskUserQuestion — the child's name as the label, its state as the description — ordered by PROGRAM
§Children's *Depends on* column, and recommend the next **unblocked** child: one whose dependencies
all read `— shipped`. On selection, continue at Step 1 with that child's path.

- A child at `— spec` with no folder yet → `/builder:brainstorm --path <registry>/<child>`, starting
  from PROGRAM §Shared decisions: its grill is short, and its audit treats those as settled.
- A child in flight → `/builder:resume --path <registry>/<child>`.
- **One program go-ahead** covers the decomposition and the order; each child then keeps its own
  three gates and ships **one PR per child**, serial by default.
- 🔴 **Children are ordered by the contract, not by convenience** — a child producing a contract
  another consumes ships first.
- The picker shows a program as "3/5 children shipped". When the last child ships, `/builder:ship`
  flips PROGRAM's own header.

## `--auto`

Autopilot for work whose shape is already agreed. Recorded on the manifest as
`auto: on YYYY-MM-DD`, so a cold session resumes under it, and it settles these without asking:

| Pause | Under `--auto` |
|---|---|
| Scope | must already be settled by the ref or the free text; an open scope question refuses to start and prints the resolution instead |
| Committing a step's docs | commit them, with the work they describe |
| Ticket | `--ticket`, else the key in the current branch name; neither → say so in the hand-off and keep going |
| **The decisions gate** | every OPEN row takes its **Recommended** ruling, written as an implementable statement with decider `auto (recommended) YYYY-MM-DD`; a row with no recommendation gets one first. The human reads these at the go-ahead, which is where an autopilot run is checked |
| A prototype gap | the recommended one of REFERENCE §Prototype mode's three options — "fix it in the design" only for a bounded, mechanical fix, **never a design change** |
| The audit finds a code defect | it becomes a build task carried as a `build-time risk` row naming the task that settles it — never silently fixed before the go-ahead |
| **The go-ahead** | the phase table is presented in the hand-off and the run proceeds |
| **The walk** | ⛔ **the terminal state.** Print the walk script, land everything, stop |
| A commit in an app the config marks `commit: manual` | ⛔ **never** — staged and left for the human under every flag |

`--auto` never writes a sign-off, opens or pushes a PR, lifts a `hold:`, drops a capability users
already have, edits the design, or widens scope. Nothing about it touches the PR lock.

## The picker (no `--path`, no text)

Never ask "which feature?" as an open question. Run

```
node <builder>/scripts/list-features.mjs --json
```

Each row gives `feature`, `path`, `layout`, `state`, `next`, `done`, `blocked`, `convert`, plus
`manifest` or `children`. Present **one AskUserQuestion**: one option per row whose `done` is false —
the `feature` as the label, its `state` + `next` as the description — plus **New (describe it)**,
which hands the description to `/builder:brainstorm`. Rows with `done` appear only as a count. **Mark
a `convert: true` row as needing conversion**, so the human knows picking it starts there. Recommend
the unblocked feature closest to done. On selection, continue at Step 1 with that row's `path`.

## Ship

0. **Did this code already ship inside another PR?**
   `git merge-base --is-ancestor <the manifest's head> origin/<base_branch>` succeeds → **open no
   PR**; take the ship moment through `/builder:ship --path <folder>` on the carrying PR while it is
   open, so its merge carries the line.
1. **Review the diff locally** with whatever the config's §Companion skills names for review.
   Offered, not assumed — the human has already walked it. Skipped = say why.
2. **Open ONE PR for the whole feature**, base the config's `base_branch`:
   `gh pr create --base <base_branch> --title "<type>(<ticket-or-feature>): <feature>" --body "<the
   SPEC header's sign-off line + what changed per app>"`.
   🔴 Only on a sign-off with no hold, and only on a branch that is not the base. **One PR for the
   feature, never one per phase** — a phase is one app, and the apps ship together or the contract
   is live with only half its consumers.
3. **Write `pr: #N` to the manifest yourself and commit it** — `gh pr view --json number --jq
   .number` — plus `next: watch CI, then /builder:ship --path <folder>`. Nothing else writes that line.
4. **Watch CI.** Merging is the user's call.
5. **On the open PR:** `/builder:ship --path <folder>` flips the SPEC header to SHIPPED, removes
   `MANIFEST.md` and deletes the workspace.
6. **Reporting back to the ticket system is a separate, explicit call** — the config's §Companion
   skills names it. This family never writes to a ticket.

### 🔒 The PR lock (binding on every skill in this family)

**No `/builder:*` skill may open, reopen, or push toward a PR until the human has personally
exercised the finished feature in the running app and said, in their own words, that it works.**
A green gate run or a code review is evidence for the human — never their sign-off. In doubt = you
don't have it: ask. "It works" and "open the PR" are two different permissions — a sign-off can carry
`🛑 PR HELD`.

🔴 **Where the config marks an app `commit: manual`, the lock is stricter still**: committing there
is an explicit user call at every size and under every flag — typically because that app produces a
released artifact nobody can hot-fix.

## Step-end handoff (after every step, and on every pause)

1. **What just happened** — two to four plain sentences, no session shorthand.
2. **The next action as a copy/paste command**, or the file, the exact edit, and the command to
   re-run.
3. **Then KEEP GOING.** 🔴 A step ending with work still to do and no decision pending continues into
   the next in the same turn. Stop only for a real decision; the two unconditional gates and the PR
   lock; something destructive or outward-facing; a manual-commit app; or context running out — then
   land the current phase, write the manifest, commit, and hand off with *"run `/clear`, then
   `/builder:resume --path <folder>`"*. Prefer stopping at a clean boundary over running out
   mid-phase. A blocked task is not a stop: start the next startable one.
4. **One-line resume footer** naming the command that does the NEXT work — not always
   `/builder:resume`: after the build it is `/builder:signoff`, then `/builder:verify`, then the PR.
   On a hold there is no command, because the pipeline is parked on the human's call.

   ```
   📍 <feature>: <state> — next: <command>
   ```

## Context survival

State lives in two places, and neither is the conversation: the committed `SPEC.md` + `MANIFEST.md`,
and the git-ignored workspace holding the ledger, the briefs, the reports and `walk.md`. A discovery
that must outlive the session goes into a file the moment it matters — a ruling → SPEC §Decisions,
something a later phase must know → SPEC §Findings & risks, an environment fact that cost time → the
ledger's `env notes`, a mid-build stop → a ledger line plus the manifest. Docs commit with the work
they describe, never as their own commit.

## Ground rules

- **One feature per run.** One PR for the whole feature, after the sign-off.
- **One app per phase, the producer before its consumers.** The contract freezes when the producer's
  phase verifies.
- **Read-only against the code:** design, align, audit and plan. Only the build, the `## Fixes` work
  and `/builder:revise` change app code.
- **Never write the design source, and never write to the ticket system** — the config names who owns
  each.
- Follow the recipe skills the config's §Companion skills names; a skipped one is said out loud with
  its reason.
- Deploys are never part of the pipeline.
