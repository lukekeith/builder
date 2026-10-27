---
name: resume
description: Shows where a builder feature stands and runs its next step, pausing only for real human decisions; with no --path it lists everything in flight. Use when the user asks to continue or resume builder work, or answers a builder footer with "go", "yes", "step by step" or "in this session" — on a footer that offers Agent, "go" is /builder:agent.
---

# `/builder:resume` — where a feature stands, and the next step

Invocation: **`/builder:resume [--path <folder|file>] [--ticket <id>] [--auto] [--agent-walk] [--here] [--no-dev-env] [--walk-lane] [--help]`**. Flags:
[REFERENCE](REFERENCE.md) §Flags — flags first, and **ignore any flag this step does not use rather
than erroring on it**.

**`--help` first.** If present, render the `builder:help` card (`../help/SKILL.md`) and stop — no
picker, nothing written.

**Read `.claude/builder.md` before anything else.** It is the only place this pipeline learns what
your project is (REFERENCE §The project's own rules). No config → say so in one line, name
`/builder:init`, and stop. One call prints it with the REFERENCE sections this flow reads —
§Flags · §MANIFEST.md · §Condense · §The two-way footer · §Continuing on "go":
`node <builder>/scripts/docs.mjs resume` — **`docs.mjs resume-agent` under `--agent-walk`**, which
adds [`AGENT-MODE.md`](AGENT-MODE.md).

**State changes go through the scripts** (REFERENCE §The scripts): a manifest key, a ledger line and
its commit are one `node <builder>/scripts/advance.mjs <folder> …` call, never a hand `sed`. 🔴 Each
is idempotent — **after a crash or a session that died, re-run the same command**; it finishes what
is missing or says `already applied`.

**`--here` (not under `--agent-walk`)** → write `build: here` to the manifest (once; a manifest that
already says it is left alone), commit `chore(<feature>): build here, without the ceremony` —
`node <builder>/scripts/advance.mjs <folder> --set build=here --commit "chore({feature}): build here, without the ceremony"` — then
route as below. Valid only before the build starts (`state` spec, aligned, audited or planned); past
that, say so in one line and route as usual.

**No `--path` and no text → §The picker first**, before Step 1. Never ask "which feature?" as an
open question, and never guess one from the branch or the session.

**This command never sizes or designs anything.** New work is a conversation's: free text →
`/builder:brainstorm`; a design ref, a ticket or a worked-out document with no folder
behind it → `/builder:intake`. Hand it there verbatim, flags included, and stop.
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

**`--path` names a folder that is gone, and `<registry>/_archive/<name>/` exists** → it shipped. Say in
one line `<name> shipped <date> — archived at <registry>/_archive/<name>; nothing to resume` (the date
from its header) and stop.

**No registry folder, but a `.builder/<feature>/brainstorm.md`** → a design conversation in progress
(its header: `status`, `source`). `sized md|lg|xl` → `/builder:spec --path <folder>`; `handed-off`
→ nothing to resume: an xs/sm finished in chat, a conversation stopped at understanding, or a spec
committed on another branch (`git log --all --oneline -- <registry>/<feature>` finds it) — say
which, and stop; any other status →
`/builder:intake --path <folder>` when the header says `source: intake`, otherwise
`/builder:brainstorm --path <folder>`. Run it and stop.

**A feature folder (a SPEC, MANIFEST or PROGRAM) that also has a `.builder/<feature>/brainstorm.md`
whose status is not `handed-off`** → a revision conversation is open, and it comes before the manifest's next step: run
`/builder:brainstorm --path <folder>` and stop — except an `--auto` stub (`auto: stub` in its header,
brainstorm §Spec under --auto) whose SPEC is committed: that run died after its commit, so set the
stub's `status: handed-off` and route on the manifest.

**The fleet's copy wins.** Not under `--agent-walk`: when `.builder/fleet/fleet.json` has a row for
the feature whose `worktree` exists on disk, that worktree's `<registry>/<feature>/MANIFEST.md` is the
live manifest — the fleet's runs commit there, never in this checkout. Say `reading the fleet's copy
in <worktree>` in one line, then route on it. **Every write that follows goes there too** — an unpark's
`blocked: none`, the park record's History line, any manifest or SPEC edit — committed with
`git -C <worktree>`; this checkout's stale copy is never written. A parked row you unpark there is
handed back with `node <builder>/scripts/fleet.mjs <feature> --detach --into <target>`.

**No `MANIFEST.md`** → REFERENCE §Condense, *Legacy layouts* decides which of four shapes it is, and
only one of them converts. `<builder>/scripts/list-features.mjs` marks a convertible row in its
`next:` column.

| The manifest says | Next |
|---|---|
| SPEC header `✅ SHIPPED`, or a README header opening `SHIPPED` | ⛔ **DONE — run no step.** Print the header line; follow-on work is a new feature: `/builder:brainstorm <the new thing>` |
| `blocked:` reads `waiting for your walk …` (test plan `walk=you`: the agent walk passed) | your walk, in the fleet's worktree `<wt>` — the row's `worktree` in `.builder/fleet/fleet.json`, kept for you when the fleet ends (gone → `git worktree add <wt> <the row's branch>` first): 1. start `<wt>`'s walk env — `agent_walk.start` run in `<wt>` with `agent_walk.env` ({feature} filled in), as the walk lane does; 2. print `<wt>`'s `walk.md` (`cd <wt> && <builder>/scripts/workspace <feature>`); 3. 🔒 stop, giving the exact command to type: `/builder:signoff --path <wt>/<registry>/<feature>` (the absolute path) — it reads, writes and commits in `<wt>`, and its migration-status check runs with that same `agent_walk.env`; 4. whatever its verdict, `/builder:signoff` hands it back with `node <builder>/scripts/fleet.mjs <feature> --detach --into <target>` (the manifest's `target:`) — run it yourself when it didn't — on PASS the fleet verifies and lands it; on PROBLEMS the agents work the `## Fixes`, re-walk, and park again for your walk. Never unpark it any other way — `/builder:agent` doesn't either. Under `--agent-walk`, end the run |
| `blocked:` set (anything but `none`) | ⛔ **parked.** Show why and the recommended next step — from `<folder>/PARKED.md` when there is one (*What is stuck*, *Recommended next step*, and the last *History* line), else the line split per REFERENCE §How a park reads. Then **offer to unpark**, one AskUserQuestion: **Unpark and dig in (Recommended)** — set `blocked: none`, append `unparked by <you> YYYY-MM-DD` to the record's History, commit `chore(<feature>): unparked — was: <the line>` (`advance.mjs <folder> --set blocked=none --add <folder>/PARKED.md --commit "chore({feature}): unparked — was: <the line>"`), then start from *Where to dig* with [`systematic-debugging`](../systematic-debugging/SKILL.md) before anything else, and carry on to the manifest's step; or **Leave it parked**. A `kind: human-step` park recommends its human step instead. Under `--agent-walk`, end the run: the fleet reads the line, and retries it itself |
| **no manifest, and build state on disk** (phase docs, a `STATUS.md`) | §Converting a folder from an earlier pipeline — the one action offered |
| **no manifest, no build state** | not a feature yet — analysis that feeds a design conversation. Hand to `/builder:brainstorm --path <folder> <what you want built>` |
| **a `SPEC.md` with no manifest** | half-written, or a half-finished conversion. Write the missing manifest from what the SPEC records, then re-enter this table |
| `tier: program` | §Programs — route on its `child:` lines |
| `state: spec` **and** the design key carries a ref | `/builder:align --path <folder>` |
| `state: spec` with no design ref, or `state: aligned` | `/builder:audit --path <folder>` |
| `state: audited` **and** §Decisions has an OPEN row | §The decisions gate |
| `state: audited` **and** §Findings & risks has a `blocked:` row | ⛔ name each row and the clearer it carries; the plan step refuses until they are gone. A `build-time risk` row is not a blocker |
| `state: audited`, no OPEN row, no `blocked:` row | `/builder:plan --path <folder>` |
| `state: planned` with a go-ahead, or `state: building`, **and** `build: here` | `/builder:build --path <folder> --here` — build §Build here; never the fleet |
| `state: planned` **and** `go-ahead: none` **and** `build: here` | `/builder:plan --path <folder>` — its go-ahead shows the slice table and proceeds straight into the build here (plan §Build here) |
| `state: planned` **and** `go-ahead: none` **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | `/builder:plan --path <folder>` — its go-ahead picks the test plan and launches the fleet (plan §The go-ahead); never a hand build |
| `state: planned` **and** `go-ahead: none` | §The go-ahead |
| `state: planned` with a go-ahead, or `state: building`, **and** the manifest carries `target:` or an old `profile:` (an agent go-ahead writes `target:`; `tests:` alone is an in-chat go-ahead, built by the rows below) **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | agents build it: `/builder:agent --path <folder>` — it relaunches the fleet on the manifest's `target:`, or says it is already running. A fleet row parked `waiting for your walk …` is the walk row above, never this one. Neither key (a 4.8 go-ahead) → the hand-build rows below, as before |
| `state: building` **and** `ready: pending` | every phase is closed and only §Walk readiness is left — the walk lane. **First `node <builder>/scripts/handoff.mjs read <folder>`**: `trust: ok` → it prints the build lane's hand-off (state, sha, gates, open items, this config's readiness facts, the route with its exact `advance.mjs` call) and the walk-lane docs (REFERENCE §Walk readiness, build §When the last phase signs) — follow its route. **`stale: …` (exit 3)** — no hand-off, or the code or the manifest moved since — → derive it as before: `node <builder>/scripts/docs.mjs walk-lane`, run REFERENCE §Walk readiness, then the build's walk script (`walk-script.mjs`, when `walk.md` is missing) and `state: built`. The manifest always wins over the hand-off. Don't re-run the final review |
| `state: planned` with a go-ahead, or `state: building` | `/builder:build --path <folder>` — it resumes from the ledger, not from memory |
| `state: built` **and** SPEC `## Fixes` has an open `- [ ]` | the walk found problems — §Working `## Fixes`, then re-walk what changed. A PROBLEMS or PARTIAL verdict moves neither `state:` nor `walk:`, so the open task IS the signal |
| `state: built`, `walk: none`, no open `## Fixes` row | 🔒 stop — §The walk. **Under `--agent-walk`:** `/builder:agent-walk --path <folder>` instead |
| `state: built`, `walk: agent-pass …` (walked before agents signed off) | `/builder:agent-walk --path <folder>` — it writes the agent sign-off from the passing round it already has, then verify |
| `state: signed-off` **and** `verify: none` | `/builder:verify --path <folder>` |
| `verify: INCOMPLETE` | §Working `## Fixes`, then `/builder:verify --path <folder>` again — scoped |
| `verify: READY` **and** the manifest's `head` is already an ancestor of the remote base branch | it shipped inside someone else's PR — **no second PR**. §Ship's first check |
| `verify: READY`, `hold: none`, `pr: none` | §Ship — under `--agent-walk`, §Ship in agent mode |
| `verify: READY` **and** `walk: agent-pass …` **under `--agent-walk`**, whatever `pr:` says | §Ship in agent mode |
| `hold:` set | 🛑 **parked** — local gates only. Nothing pushes; the hold is the human's to lift |
| `pr: #N` is a **draft** (`gh pr view <N> --json isDraft`) **and** `walk:` now carries a human name **and** the manifest has an `agent-walk:` line (`on` or `off` — it was agent-walked) | the human signed off an agent-verified feature. Ask once — **Mark PR ready** / **Not yet** — then `gh pr ready <N>`. **Not yet** → fall through to the next row that fits. Never under `--agent-walk` |
| `walk: agent-pass …`, not under `--agent-walk` | agent-signed-off, not human-tested. Say so, and offer the two ways on: the fleet finishes it (`/builder:fleet <feature>` — ship, and the merge into its target branch), or the human tests it and types `/builder:signoff --path <folder> <their words>`, which hands it back to them |
| `pr: #N` open, `walk:` carries a human name, SPEC header not yet `SHIPPED` | `/builder:ship --path <folder>` **on the open PR**, then watch CI. Merging is the user's call |
| **a requirement changed · a ruling reversed · a conflict surfaced** — at any state | `/builder:revise --path <folder> <the change>` first, then re-enter this table |

`pr:` is written **here**, by §Ship, once the PR is open. `hold:` and the sign-off header are
`/builder:signoff`'s alone; this command never writes either.

## Converting a folder from an earlier pipeline

A folder with no `MANIFEST.md` but **build state on disk** was driven by something before this. **It
is not broken and its analysis is not wasted**: the conversion writes the two files this pipeline
reads and leaves every existing doc where it is.

Follow **REFERENCE §Condense, *Legacy layouts*** — the four-step recipe there is the procedure, cited
rather than restated so a fix lands in one place.

A legacy folder whose status is SHIPPED is not converted: `git mv` it into `<registry>/_archive/`.

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
related rows folded into the same message, each briefed first in chat per REFERENCE §Before a picker
(the options explained, and why the recommended one). **Translate each answer into an implementable statement**
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
presenting a one-part recap of what it builds (REFERENCE §The review) and the plan as numbered slices — `scripts/plan-slices.mjs`, one per task, grouped by app —
with the test plan and what it costs, the path to read the plan at, and anything riding along as a
named risk, and takes the approval with the test plan (plan §The go-ahead). A manifest left at `state: planned` with `go-ahead: none` is
picked up by **`/builder:build`**, which presents that same table itself before its first dispatch.
**This command never presents a slice table of its own** — one artifact, one approval. In a project
with an `agent_walk:` block (not under `--agent-walk`) the go-ahead is **`/builder:plan`**'s, never
`/builder:build`'s: a manifest at `planned` with `go-ahead: none` goes to `/builder:plan --path
<folder>`, whose go-ahead picks the test plan and launches the fleet (plan §The go-ahead). A human may
also record it by typing `/builder:signoff --path <folder>`, which labels it GO-AHEAD (build) and
touches neither the SPEC header nor the PR lock.

## 🔒 The walk (before the deep pass)

1. **Fast gates only, for the apps the build touched** — `node <builder>/scripts/gate.mjs <app>…`
   (REFERENCE §Quality gates) — ⛔ not the cross-app walk, not the full deep set. The build ran them
   at the last phase close; the runner re-runs an app a commit since then can have turned red and
   quotes the rest.
1b. 🔴 **Walk readiness** — REFERENCE §Walk readiness, whenever the manifest's `ready:` is not
   `yes` at the current HEAD, or anything since could have left the dev environment behind (a new
   migration, a restart-class change). Pending → hand off the one step that's left; ⛔ **never print
   the walk script or name `/builder:signoff` over a pending readiness.**
1c. **After an `--auto` run, the review first.** When the manifest carries `auto: on` or
   `agent-walk: on` — no human approved the design, the audit or the go-ahead, because nobody was
   asked — open the hand-off with **the full review of what was built**: REFERENCE §The review,
   sections 1–8, written from `SPEC.md` as it now stands, every ruling an autopilot took marked
   `(auto)`, in parts with `A. Looks right — next part` · `B. Change something — say what`. B → the
   change goes through `/builder:revise --path <folder>` before the walk. The last part ends with the
   walk script below. This is where an unattended run is checked: nothing lands unseen.
2. **Print the walk script.** The build wrote it to `walk.md` in the workspace
   (`<builder>/scripts/workspace <feature>` prints the directory; re-resolve it inline in every
   command). Missing → write it now with `node <builder>/scripts/walk-script.mjs <folder>` and fill
   its marked blocks: **per app**, since a multi-app feature is walked in more than
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
(`state: built`, no sign-off yet) end with REFERENCE §Walk readiness again, then the human re-walking what changed and typing
`/builder:signoff` — tick each `- [ ]` as it lands, so the row that routed you here stops firing.
Tasks from a verify INCOMPLETE (already signed off) end at `/builder:verify --path <folder>` again —
**scoped**, per its §A re-verify is SCOPED — plus a re-walk of any signed-off surface the fix changed.

Tasks from an **agent walk** (`--agent-walk`, rows tagged `(agent walk round <n>)`) end with REFERENCE
§Walk readiness again, then `/builder:agent-walk --path <folder>` — never a human re-walk request.
**Under `--no-dev-env`** — a batched fleet works a walk's fixes in its parallel lanes, with no env —
they end with the touched apps' fast gates green and each row ticked, then `ready: pending "dev env
(fleet walk lane)"` and the run ends (`advance.mjs <folder> --set 'ready=pending "dev env (fleet walk
lane)"' --head --commit walk-lane`): the next walk batch does readiness and the re-walk, which covers
only what the fix changed.
Under `--agent-walk`, the re-walk after a verify INCOMPLETE is the scoped re-verify's cross-app walk
leg for the surface the fix changed — no human is asked, and no new agent-walk round is started.

Tasks from a **target sync** (§Ship in agent mode, rows tagged `(target sync)`) end with those apps'
fast gates green, one commit per fix, and §Ship in agent mode again.

## Programs (`tier: program`)

A program manifest tracks one `child: <name> — <state>` line per child instead of a state of its own.

**Pick the child the way the picker picks a feature.** Brief it first (REFERENCE §Before a picker):
each child, what users can do once it ships, its state, and why the recommended one is next (what
it waits on). Then present the `child:` lines in one
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
| **The decisions gate** | every OPEN row takes its **Recommended** ruling, written as an implementable statement with decider `auto (recommended) YYYY-MM-DD`; a row with no recommendation gets one first. The human reads these in the review at the walk (§🔒 The walk step 1c), which is where an autopilot run is checked |
| **Every review** (REFERENCE §The review) | not printed at §Confirm, spec, audit, the go-ahead or revise — nobody approves; each says in one line what it did. The full review of what was built opens the walk hand-off |
| A prototype gap | the recommended one of REFERENCE §Prototype mode's three options — "fix it in the design" only for a bounded, mechanical fix, **never a design change** |
| The audit finds a code defect | it becomes a build task carried as a `build-time risk` row naming the task that settles it — never silently fixed before the go-ahead |
| **The go-ahead** | the slice table is presented in the hand-off with the recommended test plan, recorded `tests:` with `go-ahead: auto (recommended)`, and the run proceeds |
| **The walk** | ⛔ **the terminal state.** The review of what was built (§🔒 The walk step 1c), the walk script, land everything, stop |
| A commit in an app the config marks `commit: manual` | ⛔ **never** — staged and left for the human under every flag |

`--auto` never writes a sign-off, opens or pushes a PR, lifts a `hold:`, drops a capability users
already have, edits the design, or widens scope. Nothing about it touches the PR lock.

## `--agent-walk`

Agent mode — what `/builder:agent` and `/builder:fleet` run — has its own file,
[`AGENT-MODE.md`](AGENT-MODE.md): how every pause is settled without asking, the flags that carry
through, and §Ship in agent mode. **`docs.mjs resume-agent` (the first call, above) already printed
it — never read it again.**

## The picker (no `--path`, no text)

Never ask "which feature?" as an open question. Run

```
node <builder>/scripts/list-features.mjs --json
```

Each row gives `feature`, `path`, `layout`, `state`, `done`, `convert`, `lastDone`, `nextStep`,
`updatedAt`, `branch`, plus `manifest` or `children`. **A top-level `builder` field with `behind:
true`** means this repo runs a vendored copy older than the newest release on this machine: say so
in one line above the question — `⬆️ builder <latest> is available — this repo carries <have>. Run
/builder:vendor to update it.` — and carry on; it is never a reason to stop.

- **Offerable** — `done` false. A parked row (`manifest.blocked` set) is offered too, its
  description `parked — <why>`; picking it goes to Step 1's parked row, which offers to unpark it.
  `done` rows only as a count.
- Rows with `layout: brainstorm` are conversations in progress; selecting one runs its `command`.
- **Nothing offerable** → say so, name `/builder:brainstorm <what you want built>` (an idea) or `/builder:intake <doc>` (a written spec), and stop.
- **Exactly one** → still ask, with **Not now** as the second option (AskUserQuestion needs two).
  Don't start it unasked.

Present **one AskUserQuestion**, single-select. Each option: the `feature` as the label; `lastDone`
→ `nextStep` as the description, plus `on <branch>` when `branch` isn't the current branch and
`needs conversion` for a `convert: true` row. **AskUserQuestion takes at most four options**, so
with more than four offerable, offer the four most recently touched (`updatedAt`) and say in the
question that any other can be typed by name under **Other**. Put the unblocked feature closest to
done first with `(Recommended)`. **Other** also takes new work: text that names no feature is
handed to `/builder:brainstorm` verbatim.

On selection, continue at Step 1 with that row's `path`. A row on another branch → switch to it
first (`git switch <branch>`) if the tree is clean; otherwise stop and name the command.

## Ship

0. **Did this code already ship inside another PR?**
   `git merge-base --is-ancestor <the manifest's head> origin/<base_branch>` succeeds → **open no
   PR**; take the ship moment through `/builder:ship --path <folder>` on the carrying PR while it is
   open, so its merge carries the line.
1. **Review the diff locally** with whatever the config's §Companion skills names for review.
   Offered, not assumed — the human has already walked it. Skipped = say why.
2. **Open ONE PR for the whole feature**, base the config's `base_branch`:
   `gh pr create --base <base_branch> --title "<type>(<ticket-or-feature>): <feature>" --body "<the
   PR body>"`. The body is REFERENCE §The review, written from the condensed `SPEC.md`: the SPEC
   header's sign-off line; what changes for users; added · changed · removed; the data, migrations
   named; what changes in each app (a released app's transition); how it was tested — the walk, by
   whom, and the verify verdict; then `Spec: <registry>/<feature>/SPEC.md` as a reference line.
   🔴 **Print the body in full in the chat first** — the human approves what the PR will say, never a
   title and a path.
   🔴 Only on a sign-off with no hold, and only on a branch that is not the base. **Ask once first**
   — one AskUserQuestion, **Open the PR** / **Not yet** — under the printed body (an edit they ask
   for is made, the body printed again, and the question asked again) — even when an affirmative brought you here:
   "go" continued the pipeline, it did not name an outward-facing action. **One PR for the
   feature, never one per phase** — a phase is one app, and the apps ship together or the contract
   is live with only half its consumers.
   **Agent-signed-off** (`walk: agent-pass …`) → this section is not the one: §Ship in agent mode
   under `--agent-walk`; without it, the route table's agent-mode row says what to offer.
3. **Write `pr: #N` to the manifest yourself and commit it** — `gh pr view --json number --jq
   .number` — plus `next: watch CI, then /builder:ship --path <folder>`, in one call:
   `node <builder>/scripts/advance.mjs <folder> --set "pr=#N" --set "next=watch CI, then /builder:ship --path <folder>" --head --commit "docs({key}): {feature} — PR #N open"`.
   Nothing else writes that line.
4. **Watch CI.** Merging is the user's call.
5. **On the open PR:** `/builder:ship --path <folder>` flips the SPEC header to SHIPPED, removes
   `MANIFEST.md` and deletes the workspace.
6. **Reporting back to the ticket system is a separate, explicit call** — the config's §Companion
   skills names it. This family never writes to a ticket.

### Ship in agent mode (`--agent-walk`)

`AGENT-MODE.md` §Ship in agent mode — the merge into the target, never a PR. `docs.mjs resume-agent` printed it with the rest of that file; don't read it again.

### 🔒 The PR lock (binding on every skill in this family)

**No `/builder:*` skill may open, reopen, or push toward a PR until the human has personally
exercised the finished feature in the running app and said, in their own words, that it works.**
A green gate run or a code review is evidence for the human — never their sign-off. In doubt = you
don't have it: ask. "It works" and "open the PR" are two different permissions — a sign-off can carry
`🛑 PR HELD`.

**Agent mode is not an exception to it.** A feature the human handed to agents (`/builder:agent` or
`/builder:fleet`, recorded `agent-walk: on`) is taken all the way by §Ship in agent mode — the agent
walk and its **agent** sign-off stand in for the human's, and it is merged into the branch the human
ran it from, **locally**. No PR opens and nothing is pushed: the human tests the merged result there
and makes those calls. The records say so everywhere — `walk: agent-pass`, the 🤖 header, the merge
commit — so nobody mistakes it for human-tested. A human `/builder:signoff` over an agent one
sets `agent-walk: off` and hands the rest back to the human flow.

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
   land the current phase, write the manifest, commit, and hand off with *"say go to continue here,
   or run `/clear` first, then `/builder:resume --path <folder>`"*. Prefer stopping at a clean
   boundary over running out mid-phase. A blocked task is not a stop: start the next startable one.
   Under `--no-dev-env` the fleet's build lane also ends the run at the audit's and the go-ahead's
   commits — a fresh context per stage (AGENT-MODE §`--agent-walk`).
4. **One-line resume footer** naming the command that does the NEXT work — not always
   `/builder:resume`: after the build it is `/builder:signoff`, then `/builder:verify`, then the PR.
   On a hold there is no command, because the pipeline is parked on the human's call.

   ```
   📍 <feature>: <state> — next: <command> · or say go
   ```

   ` · or say go` only where an affirmative can continue it — REFERENCE §Continuing on "go". Where
   another way through the next step exists, the footer is the numbered choice of REFERENCE §The
   two-way footer — `Full spec:` and the `Pick up where you left off` line above it, then
   `1. Agent` (only with an `agent_walk:` block) · `2. Step by step` (this command) ·
   `3. In this session` (only before the build), renumbered when one is absent, each explained in
   plain words for the state and none carrying a `/builder:*` command.
5. **A bare affirmative picks option 1** — on a numbered footer that offers Agent, "go" runs
   `/builder:agent --path <folder>`; otherwise it continues this command. `agent` runs
   `/builder:agent --path <folder>`; `step by step` or `resume` continues this command; `in this
   session` or `here` runs `/builder:resume --path <folder> --here`; an option's number picks it.
   Whatever is picked runs through the Skill tool, in that turn — never ask the human to paste it.
   The exceptions (signoff, the walk, a human's step, a hold, opening the PR) are REFERENCE
   §Continuing on "go".

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
