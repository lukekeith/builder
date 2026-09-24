---
name: build
description: The app-changing step of the /builder:* pipeline — executes the feature's committed PLAN.md through superpowers' subagent-driven-development with MakeReady briefs: a fresh implementer per task reading the task block with its code, the SPEC section it implements, the recipe skill and the MakeReady constraints block; a task review after each; ONE APP PER PHASE with that app's fast gates at every phase close; the contract frozen on the manifest when the server phase closes; iPhone commits left to the human. Works on the current branch, never creates a worktree, never opens a PR. Resumes from the SDD ledger after any /clear. Use when the user asks to build, implement or continue building a specced feature.
---

# `/builder:build` — PLAN.md, executed by subagents

Invocation: **`/builder:build --path <folder> [--ticket <monday id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

**This skill is a wrapper.** `superpowers:subagent-driven-development` owns the loop — setup, dispatch,
the task review, the fix loop and its breaker, the final review, the `Rulings I made` list. Follow that
skill exactly and **never edit it**; everything below is the MakeReady binding that sits on top. Read it
first, then REFERENCE: §Quality gates (the per-app fast sets) · §House rules · §Contract and the
contract freeze · §PLAN.md (the task block shape) · §SPEC.md (the sections a brief copies) ·
§MANIFEST.md (what a stop writes) · §Environment landmines · §Branch and ticket · §Agent model tiering.

Input: `<folder>/PLAN.md` — the plan, and the only thing executed — with `<folder>/SPEC.md` read for the
sections a task implements and `<folder>/MANIFEST.md` for state, plus the ledger. Output: code — **one
commit per task, written by its implementer** — one ledger line per phase, and the manifest written
**only** at a stop, at the go-ahead when it is taken here, **at the server phase close (the contract
freeze)**, and when the last phase signs.

**The commit key** is `--ticket` when it was given — and a given `--ticket` is also written to the
manifest's `ticket:` line; absent, it is the manifest's `ticket:`, and absent that, the feature name.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node .claude/scripts/list-feature-specs.mjs --json` and offer only the folders
whose state is `planned` or `building`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` — the folder shipped and was condensed, or it is a pre-builder layout | this step does not run on it. Say so in one line, hand back to `/builder:resume --path <folder>`, stop |
| `state: planned` **and** `go-ahead:` carries a name + date | run |
| `state: planned` **and** `go-ahead: none` | present `PLAN.md`'s `## Phases` table — phase · app · tasks · goal · gates, with the totals and which phase freezes the contract — and take the go-ahead here through plan mode's `ExitPlanMode`. Yes → write `go-ahead: <name YYYY-MM-DD>`, commit `chore(<ticket-or-feature>): <feature> — go-ahead`, run. No → hand back. ⛔ Never hand back to the plan step for this. **Under `--auto`** the table is presented and the run proceeds, recorded as `go-ahead: auto (recommended) YYYY-MM-DD` |
| `state: building` | resume (see §Setup) — the ledger is ground truth, not the conversation |
| §Findings & risks has a `blocked:` row | name the row and the clearer the audit wrote on it, hand back, stop. A row marked `build-time risk` is **not** a blocker — it rides into its task's brief |
| `state: built` · `signed-off` · `verified` · `shipped` | already built. Say so naming the state, hand back, stop |
| `state: spec` · `aligned` · `audited` | not planned yet. One line naming the state and the step that owns it, hand back, stop |

Handing back is that one line plus its own footer, carrying the manifest's own `state`:

```
📍 <feature>: <manifest state> — not built: <reason> — next: <the command the row names>
```

## Setup — SDD §Setup, with the worktree step skipped

1. **Workspace:** `.claude/scripts/build-spec-workspace.sh <feature>` prints and ensures it, `<feature>`
   being the folder's basename. Every brief, report, review diff, the ledger and `walk.md` live there;
   it is git-ignored and never committed. SDD's own `scripts/sdd-workspace` is **not** used — it names
   the workspace after the plan file's BASENAME, and every feature's plan is `PLAN.md`, so every feature
   would share one directory. The default outfiles of `task-brief` and `review-package` derive from that
   same basename — which is why every call below passes an explicit outfile.
2. 🔴 **A shell variable does not survive between Bash calls** — the working directory persists, shell
   state does not. Never resolve a path in one call and use the variable in the next: it expands to
   nothing and the brief lands at `/task-1-brief.md`. **Re-resolve inline in every command** —
   `"$(.claude/scripts/build-spec-workspace.sh <feature>)/task-3-brief.md"` — or paste the resolved
   absolute path into the command. Below, **`<WS>/` is shorthand for that command substitution written
   out in the same command**, never for a variable.
3. 🔴 **Skip SDD's worktree and branch setup entirely.** This family never creates a branch or a
   worktree. Build on the branch that is already checked out. If it differs from the manifest's
   `branch:`, print **one** warning line and continue; never check anything out. 🔴 **But on `main`,
   dispatch nothing and commit nothing** — skipping the worktree step dropped SDD's guard against
   implementing on the base branch: stop and say the human cuts the branch.
4. **SDD's two scripts** live in the superpowers skill's own directory, whose version moves — resolve
   that path inline too, in each call:
   `$(ls -d ~/.claude/plugins/cache/*/superpowers/*/skills/subagent-driven-development |
   sort -V | tail -1)/scripts/task-brief`. **`sort -V`**, because plain `ls` order puts `10.0.0` before
   `6.3.0`, and an old cached version carries no `scripts/` directory at all. **If that `ls` prints
   nothing, stop before dispatching anything** and say the one line that fixes it: superpowers is not
   installed on this machine — `claude plugin install superpowers@claude-plugins-official
   --scope project`. Record the resolved version in the ledger's first lines (tested: 6.3.0,
   CONSTRAINTS.md). Below, `task-brief` and `review-package` are shorthand for that resolution plus the
   script name.
5. **Ledger** `<WS>/progress.md`, whose first line is its identity:
   `# SDD ledger — plan: <folder>/PLAN.md`. Create it with that line if absent. If an existing ledger's
   first line names a different plan, it is another feature's — leave it and start a fresh one. Keep an
   `## env notes` section in it: an environment fact that cost time here saves it next session
   (REFERENCE §Environment landmines).
6. **Resume point:** the first `### Task N` in `<folder>/PLAN.md` with no `Task N: complete` line in the
   ledger. The ledger plus `git log` are ground truth after a `/clear`; never re-derive progress from
   memory, and never re-dispatch a task the ledger calls complete. A task whose last ledger line is a
   fix round is mid-loop — resume the loop at the next round.
7. **Before Task 1 only,** run SDD's pre-flight conflict scan over `PLAN.md`'s task blocks and **write
   its table to the ledger**: one row for every pair of tasks sharing a file or an interface, one row
   per task for whether its own **Files**, **Interfaces** and steps agree — **and one row per task for
   whether its `Files` stay inside its `App:`**, because a task that reaches into another app breaks the
   phase's gates. Rule on every finding with the SPEC as the binding authority, record each as
   `Ruling: …`, then dispatch Task 1. On a resume the table is already in the ledger — do not re-run it.

## The task loop — SDD §The Task Loop, bound to MakeReady

### Composing the brief (SDD step 1)

1. `task-brief <folder>/PLAN.md N "<WS>/task-N-brief.md"` — SDD's script, with the **explicit outfile**.
2. **Nothing is trimmed.** REFERENCE §PLAN.md keeps nothing between the task blocks and nothing after
   the last one, so what it wrote is exactly one task.
3. **Append four blocks**, in this order:
   - **The SPEC section(s) this task implements**, copied: the ones the block's **Files**, its `App:`
     and `Phase:` lines and its **Interfaces** point at — a schema task → §Schema & API changes + the
     Data plan; a route → §Server; a store, page or component → §Client or §iPhone; a twin → §Capture;
     the tests → §Testing — plus every §Decisions row binding the task and any §Findings row marked
     `build-time risk` that names it.
   - 🔴 **§Contract, always, on every task in every app.** The producer implements exactly it; each
     consumer codes against exactly it. An implementer who never saw the contract is how the two
     consumers diverge. **Say in the brief whether it is frozen** — once the server phase has closed,
     the brief states that the shape is fixed and that a mismatch is reported, never worked around.
   - **What the block's `Recipe:` line names, read first:** a companion skill as the path
     `.claude/skills/<skill>/SKILL.md`, or a REFERENCE section as
     `plugins/builder/skills/resume/REFERENCE.md` §<name>. The path, not the text — the implementer
     reads it. **In prototype mode**, a component task also takes its UI 2.0 contract path
     (`docs/ui2/design-system/components/C-###-<name>.md`) and its frozen snapshot: that contract is
     the component's spec, and an undesigned state is not invented by the implementer.
   - **`plugins/builder/skills/build/CONSTRAINTS.md` verbatim**, with `<TICKET>` replaced by the
     manifest's `ticket:` — or by the feature name when that is `none`. Paste it **even though
     `PLAN.md`'s header carries the same Global Constraints**: the implementer sees only its own block
     plus this brief. A later session must not "de-duplicate" it away.

### Dispatch, review, fix (SDD steps 1–5)

- **BASE** is recorded before the dispatch, per SDD §The Task Loop step 1.
- **Report file:** `<WS>/task-N-report.md`, named in the dispatch prompt.
- **Review package:** `review-package <folder>/PLAN.md BASE HEAD "<WS>/review-<base7>..<head7>.diff"` —
  SDD's script, explicit outfile again. A scoped re-review uses `FIX_BASE HEAD` and gets its own file.
- **The reviewer's global-constraints block is `CONSTRAINTS.md`** — the same text the implementer read,
  so spec compliance and house rules are judged against one document. **The reviewer also gets
  §Contract**, and checks the diff against it rather than against the implementer's description.
- **Name the model on every dispatch** (SDD §Model Selection · REFERENCE §Agent model tiering):
  `sonnet` for a 1–2-file task whose block carries the complete code (a schema row, a presentational
  component, a fixture + adapter); `opus` for judgment or multi-file integration (a service with an org
  permission path, an `AppState` entity plus its Actions, a store + page port, anything touching
  auth or money). Unsure → `opus`.
  ⛔ **Never omit it** — an omitted model inherits this session's, the most expensive one running.
- **Batch small same-shape tasks** into one dispatch per SDD (three fixtures, one field added to four
  adapters) — 🔴 **only ever within one app**.
- The fix loop, the five-round cap, the breaker and its adjudications are SDD's, unchanged. Every
  decision taken on the human's behalf is a ledger line:
  `Ruling: <what was decided> — <why> — <cost if wrong>`.
- 🔴 **Never fix a finding in the controller.** Resume the implementer (rounds 1–3) or dispatch a fresh
  one a tier up (rounds 4–5). A controller fix pollutes this context and skips review entirely.
- **When reality contradicts the spec,** the fix is code plus at most one line of docs — a ruling →
  SPEC §Decisions; knowledge a later phase needs → SPEC §Findings; a plain bug → nothing. Only a
  **contract change** that un-built tasks depend on edits a SPEC section, and once the contract is
  frozen that is `/builder:revise`'s call, not a mid-task decision. Never re-audit.

### MakeReady specifics that bite

Carry the one that applies into the dispatch's context block — a fresh implementer has never met them,
and the full list is REFERENCE §Environment landmines.

- 🔴 **`docker restart makeready-server` after ANY `server/src` edit** — `tsx watch` misses bind-mount
  events, so an un-restarted container serves the old code and the task's test passes or fails against
  a lie. Put the restart **in the step**, not in the prose.
- **curl against the server needs a non-bot User-Agent** (the bot-guard middleware).
- **`swiftlint` runs from `iphone/`**, never the repo root — its included paths are relative.
- **A web capture needs the host artisan on `:8002` with `CAPTURE_BASE_URL`**, and the client bundle
  rebuilt first; `:8001` silently produces blank screenshots.
- **Restart the capture server after editing an adapter.**
- **iPhone snapshots lie in known ways** — `.ultraThinMaterial` invisible, `AsyncImage` falling back to
  initials, `CachedAsyncImage` spinning. Consult the `compare-*` auto-memories before "fixing" a twin.
- **Local SMS verification codes come from the api container logs**, never a database reset.

## Phase close — the controller's own work

A phase closes when every task the `## Phases` table assigns to it — each block's `Phase:` line —
carries a `Task N: complete` ledger line. **The table's `Tasks` cell is the membership source; a block's
`Phase:` line is its per-block echo** — when they disagree, the table decides and the mismatch is said
out loud. Then:

1. **That app's fast set, fresh** — REFERENCE §Quality gates lists one block per app; run **the block
   for this phase's app**, from there, never from memory. Report the `client: npm run guard` **delta**,
   and record the two known-red gates as BLOCKED with evidence rather than failing on them.
   ⛔ **No cross-app E2E walk, no full `/compare` sweep here** — the deep set runs once, in
   `/builder:verify`.
2. 🔴 **A phase whose gates are red does not close.** Each failure becomes a fix dispatch against the
   task that caused it, reviewed like any other finding — never a controller fix — and then the gate
   re-runs.
3. 🔴 **If this was the SERVER phase, freeze the contract.** Write `contract: frozen <YYYY-MM-DD>` to
   the manifest and commit it with the phase's ledger line:
   `chore(<ticket-or-feature>): <feature> — contract frozen at phase N`. **This is a manifest write
   moment** (REFERENCE §MANIFEST.md) and the one exception to "the manifest is not written at a phase
   close". Every consumer task after it is briefed against a frozen contract.
4. **If the phase landed `SC#` rows,** tick each row's Status in SPEC §Schema & API changes with its
   real migration name. That is **the one docs-only commit the build allows**:
   `docs(<ticket-or-feature>): <feature> — SC# landed`.
5. **One ledger line:** `Phase N (<app>): closed — gates <one line> · <sha>`.
6. **Otherwise the manifest is not written here** — per-phase state is the ledger line plus `git log`.
7. **Start the next phase in the same turn.** The go-ahead covered the whole plan; no phase re-asks.

### 🔴 The iPhone phase commits differently

An implementer on an `App: iphone` task writes its code and its tests, **and stops before the commit**:
committing iPhone code is an explicit user call, at every size and under every flag, because an iPhone
build that reaches TestFlight cannot be hot-fixed. So for an iPhone phase:

- the task's final step is `git add` plus the proposed commit message, **not `git commit`**;
- the controller presents the staged diff and the proposed message, and takes one approval per task or
  one for the phase — the human's choice, offered explicitly;
- `npm run ios:build-check` and `swiftlint` still run as the phase's gates, and a red gate still blocks
  the close;
- **launching the simulator (`/rebuild-iphone`) and archiving are never done by this step** — they are
  offered as the human's next action.

Declining to commit is not a problem: the ledger and the working tree carry the state, and the walk can
still happen from a dirty tree with that said plainly.

## Stops

A run stops mid-phase for context running out, the session ending, or one of SDD's stop classes (an
irreversible or destructive operation, a security-sensitive action, an outward-facing side effect such
as a push or a merge, or a plan so broken that every path forward is a guess). Then:

1. Tick the ledger: tasks complete, the open fix round if there is one, one line on where the phase
   stands, and anything for `## env notes`.
2. Write the manifest — `state: building`, `next: /builder:resume --path <folder>`, `head`, `branch`.
3. Commit it alone: `chore(<ticket-or-feature>): <feature> — stopped mid-phase N`. **Nothing else is
   committed by the controller mid-build**; task code is committed by the implementer that wrote it
   (or staged, on iPhone).
4. Hand off with the footer below, ending `run /clear, then /builder:resume --path <folder>`.

## When the last phase signs

1. **Fast gates** for every app the build touched, as at any phase close.
2. **SDD's final whole-branch review** (SDD §Final Review) on the most capable model, over
   `review-package <folder>/PLAN.md <merge-base> HEAD "<WS>/review-final.diff"`, pointed at the ledger's
   deferred-minor and parked lines **and at §Contract**. Its findings get **ONE fix dispatch and one
   scoped re-review**; residual findings are adjudicated and ledgered. There is no second fix wave.
3. **The walk script** — write it to `<WS>/walk.md` **and print it in the hand-off**. 🔴 **It is
   per app**: a four-app feature is walked in two or three places, and a script that names only one of
   them gets half a sign-off. Per app: the URL or the simulator screen, what to tap, what to look for
   **newest-first**, and the local facts the human needs — which port (client docker `:8001`, host
   artisan `:8002`, server `:3010`, capture `:5950`), that SMS verification codes come from the api
   container logs and never from a database reset, which seeded org or fixture to use, any state to set
   up first, and **which surfaces cannot work locally**. The walk is the human's — no agent signs it.
4. **Manifest:** `state: built`, `next: 🔒 your walk → /builder:signoff --path <folder>`, `head`,
   `branch`. Commit: `chore(<ticket-or-feature>): <feature> — built, awaiting the walk`.
5. **"Rulings I made"** (SDD §Finish) goes in the hand-off — every ledger line containing `Ruling:`, in
   the order made, each with what it costs if wrong. It is the only place those decisions reach the
   human.
6. ⛔ **Do not delete the workspace.** SDD deletes it at its own finish; here the walk,
   `/builder:verify` and sign-off still read the ledger, the reports and `walk.md`. For the same reason
   SDD's closing `finishing-a-development-branch` is never invoked here — the PR lock owns what happens
   next.

## 🔒 This skill never opens a PR

Not per phase, not at the end. The PR comes after the human's walk + sign-off + verify
(`builder:resume` §The PR lock). Don't call the branch "verified" or "ready to merge" while only agents
have exercised it. It also never writes to monday.com, never runs `/deploy`, and never edits a UI 2.0
contract, registry row or note.

## Exit handoff

What landed (phases · apps · tasks · commits), the rulings list, whether the contract froze, any staged
iPhone commits awaiting approval, blockers, the next command, and one footer:

```
📍 <feature>: building — phase N/M (<app>), stopped — next: /clear, then /builder:resume --path <folder>
```

```
📍 <feature>: built (<M> phases across <apps>, <T> tasks) — next: 🔒 your walk → /builder:signoff --path <folder>
```
