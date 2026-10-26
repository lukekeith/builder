---
name: plan
description: Turns an audited spec into a committed PLAN.md — ordered phases, one app per phase, each step with its code and tests — and takes the build go-ahead with its test plan. Use when asked to plan a spec's implementation.
---

# `/builder:plan` — the audited spec becomes phases

Invocation: **`/builder:plan --path <folder> [--ticket <id>] [--auto] [--agent-walk] [--into <branch>]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — **ignore any flag this step does not use rather than
erroring on it**.

**Load these three before writing anything — in one call,** `node <builder>/scripts/docs.mjs plan`
prints all three — and cite them rather than restate them:
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

**A one-task phase for a tiny change is the most expensive shape a plan can take.** A phase costs a
brief and a fresh implementer whatever its size, and a review and a gate run wherever the test plan
closes phases on them; measured on a real build under per-task review and phase-close gates, three
consecutive phases of one small task each (a tool description, a rule line, a guard) cost as much as
a phase of five real tasks. Before accepting one: fold the change into a task of the
same app that already exists, or — when the app has no other phase — write it as one task whose
steps are exactly the edit and its test, and note `tiny` on its `Recipe:` line so the build picks the
cheapest reviewer tier. Never fold across an app boundary to avoid a phase.

**A plan landing at 9+ phases is a feature that should be two.** Present the split before taking any
go-ahead — by delivery slice or by domain — and proceed only on the split, or on an explicit "build
it whole". **`--auto` does not decide this**: a split creates feature folders, which is a scope
change and outside autopilot's remit; present it and stop. **Under `--agent-walk`** the human
already chose: they handed this spec to agents to build, so it is **built whole** — no new folders,
no park. Write the plan as one feature, and put the split it wanted in the ledger and the hand-off as
`Ruling: built as one feature under --agent-walk — a split into <parts> was on the table` (resume
§`--agent-walk`). 🔴 **This step never parks under `--agent-walk`.** The go-ahead there is
`auto (recommended)` and the run proceeds — a spec whose decisions were all
auto-ruled is still a spec the human handed to agents, and "Luke should review the auto rulings" is
what the hand-off's rulings list is for, not a `blocked:` line.

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
reads it by position. Never per-phase docs. **The script writes it** from PLAN.md's headings and
`## Phases` table — never type it by hand:
`node <builder>/scripts/plan-slices.mjs <folder> --index --write` (re-running it rewrites the same index).

**The manifest:** `state: planned`, `head`, `branch`, `next: /builder:resume --path <folder>`. Commit
`PLAN.md`, the SPEC and the manifest together: `docs(<ticket-or-feature>): plan <feature>` — one call:

```bash
node <builder>/scripts/advance.mjs <folder> --set state=planned \
  --set "next=/builder:resume --path <folder>" --head \
  --add <folder>/PLAN.md --add <folder>/SPEC.md --commit plan
```

After a crash, re-run the same command — it finishes what's missing or says `already applied`
(REFERENCE §The scripts). Every manifest write below goes through `advance.mjs` the same way.

**Then take the go-ahead, in the same turn** — §The go-ahead.

**Nothing here creates a branch, a worktree or a ticket** — the fleet makes the feature's worktree
when it launches. Given `--ticket`, check the branch name carries the key and warn once if not.

## The go-ahead

One approval covers the whole build; no later phase re-asks. It is taken the same way in chat and
with an `agent_walk:` block — the slices, the test plan, A/B/C — and only what **A** starts differs.
**The manifest says `build: here`** → §Build here instead.

**0. The recap — what is being built.** REFERENCE §The review, one part, above the slices: what
changes for users (1), added · changed · removed (3) and the data (4), each in a few lines from the
SPEC; then **what the audit changed since the design was approved** — the audit's review delta, or
`The audit changed nothing in the design you approved.` — and every ruling taken at the decisions
gate, one line each (`(auto)` when an autopilot took it). The human approves the build here, so they
see what it builds, not only how it is sliced.

**1. The slices** — section 9 of the review. Run `node <builder>/scripts/plan-slices.mjs <folder>` — with `--tests "<value>"`
when the manifest already carries `tests:` (chosen ahead, §Picking the test plan ahead) — and present
its output **verbatim**: the feature, its slices and apps, where it lands, one line per task grouped by
app with the tests it adds, then the test plan's two lines — what runs, and what it costs in runs and,
when the gate runner has timed the suites, minutes. Never redraw it as a table, re-total it or add a
column. The `## Phases` table stays in `PLAN.md` for the build; the human sees slices. Under the
block, one line each for what rides along: the slices carrying a `build-time risk`, **which slice
freezes the contract**, anything deferred with a decider, and the path to read the plan at. When
`node <builder>/scripts/profile.mjs --recommend <folder>` returns `signals` (a breaking schema change, a
released consumer… raised the end to the risky parts), say its `reason` in one line — unless the
block already does.

**2. The ways on** — CONVERSATION §Ways on, plain chat:

```
A. Build it with this plan (recommended) — <what A starts, below>
B. Change the test plan — how much to test per slice, at the end, and when to review
C. Keep planning — nothing is built; say what to change
Reply A, B or C — "go" is A.
```

A's description: no `agent_walk:` block → `build it now, in this session`; with one → `agents build it
in its own worktree and land it on <target>`, the target being the one **Land on?** below would
recommend. A reply naming another branch with A ("A, onto develop") lands it there.

**3. B → one AskUserQuestion, three questions** (four with an `agent_walk:` block: **Land on?** last),
briefed first in chat per REFERENCE §Before a picker — each option explained with its cost, and why
the recommended plan is first.
Each option's description **leads with what it costs for this plan**: run
`node <builder>/scripts/profile.mjs --cost <folder> --tests "<value>"` for each option — its own lever
set, the other two held where they stand — → `{ ownRuns, suiteRuns, reviews, walk, minutes }`, and
lead with the counts (`12 quick runs + 3 suite runs`, `4 reviews`), then `≈ N min` when `minutes` is
not `null`. Then what it runs, in the words below. The recommendation's option is first, with
` (Recommended)` on its label; the rest keep this order.

- **Testing while building — after each slice:** **Its own tests** — the tests that slice adds, and
  the type-check (`slice=own`) · **Its own, plus the app's suite when the app's slices are done**
  (`own+app`) · **The app's suite after every slice** — slowest; `@scoped` lines still narrow it
  (`full`) · **None while building** — tests are still written; they run at the end (`none`).
- **Testing at the end — once every slice is built:** **The touched apps' suites, once** — every
  touched app's fast set, the tests §Testing names, released-consumer parity (`end=touched`) · **Plus
  an agent tries the risky parts** — the `[risk]` walk items in the running app, and `@scoped` deep
  lines (`risk`) · **Everything** — the deep set, the cross-app E2E, the full walk (`everything`) ·
  **Nothing — I'll test it** — the type-check only; the verdict says nothing was tested (`none`). On a
  feature with a released consumer or a breaking schema change, `none`'s description adds `⚠ This feature has
  a <signal>: nothing tests it before it lands.` It warns; it never refuses.
- **Review:** **Once at the end** — one whole-branch review (`review=end`) · **Once per app** — after
  each app's slices (`app`) · **After every slice** (`slice`).
- **Land on?** (`agent_walk:` set) — the recommendation is **the branch checked out here** when it
  is not `base_branch` and not a `builder/*` branch: the human is working on it, and it is where the
  spec — and often the config — was committed. Otherwise `<merge_into> (Recommended)` (the same
  branch under `merge_into: current`). Then up to two other likely branches: `merge_into` and
  `base_branch`, each where it differs. The tool's *Other* takes any other branch name. A target
  whose `.claude/builder.md` has no `agent_walk:` block is refused by the fleet's dry run — relay its
  fix, never launch around it.

**The floors are not options** and are never offered off: the type-check of every touched app before
the work lands, and the final whole-branch review. The human walk is not a lever either — an in-chat
build keeps the 🔒 walk before a PR whatever the test plan.

The tool's *Other* on any of the three testing questions is the rest of the levers: one more
AskUserQuestion — `models` (`default` · `economy` · `strong`), `persist` (`default` · `low`),
`unruled` (`recommend` · `park`), each pre-filled from `profile.mjs --levers <folder>`. A value typed
into *Other* that names one of the question's own options counts as that option. **With an
`agent_walk:` block, and `end` set to `risk` or `everything` through B** → **Walk it yourself before
it lands?** in that same follow-up call (or alone): **No (Recommended)** · **Yes** → `walk=you` (the
fleet parks it for your walk after the agent's, and lands it after your `/builder:signoff`).

Then run `plan-slices.mjs <folder> --tests "<the new value>"` again and present **only its test-plan
lines**, with the same A/B/C — A now reads *Build it with this plan*, and "go" is still A.

**4. A → record it.** The manifest gets `go-ahead: <name YYYY-MM-DD>` and
`tests: slice=<v> end=<v> review=<v>`, plus any `models=`, `persist=`, `unruled=` or `walk=you` pair
that is not its default — the recommendation taken unchanged is still written. `<test plan>` below is
its label, the three values `·`-joined (`own · touched · end`, ` · you` with `walk=you`).

One call records it — `node <builder>/scripts/advance.mjs <folder> --set "go-ahead=<name YYYY-MM-DD>"
--set "tests=slice=<v> end=<v> review=<v>[ …]" [--set target=<branch>] --head --commit
"chore({key}): {feature} — go-ahead (<test plan>)"`:

- **No `agent_walk:` block** → commit `chore(<ticket-or-feature>): <feature> — go-ahead (<test plan>)`,
  then run `/builder:build --path <folder>` through the Skill tool in the same turn — A was the go.
- **An `agent_walk:` block** → write `target: <branch>` too, commit
  `chore(<ticket-or-feature>): <feature> — go-ahead (<test plan>)`, then run
  `node <builder>/scripts/fleet.mjs <feature> --detach --into <target>`. A target that matches a
  running fleet's joins its queue. A branch that doesn't exist → relay the fleet's refusal and ask
  **Land on?** again.
- **A running fleet with a different target refuses.** Relay its message as written, then one
  AskUserQuestion: **Switch this feature to <the running target>** (rewrite `target:`, commit, launch
  again) / **Launch it once that fleet ends** (leave the manifest as written; `/builder:agent --path
  <folder>` then).

**5. C → keep planning.** `go-ahead: none`; `state: planned` stands. Their words decide where it goes:
a change to the plan itself (a slice split, merged or reordered) is made here — `PLAN.md` and the
§Plan index edited, §Writing the plan's checks re-run, committed — and the go-ahead is taken again; a
scope objection routes to `/builder:brainstorm --path <folder>`; a changed requirement or reversed
ruling routes to `/builder:revise --path <folder> <the change>`.

**An old manifest** — `profile:` and no `tests:` — is still read: `profile.mjs` maps it to levers. A
new go-ahead writes `tests:`.

### Build here (`build: here`)

The human chose to build it in this session without the ceremony (REFERENCE §Flags `--here`). Present
the slices and what rides along exactly as above — it is the plan they are about to watch being
built — but **don't stop for an approval**: choosing *here* was the go-ahead. No A/B/C, no questions:
the test plan is the manifest's `tests:`, or the recommendation, written as `tests:`. Write
`go-ahead: <name YYYY-MM-DD> (here)`, commit `chore(<feature>): <feature> — go-ahead (here)`
(`advance.mjs <folder> --set "go-ahead=<name YYYY-MM-DD> (here)" --set "tests=…" --head --commit
"chore({feature}): {feature} — go-ahead (here)"`), and run
`/builder:build --path <folder> --here` through the Skill tool in the same turn. No **Land on?**, no
fleet. Under `--agent-walk`, `build: here` is ignored.

### Picking the test plan ahead — `/builder:agent` and `/builder:fleet`

Agents can take a feature before it is planned, so its go-ahead then runs headless. **Before their
one confirmation, `/builder:agent` and `/builder:fleet` ask the test plan for every pick whose
manifest has neither `tests:` nor an old `profile:`**:

1. **One AskUserQuestion, one question per pick** (up to four picks per call): `Test plan for
   "<feature>"?` — **The recommended plan (Recommended)**, described by `profile.mjs --recommend <folder>`'s
   three values (`own · touched · end`) and, when it has `signals`, its `reason` · **Change it**. A pick with `PLAN.md` gets its slice
   table (`plan-slices.mjs <folder>`) printed above the call.
2. **Change it** → that pick's B questions (§The go-ahead step 3), one call per pick, *Other* and the
   *Walk it yourself* follow-up as written there. A pick with no `PLAN.md` has no slices to count, so
   `--cost` has nothing to say: each option leads with its place in the ladder instead — per slice:
   own `quick — one small run per slice`, own+app `+ one suite run per app`, full `slowest — a suite
   run per slice`, none `fastest — the type-check only`; at the end: touched `one suite run per app`,
   risk `+ an agent walks the risky parts`, everything `slowest — deep set, cross-app E2E, full walk`,
   none `fastest — the type-check only`; review: end `one review`, app `one per app`, slice `one per
   slice`.
3. **Land on?** once for the run (one target per run), in the first call.

Write `tests:` and `target:` to each pick's manifest — never `go-ahead:`, which the plan still records
— and commit `chore(<feature>): test plan <test plan> → <target>` in this checkout before the dry run
(`advance.mjs <folder> --set "tests=…" --set target=<target> --commit "chore({feature}): test plan
<test plan> → <target>"`, one per pick).
The headless go-ahead keeps them (below). A pick that already carries `tests:` or `profile:` is not
asked again.

🔴 **`--auto` and `--agent-walk` never ask**, and print no recap (REFERENCE §The review — the walk
shows it). They present the slices, record
`go-ahead: auto (recommended) YYYY-MM-DD` in the go-ahead commit and **keep a `tests:` (or an old
`profile:`) and `target:` the manifest already carries** — chosen at §Picking the test plan ahead.
Only when one is missing do they write it: `tests: <the levers profile.mjs --recommend <folder>
returns>`, and `target: <the --into this run was given>` — `<merge_into>` only without `--into`.
Without an `agent_walk:` block, `--auto` returns here — the run that called this step carries on into
the build. Plain `--auto` with the block then launches the fleet as in step 4;
**`--agent-walk` launches nothing** — the fleet is already running it.

```
📍 <feature>: planned — <m> slices in <apps>, test plan <test plan> — next: A builds it (/builder:build --path <folder>) · or say go
   Agents build features once agent_walk is set up — /builder:init --update adds it.
```

That is the footer under the A/B/C without an `agent_walk:` block — the second line only without the
block. With it, the footer's `next:` is `A — agents build it, landing on <target>`; on A the go-ahead
ends on the fleet's launch line, verbatim, then:

```
📍 <feature>: go-ahead (<test plan>) — agents are building it in its own worktree, landing on <target> — follow it: /builder:status
```

On C:

```
📍 <feature>: planned, go-ahead none — next: say what to change, or /builder:resume --path <folder> to take the go-ahead
```

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
