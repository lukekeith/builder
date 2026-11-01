---
name: build
description: Builds a planned feature from its PLAN.md — a fresh agent and a review per task, one app per phase, on the current branch — and resumes after /clear. Use when asked to build, implement or continue building a specced feature.
---

# `/builder:build` — PLAN.md, executed by subagents

Invocation: **`/builder:build --path <folder> [--ticket <id>] [--auto] [--agent-walk] [--here] [--no-dev-env]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — **ignore any flag this step does not use rather than
erroring on it**.

**`--here`, or the manifest says `build: here` (and not under `--agent-walk`)** → §Build here, and
nothing else in this skill applies — §The test plan's levers included.

**This skill is a wrapper.** [`EXECUTION.md`](EXECUTION.md) owns the loop — setup, dispatch, the task
review, the fix loop and its breaker, the final review, the "Rulings I made" list. **Read it first,
with everything else this step reads, in one call:** `node <builder>/scripts/docs.mjs build` — it
prints EXECUTION.md, then REFERENCE (§Contract and the contract freeze · §PLAN.md · §SPEC.md ·
§MANIFEST.md · §Branch and ticket · §The verifier · §Walk readiness · §The craft skills) and
**`.claude/builder.md`** (§Verification and the `verify:` block · §Global constraints for every
brief · §House rules · §Environment landmines). Everything below is the binding this pipeline puts
on top of that loop.

**Under the fleet (`BUILDER_DIR` is set), `<builder>` is `"$BUILDER_DIR"`** — use it as is; never resolve the path or prefix a command with `B=…;`.

**Under the fleet (`BUILDER_FLEET_DIR` is set):** read in two Bash calls instead, each one Bash
output: `node <builder>/scripts/docs.mjs fleet-build --no-config --path <folder>` — EXECUTION §The task loop
(without §3 under `review=end`), REFERENCE §Contract and the contract freeze · §PLAN.md · §The verifier,
AGENT-MODE §Agent mode in the build lane — then `node <builder>/scripts/docs.mjs fleet-setup` —
EXECUTION §Setup and the part of the config the build acts on. The rest is read with
`docs.mjs section` at the step that needs it — never EXECUTION §Model selection for a routine
dispatch (dispatch.mjs names the model; §Dispatch, review, fix says when to raise it); when the last phase closes, this
skill's §When the last phase signs (it names the others there); after an unpark, AGENT-MODE's
pointer. A fleet build never reads REFERENCE §SPEC.md or §MANIFEST.md, nor EXECUTION's preamble,
whose rules still bind: narrate at most one short line between tool calls, execute every task without
checking in, and type only judgment — the scripts write the rest. Record every ruling as
`Ruling: <what you decided> — <why> — <what it costs if wrong>`; the SPEC binds and the plan argues
from it.

**The orchestrator does not type what a script writes** (REFERENCE §The scripts): every subagent
prompt comes from `dispatch.mjs`, every manifest / ledger / commit change from `advance.mjs`, the walk
script from `walk-script.mjs`, the walk lane's hand-off from `handoff.mjs`. Each is idempotent —
🔴 **after a crash or a `/clear`, re-run the same command**; it finishes what is missing or says
`already applied`.

Input: `<folder>/PLAN.md` — the plan, and the only thing executed — with `SPEC.md` read for the
sections a task implements and `MANIFEST.md` for state, plus the ledger. Output: code — **one commit
per task, written by its implementer** (or staged, where the config says so) — one ledger line per
phase, and the manifest written **only** at a stop, at the go-ahead when taken here, at setup
under `--agent-walk` (`agent-walk: on`), **at the producer's phase close (the contract freeze)**,
and when the last phase signs.

**The commit key** is `--ticket` when given — and a given `--ticket` is written to the manifest's
`ticket:` line; absent, the manifest's `ticket:`, and absent that, the feature name.

## The test plan — read on every build

Read the levers first: `node <builder>/scripts/profile.mjs --levers <folder>` — the manifest's
`tests:` (or the recommendation when there is none). The floor — the final whole-branch review —
holds whatever the levers say. Tests are not a lever: the verifier runs every commit's affected
tests in the background, waits at each phase close, and runs everything on the merged result before
the feature lands (REFERENCE §The verifier).

**`review`** — **`slice`** → a task review after every task (EXECUTION.md §3–4). **`slice+second`** →
also a second reviewer, on the most capable model, on every task touching §Contract or §Schema & API
changes. **`app`** → no task reviewer; one review of the phase's whole diff at its close (§Phase
close).
**`end`** → no task reviewer at all. The final whole-branch review runs under every value.

**`walk`** is `/builder:agent-walk`'s; **`human=yes`** the fleet's; `persist` is agent-walk's.

- **`models`** → EXECUTION.md §Model selection's `economy` / `strong` lines; `default` is as written.
- **`unruled: park`** → a decision §Decisions leaves open parks the build (§Stops) instead of taking
  the recommendation. `recommend` → a ruling, as written.

🔴 **A red verdict is a stop wherever it is read.** A regression the verifier reports is a fix
dispatch against the task that introduced it — the verdict names the commit (`introduced by`), and
the ledger maps a commit to its task — never a controller fix. Flakes, known failures and newly
found debt in a verdict are reported, never fixed here.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `planned` or `building`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `state: planned` with a go-ahead, or `state: building`, **and** the manifest carries `profile:` or `target:` (a 4.9 go-ahead) **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | agents build it: hand off to `/builder:agent --path <folder>`. Never build it here. Neither key (a 4.8 go-ahead) → the rows below, as before |
| `state: planned` **and** `go-ahead:` carries a name + date | run |
| `state: planned` **and** `go-ahead: none` **and** the config has an `agent_walk:` block, **not** under `--agent-walk` | agents build it: hand off to `/builder:plan --path <folder>` — its go-ahead picks the test plan and launches the fleet. Never take the go-ahead or build it here |
| `state: planned` **and** `go-ahead: none` | take the go-ahead here, exactly as plan §The go-ahead does — the slices from `plan-slices.mjs`, the A/B/C, B's questions, `tests:` recorded. A → write `go-ahead:` and `tests:` and commit — the same `advance.mjs` call plan §The go-ahead makes — then run. C → hand back. ⛔ Never hand back to the plan step for this. Under `--auto` the slices are presented, the recommendation recorded, and the run proceeds |
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
  `Files` stay inside its `App:`. A task reaching into another app breaks the one-app phase the
  verifier waits on.

**Under `--agent-walk`, when `git show HEAD:<folder>/MANIFEST.md` has no `agent-walk:` line, run**
this before the first dispatch — it also commits one left uncommitted — so a cold session keeps
agent mode (AGENT-MODE §Agent mode in the build lane):
`node <builder>/scripts/advance.mjs <folder> --set "agent-walk=on <YYYY-MM-DD>" --commit "chore({key}): {feature} — agent walk on"`.

## The task loop

[`EXECUTION.md`](EXECUTION.md) §The task loop is the loop. What this pipeline adds to each brief:

### Composing the brief

`node <builder>/scripts/dispatch.mjs implementer <folder> --task N [--context "<one paragraph>"]`
composes the brief at `<WS>/task-N-brief.md` and the implementer's prompt beside it — and records the
task's BASE the first time. What the brief carries — the script writes it; this is what it holds, so
you know what not to repeat in `--context`:

1. **The task block** exactly as `<builder>/scripts/task-brief` cuts it — from its heading to the next
   `Task` heading.
2. **Nothing is trimmed.** The plan keeps nothing between task blocks and nothing after the last one,
   so what the script wrote is exactly one task.
3. **Then four blocks**, in this order:
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
   - **The config's §Global constraints, verbatim**, with `<TICKET>` replaced — **once, here**: the
     implementer, the task reviewer and the re-reviewer all read this brief, so the prompts point at
     it instead of repeating it. Paste it **even though `PLAN.md`'s header carries the same block**:
     the implementer sees only its own block plus this brief. A later session must not
     "de-duplicate" it away.

   The four craft skills (REFERENCE §The craft skills) are the implementer **prompt's**, by path,
   each with when to read it — TDD and verification before starting, debugging and
   receiving-code-review at the moment each names — never pasted, and not repeated in the brief.

### Dispatch, review, fix

EXECUTION.md §1–5 unchanged, with these bindings:

- 🔴 **Every dispatch is rendered, never typed:** `node <builder>/scripts/dispatch.mjs <kind> <folder> …`
  writes the subagent's whole prompt into the workspace and prints the Agent call on one line — its
  **`subagent_type`** (send it as printed: builder's lean `builder:implementer`,
  `builder:implementer-skills` or `builder:reviewer` unless the config's `agent_types:` says
  otherwise — general-purpose only when this session has no agent of that type), its **`model`**
  (send the model it names: EXECUTION.md §Model selection as a table, the fix-loop escalation
  included — the reason is printed beside it, e.g. `model: haiku (default — tiny)`), its `description`
  and its prompt. Every path it prints is relative to the repo root but the prompt's, which is absolute. The Agent call's prompt is **`Read <file> and do what it says.`** plus, at most,
  one paragraph of context the template cannot know — better passed as `--context`, so it lands in
  the file and survives a crash. **The printed model is the default; raise a `tiny` task to sonnet when it spans files, touches a permission path, or holds state with its mutations; architecture or design work → opus; under `models=economy`, a block that leaves an algorithm or a multi-file choice open → sonnet. Never lower it** — `dispatch.mjs` refuses a `--model` below the printed one.
  Raise it with `--model <m>` on the dispatch, so the model that ran is recorded and rounds 4–5
  escalate one tier above it. The kinds:

  | Dispatch | Command |
  |---|---|
  | the implementer | `dispatch.mjs implementer <folder> --task N [--context "…"]` |
  | the task review | `dispatch.mjs task-review <folder> --task N` — the review package from the recorded BASE, **never `HEAD~1`** |
  | a fix round R | `dispatch.mjs implementer <folder> --task N --round R --findings-file <the findings: file the last review printed>` — rounds 1–3: send the resumed implementer `Read <file> and do what it says.`; rounds 4–5: a fresh Agent, one tier up |
  | its scoped re-review | `dispatch.mjs re-review <folder> --task N --round R --findings-file <the same file>` — the next round's file is this re-review's `findings:` |
  | the phase review (`review=app`) | `dispatch.mjs task-review <folder> --phase N` |

- **Findings travel as files.** Each reviewer writes its report to the workspace file its dispatch
  names (`findings: <WS>/task-N-review.md`, `task-N-re-review-R.md`, `review-phase-N.md`) and the fix
  round passes that file — never paste a review into a dispatch. A ⚠️ item you confirmed rides along
  as `--findings "<it>"`; a finding you ruled out of the loop (a plan-mandated ruling) goes in
  `--context` with the `Ruling:`.
- **What the templates are:** [`prompts/implementer.md`](prompts/implementer.md),
  [`prompts/task-reviewer.md`](prompts/task-reviewer.md) and
  [`prompts/re-review.md`](prompts/re-review.md) — `dispatch.mjs` fills them. Report file:
  `<WS>/task-N-report.md`. The implementer's `[COMMIT_INSTRUCTION]` comes from the config: an app
  marked `commit: auto` commits its own task; one marked **`commit: manual` stages and stops**.
- **The reviewer gets §Contract** as well as the constraints block, and checks the diff against it
  rather than against the implementer's description.
- **The implementer runs its own tests and the type-check, not the app's suite.** The prompt says
  so; do not add "run the full suite" to a dispatch — the verifier runs everything the commit can
  reach as soon as it lands.
- **After each task's commit** (its review too, when there is one):
  `node <builder>/scripts/verify/verify.mjs request <worktree> HEAD --tier commit` — `<worktree>` is
  this checkout's root (`git rev-parse --show-toplevel`). It prints a request id and returns at
  once; the next task does not wait. Under the fleet, `dispatch.mjs next` files it and reads the
  verdict below (EXECUTION.md §5).
- **Before every implementer dispatch**, read `node <builder>/scripts/verify/verify.mjs verdict
  <branch>` — `<branch>` is the checked-out branch. It prints the latest *finished* verdict and the
  sha it ran at; exit 75 (none finished yet) or 5 (none at all) → nothing to act on yet. A
  regression is new only when its test id is not already ledgered for its `introduced by` commit:
  dispatch a fix against the task that commit belongs to, reviewed like any other finding, and
  ledger `Regression <test id> (introduced by <sha7>): fix dispatched against Task N`. One already
  ledgered is in hand — never dispatch it twice; a later verdict that no longer lists it means the
  fix held.
- **Under `review=app` or `end`, there is no task review:** a DONE report goes straight to
  EXECUTION.md §5, the ledger line saying so.
- **Batch small same-shape tasks** per EXECUTION.md — 🔴 **only ever within one app**: render each
  task's dispatch, then send the first one's with `--context` naming the others' brief files.
- **The brief already carries the config's §Environment landmines** and the ledger's `## env notes`
  (`dispatch.mjs` writes them in) — never repeat them in `--context` (EXECUTION.md §1). A fresh
  implementer has never met them, and the commonest class — a service that does not reload, a tool
  that must run from a particular directory, a cache that must be rebuilt first — makes a test pass or
  fail against a lie: when one bites mid-build, add it to `## env notes` with its remedy **as a step**.
- 🔴 **Under `--agent-walk`, after each task (and its review, when there is one):** if `$BUILDER_FLEET_DIR/requests/<feature>.pause`
  exists — the fleet sets `BUILDER_FLEET_DIR` to the main checkout's fleet dir, since this run's cwd
  is its worktree; unset → `.builder/fleet/requests/<feature>.pause` — tick the ledger, write `blocked: "revising — next: /builder:revise --path <folder>"` to the
  manifest and commit it, in one call:
  `node <builder>/scripts/advance.mjs <folder> --set 'blocked="revising — next: /builder:revise --path <folder>"' --ledger "<where it stopped>" --head --commit "chore({key}): {feature} — parked: revising"`,
  and stop. The ledger keeps every finished task. Under the fleet, `dispatch.mjs next` makes this
  check and prints `paused — <the request's first line>` in place of the next render.

## Phase close — the controller's own work

A phase closes when every task the `## Phases` table assigns to it carries a `Task N: complete` ledger
line. **The table's `Tasks` cell is the membership source; a block's `Phase:` line is its per-block
echo** — when they disagree, the table decides and the mismatch is said out loud. Then:

1. **The phase tier — the build's one wait.**
   `node <builder>/scripts/verify/verify.mjs request <worktree> HEAD --tier phase --since <BASE>`
   (`<BASE>` = the BASE recorded before the phase's first task — on the target branch itself there
   is no branch point to measure from) prints a request id; `node <builder>/scripts/verify/verify.mjs wait <id>` (Bash timeout 600000) until it exits
   with a verdict — exit 75 means still running: call it again. It runs every test the phase's
   commits can reach, reusing what already passed at this commit. 🔴 *Fresh* is
   [`verification-before-completion`](../verification-before-completion/SKILL.md)'s iron law, and
   the verdict is how it is kept: it names the sha it ran at. A result remembered from an earlier
   message is not one. Never run a suite by hand beside it. ⛔ **No cross-app walk here** — the
   merge tier and the walk cover that.
2. 🔴 **A phase whose verdict is red does not close.** Each regression becomes a fix dispatch against
   the task that introduced it, reviewed like any other finding — never a controller fix — then the
   phase tier again. A consumer app's phase never starts on a red producer. 🔴 **An env-broken
   verdict (exit 3) does not close either** — the verifier never ran the tests, so there is nothing to
   close on. Fix the environment its `⚠` lines name the way the config's `verify:` block expects it
   (its `setup`, the database `db.url` names, a check's `cwd`; under the fleet, read it first:
   `node <builder>/scripts/docs.mjs config-key verify`) — never a suite run by hand instead —
   then request the phase tier again. Env-broken a second time → stop: under `--agent-walk` park
   (`kind: stuck`, §Stops) with the verifier's reason as the `blocked:` line; otherwise say that
   reason and end the turn.
2b. **Under `review=app`, one review of the phase's whole diff:**
   `node <builder>/scripts/dispatch.mjs task-review <folder> --phase N` — the review package from
   the BASE recorded before the phase's first task to HEAD (`<WS>/review-phase-N.diff`), with
   [`prompts/task-reviewer.md`](prompts/task-reviewer.md), every brief and report of the phase, the
   constraints block and §Contract. Its findings (`<WS>/review-phase-N.md`) run EXECUTION.md §4's
   fix loop, each against the task it names; the phase closes when the loop does.
3. 🔴 **If this was the PRODUCER's phase, freeze the contract.** Write `contract: frozen <YYYY-MM-DD>`
   to the manifest and commit it with the phase's ledger line — one call:
   `node <builder>/scripts/advance.mjs <folder> --set "contract=frozen <YYYY-MM-DD>" --ledger "Phase N (<app>): closed — …" --head --commit "chore({key}): {feature} — contract frozen at phase N"`
   (the subject `chore(<ticket-or-feature>): <feature> — contract frozen at phase N`). **This is a
   manifest write moment** and the one exception to "the manifest is not written at a phase close".
   Every consumer task after it is briefed against a frozen contract — `dispatch.mjs` reads the
   manifest and says so in every brief.
4. **If the phase landed `SC#` rows,** tick each row's Status in §Schema & API changes with its real
   migration id. That is **the one docs-only commit the build allows**:
   `node <builder>/scripts/advance.mjs <folder> --add <folder>/SPEC.md --commit "docs({key}): {feature} — SC# landed"`.
5. **One ledger line** — `node <builder>/scripts/advance.mjs <folder> --ledger "<line>"` (no commit):
   `Phase N (<app>): closed — verify phase GREEN <request id> · <sha>`.
6. **Otherwise the manifest is not written here** — per-phase state is the ledger plus `git log`.
7. **Start the next phase in the same turn.** The go-ahead covered the whole plan.

### 🔴 A phase in a `commit: manual` app closes differently

Where the config marks an app `commit: manual` — typically because it produces a released artifact
nobody can hot-fix — an implementer writes its code and its tests **and stops before the commit**:

- the task's final step is `git add` plus the proposed commit message, **not `git commit`**;
- the controller presents the staged diff and the proposed message, and takes one approval per task
  or one for the phase — the human's choice, offered explicitly;
- the phase tier still runs on its uncommitted work (`verify.mjs request … --tier phase --tree`),
  and a red or env-broken verdict still blocks the close;
- **anything else the config reserves to the human for that app** — launching it, packaging it,
  releasing it — is offered as their next action, never done here.

Declining to commit is not a problem: the ledger and the working tree carry the state, and the walk
can still happen from a dirty tree with that said plainly.

## Stops

EXECUTION.md's five stop classes, plus this pipeline's bookkeeping:

1–3. **One call** ticks the ledger (tasks complete, the open fix round if any, one line on where the
   phase stands, anything for `## env notes`), writes the manifest — `state: building`,
   `next: /builder:resume --path <folder>`, `head`, `branch` — and commits it alone:
   `node <builder>/scripts/advance.mjs <folder> --set state=building --set "next=/builder:resume --path <folder>" --head --ledger "<line>"… --commit "chore({key}): {feature} — stopped mid-phase N"`
   (the subject `chore(<ticket-or-feature>): <feature> — stopped mid-phase N`). **Nothing else is
   committed by the controller mid-build.**
4. Hand off ending `say go to continue here, or run /clear first, then /builder:resume --path <folder>`
   — all state is on disk, so continuing in this session loses nothing but room.

**Under `--agent-walk`, nothing runs in the background** — implementers and reviewers run in the
foreground; tests are the verifier's, which runs on its own and is read with `verify.mjs verdict` /
`wait`.

**Under `--agent-walk`, nobody is there to ask — and almost nothing needs asking** (AGENT-MODE
§Agent mode in the build lane: agent mode builds to done). Of the five stop classes:

- **an irreversible or destructive operation, a security-sensitive action, a side effect outside the
  repo** — none is ever needed to build a feature to merged-locally. Take the path that avoids it (a
  new migration instead of an edited one, a local stub instead of a live service, no push, no
  deploy), record `Ruling: <the path taken> — avoided <the operation> under --agent-walk`, and keep
  going. Not a park.
- **a commit in a `commit: manual` app** (from the start of its phase) and **a plan so broken that
  every path forward is a guess at what the product should be** — these park: write
  `blocked: "<the stop class, and what it stopped on, in plain words> — next: <step>"` (REFERENCE §How a park reads; under the fleet, read
  `docs.mjs section skills/resume/REFERENCE.md "The park record"` and `"How a park reads"` before writing PARKED.md) to the manifest, and `<folder>/PARKED.md` (REFERENCE §The park
  record; `kind: human-step` for a `commit: manual` app, `decision` for a broken plan), in the same
  ledger line and manifest commit as steps 1–3 — that call with `--set 'blocked="…"' --add <folder>/PARKED.md`
  and the subject `chore(<ticket-or-feature>): <feature> — parked: <stop class>` — and
  **end the run**. A plan that is merely wrong in places is not this: rule, fix the task, go on.
- **Under `unruled: park`**, a choice the spec doesn't settle parks the same way (`kind: decision`),
  naming the choice — no ruling taken.

Never ask.

## When the last phase signs

**Under the fleet (`BUILDER_FLEET_DIR` is set):** first
`node <builder>/scripts/docs.mjs section skills/build/SKILL.md "When the last phase signs"` if this
section is not in context; then `docs.mjs section skills/resume/REFERENCE.md "Walk readiness"` at
step 3 when it runs, and `docs.mjs section skills/build/EXECUTION.md "Finish"` at step 6. EXECUTION's
"Common rationalizations" is the same call, read when a step looks skippable.

1. **The last phase's tier is the end's.** The phase tier of the last phase (§Phase close) is
   green on the last commit; nothing else runs here. After step 2's fix wave commits, request the
   phase tier again and wait — "green before the walk" still means green on the last commit.
2. **The final whole-branch review** — EXECUTION.md §The final whole-branch review:
   `node <builder>/scripts/dispatch.mjs final-review <folder>` renders
   [`prompts/final-reviewer.md`](prompts/final-reviewer.md) — on the most capable model, pointed at
   the ledger's deferred-minor and parked lines **and at §Contract**, its report written to
   `<WS>/final-review.md`. ONE fix dispatch (`dispatch.mjs implementer <folder> --final`, which takes
   that file), one scoped re-review (`dispatch.mjs re-review <folder> --final --round 1
   --findings-file <WS>/final-review.md`), then adjudicate. No second fix wave.
3. 🔴 **Walk readiness** — [REFERENCE](../resume/REFERENCE.md) §Walk readiness: pending
   migrations applied to the **dev** database (asked for, not assumed), stale processes restarted,
   the running app smoked on every surface this feature changed. A defect it finds is a fix dispatch
   like a regression, then it runs again. **Still `pending` → stop here**: no walk script, no
   `state: built`; write `state: building`, `ready: pending "<what>"`,
   `next: <what the human must do>, then /builder:resume --path <folder>` —
   `node <builder>/scripts/advance.mjs <folder> --set state=building --set 'ready=pending "<what>"' --set "next=<…>" --head --commit "chore({key}): {feature} — built, walk readiness pending"` —
   and hand off saying exactly that. Under `--auto` this is a stop too — the walk is its terminal state, and this precedes it.
   **Under `--no-dev-env`** (the fleet's build lane): don't run readiness at all, and
   nothing more runs here: the fleet requests the merge tier when the walk starts, and verify reads
   it. Then write the walk script (step 4, so the walk lane finds it), write `state: building`,
   `ready: pending "dev env (fleet walk lane)"`, `next: /builder:resume --path <folder>` and commit —
   `node <builder>/scripts/advance.mjs <folder> --set state=building --set 'ready=pending "dev env (fleet walk lane)"' --set "next=/builder:resume --path <folder>" --head --commit walk-lane`
   (the preset `walk-lane` = `chore(<ticket-or-feature>): <feature> — phases closed, awaiting the walk lane`) —
   then §The hand-off file, and end the run. **Under `--agent-walk`**, readiness never asks: resume's AGENT-MODE.md says what each question
   becomes. With `agent_walk.start` set, the fleet has already started the walk env for this worktree —
   never start or restart it here (REFERENCE §Walk readiness).
4. **The walk script** — `node <builder>/scripts/walk-script.mjs <folder>` writes `<WS>/walk.md`
   from SPEC §Testing; **you fill only each app's marked `<!-- orchestrator: … -->` block** — how to
   reach it (a URL, the command prefix, scratch files), the surfaces that cannot work locally, a
   readiness step that could not run here — and reword an item a person couldn't do as written, or
   fix a `[risk]` tag the script got wrong. A re-run keeps your blocks and rewrites the rest
   identically. **Print it in the hand-off.** 🔴 **It is per
   app**: a multi-app feature is walked in more than one place, and a script naming one of them gets
   half a sign-off. Per app: where to go, what to do, what to look for **newest-first**, and the local
   facts the human needs — taken from the config's §Environment landmines, plus which surfaces cannot
   work locally. The walk is the human's; no agent signs it.
   **Under `--agent-walk`**, append the cross-app walk after the per-app sections, so the agent walk
   runs it in the same live session and verify need not drive the app again (verify item 10):
   `## Cross-app (verify E2E)`, then SPEC §Testing's walk script as numbered steps `E1…En` — each
   one line of what to do and one of what to see, in the script's order. `walk-script.mjs` writes it
   when the manifest says `agent-walk: on` (`--cross-app` forces it). Without `--agent-walk`,
   `walk.md` stays per-app only.
   **Tag `[risk]`** on every item touching a §Contract row, an auth or permission path, a
   load/save/delete path, a notification payload or a deep-link target (verify's re-walk table) — the
   agent walk under `walk=risk` walks only those.
5. **Manifest:** `state: built`, `ready: yes <date> <sha>`, `next: 🔒 your walk → /builder:signoff --path <folder>`, `head`,
   `branch`. Commit: `chore(<ticket-or-feature>): <feature> — built, awaiting the walk` — one call:
   `node <builder>/scripts/advance.mjs <folder> --set state=built --set "ready=yes <YYYY-MM-DD> <sha>" --set "next=🔒 your walk → /builder:signoff --path <folder>" --head --commit built`.
   **Under `--agent-walk`:** `--set "next=/builder:agent-walk --path <folder>"` and keep going into it — the
   walk script is still written (the agent walks it), and no human is asked to.
5b. **The hand-off file** — `node <builder>/scripts/handoff.mjs write <folder> [--note "<a line only
   this lane knows>"]`, the build's last act after its manifest commit, at both ends: built, or
   phases closed for the walk lane. It writes `<WS>/handoff.md` — state, sha, the verifier's verdicts,
   the contract, walk.md's counts, open items, this config's readiness facts — so the walk lane's resume reads one
   file instead of re-deriving it. Re-running it rewrites nothing that hasn't changed.
6. **"Rulings I made"** goes in the hand-off — every ledger line containing `Ruling:`, in order, each
   with what it costs if wrong. It is the only place those decisions reach the human.
7. ⛔ **Do not delete the workspace** — the walk, verify and the sign-off still read it.
   `/builder:ship` removes it.

## Build here

The human chose this session over the ceremony. The plan is the same `PLAN.md`; what changes is who
works it and what is skipped. Read `.claude/builder.md` (§Verification, §Global constraints, §House
rules, §Environment landmines, §Companion skills) and `PLAN.md`, then:

1. **Work the tasks in order, yourself, in this session.** For each `### Task N`: read its block and
   the SPEC section it implements, then the recipe skill its `Recipe:` line names; write the test
   first where behaviour changes ([`test-driven-development`](../test-driven-development/SKILL.md)),
   see it fail, implement, see it pass. On the branch checked out here — never a new branch or
   worktree.
2. **Commit per task** the house way (§Global constraints' commit rule): name every file you stage.
   🔴 **In an app the config marks `commit: manual`, stage and carry on** — those commits are the
   human's; list them at the end.
3. **Tests by the verifier** — after each task's commit, `node <builder>/scripts/verify/verify.mjs
   request <worktree> HEAD --tier commit` (`<worktree>` = `git rev-parse --show-toplevel`), and read
   `verify.mjs verdict <branch>` before the next task (exit 75 or 5 → nothing yet); at each phase
   close, `--tier phase --since <the phase's BASE>` (`<sha>^` of the phase's first ledger line) and
   `wait`. A red verdict is fixed here, in place, before the next task or
   phase; an env-broken one at a phase close is not a pass either (§Phase close step 2).
4. **Keep a one-line ledger** in the workspace (`<builder>/scripts/workspace <feature>` →
   `ledger.md`): `Task N: done <sha>`. After a `/clear`, `/builder:resume` routes back here and you
   pick up at the first task without a line.
5. **Skipped:** reviewer and implementer agents, the final whole-branch review (the one floor
   *here* gives up — choosing it was choosing that), the
   contract-freeze ceremony (still freeze it in the manifest when the producer's phase closes),
   walk readiness, the walk, sign-off and verify.
6. **When the last task is in:** write `state: built`, `walk: none`, `ready: none` and commit
   `chore(<feature>): built here — not walked` — `node <builder>/scripts/advance.mjs <folder> --set state=built --set walk=none --set ready=none --head --commit "chore({feature}): built here — not walked"`. Then:

~~~
📍 <feature>: built here, not walked — test it yourself. When you want the full finish:
   /builder:resume --path <folder> (walk → sign-off → verify → ship)
~~~

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
Full spec: <folder>/SPEC.md
Pick up where you left off any time: /builder:resume --path <folder>
  (if this session ends, or to spec several features before building any of them)

📍 <feature>: building — phase N/M (<app>), stopped (/clear first for a fresh context) — how do you want it built?
   1. Agent — sent to agents who finish the build, walk, sign off and verify it, and merge it on their own; you get the review of what landed
   2. Step by step — carry on with the build here (next: phase N/M), pausing for you at each decision and for your walk
   Reply 1 or 2 — "go" is 1.
```

```
Full spec: <folder>/SPEC.md
Pick up where you left off any time: /builder:resume --path <folder>
  (if this session ends, or to spec several features before building any of them)

📍 <feature>: built (<M> phases across <apps>, <T> tasks) — what next?
   1. Agent — sent to agents who walk it in the running app, sign it off as the agent (not human-tested), verify it and merge it; you get the review of what landed
   2. Step by step — you walk it yourself in the running app, then sign it off here
   Reply 1 or 2 — "go" is 1.
```

No `/builder:*` command on an option line, and "go" is option 1 — Agent (REFERENCE §Continuing on
"go"). Without a config `agent_walk:` block only Step by step is left, so the single-line footer is
printed: `next: /builder:resume --path <folder> · or say go` mid-build, `next: 🔒 your walk →
/builder:signoff --path <folder>` once built.

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — on a
numbered footer, option 1 (Agent, where it is offered) — never ask the human to paste it. REFERENCE
§Continuing on "go" has the exceptions.
