# Fleet token cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fleet build session starts on `/builder:build` with a compact fleet bundle and lets one `dispatch.mjs next` call do the per-task bookkeeping — plus four fixes the benchmark needs to measure it honestly.

**Architecture:** `docs.mjs` gains a `fleet-build` bundle and a `section` verb; `fleet.mjs` picks the build-lane prompt from the manifest's state; `dispatch.mjs` gains a `next` verb that wraps `advance.mjs --ledger`, `verify.mjs request` and the existing `implementer` / `task-review` renders; the build skill text routes to both under the fleet. Separately, `bench-case.mjs` gains `--replan`, the verifier reaps processes a run left in its checkout, and a case's verifier checkouts go with its clone.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, git CLI; no dependencies.

**Spec:** `docs/specs/2026-10-31-fleet-token-cuts-design.md`

## Global Constraints

- A human `/builder:build` (no `BUILDER_FLEET_DIR` in the environment) behaves exactly as today: same bundle, same steps.
- The `fleet-build` bundle is **at most 30,000 characters, not counting the project config it ends with** (the config is the project's, not builder's — Ruling, see below). It prints the config once.
- What a build does is unchanged: the task loop, reviews, fix rounds, verifier tiers, the ledger line formats and the plan format (spec D3).
- Under the fleet, the orchestrator turns per task target: one for bookkeeping (`dispatch.mjs next`) and one Agent call.
- No consuming project's name in anything committed.
- Ruling (spec: "at most 30,000 characters"): measured against builder's own text; a project config varies from 1k to 15k and is outside builder's control — if wrong, a large config pushes one Bash output over the cap and the model reads it from the tool-output file, as today.

## Review Focus

1. **A fleet build lane on a feature that is not yet planned** (state `spec`/`aligned`/`audited`) must still start on `/builder:resume` — real fleets audit and plan in the same lane. Tested in Task 2.
2. **`dispatch.mjs next` run twice after a crash or `/clear`** must not write the ledger line twice or file a second commit-tier request for the same sha. Tested in Task 3.
3. **The last task of a phase** — `next --close N` must not render task N+1's brief across a phase boundary; it says the phase closes. Tested in Task 3.
4. **A test plan with no task review** (`review=app` / none) — `next --after-implement N` must go straight to the close, with the "no task review" ledger line. Tested in Task 3.
5. **A process the verifier must not reap** — one whose cwd is outside the checkout, or this process's own group. Tested in Task 6.

---

### Task 1: The `fleet-build` bundle and the `section` verb

**Files:**
- Modify: `scripts/docs.mjs` (`STEPS`, the CLI)
- Test: `scripts/test/docs.test.mjs`

**Interfaces:**
- Produces: `STEPS['fleet-build']`; CLI `node docs.mjs fleet-build` (bundle) and `node docs.mjs section <file> "<heading>"` (one section, printed as the bundles print it, exit 1 naming it when missing).

- [ ] **Step 1: Write the failing tests**

```js
test('fleet-build fits one Bash output: ≤ 30,000 chars before the config, config printed once', () => {
  const out = run(['fleet-build'])
  const [builderText] = out.split(/^--- .*builder\.md/m)
  assert.ok(builderText.length <= 30000, `${builderText.length} chars`)
  assert.equal((out.match(/^--- .*\.claude\/builder\.md/gm) ?? []).length, 1)
})
test('fleet-build carries the loop and the rules a fleet build needs', () => {
  const out = run(['fleet-build'])
  for (const h of ['§The task loop', '§The verifier', '§PLAN.md', '§Contract and the contract freeze', '§`--agent-walk`']) assert.match(out, new RegExp(h.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')))
  for (const h of ['§SPEC.md', '§MANIFEST.md', '§Walk readiness']) assert.doesNotMatch(out, new RegExp(`--- .*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`))
})
test('section prints one heading, and fails naming a missing one', () => {
  assert.match(run(['section', 'skills/build/SKILL.md', 'When the last phase signs']), /When the last phase signs/)
  const r = runRaw(['section', 'skills/build/SKILL.md', 'No such heading'])
  assert.equal(r.status, 1); assert.match(r.stderr, /No such heading/)
})
test('build (the human bundle) is unchanged', () => assert.deepEqual(STEPS.build, BUILD_BEFORE))  // BUILD_BEFORE: today's list, copied into the test
```

- [ ] **Step 2: Run** `node --test scripts/test/docs.test.mjs` — Expected: the four new tests FAIL.

- [ ] **Step 3: Implement.** `STEPS['fleet-build']` = EXECUTION.md's §Setup through §The task loop (its subsections 1–5) · REFERENCE §Contract and the contract freeze · §PLAN.md · §The verifier · AGENT-MODE.md §`--agent-walk` · CONFIG. If that exceeds 30,000, the sections left for the step that needs them — fetched with `section` — are, in this order: EXECUTION §The final whole-branch review, §Finish, §Common rationalizations, §Model selection. Add the comment line naming the skill line it comes from (Task 4 writes it). `section <file> "<heading>"` uses the existing `mdSection`.

- [ ] **Step 4: Run** `node --test scripts/test/docs.test.mjs scripts/test/docs-drift.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(docs): a fleet-build bundle under 30k characters, and docs.mjs section for the step-only parts`

---

### Task 2: The build lane starts on `/builder:build` when the feature is planned

**Files:**
- Modify: `scripts/fleet.mjs` (`runClaude` default prompt, ~:727)
- Test: `scripts/test/fleet.test.mjs` (the stub claude records each session's prompt)

**Interfaces:**
- Produces: `buildLanePrompt(state, { spec, target, walkLane, prior }) → string` exported from `scripts/fleet-core.mjs`.

- [ ] **Step 1: Write the failing tests** (fleet-core unit, plus one fleet run):

```js
test('a planned or building feature starts the build lane on /builder:build', () => {
  for (const state of ['planned', 'building'])
    assert.equal(buildLanePrompt(state, { spec: 'docs/features/f', target: 'main' }), '/builder:build --path docs/features/f --agent-walk --into main --no-dev-env')
})
test('a feature not yet planned still starts on /builder:resume', () => {
  for (const state of ['spec', 'aligned', 'audited'])
    assert.match(buildLanePrompt(state, { spec: 'docs/features/f', target: 'main' }), /^\/builder:resume --path docs\/features\/f --agent-walk --into main --no-dev-env/)
})
```
  And in `fleet.test.mjs`: a fixture feature at `state: planned` with a go-ahead → the stub's first build-lane prompt starts `/builder:build`.

- [ ] **Step 2: Run** `node --test scripts/test/fleet-core.test.mjs` — Expected: FAIL (no export).

- [ ] **Step 3: Implement** `buildLanePrompt` in fleet-core (the walk lane and `priorPark` suffixes keep today's spelling); `runClaude`'s default uses it with the manifest's `state:` read the way fleet.mjs already reads the manifest for that feature. Walk and closing prompts are unchanged.

- [ ] **Step 4: Run** `node --test scripts/test/fleet-core.test.mjs` and `node --test --test-concurrency=2 scripts/test/fleet.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(fleet): a planned feature's build lane starts on /builder:build, not /builder:resume`

---

### Task 3: `dispatch.mjs next` — the bookkeeping in one call

**Files:**
- Modify: `scripts/dispatch.mjs`
- Test: `scripts/test/dispatch.test.mjs`

**Interfaces:**
- Consumes: today's `implementer` and `task-review` renders in dispatch.mjs; `advance.mjs <folder> --ledger "<line>"`; `verify.mjs request <worktree> HEAD --tier commit` and `verify.mjs verdict <branch>` (spawned, as the skill runs them today).
- Produces (CLI):
  - `dispatch.mjs next <folder> --after-implement N` → when the test plan reviews tasks: renders task N's review (as `task-review --task N`) and prints its Agent call. When it does not: does the close below with the line `Task N: complete (commits <base7>..<head7>, no task review (tests: review=<v>))`.
  - `dispatch.mjs next <folder> --close N --ledger "<line>"` → appends the ledger line (skipped, printing `already applied`, when the ledger already has a `Task N: complete` line); files the commit-tier request (skipped when a request for HEAD's sha exists); prints `verify.mjs verdict`'s output verbatim; then renders task N+1's implementer brief and prints its Agent call — or, when N is the last task of its phase, prints `phase <P> closes — build §Phase close` and renders nothing.
  - Exit 0; exit 2 on usage. Each part idempotent, so a re-run after a crash finishes what is missing.

- [ ] **Step 1: Write the failing tests** (use the existing dispatch test fixture workspace and a stub `verify.mjs` via the env var the tests already use, or add `BUILDER_VERIFY_BIN`):

```js
test('next --close writes the ledger, files the request, prints the verdict and the next Agent call', () => {
  const r = next(['--close', '1', '--ledger', 'Task 1: complete (commits aaaaaaa..bbbbbbb, review clean)'])
  assert.equal(r.status, 0)
  assert.match(ledger(), /^Task 1: complete \(commits aaaaaaa\.\.bbbbbbb, review clean\)$/m)
  assert.equal(stubCalls('request').length, 1)
  assert.match(r.stdout, /task-2-brief\.md/); assert.match(r.stdout, /Read .* and do what it says/)
})
test('next --close run twice writes one ledger line and one request', () => {
  next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  const r = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  assert.equal((ledger().match(/^Task 1: complete/gm) ?? []).length, 1)
  assert.equal(stubCalls('request').length, 1); assert.match(r.stdout, /already applied/)
})
test('next --close on the last task of a phase renders no brief across the boundary', () => {
  const r = next(['--close', String(lastTaskOfPhase1), '--ledger', `Task ${lastTaskOfPhase1}: complete (commits a..b, review clean)`])
  assert.match(r.stdout, /^phase 1 closes — build §Phase close$/m); assert.doesNotMatch(r.stdout, /task-\d+-brief\.md/)
})
test('next --after-implement renders the review when the test plan reviews tasks', () => {
  assert.match(next(['--after-implement', '1']).stdout, /task-1-review/)
})
test('next --after-implement closes with the no-review line when the test plan sets none', () => {
  setTests('review=app')
  const r = next(['--after-implement', '1'])
  assert.match(ledger(), /^Task 1: complete \(commits \w+\.\.\w+, no task review \(tests: review=app\)\)$/m)
  assert.match(r.stdout, /task-2-brief\.md/)
})
```

- [ ] **Step 2: Run** `node --test scripts/test/dispatch.test.mjs` — Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `next` in dispatch.mjs by calling the existing render functions and spawning `advance.mjs` / `verify.mjs` with the same arguments EXECUTION §5 names. The phase boundary comes from the plan's phase table (the same source `--phase` uses).

- [ ] **Step 4: Run** `node --test scripts/test/dispatch.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(dispatch): next — the ledger line, the commit-tier request, the verdict and the next brief in one call`

---

### Task 4: The build skill under the fleet uses both

**Files:**
- Modify: `skills/build/SKILL.md` (the opening "Read it first" paragraph; §When the last phase signs entry), `skills/build/EXECUTION.md` (§1 Dispatch, §3 the task-review render, §5 Complete the task), `skills/resume/AGENT-MODE.md` (the env row, ~:73)
- Test: `scripts/test/skills-consistency.test.mjs`, `scripts/test/skills-budget.test.mjs`, `node preview/preview.mjs --check`

- [ ] **Step 1: Edit SKILL.md.** After the `docs.mjs build` sentence add: under the fleet (`BUILDER_FLEET_DIR` is set) read `node <builder>/scripts/docs.mjs fleet-build` instead; the sections it leaves out are read with `docs.mjs section` at the step that needs them — name them, as Task 1 settled. At §When the last phase signs: under the fleet, first `docs.mjs section skills/build/SKILL.md "When the last phase signs"` if not already in context.
- [ ] **Step 2: Edit EXECUTION.md.** §1, §3 and §5 gain one paragraph each: under the fleet, after an implementer reports run `dispatch.mjs next <folder> --after-implement N`; after a clean review (or a parked one) run `dispatch.mjs next <folder> --close N --ledger "<line>"` — it writes the ledger line, files the commit-tier request, prints the verdict and the next Agent call; act on a regression in the printed verdict exactly as §5 says. The human path's text stays as it is.
- [ ] **Step 3: Edit AGENT-MODE.md row ~:73** to match the build skill's env-broken rule (commit 760e8a9): a dev env or verifier env that won't come up is worked once the config's way and re-requested; env-broken twice parks with the verifier's reason. Keep "never a park" for conflicts, red verdicts, failed walks and stalls.
- [ ] **Step 4: Verify** — `node --test scripts/test/skills-consistency.test.mjs scripts/test/skills-budget.test.mjs scripts/test/docs-drift.test.mjs` PASS; `node preview/preview.mjs --check` — rewrite and `--stamp` any stage these edits made stale (preview/README.md).
- [ ] **Step 5: Commit** — `feat(build): under the fleet the build reads the fleet-build bundle and closes each task with dispatch.mjs next; agent mode parks after a second env-broken`

---

### Task 5: `bench-case --replan`

**Files:**
- Modify: `scripts/bench-case.mjs` (`specCommits` caller / `planCase`), `scripts/bench-suite.mjs` (pass-through, suite.json, report header)
- Test: `scripts/test/bench-case.test.mjs`, `scripts/test/bench-suite.test.mjs`

**Interfaces:**
- Produces: `replanCommits(repo, registry, feature, specs) → string[]` — the longest prefix of `specs` after which `<registry>/<feature>/MANIFEST.md`'s `state:` is `spec` or `aligned`; `[]` when none. CLI flag `--replan` on bench-case and on `bench-suite.mjs plan|run`; suite.json `replan: true`; both report headers say `re-planned: the fleet audited and planned each case`.

- [ ] **Step 1: Write the failing tests:**

```js
test('replanCommits stops before the audit', () => {
  // fixture spec commits: spec (state: spec) → audited (state: audited) → plan (state: planned)
  assert.deepEqual(replanCommits(repo, 'docs/features', 'f', specs), [specs[0]])
})
test('--replan starts the fleet before the audit and the result says so', () => {
  const r = run(['c1', '--builder', REPO, '--out', out, '--replan'])
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(cloneAtStart, 'docs/features/f/PLAN.md')))   // stub fleet records the tree it started on
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).replan, true)
})
test('--replan with no pre-audit spec commit is a prep failure, not a crash', () => {
  // fixture whose first spec commit is already audited
  assert.match(result().status, /^failed: --replan: no spec commit before the audit/)
})
```

- [ ] **Step 2: Run** `node --test scripts/test/bench-case.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement**; the baseline row is unchanged (it measured a run that may have started later — the report header line is the caveat).
- [ ] **Step 4: Run** `node --test scripts/test/bench-case.test.mjs scripts/test/bench-suite.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(bench): --replan — a case starts before its audit, so the fleet audits and plans it with the builder under test`

---

### Task 6: The verifier reaps what a run left in its checkout

**Files:**
- Modify: `scripts/verify/run.mjs` (after each `runShell` in a run, and on timeout/cancel)
- Test: `scripts/test/verify-run.test.mjs`

**Interfaces:**
- Produces: `reapStrays(dir) → number[]` (pids signalled) in run.mjs: every process whose cwd is `dir` or under it (`lsof -nP -d cwd -Fpn`), never this process or its parent; SIGTERM, then SIGKILL after 3 s for any still alive. No `lsof` → `[]`.

- [ ] **Step 1: Write the failing tests:**

```js
test('a suite that leaves a detached server in the checkout: the run reaps it', async () => {
  // suite command: node -e "spawn('sleep',['60'],{cwd:process.cwd(),detached:true,stdio:'ignore'}).unref()"; then exits 0
  const { pid } = await runSuiteLeavingSleep(checkout)
  assert.equal(alive(pid), false)
})
test('reapStrays never touches a process outside the checkout', () => {
  const outside = spawnSleep(tmpdir())
  reapStrays(checkout)
  assert.equal(alive(outside.pid), true); outside.kill()
})
```

- [ ] **Step 2: Run** `node --test scripts/test/verify-run.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement**; call `reapStrays(cwd)` after every suite/check run in a checkout (success, red, timeout and cancel alike).
- [ ] **Step 4: Run** `node --test scripts/test/verify-run.test.mjs scripts/test/verify-serve.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(verify): a run reaps what its suites left running in the checkout — a playwright webServer outlived the timeout by hours`

---

### Task 7: A case's verifier checkouts go with its clone

**Files:**
- Modify: `scripts/bench-case.mjs` (`removeClone`, ~:647)
- Test: `scripts/test/bench-case.test.mjs`

- [ ] **Step 1: Write the failing test:** after a stub case whose fleet stub creates `<clone>-verify/co/0/x` and starts a detached `sleep` with that cwd, `removeClone` leaves no `<clone>-verify` and the sleep is dead; a `sleep` outside the clone survives.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement:** `removeClone` reaps (with `reapStrays` from Task 6, imported) under `clone`, `${clone}.fleet` and `${clone}-verify`, then removes all three; `BENCH_KEEP_CLONES` keeps all three.
- [ ] **Step 4: Run** `node --test scripts/test/bench-case.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(bench): a case's verifier checkouts and what runs in them go with its clone`

---

### Task 8: Measure (operational — stop for the human)

- [ ] **Step 1:** `node scripts/bench-suite.mjs plan a19,b03,d03,a26 --replan --lanes 3` — dry runs ok; show the schedule as a review.
- [ ] **Step 2: Stop for the human:** Run it / Not now. On yes, `run … --replan --detach`.
- [ ] **Step 3:** When it finishes, compare per case against `2026-10-30-1821-suite`: build orchestrator summed context (≥ 40% lower), its turns (≥ 30% lower), landed / fix rounds / final-review findings (no worse), and the new audit and plan stage times. Note that `--replan` adds audit and plan to this run, so compare the build session, not the case wall.
