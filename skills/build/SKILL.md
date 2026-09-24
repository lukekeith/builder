---
name: build
description: The code-changing step of the /builder:* pipeline — executes the feature's committed PLAN.md through the plugin's own task loop: a fresh implementer per task reading the task block with its code, the SPEC section it implements, the frozen contract, the recipe skill and the project's global constraints; a task review after each; ONE APP PER PHASE with that app's fast gates at every phase close; the contract frozen on the manifest when the producer's phase closes; commits left to the human in any app the config marks commit:manual. Works on the current branch, never creates a worktree, never opens a PR. Resumes from the ledger after any /clear. Use when the user asks to build, implement or continue building a specced feature.
---

# `/builder:build` — PLAN.md, executed by subagents

Invocation: **`/builder:build --path <folder> [--ticket <id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — **ignore any flag this step does not use rather than
erroring on it**.

**This skill is a wrapper.** [`EXECUTION.md`](EXECUTION.md) owns the loop — setup, dispatch, the task
review, the fix loop and its breaker, the final review, the "Rulings I made" list. **Read it first**,
then REFERENCE (§Contract and the contract freeze · §PLAN.md · §SPEC.md · §MANIFEST.md · §Branch and
ticket) and **`.claude/builder.md`** (§Quality gates for the per-app fast sets · §Global constraints
for every brief · §House rules · §Environment landmines). Everything below is the binding this
pipeline puts on top of that loop.

Input: `<folder>/PLAN.md` — the plan, and the only thing executed — with `SPEC.md` read for the
sections a task implements and `MANIFEST.md` for state, plus the ledger. Output: code — **one commit
per task, written by its implementer** (or staged, where the config says so) — one ledger line per
phase, and the manifest written **only** at a stop, at the go-ahead when taken here, **at the
producer's phase close (the contract freeze)**, and when the last phase signs.

**The commit key** is `--ticket` when given — and a given `--ticket` is written to the manifest's
`ticket:` line; absent, the manifest's `ticket:`, and absent that, the feature name.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `planned` or `building`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `state: planned` **and** `go-ahead:` carries a name + date | run |
| `state: planned` **and** `go-ahead: none` | present `PLAN.md`'s `## Phases` table — phase · app · tasks · goal · gates, with the totals and which phase freezes the contract — and take the go-ahead here through `ExitPlanMode`. Yes → write `go-ahead:`, commit, run. No → hand back. ⛔ Never hand back to the plan step for this. Under `--auto` the table is presented and the run proceeds |
| `state: building` | resume — the ledger is ground truth, not the conversation |
| §Findings has a `blocked:` row | name the row and its clearer, hand back, stop. A `build-time risk` row is **not** a blocker — it rides into its task's brief |
| `state: built` · `signed-off` · `verified` · `shipped` | already built. Say so naming the state, hand back, stop |
| `state: spec` · `aligned` · `audited` | not planned yet. One line naming the state and the step that owns it, hand back, stop |

```
📍 <feature>: <manifest state> — not built: <reason> — next: <the command the row names>
```

## Setup

[`EXECUTION.md`](EXECUTION.md) §Setup is the procedure — the workspace, the no-worktree rule, the
ledger and its identity line, the resume point, and the pre-flight conflict scan. Run it as written.
Two things it leaves to this skill:

- **The workspace command** is `<builder>/scripts/workspace <feature>`, `<feature>` being the
  folder's basename. 🔴 Re-resolve it inline in every command; a shell variable does not survive
  between Bash calls, and a brief written to an unresolved path lands at `/task-1-brief.md`.
- **The pre-flight scan's third row type is this pipeline's:** one row per task for whether its
  `Files` stay inside its `App:`. A task reaching into another app breaks that phase's gates.

## The task loop

[`EXECUTION.md`](EXECUTION.md) §The task loop is the loop. What this pipeline adds to each brief:

### Composing the brief

1. `<builder>/scripts/task-brief <folder>/PLAN.md N "<WS>/task-N-brief.md"` — with the **explicit
   outfile**, always.
2. **Nothing is trimmed.** The plan keeps nothing between task blocks and nothing after the last one,
   so what the script wrote is exactly one task.
3. **Append four blocks**, in this order:
   - **The SPEC section(s) this task implements**, copied: the ones the block's **Files**, its `App:`
     and `Phase:` lines and its **Interfaces** point at — a schema task → §Schema & API changes + the
     Data plan; work in an app → that app's §<App> section; the tests → §Testing — plus every
     §Decisions row binding the task and any §Findings row marked `build-time risk` naming it.
   - 🔴 **§Contract, always, on every task in every app.** The producer implements exactly it; each
     consumer codes against exactly it. An implementer who never saw the contract is how consumers
     diverge. **Say whether it is frozen** — once the producer's phase has closed, the brief states
     that the shape is fixed and that a mismatch is reported, never worked around.
   - **What the block's `Recipe:` line names, read first** — the path, not the text. In prototype
     mode, a task implementing a design item also takes that item's contract path and its frozen
     snapshot: the contract is the item's spec, and an undesigned state is not invented here.
   - **The config's §Global constraints, verbatim**, with `<TICKET>` replaced. Paste it **even though
     `PLAN.md`'s header carries the same block**: the implementer sees only its own block plus this
     brief. A later session must not "de-duplicate" it away.

### Dispatch, review, fix

EXECUTION.md §1–5 unchanged, with these bindings:

- **Report file:** `<WS>/task-N-report.md`. **Review package:**
  `<builder>/scripts/review-package BASE HEAD "<WS>/review-<base7>..<head7>.diff"` — explicit outfile
  again, and the BASE you recorded, **never `HEAD~1`**.
- **The prompts** are [`prompts/implementer.md`](prompts/implementer.md),
  [`prompts/task-reviewer.md`](prompts/task-reviewer.md) and
  [`prompts/re-review.md`](prompts/re-review.md). The implementer's `[COMMIT_INSTRUCTION]` comes from
  the config: an app marked `commit: auto` commits its own task; one marked **`commit: manual`
  stages and stops**.
- **The reviewer gets §Contract** as well as the constraints block, and checks the diff against it
  rather than against the implementer's description.
- **Batch small same-shape tasks** per EXECUTION.md — 🔴 **only ever within one app**.
- **Carry the config's §Environment landmines into the dispatch** when one applies to this task. A
  fresh implementer has never met them, and the commonest class — a service that does not reload, a
  tool that must run from a particular directory, a cache that must be rebuilt first — makes a test
  pass or fail against a lie. Put the remedy **in the step**, not in the prose.

## Phase close — the controller's own work

A phase closes when every task the `## Phases` table assigns to it carries a `Task N: complete` ledger
line. **The table's `Tasks` cell is the membership source; a block's `Phase:` line is its per-block
echo** — when they disagree, the table decides and the mismatch is said out loud. Then:

1. **That app's fast set, fresh** — from the config's §Quality gates, run from there, never from
   memory. Report a delta where the config asks for one, and record a gate the config marks
   KNOWN-RED as BLOCKED with evidence rather than failing on it.
   ⛔ **No cross-app walk, no deep set here** — that runs once, in `/builder:verify`.
2. 🔴 **A phase whose gates are red does not close.** Each failure becomes a fix dispatch against the
   task that caused it, reviewed like any other finding — never a controller fix — then the gate
   re-runs.
3. 🔴 **If this was the PRODUCER's phase, freeze the contract.** Write `contract: frozen <YYYY-MM-DD>`
   to the manifest and commit it with the phase's ledger line:
   `chore(<ticket-or-feature>): <feature> — contract frozen at phase N`. **This is a manifest write
   moment** and the one exception to "the manifest is not written at a phase close". Every consumer
   task after it is briefed against a frozen contract.
4. **If the phase landed `SC#` rows,** tick each row's Status in §Schema & API changes with its real
   migration id. That is **the one docs-only commit the build allows**:
   `docs(<ticket-or-feature>): <feature> — SC# landed`.
5. **One ledger line:** `Phase N (<app>): closed — gates <one line> · <sha>`.
6. **Otherwise the manifest is not written here** — per-phase state is the ledger plus `git log`.
7. **Start the next phase in the same turn.** The go-ahead covered the whole plan.

### 🔴 A phase in a `commit: manual` app closes differently

Where the config marks an app `commit: manual` — typically because it produces a released artifact
nobody can hot-fix — an implementer writes its code and its tests **and stops before the commit**:

- the task's final step is `git add` plus the proposed commit message, **not `git commit`**;
- the controller presents the staged diff and the proposed message, and takes one approval per task
  or one for the phase — the human's choice, offered explicitly;
- that app's gates still run as the phase's gates, and a red gate still blocks the close;
- **anything else the config reserves to the human for that app** — launching it, packaging it,
  releasing it — is offered as their next action, never done here.

Declining to commit is not a problem: the ledger and the working tree carry the state, and the walk
can still happen from a dirty tree with that said plainly.

## Stops

EXECUTION.md's five stop classes, plus this pipeline's bookkeeping:

1. Tick the ledger: tasks complete, the open fix round if any, one line on where the phase stands,
   and anything for `## env notes`.
2. Write the manifest — `state: building`, `next: /builder:resume --path <folder>`, `head`, `branch`.
3. Commit it alone: `chore(<ticket-or-feature>): <feature> — stopped mid-phase N`. **Nothing else is
   committed by the controller mid-build.**
4. Hand off ending `run /clear, then /builder:resume --path <folder>`.

## When the last phase signs

1. **Fast gates** for every app the build touched, as at any phase close.
2. **The final whole-branch review** — EXECUTION.md §The final whole-branch review, using
   [`prompts/final-reviewer.md`](prompts/final-reviewer.md) on the most capable model, pointed at the
   ledger's deferred-minor and parked lines **and at §Contract**. ONE fix dispatch, one scoped
   re-review, then adjudicate. No second fix wave.
3. **The walk script** — write it to `<WS>/walk.md` **and print it in the hand-off**. 🔴 **It is per
   app**: a multi-app feature is walked in more than one place, and a script naming one of them gets
   half a sign-off. Per app: where to go, what to do, what to look for **newest-first**, and the local
   facts the human needs — taken from the config's §Environment landmines, plus which surfaces cannot
   work locally. The walk is the human's; no agent signs it.
4. **Manifest:** `state: built`, `next: 🔒 your walk → /builder:signoff --path <folder>`, `head`,
   `branch`. Commit: `chore(<ticket-or-feature>): <feature> — built, awaiting the walk`.
5. **"Rulings I made"** goes in the hand-off — every ledger line containing `Ruling:`, in order, each
   with what it costs if wrong. It is the only place those decisions reach the human.
6. ⛔ **Do not delete the workspace** — the walk, verify and the sign-off still read it.
   `/builder:ship` removes it.

## 🔒 This skill never opens a PR

Not per phase, not at the end. The PR comes after the human's walk + sign-off + verify. Don't call the
branch "verified" or "ready to merge" while only agents have exercised it. It also never writes to
the ticket system, never deploys, and never edits the design source.

## Exit handoff

What landed (phases · apps · tasks · commits), the rulings list, whether the contract froze, any
staged commits awaiting approval, blockers, the next command, and one footer:

```
📍 <feature>: building — phase N/M (<app>), stopped — next: /clear, then /builder:resume --path <folder>
📍 <feature>: built (<M> phases across <apps>, <T> tasks) — next: 🔒 your walk → /builder:signoff --path <folder>
```
