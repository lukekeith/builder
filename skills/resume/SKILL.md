---
name: resume
description: Where a feature stands and the one next step — reads the feature's MANIFEST.md and drives the family from there: align → audit → the decisions gate → plan → the go-ahead → build (one app per phase) → 🔒 the walk → signoff → verify → ship, pausing only at real human decisions. Invoked without --path it is the picker over every in-flight feature and program, and it is what converts a folder left by an earlier pipeline. Never sizes or designs new work — that is /builder:brainstorm — and never creates a branch, worktree or ticket, or opens a PR before the human has personally tested the feature — except under --agent-walk (agent mode, what /builder:agent and /builder:fleet run), which takes the feature all the way: agent walk, agent sign-off, verify, ship, and a merge into the project's merge_into branch (default base_branch). Resumable after any /clear. Use when the user types /builder:resume, asks to continue, resume or pick up /builder:* work, or answers a /builder:* handoff footer with a bare affirmative ("go", "yes", "proceed", "continue"), or "1" / "resume" on a two-way footer.
---

# `/builder:resume` — where a feature stands, and the next step

Invocation: **`/builder:resume [--path <folder|file>] [--ticket <id>] [--auto] [--agent-walk] [--no-dev-env] [--help]`**. Flags:
[REFERENCE](REFERENCE.md) §Flags — flags first, and **ignore any flag this step does not use rather
than erroring on it**.

**`--help` first.** If present, render the `builder:help` card (`../help/SKILL.md`) and stop — no
picker, nothing written.

**Read `.claude/builder.md` before anything else.** It is the only place this pipeline learns what
your project is (REFERENCE §The project's own rules). No config → say so in one line, name
`/builder:init`, and stop.

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
`/builder:brainstorm --path <folder>` and stop.

**No `MANIFEST.md`** → REFERENCE §Condense, *Legacy layouts* decides which of four shapes it is, and
only one of them converts. `<builder>/scripts/list-features.mjs` marks a convertible row in its
`next:` column.

| The manifest says | Next |
|---|---|
| SPEC header `✅ SHIPPED`, or a README header opening `SHIPPED` | ⛔ **DONE — run no step.** Print the header line; follow-on work is a new feature: `/builder:brainstorm <the new thing>` |
| `blocked:` set (anything but `none`) | ⛔ **parked.** Show why and the recommended next step — from `<folder>/PARKED.md` when there is one (*What is stuck*, *Recommended next step*, and the last *History* line), else the line split per REFERENCE §How a park reads. Then **offer to unpark**, one AskUserQuestion: **Unpark and dig in (Recommended)** — set `blocked: none`, append `unparked by <you> YYYY-MM-DD` to the record's History, commit `chore(<feature>): unparked — was: <the line>`, then start from *Where to dig* with [`systematic-debugging`](../systematic-debugging/SKILL.md) before anything else, and carry on to the manifest's step; or **Leave it parked**. A `kind: human-step` park recommends its human step instead. Under `--agent-walk`, end the run: the fleet reads the line, and retries it itself |
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
| `state: building` **and** `ready: pending` | every phase is closed and only §Walk readiness is left — run REFERENCE §Walk readiness, then the build's walk script and `state: built`. Don't re-run the final review |
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

1. **Fast gates only, for the apps the build touched** — `node <builder>/scripts/gate.mjs <app>…`
   (REFERENCE §Quality gates) — ⛔ not the cross-app walk, not the full deep set. The build ran them
   at the last phase close; the runner re-runs an app a commit since then can have turned red and
   quotes the rest.
1b. 🔴 **Walk readiness** — REFERENCE §Walk readiness, whenever the manifest's `ready:` is not
   `yes` at the current HEAD, or anything since could have left the dev environment behind (a new
   migration, a restart-class change). Pending → hand off the one step that's left; ⛔ **never print
   the walk script or name `/builder:signoff` over a pending readiness.**
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
(`state: built`, no sign-off yet) end with REFERENCE §Walk readiness again, then the human re-walking what changed and typing
`/builder:signoff` — tick each `- [ ]` as it lands, so the row that routed you here stops firing.
Tasks from a verify INCOMPLETE (already signed off) end at `/builder:verify --path <folder>` again —
**scoped**, per its §A re-verify is SCOPED — plus a re-walk of any signed-off surface the fix changed.

Tasks from an **agent walk** (`--agent-walk`, rows tagged `(agent walk round <n>)`) end with REFERENCE
§Walk readiness again, then `/builder:agent-walk --path <folder>` — never a human re-walk request.
Under `--agent-walk`, the re-walk after a verify INCOMPLETE is the scoped re-verify's cross-app walk
leg for the surface the fix changed — no human is asked, and no new agent-walk round is started.

Tasks from a **target sync** (§Ship in agent mode, rows tagged `(target sync)`) end with those apps'
fast gates green, one commit per fix, and §Ship in agent mode again.

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

## `--agent-walk`

Unattended mode, for `/builder:fleet` (REFERENCE §Flags). It **implies `--auto`** and is recorded on
the manifest as `agent-walk: on YYYY-MM-DD`, so a cold session keeps it. That persisted line governs
unattended runs only: a human `/builder:signoff` sets it to `agent-walk: off`, so the human's own
`/builder:resume` afterwards is interactive and offers **Mark PR ready**. No `agent_walk:` block in the
config → refuse in one line naming `/builder:init --update`.

🔴 **Never call AskUserQuestion or ExitPlanMode** — nobody is there to answer, and a headless run that
asks hangs until it times out.

🔴 **Nothing runs in the background, and no turn ends waiting.** A headless `claude -p` run **exits
when its last turn ends**, and whatever it left running goes with it — a gate suite cut off half-way,
a reviewer whose verdict is never read, a feature the fleet then parks for "no progress". So under
`--agent-walk`, in this command and every step it runs:

- **Never** `run_in_background` on Bash or Agent, never `ScheduleWakeup`, `Monitor` or a cron.
  Subagents run in the foreground, several in one message when they are independent.
- **A command that may outlast one Bash call** (a gate suite, an e2e run, a CI watch) is started with
  `node <builder>/scripts/job.mjs start <name> -- <command>` and then waited on in the foreground,
  **Bash timeout 600000**, with `node <builder>/scripts/job.mjs wait <name>` — again and again while it
  prints `still running` (exit 75), until it prints an exit code. That code is the gate's result.
  Gate suites are always `scripts/gate.mjs` (REFERENCE §Quality gates), so the command under `job.mjs`
  is `node <builder>/scripts/gate.mjs …`, never the config's commands pasted by hand.
- **Never kill a process you did not start in this run**, and never `pkill`/`killall` by pattern:
  other fleet worktrees share this machine, and their suites look exactly like yours. Wrap a command
  of yours that may hang in `timeout`.
- **The run's last message is a handoff after the work finished** — never "waiting on …", "I'll
  pick this up when …", or "still running". Work that cannot finish in this run ends at a committed
  manifest the next run resumes from.

🔴 **Agent mode builds to done. It does not park on work.** A spec the human approved and handed
to agents has no reason to stop short of merged: a merge conflict, a red gate, a failing agent walk,
a plan that came out large, a dev env that won't start — each of those is work, and the run does it.
A park is reserved for **a product decision the spec leaves open that no ruling can responsibly
settle** — which means the spec was not finished — and for the few steps the config reserves to the
human (below). "It's a big call", "the human might want to review this", "a lot of decisions were
auto-ruled" are never reasons: rule, record the ruling where the hand-off lists it, and keep going.

Every point that would ask resolves one of two ways:

- **Take the recommendation** — the default, and the answer for anything local and reversible,
  which after a local-only merge is nearly everything: the human tests the result and changes what
  they don't like.
- **Park** — only for the cases above. Write `blocked: "<why> — next: <step>"` (REFERENCE §How a park reads) and `next:
  /builder:resume --path <folder>` to the manifest, **and `<folder>/PARKED.md`** (REFERENCE §The park
  record — everything a cold reader needs to dig: what is stuck, what was tried, the evidence quoted,
  where to dig), commit both `chore(<ticket-or-feature>): <feature> — parked: <reason>`, print the
  footer, and **end the run**. The reason names the decision the spec is missing, in one line the
  human can answer.
- **A run started after an unpark** — the fleet's prompt says the feature *was parked before* and
  quotes the old line. **Read `<folder>/PARKED.md` first**: it is the investigation so far. Treat it
  as a lead, not a verdict — find out whether its cause still holds in the code and the spec as they
  are now (a newer builder may not stop there at all, a fix may have landed since, a ruling may now
  settle it). Start from *Where to dig*, find the root cause before trying the same fix again
  ([`systematic-debugging`](../systematic-debugging/SKILL.md)), and add what you try under *What was
  tried*. Park again only if it still stands — the line written fresh to REFERENCE §How a park reads
  and the record's sections rewritten with what this attempt learned, never copied back.

| Pause | Under `--agent-walk` |
|---|---|
| Decisions gate · go-ahead · prototype gap · audit code defect | as `--auto`: the recommendation, recorded `auto (recommended)`. 🔴 **A go-ahead is never a reason to park**, however many decisions were auto-ruled on the way to it: handing the feature to agents was the go-ahead. A run that wrote `blocked: "no human go-ahead …"` misread this table |
| A plan that wants to split | build it whole — record `Ruling: built as one feature under --agent-walk — <the split it wanted>` (plan §Writing the plan's dials). Never a park |
| An open scope question the spec can't answer, and no ruling can settle without guessing at what the product should be | park — the spec needs a human. A question a reasonable reading of the SPEC settles is a ruling, not this |
| An audit `blocked:` finding | park, citing it — it is a spec defect (a released contract it would break, a promise it can't keep) |
| A merge conflict · a red gate · a failed agent walk · a dev env that won't come up · a stalled step | work it — never a park. The fleet hands conflicts and env failures to a run of their own (fleet §What it will do) |
| An app the config marks `commit: manual` | park at the start of that app's phase; earlier phases stay committed |
| Dev-DB migrations (§Walk readiness) | `apply_mode: ask` → apply · `human` → park · `agent` → apply |
| Starting or restarting the dev env | never, when `agent_walk.start` is set: the fleet owns it (REFERENCE §Walk readiness) |
| The walk | `/builder:agent-walk --path <folder>` — on PASS it writes the **agent sign-off** and condenses |
| The sign-off | the agent sign-off above — labelled 🤖, never a human's; `/builder:signoff` stays human-only |
| The ship commit and the merge into the target | §Ship in agent mode, no question — handing the feature to agents was the permission for all of it |
| **Any other point that would ask, including ones added later** | the rule above. A pause missing from this table is never a reason to ask |

**The flags carry through:** every step this command runs gets `--auto --agent-walk`, and
`--no-dev-env` when this run has it — `--auto` too, because plan, audit and align read `--agent-walk`
only to park (a plan's split) and would otherwise still raise their own pauses (a plan step's
`ExitPlanMode` for the go-ahead, for one); they do already honour `--auto`, so that's what settles them. Under
`--no-dev-env`, reaching walk readiness writes `ready: pending "dev env (fleet walk lane)"`, commits,
and ends the run.

**Agent mode's job is a feature merged into the target branch.** A run that stops short of that
without a `blocked:` line has not finished — the fleet runs it again. What it never does, at any step:
write a **human** sign-off (or run `/builder:signoff`), lift a `hold:`, push, open a PR, commit in a
`commit: manual` app, or deploy. None of those is needed to reach merged-into-the-target, so they are
left to the human — only `commit: manual` and `hold:` stop the feature, and they park.

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
   SPEC header's sign-off line + what changed per app>"`.
   🔴 Only on a sign-off with no hold, and only on a branch that is not the base. **Ask once first**
   — one AskUserQuestion, **Open the PR** / **Not yet** — even when an affirmative brought you here:
   "go" continued the pipeline, it did not name an outward-facing action. **One PR for the
   feature, never one per phase** — a phase is one app, and the apps ship together or the contract
   is live with only half its consumers.
   **Agent-signed-off** (`walk: agent-pass …`) → this section is not the one: §Ship in agent mode
   under `--agent-walk`; without it, the route table's agent-mode row says what to offer.
3. **Write `pr: #N` to the manifest yourself and commit it** — `gh pr view --json number --jq
   .number` — plus `next: watch CI, then /builder:ship --path <folder>`. Nothing else writes that line.
4. **Watch CI.** Merging is the user's call.
5. **On the open PR:** `/builder:ship --path <folder>` flips the SPEC header to SHIPPED, removes
   `MANIFEST.md` and deletes the workspace.
6. **Reporting back to the ticket system is a separate, explicit call** — the config's §Companion
   skills names it. This family never writes to a ticket.

### Ship in agent mode (`--agent-walk`)

Agent mode lands every feature on **one branch: the one the human ran `/builder:agent` or
`/builder:fleet` from**, which the fleet passes as `--into <branch>`. It opens no PR and pushes
nothing — pushing that branch, and any PR from it, stay the human's. The feature has an agent
sign-off (`walk: agent-pass …`, SPEC header `> 🤖 AGENT SIGNED OFF …`) and `verify: READY`. This
runs without a question; a step that can't finish **parks** (`blocked:` + commit + end the run, per
§`--agent-walk`). Long waits go through `scripts/job.mjs`.

1. **Pre-flight.** No `--into` → park `"no target branch — run it through /builder:fleet"`.
   `hold:` set → park (the hold is the human's).
2. **Bring the target in.** `git merge --no-edit <into>` — a local branch, visible from this
   worktree.
   - Nothing new → go on.
   - Nothing new is the normal case: the fleet merges the target into the worktree before every
     build-lane run and before the walk env starts, so the tree already carries it.
   - Merged cleanly with new commits (another feature landed first) → `node <builder>/scripts/gate.mjs
     <every in-scope app>` (through `job.mjs`). The runner re-runs only the apps whose inputs the
     merge changed and quotes the rest. Red → each failure a `- [ ] <app>: … (target sync)` under
     `## Fixes`, fixed per §Working `## Fixes`, gates green, then on.
   - Conflicts → **resolve them, always.** The other side is features that already merged, this side
     a spec the human approved; both are settled, so the job is code that does both. Read this SPEC
     and `git log -p MERGE_HEAD --not HEAD -- <file>` for each file, keep both behaviours, and where
     they truly disagree keep the merged feature's behaviour working while still meeting this spec —
     a ruling in the merge commit message. Then `gate.mjs` for the in-scope apps, fixes until green,
     and commit the merge. Never `git merge --abort` to park.
3. **Ship.** `/builder:ship --path <folder> --into <into>` (its §At ship, agent form) — the SHIPPED
   header naming `<into>`, `MANIFEST.md` removed, the workspace removed, a program child's line set
   to `shipped` — one commit.
4. **End the run.** The fleet merges this branch into `<into>` in the human's checkout (one `--no-ff`
   merge commit per feature, `merge(<feature>): agent-verified, not human-tested`) and removes the
   worktree. Hand off with every ruling the run made, and:
   `📍 <feature>: shipped — merging into <into> (agent-verified, not human-tested)`.

A feature that already has a PR open (a draft from an earlier version of this pipeline) ships the
same way; the PR is left for the human to close.

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
4. **One-line resume footer** naming the command that does the NEXT work — not always
   `/builder:resume`: after the build it is `/builder:signoff`, then `/builder:verify`, then the PR.
   On a hold there is no command, because the pipeline is parked on the human's call.

   ```
   📍 <feature>: <state> — next: <command> · or say go
   ```

   ` · or say go` only where an affirmative can continue it — REFERENCE §Continuing on "go". Where
   agents could take the next step instead, the footer is the numbered choice of REFERENCE §The
   two-way footer — `1. resume` (this command) / `2. agent` (`/builder:agent --path <folder>`).
5. **A bare affirmative, `1` or `resume` in reply continues it; `2` or `agent` runs
   `/builder:agent --path <folder>`.** "go", "yes", "proceed" after a footer runs that
   footer's command through the Skill tool, in that turn — never ask the human to paste it. The
   exceptions (signoff, the walk, a human's step, a hold, opening the PR) are REFERENCE §Continuing
   on "go".

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
