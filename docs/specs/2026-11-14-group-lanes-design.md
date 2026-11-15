# Group lanes: features that share code build in one lane, are tested once, and land together — design

**Status:** decisions taken by the owner as recommended (2026-11-14) — building · **Date:** 2026-11-14 · **Branch:** `tasks/group-lanes` · **Release:** 6.3.0 (minor: new optional config keys, a new fleet mode)

## Why

The fleet runs several features at once, each in its own worktree and lane (`--parallel`, default
3). It has no notion of two features *overlapping*:

- Two features that edit the same files build side by side, each against the target. The conflict
  surfaces late, at the batched walk (where 6.2.3 now syncs it) or at landing, where an agent
  resolves it and the feature goes back to the walk lane for a re-walk. The work was done twice and
  walked twice.
- A program child that declares `Depends on` another waits until that feature **merges** — through
  its walk, verify and ship — before it starts building at all (`fleet.mjs` `after` / `waitsOn`).
- Each feature gets its own merge-tier run and its own walk, even when three of them change one
  screen and could be walked together once.
- Parallel builds share one test database unless the config isolates them by hand
  (`worktree_env` with `{feature}`), and nothing warns when it doesn't.

A motivating run (a consuming project with several features drawn from one source document): three
features touched the same service layer. They built in parallel, conflicted at every landing, and
each was re-walked after an agent resolved the conflict — most of the walk time was spent re-walking
code that had already passed.

The parallelism stays **across features**. Tasks inside one feature still run one at a time, in one
worktree — the same rule superpowers' subagent-driven-development and builder's EXECUTION.md both
keep, for the same reason: implementers sharing a worktree conflict.

## Decisions

### Footprints and groups

- **D1. A footprint is read from PLAN.md once the feature plans.** Each `### Task N` block's
  **Files:** paths (globs allowed) and its **Interfaces:** names in backticks — a name in a fence
  under the task that defines it is *produced*; a name a task only cites is *consumed*. The
  footprint is the union over tasks: `{ paths, produces, consumes }`. Paths under `generated.paths`
  (D14) are left out. A feature that has not planned has no footprint and runs alone until it does.
  → `footprintOf(planText, { generated })`.
- **D2. Two features overlap** when any of: (a) a path or glob of one matches a path or glob of the
  other (`matchesGlob`, both directions; two globs overlap when either matches the other's literal
  prefix); (b) one produces an interface the other consumes; (c) one names the other in PROGRAM.md
  §Children "Depends on". → `overlapOf(a, b)` returns the reasons (paths, interfaces, declared), so
  status and notes can say *why*.
- **D3. A group is a connected set of overlapping features, at most `agent_walk.group_max`
  members (default 3).** `groupsOf` builds the overlap graph (`edgesOf`) and takes its components;
  a component larger than the cap is cut in member order (D5) — the members past the cap wait for
  the group before them to land, as an implied dependency, and say so. A feature with no overlaps
  is a group of one and behaves exactly as today.
- **D4. A declared dependent joins its dependency's group** instead of waiting for it to merge: it
  stacks on the dependency's built branch (D6). The dependency's code still lands first, because
  the group lands as one (D9). `--dry-run` says it: `b joins a's group (declared: Depends on a)`.
- **D5. Member order** is dependencies first (declared, then producer before consumer of an
  interface), then PROGRAM §Children order, then the order the features were named to the fleet.
  A cycle (each consumes the other's interface) is broken by fleet order, with a note. →
  `orderMembers(group, edges)`.

### Building a group

- **D6. A group owns one lane, and its members stack.** Members build in order; each member's
  worktree starts from the previous member's built branch, not the target. Before a member builds,
  the fleet checks that the previous member's branch really is an ancestor of it (`merge-base
  --is-ancestor`); if it isn't — for example, uncommitted changes blocked the merge — the member
  parks and says which branch is missing and why. A group of one is today's lane.
- **D7. When a member before it changes** (a fix round, a walk fix), the members after it are
  re-chained (`chainGroup`): each merges its predecessor's new tip. A conflict there is resolved by
  the existing agent merge-resolution run; one that two runs can't resolve parks the member.

### The barrier and the walk

- **D8. Once every member is built, the group is tested once, on its tip.** The tip is the last
  member's branch, which holds the whole group. It gets:
  - **one held merge-tier run** (the verifier's merge tier on the tip merged onto the target), held
    until the group's walk passes — today's per-feature held run, once per group;
  - **one batched walk of the whole group.** A walk batch takes whole groups, never part of one
    (`takeWalkBatch`); a group bigger than `agent_walk.batch` walks alone.
  - **Walk fixes on any member send the group back to building**, starting at the earliest member
    with fixes; the members after it re-chain (D7), and the barrier runs again.
  - **When chaining brings new code into a member an agent already signed off**, that member goes
    back to `built`, so the group walk signs it off again. **A human's sign-off is never replaced**:
    the landing parks that member as a human step, with the choice of walking it again or handing
    the re-walk to agents (today's `walkAgain` rule).
  - **Without a walk env of the fleet's own** (`agent_walk.start` unset), members walk one by one,
    in group order, after all of them are built.
- **D8a. The walk worktree merges only what a group's later members don't already hold** — once
  chained, that is the tip alone. This is the group half of the walk-loop fix (6.2.3 did the
  feature half): a group whose stack no longer chains is re-chained (D7); a group whose tip
  conflicts with the target is synced on the tip and requeued first in line; a sync no agent
  resolves parks the group.

### Landing

- **D9. A group lands as one batch, through its tip.** No member lands alone. Right before
  releasing the tip's held merge, the fleet re-checks every member's phase (all signed off, none
  paused or parked — `landingGate`). If the tip's merge tier goes red, the fleet tests each prefix
  of the stack — member 1, then 1–2, … (`bisectPlan`, `firstFailing`) — to find the first member
  that breaks it. The members before it land; it and the members after it stay, and it parks as
  `merge tier went red` with the verdict's evidence.

### Overlaps found while running

- **D10. At every run boundary, check lanes for new collisions** (`laneCollisions`): a lane whose
  branch now touches paths in another group's unlanded footprint. The feature joins that group when
  there is room and it hasn't started building, or else waits for the group to land, as an implied
  dependency. Either way it's a note naming the shared paths.
- **D11. Rulings outside the footprint are recorded.** An agent making a ruling that touches a path
  outside its feature's footprint records it with `node <builder>/scripts/fleet-ruling.mjs
  <feature> <path>… -- <ruling>`, which appends to `.builder/fleet/rulings.md`; those paths join the
  feature's footprint at the next boundary (D10).
- **D12. A spec edit landing on the target pauses a feature still planning or building** whose
  folder it changed, with `next: /builder:revise --path <folder>`. A feature past building is left
  alone; its landing re-reads the spec.
- **D13. Engine-split advice.** When two features overlap on few paths (≤
  `agent_walk.split_max_paths`, default 10), the fleet adds a note suggesting a prerequisite
  feature that takes the shared changes (`splitAdvice`). Advice only — it never stops the fleet.

### Isolation

- **D14. A test database per worktree** (`agent_walk.test_db_env`, `scripts/lane-db.mjs`). The
  value names the variable that holds the database URL (for example `DATABASE_URL`). The fleet
  creates, migrates and drops a database for each feature worktree, and for the walk and env-check
  worktrees, named `<base>_ln_<repo-root hash6>_<feature>_<hash8>` — so checkouts that share one
  database server never drop each other's. **With a `verify.db` and no isolation, the fleet forces
  `parallel: 1` and says why.** A `worktree_env` variable whose database value contains `{feature}`
  already counts as isolation.
- **D15. Generated files** (`generated: { paths, command }` in `.claude/builder.md`). After every
  merge — a sync, a chain or a landing — the fleet runs `generated.command` instead of
  hand-merging the files, then commits only paths under `generated.paths`, tracked or new; never
  `git add -u`. Generated paths stay out of footprints (D1), and a sign-off ignores them (a commit
  that changes only generated paths is not new code — `generatedOnly`). `agent_walk.after_land`, if
  set, runs in the user's checkout after each landing (for example, to regenerate or reinstall).

### Status, docs and config

- **D16. Status shows one line per group**: `group g-a: a ✓ → b ▶ → c ·` (✓ built or landed,
  ▶ building, · waiting), above that group's feature rows. A group of one shows no group line.
- **D17. Nothing new is required in `.claude/builder.md`.** Every new key — `agent_walk.group_max`,
  `agent_walk.split_max_paths`, `agent_walk.test_db_env`, `agent_walk.after_land`, `generated` — is
  optional, and leaving them all out keeps today's behaviour, **except D14's forced `parallel: 1`**
  for a repo with a `verify.db` and no per-worktree database. That is a visible change; the fleet's
  note and the CHANGELOG say what to set to get parallelism back.
- **D18. Docs:** `skills/fleet/SKILL.md` (groups, the barrier, landing, the new keys), the plan skill
  (a task's `Decisions:` line, F3), the guide and `skills/init` (`--update` offers the new keys, never
  writes them unasked).

## Four fleet fixes in the same release

- **F1. Keep the Mac awake.** Once the fleet holds its lock, it spawns `caffeinate -is -w <fleet
  pid>`: detached, stdio ignored, a no-op error handler, `unref()`. Skipped on `--dry-run`,
  `--status`, `--wait`, `--pause` and `--land`, and when an invocation only adds specs to a running
  fleet. The decision is a pure function, `keepAwakeArgs({ platform, env, pid })`, which returns
  null off darwin, when `BUILDER_CAFFEINATE=0`, or when `NODE_TEST_CONTEXT` is set. A note says
  the fleet keeps the Mac awake (or that `caffeinate` is unavailable), and the detached launch line
  ends `· kept awake by caffeinate until it ends`.
- **F2. Wall-clock time.** The status Time cell counts real elapsed time, plus the run in progress —
  not the sum of runs, which double-counts parallel lanes and drops the gaps between runs.
- **F3. Trimmed decisions.** The plan gives each task a `Decisions:` line citing D numbers, and an
  implementer's brief carries only the SPEC §Decisions rows its task cites; `Decisions: none` carries
  none. A plan without the line (written before 6.3.0) carries every row, as today. Scoped
  re-reviews run at `effort: medium`.
- **F4. Walk-lane guard.** A feature signed off with `ready: pending` goes to the walk lane, never
  the ship lane.

## What it costs, and what it saves

- **Saves:** for N overlapping features, one walk and one merge-tier run in place of N each, no
  landing conflicts between members (they were resolved once, while stacking), and no re-walk after
  a landing conflict. A declared dependent starts building as soon as its dependency is *built*,
  not merged.
- **Costs:** members of a group build one after another, not in parallel — slower wall-clock for a
  group than today's parallel-then-conflict, when the conflicts would have been cheap. `group_max`
  bounds it; D13's advice says when splitting out the shared part would restore parallelism. A red
  tip costs up to N prefix runs of the merge tier to find the breaking member (D9).

## Testing

Pure logic in `scripts/groups-core.mjs`, unit-tested directly: `footprintOf`, `matchesGlob`,
`overlapOf`, `edgesOf`, `orderMembers`, `groupsOf`, `splitAdvice`, `laneCollisions`,
`takeWalkBatch`, `landingGate`, `bisectPlan`, `firstFailing`, `generatedOnly`. The fleet behaviour is
proved with stub-driven fleet tests (`scripts/test/fleet.test.mjs` and
`scripts/test/fixtures/stub-claude.mjs`), which run the real fleet, git and verifier. Every fleet test
that could loop takes a spawn timeout, so a spin fails the test instead of hanging it. Among them:

- two overlapping features stack, walk once together, and land together through the tip;
- a declared dependent joins its dependency's group and starts building before the dependency merges;
- walk fixes on the first member send the group back to building from that member, and the
  second member re-chains;
- a red tip finds the breaking member by prefix; the members before it land;
- a group whose first member is stale against the target but whose tip already holds it walks with
  no sync;
- a `verify.db` with no isolation forces `parallel: 1`, with the note; `test_db_env` creates and
  drops one database per worktree;
- a merge that touches generated paths regenerates them and commits only those paths.

## Plan outline (the plan itself follows the owner's review)

1. `groups-core.mjs`: footprints, globs, overlaps, edges, order, groups (D1–D5)
2. Fleet: groups computed at plan time; a group of one unchanged; `--dry-run` and status lines (D3, D4, D16)
3. Stacking and chaining in one lane, with the ancestry check (D6, D7)
4. The barrier: held merge tier on the tip, whole-group walk batches, fix routing, sign-off resets (D8, D8a)
5. Group landing, the gate and prefix bisect (D9)
6. Run-boundary collisions, `fleet-ruling.mjs`, spec-edit pauses, split advice (D10–D13)
7. `lane-db.mjs` and the forced `parallel: 1` (D14)
8. Generated files and `after_land` (D15)
9. F1 caffeinate and F2 wall-clock time
10. F3 trimmed decisions (plan format, `dispatch.mjs`, re-review effort) and F4 the walk-lane guard
11. Docs, preview, CHANGELOG 6.3.0, the full suite on Node 24

## Rulings (owner, 2026-11-14 — "go with your recommendation")

1. **`group_max` defaults to 3.**
2. **D14 forces `parallel: 1`** for a `verify.db` with no per-worktree isolation, with a note naming
   the keys that restore parallelism.
3. **D8 stands:** a human-signed member that receives chained code parks the group's landing as a
   human step; no member lands alone.
