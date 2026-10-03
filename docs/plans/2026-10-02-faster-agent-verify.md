# Faster agent-mode verify — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ~15–25 minutes off every agent-run feature by making gate reuse visible, letting the agent walk cover verify's cross-app E2E walk, stopping baseline-failure triage, and measuring time per run.

**Architecture:** Two script changes (`gate.mjs` names dirty paths; the fleet records each run's duration and turns and shows them in `--status`) and skill-text changes (build writes an `E1…En` cross-app section into `walk.md` under `--agent-walk`; verify item 10 quotes the agent walk's report for those steps; verify and agent-walk treat at-baseline failures as green; init recon warns about tracked test output).

**Tech Stack:** Node ESM scripts (`node:test`, `node:assert/strict`), Markdown skills.

**Spec:** `docs/specs/2026-10-02-faster-agent-verify-design.md`

## Global Constraints

- No change to any config key's meaning, manifest field or record format; old folders and configs read as before.
- Human-walked features keep today's verify exactly — every agent-mode change is gated on `--agent-walk`.
- `isDirty` keeps its meaning (tracked files only; untracked ignored).
- Release: **4.6.0** (minor). Commits: `<area>(<scope>): <subject>`, lower case, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run tests with `node --test scripts/test/<file>.test.mjs`; the whole suite is `node --test scripts/test/*.test.mjs` (two timing-sensitive tests — `job.test.mjs` "wait gives up after --max", fleet "keeps talking outlives the idle timeout" — can flake under full-suite load; re-run their file alone before calling them red).

## Review Focus

1. **A dirty tree of many files** — the gate line lists five paths then `+N more`, never a wall of text (Task 1 test).
2. **A run killed by the timeout** — its timing row has wall-clock `ms` and `turns: null`, and the fleet still archives (Task 2 test).
3. **A feature built before this release** (no `timing` on its fleet row, no `E` section in `walk.md`) — `--status` renders `—` in the Time column; verify item 10 runs as today (Tasks 3 and 4).
4. **Code changed after the agent walk** (a fix commit after AGENT-PASS) — verify must not quote the walk's `E` steps for that code (Task 4 text, pinned by the consistency test).
5. **Several `result` events in one run's stream** (the CLI can emit one per turn in some modes) — the last one wins (Task 2 test via the CHATTY stub path, which emits two).

---

### Task 1: `gate.mjs` names the files that stop reuse

**Files:**
- Modify: `scripts/gates-core.mjs:124-125` (beside `isDirty`)
- Modify: `scripts/gate.mjs:113` and `:143`
- Test: `scripts/test/gates-core.test.mjs` (the `isDirty and mainRoot` test at :109, the gate.mjs dirty test at :205)

**Interfaces:**
- Produces: `dirtyPaths(root: string): string[]` — tracked files with local changes (staged or not), repo-relative; untracked files excluded. `fmtPaths(paths: string[], max = 5): string` — `a, b, c` or `a, b, c, d, e +2 more`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/gates-core.test.mjs`, add `dirtyPaths, fmtPaths` to the import from `'../gates-core.mjs'` (line 8), and add after the `isDirty and mainRoot` test:

```js
test('dirtyPaths lists modified tracked files, never untracked ones; fmtPaths caps the list', () => {
  const root = repo()
  assert.deepEqual(dirtyPaths(root), [])
  writeFileSync(join(root, 'package.json'), 'changed\n')
  writeFileSync(join(root, 'scratch.txt'), 'untracked\n')
  assert.deepEqual(dirtyPaths(root), ['package.json'])
  git(root, 'checkout', '--', 'package.json')
  assert.equal(fmtPaths(['a', 'b']), 'a, b')
  assert.equal(fmtPaths(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e +2 more')
})
```

In the test `gate.mjs: a red set is never quoted, exits 1, and a dirty tree is not memoised` (:205), replace its last assertion:

```js
  assert.match(dirty.stdout, /uncommitted: package\.json — not quoted, result not memoised/)
```

and append, still inside that test:

```js
  // Green and memoised on a clean tree, then dirtied: the quote is refused, and the line says why.
  git(root, 'checkout', '--', 'package.json')
  run(root, 'server')
  writeFileSync(join(root, 'package.json'), 'dirty again\n')
  const refused = run(root, 'server')
  assert.match(refused.stdout, /▶ server — fast at \w+ \(uncommitted: package\.json — not quoted, result not memoised\)/)
```

(If `git` is not already imported in that file's helpers, use the same `git(root, …)` helper the `isDirty and mainRoot` test uses.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/test/gates-core.test.mjs`
Expected: FAIL — `dirtyPaths` is not exported; the gate line still reads `tree has uncommitted changes`.

- [ ] **Step 3: Implement**

In `scripts/gates-core.mjs`, after `isDirty` (line 125):

```js
/** The tracked files with local changes, staged or not — what makes isDirty true. */
export const dirtyPaths = (root) => git(['diff', '--name-only', 'HEAD'], root).split('\n').filter(Boolean)

/** Paths for one line of output: the first `max`, then how many more. */
export const fmtPaths = (paths, max = 5) => paths.slice(0, max).join(', ') + (paths.length > max ? ` +${paths.length - max} more` : '')
```

In `scripts/gate.mjs`, add `dirtyPaths, fmtPaths` to its import from `./gates-core.mjs`, then replace line 113 (`const dirty = isDirty(ROOT)`) with:

```js
const dirtyList = dirtyPaths(ROOT)
const dirty = dirtyList.length > 0
```

and replace line 143 with:

```js
  console.log(`▶ ${set.label} at ${sha}${dirty ? ` (uncommitted: ${fmtPaths(dirtyList)} — not quoted, result not memoised)` : ''}`)
```

Remove `isDirty` from gate.mjs's import if nothing else in the file uses it.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test scripts/test/gates-core.test.mjs`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/gates-core.mjs scripts/gate.mjs scripts/test/gates-core.test.mjs
git commit -m "fix(gate): name the uncommitted files that stop a quote

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The fleet records each run's time and turns

**Files:**
- Modify: `scripts/fleet.mjs:531-608` (`runClaude`), `:642-656` (`archiveRow`)
- Modify: `scripts/fleet-core.mjs` (add `duration`, `laneTotals` near `ago`, line 187)
- Modify: `scripts/test/fixtures/stub-claude.mjs` (`finish` and the `CHATTY:` path)
- Test: `scripts/test/fleet.test.mjs` (the spec-to-merged test at :79, the idle-timeout test at :124), `scripts/test/fleet-core.test.mjs`

**Interfaces:**
- Produces on each fleet row: `fleet.features[f].timing: Array<{ n: number, lane: 'build'|'walk', ms: number, turns: number|null }>` — one entry per `runClaude` call, appended when the run settles.
- Produces in each archive row: `timing` (that array, `[]` when absent) and `lanes: { [lane]: ms }`.
- Produces in `fleet-core.mjs`: `duration(ms: number): string` → `45s`, `12m`, `1h12m`; `laneTotals(timing): { [lane]: number }`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/fleet-core.test.mjs`, add `duration, laneTotals` to the import (line 6) and add:

```js
test('duration is compact; laneTotals sums ms per lane', () => {
  assert.deepEqual([duration(45000), duration(12 * 60000), duration(72 * 60000)], ['45s', '12m', '1h12m'])
  assert.deepEqual(laneTotals([{ lane: 'build', ms: 1000 }, { lane: 'walk', ms: 500 }, { lane: 'build', ms: 250 }]), { build: 1250, walk: 500 })
  assert.deepEqual(laneTotals(undefined), {})
})
```

In `scripts/test/fleet.test.mjs`, in `a spec goes from spec to merged through the build, walk and ship lanes` (:79), after `assert.equal(a.runs, 8)`:

```js
  // Every run's time and turns, from the result event the stub prints (STUB_DURATION_MS, default 1000).
  assert.equal(a.timing.length, 8)
  assert.deepEqual(a.timing[0], { n: 1, lane: 'build', ms: 1000, turns: 3 })
  assert.deepEqual(a.lanes, { build: 5000, walk: 3000 })
```

In `a run that keeps talking outlives the idle timeout; a silent one does not` (:124), after the `timed out twice` assertion:

```js
  // A run killed by the timeout has no result event: wall-clock ms, turns null.
  const hung = r.fleet.features.t2.timing
  assert.equal(hung.length, 2)
  assert.ok(hung.every((t) => t.turns === null && t.ms >= 400), JSON.stringify(hung))
  // CHATTY prints two result events (its own, then finish's): the last one wins.
  assert.equal(r.archived.t1.timing[0].turns, 3)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/test/fleet-core.test.mjs scripts/test/fleet.test.mjs`
Expected: FAIL — `duration` not exported; `a.timing` undefined.

- [ ] **Step 3: Make the stub print a result event**

In `scripts/test/fixtures/stub-claude.mjs`, in `finish` (before `log(\`end …\`)`):

```js
  process.stdout.write(JSON.stringify({ type: 'result', result: `did ${step}`, duration_ms: Number(process.env.STUB_DURATION_MS) || 1000, num_turns: 3 }) + '\n')
```

In the `CHATTY:` block, change its result line to carry a different turn count, so "last wins" is observable:

```js
  process.stdout.write(JSON.stringify({ type: 'result', result: `did ${step}`, duration_ms: 1, num_turns: 1 }) + '\n')
```

(`finish`'s result repeats `did <step>`, which `readable` already de-duplicates against the last assistant text only; the CHATTY test asserts `did audited` appears once in the `.log` — if it now appears twice, make `finish` write `result: ''` instead and change `readable` (fleet.mjs:625-628) to return `''` for an empty result text.)

- [ ] **Step 4: Implement `duration` and `laneTotals`**

In `scripts/fleet-core.mjs`, after `ago` (line 194):

```js
/** Milliseconds as `45s`, `12m`, `1h12m`. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A feature's run timings summed per lane. */
export function laneTotals(timing) {
  const out = {}
  for (const t of timing ?? []) out[t.lane] = (out[t.lane] ?? 0) + t.ms
  return out
}
```

- [ ] **Step 5: Record timing in `runClaude`**

In `scripts/fleet.mjs` `runClaude`, before `const out = createWriteStream(log)` (inside the Promise):

```js
    const t0 = Date.now()
    let result = null // the last `result` event: { duration_ms, num_turns }
```

In the stdout `for (const line of lines)` loop, before `out.write(readable(line, seen))`:

```js
      if (line.includes('"type":"result"')) {
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'result') result = ev
        } catch {}
      }
```

In `finish`, before `save()`:

```js
      const timing = fleet.features[feature].timing ?? (fleet.features[feature].timing = [])
      timing.push({ n, lane: lane === 'walk' ? 'walk' : 'build', ms: result?.duration_ms ?? Date.now() - t0, turns: result?.num_turns ?? null })
```

(The stub's lanes are `build`/`walk`; the fleet's ship lane runs with `--no-dev-env` and is recorded as `build`, matching how the stub and `calls.log` already name it.)

- [ ] **Step 6: Carry it into the archive**

In `archiveRow` (fleet.mjs:642), add to the object passed to `appendArchive`, after `runsThisTime`:

```js
    timing: f.timing ?? [],
    lanes: laneTotals(f.timing),
```

and add `laneTotals` (and `duration`, used in Task 3) to the fleet.mjs import from `./fleet-core.mjs` (line 29).

Update the archive test at `fleet.test.mjs:1130` — its `deepEqual` lists every field; add `timing: [], lanes: {}` only if that test builds its row through `archiveRow` (run it: if it fails on the new fields, add them to the expected object).

- [ ] **Step 7: Run to verify they pass**

Run: `node --test scripts/test/fleet-core.test.mjs scripts/test/fleet.test.mjs`
Expected: PASS, 0 fail (re-run `fleet.test.mjs` alone if only the idle-timeout test fails under load).

- [ ] **Step 8: Commit**

```bash
git add scripts/fleet.mjs scripts/fleet-core.mjs scripts/test/fixtures/stub-claude.mjs scripts/test/fleet.test.mjs scripts/test/fleet-core.test.mjs
git commit -m "feat(fleet): record each run's time and turns, per lane in the archive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `--status` shows the time

**Files:**
- Modify: `scripts/fleet-core.mjs:268-310` (`renderStatus`), `:92` (STATUS.md writer)
- Modify: `scripts/fleet.mjs:87` (`--status`)
- Test: `scripts/test/fleet-core.test.mjs`

**Interfaces:**
- Consumes: `duration`, `laneTotals` (Task 2); rows' `timing`.
- Produces: `renderStatus(fleet, progress = null, last = null, now = Date.now(), recent = [])` — `recent` is up to five archive rows (oldest first, as `tailArchive` returns them).

- [ ] **Step 1: Write the failing test**

In `scripts/test/fleet-core.test.mjs`:

```js
test('renderStatus adds a Time column, and the mean per lane of recently landed features', () => {
  const out = renderStatus(
    {
      target: 'main',
      archived: 2,
      features: {
        a: { status: 'building', runs: 2, worktree: '/w/a', timing: [{ n: 1, lane: 'build', ms: 30 * 60000, turns: 9 }, { n: 2, lane: 'build', ms: 12 * 60000, turns: 4 }] },
        b: { status: 'queued', runs: 0, worktree: null },
      },
    },
    null,
    null,
    Date.now(),
    [{ feature: 'x', lanes: { build: 60 * 60000, walk: 30 * 60000 } }, { feature: 'y', lanes: { build: 40 * 60000, walk: 50 * 60000 } }]
  )
  assert.match(out, /\| Feature \| Status \| Runs \| Time \| Reason \| Worktree \|/)
  assert.match(out, /\| a \| building \| 2 \| 42m \| — \| yes \|/)
  assert.match(out, /\| b \| queued \| 0 \| — \| — \| — \|/)
  assert.match(out, /^last 2 landed, mean per lane: build 50m · walk 40m$/m)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/fleet-core.test.mjs`
Expected: FAIL — no `Time` column.

- [ ] **Step 3: Implement**

In `renderStatus`, change the signature to `(fleet, progress = null, last = null, now = Date.now(), recent = [])`. Replace the table header line with:

```js
    lines.push('', `| Feature | Status |${col} Runs | Time | Reason | Worktree |`, `|---|---|${prog ? '---|' : ''}---|---|---|---|`)
```

and the row line with:

```js
      const spent = f.timing?.length ? duration(f.timing.reduce((s, t) => s + t.ms, 0)) : '—'
      lines.push(`| ${cell(name)} | ${cell(f.status)} |${p} ${f.runs ?? 0} | ${spent} | ${cell(reason)} | ${f.worktree ? 'yes' : '—'} |`)
```

After the `archived` line is pushed (the `if (archived) lines.push(…)` line), add:

```js
  const timed = recent.filter((r) => r.lanes && Object.keys(r.lanes).length)
  if (timed.length) {
    const sums = {}
    for (const r of timed) for (const [lane, ms] of Object.entries(r.lanes)) sums[lane] = (sums[lane] ?? 0) + ms
    lines.push(`last ${timed.length} landed, mean per lane: ${Object.entries(sums).map(([lane, ms]) => `${lane} ${duration(ms / timed.length)}`).join(' · ')}`)
  }
```

Update the two callers to pass the last five rows: `fleet-core.mjs:92` →
`renderStatus(fleet, progress, tailArchive(root, 1)[0] ?? null, Date.now(), tailArchive(root, 5))` and `fleet.mjs:87` → `renderStatus(fleet, progressOf, tailArchive(ROOT, 1)[0] ?? null, Date.now(), tailArchive(ROOT, 5))`.

Existing `renderStatus` tests that match the old header (`| Feature | Status | Progress | Runs | Reason | Worktree |` at fleet-core.test.mjs:198-215 and the one at :121) gain the `Time` column: update their expected header and row strings to include `| Time |` and `| — |` (rows there have no `timing`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/test/fleet-core.test.mjs scripts/test/fleet.test.mjs`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet-core.mjs scripts/fleet.mjs scripts/test/fleet-core.test.mjs
git commit -m "feat(fleet): --status shows each feature's time and the recent mean per lane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The agent walk covers verify's E2E; at-baseline is green; init warns

**Files:**
- Modify: `skills/build/SKILL.md:217-221` (step 4, the walk script)
- Modify: `skills/agent-walk/SKILL.md:55-68` (§2 the brief)
- Modify: `skills/verify/SKILL.md:98-111` (item 3), `:133-136` (item 10)
- Modify: `skills/init/SKILL.md:35-58` (recon table) and its step 6 report section
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Produces (text contract shared by three skills): the `walk.md` heading `## Cross-app (verify E2E)` and step ids `E1…En`; report rows with `#` = `E<k>` and App = `cross-app`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test/skills-consistency.test.mjs`:

```js
test('agent mode: build writes the E steps, agent-walk reports them, verify quotes them only on unchanged code', () => {
  const HEAD = '## Cross-app (verify E2E)'
  const build = read('skills/build/SKILL.md')
  const walk = read('skills/agent-walk/SKILL.md')
  const verify = read('skills/verify/SKILL.md')
  for (const [name, s] of [['build', build], ['agent-walk', walk], ['verify', verify]]) assert.ok(s.includes(HEAD), `${name} names ${HEAD}`)
  assert.match(build, /--agent-walk[^\n]*\n?[^\n]*E1…En|E1…En[^\n]*--agent-walk/)
  assert.match(walk, /`E<k>`/)
  // Quoted only when no code changed since the agent walk's sha; otherwise only the uncovered steps run live.
  assert.match(verify, /git diff --quiet <walk sha> HEAD -- \. ':!<registry>'/)
  assert.match(verify, /only those steps/)
  // A gate at or under its baseline is green, in verify and in the walker's brief.
  for (const s of [verify, walk]) assert.match(s, /at or under its baseline/)
  // init recon names tracked test output.
  assert.match(read('skills/init/SKILL.md'), /test-results\//)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: FAIL — `build names ## Cross-app (verify E2E)`.

- [ ] **Step 3: Build step 4 — the E section**

In `skills/build/SKILL.md`, at the end of step 4 (after "The walk is the human's; no agent signs it."), add:

```markdown
   **Under `--agent-walk`**, append the cross-app walk after the per-app sections, so the agent walk
   runs it in the same live session and verify need not drive the app again (verify item 10):
   `## Cross-app (verify E2E)`, then SPEC §Testing's walk script as numbered steps `E1…En` — each
   one line of what to do and one of what to see, in the script's order. Without `--agent-walk`,
   `walk.md` stays per-app only.
```

- [ ] **Step 4: Agent-walk brief — E rows and the baseline rule**

In `skills/agent-walk/SKILL.md` §2, after the `the report:` bullet, add two bullets:

```markdown
- the `## Cross-app (verify E2E)` section of `walk.md`, when present, is walked like every other
  item: one report row per step, `#` = `E<k>`, App = `cross-app`, with its evidence. Verify quotes
  these rows instead of driving the app again, so an `E` row without evidence is a `FAIL`.
- any gate the walker runs: a line at or under its baseline (`→ 7 (baseline 7)`) is green — note
  the count and move on; never investigate failures that already fail on the base branch.
```

- [ ] **Step 5: Verify — item 3's baseline rule and item 10's agent-mode coverage**

In `skills/verify/SKILL.md` item 3, after "a `✗` is a finding.", add:

```markdown
   A line **at or under its baseline** (`→ 7 (baseline 7)`) is green: report it as `<n> = baseline
   <n>` and move on. Open a failure's log only when the set is red — above its baseline — and then
   only for the failures above it; the ones already failing on the base branch are not this
   feature's to explain.
```

Replace item 10's text with:

```markdown
10. **The cross-app E2E walk** — 🔴 the ONE place the pipeline exercises every app at once: §Testing's
    walk script, executed live. Can't bring the stack up → **BLOCKED-on-environment**, never READY.
    Mandatory on a feature's **first** verify; conditional on a re-verify — see §A re-verify is
    SCOPED, and quote the earlier run when the diff didn't earn a new one.
    **Under `--agent-walk`, the agent walk may already have covered it.** When `walk.md` has a
    `## Cross-app (verify E2E)` section, read the latest round's
    `.builder/<feature>/agent-walk/round-<n>/report.md`. Every `E<k>` row `PASS` with evidence, and
    no code changed since the manifest's `walk: agent-pass … <walk sha>` —
    `git diff --quiet <walk sha> HEAD -- . ':!<registry>'` exits 0 — → item 10 is **covered by the
    agent walk**: cite the report path and the sha, marked quoted. Any `E` row missing or not `PASS`,
    or code changed since → run **only those steps** live (all of them when code changed), as above.
    No such section (built before builder 4.6) → item 10 as written. A human walk never covers it.
```

- [ ] **Step 6: Init recon — tracked test output**

In `skills/init/SKILL.md` §2's recon table, add a row after `deep gates`:

```markdown
| tracked test output | `git ls-files` for `test-results/`, `playwright-report/`, `coverage/`, `.nyc_output/`, `junit*.xml`. A runner rewrites these on every run, the tree reads dirty, and `gate.mjs` never quotes a dirty tree — so every verify re-runs what the build already ran. List any found in the step 6 report with the fix (`git rm -r --cached <path>` and a `.gitignore` line); never untrack anything yourself |
```

In §6 (Report), add one line to what it reports: "tracked test output found in recon, with its fix — or nothing".

- [ ] **Step 7: Run to verify it passes**

Run: `node --test scripts/test/skills-consistency.test.mjs && claude plugin validate .`
Expected: PASS, 0 fail; `✔ Validation passed`.

- [ ] **Step 8: Commit**

```bash
git add skills/build/SKILL.md skills/agent-walk/SKILL.md skills/verify/SKILL.md skills/init/SKILL.md scripts/test/skills-consistency.test.mjs
git commit -m "feat(verify): the agent walk covers the cross-app E2E; at-baseline is green; init flags tracked test output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Release notes and version

**Files:**
- Modify: `.claude-plugin/plugin.json` (`"version": "4.5.0"` → `"4.6.0"`)
- Modify: `CHANGELOG.md` (new `## 4.6.0` above `## 4.5.0`)
- Modify: `skills/fleet/SKILL.md` — where it describes `--status`, one sentence: the table has a Time column and a mean per lane for the last five landed features.

- [ ] **Step 1: Write the CHANGELOG entry**

```markdown
## 4.6.0

**Faster agent-run features** — about 15–25 minutes less per feature, nothing weaker:

- **The agent walk covers verify's cross-app E2E walk.** Under the fleet, the build adds the spec's
  cross-app walk to `walk.md` as steps `E1…En`; the agent walk runs them in the session it already
  drives, and verify quotes that report instead of driving the app again — only when no code changed
  since, and only the steps it didn't cover run live. Human-walked features are unchanged.
- **Failures already failing on the base branch are not re-investigated.** A gate at or under its
  baseline is green; verify reports the count and moves on.
- **`gate.mjs` says why it didn't quote:** `uncommitted: test-results/.last-run.json — not quoted`.
  `/builder:init` now flags tracked test output (`test-results/`, `coverage/`, …), the usual cause.
- **Time per run.** The fleet records each run's duration and turns; the archive keeps them per lane,
  and `/builder:fleet --status` shows a Time column and the recent mean per lane.
```

- [ ] **Step 2: Bump the version and the fleet skill line**

Edit `plugin.json` and `skills/fleet/SKILL.md` as listed above.

- [ ] **Step 3: Full suite and validation**

Run: `node --test scripts/test/*.test.mjs; claude plugin validate .`
Expected: all pass (re-run any timing-sensitive failure's file alone — Global Constraints); `✔ Validation passed`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json CHANGELOG.md skills/fleet/SKILL.md
git commit -m "chore(release): 4.6.0 — faster agent-mode verify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
