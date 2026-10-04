---
name: build
description: The code-changing step of the /builder:* pipeline — executes the feature's committed PLAN.md through the plugin's own task loop: a fresh implementer per task reading the task block with its code, the SPEC section it implements, the frozen contract, the recipe skill and the project's global constraints; a task review after each; ONE APP PER PHASE with that app's fast gates at every phase close; the contract frozen on the manifest when the producer's phase closes; commits left to the human in any app the config marks commit:manual. Works on the current branch, never creates a worktree, never opens a PR. Resumes from the ledger after any /clear. Use when the user asks to build, implement or continue building a specced feature.
---

# `/builder:build` — PLAN.md, executed by subagents

Invocation: **`/builder:build --path <folder> [--ticket <id>] [--auto] [--agent-walk] [--no-dev-env]`**. Flags:
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

**The build profile (under `--agent-walk`).** Read the levers:
`node <builder>/scripts/profile.mjs --levers <folder>`. The floors in its `floors` hold whatever
the levers say — each app's fast gates at its phase close and the final whole-branch review always
run. Without `--agent-walk` the build runs as written here.

- **`review: final`** → no per-task reviewer; the final whole-branch review always runs.
  **`per-task`** → as written. **`per-task+second`** → also a second reviewer, on the most capable
  model, on any task touching §Contract or §Schema.
- **`models`** → EXECUTION.md §Model selection's `economy` / `strong` lines; `default` is as written.
- **`unruled: park`** → a choice the spec doesn't settle parks the feature (§Stops) instead of taking
  the recommendation. `recommend` → a ruling, as written.

**The commit key** is `--ticket` when given — and a given `--ticket` is written to the manifest's
`ticket:` line; absent, the manifest's `ticket:`, and absent that, the feature name.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `planned` or `building`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `state: planned` with a go-ahead, or `state: building`, **and** the manifest carries `profile:` or `target:` (a 4.9 go-ahead) **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | agents build it: hand off to `/builder:agent --path <folder>`. Never build it here. Neither key (a 4.8 go-ahead) → the rows below, as before |
| `state: planned` **and** `go-ahead:` carries a name + date | run |
| `state: planned` **and** `go-ahead: none` **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | agents build it: hand off to `/builder:plan --path <folder>` — its go-ahead picks the build profile and launches the fleet. Never take the go-ahead or build it here |
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
   - **The four craft skills, by path** — `test-driven-development`,
     `systematic-debugging`, `receiving-code-review` and `verification-before-completion`
     (REFERENCE §The craft skills). Paths, never pasted text.
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
- **The implementer runs its own tests and the type-check, not the app's suite.** The prompt says
  so; do not add "run the full suite" to a dispatch. The suite is the phase close's, once, through
  the gate runner — an implementer running it per task was the largest single cost measured in a
  real build, and it proved nothing the phase close did not prove again minutes later.
- **Batch small same-shape tasks** per EXECUTION.md — 🔴 **only ever within one app**.
- **Carry the config's §Environment landmines into the dispatch** when one applies to this task. A
  fresh implementer has never met them, and the commonest class — a service that does not reload, a
  tool that must run from a particular directory, a cache that must be rebuilt first — makes a test
  pass or fail against a lie. Put the remedy **in the step**, not in the prose.
- 🔴 **Under `--agent-walk`, after each task (and its review, when there is one):** if `$BUILDER_FLEET_DIR/requests/<feature>.pause`
  exists — the fleet sets `BUILDER_FLEET_DIR` to the main checkout's fleet dir, since this run's cwd
  is its worktree; unset → `.builder/fleet/requests/<feature>.pause` — tick the ledger, write `blocked: "revising — next: /builder:revise --path <folder>"` to the
  manifest, commit it (`chore(<ticket-or-feature>): <feature> — parked: revising`) and stop. The
  ledger keeps every finished task.

## Phase close — the controller's own work

A phase closes when every task the `## Phases` table assigns to it carries a `Task N: complete` ledger
line. **The table's `Tasks` cell is the membership source; a block's `Phase:` line is its per-block
echo** — when they disagree, the table decides and the mismatch is said out loud. Then:

1. **That app's fast set, through the gate runner:**
   `node <builder>/scripts/gate.mjs <app>` (under `--agent-walk`, started with `job.mjs start` and
   waited on — REFERENCE §Quality gates). It runs the config's block for that app, applies the
   config's `flaky:` re-runs, `@delta` baselines and `@known-red` marks itself, and prints one
   verdict line per command and one for the set. 🔴 *Fresh* is
   [`verification-before-completion`](../verification-before-completion/SKILL.md)'s iron law, and the
   runner is how it is kept: a set is quoted only when the runner itself proves its inputs are
   byte-identical to its last green run, and it says so with the sha. A gate result you remember
   from an earlier message is not one. Never run the block's commands by hand to "save time" and
   never read the config's tails to decide what a failure means — the runner's `✗` lines carry the
   tail, and a `✗` is a red gate, full stop.
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
4. Hand off ending `say go to continue here, or run /clear first, then /builder:resume --path <folder>`
   — all state is on disk, so continuing in this session loses nothing but room.

**Under `--agent-walk`, nothing runs in the background** — implementers, reviewers and gates run in
the foreground, and a long gate goes through `scripts/job.mjs` (resume §`--agent-walk`).

**Under `--agent-walk`, nobody is there to ask — and almost nothing needs asking** (resume
§`--agent-walk`: agent mode builds to done). Of the five stop classes:

- **an irreversible or destructive operation, a security-sensitive action, a side effect outside the
  repo** — none is ever needed to build a feature to merged-locally. Take the path that avoids it (a
  new migration instead of an edited one, a local stub instead of a live service, no push, no
  deploy), record `Ruling: <the path taken> — avoided <the operation> under --agent-walk`, and keep
  going. Not a park.
- **a commit in a `commit: manual` app** (from the start of its phase) and **a plan so broken that
  every path forward is a guess at what the product should be** — these park: write
  `blocked: "<the stop class, and what it stopped on, in plain words> — next: <step>"` (REFERENCE §How a park reads) to the manifest, and `<folder>/PARKED.md` (REFERENCE §The park
  record; `kind: human-step` for a `commit: manual` app, `decision` for a broken plan), in the same
  ledger line and manifest commit as steps 1–3, the subject `chore(<ticket-or-feature>): <feature> — parked: <stop class>`, and
  **end the run**. A plan that is merely wrong in places is not this: rule, fix the task, go on.
- **Under `unruled: park`**, a choice the spec doesn't settle parks the same way (`kind: decision`),
  naming the choice — no ruling taken.

Never ask.

## When the last phase signs

1. **Fast gates** for every app the build touched: `node <builder>/scripts/gate.mjs <app> <app>…` in
   one call. An app with no commit since its phase close is quoted by the runner, not re-run — that
   is the point of running it this way, and the quoted line is the evidence.
2. **The final whole-branch review** — EXECUTION.md §The final whole-branch review, using
   [`prompts/final-reviewer.md`](prompts/final-reviewer.md) on the most capable model, pointed at the
   ledger's deferred-minor and parked lines **and at §Contract**. ONE fix dispatch, one scoped
   re-review, then adjudicate. No second fix wave.
3. 🔴 **Walk readiness** — [REFERENCE](../resume/REFERENCE.md) §Walk readiness: pending
   migrations applied to the **dev** database (asked for, not assumed), stale processes restarted,
   the running app smoked on every surface this feature changed. A defect it finds is a fix dispatch
   like a red gate, then it runs again. **Still `pending` → stop here**: no walk script, no
   `state: built`; write `state: building`, `ready: pending "<what>"`,
   `next: <what the human must do>, then /builder:resume --path <folder>` and hand off saying exactly
   that. Under `--auto` this is a stop too — the walk is its terminal state, and this precedes it.
   **Under `--no-dev-env`** (the fleet's build lane): don't run readiness at all. Instead, **run the
   deep set here**, where it runs in parallel with other builds instead of holding the one-at-a-time
   walk lane: `node <builder>/scripts/gate.mjs --deep <every in-scope app>` through `job.mjs`. Red
   deep gates are fix dispatches like any red phase gate. Verify will quote this run if nothing
   changes the tree before it — and re-run it if something does. Then write `state: building`,
   `ready: pending "dev env (fleet walk lane)"`, `next: /builder:resume --path <folder>`, commit
   `chore(<ticket-or-feature>): <feature> — phases closed, awaiting the walk lane`, and end the run. **Under `--agent-walk`**, readiness never asks: resume §`--agent-walk` says what each question
   becomes. With `agent_walk.start` set, the fleet has already started the walk env for this worktree —
   never start or restart it here (REFERENCE §Walk readiness).
4. **The walk script** — write it to `<WS>/walk.md` **and print it in the hand-off**. 🔴 **It is per
   app**: a multi-app feature is walked in more than one place, and a script naming one of them gets
   half a sign-off. Per app: where to go, what to do, what to look for **newest-first**, and the local
   facts the human needs — taken from the config's §Environment landmines, plus which surfaces cannot
   work locally. The walk is the human's; no agent signs it.
   **Under `--agent-walk`**, append the cross-app walk after the per-app sections, so the agent walk
   runs it in the same live session and verify need not drive the app again (verify item 10):
   `## Cross-app (verify E2E)`, then SPEC §Testing's walk script as numbered steps `E1…En` — each
   one line of what to do and one of what to see, in the script's order. Without `--agent-walk`,
   `walk.md` stays per-app only.
   **Tag `[risk]`** on every item touching a §Contract row, an auth or permission path, a
   load/save/delete path, a notification payload or a deep-link target (verify's re-walk table) — the
   agent walk under `testing: risky` walks only those.
5. **Manifest:** `state: built`, `ready: yes <date> <sha>`, `next: 🔒 your walk → /builder:signoff --path <folder>`, `head`,
   `branch`. Commit: `chore(<ticket-or-feature>): <feature> — built, awaiting the walk`.
   **Under `--agent-walk`:** `next: /builder:agent-walk --path <folder>` and keep going into it — the
   walk script is still written (the agent walks it), and no human is asked to.
6. **"Rulings I made"** goes in the hand-off — every ledger line containing `Ruling:`, in order, each
   with what it costs if wrong. It is the only place those decisions reach the human.
7. ⛔ **Do not delete the workspace** — the walk, verify and the sign-off still read it.
   `/builder:ship` removes it.

## 🔒 This skill never opens a PR

Not per phase, not at the end. The PR comes after the human's walk + sign-off + verify. Don't call the
branch "verified" or "ready to merge" while only agents have exercised it. It also never writes to
the ticket system, never deploys, and never edits the design source.

## Exit handoff

What landed (phases · apps · tasks · commits), walk readiness (migrations applied, restarts, what
the smoke exercised), the rulings list, whether the contract froze, any
staged commits awaiting approval, blockers, the next command, and one footer:

```
📍 <feature>: built, not walkable yet — <what is left> — next: <the human's step>, then /builder:resume --path <folder>
```

Stopped mid-build, or built and walkable, the footer is two-way (REFERENCE §The two-way footer):

```
📍 <feature>: building — phase N/M (<app>), stopped (go continues here; /clear first for a fresh context) — next:
   1. resume — continue here, step by step: /builder:resume --path <folder>
   2. agent  — hand it to agents to finish and merge: /builder:agent --path <folder>
   Reply 1 or 2 (or "resume" / "agent"; "go" is 1)

📍 <feature>: built (<M> phases across <apps>, <T> tasks) — next:
   1. resume — 🔒 your walk → /builder:signoff --path <folder>
   2. agent  — agents walk it, sign off, verify and merge: /builder:agent --path <folder>
   Reply 1 or 2 (or "resume" / "agent")
```

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
