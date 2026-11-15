# Group lanes — implementation plan

**Spec:** [docs/specs/2026-11-14-group-lanes-design.md](../specs/2026-11-14-group-lanes-design.md) — the
authority; D#/F# below are its decisions. **Branch:** `tasks/group-lanes` (worktree
`~/www/builder-group-lanes`). **Release:** 6.3.0.

## Global constraints (every task)

- **Test first.** Write the failing test, see it fail for the right reason, then the code. Fleet behaviour
  is proved with stub-driven tests in `scripts/test/fleet.test.mjs` (real fleet, git and verifier; the
  claude CLI is `scripts/test/fixtures/stub-claude.mjs`). Extend the stub only with new step words,
  documented in its header comment. **Every new fleet test passes `{ timeout }` to `runFleet`** (90 000
  ms or less) and asserts `r.signal === null`, so a loop fails instead of hanging.
- **Run tests on Node 24:** `export PATH=~/.nvm/versions/node/v24.14.1/bin:$PATH`. Unit tests with
  `node --test scripts/test/<file>.test.mjs`; the whole suite with `node --test 'scripts/test/*.test.mjs'`.
  A test run that shows only the known flake ("a spec named while a fleet runs joins its queue") is green.
- **A group of one behaves exactly as today.** Every existing test must keep passing unchanged; a fleet
  whose features don't overlap must make the same calls in the same order.
- **No new dependencies.** Plain Node ESM, as the rest of `scripts/`.
- **Nothing new required in `.claude/builder.md`** (D17). Every new key is optional.
- **No client or project names** from any consuming repo in code, tests, docs or commit messages.
- **One commit per task** (more is fine), message `feat(fleet): …` / `fix(fleet): …` / `docs: …`, ending
  with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Git author: `Luke Keith
  <luke.keith@geniant.com>` (pass `-c user.name=… -c user.email=…`). Never amend, never push.
- **House style:** fleet.mjs explains *why* in comments, in full sentences; user-facing notes and park
  reasons say what happened and end with `— next: <the step>`. Match the surrounding code.
- **Do not touch** `codex/`, `bench/`, or version numbers (Task 11 bumps the version).

### Task 1: `groups-core.mjs` — footprints, overlaps and groups (D1–D5, D9, D10, D13, D15 pure parts)

App: scripts · Phase: 1

**Files:** `scripts/groups-core.mjs` (new), `scripts/test/groups-core.test.mjs` (new)

**Interfaces** (all exported, pure — no fs, no git, no process):

```js
footprintOf(planText, { generated = [] } = {}) // → { paths: string[], produces: string[], consumes: string[] }
matchesGlob(path, glob)                        // → boolean; '*' within a segment, '**' across segments, '?' one char
overlapOf(a, b, { declared = false } = {})      // a, b: footprints → { paths: string[], interfaces: string[], declared: boolean } | null
edgesOf(features)                               // features: [{ name, footprint, dependsOn: string[] }] → [{ a, b, why }]
orderMembers(names, { edges, programOrder = [], fleetOrder = [] }) // → string[] (D5), cycle broken by fleetOrder
groupsOf(features, { max = 3, programOrder, fleetOrder }) // → [{ id: 'g-<first member>', members: string[], waitsOn: string|null }]
splitAdvice(a, b, overlap, { maxPaths = 10 })   // → string | null (D13)
laneCollisions({ changed: { [feature]: string[] }, groups, footprints }) // → [{ feature, group, paths }]
takeWalkBatch(queue, groupOfFeature, max)       // queue: names in order → { batch: string[], rest: string[] }; whole groups only
landingGate(members, manifests)                 // → { ok: true } | { ok: false, why: string }
bisectPlan(members)                             // → string[][]  prefixes [[m1], [m1, m2], …]
firstFailing(results)                           // results: [{ prefix, green }] → index of first red prefix or -1
generatedOnly(paths, generated)                 // → boolean: every path matches a generated glob (empty list → false)
```

**Behaviour:**
- `footprintOf` reads every `### Task N` block: the `**Files:**` lines/bullets (backticked or bare paths,
  with or without a `(new)`/`(modify)` note) and the `**Interfaces:**` section. Names inside a code fence
  under Interfaces are *produced* (a function/type/const/endpoint name declared there — take identifiers
  before `(` or `:` or `=` at line start, and `export`ed names); backticked names in Interfaces prose
  outside a fence are *consumed*. A name both produced and consumed in one plan counts as produced only.
  Paths matching a `generated` glob are dropped. Sort and dedupe each list.
- Two globs overlap when either matches the other's literal prefix (the part before the first glob char)
  or they are equal. D2's three reasons are all reported, not just the first.
- `groupsOf`: connected components of `edgesOf`, members ordered by `orderMembers`, each component cut
  into chunks of `max`; chunk k>0 has `waitsOn` = the id of chunk k−1. A feature with no edges is a group
  of one. Ids are stable: `g-` + the first member's name.
- `splitAdvice` returns a one-line note when `overlap.paths.length` is between 1 and `maxPaths`:
  `<a> and <b> share <n> path(s) (<first 3>…) — a prerequisite feature that takes the shared change would
  let them build in parallel`. Null otherwise, and null for interface-only or declared overlaps.
- `landingGate`: every member's manifest `state` is `signed-off` or `verified`, none has `blocked:`; the
  `why` names the first member that fails and its state.

**Tests:** one `test()` per function at least, covering: a plan with globbed paths and fenced interfaces;
generated paths dropped; glob/glob and path/glob overlap both directions; produce→consume edge; declared
edge with no shared paths; a 4-member component with max 3 → two groups, the second `waitsOn` the first;
cycle broken by fleet order; `takeWalkBatch` never splits a group and lets a group larger than `max`
walk alone; `bisectPlan`/`firstFailing` on 3 members.

- [ ] Write the tests, run them (fail: module missing), write the module, run them green, commit.

### Task 2: config keys (D14, D15, D17)

App: scripts · Phase: 1

**Files:** `scripts/config.mjs`, `scripts/test/config.test.mjs`

**Interfaces:** `agentWalkOf` gains `groupMax` (int > 0, default 3), `splitMaxPaths` (int ≥ 0, default 10),
`testDbEnv` (string|null), `afterLand` (string|null). A new top-level `generated:` block is parsed by the
config loader into `cfg.generated = { paths: string[], command: string|null }` (`paths` a comma list or a
YAML list; absent → `{ paths: [], command: null }`). Follow how existing keys are read and defaulted.

**Tests:** defaults when absent; values when present; invalid values fall back to defaults.

- [ ] Test, implement, green, commit.

### Task 3: groups in the fleet — formed at plan time, members stacked in one lane (D3–D7, D16)

App: scripts · Phase: 2

**Files:** `scripts/fleet.mjs`, `scripts/fleet-core.mjs` (status rendering), `scripts/test/fleet.test.mjs`,
`scripts/test/fixtures/stub-claude.mjs`

**Behaviour:**
- `fleet.groups` (saved in fleet.json): `{ [id]: { members: string[], waitsOn: string|null } }`, and each
  feature row gets `group: <id>` when its group has more than one member. Recompute groups (via
  `groupsOf`) whenever a feature's PLAN.md first exists in its worktree (after a plan-lane run) and at
  each run boundary; a feature without a PLAN.md has no footprint and is a group of one. Never move a
  feature that has started building out of its group.
- **Declared dependents (D4):** a program child whose "Depends on" names a feature *in this fleet run*
  joins that feature's group instead of waiting for it to land (the `after`/`waitsOn`/`pendingDeps`
  path). A dependency not in the run keeps today's wait-for-merge behaviour.
- **Stacking (D6):** a member after the first does not start its build-lane run (state `planned` with
  go-ahead → building) until the member before it is `built` (or further). Its status meanwhile is
  `waiting` with reason `after <prev> builds (group <id>)`. Then the fleet merges the predecessor's
  branch into the member's worktree (`merge --no-edit refs/heads/<prev branch>`; a conflict goes to
  `resolveMerge`), and checks `merge-base --is-ancestor <prev branch> HEAD` in the member worktree. Not
  an ancestor → park: `<prev>'s branch is not in <member>'s worktree (<why, e.g. uncommitted changes
  there>) — next: commit or set aside the changes in <wt>, then /builder:agent <member>`.
- **Chaining (D7):** `chainGroup(id, from)` re-merges each member after index `from` with its
  predecessor's current branch, in order; used by Task 4 when an earlier member changes.
- **Planning stays parallel:** only building is serialised. Members plan in parallel lanes as today.
- **Status (D16):** `--status` prints `group g-a: a ✓ → b ▶ → c ·` above the group's rows (✓ built or
  landed, ▶ in a run, · waiting); a group of one prints nothing new. `--dry-run` prints, for a declared
  dependent in the run, `<b> joins <a>'s group (declared: Depends on <a>)`.

**Tests (fleet, stub-driven):** two planned features whose PLAN.md files share a path: the second's
build starts only after the first is built, and its worktree holds the first's commits; a declared
dependent starts building before its dependency lands; a predecessor branch that can't be merged in
(uncommitted change in the member worktree) parks the member with the reason; two non-overlapping
features behave as today (calls in parallel); `--status` shows the group line; `--dry-run` shows the
join line.

- [ ] Test, implement, green (whole fleet.test.mjs), commit.

### Task 4: the barrier — one held merge tier on the tip, whole-group walks, fix routing (D8, D8a)

App: scripts · Phase: 2

**Files:** `scripts/fleet.mjs`, `scripts/test/fleet.test.mjs`, `scripts/test/fixtures/stub-claude.mjs`

**Behaviour:**
- A member that reaches the walk lane waits (status `awaiting-walk`, reason `waiting for <group> to be
  built`) until every member is at the walk lane or past it. The group then enters the walk queue as a
  unit, members in order.
- **One held merge tier per group**, requested on the **tip** (last member's worktree) at walk start —
  `requestMergeAtWalk` for the tip only; record it on every member row (`mergeReq`).
- **Batches take whole groups** (`takeWalkBatch`). `prepareWalkTree` merges only members whose branch is
  not already an ancestor of a later member's branch in the same group — once chained, just the tip.
  The 6.2.3 classification (stale / deferred / stuck) applies per unit: a stale group syncs **its tip**
  with the target and requeues first; a group whose stack no longer chains is re-chained (`chainGroup`);
  a sync no agent resolves parks the group (every member, the same reason).
- **Fixes:** when the walk leaves `## Fixes` on any member, the group goes back to building starting at
  the earliest member with fixes; members after it re-chain once it's built again, and the barrier
  repeats.
- **Sign-offs after chaining:** a member an agent signed off whose branch receives new code by chaining
  goes back to `state: built` (as `walkAgain` does), so the group walk signs it off again. A human-signed
  member is never reset: record it, and Task 5's landing parks it as a human step.
- **No walk env of its own** (`agent_walk.start` unset): members walk one at a time, in group order,
  only after all are built (walkOne per member).

**Tests:** a group of two walks once in one batch (one `batch a,b` call, no per-member walk) and only
after both are built; only the tip's held merge is requested; walk fixes on member 1 send it back to
building, member 2 re-chains, the group walks again; a group whose first member is stale against the
target but whose tip already holds it walks with no sync; no walk env → members walk in order after both
are built.

- [ ] Test, implement, green, commit.

### Task 5: group landing — the gate, the tip, prefix bisect (D9)

App: scripts · Phase: 2

**Files:** `scripts/fleet.mjs`, `scripts/test/fleet.test.mjs`

**Behaviour:**
- A member that would land (`land`/`landNow`) waits until every member would; the group then lands
  through the tip: `mergeThroughVerifier` on the tip's held run. Right before releasing it,
  `landingGate` on every member's manifest; a failure leaves the group unlanded with the gate's reason
  as each member's reason.
- A human-signed member that received chained code (Task 4) parks as a human step here — the choice of
  walking it again or handing it to agents — and the group waits.
- **Red tip:** run the merge tier on each prefix's last member (`bisectPlan`; reuse the verifier request
  API), find the first red (`firstFailing`). The members before it land (through the last green
  prefix's member); it parks as `merge tier went red: <verdict summary> — next: /builder:agent <member>`;
  the members after it stay, waiting on it.
- Each landed member gets its own archive row, as today.

**Tests:** a group of two lands in one target merge through the tip (target has both members' commits,
one landing merge); a red tip whose prefix [m1] is green lands m1 and parks m2 with `merge tier went
red`; a gate failure (one member paused) lands nothing.

- [ ] Test, implement, green, commit.

### Task 6: overlaps found while running — collisions, rulings, spec edits, split advice (D10–D13)

App: scripts · Phase: 3

**Files:** `scripts/fleet.mjs`, `scripts/fleet-ruling.mjs` (new), `scripts/test/fleet.test.mjs`,
`scripts/test/fleet-ruling.test.mjs` (new), `skills/build/EXECUTION.md` (one paragraph: when to record)

**Behaviour:**
- At each run boundary, `laneCollisions` over each lane's changed paths (`git diff --name-only
  <merge-base>..HEAD`): a collision with another group's unlanded footprint → join that group if the
  feature hasn't started building and there's room, else wait for the group to land; either way a note
  naming the shared paths.
- `fleet-ruling.mjs <feature> <path>… -- <ruling text>` appends `- <date> <feature>: <ruling> (paths: …)`
  to `$BUILDER_FLEET_DIR/rulings.md` (or `.builder/fleet/rulings.md` from the repo root); the fleet reads
  it at each boundary and adds those paths to that feature's footprint.
- A commit landing on the target that changes a feature folder of a feature still planning or building
  pauses it (`blocked: "its spec changed on <target> — next: /builder:revise --path <folder>"`).
- `splitAdvice` notes when groups form (once per pair per run).

**Tests:** fleet-ruling appends and is read back into the footprint; a lane that starts touching another
group's path gets the note and waits/joins; a spec edit on the target pauses a building feature; split
advice note appears for a 2-path overlap and not for an interface-only one.

- [ ] Test, implement, green, commit.

### Task 7: a test database per worktree (D14)

App: scripts · Phase: 3

**Files:** `scripts/lane-db.mjs` (new), `scripts/fleet.mjs`, `scripts/test/lane-db.test.mjs` (new),
`scripts/test/fleet.test.mjs`

**Interfaces:** `laneDbName({ base, root, feature })` → `<base>_ln_<sha1(root) first 6>_<feature
sanitised>_<sha1(root+feature) first 8>` (lowercase, `[a-z0-9_]`, ≤ 63 chars); `laneDbUrl(url, name)`
replaces the database path segment of a URL; `isolated(cfg)` → true when `agent_walk.test_db_env` is set
or a `worktree_env` value for a key containing `DATABASE`/`DB` contains `{feature}`.

**Behaviour:** with `agent_walk.test_db_env: <VAR>`, the fleet sets `<VAR>` in each feature worktree's
env (and the walk and env-check worktrees) to the lane URL, runs the config's `verify.db` create/migrate
commands for it when the worktree is made (reuse whatever `verify.db` already defines — read
`scripts/verify/config.mjs`), and drops it when the worktree is removed. With a `verify.db` and not
`isolated`, `PARALLEL` is forced to 1 and a note says: `parallel 1: the verifier's test database is
shared — set agent_walk.test_db_env (or a {feature} database in worktree_env) to build in parallel`.

**Tests:** name shape, length cap, two roots → different names; URL rewrite (postgres, mysql); forced
parallel note in a fleet with `verify.db` and no isolation; no note with `test_db_env`.

- [ ] Test, implement, green, commit.

### Task 8: generated files and `after_land` (D15)

App: scripts · Phase: 3

**Files:** `scripts/fleet.mjs`, `scripts/test/fleet.test.mjs`

**Behaviour:** after every merge the fleet makes (target sync, chain, landing), when `generated.command`
is set: on a conflict whose conflicted files are all generated, take either side, run the command, `git
add` only paths matching `generated.paths` (tracked or new — list them with `git status --porcelain`, never
`git add -u`), and finish the merge; after a clean merge, run the command and commit only generated paths
if they changed. Generated paths never count as code for the sign-off check (`signoffMoved` uses
`generatedOnly`). `agent_walk.after_land`, when set, runs in ROOT after each landing; a failure is a note.

**Tests:** two features that both change a generated file land with no agent resolve run and the file
regenerated; a commit touching only generated paths after an agent sign-off does not trigger a re-walk;
after_land runs once per landing.

- [ ] Test, implement, green, commit.

### Task 9: keep the Mac awake, wall-clock time (F1, F2)

App: scripts · Phase: 4

**Files:** `scripts/fleet-core.mjs`, `scripts/fleet.mjs`, `scripts/test/fleet-core.test.mjs`,
`scripts/test/fleet.test.mjs`

**Behaviour:** F1 and F2 exactly as the spec says. `keepAwakeArgs({ platform, env, pid })` → `['-is',
'-w', String(pid)]` or null, in fleet-core. F2: the status Time cell is `now − first run start` for a
feature in flight (`last run end − first run start` when done), not the sum of run durations.

**Tests:** keepAwakeArgs table (darwin / linux / `BUILDER_CAFFEINATE=0` / `NODE_TEST_CONTEXT`); the
detached launch line; the Time cell for overlapping runs.

- [ ] Test, implement, green, commit.

### Task 10: trimmed decisions, scoped re-review effort, the walk-lane guard (F3, F4)

App: scripts · Phase: 4

**Files:** `skills/plan/PLAN-FORMAT.md`, `skills/plan/SKILL.md` (as needed), `scripts/dispatch.mjs`,
`scripts/fleet-core.mjs` (`laneOf`), tests in `scripts/test/dispatch.test.mjs` and
`scripts/test/fleet-core.test.mjs`

**Behaviour:** PLAN-FORMAT adds a `Decisions: D1, D4` (or `Decisions: none`) line to each task block.
`dispatch.mjs implementer` copies only the cited §Decisions rows when the line is present (`none` → no
rows), every row when it's absent. The scoped re-review dispatch sets `effort: medium` (find how other
dispatches name effort/model). `laneOf`: `state: signed-off` with `ready: pending` → walk lane.

**Tests:** brief with `Decisions: D2` holds D2 and not D1; `none` holds none; absent holds all; re-review
dispatch carries medium effort; laneOf case.

- [ ] Test, implement, green, commit.

### Task 11: docs, preview, release prep (D18)

App: docs · Phase: 5

**Files:** `skills/fleet/SKILL.md`, `skills/init/SKILL.md` (or its reference), the guide, `README.md` if it
lists fleet keys, `preview/` stages, `CHANGELOG.md` (`## 6.3.0`), `.claude-plugin/plugin.json` (6.3.0)

**Behaviour:** document groups, the barrier, group landing, overlaps while running, the new keys and the
forced `parallel: 1`, F1–F4. Say plainly that parallelism is across features; tasks inside a feature
still run one at a time. `node preview/preview.mjs --check`, rewrite stale stages, `--stamp`. Full suite
on Node 24, `scripts/workspace --self-test`, `claude plugin validate .`.

- [ ] Write, check, green, commit.
