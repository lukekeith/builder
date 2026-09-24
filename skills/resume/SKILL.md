---
name: resume
description: Where a feature stands and the one next step — reads docs/features/<feature>/MANIFEST.md and drives the family from there: align → audit → the decisions gate → plan → the go-ahead → build (one app per phase) → 🔒 the walk → signoff → verify → ship, pausing only at real human decisions. Invoked without --path it is the picker over every in-flight feature and program, and it is what converts a pre-builder numbered suite. Never sizes or designs new work — that is /builder:brainstorm — and never creates a branch, worktree or ticket, or opens a PR before the human has personally tested the feature. Resumable after any /clear. Use only when explicitly invoked via /builder:resume.
disable-model-invocation: true
---

# `/builder:resume` — where a feature stands, and the next step

Invocation: **`/builder:resume [--path <folder|file>] [--ticket <monday id>] [--auto] [--help]`**.
Flags: [REFERENCE](REFERENCE.md) §Flags — flags first, and **ignore any flag this step does not use
rather than erroring on it**.

**`--help` first.** If it is present, render the `builder:help` card
(`plugins/builder/skills/help/SKILL.md`) and stop — no picker, nothing written.

**This command never sizes or designs anything.** New work — free text, a `--size`, a `--ui2` ref with
no folder behind it — is `/builder:brainstorm`'s: hand it there verbatim, flags included, and stop.
`/builder:resume` picks up a feature that already has a folder: it reads the manifest, names the state,
runs the next step, and keeps going until a human gate. Formats, gates, house rules and every shape a
step writes live in [REFERENCE.md](REFERENCE.md) — **this file is the flow, REFERENCE is the facts**.

🔴 **Building the feature outranks recording it** (REFERENCE §The first principle). Git history is the
full record; the working tree keeps only what a future reader needs.

## The order (md and lg)

```
design → (align) → audit → [decisions] → plan → [go-ahead] → build → 🔒 walk + sign-off → verify → ship
              ↑ prototype mode only        one app per phase, server before its consumers ↑
```

Why the walk precedes verify: the deep pass in this monorepo needs the server, the client, a simulator
and the capture stack up at once. It is the most expensive thing the pipeline runs, and a human spots
in seconds what it takes twenty minutes to discover — so the expensive pass runs once, on a build they
have already accepted.

Why one app per phase: the apps have one direction of dependency (server produces, client and iPhone
consume) and the consumers never import each other. A phase that touches two apps cannot be gated,
because each app's gates are different commands — and a consumer built against an unverified contract
is how a shipped iPhone build breaks.

## Step 1 — Detect state

Read **`<folder>/MANIFEST.md` and nothing else on entry except the SPEC sections the table names**
(REFERENCE §MANIFEST.md) — §Decisions for an OPEN row, §Findings & risks for a `blocked:` row, and
`## Fixes` for an open `- [ ]`, each read only when the row it keys reaches them. It is ~12 lines, it
commits at every transition, and it outranks anything remembered from the session; trust its `next:`
line and spot-verify that line against the artifact it names. `--path` may point at the folder, its
`SPEC.md` or its `PROGRAM.md`. **Free text alongside `--path` is a change to an existing feature**, not
a new design: it takes the table's last row.

**No `MANIFEST.md`** means one of three things, checked in this order: a `SPEC.md` header carrying
`✅ SHIPPED` → DONE; a `README.md` whose `**Status:**` line opens `SHIPPED` → also DONE; otherwise a
**pre-builder layout** — the numbered `/build-spec` suite, or an older prose folder. Such a folder does
not run on the new rules: say which layout it is, and offer **the conversion** (REFERENCE §Condense,
*Legacy layouts*) as the one action. `node .claude/scripts/list-feature-specs.mjs` marks these rows
with the conversion in their `next:` column.

| The manifest says | Next |
|---|---|
| SPEC header `✅ SHIPPED`, or no manifest and a shipped README | ⛔ **DONE — run no step.** Print the header line; follow-on work is a new feature: `/builder:brainstorm --size md <the new thing>` |
| **no manifest, and a numbered or prose suite on disk** | §Converting a pre-builder suite — the one action offered |
| `tier: program` | §Programs — route on its `child:` lines |
| `state: spec` **and** `ui2:` carries a ref (anything but `none`) | `/builder:align --path <folder>` |
| `state: spec` **and** `ui2: none`, or `state: aligned` | `/builder:audit --path <folder>` |
| `state: audited` **and** SPEC §Decisions has an OPEN row | §The decisions gate |
| `state: audited` **and** SPEC §Findings & risks has a `blocked:` row | ⛔ name each row and the clearer it carries; the plan step refuses to run until they are gone. A `build-time risk` row is not a blocker |
| `state: audited`, no OPEN row, no `blocked:` row | `/builder:plan --path <folder>` |
| `state: planned` **and** `go-ahead: none` | §The go-ahead |
| `state: planned` with a go-ahead, or `state: building` | `/builder:build --path <folder>` — it resumes from the ledger, not from memory |
| `state: built` **and** SPEC `## Fixes` has an open `- [ ]` | the walk found problems — §Working `## Fixes`, then re-walk what changed. A PROBLEMS or PARTIAL verdict moves neither `state:` nor `walk:`, so the open task IS the signal |
| `state: built`, `walk: none`, no open `## Fixes` row | 🔒 stop — §The walk |
| `state: signed-off` **and** `verify: none` | `/builder:verify --path <folder>` |
| `verify: INCOMPLETE` | §Working `## Fixes`, then `/builder:verify --path <folder>` again — scoped |
| `verify: READY` **and** the manifest's `head` is already an ancestor of `origin/main` | it shipped inside someone else's PR — **no second PR**. §Ship's first check |
| `verify: READY`, `hold: none`, `pr: none` | §Ship |
| `hold:` set | 🛑 **parked** — local gates only (`/code-review`, the fast sets). Nothing pushes; the hold is the human's to lift |
| `pr: #N` open, SPEC header not yet `SHIPPED` | `/builder:ship --path <folder>` **on the open PR** — the SPEC header flips to SHIPPED citing #N, the manifest and the workspace go, the commit rides the PR; then poll CI with `/monitor-ci`. Merging is the user's call |
| **a requirement changed · a ruling reversed · a conflict surfaced** — at any state | `/builder:revise --path <folder> <the change>` first, then re-enter this table |

`pr:` is written **here**, by §Ship, once the PR is open. `hold:` and the sign-off header are
`/builder:signoff`'s alone; this command never writes either.

## Converting a pre-builder suite

A folder with no `MANIFEST.md` but a numbered `/build-spec` suite — `README.md` +
`01-architecture.md` … `08-testing.md` + `09-gaps-and-decisions.md`, often with `10+-phase-N-*.md`
docs — or an older prose folder, was started under the pipeline this family replaced. **It is not
broken and its analysis is not wasted**: the conversion writes the two files this pipeline reads and
leaves every numbered doc exactly where it is.

Follow **REFERENCE §Condense, *Legacy layouts*** — the four-step recipe there is the procedure, and it
is cited rather than restated so a fix lands in one place. In summary: write `MANIFEST.md` from what
the suite already records, write `SPEC.md` as the index that points at the numbered docs for detail,
leave the phase docs alone as the plan, record the conversion, commit
`docs(<feature>): convert to the builder layout`.

🔴 **Do not rewrite the content, and do not delete a numbered doc.** The suite's analysis is the
expensive part. Present the conversion, take one explicit approval — it changes how a folder is driven
from now on — and then re-enter Step 1 on the converted folder in the same turn.

```
📍 <feature>: converted to SPEC.md + MANIFEST.md (<n> numbered docs left in place) — next: /builder:resume --path <folder>
```

## The decisions gate (human, unconditional)

Present every OPEN row from SPEC §Decisions in **one AskUserQuestion** — recommendation first, related
rows folded into the same message. **Translate each answer into an implementable statement** before it
becomes the row's Ruling; REFERENCE §SPEC.md's §Decisions comment block says what that means. An answer
given as "yes, do that", or one carrying an "etc.", is not yet a ruling: write the version a later
session can check code against, and read it back when the translation added anything that was not said.
🔴 **Never quote the user's words as the ruling** — operationalize them into a closed list, a measured
value or an enumerated set of deviations. Then apply the consequences to the SPEC sections the ruling
touches, fill `Who / date`, and move on. A ruling is never deleted — it is superseded in place, with a
date. Under `--auto` this gate takes recommendations (§`--auto`).

**The internal letters are internal.** `G#`, `D#`, `O#`, `C#`, `X#`, `T#`, `SC#`, `S#`, `N#` exist so
rows never collide and the scripts can grep them. When rows are put to the user they are renumbered
1, 2, 3… in display order and the ledger id becomes a trailing note. A reader should never have to
learn what `X` means to answer a question.

## The go-ahead (human, unconditional)

One approval covers the whole build, and it belongs to the plan step: `/builder:plan` ends by
presenting `PLAN.md`'s `## Phases` table as it stands — `Phase · App · Tasks · Goal · Gates` — with the
totals, the path to read the plan itself at, and anything riding along as a named risk, and takes the
approval through plan mode's `ExitPlanMode`. A manifest left at `state: planned` with `go-ahead: none`
is picked up by **`/builder:build --path <folder>`**, which presents that same table itself and takes
the approval before its first dispatch. **This command never presents a phase table of its own** — one
artifact, one approval. A human may also record it by typing `/builder:signoff --path <folder>`, which
labels it GO-AHEAD (build) and touches neither the SPEC header nor the PR lock. Later phases inside an
approved plan proceed without re-asking.

## 🔒 The walk (before the deep pass)

1. **Fast gates only, for the apps the build touched** (REFERENCE §Quality gates) — ⛔ not the
   cross-app E2E walk, not the full `/compare` sweep. The build step ran them at the last phase close;
   re-run what a commit since then can turn red.
2. **Print the walk script.** The build wrote it to `walk.md` in the SDD workspace —
   `.claude/scripts/build-spec-workspace.sh <feature>` prints that folder, and the path is re-resolved
   inline in every command that uses it, because a shell variable does not survive between Bash calls.
   Missing → write it now: **per app**, since a four-app feature is walked in two or three places —
   the URL or the simulator screen, what to tap, what to look for **newest-first**, and the local facts
   the human needs (which port: client docker `:8001`, host artisan `:8002`, server `:3010`; SMS
   verification codes come from the **api container logs**, never a database reset; which seeded org;
   which surfaces cannot work locally).
3. **Wait.** Say plainly what has and has not been human-tested, and on which app.
4. The verdict is recorded by **`/builder:signoff --path <folder> <your words>`** — the human types it,
   and a sign-off written by an agent is void. PASS condenses the folder and unlocks verify; PASS with
   `--hold "<reason>"` records the sign-off and parks the PR; problems become `## Fixes` tasks and the
   lock stays closed.

## Working `## Fixes`

`## Fixes` is the last section of the SPEC (REFERENCE §SPEC.md) and holds the `- [ ]` tasks a PROBLEMS
walk, a verify INCOMPLETE, a review or a declined re-walk left behind. Each is worked like a build task
— its recipe skill read first, its test shipping with it, one commit each — in the main context: the
build step runs only at `state: planned` or `building` and declines anything past it. **Each fix names
its app**, and a fix that crosses an app boundary is not a fix: it is a contract change and goes through
`/builder:revise --path <folder>` first.

**Where it goes back to depends on which list it came from.** Tasks from a PROBLEMS or PARTIAL walk
(`state: built`, no sign-off yet) end with the human re-walking what changed and typing
`/builder:signoff --path <folder> <their words>` — tick each `- [ ]` as it lands, so the row that
routed you here stops firing. Tasks from a verify INCOMPLETE (already signed off) end at
`/builder:verify --path <folder>` again — **scoped**, per its §A re-verify is SCOPED — plus a re-walk
of any signed-off surface the fix changed.

## Programs (`tier: program`)

A program manifest tracks one `child: <name> — <state>` line per child instead of a state of its own.

**Pick the child the same way the picker picks a feature.** Present the `child:` lines in one
AskUserQuestion — the child's name as the label, its state as the description — ordered by PROGRAM
§Children's *Depends on* column, and recommend the next **unblocked** child: one whose dependencies all
read `— shipped`. On selection, continue at Step 1 with `--path docs/features/<child>` — or, when that
child has no folder yet, run `/builder:brainstorm --path docs/features/<child>` as below.

- A child at `— spec` with no folder yet → `/builder:brainstorm --path docs/features/<child>`, starting
  from PROGRAM §Shared decisions: its grill is short, and its audit treats those decisions as settled
  rather than re-asking them.
- A child in flight → `/builder:resume --path docs/features/<child>`, which enters Step 1 as usual.
- **One program go-ahead** covers the decomposition and the order; each child then keeps its own three
  gates (decisions · go-ahead · the walk) and ships **one PR per child** to `main`, serial by default.
- 🔴 **A program's children are ordered by the contract, not by convenience.** A child that produces a
  contract another child consumes ships first — the same rule the phases follow, one level up.
- The picker shows a program as "3/5 children shipped". When the last child ships, `/builder:ship`
  flips PROGRAM's own header — it sets the `child:` line and the parent header in the same run.

## `--auto`

Autopilot for work whose shape is already agreed (REFERENCE §Flags). It is recorded on the manifest as
`auto: on YYYY-MM-DD`, so a cold session resumes under it, and it settles these without asking:

| Pause | Under `--auto` |
|---|---|
| Scope | must already be settled by the ref or the free text; an open scope question refuses to start and prints the resolution instead |
| Committing a step's docs | commit them, with the work they describe |
| Ticket | `--ticket`, else the monday id in the current branch name; neither → say so in the hand-off and keep going |
| **The decisions gate** | every OPEN row takes its **Recommended** ruling, written as an implementable statement with decider `auto (recommended) YYYY-MM-DD`; a row with no recommendation gets one first. The human reads these rows at the go-ahead, which is where an autopilot run is checked |
| A prototype gap (design, align) | the recommended one of REFERENCE §Prototype mode's three options — and "fix it in the design" is recommended only for a bounded, mechanical fix, **never for a design change** |
| The audit finds a code defect | it becomes a build task, carried as a `build-time risk` row naming the task that settles it — never silently fixed before the go-ahead |
| **The go-ahead** | the phase table is presented in the hand-off and the run proceeds |
| **The walk** | ⛔ **the terminal state.** Print the walk script, land everything, stop |
| Committing iPhone code | ⛔ **never** — an iPhone commit is an explicit user call under any flag |
| Launching the simulator, archiving, `/deploy`, writing to monday | ⛔ **never** |

`--auto` never writes a sign-off, opens or pushes a PR, lifts a `hold:`, drops a capability users
already have, hand-edits a migration, edits a UI 2.0 contract, or widens scope. Nothing about it touches
the PR lock.

## The picker (no `--path`, no text)

Never ask "which feature?" as an open question. Run

```
node .claude/scripts/list-feature-specs.mjs --json
```

which returns `{ "features": [ … ] }` over `docs/features/`. Each row gives `feature`, `path`,
`layout` (`manifest` · `program` · `condensed` · `suite` · `legacy` · `note`), `state`, `next`, `done`,
`blocked`, `convert` (true for a pre-builder folder), plus `manifest` (the parsed key/values) or
`children` for a program. Present **one AskUserQuestion**: one option per row whose `done` is false —
the `feature` as the label, its `state` + `next` as the description — plus **New (describe it)**, which
hands the description to `/builder:brainstorm`. Rows with `done` appear only as a count. **Mark a
`convert: true` row as needing conversion** in its description, so the human knows that picking it
starts with the conversion rather than the next build step. Recommend the unblocked feature closest to
done. On selection, continue at Step 1 with that row's `path`.

## Ship

0. **Did this code already ship inside another PR?**

   ```
   git merge-base --is-ancestor <the manifest's head> origin/main
   ```

   Succeeds → **open no PR; a second PR for landed code is the defect this check exists to prevent.**
   Say so, and take the ship moment through `/builder:ship --path <folder>`, which writes SHIPPED on
   the carrying PR while it is open so its merge carries the line.
1. **Review the diff locally** — `/code-review` — and say what it found. Offered, not assumed: the
   human has already walked the feature. Skipped = say why.
2. **Open ONE PR for the whole feature**, base `main`:

   ```
   gh pr create --base main --title "<type>(<ticket-or-feature>): <feature>" --body "<the SPEC header's sign-off line + what changed per app>"
   ```

   🔴 It runs only on a sign-off with no hold, and only on a branch that is not `main`. **One PR for
   the feature, never one per phase** — a phase is one app, and the apps ship together or the contract
   is live in production with only half its consumers.
3. **Write `pr: #N` to the manifest yourself and commit it** — a `pr:` line nobody wrote leaves the
   next session polling nothing:

   ```
   gh pr view --json number --jq .number
   ```

   then `pr: #<n>` plus `next: /monitor-ci, then /builder:ship --path <folder>`.
4. **Poll CI** — `/monitor-ci`. Merging is the user's call.
5. **On the open PR:** `/builder:ship --path <folder>` flips the SPEC header to SHIPPED, removes
   `MANIFEST.md` and deletes the SDD workspace. It is written ON the PR so the merge carries it.
6. **Reporting back to monday is a separate, explicit call** — `/monday-resolve`. This family never
   writes to the ticket.

### 🔒 The PR lock (binding on every skill in this family)

**No `/builder:*` skill may open, reopen, or push toward a PR until the human has personally
exercised the finished feature in the running app and said, in their own words, that it works.**
A green gate run, a clean `/compare` diff or a code review is evidence for the human — never their
sign-off. In doubt = you don't have it: ask. "It works" and "open the PR" are two different
permissions — a sign-off can carry `🛑 PR HELD`.

🔴 **The iPhone half of the lock is stricter still.** Committing iPhone code, launching the simulator
and archiving are explicit user calls at every size and under every flag — because an iPhone build
that reaches TestFlight cannot be hot-fixed, and the pipeline's agents cannot see the device.

## Step-end handoff (after every step, and on every pause)

1. **What just happened** — two to four plain sentences, no session shorthand.
2. **The next action as a copy/paste command**, or the file, the exact edit and the command to re-run.
3. **Then KEEP GOING.** 🔴 A step that ends with work still to do and no decision pending continues
   into the next one in the same turn. Stop only for a real decision; the two unconditional gates and
   the PR lock; something destructive or outward-facing; an iPhone commit; or context running out —
   then land the current phase, write the manifest, commit, and hand off with *"run `/clear`, then
   `/builder:resume --path <folder>`"*. Prefer stopping at a clean boundary over running out
   mid-phase. A blocked task is not a stop: start the next startable one.
4. **One-line resume footer** naming the command that does the NEXT work — not always
   `/builder:resume`: after the build it is `/builder:signoff`, then `/builder:verify`, then
   `gh pr create`, then `/monitor-ci`; on a hold there is no command, because the pipeline is parked on
   the human's call.

   ```
   📍 <feature>: <state> — next: <command>
   ```

## Context survival

State lives in two places, and neither is the conversation: the committed `SPEC.md` + `MANIFEST.md`, and
the git-ignored SDD workspace (REFERENCE §Where things live) that holds the ledger, the briefs, the
reports and `walk.md`. A discovery that must outlive the session goes into a file the moment it matters
— a ruling → SPEC §Decisions, something a later phase must know → SPEC §Findings & risks, an
environment fact that cost time → the ledger's `env notes`, a mid-build stop → a ledger line plus the
manifest. Everything else stays in conversation. Docs commit with the work they describe, never as
their own commit.

## Ground rules

- **One feature per run.** One PR for the whole feature, after the sign-off — never a PR per phase.
- **One app per phase, server before its consumers.** The contract freezes when the server phase
  verifies (REFERENCE §Contract and the contract freeze).
- **Read-only against the app:** design, align, audit and plan. Only the build, the `## Fixes` work and
  `/builder:revise` change `server/**`, `client/**`, `iphone/**` or `capture/**`.
- **Never write a UI 2.0 contract, registry row, note or open question** — `/ui2-*` and `/d2m-*` own
  those, and a note is normative owner input read with `node capture/lib/ui2-notes.mjs read`.
- **Never write to monday.com.** `/monday-resolve` is the explicit call that does.
- Follow the companion skills REFERENCE §Companion skills names; a skipped one is said out loud with
  its reason.
- Deploys are never part of the pipeline — `/deploy` is the user's own command.
