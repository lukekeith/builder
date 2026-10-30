# Benchmark suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/builder:benchmark` offers a catalogue of sized benchmark cases (builder's fixtures plus local, archived real features), schedules a picked set into parallel lanes that fit a night, runs it detached, and reports where tokens and minutes went against each case's baseline.

**Architecture:** Pure decisions (estimates, lane packing, budget fill, profile application, safety check, report tables) live in `scripts/bench-suite-core.mjs` and are unit-tested. `scripts/bench-case.mjs` runs one archived case end to end in a scratch clone. `scripts/bench-suite.mjs` is the CLI: it lists the catalogue, plans the schedule, runs lanes detached, shows status, and writes the report. Fixture cases run through the existing `scripts/bench.mjs` unchanged.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, git CLI; no dependencies.

**Spec:** `docs/specs/2026-10-29-benchmark-suite-design.md`

## Global Constraints

- Real-project cases, profiles and per-case results live only under `bench/local/` (git-ignored except `bench/local/README.md`). No committed file, report, test fixture or skill text names a consuming project.
- The committed suite report (`bench/results/<date>-suite/REPORT.md`) carries case ids and sizes only; the named detail is `bench/local/results/<suite-id>/REPORT.md`.
- Nothing writes into a project repo: every archived case runs in `git clone --no-local` copy with `origin` removed.
- Sizes are exactly `xs | sm | md | lg | xl`, in that order.
- Default `--lanes 3`; a night is `--budget 12h`; success tolerance ±25% of the estimate.
- Two cases of one project never run at the same time. All fixture cases count as one project, `fixtures` (bench.mjs holds one global lock).
- Env overrides for tests: `BENCH_LOCAL` (default `<builder>/bench/local`), `BENCH_SUITE_OUT` (default `<builder>/bench/results`), `BENCH_FLEET` (as bench.mjs), `BENCH_CASE` (the case runner the suite spawns), `BENCH_FIXTURE_RUNNER` (the bench.mjs the suite spawns).
- Never launch from a session as a background task; `run --detach` only (as bench.mjs).

## Review Focus

1. **An archive row from before the fleet recorded time** (no `wallMs`, no `costUsd`, as the oldest rows are) — the estimate falls back to the summed `timing[].ms` / `timing[].tokens.costUsd`, and to "no estimate yet" when there is no timing either; the report shows `—`, never `0` or `NaN`. Tested in Task 1 and Task 3.
2. **A case whose real run is far longer than its estimate** — the project mutex is enforced at run time, not only in the packed schedule, so a late case never overlaps another of its project. Tested in Task 5.
3. **A profile that would touch the human's environment** — a non-bench database name, a port already listening, `docker` against a non-bench container, `simctl … booted` — is refused before launch, and the whole suite does not start. Tested in Task 2 and Task 5.
4. **The suite process dying mid-run** (machine sleep, kill) — `status` says it stopped, which items finished, and `run --resume <suite-id>` runs only the unfinished ones. Tested in Task 5.
5. **A `merged` sha that is short or no longer a merge commit** (a squash) — the case fails at prep with the reason in status, the other lanes go on. Tested in Task 4.

---

### Task 1: Catalogue, estimates, lane packing, budget fill

**Files:**
- Create: `scripts/bench-suite-core.mjs`
- Test: `scripts/test/bench-suite-core.test.mjs`

**Interfaces:**
- Produces:
  - `SIZES = ['xs','sm','md','lg','xl']`
  - Case: `{ id, kind: 'fixture'|'archived', size, project, feature, covers, estimate: { minutes, usd }|null, control?: true }` — a control's id is `<id>@main`.
  - `estimateFromRow(row) → { minutes, usd }|null` — minutes from `row.wallMs`, else Σ `timing[].ms`; usd from `row.costUsd` when > 0, else Σ `timing[].tokens.costUsd`, else `null` (minutes alone still makes an estimate); `null` when neither minutes source exists. Minutes rounded up to whole, usd to cents.
  - `estimateFromRuns(runsJson, config = 'builder') → { minutes, usd }|null` — median `ms` and median `runTotals(sessions).costUsd` over that config's `status: 'done'` runs.
  - `pickLabel(c) → string` — `` `${size} · ${id} — ${covers} · ~${minutes}m · ~$${usd}` ``; with no estimate the tail is `· no estimate yet`; with no usd `· ~$?`.
  - `packLanes(items, lanes) → { lanes: Array<Array<{ id, project, start, end }>>, wallMinutes, usd }` — times in minutes from 0.
  - `fillBudget(cases, { minutes, lanes }) → { picked: Case[], skipped: Array<{ id, reason }> }`
  - `recommendControls(cases) → string[]` — per size, in `SIZES` order, the archived case with the smallest estimated minutes.

- [ ] **Step 1: Write the failing tests** in `scripts/test/bench-suite-core.test.mjs`:

```js
test('estimateFromRow: wallMs and costUsd win', () =>
  assert.deepEqual(estimateFromRow({ wallMs: 61 * 60000, costUsd: 3.456, timing: [{ ms: 1 }] }), { minutes: 61, usd: 3.46 }))
test('estimateFromRow: an old row falls back to timing', () =>
  assert.deepEqual(estimateFromRow({ timing: [{ ms: 90000, tokens: { costUsd: 1 } }, { ms: 30000, tokens: { costUsd: 0.5 } }] }), { minutes: 2, usd: 1.5 }))
test('estimateFromRow: no time at all is no estimate', () => assert.equal(estimateFromRow({ feature: 'x', runs: 3 }), null))
test('estimateFromRuns: median of done builder runs', () => {
  const s = (c) => [{ totals: { costUsd: c } }]
  const runs = { runs: [{ config: 'builder', status: 'done', ms: 600000, sessions: s(2) }, { config: 'builder', status: 'done', ms: 1200000, sessions: s(4) }, { config: 'builder', status: 'done', ms: 900000, sessions: s(3) }, { config: 'builder', status: 'failed', ms: 1, sessions: s(99) }, { config: 'gsd', status: 'done', ms: 1, sessions: s(1) }] }
  assert.deepEqual(estimateFromRuns(runs), { minutes: 15, usd: 3 })
})
test('pickLabel', () => {
  assert.equal(pickLabel({ id: 'a', size: 'md', covers: 'two apps', estimate: { minutes: 90, usd: 12.5 } }), 'md · a — two apps · ~90m · ~$12.5')
  assert.equal(pickLabel({ id: 'b', size: 'xs', covers: 'one command', estimate: null }), 'xs · b — one command · no estimate yet')
})
test('packLanes: longest first, onto the lane free earliest', () => {
  const c = (id, project, minutes) => ({ id, project, estimate: { minutes, usd: 1 } })
  const p = packLanes([c('s', 'A', 10), c('l', 'B', 100), c('m', 'C', 50), c('m2', 'D', 40)], 2)
  assert.deepEqual(p.lanes.map((l) => l.map((x) => x.id)), [['l'], ['m', 'm2', 's']])
  assert.equal(p.wallMinutes, 100)
  assert.equal(p.usd, 4)
})
test('packLanes: never two of one project at once, even with a lane idle', () => {
  const c = (id, minutes) => ({ id, project: 'A', estimate: { minutes, usd: 0 } })
  const p = packLanes([c('a', 60), c('b', 30)], 3)
  const all = p.lanes.flat()
  const b = all.find((x) => x.id === 'b')
  assert.equal(b.start, 60)
  assert.equal(p.wallMinutes, 90)
})
test('fillBudget: widest spread of sizes first, skips what has no estimate', () => {
  const c = (id, size, minutes, project = id) => ({ id, size, project, kind: 'archived', estimate: minutes == null ? null : { minutes, usd: 1 } })
  const r = fillBudget([c('xl1', 'xl', 700), c('lg1', 'lg', 300), c('md1', 'md', 120), c('md2', 'md', 100), c('sm1', 'sm', 40), c('xs1', 'xs', null)], { minutes: 720, lanes: 2 })
  assert.deepEqual(r.picked.map((x) => x.id).sort(), ['lg1', 'md1', 'md2', 'sm1', 'xl1'])
  assert.deepEqual(r.skipped, [{ id: 'xs1', reason: 'no estimate' }])
})
test('fillBudget: a case that would overrun is skipped with the reason', () => {
  const r = fillBudget([{ id: 'big', size: 'xl', project: 'A', estimate: { minutes: 800, usd: 1 } }], { minutes: 720, lanes: 3 })
  assert.deepEqual(r, { picked: [], skipped: [{ id: 'big', reason: 'does not fit 720m' }] })
})
test('recommendControls: the shortest archived case per size', () => {
  const c = (id, size, minutes, kind = 'archived') => ({ id, size, kind, estimate: { minutes, usd: 1 } })
  assert.deepEqual(recommendControls([c('a', 'md', 90), c('b', 'md', 60), c('c', 'lg', 200), c('f', 'sm', 5, 'fixture')]), ['b', 'c'])
})
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** the Interfaces above in `scripts/bench-suite-core.mjs` (`runTotals` from `./bench-core.mjs`). Items without an estimate are not packable — callers filter them. The packing is the decision; implement it as:

```js
// longest first; each item goes to the lane where it can start earliest — a lane's free time,
// or the end of the last item of its project, whichever is later; ties → the lower lane index
const order = [...items].sort((a, b) => b.estimate.minutes - a.estimate.minutes || a.id.localeCompare(b.id))
const free = Array(lanes).fill(0), projectFree = new Map()
for (const it of order) {
  const starts = free.map((f) => Math.max(f, projectFree.get(it.project) ?? 0))
  const lane = starts.indexOf(Math.min(...starts))
  const start = starts[lane], end = start + it.estimate.minutes
  out[lane].push({ id: it.id, project: it.project, start, end }); free[lane] = end; projectFree.set(it.project, end)
}
```

`fillBudget`: skip unestimated cases first (`'no estimate'`). Then rounds: each round walks the sizes `xl, lg, md, sm, xs` and, per size, tries that size's next not-yet-tried case (shortest first). A case is picked if `packLanes([...picked, case], lanes).wallMinutes <= minutes`, else skipped with `` `does not fit ${minutes}m` ``. Stop when a round picks nothing.

- [ ] **Step 4: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add scripts/bench-suite-core.mjs scripts/test/bench-suite-core.test.mjs && git commit -m "feat(bench): suite core — estimates from archive rows and reports, lane packing, budget fill"`

---

### Task 2: Profile application and the safety check

**Files:**
- Modify: `scripts/bench-suite-core.mjs`
- Test: `scripts/test/bench-suite-core.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - Profile (`bench/local/projects/<name>.json`): `{ repo, setup?: string, agent_walk: { <key>: <string> }, verify?: string /* path, relative to the profile file, to a YAML file holding the verify: block */, files?: { "<path in clone>": "<source path, relative to the profile file>" }, db_prefix: string }`
  - `applyProfile(builderMd, { agentWalk, verifyBlock, claudeArgs }) → string` — in the front matter: each `agent_walk` key replaced in place or appended to the `agent_walk:` map (the map is created when missing); `claude_args` set to `claudeArgs`; when `verifyBlock` is given, the whole top-level `verify:` section replaced by it (or appended before the closing `---`). The body after the front matter is untouched.
  - `safetyRefusals(builderMd, profile, { listening }) → string[]` — empty means safe. `builderMd` is the text *after* `applyProfile`; `listening` is the TCP ports now listening.

- [ ] **Step 1: Write the failing tests:**

```js
const MD = '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: {claude_args}\n  env: PORT=4917\nverify:\n  workers: 2\n---\n\n# body\nverify: stays\n'
test('applyProfile: replaces and appends agent_walk keys, sets claude_args, swaps verify', () => {
  const out = applyProfile(MD, { agentWalk: { env: 'PORT=5917 DATABASE_URL=postgres://localhost/bench_p', start: 'npm start' }, verifyBlock: 'verify:\n  workers: 1\n', claudeArgs: '--plugin-dir /b' })
  assert.match(out, /^  env: PORT=5917 DATABASE_URL=postgres:\/\/localhost\/bench_p$/m)
  assert.match(out, /^  start: npm start$/m)
  assert.match(out, /^  claude_args: --plugin-dir \/b$/m)
  assert.match(out, /^verify:\n  workers: 1\n---/m)
  assert.ok(out.endsWith('# body\nverify: stays\n'))
})
test('applyProfile: no agent_walk map yet', () =>
  assert.match(applyProfile('---\nproject: p\n---\n', { agentWalk: { env: 'X=1' }, claudeArgs: '--a' }), /^agent_walk:\n  env: X=1\n  claude_args: --a\n---/m))
const P = { db_prefix: 'bench_' }
const walk = (s) => `---\nagent_walk:\n  claude_args: --plugin-dir /b\n${s}\n---\n`
test('safety: a bench database and a free port pass', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=5917 DATABASE_URL=postgres://u@localhost:5432/bench_p'), P, { listening: [5432] }), []))
test('safety: a database that is not the bench\'s', () =>
  assert.deepEqual(safetyRefusals(walk('  env: DATABASE_URL=postgresql://localhost:5432/app_dev'), P, { listening: [5432] }), ['database app_dev is not a bench database (bench_*)']))
test('safety: a port something already listens on', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=3000'), P, { listening: [3000] }), ['port 3000 is in use now']))
test('safety: docker against a container that is not the bench\'s', () =>
  assert.deepEqual(safetyRefusals(walk('  start: docker start app-db'), P, { listening: [] }), ['docker command names no bench_ container: docker start app-db']))
test('safety: the booted simulator', () =>
  assert.deepEqual(safetyRefusals(walk('  start: xcrun simctl launch booted com.x'), P, { listening: [] }), ['simctl targets the booted simulator — name a bench device UDID']))
test('safety: claude_args still the placeholder', () =>
  assert.deepEqual(safetyRefusals('---\nagent_walk:\n  claude_args: {claude_args}\n---\n', P, { listening: [] }), ['agent_walk.claude_args is not set — sessions would load the user\'s plugins']))
test('safety: no db_prefix', () =>
  assert.deepEqual(safetyRefusals(walk(''), {}, { listening: [] }), ['profile has no db_prefix']))
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `applyProfile` and `safetyRefusals` in `scripts/bench-suite-core.mjs`. The check scans only the front matter. The rules, in this order, are pinned by the tests' messages:
  - a database URL `(postgres|postgresql|mysql|mongodb|redis)://…/<name>` whose `<name>` does not start with `db_prefix`;
  - a port in `PORT=N`, `--port N`, `localhost:N` or `127.0.0.1:N` that is in `listening`, except a database URL's own server port (a shared server with a bench database is fine);
  - a line with `docker (start|stop|exec|run|rm|compose)` that does not contain `db_prefix`;
  - `simctl … booted`;
  - `claude_args` still `{claude_args}`.

  A profile with no `db_prefix` gets that one refusal and no other checks.

- [ ] **Step 4: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(bench): suite core — a profile applied to a clone's config, and the safety check that refuses one touching the human's environment"`

---

### Task 3: Results and the report tables

**Files:**
- Modify: `scripts/bench-suite-core.mjs`
- Test: `scripts/test/bench-suite-core.test.mjs`

**Interfaces:**
- Consumes: `estimateFromRow` (Task 1); `runTotals` from `bench-core.mjs`.
- Produces:
  - Measure: `{ wallMs|null, costUsd|null, turns|null, tokens|null, stages: { [stage]: ms }|null, byKind|null, quality|null }`
  - `measureFromRow(row) → Measure`. Here `tokens` = `input + output + cacheRead + cacheCreation` + Σ `byKind[*].sumCtx`, and `turns` = `orchestrator.turns` + Σ `byKind[*].turns`. `wallMs`/`costUsd` fall back as in `estimateFromRow`. A field with no source is `null`.
  - `measureFromRuns(runsJson, config = 'builder') → Measure` — the median done run. Stages are its sessions' `totals.ms`, keyed by session name with its trailing number dropped (`fleet 03` → `fleet`).
  - Result: `{ id, size, kind, project, control: boolean, status, measure: Measure|null, baseline: Measure|null, specLines|null, planLines|null }`
  - `topSpend(results, n = 5) → { minutes: Array<{ where, minutes }>, tokens: Array<{ where, tokens }> }`. Minutes come from stage ms summed by stage name across non-control results. Tokens come from `byKind` sumCtx summed by kind, with `where` = `` `${kind} dispatches` ``. Both are sorted descending and cut to `n`.
  - `renderSuiteReport(results, { names }) → string` — markdown. With `names: false`, a result's `project` never appears, and `id` and `size` are the only identifiers.

- [ ] **Step 1: Write the failing tests:**

```js
const row = (wallMin, cost, stages) => ({ wallMs: wallMin * 60000, costUsd: cost, tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 0 }, orchestrator: { turns: 4 }, byKind: { implementer: { turns: 20, sumCtx: 1000 }, reviewer: { turns: 6, sumCtx: 400 } }, stages, quality: { fixRounds: 2 } })
test('measureFromRow', () => {
  const m = measureFromRow(row(60, 9, { build: 3600000 }))
  assert.equal(m.tokens, 1515); assert.equal(m.turns, 30); assert.equal(m.wallMs, 3600000)
})
test('measureFromRow: an old row has nulls, not zeros', () => {
  const m = measureFromRow({ feature: 'x' })
  assert.deepEqual([m.wallMs, m.costUsd, m.tokens, m.turns], [null, null, null, null])
})
test('topSpend: by stage minutes and by dispatch kind, controls left out', () => {
  const r = (id, stages, control = false) => ({ id, control, measure: measureFromRow(row(1, 1, stages)) })
  const t = topSpend([r('a', { build: 60 * 60000, plan: 10 * 60000 }), r('b', { build: 30 * 60000, walk: 20 * 60000 }), r('a@main', { build: 999 * 60000 }, true)], 2)
  assert.deepEqual(t.minutes, [{ where: 'build', minutes: 90 }, { where: 'walk', minutes: 20 }])
  assert.deepEqual(t.tokens, [{ where: 'implementer dispatches', tokens: 2000 }, { where: 'reviewer dispatches', tokens: 800 }])
})
test('renderSuiteReport: no project names in the committed report, — for missing numbers', () => {
  const res = [{ id: 'c1', size: 'md', kind: 'archived', project: 'secretproj', control: false, status: 'done', measure: measureFromRow(row(50, 8, { build: 1 })), baseline: measureFromRow({ feature: 'x' }), specLines: 120, planLines: 300 }]
  const md = renderSuiteReport(res, { names: false })
  assert.doesNotMatch(md, /secretproj/)
  assert.match(md, /\| c1 \| md \|/)
  assert.match(md, /—/)
  assert.doesNotMatch(md, /NaN|undefined/)
  assert.match(renderSuiteReport(res, { names: true }), /secretproj/)
})
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** in `scripts/bench-suite-core.mjs`. The report sections, in order:
  - **Cases**: id, size, status, wall, tokens, turns, cost, then each of those four as Δ% against the baseline and against the control, and the estimate with `within ±25%` / `over` / `under` (the spec's success line).
  - **Stages**: one row per case, one column per stage. The column order is brainstorm, spec, then the fleet's `STAGE_ORDER` (`audit, plan, build, finalReview, endGates, walk, verify, ship, merge, parked`).
  - **Plan format**: spec lines, plan lines, the ratio, fix rounds.
  - **Gate share**: `endGates + verify` ÷ wall.
  - **Top 5**: both lists from `topSpend`.

  Use `duration` and `formatTokens` from `fleet-core.mjs`. A null value renders `—`.

- [ ] **Step 4: Run** `node --test scripts/test/bench-suite-core.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(bench): suite core — measures from archive rows and fixture runs, the suite report and the top places time and tokens went"`

---

### Task 4: One archived case end to end — `scripts/bench-case.mjs`

**Files:**
- Create: `scripts/bench-case.mjs`
- Modify: `scripts/bench.mjs` (export `disabledPlugins`)
- Test: `scripts/test/bench-case.test.mjs`

**Interfaces:**
- Consumes:
  - `applyProfile`, `safetyRefusals`, `measureFromRow` (Tasks 2–3);
  - `featureRange` (`bench-replay-core.mjs`);
  - `disabledPlugins` (`bench.mjs`);
  - `landedRow` (`fleet-core.mjs`).
- Produces:
  - CLI: `node scripts/bench-case.mjs <case-id> --builder <checkout> --out <dir> [--dry-run]`. It reads `$BENCH_LOCAL/cases/<id>.json` and `$BENCH_LOCAL/projects/<project>.json`. It exits 0 and writes `<out>/result.json` (a Result, Task 3) whether the case landed or not. It exits 2 on a refusal, with the reasons on stderr.
  - `specCommits(repo, registry, feature, commits) → string[]` — the leading commits of `commits` whose changed files are all under `<registry>/<feature>/`, stopping at the first that touches anything else.
  - `prepareClone({ profile, profileDir, caseDef, builder, dest }) → { clone, base, specs, refusals }`. Steps, in order:
    1. Find the original archive row: `landedRow(profile.repo, feature)`.
    2. Get the range: `featureRange(repo, row.merged)`.
    3. Clone: `git clone --no-local -q <repo> <dest>`, then `checkout -B main <base>`, then `cherry-pick` the spec commits, then `remote remove origin`.
    4. Write `.claude/bench-settings.json` (`{ enabledPlugins: disabledPlugins() }`) and add it to `.git/info/exclude`.
    5. Apply the profile to `.claude/builder.md`. `claudeArgs` = `--permission-mode bypassPermissions --settings <clone>/.claude/bench-settings.json --plugin-dir <builder>`. The verify block is read when `profile.verify` is set.
    6. Copy `profile.files` into the clone, untracked and excluded.
    7. Commit `bench: profile` (builder.md only) on `main`.
    8. Run `profile.setup` in the clone when set.

    `refusals` is `safetyRefusals(...)` plus the profile and case checks (missing file, missing row, missing `merged`). Any refusal stops before the clone is made, except checks that need the clone's `builder.md`. Those run after step 5, and on a refusal the clone is deleted.

- [ ] **Step 1: Write the failing tests** in `scripts/test/bench-case.test.mjs`. The fixture is built in a tmp dir:
  - a git repo with `.claude/builder.md` (`registry: docs/features`, an `agent_walk:` map, `claude_args: {claude_args}`) on `main`;
  - a branch `builder/f` with commit 1 touching only `docs/features/f/SPEC.md` + `MANIFEST.md`, commit 2 touching `src/a.js`;
  - that branch merged `--no-ff` into `main`;
  - `.builder/fleet/archive.jsonl` holding `{ feature: 'f', merged: <merge sha>, wallMs: 600000, costUsd: 2, timing: [] }`;
  - `BENCH_LOCAL` with `projects/p.json` (`{ repo, agent_walk: { env: 'PORT=5999' }, db_prefix: 'bench_' }`) and `cases/c1.json` (`{ id: 'c1', size: 'sm', kind: 'archived', project: 'p', feature: 'f', covers: 'one file' }`);
  - `BENCH_FLEET` → `scripts/test/fixtures/bench/stub-fleet-land.mjs` (new). The stub appends an archive row `{ feature, merged: 'x', wallMs: 300000, costUsd: 1, stages: { build: 200000 }, timing: [] }` to `<cwd>/.builder/fleet/archive.jsonl` and writes `docs/features/<f>/PLAN.md` (10 lines) as a commit.

```js
test('specCommits: the leading spec-only commits', () => assert.deepEqual(specCommits(repo, 'docs/features', 'f', range.commits), [range.commits[0]]))
test('a case runs in a clone and never touches the repo', () => {
  const before = git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain')
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain'), before)
  const res = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
  assert.equal(res.status, 'done'); assert.equal(res.measure.wallMs, 300000); assert.equal(res.baseline.wallMs, 600000)
  assert.equal(res.specLines > 0, true); assert.equal(res.planLines, 10)
  const clone = join(out, 'clone')
  assert.equal(git(clone, 'remote'), '')
  assert.match(readFileSync(join(clone, '.claude', 'builder.md'), 'utf8'), /claude_args: --permission-mode bypassPermissions --settings \S+ --plugin-dir /)
  assert.ok(!existsSync(join(clone, 'src', 'a.js')))   // the code commit is not in the clone's start
})
test('an unsafe profile is refused before a clone is made', () => {
  writeProfile({ agent_walk: { env: 'DATABASE_URL=postgres://localhost/app_dev' } })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2); assert.match(r.stderr, /database app_dev is not a bench database/)
})
test('a squash-merged feature fails prep with the reason, exit 0, status failed', () => {
  setRow({ merged: '<a non-merge sha>' })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*not a merge commit/)
})
test('--dry-run prints what the clone will touch and runs nothing', () => {
  const r = run(['c1', '--builder', REPO, '--out', out, '--dry-run'])
  assert.equal(r.status, 0); assert.match(r.stdout, /PORT=5999/); assert.ok(!existsSync(join(out, 'result.json')))
})
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-case.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** `scripts/bench-case.mjs`. After prep, it runs `node $BENCH_FLEET|<builder>/scripts/fleet.mjs <feature> --into main --parallel 1` in the clone, then collects:
  - `measure` = `measureFromRow(landedRow(clone, feature))`;
  - `baseline` = `measureFromRow(original row)`;
  - `specLines` = the line count of `SPEC.md` at the last spec commit;
  - `planLines` = the most lines any committed version of `<registry>/<feature>/PLAN.md` had in the clone's history (ship condenses it away);
  - `status` = `done` with a landed row, else the fleet's `fleet.json` status and reason, as `bench.mjs`'s `fleetRecord` reads them.

  The `--dry-run` output lists the clone path, the base, the spec commits, the applied `agent_walk` lines, the files placed, and `setup`. Also export `disabledPlugins` from `bench.mjs`.

- [ ] **Step 4: Run** `node --test scripts/test/bench-case.test.mjs scripts/test/bench.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add scripts/bench-case.mjs scripts/bench.mjs scripts/test/bench-case.test.mjs scripts/test/fixtures/bench/stub-fleet-land.mjs && git commit -m "feat(bench): run one archived feature's spec again through the fleet in a scratch clone, on the builder under test"`

---

### Task 5: The suite — `scripts/bench-suite.mjs`

**Files:**
- Create: `scripts/bench-suite.mjs`
- Modify: `bench/features/{tags,share,edit}/feature.json` (create `tags/feature.json` as `{ "fixture": "notes" }`)
- Test: `scripts/test/bench-suite.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3 core; `bench-case.mjs` CLI (Task 4); `bench.mjs run <feature> --only builder`.
- Produces (CLI):
  - `list [--json]`: one `pickLabel` line per case, sorted by size, then id. Fixture cases come from `bench/features/*/feature.json`, which gains `size` and `covers` (`edit`: `xs`, "one small command, built in the chat"; `tags`: `sm`, "one app, one feature"; `share`: `md`, "two apps, slow suites"). Their project is `fixtures`, and their estimate comes from `estimateFromRuns` over the newest `bench/results/*-<feature>/runs.json`. Archived cases come from `$BENCH_LOCAL/cases/*.json` (estimate: the case file's `estimate`, else `estimateFromRow` of the original row).
  - `plan <id,…|--all|--budget 12h> [--lanes N] [--control <id,…>]`: prints the schedule review. It shows each lane's cases in order with start and end clock times from now, the estimated end time, the total cost, the cases skipped with their reasons, and the recommended controls when `--control` is not given. Then it runs each archived case's `--dry-run`. Any refusal prints the reasons and exits 2.
  - `run <same selection> [--lanes N] [--control …] --detach`: creates `bench/local/results/<YYYY-MM-DD-HHMM>-suite/suite.json` (`{ id, lanes, items: [{ id, lane, status, startedAt, endedAt, out }], pid }`) and runs detached. It prints `` `suite started detached (pid N) — <id> · /builder:benchmark --status` ``. A `--control` item first creates `$TMPDIR/bench-builder-main` (`git worktree add … main`, reused when present) and runs with `--builder` set to that worktree.
  - `run --resume <suite-id> --detach`: runs only the items whose status is not `done`/`failed:*`.
  - `status`: per lane, the running item and its elapsed time, then done, failed and waiting. When the pid is dead and items are unfinished, it prints `` `⚠ suite stopped mid-run — <n> unfinished; /builder:benchmark --resume <id> runs them` ``.
  - `report <suite-id>`: writes `$BENCH_SUITE_OUT/<YYYY-MM-DD>-suite/REPORT.md` (`names: false`) and `bench/local/results/<suite-id>/REPORT.md` (`names: true`). It runs automatically when the last lane ends.

- [ ] **Step 1: Write the failing tests** in `scripts/test/bench-suite.test.mjs`. Use tmp `BENCH_LOCAL`/`BENCH_SUITE_OUT`, and set `BENCH_CASE` → `scripts/test/fixtures/bench/stub-case.mjs` (new). The stub sleeps `STUB_CASE_MS` × the case's `estimate.minutes`, then writes `result.json` (status `done`, measure from the case's estimate). It also appends `start <id> <project> <t>` and `end <id> <t>` lines to `$STUB_STATE/case.log`.

```js
test('list shows fixtures and local cases with size and estimate', () => {
  const r = suite(['list'])
  assert.match(r.stdout, /^sm · tags — one app, one feature · /m)
  assert.match(r.stdout, /^md · c1 — x · ~30m · ~\$2$/m)
})
test('plan: --budget fits, refuses an unsafe case, recommends controls', () => {
  assert.match(suite(['plan', '--budget', '2h', '--lanes', '2']).stdout, /lane 1:.*\n.*ends ~\d\d:\d\d · ~\$/)
  writeCase('bad', { project: 'unsafe' })
  const r = suite(['plan', 'bad'])
  assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /not a bench database/)
})
test('run: two lanes, never two of one project at once, report at the end with no project names', async () => {
  // c1, c2 project A (30m, 10m); c3 project B (20m); STUB_CASE_MS=20 → 1 estimated minute = 20 ms
  suite(['run', 'c1,c2,c3', '--lanes', '2', '--detach'])
  await until(() => existsSync(join(out, todaySuite, 'REPORT.md')))
  const log = readLog()
  assert.ok(log.end('c1') <= log.start('c2'))          // same project, serialized
  assert.ok(log.start('c3') < log.end('c1'))           // other project, in parallel
  assert.doesNotMatch(readFileSync(join(out, todaySuite, 'REPORT.md'), 'utf8'), /projA|projB/)
})
test('the project mutex holds when a case runs long', async () => {
  // c1 (project A) estimated 1m, but STUB_CASE_LONG=c1 runs it 10x its estimate; c2 (project A) is packed on the other lane
  suite(['run', 'c1,c2', '--lanes', '2', '--detach'], { STUB_CASE_LONG: 'c1' })
  await until(() => existsSync(join(out, todaySuite, 'REPORT.md')))
  assert.ok(readLog().end('c1') <= readLog().start('c2'))
})
test('status after the suite process dies; --resume runs only the rest', async () => {
  suite(['run', 'c1,c2,c3', '--lanes', '1', '--detach'])
  await until(() => readLog().ended('c3'))              // c3 (20m) is packed after c1 (30m) → it ends second; kill then
  process.kill(suiteJson().pid, 'SIGKILL')
  const st = suite(['status']).stdout
  assert.match(st, /⚠ suite stopped mid-run — 1 unfinished; \/builder:benchmark --resume \S+ runs them/)
  suite(['run', '--resume', suiteJson().id, '--detach'])
  await until(() => existsSync(join(out, todaySuite, 'REPORT.md')))
  assert.equal(readLog().starts('c1'), 1); assert.equal(readLog().starts('c3'), 1); assert.equal(readLog().ends('c2'), 1)   // c2 may have started before the kill; it finishes exactly once
})
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-suite.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** `scripts/bench-suite.mjs`:
  - **Lanes** are async loops over their packed order. When an item ends with a dead case process and no `result.json`, its status is `failed: case process died`. Before starting an item, a lane awaits the project mutex (a Map of project → Promise); the packed order is the plan, and the mutex is the guarantee.
  - **Archived items** spawn `node $BENCH_CASE|scripts/bench-case.mjs <id> --builder <checkout> --out <suite>/<item id>`.
  - **Fixture items** spawn `node <checkout>/scripts/bench.mjs run <feature> --only builder` with cwd `<checkout>` (`$BENCH_FIXTURE_RUNNER` overrides the script). Their Result's measure is `measureFromRuns` of the newest `<checkout>/bench/results/*-<feature>/runs.json`, and their baseline is the previous one.
  - `suite.json` is rewritten after every state change.
  - **Detach and lock** follow `bench.mjs` (a `wx` lock at `bench/local/results/lock`; a dead holder's lock is cleared).

- [ ] **Step 4: Run** `node --test scripts/test/bench-suite.test.mjs scripts/test/bench.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add scripts/bench-suite.mjs scripts/test/bench-suite.test.mjs scripts/test/fixtures/bench/stub-case.mjs bench/features && git commit -m "feat(bench): the suite — a catalogue of sized cases, scheduled into lanes that fit a night, run detached, reported per case and per stage"`

---

### Task 6: The skill, the READMEs, the ignore rule

**Files:**
- Modify: `skills/benchmark/SKILL.md`, `bench/README.md`, `.gitignore`
- Create: `bench/local/README.md`

- [ ] **Step 1:** Add to `.gitignore`:

```
/bench/local/*
!/bench/local/README.md
```

  Verify: `git check-ignore bench/local/cases/x.json` prints the path; `git check-ignore bench/local/README.md` prints nothing.

- [ ] **Step 2:** `skills/benchmark/SKILL.md` gains these:
  - **Invocation**: `/builder:benchmark` with no feature means the picker; `<feature>` keeps today's fixture flow word for word; new flags `--all`, `--budget <h>`, `--lanes N`, `--control <ids>`, `--resume <suite-id>`.
  - **§Picker**:
    1. Run `node <builder>/scripts/bench-suite.mjs list --json`.
    2. Above the picker, in prose (one menu per screen): what each size bucket is for, and the recommended set — `plan --budget 12h`'s pick with its recommended controls — and why.
    3. One multi-select of every case, labelled with `pickLabel`.
    4. One question for options: lanes, controls, budget.
    5. Run `plan …` and show its schedule as a plain review, not a path.
    6. One **Run it** / **Not now**. On yes, `run … --detach` in the foreground.

    A `plan` exit 2 is shown as the reasons, and nothing launches.
  - **`--status`**: when a suite is running or newest, show `bench-suite.mjs status` (else today's `bench.mjs status`).
  - Footer: `▶ benchmark suite: <n> case(s) in <lanes> lanes, ends ~<time> — next: /builder:benchmark --status`.
  - **Never**: add "name a consuming project in anything committed".

- [ ] **Step 3:** `bench/README.md` gains a **Suite** section: the two kinds of case, sizes, lanes, baseline vs control, where results go. `bench/local/README.md` covers:
  - the case and profile file shapes, exactly as Tasks 2 and 4 define them;
  - an example of each with placeholder names (`project-a`, `bench_a_`);
  - the safety rules;
  - "adding a case is one file".

- [ ] **Step 4:** Run `node --test 'scripts/test/*.test.mjs'` — Expected: all pass, `skills-consistency` and `skills-budget` included. Run `node preview/preview.mjs --check` — Expected: no stage newly stale (the benchmark has no preview stage).

- [ ] **Step 5: Commit** — `git add .gitignore bench/README.md bench/local/README.md skills/benchmark/SKILL.md && git commit -m "feat(bench): /builder:benchmark picks from the suite's catalogue — sizes, estimates, a schedule review before one Run it"`

---

### Task 7: The first local catalogue, then stop for the human (operational, nothing committed)

- [ ] **Step 1:** For each local project with `.builder/fleet/archive.jsonl` rows, write `bench/local/projects/<project>.json`. Each profile needs:
  - its own `db_prefix`, and a bench database created with `createdb <db_prefix><name>` on the server the project already uses;
  - `agent_walk` overrides that point every database, port and container at bench ones;
  - a `verify` block reviewed from `node scripts/verify/migrate.mjs <repo>` and saved beside the profile;
  - the untracked files a run needs.

  Read the project; write nothing in it.
- [ ] **Step 2:** For each archived row with a merge commit, write `bench/local/cases/<project>-<feature>.json`. Its `size` comes from the feature's MANIFEST at its spec commit, and `covers` is one line from its SPEC's first paragraph.
- [ ] **Step 3:** Run `node scripts/bench-suite.mjs list` and `node scripts/bench-suite.mjs plan --budget 12h`. Expected: every case listed, and exit 0. Any refusal is fixed in its profile, never by loosening the check.
- [ ] **Step 4: Stop for the human.** Show, as a review in the CLI:
  - the catalogue by size;
  - the recommended 12 h set with controls;
  - the schedule, end time and cost.

  Ask Run it / Not now. Nothing launches before a yes.
