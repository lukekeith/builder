import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { specBringIn, laneOf, decide, loadFleet, saveFleet, renderStatus, fleetDir, shippedPr, featureProgress, readProgress, progressBar, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, ago, renderArchived, parkParts, duration, laneTotals, tokensOf, formatTokens, landedRow } from '../fleet-core.mjs'

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
  assert.deepEqual(d, { action: 'park', reason: 'run cap (12) reached while still making progress — next: /builder:agent to retry with a fresh cap' })
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
  assert.match(status, /# builder fleet — 1 feature\(s\): 1 parked/)
  assert.match(status, /^1 archived · \/builder:fleet:status --archived for the latest 20$/m, 'a done row is counted, not listed')
  assert.doesNotMatch(status, /\| a \|/)
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
  assert.match(out, /^# builder fleet — 1 feature\(s\): 1 building\n\nmerges into \*\*main\*\* · worktrees under \/w\/root\n\n1 archived · \/builder:fleet:status --archived for the latest 20\n/)
  assert.match(out, /\| Feature \| Status \| Tests \| Runs \| Time \| Reason \| Worktree \|/)
  assert.doesNotMatch(out, /Evidence|\| PR \|/)
  assert.match(out, /\| a \| building \| — \| 2 \| — \| — \| yes \|/)
  assert.doesNotMatch(out, /\| b \|/)
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
  // The build writes `state: building` only when a phase closes, so a plan mid-first-phase still says
  // `planned` while its ledger fills — the ledger wins whenever it has a completed task.
  const planned = 'size: md\nstate: planned\ngo-ahead: auto\nnext: x\n'
  assert.deepEqual(featureProgress({ status: 'building', manifestText: planned, planText: PLAN, ledgerText: LEDGER }), { pct: 43, label: 'build 2/4' })
  assert.deepEqual(featureProgress({ status: 'building', manifestText: planned, planText: PLAN, ledgerText: null }), { pct: 15, label: 'planned' })
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
  // b merged: it counts at 100% in the bar, so the run reads (43 + 100) / 2
  assert.match(out, /^# builder fleet — 2 feature\(s\): 1 merged this run · 1 building · ▓▓▓▓▓▓▓░░░ 72%\n/)
  assert.match(out, /\| Feature \| Status \| Tests \| Progress \| Runs \| Time \| Reason \| Worktree \|/)
  assert.match(out, /\| a \| building \| — \| ▓▓▓▓░░░░░░ 43% · build 2\/4 \| 2 \| — \| — \| yes \|/)
  assert.doesNotMatch(out, /\| b \|/)
})

test('renderStatus without a progress reader keeps the old columns', () => {
  const out = renderStatus({ features: { a: { status: 'queued', runs: 0 } } })
  assert.doesNotMatch(out, /Progress|%/)
})

// ---- the archive: what landed leaves fleet.json ----------------------------------------------

const row = (feature, merged = 'abc1234') => ({ feature, branch: `builder/${feature}`, target: 'main', merged, pr: null, runs: 3, runsThisTime: 3, landedAt: '2026-09-29T10:00:00.000Z' })

test('appendArchive appends one line per landing and skips a repeat of the same landing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  assert.equal(appendArchive(root, row('a')), true)
  assert.equal(appendArchive(root, row('a')), false, 'a fleet killed before saving re-archives the same landing')
  assert.equal(appendArchive(root, row('a', 'def5678')), true, 'the same name landing again later is a new line')
  assert.deepEqual(tailArchive(root, 10).map((r) => [r.feature, r.merged]), [['a', 'abc1234'], ['a', 'def5678']])
})

test('tailArchive returns the last N rows, oldest first, reading backwards in chunks', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  mkdirSync(fleetDir(root), { recursive: true })
  for (let i = 0; i < 300; i++) appendFileSync(join(fleetDir(root), 'archive.jsonl'), JSON.stringify(row(`fé${i}`)) + '\n')
  assert.deepEqual(tailArchive(root, 3, 37).map((r) => r.feature), ['fé297', 'fé298', 'fé299'])
  assert.equal(tailArchive(root, 1000, 37).length, 300)
  assert.deepEqual(tailArchive(mkdtempSync(join(tmpdir(), 'fc-')), 5), [])
})

test('archiveLogs moves exactly this feature’s logs — not those of a feature whose name it prefixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const logs = join(fleetDir(root), 'logs')
  mkdirSync(logs, { recursive: true })
  for (const n of ['a-01.log', 'a-01.jsonl', 'a-12.log', 'a-setup.log', 'a-start.log', 'a-sync.log', 'a-b-01.log', 'baseline.log']) writeFileSync(join(logs, n), 'x')
  assert.equal(archiveLogs(root, 'a'), null)
  for (const n of ['a-01.log', 'a-01.jsonl', 'a-12.log', 'a-setup.log', 'a-start.log', 'a-sync.log']) assert.ok(existsSync(join(logs, '_archive', 'a', n)), n)
  assert.ok(existsSync(join(logs, 'a-b-01.log')))
  assert.ok(existsSync(join(logs, 'baseline.log')))
  assert.equal(archiveLogs(root, 'nothing-here'), null)
})

test('pruneArchivedLogs removes archived logs older than the window; 0 keeps them', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const base = join(fleetDir(root), 'logs', '_archive')
  for (const n of ['old', 'new']) {
    mkdirSync(join(base, n), { recursive: true })
    writeFileSync(join(base, n, `${n}-01.log`), 'x')
  }
  const now = Date.now()
  const old = new Date(now - 3 * 86400000)
  utimesSync(join(base, 'old'), old, old)
  assert.equal(pruneArchivedLogs(root, 0, now), 0)
  assert.ok(existsSync(join(base, 'old')))
  assert.equal(pruneArchivedLogs(root, 1, now), 1)
  assert.equal(existsSync(join(base, 'old')), false)
  assert.ok(existsSync(join(base, 'new')))
  assert.equal(pruneArchivedLogs(mkdtempSync(join(tmpdir(), 'fc-')), 30, now), 0, 'no logs dir is not an error')
})

test('ago', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  assert.equal(ago('2026-09-29T11:59:30Z', now), 'just now')
  assert.equal(ago('2026-09-29T11:15:00Z', now), '45m ago')
  assert.equal(ago('2026-09-29T02:00:00Z', now), '10h ago')
  assert.equal(ago('2026-09-25T12:00:00Z', now), '4d ago')
  assert.equal(ago('nonsense', now), 'unknown')
})

test('renderStatus names the archive with the last landing', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  const out = renderStatus({ target: 'main', archived: 412, features: {} }, null, { feature: 'auth-refresh', landedAt: '2026-09-29T10:00:00Z' }, now)
  assert.match(out, /^# builder fleet — 0 feature\(s\): none\n/)
  assert.match(out, /^412 archived \(last: auth-refresh, 2h ago\) · \/builder:fleet:status --archived for the latest 20$/m)
  assert.match(out, /^Nothing in flight\.$/m)
  assert.doesNotMatch(out, /\| Feature \|/)
})

test('renderArchived lists the latest landings newest first', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  const out = renderArchived([row('a'), { ...row('b', 'fff0000'), pr: '#9', landedAt: '2026-09-29T11:00:00Z' }], 412, now)
  assert.match(out, /^# builder fleet — archive: latest 2 of 412\n/)
  assert.match(out, /\| Feature \| Tests \| Time \| Tokens \| Merged \| PR \| Landed \|/)
  assert.ok(out.indexOf('| b |') < out.indexOf('| a |'))
  assert.match(out, /\| b \| — \| — \| — \| fff0000 \| #9 \| 1h ago \|/)
  assert.match(out, /\| a \| — \| — \| — \| abc1234 \| — \| 2h ago \|/)
  const full = renderArchived([{ ...row('c'), tests: 'slice=own end=touched review=end', lanes: { build: 600000, walk: 120000 }, tokens: { input: 1500000, output: 600000, cacheRead: 0 } }], 1, now)
  assert.match(full, /\| c \| own · touched · end \| 12m \| 2\.1M \| abc1234 \|/)
  assert.equal(renderArchived([], 0), 'No feature has landed from this fleet yet.\n')
})

test('parkParts splits a park into why and next; an old "clears when" reads as the next step', () => {
  assert.deepEqual(parkParts('the pane opens on a struck preview — next: /builder:agent'), { why: 'the pane opens on a struck preview', next: '/builder:agent' })
  assert.deepEqual(parkParts('a — b — next: c'), { why: 'a — b', next: 'c' }, 'the last next: wins')
  assert.deepEqual(parkParts('plan wants to split — clears when you split it'), { why: 'plan wants to split', next: 'clears when you split it' })
  assert.deepEqual(parkParts('run cap (12) reached'), { why: 'run cap (12) reached', next: null })
  assert.deepEqual(parkParts(null), { why: '', next: null })
})

test('renderStatus lists each parked feature with why and the recommended next step', () => {
  const out = renderStatus({
    features: {
      p: { status: 'parked', runs: 3, worktree: '/w/p', reason: 'the walk keeps failing on the pane default — next: a human walk, then /builder:signoff --path docs/features/p' },
      q: { status: 'parked', runs: 1, worktree: '/w/q', reason: 'run cap (12) reached' },
      r: { status: 'building', runs: 1, worktree: '/w/r', reason: null },
    },
  })
  assert.match(out, /\| p \| parked \| — \| 3 \| — \| the walk keeps failing on the pane default \| yes \|/, 'the table carries only the why')
  assert.match(out, /^## Parked$/m)
  assert.match(out, /^- \*\*p\*\* — the walk keeps failing on the pane default\n {2}next: a human walk, then \/builder:signoff --path docs\/features\/p$/m)
  assert.match(out, /^- \*\*q\*\* — run cap \(12\) reached\n {2}next: \/builder:agent — naming it again unparks it and retries$/m, 'no next step written → the retry')
  assert.doesNotMatch(out.slice(out.indexOf('## Parked')), /\*\*r\*\*/)
})

test('duration is compact; laneTotals sums ms per lane', () => {
  assert.deepEqual([duration(45000), duration(12 * 60000), duration(72 * 60000)], ['45s', '12m', '1h12m'])
  assert.deepEqual(laneTotals([{ lane: 'build', ms: 1000 }, { lane: 'walk', ms: 500 }, { lane: 'build', ms: 250 }]), { build: 1250, walk: 500 })
  assert.deepEqual(laneTotals(undefined), {})
})

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
  assert.match(out, /\| Feature \| Status \| Tests \| Runs \| Time \| Reason \| Worktree \|/)
  assert.match(out, /\| a \| building \| — \| 2 \| 42m \| — \| yes \|/)
  assert.match(out, /\| b \| queued \| — \| 0 \| — \| — \| — \|/)
  assert.match(out, /^last 2 landed, mean agent time per lane: build 50m · walk 40m$/m)
})

test('renderStatus prefers wall-clock by stage when the landings recorded it', () => {
  const rows = [
    { feature: 'x', lanes: { build: 1 }, wallMs: 200 * 60000, stages: { audit: 10 * 60000, plan: 30 * 60000, build: 40 * 60000, walk: 60 * 60000, parked: 20 * 60000, verify: 40 * 60000 } },
    { feature: 'y', lanes: { build: 1 }, wallMs: 220 * 60000, stages: { audit: 6 * 60000, plan: 30 * 60000, build: 44 * 60000, walk: 80 * 60000, verify: 60 * 60000 } },
  ]
  const out = renderStatus({ target: 'main', archived: 2, features: {} }, null, null, Date.now(), rows)
  assert.match(out, /^last 2 landed, mean wall-clock 3h30m start → merge \(audit 8m · plan 30m · build 42m · walk 1h10m · verify 50m · parked 10m\)$/m)
})

test('stagesFromCommits splits a branch history into stages, parks kept apart', () => {
  const c = (min, s) => ({ t: 1000 + min * 60, s })
  const r = stagesFromCommits([
    c(0, 'chore(x): x — agent mode on'), c(7, 'docs(x): x audited'), c(38, 'docs(x): plan x'),
    c(41, 'feat(x): engine'), c(84, 'feat(x): view'), c(94, 'docs(x): x — final-review rulings'), c(106, 'fix(x): final review findings'),
    c(146, 'chore(x): x — phases closed, awaiting the walk lane'), c(150, 'chore(x): x — parked: walk env needs a restart'),
    c(160, 'chore(x): walk env restarted by the fleet'), c(188, 'docs(x): x — agent walk round 1: 1 fixes'), c(189, 'fix(x): one'),
    c(196, 'docs(x): x agent signed off'), c(232, 'docs(x): x — verify READY'), c(235, 'docs(x): x shipped into main'),
  ])
  const m = (k) => r.stages[k] / 60000
  assert.deepEqual([m('audit'), m('plan'), m('build'), m('finalReview'), m('endGates'), m('walk'), m('parked'), m('verify'), m('ship')], [7, 31, 46, 22, 40, 40, 10, 36, 3])
  assert.equal(r.walkRounds, 1); assert.equal(r.parks, 1)
  assert.equal(r.endGatesAt, (1000 + 146 * 60) * 1000)
  assert.deepEqual(stagesFromCommits([]).stages, {})
})

test('walkFacts counts walk.md checks and each round report\'s results', () => {
  const report = (verdict, rows) => `sha: abc\n| # | App | Item | Result | Evidence |\n|---|---|---|---|---|\n${rows.map(([n, r]) => `| ${n} | web | item | ${r} | e.png |`).join('\n')}\nverdict: ${verdict}\n`
  const f = walkFacts({
    walkMd: '# walk\n\n## web\n\n1. [risk] saves\n2. lists\n\n## Cross-app (verify E2E)\n\nE1. end to end\n',
    reports: [{ n: 2, text: report('PASS', [[1, 'PASS']]) }, { n: 1, text: report('PROBLEMS (1)', [[1, 'FAIL'], [2, 'PASS'], ['E1', 'UNVERIFIABLE']]) }],
  })
  assert.equal(f.checks, 3)
  assert.deepEqual(f.rounds, [{ n: 1, pass: 1, fail: 1, unverifiable: 1, verdict: 'PROBLEMS' }, { n: 2, pass: 1, fail: 0, unverifiable: 0, verdict: 'PASS' }])
  assert.deepEqual(walkFacts(), { checks: null, rounds: [] })
})

test('tokensOf reads a result event’s usage; zeros without one', () => {
  assert.deepEqual(tokensOf({ usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 }, total_cost_usd: 0.1 }), { input: 5, output: 2, cacheRead: 1, costUsd: 0.1 })
  assert.deepEqual(tokensOf(null), { input: 0, output: 0, cacheRead: 0, costUsd: 0 })
})

test('formatTokens: 2.1M, 340k, — when absent', () => {
  assert.equal(formatTokens(2100000), '2.1M')
  assert.equal(formatTokens(340000), '340k')
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(999600), '1.0M')
  assert.equal(formatTokens(null), '—')
  assert.equal(formatTokens(0), '—')
})

test('specBringIn: a new branch takes HEAD\u2019s folder unless the target already has the same one', () => {
  assert.equal(specBringIn({ targetTree: null, headTree: 'h', worktreeHasFolder: true, isNewBranch: true }), true, 'the target lacks it')
  assert.equal(specBringIn({ targetTree: 'old', headTree: 'h', worktreeHasFolder: true, isNewBranch: true }), true, 'the target holds an older copy')
  assert.equal(specBringIn({ targetTree: 'h', headTree: 'h', worktreeHasFolder: true, isNewBranch: true }), false, 'identical')
  assert.equal(specBringIn({ targetTree: 'old', headTree: 'h', worktreeHasFolder: true, isNewBranch: false }), false, 'an existing branch is left alone')
  assert.equal(specBringIn({ targetTree: 'h', headTree: 'h', worktreeHasFolder: false, isNewBranch: false }), true, 'a worktree with no spec folder heals')
  // The caller reports a folder holding only SPEC.md (condensed at sign-off, merge pending) as present.
  assert.equal(specBringIn({ targetTree: 'old', headTree: 'h', worktreeHasFolder: true, isNewBranch: false }), false, 'a SPEC.md-only folder is not healed')
})

test('renderStatus shows each feature\'s test plan as its label; an old profile in the facts maps onto it', () => {
  const f = (facts) => ({ status: 'building', runs: 1, facts: facts ? { size: 'md', ...facts } : undefined })
  const out = renderStatus({ features: {
    a: f({ tests: 'slice=own end=touched review=end' }),
    b: f({ tests: 'slice=own end=risk review=app walk=you' }),
    c: f({ tests: 'slice=own+app end=everything review=slice', profile: 'rush' }),
    d: f({ profile: 'rush' }),
    e: f({ profile: 'thorough-you' }),
    g: f({ profile: 'bogus' }),
    h: f(null),
  } })
  assert.match(out, /\| Tests \|/)
  assert.doesNotMatch(out, /\| Profile \|/)
  assert.match(out, /\| a \| building \| own · touched · end \|/)
  assert.match(out, /\| b \| building \| own · risk · app · you \|/)
  assert.match(out, /\| c \| building \| own\+app · everything · slice \|/, 'tests wins over profile')
  assert.match(out, /\| d \| building \| own\+app · touched · end \|/)
  assert.match(out, /\| e \| building \| own\+app · everything · slice · you \|/)
  assert.match(out, /\| g \| building \| own\+app · everything · slice \|/, 'an unknown old profile reads as thorough')
  assert.match(out, /\| h \| building \| — \|/)
})

test('renderArchived labels the test plan as every status view does — an old row by its profile', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  assert.match(renderArchived([{ ...row('y'), profile: 'thorough-you' }], 1, now), /\| y \| own\+app · everything · slice · you \|/)
  assert.match(renderArchived([{ ...row('z'), tests: 'slice=own end=touched review=end', profile: null }], 1, now), /\| z \| own · touched · end \|/)
  assert.match(renderArchived([{ ...row('h'), profile: 'here' }], 1, now), /\| h \| here \|/)
})

test('renderStatus: a row with no facts yet shows the label the caller resolves for it', () => {
  const fleet = { target: 'main', features: { a: { status: 'queued', runs: 0 }, b: { status: 'building', runs: 1, facts: { tests: 'slice=own end=touched review=end' } } } }
  const out = renderStatus(fleet, null, null, Date.now(), [], (name) => (name === 'a' ? 'own · risk · end' : 'own · everything · end'))
  assert.match(out, /\| a \| queued \| own · risk · end \|/)
  assert.match(out, /\| b \| building \| own · touched · end \|/, 'facts win over the fallback')
  assert.match(renderStatus(fleet), /\| a \| queued \| — \|/, 'no fallback given: as before')
})

test('landedRow reads the whole archive and returns the last row for a feature', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  assert.equal(landedRow(root, 'a'), null)
  appendArchive(root, { feature: 'a', target: 'main', merged: 'abc' })
  appendArchive(root, { feature: 'b', target: 'main', merged: 'def' })
  assert.deepEqual(landedRow(root, 'a'), { feature: 'a', target: 'main', merged: 'abc' })
  assert.equal(landedRow(root, 'c'), null)
})

// ---- 4.9.2: migrations that land with a feature reach the dev DB ------------------------------
import { parseWalkReadiness, landedMigrations, stagesFromCommits, walkFacts, destructiveMigration, forwardHalf } from '../fleet-core.mjs'

const BODY = [
  '## Quality gates', '', '```', 'x: y', '```', '',
  '## Walk readiness', '', '```',
  'migrations: packages/db/prisma/migrations',
  'status:     npx prisma migrate status   # against the DEV db',
  'apply:      npm run db:migrate',
  'apply_mode: agent       # Luke: just run it',
  'regenerate: npm run db:generate',
  '```', '', '- prose', '', '## Global constraints', '',
].join('\n')

test('parseWalkReadiness reads the block under ## Walk readiness, comments dropped', () => {
  assert.deepEqual(parseWalkReadiness(BODY), {
    migrations: 'packages/db/prisma/migrations', status: 'npx prisma migrate status', apply: 'npm run db:migrate', apply_mode: 'agent', regenerate: 'npm run db:generate',
  })
  assert.deepEqual(parseWalkReadiness('## Other\n'), {})
  assert.equal(parseWalkReadiness(BODY.replace('apply:      npm run db:migrate', 'apply:      <command>')).apply, undefined, 'a template placeholder is not a command')
})

test('landedMigrations: nothing landed → nothing to do', () => {
  assert.deepEqual(landedMigrations({ files: [], readiness: parseWalkReadiness(BODY) }), { action: 'none' })
})

test('landedMigrations: apply_mode agent and additive → run apply then regenerate', () => {
  const r = landedMigrations({ files: [{ path: 'm/1/migration.sql', text: 'ALTER TABLE "A" ADD COLUMN "b" TEXT;' }], readiness: parseWalkReadiness(BODY) })
  assert.deepEqual(r, { action: 'apply', commands: ['npm run db:migrate', 'npm run db:generate'] })
})

test('landedMigrations: a drop or rewrite is never run, only noted', () => {
  for (const text of ['DROP TABLE "A";', 'ALTER TABLE "A" DROP COLUMN "b";', 'DELETE FROM "A";', 'TRUNCATE "A";', 'ALTER TABLE "A" RENAME COLUMN "b" TO "c";']) {
    const r = landedMigrations({ files: [{ path: 'm/1/migration.sql', text }], readiness: parseWalkReadiness(BODY) })
    assert.equal(r.action, 'note', text)
    assert.match(r.why, /may drop or rewrite data going forward/)
    assert.match(r.why, /npm run db:migrate/)
  }
})

test('destructiveMigration reads only the forward half, catches ORM operations, ignores comments', () => {
  const alembic = (up, down) => `"""add plans — rename later?"""\nfrom alembic import op\n\ndef upgrade():\n    ${up}\n\n\ndef downgrade():\n    ${down}\n`
  assert.equal(destructiveMigration({ path: 'alembic/versions/1_add.py', text: alembic('op.add_column("plans", sa.Column("x", sa.Text()))', 'op.drop_column("plans", "x")') }), null, 'a drop only in downgrade() is not a forward drop')
  assert.equal(destructiveMigration({ path: 'alembic/versions/2.py', text: alembic('op.drop_column("plans", "x")', 'pass') }), 'drop_column')
  assert.equal(destructiveMigration({ path: 'alembic/versions/3.py', text: alembic('op.execute("DROP TABLE old")', 'pass') }), 'DROP TABLE')
  assert.equal(destructiveMigration({ path: 'alembic/versions/4.py', text: alembic('# we may rename this later\n    op.create_table("t")', 'op.drop_table("t")') }), null, 'a comment is not an operation')
  assert.equal(destructiveMigration({ path: 'db/migrate/1_x.rb', text: 'class X < ActiveRecord::Migration[7.1]\n  def up\n    add_column :a, :b, :string\n  end\n  def down\n    remove_column :a, :b\n  end\nend\n' }), null)
  assert.equal(destructiveMigration({ path: 'db/migrate/2_x.rb', text: 'class X < ActiveRecord::Migration[7.1]\n  def change\n    remove_column :a, :b\n  end\nend\n' }), 'remove_column')
  assert.equal(destructiveMigration({ path: 'migrations/1.js', text: 'exports.up = (knex) => knex.schema.table("a", (t) => t.string("b"))\nexports.down = (knex) => knex.schema.table("a", (t) => t.dropColumn("b"))\n' }), null)
  assert.equal(destructiveMigration({ path: 'migrations/2.ts', text: 'export async function up(knex) { await knex.schema.dropTable("a") }\nexport async function down() {}\n' }), 'dropTable')
  assert.equal(destructiveMigration({ path: 'app/migrations/0002_x.py', text: 'operations = [migrations.RemoveField(model_name="a", name="b")]' }), 'RemoveField', 'Django: the whole file')
  assert.equal(destructiveMigration({ path: 'db/1.sql', text: 'CREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;\n' }), null)
  assert.equal(destructiveMigration({ path: 'db/2.down.sql', text: 'DROP TABLE a;' }), null, 'a down-only file')
  assert.equal(destructiveMigration({ path: 'm/3/migration.sql', text: 'ALTER TABLE "a" ALTER COLUMN "b" TYPE bigint;' }), 'ALTER COLUMN "b" TYPE')
  assert.equal(destructiveMigration({ path: 'm/4/migration.sql', text: 'UPDATE "a" SET b = 1;' }), 'UPDATE "a" SET')
  assert.match(destructiveMigration({ path: 'migrations/5.go', text: 'func Up() {}' }), /unrecognised/)
  assert.equal(forwardHalf('db/2.down.sql', 'x'), null)
})

test('landedMigrations: ask, human, or no apply command → a note naming the command', () => {
  const files = [{ path: 'm/1/migration.sql', text: 'CREATE TABLE "A" ();' }]
  for (const mode of ['ask', 'human']) {
    const r = landedMigrations({ files, readiness: { ...parseWalkReadiness(BODY), apply_mode: mode } })
    assert.equal(r.action, 'note')
    assert.match(r.why, /1 new migration/)
    assert.match(r.why, /run `npm run db:migrate`/)
  }
  const none = landedMigrations({ files, readiness: { migrations: 'm' } })
  assert.equal(none.action, 'note')
  assert.match(none.why, /no `apply:` command/)
  assert.equal(landedMigrations({ files, readiness: { ...parseWalkReadiness(BODY), apply_mode: undefined } }).action, 'note', 'ask is the default')
})

// ---- agent picks: a feature a session is building, and a branch several features share ---------
import { activeInSession, sharedBranch, ACTIVE_MS } from '../fleet-core.mjs'

test('activeInSession: a workspace file touched within ACTIVE_MS means a session is building it', () => {
  const root = mkdtempSync(join(tmpdir(), 'active-'))
  mkdirSync(join(root, '.builder', 'f'), { recursive: true })
  writeFileSync(join(root, '.builder', 'f', 'ledger.md'), 'x')
  const now = Date.now()
  assert.equal(activeInSession(root, 'f', now), true)
  assert.equal(activeInSession(root, 'f', now + ACTIVE_MS + 1000), false)
  assert.equal(activeInSession(root, 'missing', now), false)
  assert.equal(ACTIVE_MS, 30 * 60 * 1000)
})

test('sharedBranch: other unfinished features whose manifest names the same feature branch', () => {
  const manifests = {
    a: { state: 'building', branch: 'feat/x' },
    b: { state: 'built', branch: 'feat/x' },
    c: { state: 'spec', branch: 'feat/x' },
    d: { state: 'building', branch: 'main' },
    e: { state: 'building', branch: 'main' },
    f: { state: 'shipped', branch: 'feat/x' },
    g: { state: 'building', branch: 'builder/g' },
  }
  const cfg = { baseBranch: 'main', mergeInto: 'main' }
  assert.deepEqual(sharedBranch('a', manifests, cfg), ['b', 'c'])
  assert.deepEqual(sharedBranch('d', manifests, cfg), [], 'the base branch is everyone\'s, not shared work')
  assert.deepEqual(sharedBranch('g', manifests, cfg), [])
})

test('waitForCommand: found at once, found after the binary comes back, gives up after the timeout', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { waitForCommand, findOnPath } = await import('../fleet-core.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'wfc-'))
  const env = { PATH: dir }
  assert.equal(findOnPath('fakeclaude', env), null)
  let ticks = 0
  const sleep = async () => {
    if (++ticks === 2) { writeFileSync(join(dir, 'fakeclaude'), '#!/bin/sh\n'); chmodSync(join(dir, 'fakeclaude'), 0o755) }
  }
  assert.equal(await waitForCommand('fakeclaude', { env, timeoutMs: 60000, everyMs: 5000, sleep }), true)
  assert.equal(ticks, 2, 'it waited for the update to finish')
  assert.equal(await waitForCommand('nope', { env, timeoutMs: 10000, everyMs: 5000, sleep: async () => {} }), false)
})

test('initWithoutBuilder: a run that starts without builder is named; with it, or no init, is not', async () => {
  const { initWithoutBuilder } = await import('../fleet-core.mjs')
  const init = (plugins) => ({ type: 'system', subtype: 'init', plugins })
  assert.equal(initWithoutBuilder(init([{ name: 'builder', source: 'builder@claude-builder' }])), null)
  assert.match(initWithoutBuilder(init([{ name: 'cc-plugin-telemetry' }])), /without the builder plugin loaded[\s\S]*--bare/)
  assert.equal(initWithoutBuilder({ type: 'assistant' }), null)
  assert.equal(initWithoutBuilder({ type: 'system', subtype: 'init' }), null) // no plugin list: not judged
})

test('fleetOverall: a merged feature counts at 100% — five with one merged and four not started is 20%', async () => {
  const { fleetOverall } = await import('../fleet-core.mjs')
  const fleet = { landedThisRun: ['a'], features: { b: { status: 'queued' }, c: { status: 'queued' }, d: { status: 'queued' }, e: { status: 'queued' } } }
  assert.deepEqual(fleetOverall(fleet, () => 0), { pct: 20, merged: 1, total: 5 })
  // a done row not yet archived counts once, as merged
  const mid = { landedThisRun: ['a'], features: { a: { status: 'done' }, b: { status: 'building' } } }
  assert.deepEqual(fleetOverall(mid, () => 50), { pct: 75, merged: 1, total: 2 })
  // a feature added while the run goes on grows the total
  fleet.features.f = { status: 'queued' }
  assert.equal(fleetOverall(fleet, () => 0).total, 6)
  assert.equal(fleetOverall({ features: {} }, () => 0).pct, null)
})

test('renderStatus: the heading counts what this run merged, and its bar covers the whole run', async () => {
  const { renderStatus } = await import('../fleet-core.mjs')
  const fleet = { landedThisRun: ['a'], features: { b: { status: 'building', runs: 1 }, c: { status: 'queued', runs: 0 }, d: { status: 'queued', runs: 0 }, e: { status: 'queued', runs: 0 } } }
  const out = renderStatus(fleet, (name) => ({ pct: name === 'b' ? 50 : 0, label: 'x' }))
  assert.match(out, /^# builder fleet — 5 feature\(s\): 1 merged this run · 1 building · 3 queued · ▓▓▓░░░░░░░ 30%$/m)
})

test('laneOf, batched: the walk lane keeps readiness and the walk; fixes and verify go to the pool', async () => {
  const { laneOf, hasOpenFixes } = await import('../fleet-core.mjs')
  const fixes = '# s\n\n## Testing\n\n- [ ] not a fix\n\n## Fixes\n\n- [x] done\n- [ ] notes: list --tag — expected one line (agent walk round 1)\n'
  const ticked = fixes.replace('- [ ] notes', '- [x] notes')
  const batched = (mf, specText = null) => laneOf(mf, { batched: true, specText })
  assert.equal(batched({ state: 'building', ready: 'pending "dev env (fleet walk lane)"' }), 'walk')
  assert.equal(batched({ state: 'built' }), 'walk')
  assert.equal(batched({ state: 'built' }, fixes), 'build', 'a walk\'s open fixes are worked with no env')
  assert.equal(batched({ state: 'built' }, ticked), 'walk', 'ticked: back to a walk batch')
  assert.equal(batched({ state: 'signed-off' }), 'ship', 'verify runs in the pool')
  // not batched: as before
  assert.equal(laneOf({ state: 'built' }, { specText: fixes }), 'walk')
  assert.equal(laneOf({ state: 'signed-off' }), 'walk')
  assert.equal(hasOpenFixes('## Testing\n\n- [ ] x\n'), false, 'a box outside ## Fixes is not a fix')
})
