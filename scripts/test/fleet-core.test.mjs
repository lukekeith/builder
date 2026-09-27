import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laneOf, decide, loadFleet, saveFleet, renderStatus, fleetDir, shippedPr, featureProgress, readProgress, progressBar } from '../fleet-core.mjs'

test('laneOf routes each state', () => {
  assert.equal(laneOf({ state: 'spec' }), 'build')
  assert.equal(laneOf({ state: 'building' }), 'build')
  assert.equal(laneOf({ state: 'building', ready: 'pending "dev env (fleet walk lane)"' }), 'walk')
  assert.equal(laneOf({ state: 'built' }), 'walk')
  assert.equal(laneOf({ state: 'signed-off' }), 'walk')
  assert.equal(laneOf({ state: 'verified' }), 'ship')
  assert.equal(laneOf({ state: 'verified', pr: '#3' }), 'ship')
  assert.equal(laneOf({ state: 'signed-off', pr: '#3' }), 'walk', 'a re-verify after CI fixes still needs the dev env')
  assert.equal(laneOf({ state: 'shipped' }), 'done')
  assert.equal(laneOf({ state: 'audited', blocked: '"x"' }), 'blocked')
  assert.equal(laneOf({ state: 'audited', blocked: 'none' }), 'build')
  assert.equal(laneOf({ state: 'weird' }), 'unknown')
})

const base = { lane: 'build', exit: 0, failures: 0, runs: 1, cap: 12, progressed: true }
const mf = (s) => `size: md\n${s}\nnext: x\n`

test('a failed run is retried once, then fails', () => {
  assert.deepEqual(decide({ ...base, exit: 3, manifestText: mf('state: spec') }), { action: 'retry' })
  const d = decide({ ...base, exit: 3, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /failed \(exit 3\) twice/)
})

test('a timeout counts as a failure', () => {
  const d = decide({ ...base, exit: null, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /timed out twice/)
})

test('blocked parks with the reason, unquoted', () => {
  const d = decide({ ...base, manifestText: mf('state: audited\nblocked: "plan wants to split"') })
  assert.deepEqual(d, { action: 'park', reason: 'plan wants to split' })
})

const SHIPPED = '# f — spec\n> ✅ SHIPPED 2026-09-26 — PR #7 · none · 🤖 agent signed off (round 1), not human-tested\n'

test('an open PR is not done — the ship lane takes it to merged', () => {
  assert.deepEqual(decide({ ...base, lane: 'ship', manifestText: mf('state: verified\npr: #7') }), { action: 'again' })
})

test('shipped — the manifest gone and the SPEC header SHIPPED — is done, with its PR', () => {
  assert.equal(shippedPr(SHIPPED), '#7')
  assert.equal(shippedPr('# f\n> ✅ SIGNED OFF 2026-09-26'), null)
  assert.equal(shippedPr('# f\n> ✅ SHIPPED 2026-09-26 — merged into main · none'), 'shipped')
  assert.deepEqual(decide({ ...base, lane: 'ship', manifestText: null, specText: SHIPPED }), { action: 'done', pr: '#7' })
})

test('a run that timed out after shipping still counts as done', () => {
  assert.deepEqual(decide({ ...base, lane: 'ship', exit: null, manifestText: null, specText: SHIPPED }), { action: 'done', pr: '#7' })
  assert.deepEqual(decide({ ...base, lane: 'ship', exit: 3, failures: 1, manifestText: null, specText: SHIPPED }), { action: 'done', pr: '#7' })
})

test('the walk lane hands off to the ship lane at verify READY', () => {
  assert.deepEqual(decide({ ...base, lane: 'walk', manifestText: mf('state: verified\nverify: READY 2026-09-26') }), { action: 'handoff', to: 'ship' })
})

test('the build lane hands off once the feature needs the dev env', () => {
  const d = decide({ ...base, manifestText: mf('state: building\nready: pending "dev env (fleet walk lane)"') })
  assert.deepEqual(d, { action: 'handoff', to: 'walk' })
})

test('a first run with no progress runs again; a second in a row parks', () => {
  assert.deepEqual(decide({ ...base, progressed: false, manifestText: mf('state: planned') }), { action: 'stalled' })
  const d = decide({ ...base, progressed: false, stalls: 1, manifestText: mf('state: planned') })
  assert.equal(d.action, 'park')
  assert.match(d.reason, /no progress/)
})

test('the run cap parks', () => {
  const d = decide({ ...base, runs: 12, manifestText: mf('state: planned') })
  assert.deepEqual(d, { action: 'park', reason: 'run cap (12) reached' })
})

test('progress under the cap runs again', () => {
  assert.deepEqual(decide({ ...base, manifestText: mf('state: planned') }), { action: 'again' })
})

test('a missing manifest or unknown state parks', () => {
  assert.equal(decide({ ...base, manifestText: null }).action, 'park')
  assert.match(decide({ ...base, manifestText: mf('state: weird') }).reason, /weird/)
})

test('saveFleet writes fleet.json atomically, STATUS.md, and the .builder ignore', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const fleet = {
    features: {
      b: { status: 'parked', runs: 2, branch: 'builder/b', worktree: '/w/b', pr: null, reason: 'x | y' },
      a: { status: 'done', runs: 7, branch: 'builder/a', worktree: '/w/a', pr: '#1', reason: null },
    },
    notes: ['No agent_walk.reset — dev-DB state accumulates from one walk to the next.'],
  }
  saveFleet(root, fleet)
  assert.deepEqual(loadFleet(root), fleet)
  assert.equal(existsSync(join(fleetDir(root), 'fleet.json.tmp')), false)
  assert.equal(readFileSync(join(root, '.builder/.gitignore'), 'utf8'), '*\n')
  const status = readFileSync(join(fleetDir(root), 'STATUS.md'), 'utf8')
  assert.match(status, /2 feature\(s\): 1 done · 1 parked|2 feature\(s\): 1 parked · 1 done/)
  assert.ok(status.indexOf('| a |') < status.indexOf('| b |'), 'rows sorted by feature')
  assert.match(status, /x \\\| y/, 'pipes escaped')
  assert.match(status, /- No agent_walk.reset/)
})

test('loadFleet on a fresh repo is empty', () => {
  assert.deepEqual(loadFleet(mkdtempSync(join(tmpdir(), 'fc-'))), { features: {} })
})

test('renderStatus with nothing in it', () => {
  assert.match(renderStatus({ features: {} }), /0 feature\(s\): none/)
})

test('renderStatus keeps only informative columns, names the target and the worktree root once', () => {
  const out = renderStatus({
    target: 'main',
    features: {
      a: { status: 'building', runs: 2, worktree: '/w/root/a', reason: null, pr: null },
      b: { status: 'done', runs: 3, worktree: null, reason: null, pr: '#7' },
    },
    notes: ['a note'],
  })
  assert.match(out, /^# builder fleet — 2 feature\(s\): 1 building · 1 done\n\nmerges into \*\*main\*\* · worktrees under \/w\/root\n/)
  assert.match(out, /\| Feature \| Status \| Runs \| Reason \| Worktree \|/)
  assert.doesNotMatch(out, /Evidence|\| PR \|/)
  assert.match(out, /\| a \| building \| 2 \| — \| yes \|/)
  assert.match(out, /\| b \| done \| 3 \| PR #7 \| — \|/)
  assert.match(out, /- a note$/m)
})

// ---- progress: how far along the pipeline a feature is -------------------------------------

const PLAN = '## Phases\n\n| Phase | App | Tasks | Goal | Gates |\n|---|---|---|---|---|\n| 1 | app | 1–4 | x | y |\n\n### Task 1: a\n\n### Task 2: b\n\n### Task 3: c\n\n### Task 4: d\n'
const LEDGER = '# builder ledger — plan: docs/features/a/PLAN.md\n\n- Task 1: dispatched (BASE 1, sonnet)\n- Task 1: complete (commits 1..2, review clean)\n- Task 2: fix round 1/5 (1 addressed)\n- Task 2: complete (commits 2..3, review clean)\n- Phase 1 (app): closed — gates ok · 3\n- Task 3: dispatched (BASE 3, sonnet)\n'

test('featureProgress: each pipeline stage has a floor, the build stage scales with ledger tasks', () => {
  const at = (state, extra = '') => featureProgress({ status: 'building', manifestText: `size: md\nstate: ${state}\n${extra}next: x\n` })
  assert.deepEqual(at('spec'), { pct: 0, label: 'spec' })
  assert.deepEqual(at('aligned'), { pct: 5, label: 'aligned' })
  assert.deepEqual(at('audited'), { pct: 10, label: 'audited' })
  assert.deepEqual(at('planned'), { pct: 15, label: 'planned' })
  assert.deepEqual(at('built'), { pct: 75, label: 'built' })
  assert.deepEqual(at('built', 'walk: agent-pass 2026-09-27 abc\n'), { pct: 78, label: 'walked' })
  assert.deepEqual(at('signed-off'), { pct: 80, label: 'signed-off' })
  assert.deepEqual(at('verified'), { pct: 90, label: 'verified' })
  assert.deepEqual(at('verified', 'pr: #4\n'), { pct: 95, label: 'PR open' })
  assert.deepEqual(at('shipped'), { pct: 100, label: 'shipped' })
})

test('featureProgress: building counts ledger tasks against the plan', () => {
  const mf = 'size: md\nstate: building\nnext: x\n'
  assert.deepEqual(featureProgress({ status: 'building', manifestText: mf, planText: PLAN, ledgerText: LEDGER }), { pct: 43, label: 'build 2/4' })
  assert.deepEqual(featureProgress({ status: 'building', manifestText: mf, planText: PLAN, ledgerText: null }), { pct: 15, label: 'build 0/4' })
  assert.deepEqual(featureProgress({ status: 'building', manifestText: mf, planText: null, ledgerText: null }), { pct: 15, label: 'build' })
  const allDone = LEDGER + '- Task 3: complete (x)\n- Task 4: complete (x)\n'
  assert.deepEqual(featureProgress({ status: 'building', manifestText: mf, planText: PLAN, ledgerText: allDone }), { pct: 70, label: 'build 4/4' })
  const readyPending = 'size: md\nstate: building\nready: pending "dev env (fleet walk lane)"\nnext: x\n'
  assert.deepEqual(featureProgress({ status: 'walking', manifestText: readyPending, planText: PLAN, ledgerText: allDone }), { pct: 72, label: 'walk readiness' })
})

test('featureProgress: the fleet status wins when it is final or nothing has been read', () => {
  assert.deepEqual(featureProgress({ status: 'done', manifestText: 'size: md\nstate: verified\n' }), { pct: 100, label: 'merged' })
  assert.deepEqual(featureProgress({ status: 'done', manifestText: null }), { pct: 100, label: 'merged' })
  assert.deepEqual(featureProgress({ status: 'queued', manifestText: null }), { pct: 0, label: '—' })
  assert.deepEqual(featureProgress({ status: 'parked', manifestText: 'size: md\nstate: audited\nblocked: "x"\n' }), { pct: 10, label: 'audited' })
  assert.deepEqual(featureProgress({ status: 'failed', manifestText: 'size: md\nstate: weird\n' }), { pct: 0, label: 'weird' })
})

test('progressBar renders ten cells and the percentage', () => {
  assert.equal(progressBar(0), '░░░░░░░░░░ 0%')
  assert.equal(progressBar(43), '▓▓▓▓░░░░░░ 43%')
  assert.equal(progressBar(100), '▓▓▓▓▓▓▓▓▓▓ 100%')
})

test('readProgress reads the manifest, plan and ledger from a worktree', () => {
  const wt = mkdtempSync(join(tmpdir(), 'fc-wt-'))
  mkdirSync(join(wt, 'docs/features/a'), { recursive: true })
  writeFileSync(join(wt, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: building\nnext: x\n')
  writeFileSync(join(wt, 'docs/features/a/PLAN.md'), PLAN)
  mkdirSync(join(wt, '.builder/a'), { recursive: true })
  writeFileSync(join(wt, '.builder/a/progress.md'), LEDGER)
  assert.deepEqual(readProgress(wt, 'docs/features', 'a', 'building'), { pct: 43, label: 'build 2/4' })
  assert.deepEqual(readProgress(join(wt, 'nowhere'), 'docs/features', 'a', 'queued'), { pct: 0, label: '—' })
})

test('renderStatus adds a Progress column and an overall bar when given a progress reader', () => {
  const progress = (name) => ({ a: { pct: 43, label: 'build 2/4' }, b: { pct: 100, label: 'merged' } })[name]
  const out = renderStatus(
    {
      target: 'main',
      features: {
        a: { status: 'building', runs: 2, worktree: '/w/root/a', reason: null, pr: null },
        b: { status: 'done', runs: 3, worktree: null, reason: null, pr: null },
      },
    },
    progress
  )
  assert.match(out, /^# builder fleet — 2 feature\(s\): 1 building · 1 done · ▓▓▓▓▓▓▓░░░ 72%\n/)
  assert.match(out, /\| Feature \| Status \| Progress \| Runs \| Reason \| Worktree \|/)
  assert.match(out, /\| a \| building \| ▓▓▓▓░░░░░░ 43% · build 2\/4 \| 2 \| — \| yes \|/)
  assert.match(out, /\| b \| done \| ▓▓▓▓▓▓▓▓▓▓ 100% · merged \| 3 \| — \| — \|/)
})

test('renderStatus without a progress reader keeps the old columns', () => {
  const out = renderStatus({ features: { a: { status: 'queued', runs: 0 } } })
  assert.doesNotMatch(out, /Progress|%/)
})
