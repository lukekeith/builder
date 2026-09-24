---
name: plan
description: Turn an audited feature spec into a committed implementation plan at docs/features/<feature>/PLAN.md, written by composing superpowers:writing-plans — dependency-ordered phases, ONE APP PER PHASE with the server before its consumers (contract + migrations → server → client ∥ iphone → capture → the cross-app E2E walk last), each task naming its app, its phase, the recipe skill to read first, its files and interfaces, and bite-sized steps carrying the actual code and tests. SPEC §Plan becomes a one-line-per-task index pointing at PLAN.md. Runs only after /builder:audit, with no OPEN decisions and no blocked findings. Ends by taking the build go-ahead and recording it on the manifest. Use when the user asks to plan a spec's implementation.
---

# `/builder:plan` — the audited spec becomes phases

Invocation: **`/builder:plan --path <folder> [--ticket <monday id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

**Load REFERENCE before writing anything**, and cite it rather than restate it: §PLAN.md is the shape of
the file this step writes · §SPEC.md says what the §Plan index holds and where it sits · §Sizes gives
the phase counts · §Quality gates gives the per-app fast set a phase's `Gates` column names and the
E2E rule · §Contract and the contract freeze is what the phase ORDER exists to protect · §House rules
is what each phase's work has to satisfy · §MANIFEST.md is the file written at the end · §Branch and
ticket.

Input: `<folder>/SPEC.md` + `<folder>/MANIFEST.md`. Output: `<folder>/PLAN.md` — the plan itself, with
its code — the §Plan index appended to that SPEC, the manifest at `state: planned`, and the build
go-ahead taken in the same turn. **No app code is written here.**

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node .claude/scripts/list-feature-specs.mjs --json` and offer only the folders
whose state is `audited`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` — the folder shipped and was condensed, or it is a pre-builder layout (REFERENCE §Condense) | this step does not run on it. Say so in one line, hand back to `/builder:resume --path <folder>`, stop |
| `state: spec` or `state: aligned` | not audited yet. One line naming the state, hand back, stop |
| `state: audited` **and** §Decisions has an OPEN row | the decisions gate owns it. Name the OPEN rows, hand back, stop |
| `state: audited` **and** §Findings has a `blocked:` row | name the row and the clearer it carries — the audit's exit wrote both — hand back, stop |
| `state: audited`, no OPEN row, no `blocked:` row | run |
| `state:` `planned` or anything further along | already planned. Say so naming the state, hand back, stop |

Handing back is that one line plus its own footer, carrying the manifest's own `state`:

```
📍 <feature>: <manifest state> — not planned: <reason> — next: <the command the row names>
```

⛔ **A §Findings row marked `build-time risk` is not a blocker and never a reason for another audit
pass** — the cap is spent (`builder:audit` §The pass cap). Each one names the phase or task that settles
it; **copy the note onto that task** so it arrives with the work.

## What the plan is

One committed file, `<folder>/PLAN.md`, holding the tasks **and the code they carry** — the human reads
it at the go-ahead, a reviewer sees it in the PR, and the sign-off condense deletes it with `git log`
keeping it. The plan is never inside the SPEC: the SPEC gets a §Plan index only.

**Its shape is [REFERENCE](../resume/REFERENCE.md) §PLAN.md** — write what that section specifies,
reading it there rather than from a restatement. In short, the file is, in order:

- the `superpowers:writing-plans` header — kept whole, its `REQUIRED SUB-SKILL` line included — then
  **Goal**, **Architecture**, **Tech Stack** and **Spec:** pointing at this feature's `SPEC.md`;
- `## Global Constraints`, copied verbatim from [CONSTRAINTS.md](../build/CONSTRAINTS.md);
- the `## Phases` table, columns `Phase · App · Tasks · Goal · Gates`;
- flat `### Task N: <name>` blocks — `App:`, `Phase:`, `Recipe:`, **Files**, **Interfaces**, then
  bite-sized `- [ ]` steps carrying the actual code, the run command with its expected output, and the
  commit.

**How those steps are written is `superpowers:writing-plans`' own law, not this skill's** — its
§File Structure, §Task Right-Sizing, §Bite-Sized Task Granularity, §No Placeholders and §Self-Review
sections. They are named here and not restated: that skill is invoked (§Composing the plan below), and
its text is the rule, so upstream fixes arrive for free.

- **Task numbering runs across the whole plan** — Task 1 … Task N continue through every phase, in
  `PLAN.md` and in the SPEC index alike, because SDD's `task-brief` keys on the literal `Task N`
  heading.
- **Every task names the recipe skill to read FIRST** on its `Recipe:` line
  (REFERENCE §Companion skills) **and ships the tests that belong to it**. Tests are never a later task
  and never a later phase.
- **The `Gates` cell is the fast set for THAT PHASE'S APP** (REFERENCE §Quality gates) — never another
  app's, never the deep set, never the cross-app E2E walk.
- **A phase must fit one session** — roughly ≤5 components, ≤6 endpoints or ≤6 views. Above that, split
  the phase.

## 🔴 One app per phase, server before its consumers

**The binding rule of this pipeline's phase derivation.** A phase names exactly one app on every task's
`App:` line and in the table's `App` column. Two reasons, and both are load-bearing:

1. **Each app's gates are different commands.** A phase that touched the server and the iPhone app
   cannot be gated — `tsc --noEmit` says nothing about Swift, and `ios:build-check` says nothing about
   a route. A phase whose gates cannot close is a phase that closes on a feeling.
2. **The contract freezes when the server phase verifies** (REFERENCE §Contract and the contract
   freeze). Consumers built against a moving contract are how one of them ships broken — and the
   iPhone one cannot be hot-fixed.

The order that follows:

| Order | App | Why it is here |
|---|---|---|
| 1 | **contract + migrations** | schema YAML rows and their generated migrations, in the Data plan's ordering. Its own phase when there are several; folded into the server phase when there is one |
| 2 | **server** | produces the contract. Nothing consumes it yet. 🔴 **Its close is the freeze** — record `contract: frozen <date>` on the manifest at that phase close |
| 3 | **client** ∥ **iphone** | consume the frozen contract, and are parallelizable **because they never import each other**. Order them by risk: the iPhone app first when a shipped build is affected, since its findings are the expensive ones |
| 4 | **capture** | fixtures, adapters, twins and `/compare` registration for the surfaces the consumers changed. It reads both consumers, so it comes after both |
| 5 | **the cross-app E2E walk (LAST)** | 🔴 authored here and run only by `/builder:verify` (REFERENCE §Quality gates). Never an E2E task or gate in an earlier phase |

A one-app feature has one or two phases and none of this bites. It bites on every feature that doesn't.

## Deriving the phases — written-spec mode

Dependency skeleton **within** the app order above. Drop what the spec doesn't need; merge freely at
`size: md`.

| Phase | App | Contents |
|---|---|---|
| Contract + migrations | server | one task per §Schema & API changes row, in the Data plan's ordering: edit `server/schema/*.yaml`, run `npm run schema:diff`, review the generated migration. 🔴 Never hand-edit a committed migration. The Data plan executes before the migration that needs it |
| Server | server | services first (they own the logic and the org check), then the thin route modules per `/api`, with their unit and request tests **in the same task**; zod schemas that do not strip consumer fields; external integrations behind their service module. 🔴 `docker restart makeready-server` in every step that tests a `server/src` edit |
| Client | client | `/admin/api` proxy entries, Pinia domain stores then UI stores, Blade route + view, the island, design-token SCSS, component tests per `/component` · `/page` · `/store` |
| iPhone | iphone | `AppState` entities and properties, then Actions (a mutating Action refreshes derived state in the same call), then `Route` cases per `/present-overlay` · `/push-page` · `/nav-route`, then Pages and Components, then offline/disk-cache behaviour and push deep links |
| Capture | capture | `/compare` fixture + adapter + twin per changed surface (`/capture-add`, `/capture-parity`), ViewRegistry cases, and the screenshot fixtures to re-capture |
| Cross-app E2E + final sweep (LAST) | — | 🔴 the ONE cross-app walk — **authored** here and run only by `/builder:verify` — plus the residual sweep |

## Deriving the phases — prototype mode (the cutover shape)

Same task shape and the same app order; the tasks come from the spec, not from re-reading the app:
the backend phase from §Findings' `T#` rows and §Schema & API changes, the consumer phases from
§iPhone / §Client and §Contract, the repoint phase from §Findings' `repoint:` rows — **each already
tagged with its owning app by the audit**.

| Phase | App | Contents |
|---|---|---|
| 0. Missing registry row *(only when owed)* | — | a §Findings row naming a 2.0 component with no registry row is the plan's **first** task, and it is routed to `/ui2-component`, not built inline. It blocks every consumer phase below it |
| 1. Backend worklist + schema | server | §Findings' `T#` rows via their recipe skills, **blocking rows before trailing ones**, and §Schema & API changes' `SC#` rows **in the Data plan's ordering** — one task per row. A needed change with no `SC#` row → add the row (reason + Data plan) **before** writing its migration task, and note the miss in §Findings |
| 2. The consumer's state layer | iphone / client | `AppState` entities + Actions, or the Pinia stores and `/admin/api` entries; unit tests for the derived state and the guards |
| 3. Screens + routes | iphone / client | the `Route` cases and Pages, or the Blade route and island; **the UI 2.0 contract is the spec for each component** — its designed states, its tokens, its props — and a state the contract does not designate is not invented here |
| 4. Real wiring | iphone / client | the design's actions bound to the verified endpoints exactly as §Contract documents them, error-to-UI routing included |
| 5. Repoint + retire | one phase PER APP | **one task per §Findings `repoint:` row**, in that row's app, with its `file:line` sites listed (route strings, `Route` cases, imports, deep links, push payload targets); **the retirement list as its own task and its own commit**; §Prototype's frozen paths respected absolutely; then a **residual-sweep task** per app — re-grep every retired route string and import to **zero hits**, with behavioural test guards on a retired surface **ported, not deleted** |
| 6. Capture | capture | re-capture every changed surface and diff it; a twin that asserted against a retired surface is repointed or retired with it |
| 7. Cross-app E2E (LAST) | — | 🔴 authored here, run only by `/builder:verify` |

A `repoint:` row with no sites still gets its task: the task is the re-grep that proves it.

## Size dials

**`size: md` → 2–4 phases; `size: lg` → 4–7** (REFERENCE §Sizes). **Both skeletons above are orderings,
not phase counts** — merge adjacent rows **of the same app** until the plan lands inside the dial, and
split a phase that outgrows one session. 🔴 **Merging never crosses an app boundary**: two phases of the
same app merge freely, a server phase and an iPhone phase never do, whatever the dial says. A four-app
feature therefore has at least four phases, and that is correct — the dial reads the derived count, and
a four-app `md` sitting at 5 phases is not oversized, it is a monorepo.

**Phases are renumbered 1..n sequentially** once the merging is done — the skeletons' numbers are
orderings, not the numbers that land in the `## Phases` table and on the tasks' `Phase:` lines.
`PLAN.md` carries **no `Phase N` heading at any level**: any heading between two task blocks is swept
into the earlier task's brief (REFERENCE §PLAN.md).

**A plan landing at 9+ phases is a feature that should be two.** Present the split before taking any
go-ahead — by delivery slice (each half independently shippable) or by domain — and proceed only on the
split, or on an explicit "build it whole". **`--auto` does not decide this**: a split creates feature
folders, which is a scope change and outside autopilot's remit; present it and stop.

## Composing the plan

Four steps, in order. The plan is **written by `superpowers:writing-plans`**, not by hand here.

**1 — Derive the phases** from the SPEC, using whichever skeleton above matches the mode, in the app
order, merged and split to the size dials. This settles the phase list, each phase's app, its goal and
its gates *before* any task is written.

**2 — Invoke `superpowers:writing-plans`** (the Skill tool, `skill: superpowers:writing-plans`), and
state in the invocation:

- **the input** — the audited `<folder>/SPEC.md`. That skill argues from the spec, and the plan's
  `Spec:` header line points back at it;
- **the plan location** — `<folder>/PLAN.md`, which overrides that skill's default
  `docs/superpowers/plans/YYYY-MM-DD-<name>.md` (it defers to a stated location);
- **the Global Constraints** — the contents of [CONSTRAINTS.md](../build/CONSTRAINTS.md) verbatim, with
  `<TICKET>` replaced by the key (`--ticket` when given, else the manifest's `ticket:`, else the feature
  name), bullets left unwrapped;
- **the phases from step 1, with their apps**, so the tasks land inside them and each carries its `App:`
  line.

**3 — Its closing execution-choice prompt is NOT presented.** `writing-plans` §Execution Handoff ends by
offering *"Subagent-Driven or Inline?"*; that question is already answered here — the engine is always
`/builder:build`, and §Hand off's go-ahead is the one approval this pipeline takes. Suppress the prompt,
and never put the choice to the human. Its §Scope Check is routed, not answered too: a suggestion to
split the spec into independent plans is a **scope change** — say so in one line, hand to
`/builder:brainstorm --path <folder>`, and stop, exactly as the 9+ phase split does.

**4 — The MakeReady pass over the written plan**, before anything is committed:

- the `## Phases` table from step 1 is written above the first task block — writing-plans' header has
  none, so this step adds it: columns `Phase · App · Tasks · Goal · Gates`, one row per phase, `App` the
  ONE app it touches, `Tasks` the task-number range (`1–3`), `Goal` 1–2 sentences on what exists at its
  end;
- every `### Task N` block opens with an `App:` line and a `Phase:` line, assigned in step 1's order;
- every block carries a `Recipe:` line — the recipe skill to read FIRST (REFERENCE §Companion skills);
  for work with no companion skill, the REFERENCE section that governs it instead;
- every row of that table carries its `Gates` cell — **that app's fast set only**, never another app's,
  never the deep set, never the cross-app walk outside the last phase;
- 🔴 **verify the one-app rule mechanically**: no task block's `Files` list crosses `server/`,
  `client/`, `iphone/` or `capture/`. A task that does is split in two, one per app, and the phases
  re-derived;
- the tests a task owes are in **that** task — its steps, its commit — not a later one;
- every §Findings row marked `build-time risk` is **copied onto the task that settles it**;
- **the server phase's last task records the freeze** — a step that writes `contract: frozen <date>` to
  the manifest, so no consumer task starts against an open contract;
- then `writing-plans`' own §No Placeholders scan and §Self-Review, run over the finished file.

🔴 **Nothing follows the last task block** — no footer, no closing section, no summary, no separator,
and no `Phase N` heading at any level between blocks. SDD's `task-brief` reads the last task from its
heading to **end of file**, so anything written below it lands in that implementer's brief. The resume
footer at the end of this step is printed **in chat only** — never into `PLAN.md`.

## Hand off

**Two files.** `<folder>/PLAN.md`, the plan itself; and **one SPEC edit** — §Plan appended
**immediately after §Findings & risks**, which is an **index, not the plan** (REFERENCE §SPEC.md): a
pointer to `PLAN.md`, then one line per task reading `Phase N · Task M · <name>` and nothing else. In
prototype mode §Prototype and §Replaced surfaces stay after it. Condense strips §Plan by heading, so
nothing reads it by position. Never per-phase docs.

**The manifest** (REFERENCE §MANIFEST.md): `state: planned`, `head` (the sha at this transition),
`branch`, `next: /builder:resume --path <folder>`. Commit `PLAN.md`, the SPEC and the manifest together:
`docs(<ticket-or-feature>): plan <feature>`.

**Then take the go-ahead, in the same turn.** Present `PLAN.md`'s `## Phases` table as it stands —
`Phase · App · Tasks (range) · Goal · Gates` — with the totals and the path to read the plan itself at,
and name what rides along: the tasks carrying a `build-time risk` note, **which phase freezes the
contract**, and anything deferred with a decider. Take **one explicit approval** through plan mode's
`ExitPlanMode`. That approval covers the whole build; no later phase re-asks.

- **Yes** → write `go-ahead: <name YYYY-MM-DD>` to the manifest and commit it:
  `chore(<ticket-or-feature>): <feature> — go-ahead`. Under `--auto` the table is presented and the run
  proceeds to the hand-off footer, recorded as `go-ahead: auto (recommended) YYYY-MM-DD`; this skill
  writes no app code — the build is `/builder:resume --path <folder>`'s next step.
- **No** → leave `go-ahead: none`; `state: planned` stands and nothing is rebuilt to re-plan. A scope
  objection routes to `/builder:brainstorm --path <folder>`; a changed requirement or a reversed ruling
  routes to `/builder:revise --path <folder> <the change>`.

**Nothing here creates a branch, a worktree or a ticket** (REFERENCE §Branch and ticket). Given
`--ticket`, check that the current branch name carries the key and warn once if it does not.

Then the one-line resume footer, its counts read off the written `PLAN.md`:

```
📍 <feature>: planned, <n> phases across <apps>, <m> tasks, go-ahead <recorded|none> — next: /builder:resume --path <folder>
```
