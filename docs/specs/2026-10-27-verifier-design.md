# The verifier — tests that run beside the build, not in front of it — design

**Status:** approved in conversation 2026-10-27; written spec awaiting review. Branch: `feat/verifier`.
Release: 6.0.0 (major — every consumer migrates its config: `## Quality gates` → `verify:`).

## Why

Measured across the fleet history of four consuming projects (128 run streams, 124.5 agent-hours,
879 gate calls; 36 features with a modern stage timeline):

- **Gates are the largest non-model cost.** Waiting on gate suites is 39% of all run time (21% in the
  last week's runs), almost all of it the orchestrator blocked on `job.mjs wait`. A median feature
  makes 15 gate calls and waits 38 minutes on them.
- **It is concentrated, and it is mostly not the feature's fault.** One project carries 94% of gate
  time (46% of its run time; others 2–8%). There: the server fast set averages 13.7 min (a 108-second
  suite, run whole at every phase close, slowed by parallel lanes sharing one Postgres); the deep set
  averages 14 min and fails about half the time; the `flaky:` re-run fired ~290 times for one test;
  a Playwright `@delta` count wobbling around its baseline turned ±1 into a red verify.
- **Red is expensive and often false.** 27% of gate time is red runs, each followed by a fix and a
  whole-set re-run. Inherited debt is judged by counts, flakes by whole-command re-runs.
- **The memo rarely helps where it matters.** A workspace-wide type-check makes every commit change
  the server set's inputs.
- **The build stops to test** at task, phase close, end gates, verify's deep set, and again after
  merging the target — five times proving overlapping things, serially.

The aim: fewer failures that aren't the feature's, and no agent time spent waiting on tests it
doesn't need the answer to yet. Nothing in the current gate machinery has to survive.

## Decisions

| # | Decision |
|---|---|
| D1 | **Merge bar: the full suite + e2e on the merged result, every feature.** Nothing lands unless every suite and check is green on exactly the commit the target will point at. Main is never red. |
| D2 | **Commit verification is pipelined.** The next task starts at once; a red commit gets a fix dispatched against the task that introduced it. **Only phase boundaries wait for green** — a consumer app never starts on a red producer. |
| D3 | **Flakes are listed automatically.** A test that fails then passes on the same commit goes on the flake list at its first flip — still run and recorded, never failing a verdict — **unless the branch added or changed that test file** (then it is a regression the feature must stabilise). It leaves after 20 consecutive clean runs. The list shows in status and fleet reports. |
| D4 | **Projects declare suites by runner** in a `verify:` frontmatter block; builder ships adapters for node:test, vitest, jest, phpunit, xcodebuild and Playwright, plus a generic JUnit adapter. Things that can't report per test are **checks**: all-or-nothing, never selected, optionally compared to the target by output lines. The `## Quality gates` blocks are removed. |
| D5 | **One verifier per repo** — a background service owning the scheduler, worker pool, ledgers, environment pool and merge queue; started on demand, exits idle, all state in files. |
| D6 | **Debt is judged by test identity, not counts.** Known failures are test IDs failing on the target; `compare: lines` replaces `@delta` for checks. |
| D7 | **Every test run is isolated**: its own Postgres database (template clone), its own ports, project hooks for anything else. |
| D8 | **The walk runs beside the merge tier.** A walk that changes no code lets the merge-tier result stand; one that commits fixes cancels it. Verify READY = merge tier green + walk passed; there is no separate deep pass. |
| D9 | **Benchmark before release**: a deterministic gate replay over the 36 archived features, ~5 archived specs re-run end to end on `main` vs `feat/verifier` the same day, and a `bench` smoke run. |
| D10 | The `codex/` port is out of scope; it is mirrored in a follow-up. |

## The units

All under `scripts/verify/`, each one job, each testable alone.

| Unit | Does | Interface |
|---|---|---|
| **service** (`serve.mjs`) | Lifecycle: one per repo (pid lock + liveness in `.builder/verify/`), started by the first request, exits after 10 idle minutes, resumes queued/running work on restart | `verify.mjs serve` (never typed by hand) |
| **client** (`verify.mjs`) | What build, skills and fleet call | `request <worktree> <sha> --tier commit\|phase\|merge [--tree]` → request id · `status` · `verdict <branch> [<sha>]` · `wait <request>` |
| **scheduler** | Priority queue merge > phase > commit; folds queued commit requests on one branch into one; respects resource capacity; hands work to workers | internal |
| **run checkouts** | Each worker tests a clean checkout of the requested commit (a git worktree it reuses), never the agent's live worktree | internal |
| **selector** | Commit range → test files per suite, from `impact.mjs`'s import graph; the whole suite when a change can't be traced (config, lockfile, schema, runner setup), with the reason written | `select(range) → { suite: files \| 'all', why }` |
| **adapters** | One per runner | `list(suite)`, `command(suite, files, env)`, `parse(report) → [{ id, status, ms, msg }]` |
| **env pool** | Isolated environments | `lease(needs) → env`, `release(lease)` |
| **ledger** | `results.jsonl`, `known-failures.json`, `flakes.json`, `requests/` | `record`, `verdictFor(branch, sha)`, queries |
| **classifier** | Failure → regression · known · flake · env-broken | `classify(failure, ctx) → kind` |

The merge queue is the scheduler's top tier, not a separate process.

## Config

The old `## Quality gates` section and its `### <app> — fast` / `### Deep set` blocks are gone. A
`verify:` block in the frontmatter replaces them:

```yaml
verify:
  workers: 3                      # test workers on this machine
  timeout: 15m                    # per suite run
  db:                             # optional — the isolated-DB pool
    kind: postgres
    url: postgres://app:app@localhost:5432/app
    env: [TEST_DATABASE_URL]      # the variable(s) a suite reads the leased URL from
    inputs: "packages/db/prisma/**"   # what the template is built from; its hash names the template
    prepare: npm run db:migrate:test  # builds a template once per inputs hash
    max: 6                        # concurrent leases
  env:                            # optional hooks for anything else
    lease: ./scripts/test-env.sh up      # prints KEY=VALUE pairs
    release: ./scripts/test-env.sh down  # receives them in its env
  suites:                         # report per test → selected, tracked by test ID
    server:    { runner: node-test,  files: "apps/server/test/*.test.ts", app: server, needs: [db] }
    contracts: { runner: node-test,  files: "packages/{contracts,db}/test/**/*.test.ts", app: server }
    web-unit:  { runner: node-test,  files: "apps/web/test/unit/*.test.ts", app: web }
    e2e:       { runner: playwright, app: web, needs: [db, { ports: [PORT, WEB_PORT] }], tiers: [merge] }
  checks:                         # all-or-nothing, never selected
    typecheck: { run: npm run typecheck, tiers: [commit, phase, merge] }
    css:       { run: npm run gate:css, compare: lines, tiers: [phase, merge] }
    web-build: { run: npm run build -w @app/web, tiers: [phase, merge] }
```

- A suite's default tiers are `[commit, phase, merge]`: selected files at commit and phase, the whole
  suite at merge. A check runs at the tiers it lists (default `[phase, merge]`).
- `compare: lines` fails a check only on an output line the target's run doesn't print — inherited
  lint or CSS debt passes, a new finding fails and is named. Default `compare: exit`.
- `needs`: `db`, `{ ports: [NAMES] }`, `walk-env` (leases the running dev env; such suites run one at
  a time), `simulator` (a cloned simulator per worker), or a name the `env` hooks understand.
- `/builder:init` writes the block; `/builder:init --update` migrates an old config's gate blocks,
  inferring each runner from its command and asking only where it can't.

### Adapters

Selection is by file (the import graph is file-level); results are by test ID.

| runner | run chosen files | per-test results |
|---|---|---|
| `node-test` | file list | `--test-reporter=junit --test-reporter-destination=<f>` |
| `vitest` | file list | `--reporter=junit --outputFile=<f>` |
| `jest` | file list | `--json --outputFile=<f>` |
| `phpunit` | file list | `--log-junit <f>` |
| `xcodebuild` | `-only-testing:<target>/<class>` per file | `-resultBundlePath <b>` → `xcrun xcresulttool` |
| `playwright` | file list | `--reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<f>` |
| `junit` | `{files}` in a project command | the report path given |

A test ID is `<suite>::<file>::<test name path>`.

## The flow

### Commit tier — in the background

1. After each task commit the build calls `verify request <worktree> <sha> --tier commit` and moves on.
2. The scheduler folds it into any queued commit request on the same branch. The range runs from the
   branch's last green commit (else the merge-base) to the newest commit.
3. A worker checks out that commit, leases what the selected suites need, runs the commit-tier checks
   and the selected files, and writes a verdict:
   `{ request, sha, tier, status: green|red|conflict|env-broken|gone, regressions: [{ suite, id, msg, introducedBy }], flakes, known, ms }`.
4. Red over a folded range: the verifier re-runs only the failing tests on each commit of the range to
   set `introducedBy` (the commit, and so the task).
5. Before every dispatch the build reads `verdict` (a file read). Each regression becomes a fix
   dispatch against the task that introduced it, carrying the failing test's output and that task's
   diff. The fix commit enters at step 1.

### Phase tier — the build's only wait

At phase close the build requests `--tier phase` for the phase's last commit — the files the phase's
range reaches, plus phase-tier checks — and calls `wait`. A test result already recorded at a commit
whose tree for that test's inputs is identical is reused, so this mostly runs what was folded or not
yet reached. A consumer app's phase starts only on green.

### Merge tier — the merge queue

1. After the build and final review, the feature enters the queue (`--tier merge`): a checkout of the
   target's tip with the branch merged in.
2. A conflict → verdict `conflict`; agents resolve it as today and the feature re-enters.
3. Otherwise every suite whole and every check runs. Green → the target is fast-forwarded to exactly
   the tested commit: `git update-ref refs/heads/<target> <tested> <expected-old>`, or `merge
   --ff-only` in the main worktree when the target is checked out there. A refusal means the target
   moved; the feature runs again on the new tip.
4. One feature at a time per target branch, so what lands is what was tested.

### The walk beside the merge tier

The agent walk starts when the feature enters the queue. A walk that passes without committing lets
the merge-tier result stand and the feature lands on both. A walk that commits fixes cancels the
merge-tier run; the feature re-enters the queue once those fixes are green at the commit tier.
**Verify READY = merge-tier green + walk passed.**

## Environments

- **Postgres**: one template database per `db.inputs` hash, built once by `prepare` against an empty
  database (`<db>_vt_tpl_<hash>`). A lease is `CREATE DATABASE <db>_vt_<n> TEMPLATE <tpl>`; release
  drops it. A branch that changes the schema gets its own template.
- **Ports**: free ports under the names the suite asks for.
- **Hooks**: `env.lease` / `env.release` for containers, simulators or anything else.
- **Capacity**: each resource has a limit (`db.max`, simulators, `walk-env` = 1); the scheduler never
  starts a run it can't lease for.

## Judging a failure

Each failing test, in this order:

1. **Env-broken** — no report, a failed lease, or the process died before any test ran. The run is
   retried once in a fresh environment; failing again → verdict `env-broken` with the reason. Never
   red, never a fix dispatch.
2. **Known** — the ID is in the target's `known-failures.json`. Ignored.
3. **Flake-listed** — recorded only.
4. **Re-run that single test** on the same commit in a fresh environment. It passes → onto the flake
   list, unless the branch added or changed its file (then a regression noted "flaky test this branch
   owns").
5. **Still failing → run it on the target's tip.** It fails there too → newly found debt, added to
   known failures. Otherwise → **regression**, the only outcome that dispatches a fix.

At most one single-test run per step; never a suite re-run.

### The ledgers (`.builder/verify/`, git-ignored)

- `results.jsonl` — every test result `{ run, sha, tier, suite, id, status, ms }`.
- `known-failures.json` — per target, failing test IDs. Seeded by one full run on the target's tip the
  first time, and again when the target moves other than through the queue. A merge that turns a known
  failure green removes it.
- `flakes.json` — `{ id, since, flips, cleanStreak }`.
- `requests/<id>.json` — `queued → running → done`, with the verdict.

## Failure modes

- **Service crash** — on restart `running` requests return to `queued`; leases carry the owning pid;
  orphaned `<db>_vt_*` databases are dropped and run checkouts reset.
- **Two services** — pid lock with a liveness check; the loser exits, its requests are already files.
- **Untraceable change** — the whole suite, with the reason in the verdict.
- **Commit gone** (rebased/amended) — verdict `gone`; the build re-requests its head.
- **Uncommitted work** (`commit:manual` apps in chat builds) — `request --tree` snapshots the worktree
  as a commit object without touching the branch.
- **Hung test** — the suite timeout; timed-out tests are failures judged as above; no report at all is
  env-broken.

## What changes in builder

**Removed:** `scripts/gate.mjs`, `scripts/gates-core.mjs` (memo, `@delta`, `--baseline`, `flaky:`,
`@scoped`, `@parallel`, `@typecheck`, `@walk`, `@local`, `@known-red`); `job.mjs` as the way gates are
waited on (deleted if nothing else uses it); `PROJECT.template.md` §Quality gates and §Deep set; the
test plan's `slice` and `end` levers (`review`, `models`, `persist`, `unruled`, `walk` stay).

**Kept:** `impact.mjs`, as the selector's graph.

**Changed:** `skills/build` (request per commit, read verdicts before each dispatch, wait at phase
close, enter the merge queue) · `skills/verify` (merge-tier verdict + walk) · `scripts/fleet.mjs` (no
start-of-run baseline, no deep set in the walk lane, landing through the queue, the walk beside the
merge tier) · `skills/resume` AGENT-MODE and REFERENCE · `skills/agent-walk` · `skills/plan` and
PLAN-FORMAT (no `slice`/`end`) · `skills/init` (writes and migrates `verify:`) · `scripts/profile.mjs`
· `scripts/statusline.mjs` (the verifier's queue in place of running gates) · `scripts/tidy-core.mjs`
(verifier checkouts) · `scripts/dispatch.mjs`, `docs.mjs`, `feature-core.mjs`, `handoff.mjs`,
`plan-slices.mjs`, `config.mjs` (every reference to gates) · `preview/` stages (`node
preview/preview.mjs --check`, rewrite, `--stamp`).

## Testing

node:test in `scripts/test/`, as the existing suites:

- **Units**: scheduler (priority, folding, capacity), selector, classifier (each of the five
  outcomes), ledgers (flake in/out, known-failure seeding and shrinking), the request state machine
  across a simulated crash.
- **Adapters**: against recorded real reports, one fixture per runner.
- **End to end**: `bench/fixtures/notes-hub` gains a planted flaky test, a planted known failure and a
  port race. Asserted: the feature lands green, the flake is listed, the known failure ignored, and a
  planted regression produces exactly one fix aimed at the right commit.

## Benchmark

All on `feat/verifier`, all in scratch copies — never the consumer repos themselves.

1. **Gate replay (no models — the strict comparison).** For each of the 36 archived features with a
   modern timeline, in a scratch clone at its original base commit, replay its branch's commits:
   - *Control*: `main`'s `gate.mjs` at the points the archive shows it ran — per task under
     `slice=full`, each phase close, end gates, the deep set, the post-merge re-gate.
   - *Treatment*: the verifier fed the same commits as commit, phase and merge requests.
   - Same machine, same day. Measured per feature: test execution time, **blocking time** (what a
     build would have waited), red results not caused by the feature (flake or debt), regressions
     caught.
2. **End to end (models).** About 5 archived specs — 3 from the project that carries most gate time,
   2 from a second project, mixed sizes — each run through the fleet twice the same day: `main`
   (control first) and `feat/verifier`, in scratch copies at the original base. Compared on the
   archive row's existing measures: wall clock, stages, gate share, fix rounds, parks, cost — and
   both against the original archive row.
3. **Smoke**: `bench` features `tags` and `share` once, to show the small path didn't regress.

**Success** (on the replay): blocking time per feature down by more than half; red results not caused
by the feature near zero; no regression the old gates caught is missed. The end-to-end runs confirm
the saving reaches wall clock and cost.

## Out of scope

- The `codex/` port (a follow-up mirror).
- Moving the per-feature orchestration from a model into code — the next spec, simpler once nothing
  waits on tests.
- Speculative batching in the merge queue (several features tested together); one at a time first.
