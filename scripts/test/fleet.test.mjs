import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync, unlinkSync, utimesSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLEET = join(HERE, '..', 'fleet.mjs')
const STUB = join(HERE, 'fixtures', 'stub-claude.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** `lines` are extra `agent_walk:` keys, e.g. ['copy: .env.local', 'setup: pnpm i']. */
function makeRepo(features, { reset, stop, lines = [], manifest = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  // Automatic retries are off unless a test asks for them: most tests assert on the first park.
  const retries = lines.some((l) => l.startsWith('auto_unpark:')) ? [] : ['auto_unpark: 0']
  const hooks = [reset && `  reset: ${reset}`, stop && `  stop: ${stop}`, ...[...retries, ...lines].map((l) => `  ${l}`)].filter(Boolean).join('\n')
  writeFileSync(
    join(root, '.claude/builder.md'),
    `---\nproject: fleet-test\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto\n` +
      `agent_walk:\n  driver: none\n  claude_args: --stub-flag\n  worktrees: ${root}-wt\n${hooks}\n---\nbody\n`
  )
  for (const f of features) {
    mkdirSync(join(root, 'docs/features', f), { recursive: true })
    writeFileSync(join(root, 'docs/features', f, 'MANIFEST.md'), `size: md\nstate: spec\nnext: /builder:resume --path docs/features/${f}\n${manifest.map((l) => `${l}\n`).join('')}`)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  mkdirSync(join(root, '.stub'))
  return root
}

function runFleet(root, args, scenario, env = {}) {
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const r = spawnSync('node', [FLEET, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FLEET_CLAUDE: STUB, FLEET_KEEP_STOPPED_WORKTREES: '1', STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), ...env },
  })
  const fj = join(root, '.builder/fleet/fleet.json')
  const calls = existsSync(join(root, '.stub/calls.log')) ? readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n') : []
  return { ...r, fleet: existsSync(fj) ? JSON.parse(readFileSync(fj, 'utf8')) : null, calls, archived: archiveOf(root) }
}

/** archive.jsonl as { feature: row } — the last line per feature wins. */
function archiveOf(root) {
  const p = join(root, '.builder/fleet/archive.jsonl')
  if (!existsSync(p)) return {}
  return Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.feature, r]))
}

/** A feature the fleet merged: gone from fleet.json, one line in archive.jsonl. Returns that line. */
function assertLanded(r, name) {
  assert.equal(r.fleet.features[name], undefined, `${name} is still a row: ${JSON.stringify(r.fleet.features[name])}`)
  assert.ok(r.archived[name], `${name} is not in archive.jsonl`)
  return r.archived[name]
}

const HAPPY = ['audited', 'planned', 'building', 'READY-PENDING', 'built', 'signed-off', 'verified', 'SHIP']

test('the archive row carries the plan’s size and the profile, though the ship removes both files', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: spec\nprofile: rush\nnext: x\n')
  writeFileSync(join(root, 'docs/features/a/PLAN.md'), '# Plan\n\n## Phases\n\n| # | App | Goal |\n|---|---|---|\n| 1 | app | x |\n\n### Task 1: one\n\n### Task 2: two\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'plan')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const a = assertLanded(r, 'a')
  assert.equal(a.size.tasks, 2)
  assert.equal(a.profile, 'rush')
  assert.equal(existsSync(join(root, 'docs/features/_archive/a/PLAN.md')), false, 'the ship removed the plan')
})

test('a spec committed off the target is brought into the worktree', () => {
  const root = makeRepo([])
  git(root, 'checkout', '-q', '-b', 'work')
  mkdirSync(join(root, 'docs/features/a'), { recursive: true })
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: t 2026-10-03\nnext: x\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'spec on work')
  const r = runFleet(root, ['a'], { a: HAPPY.slice(HAPPY.indexOf('building')) })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assertLanded(r, 'a')
  assert.match(git(root, 'log', 'main', '--oneline'), /spec and plan from work/)
  assert.match(git(root, 'log', '-p', '--full-history', 'main', '--', 'docs/features/a/MANIFEST.md'), /\+go-ahead: t 2026-10-03/, 'the manifest content came from work')
})

test('an older copy of the folder on the target is replaced by HEAD\u2019s', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, 'docs/features/a/OLD.md'), 'only on main\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'old extra file')
  git(root, 'checkout', '-q', '-b', 'work')
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: t 2026-10-03\nprofile: rush\nnext: x\n')
  git(root, 'rm', '-q', 'docs/features/a/OLD.md')
  git(root, 'commit', '-qam', 'plan on work')
  const r = runFleet(root, ['a'], { a: HAPPY.slice(HAPPY.indexOf('building')) })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(assertLanded(r, 'a').profile, 'rush')
  assert.match(git(root, 'log', 'main', '--oneline'), /spec and plan from work/)
})

test('a feature with an open PR is taken on to merged, not refused', () => {
  const root = makeRepo(['o'])
  writeFileSync(join(root, 'docs/features/o/MANIFEST.md'), 'size: md\nstate: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc\npr: #5\nbranch: builder/o\nnext: x\n')
  git(root, 'commit', '-qam', 'o has a draft PR')
  const r = runFleet(root, ['o'], { o: ['SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'o')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(o\): agent-verified, not human-tested/)
  assert.match(r.calls[0], /^start o build /, 'the ship lane, without the dev env')
})

test('a spec goes from spec to merged through the build, walk and ship lanes', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const a = assertLanded(r, 'a')
  assert.equal(a.runs, 8)
  // Every run's time and turns, from the result event the stub prints (STUB_DURATION_MS, default 1000).
  assert.equal(a.timing.length, 8)
  assert.deepEqual(a.timing[0], { n: 1, lane: 'build', ms: 1000, turns: 3, tokens: { input: 1000, output: 100, cacheRead: 500, costUsd: 0.05 } })
  assert.deepEqual(a.lanes, { build: 5000, walk: 3000 })
  assert.equal(a.target, 'main')
  assert.equal(a.profile, 'thorough', 'the fixture manifest has no profile:')
  assert.equal(a.size, null, 'the fixture has no PLAN.md')
  assert.equal(a.tokens.input, 1000 * a.runs)
  assert.ok(a.costUsd > 0)
  assert.equal(r.fleet.archived, 1)
  // The stub reports a --no-dev-env run as 'build': the ship lane runs without the dev env too.
  const lanes = r.calls.filter((l) => l.startsWith('start')).map((l) => l.split(' ')[2])
  assert.deepEqual(lanes, ['build', 'build', 'build', 'build', 'walk', 'walk', 'walk', 'build'])
  assert.ok(r.calls.filter((l) => l.startsWith('end')).every((l) => l.endsWith('into=main')), 'every run is told the target')
  // Landed on the branch the fleet ran from, as one merge commit; the worktree and branch are gone.
  assert.equal(git(root, 'branch', '--show-current'), 'main')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(a\): agent-verified, not human-tested/)
  assert.match(readFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'utf8'), /SHIPPED/)
  assert.equal(existsSync(join(root, 'docs/features/a')), false, 'the ship moved the folder into the archive')
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(git(root, 'branch', '--list', 'builder/a'), '')
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /^1 archived \(last: a, just now\)/m)
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /^- repo: clean$/m, 'nothing left behind, and the report says so')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/a/a-01.log')), 'its logs moved with it')
  assert.equal(existsSync(join(root, '.builder/fleet/logs/a-01.log')), false)
})

test('a blocked spec parks with its reason and the fleet exits 1', () => {
  const root = makeRepo(['b'])
  const r = runFleet(root, ['b'], { b: ['audited', 'BLOCK:plan wants to split'] })
  assert.equal(r.status, 1)
  assert.equal(r.fleet.features.b.status, 'parked')
  assert.equal(r.fleet.features.b.reason, 'plan wants to split')
})

test('a run that changes nothing parks as no progress', () => {
  const root = makeRepo(['c'])
  const r = runFleet(root, ['c'], { c: ['NOOP'] })
  assert.equal(r.fleet.features.c.status, 'parked')
  assert.match(r.fleet.features.c.reason, /no progress/)
})

test('one run with no progress runs again; the feature carries on', () => {
  const root = makeRepo(['c2'])
  const r = runFleet(root, ['c2'], { c2: ['NOOP', ...HAPPY] })
  assertLanded(r, 'c2')
})

test('a run that keeps talking outlives the idle timeout; a silent one does not', () => {
  const root = makeRepo(['t1', 't2'])
  const env = { FLEET_IDLE_TIMEOUT_MS: '400' }
  const r = runFleet(root, ['t1', 't2'], { t1: ['CHATTY:1200:audited', ...HAPPY.slice(1)], t2: ['HANG', 'HANG'] }, env)
  assertLanded(r, 't1')
  assert.equal(r.fleet.features.t2.status, 'failed')
  assert.match(r.fleet.features.t2.reason, /timed out twice/)
  // A run killed by the timeout has no result event: wall-clock ms, turns null.
  const hung = r.fleet.features.t2.timing
  assert.equal(hung.length, 2)
  assert.ok(hung.every((t) => t.turns === null && t.ms >= 400), JSON.stringify(hung))
  const log = readFileSync(join(root, '.builder/fleet/logs/_archive/t1/t1-01.log'), 'utf8')
  assert.match(log, /· still working/)
  assert.match(log, /did audited/)
  assert.equal(log.match(/did audited/g).length, 1, 'the result repeating the last assistant text is printed once')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/t1/t1-01.jsonl')))
})

test('a run that prints more than one result event is timed by the last', () => {
  const root = makeRepo(['c'])
  // CHATTY prints its own result event (1 turn), then the stub's finish prints another (3 turns).
  const r = runFleet(root, ['c'], { c: ['CHATTY:100:audited', ...HAPPY.slice(1)] })
  const c = assertLanded(r, 'c')
  assert.deepEqual(c.timing[0], { n: 1, lane: 'build', ms: 1000, turns: 3, tokens: { input: 1000, output: 100, cacheRead: 500, costUsd: 0.05 } })
})

test('a run that fails twice fails, naming the log', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', 'FAIL'] })
  assert.equal(r.fleet.features.d.status, 'failed')
  assert.match(r.fleet.features.d.reason, /failed \(exit 3\) twice — see .*d-02\.log/)
})

test('a run that fails once is retried and carries on', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', ...HAPPY] })
  assertLanded(r, 'd')
})

test('a hung run times out twice and fails', () => {
  const root = makeRepo(['e'])
  const r = runFleet(root, ['e'], { e: ['HANG', 'HANG'] }, { FLEET_RUN_TIMEOUT_MS: '300' })
  assert.equal(r.fleet.features.e.status, 'failed')
  assert.match(r.fleet.features.e.reason, /timed out twice/)
})

test('a hung run with a grandchild holding stdout still times out and fails', () => {
  const root = makeRepo(['e2'])
  const start = Date.now()
  const r = runFleet(root, ['e2'], { e2: ['HANG-CHILD', 'HANG-CHILD'] }, { FLEET_RUN_TIMEOUT_MS: '300' })
  const elapsed = Date.now() - start
  assert.equal(r.fleet.features.e2.status, 'failed')
  assert.match(r.fleet.features.e2.reason, /timed out twice/)
  assert.ok(elapsed < 10000, `fleet run took ${elapsed}ms — a grandchild holding stdout kept it from settling`)
})

test('an unknown flag refuses with exit 2 and creates nothing', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--dryrun'], { a: HAPPY })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--dryrun/)
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(r.calls.length, 0)
})

test('--parallel must be a positive integer', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--parallel', '0'], { a: HAPPY })
  assert.equal(r.status, 2)
})

test('--archived must be a positive integer, and implies --status', () => {
  const root = makeRepo(['a'])
  for (const bad of ['-3', '0', 'x']) {
    const r = runFleet(root, ['--status', '--archived', bad], {})
    assert.equal(r.status, 2, bad)
    assert.match(r.stderr, /--archived must be a positive integer/)
  }
  const r = runFleet(root, ['--archived', '5'], {})
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /No feature has landed from this fleet yet\./)
  assert.doesNotMatch(r.stderr, /Name the specs/)
})

test('walk lane runs one feature at a time', () => {
  const root = makeRepo(['w1', 'w2', 'w3'])
  const slow = ['READY-PENDING', 'SLOW:built', 'SLOW:verified', 'SHIP']
  const r = runFleet(root, ['w1', 'w2', 'w3', '--parallel', '3'], { w1: slow, w2: slow, w3: slow })
  assert.equal(r.status, 0, r.stderr)
  const walk = []
  for (const line of r.calls) {
    const [kind, feature, lane, ts] = line.split(' ')
    if (lane !== 'walk') continue
    if (kind === 'start') walk.push({ feature, start: Number(ts) })
    else walk.findLast((w) => w.feature === feature).end = Number(ts)
  }
  walk.sort((x, y) => x.start - y.start)
  for (let i = 1; i < walk.length; i++) assert.ok(walk[i].start >= walk[i - 1].end, `walk runs overlap: ${JSON.stringify(walk)}`)
})

test('child runs never see CLAUDE_PROJECT_DIR', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.ok(r.calls.filter((l) => l.startsWith('start')).every((l) => l.endsWith('project_dir=-')), r.calls.join('\n'))
})

test('reset and stop run around each walk, even on park', () => {
  const root = makeRepo(['f'], { reset: 'touch reset-ran', stop: 'touch stop-ran' })
  const r = runFleet(root, ['f'], { f: ['READY-PENDING', 'BLOCK:agent walk failed twice'] })
  const wt = r.fleet.features.f.worktree
  assert.equal(r.fleet.features.f.status, 'parked')
  assert.ok(existsSync(join(wt, 'reset-ran')), 'reset ran')
  assert.ok(existsSync(join(wt, 'stop-ran')), 'stop ran')
})

test('without reset, the summary says dev-DB state accumulates', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: HAPPY })
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /dev-DB state accumulates/)
})

test('re-running resumes and retries a cleared park', () => {
  const root = makeRepo(['a'])
  const scenario = { a: ['audited', 'BLOCK:plan wants to split', 'planned', 'READY-PENDING', 'verified', 'SHIP'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked')
  const mfPath = join(first.fleet.features.a.worktree, 'docs/features/a/MANIFEST.md')
  // A still-blocked feature is not retried.
  const idle = runFleet(root, [], scenario)
  assert.equal(idle.fleet.features.a.status, 'parked')
  assert.equal(idle.calls.length, first.calls.length, 'no run while still blocked')
  writeFileSync(mfPath, readFileSync(mfPath, 'utf8').replace(/^blocked:.*\n/m, ''))
  const second = runFleet(root, [], scenario)
  assert.equal(second.status, 0, second.stderr)
  const a = assertLanded(second, 'a')
  assert.equal(a.runs, 6, 'run count continues across fleet runs')
  assert.equal(a.runsThisTime, 4, 'the cap counts this fleet run only')
})

test('a feature parked at the run cap gets a fresh cap on the next fleet run', () => {
  const root = makeRepo(['a'])
  const churn = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'planned' : 'audited'))
  const scenario = { a: [...churn, 'building', 'READY-PENDING', 'verified', 'SHIP'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked')
  assert.match(first.fleet.features.a.reason, /run cap \(12\) reached/)
  const second = runFleet(root, [], scenario)
  assert.equal(second.status, 0, second.stderr)
  const a = assertLanded(second, 'a')
  assert.equal(a.runs, 16, 'lifetime runs for the table')
  assert.equal(a.runsThisTime, 4)
})

test('a worktree on another branch is refused, the rest proceed', () => {
  const root = makeRepo(['a', 'g'])
  git(root, 'worktree', 'add', '-q', '-b', 'other', `${root}-wt/g`)
  const r = runFleet(root, ['a', 'g'], { a: HAPPY })
  assert.match(r.stderr, /g — .*exists on branch 'other'/)
  assert.equal(r.fleet.features.g, undefined)
  assertLanded(r, 'a')
})

test('--dry-run creates nothing', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--dry-run'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /merges/i)
  assert.match(r.stdout, /✓ a → builder\/a/)
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(r.calls.length, 0)
})

test('refusals: uncommitted, already shipped; a feature whose branch is the target gets a builder/ branch', () => {
  const root = makeRepo(['a', 'h', 'k'])
  git(root, 'rm', '-q', 'docs/features/h/MANIFEST.md')
  mkdirSync(join(root, 'docs/features/h'), { recursive: true })
  writeFileSync(join(root, 'docs/features/h/SPEC.md'), '# h — spec\n> ✅ SHIPPED 2026-09-01 — PR #3 · none\n')
  git(root, 'add', '-A')
  writeFileSync(join(root, 'docs/features/k/MANIFEST.md'), 'size: md\nstate: building\nbranch: feat/k\nnext: x\n')
  git(root, 'commit', '-qam', 'h shipped, k underway')
  git(root, 'switch', '-q', '-c', 'feat/k')
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nnext: x\n')
  const r = runFleet(root, ['a', 'h', 'k', '--dry-run'], {})
  assert.match(r.stdout, /✗ a — .*uncommitted changes/)
  assert.match(r.stdout, /✗ h — .*already shipped/)
  // The target is merge_into (main), so k's own branch is what it builds on — and it is checked out here.
  assert.match(r.stdout, /✗ k — feat\/k is checked out in this folder/)
  assert.match(r.stdout, /merges into: main \(merge_into\)/)
  // A feature whose branch IS the target still gets a fresh builder/ branch.
  const into = runFleet(root, ['k', '--into', 'feat/k', '--dry-run'], {})
  assert.match(into.stdout, /✓ k → builder\/k/)
  assert.match(into.stdout, /merges into: feat\/k \(--into\)/)
})

test('a feature already underway continues on its own branch, in the lane it is in', () => {
  const root = makeRepo(['u'])
  git(root, 'switch', '-q', '-c', 'feat/u')
  writeFileSync(join(root, 'docs/features/u/MANIFEST.md'), 'size: md\nstate: built\nready: yes 2026-09-26 abc\nbranch: feat/u\nnext: x\n')
  git(root, 'commit', '-qam', 'u built')
  git(root, 'switch', '-q', 'main')
  git(root, 'merge', '-q', '--ff-only', 'feat/u')
  const r = runFleet(root, ['u'], { u: ['verified', 'SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(assertLanded(r, 'u').branch, 'feat/u')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(u\)/)
  assert.equal(git(root, 'branch', '--list', 'feat/u'), '', 'a merged branch is deleted, whoever created it')
  assert.equal(r.calls.find((l) => l.startsWith('start')).split(' ')[2], 'walk', 'went straight to the walk lane')
})

test('a landed feature leaves no worktree and no branch, even with test output rewritten in its worktree', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'test-results'))
  writeFileSync(join(root, 'test-results/.last-run.json'), '{}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'a tracked test artefact')
  const r = runFleet(root, ['a'], { a: [...HAPPY.slice(0, -1), 'TOUCH:test-results/.last-run.json:SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'a')
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(git(root, 'branch', '--list', 'builder/a'), '')
  assert.equal(git(root, 'stash', 'list'), '', 'test output is restored, not stashed')
  assert.doesNotMatch(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /was kept/)
})

test('a real uncommitted change in a landed feature\'s worktree is stashed by name, then the worktree goes', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'app'))
  writeFileSync(join(root, 'app/code.js'), 'one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'tracked code')
  const r = runFleet(root, ['a'], { a: [...HAPPY.slice(0, -1), 'TOUCH:app/code.js:SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'a')
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.match(git(root, 'stash', 'list'), /builder: a leftovers \d{4}-\d{2}-\d{2}/)
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /a merged; uncommitted changes from its worktree are in stash "builder: a leftovers/)
})

test('a parked feature keeps its branch but not its worktree; picking it again carries on from the branch', () => {
  const root = makeRepo(['p'])
  const r = runFleet(root, ['p'], { p: ['audited', 'TOUCH:.builder/p/progress.md:BLOCK:later'] }, { FLEET_KEEP_STOPPED_WORKTREES: '' })
  assert.ok(existsSync(join(root, '.builder/kept/p/progress.md')), 'the build workspace outlives the worktree')
  assert.equal(r.fleet.features.p.status, 'parked')
  assert.equal(r.fleet.features.p.worktree, null)
  assert.equal(existsSync(`${root}-wt/p`), false, 'the worktree is removed at exit')
  assert.ok(git(root, 'branch', '--list', 'builder/p'), 'the branch holds the work')
  const r2 = runFleet(root, ['p'], { p: ['audited', 'BLOCK:later', ...HAPPY.slice(1)] }, { FLEET_KEEP_STOPPED_WORKTREES: '' })
  assert.equal(r2.status, 0, r2.stderr)
  assertLanded(r2, 'p')
  assert.equal(git(root, 'branch', '--list', 'builder/p'), '')
  assert.equal(existsSync(join(root, '.builder/kept/p')), false, 'handed back to the new worktree')
})

test('a planned feature joins the build lane where it is', () => {
  const root = makeRepo(['p'])
  writeFileSync(join(root, 'docs/features/p/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: auto (recommended) 2026-09-26\nnext: x\n')
  git(root, 'commit', '-qam', 'p planned')
  const r = runFleet(root, ['p'], { p: ['building', 'READY-PENDING', 'verified', 'SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  const p = assertLanded(r, 'p')
  assert.equal(p.branch, 'builder/p')
  assert.equal(p.runs, 4)
})

test('a manifest branch: before building is the spec branch, not a build branch', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nbranch: specs/batch\nnext: x\n')
  git(root, 'commit', '-qam', 'a audited on the spec branch')
  const r = runFleet(root, ['a', '--dry-run'], {})
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ a → builder\/a/)
})

test("two features building on one branch: both refused — one feature can't take the shared branch", () => {
  const root = makeRepo(['p1', 'p2'])
  for (const f of ['p1', 'p2']) writeFileSync(join(root, `docs/features/${f}/MANIFEST.md`), 'size: md\nstate: building\nbranch: feat/shared\nnext: x\n')
  git(root, 'commit', '-qam', 'both building on one branch')
  git(root, 'branch', 'feat/shared')
  const r = runFleet(root, ['p1', 'p2', '--dry-run'], {})
  assert.match(r.stdout, /✗ p1 — docs\/features\/p1 is on feat\/shared with p2/)
  assert.match(r.stdout, /✗ p2 — docs\/features\/p2 is on feat\/shared with p1/)
})

test('a planned feature whose spec branch another feature is building on gets its own branch', () => {
  const root = makeRepo(['m', 'i'])
  writeFileSync(join(root, 'docs/features/m/MANIFEST.md'), 'size: md\nstate: built\nbranch: feat/shared\nnext: x\n')
  writeFileSync(join(root, 'docs/features/i/MANIFEST.md'), 'size: md\nstate: planned\nbranch: feat/shared\nnext: x\n')
  git(root, 'commit', '-qam', 'm built, i planned, both on feat/shared')
  git(root, 'branch', 'feat/shared')
  const r = runFleet(root, ['m', 'i', '--dry-run'], {})
  assert.match(r.stdout, /✓ m → feat\/shared/)
  assert.match(r.stdout, /✓ i → builder\/i/)
})

test('specs named while one holds the lock go to its inbox; naming nothing is refused', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/lock'), String(process.pid))
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ target: 'main', features: {} }))
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /↳ a — queued for the running fleet \(pid \d+\)/)
  assert.equal(JSON.parse(readFileSync(join(root, '.builder/fleet/inbox/a'), 'utf8')).waitsOn.length, 0)
  const bare = runFleet(root, [], { a: HAPPY })
  assert.equal(bare.status, 3)
  assert.match(bare.stderr, /Another fleet is running/)
})

test('a stale lock is taken over', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/lock'), '999999')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /stale fleet lock/)
  assert.equal(existsSync(join(root, '.builder/fleet/lock')), false, 'lock released at the end')
})

test('a stale lock takeover kills the process groups the dead fleet left behind', async () => {
  const root = makeRepo(['a'])
  const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const gone = new Promise((r) => orphan.on('exit', (code, sig) => r(sig)))
  try {
    mkdirSync(join(root, '.builder/fleet'), { recursive: true })
    writeFileSync(join(root, '.builder/fleet/lock'), '999999')
    const row = { status: 'building', runs: 1, branch: 'builder/a', worktree: null, pr: null, reason: null, pgid: orphan.pid }
    writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ features: { a: row } }))
    const r = runFleet(root, [], { a: HAPPY })
    assert.equal(r.status, 0, r.stderr)
    const sig = await Promise.race([gone, new Promise((r) => setTimeout(() => r('still running'), 3000))])
    assert.equal(sig, 'SIGKILL', 'the orphaned group was killed')
    assertLanded(r, 'a') // the row, and the pgid it carried, left fleet.json with the landing
  } finally {
    try {
      process.kill(-orphan.pid, 'SIGKILL')
    } catch {}
  }
})

test('SIGHUP stops the fleet: children killed, the walk stop hook run, the lock released', async () => {
  const root = makeRepo(['h'], { stop: 'touch stop-ran' })
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ h: ['READY-PENDING', 'HANG'] }))
  const fleet = spawn('node', [FLEET, 'h'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FLEET_CLAUDE: STUB, STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') },
  })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  const calls = join(root, '.stub/calls.log')
  const deadline = Date.now() + 10000
  while (!(existsSync(calls) && / h walk .* HANG /.test(readFileSync(calls, 'utf8')))) {
    assert.ok(Date.now() < deadline, 'the walk run never started')
    await new Promise((r) => setTimeout(r, 50))
  }
  const stub = Number(/ h walk .* HANG pid=(\d+) /.exec(readFileSync(calls, 'utf8'))[1])
  fleet.kill('SIGHUP')
  assert.equal(await exited, 129)
  const alive = () => {
    try {
      process.kill(stub, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(alive(), false, 'the hung walk run was killed')
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.ok(existsSync(join(fj.features.h.worktree, 'stop-ran')), 'agent_walk.stop ran for the walking feature')
  assert.equal(existsSync(join(root, '.builder/fleet/lock')), false, 'lock released')
})

test('--status renders the table live, with progress read from each feature', () => {
  const root = makeRepo(['a', 'b'])
  runFleet(root, ['a'], { a: HAPPY })
  const r = runFleet(root, ['--status'], {})
  // a landed, so it is archived, not a row; b never joined the fleet.
  assert.match(r.stdout, /# builder fleet — 0 feature\(s\): none/)
  assert.match(r.stdout, /^1 archived \(last: a, just now\) · --status --archived for the latest 20$/m)
  assert.doesNotMatch(r.stdout, /\| a \|/)
  // Progress is read at --status time, not from the saved file: edit the manifest, the table follows.
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ target: 'main', features: { b: { status: 'building', runs: 1, branch: 'builder/b', worktree: null, pr: null, reason: null } } }))
  writeFileSync(join(root, 'docs/features/b/MANIFEST.md'), 'size: md\nstate: audited\nnext: x\n')
  const r2 = runFleet(root, ['--status'], {})
  assert.match(r2.stdout, /\| b \| building \| thorough \| ▓░░░░░░░░░ 10% · audited \| 1 \|/, 'no facts yet: the manifest\'s profile')
})

test('--status says when the fleet process is gone with features mid-run, and how to resume', () => {
  const root = makeRepo(['b', 'c'])
  // A fleet killed from outside: rows still in flight, no lock.
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ target: 'main', features: {
    b: { status: 'building', runs: 1, branch: 'builder/b', worktree: null, pr: null, reason: null },
    c: { status: 'parked', runs: 2, branch: 'builder/c', worktree: null, pr: null, reason: 'a decision' },
  } }))
  const r = runFleet(root, ['--status'], {})
  assert.match(r.stdout, /^⚠ fleet stopped — its process is gone with 1 feature mid-run \(b\)\. Resume: node \S+fleet\.mjs --detach b$/m)
  // A live lock: no warning.
  writeFileSync(join(root, '.builder/fleet/lock'), String(process.pid))
  assert.doesNotMatch(runFleet(root, ['--status'], {}).stdout, /fleet stopped/)
})

test('--detach starts the fleet in its own session and returns at once; the fleet carries on', async () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--detach'], { a: HAPPY.map((s) => `SLOW:${s}`) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^fleet started detached \(pid (\d+)\) — output in \.builder\/fleet\/fleet\.out · \/builder:fleet --status$/m)
  const pid = Number(/pid (\d+)/.exec(r.stdout)[1])
  // Its own session: a process-group leader, so the shell or agent that ran the launch can end
  // without taking the fleet with it.
  assert.equal(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), String(pid))
  // The launch returned before the fleet took its lock: wait for the landing itself.
  for (let i = 0; i < 600 && !archiveOf(root).a; i++) await new Promise((res) => setTimeout(res, 100))
  assert.ok(archiveOf(root).a, `a did not land: ${readFileSync(join(root, '.builder/fleet/fleet.out'), 'utf8').slice(-800)}`)
})

test('no agent_walk block refuses with the fix', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  const r = runFleet(root, ['a'], {})
  assert.equal(r.status, 2)
  assert.match(r.stderr, /\/builder:init --update/)
})

// ---- the walk env: copy, setup, env, start, smoke ------------------------------------------

test('copy brings untracked files into a new worktree; a missing path is noted', () => {
  const root = makeRepo(['a'], { lines: ['copy: .env.local, secrets, missing.txt'] })
  writeFileSync(join(root, '.env.local'), 'KEY=1\n')
  mkdirSync(join(root, 'secrets/deep'), { recursive: true })
  writeFileSync(join(root, 'secrets/deep/k'), 'shh\n')
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:stop here so the worktree stays'] })
  const wt = r.fleet.features.a.worktree
  assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'KEY=1\n')
  assert.equal(readFileSync(join(wt, 'secrets/deep/k'), 'utf8'), 'shh\n')
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /missing\.txt/)
})

test('copy never overwrites a tracked file', () => {
  const root = makeRepo(['a'], { lines: ['copy: app, extra.txt'] })
  mkdirSync(join(root, 'app'))
  writeFileSync(join(root, 'app/tracked.txt'), 'committed\n')
  git(root, 'add', 'app/tracked.txt')
  git(root, 'commit', '-qm', 'tracked')
  writeFileSync(join(root, 'app/tracked.txt'), 'local edit\n')
  writeFileSync(join(root, 'app/untracked.txt'), 'local only\n')
  writeFileSync(join(root, 'extra.txt'), 'extra\n')
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:stop here so the worktree stays'] })
  const wt = r.fleet.features.a.worktree
  assert.equal(readFileSync(join(wt, 'app/tracked.txt'), 'utf8'), 'committed\n')
  assert.equal(readFileSync(join(wt, 'app/untracked.txt'), 'utf8'), 'local only\n')
  assert.equal(readFileSync(join(wt, 'extra.txt'), 'utf8'), 'extra\n')
})

test('setup runs once per new worktree, not again when the worktree is reused', () => {
  const root = makeRepo(['a'])
  // setup's command names a file under the repo, so the repo path is needed first — write it in.
  const count = join(root, '.stub/setup-count')
  const cfg = join(root, '.claude/builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('agent_walk:\n', `agent_walk:\n  setup: pwd >> ${count}\n`))
  git(root, 'commit', '-qam', 'setup')
  const scenario = { a: ['audited', 'BLOCK:wait'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked', first.stderr)
  runFleet(root, [], scenario)
  const lines = readFileSync(count, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'setup ran once')
  assert.equal(realpathSync(lines[0]), realpathSync(first.fleet.features.a.worktree), 'in the worktree')
})

test('a copy that throws still leaves setup owed, so the next run does it', { skip: process.getuid?.() === 0 && 'root reads a chmod 000 file' }, () => {
  const root = makeRepo(['a'])
  const count = join(root, '.stub/setup-count')
  const cfg = join(root, '.claude/builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('agent_walk:\n', `agent_walk:\n  copy: locked.txt\n  setup: pwd >> ${count}\n`))
  git(root, 'commit', '-qam', 'copy+setup')
  const locked = join(root, 'locked.txt')
  writeFileSync(locked, 'secret\n')
  chmodSync(locked, 0o000)
  const scenario = { a: ['audited', 'BLOCK:wait'] }
  const first = runFleet(root, ['a'], scenario)
  chmodSync(locked, 0o644)
  assert.equal(first.fleet.features.a.status, 'failed', first.stderr)
  assert.match(first.fleet.features.a.reason, /^worktree: /)
  assert.ok(!existsSync(count), 'setup did not run past a failed copy')
  runFleet(root, [], scenario)
  assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 1, 'setup ran on the re-run')
})

test('a failed setup fails the feature, naming the setup log', () => {
  const root = makeRepo(['a'], { lines: ['setup: echo nope; exit 4'] })
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 1)
  assert.equal(r.fleet.features.a.status, 'failed')
  assert.match(r.fleet.features.a.reason, /^setup failed — see .*a-setup\.log$/)
  assert.match(readFileSync(join(root, '.builder/fleet/logs/a-setup.log'), 'utf8'), /nope/)
  assert.equal(r.calls.length, 0, 'no claude run')
  assert.equal(r.fleet.features.a.setupOwed, true, 'setup stays owed on disk, so a re-run retries it')
})

test('env reaches walk-lane claude children with {feature} filled in, never build-lane ones; CLAUDE_PROJECT_DIR stays out', () => {
  const root = makeRepo(['a'], { lines: ['env: WALK_MARK=x-{feature} OTHER="y z"'] })
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const starts = r.calls.filter((l) => l.startsWith('start'))
  assert.equal(starts.length, 8)
  assert.ok(starts.every((l) => l.endsWith('project_dir=-')), starts.join('\n'))
  const walk = starts.filter((l) => l.startsWith('start a walk '))
  const build = starts.filter((l) => l.startsWith('start a build '))
  assert.ok(walk.length > 0 && build.length > 0, starts.join('\n'))
  assert.ok(walk.every((l) => l.includes(' walk_mark=x-a ')), walk.join('\n'))
  assert.ok(build.every((l) => l.includes(' walk_mark=- ')), build.join('\n'))
})

test('worktree_env reaches every lane with {feature} filled in; env still only the walk lane', () => {
  const root = makeRepo(['a'], { lines: ['worktree_env: WT_MARK=db-{feature}', 'env: WALK_MARK=x-{feature}'] })
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const starts = r.calls.filter((l) => l.startsWith('start'))
  assert.equal(starts.length, 8)
  assert.ok(starts.every((l) => l.includes(' wt_mark=db-a ')), starts.join('\n'))
  assert.ok(starts.filter((l) => l.startsWith('start a build ')).every((l) => l.includes(' walk_mark=- ')), starts.join('\n'))
  assert.ok(starts.filter((l) => l.startsWith('start a walk ')).every((l) => l.includes(' walk_mark=x-a ')), starts.join('\n'))
})

test('setup sees worktree_env and gets {feature} filled in', () => {
  const root = makeRepo(['a'], { lines: ['worktree_env: WT_MARK=db-{feature}', 'setup: echo "${WT_MARK:-unset} {feature}" > setup-wt-env'] })
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:stop here so the worktree stays'] })
  assert.equal(readFileSync(join(r.fleet.features.a.worktree, 'setup-wt-env'), 'utf8'), 'db-a a\n')
})

/** A feature underway on its own branch, recorded on main, with main then moving on. */
function laggingBranch(root, feature, edits = () => {}) {
  git(root, 'switch', '-q', '-c', `feat/${feature}`)
  writeFileSync(join(root, `docs/features/${feature}/MANIFEST.md`), `size: md\nstate: building\nbranch: feat/${feature}\nnext: x\n`)
  writeFileSync(join(root, 'shared.txt'), 'base\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `${feature} building`)
  git(root, 'switch', '-q', 'main')
  git(root, 'merge', '-q', '--ff-only', `feat/${feature}`)
  edits()
  writeFileSync(join(root, 'moved.txt'), 'main moved on\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'main moved')
}

test('a pool-lane run starts on the latest target: a branch that lags main gets main merged in first', () => {
  const root = makeRepo(['u'])
  laggingBranch(root, 'u')
  const r = runFleet(root, ['u'], { u: ['BLOCK:stop here'] })
  assert.equal(r.fleet.features.u.status, 'parked', r.stderr)
  assert.equal(r.fleet.features.u.branch, 'feat/u')
  assert.ok(existsSync(join(r.fleet.features.u.worktree, 'moved.txt')), "main's commit is in the worktree before the run")
  assert.match(git(r.fleet.features.u.worktree, 'log', '--oneline', '-3'), /main moved/)
})

test('sync runs in the worktree after a target merge that brought new commits, with worktree_env and {feature}', () => {
  const root = makeRepo(['u'], { lines: ['worktree_env: WT_MARK=db-{feature}', 'sync: echo "$WT_MARK {feature}" >> synced'] })
  laggingBranch(root, 'u')
  const r = runFleet(root, ['u'], { u: ['BLOCK:stop here'] })
  assert.equal(r.fleet.features.u.status, 'parked', r.stderr)
  assert.equal(readFileSync(join(r.fleet.features.u.worktree, 'synced'), 'utf8'), 'db-u u\n', 'ran once, after the one merge')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/u-sync.log')))
})

test('a failing sync parks the feature naming its log; a target already merged runs no sync', () => {
  const root = makeRepo(['u'], { lines: ['sync: echo nope >&2; exit 4'] })
  laggingBranch(root, 'u')
  const r = runFleet(root, ['u'], { u: HAPPY })
  assert.equal(r.fleet.features.u.status, 'parked')
  assert.match(r.fleet.features.u.reason, /agent_walk\.sync failed after merging main \(see .*u-sync\.log\) — next: make agent_walk\.sync pass/)
  assert.equal(r.calls.length, 0)
  const quiet = makeRepo(['a'], { lines: ['sync: touch synced'] })
  const q = runFleet(quiet, ['a'], { a: ['audited', 'BLOCK:wait'] })
  assert.equal(existsSync(join(q.fleet.features.a.worktree, 'synced')), false, 'no merge, no sync')
})

/** laggingBranch, with the branch and main both editing shared.txt. */
function conflictingBranch(root, feature) {
  laggingBranch(root, feature, () => {
    git(root, 'switch', '-q', `feat/${feature}`)
    writeFileSync(join(root, 'shared.txt'), 'theirs\n')
    git(root, 'commit', '-qam', `${feature} edits shared`)
    git(root, 'switch', '-q', 'main')
    writeFileSync(join(root, 'shared.txt'), 'ours\n')
  })
}

test('a target sync that conflicts goes to an agent run, and the feature carries on to merged', () => {
  const root = makeRepo(['u'])
  conflictingBranch(root, 'u')
  const r = runFleet(root, ['u'], { u: HAPPY })
  assertLanded(r, 'u')
  assert.equal(r.calls[0], 'resolve u RESOLVE', 'the conflict is resolved before the first pipeline run')
  assert.equal(readFileSync(join(root, 'shared.txt'), 'utf8'), 'theirs\nours\n', 'both sides landed on main')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(u\): agent-verified/)
})

test('a conflict two agent runs leave unresolved parks, the merge backed out', () => {
  const root = makeRepo(['u'])
  conflictingBranch(root, 'u')
  const r = runFleet(root, ['u'], { u: HAPPY, 'u:resolve': ['NOOP', 'ABORT'] })
  assert.equal(r.fleet.features.u.status, 'parked')
  assert.match(r.fleet.features.u.reason, /merging main \(what other features merged\) conflicted and two agent runs could not resolve it \(see .*u-02\.log\) — next: finish the merge in .* and commit it, then \/builder:agent$/)
  assert.deepEqual(r.calls, ['resolve u NOOP', 'resolve u ABORT'], 'an aborted merge is started again for the second run; no pipeline run follows')
  const wt = r.fleet.features.u.worktree
  assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=no'), '', 'no half-merged tree is left behind')
})

test('setup never sees agent_walk.env', () => {
  const root = makeRepo(['a'], { lines: ['setup: echo "${WALK_MARK:-unset}" > setup-env', 'env: WALK_MARK=x-{feature}'] })
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:stop here so the worktree stays'] })
  assert.equal(readFileSync(join(r.fleet.features.a.worktree, 'setup-env'), 'utf8'), 'unset\n')
})

test('env reaches the hooks', () => {
  const root = makeRepo(['a'], { reset: `sh -c 'echo $WALK_MARK > reset-env'`, lines: ['env: WALK_MARK=x-{feature}'] })
  const r = runFleet(root, ['a'], { a: ['READY-PENDING', 'BLOCK:stop here so the worktree stays'] })
  assert.equal(readFileSync(join(r.fleet.features.a.worktree, 'reset-env'), 'utf8'), 'x-a\n')
})

// The walk env for the start/smoke tests: a tiny server on a port the test picks, which writes
// its pid once listening and exits on SIGTERM; smoke connects to that port.
const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function walkEnvRepo(feature, { smoke } = {}) {
  const port = await freePort()
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-env-'))
  const server = join(scratch, 'server.mjs')
  const pidFile = join(scratch, 'start.pid')
  writeFileSync(
    server,
    `import { createServer } from 'node:net'\nimport { writeFileSync } from 'node:fs'\n` +
      `const s = createServer((c) => c.end()).listen(Number(process.env.WALK_PORT), '127.0.0.1', () => writeFileSync(process.env.WALK_PID, String(process.pid)))\n` +
      `process.on('SIGTERM', () => s.close(() => process.exit(0)))\n`
  )
  const probe = join(scratch, 'smoke.mjs')
  writeFileSync(
    probe,
    `import { connect } from 'node:net'\n` +
      `connect(Number(process.env.WALK_PORT), '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))\n`
  )
  const root = makeRepo([feature], {
    lines: [`env: WALK_PORT=${port} WALK_PID=${pidFile}`, `start: node ${server}`, `smoke: ${smoke ?? `node ${probe}`}`],
  })
  return { root, pidFile }
}
const FAST = { FLEET_SMOKE_INTERVAL_MS: '100' }

test('start and smoke bring up a walk env for the walk, and it is gone afterwards', async () => {
  const { root, pidFile } = await walkEnvRepo('s')
  const r = runFleet(root, ['s'], { s: HAPPY }, FAST)
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 's')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/s/s-start.log')), 'start output is logged')
})

test('start is killed even when the walk parks', async () => {
  const { root, pidFile } = await walkEnvRepo('s')
  const r = runFleet(root, ['s'], { s: ['READY-PENDING', 'BLOCK:agent walk failed twice'] }, FAST)
  assert.equal(r.fleet.features.s.status, 'parked')
  assert.equal(r.fleet.features.s.reason, 'agent walk failed twice')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
})

test('a smoke that never passes gets one agent fix run, then parks and skips the walk', async () => {
  const { root, pidFile } = await walkEnvRepo('s', { smoke: 'exit 1' })
  const r = runFleet(root, ['s'], { s: HAPPY }, { ...FAST, FLEET_SMOKE_TIMEOUT_MS: '1500' })
  assert.equal(r.fleet.features.s.status, 'parked')
  assert.match(r.fleet.features.s.reason, /^the walk env would not start \(walk env didn't come up — see .*s-start\.log\) and an agent run could not fix it — next: run agent_walk\.start in /)
  assert.equal(r.calls.filter((l) => l === 'envfix s NOOP').length, 1, 'one fix run')
  assert.equal(r.calls.filter((l) => l.split(' ')[2] === 'walk').length, 0, 'no walk-lane run')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
})

test('a walk env the agent fix run repairs comes up, and the walk goes on', () => {
  const root = makeRepo(['s'], { lines: ['start: test -f walk-env-fixed && sleep 30', 'smoke: test -f walk-env-fixed'] })
  const r = runFleet(root, ['s'], { s: HAPPY, 's:env': ['FIX'] }, { ...FAST, FLEET_SMOKE_TIMEOUT_MS: '3000' })
  assertLanded(r, 's')
  assert.ok(r.calls.includes('envfix s FIX'))
})

test('a walk that needs the env restarted gets it restarted by the fleet, not parked', async () => {
  const { root, pidFile } = await walkEnvRepo('s')
  const r = runFleet(root, ['s'], { s: ['READY-PENDING', 'BLOCK:walk env needs a restart — a new dependency', 'built', 'signed-off', 'verified', 'SHIP'] }, FAST)
  assertLanded(r, 's')
  assert.match(git(root, 'log', '--format=%s', 'main'), /walk env restarted by the fleet/)
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the restarted env is gone afterwards')
})

test('a start that exits at once parks promptly', () => {
  const root = makeRepo(['s'], { lines: ['start: echo bye', 'smoke: exit 1'] })
  const t0 = Date.now()
  const r = runFleet(root, ['s'], { s: HAPPY }, { FLEET_SMOKE_TIMEOUT_MS: '60000' })
  assert.equal(r.fleet.features.s.status, 'parked')
  assert.match(r.fleet.features.s.reason, /walk env didn't come up/)
  assert.match(readFileSync(join(root, '.builder/fleet/logs/s-start.log'), 'utf8'), /bye/)
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0}ms`)
})

test('SIGHUP mid-walk kills the start group before running stop', async () => {
  const { root, pidFile } = await walkEnvRepo('h')
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ h: ['READY-PENDING', 'HANG'] }))
  const fleet = spawn('node', [FLEET, 'h'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, ...FAST, FLEET_CLAUDE: STUB, STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') },
  })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  const calls = join(root, '.stub/calls.log')
  const deadline = Date.now() + 10000
  while (!(existsSync(calls) && / h walk .* HANG /.test(readFileSync(calls, 'utf8')))) {
    assert.ok(Date.now() < deadline, 'the walk run never started')
    await new Promise((r) => setTimeout(r, 50))
  }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), true, 'the walk env is up during the walk')
  fleet.kill('SIGHUP')
  assert.equal(await exited, 129)
  assert.equal(alive(pid), false, 'the start process is gone')
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.equal(fj.features.h.startPgid, undefined)
})

test('env cannot put CLAUDE_PROJECT_DIR back; the fleet notes it was ignored', () => {
  const root = makeRepo(['a'], { lines: ['env: CLAUDE_PROJECT_DIR=/tmp/nope WALK_MARK=x'] })
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const starts = r.calls.filter((l) => l.startsWith('start'))
  assert.equal(starts.length, 8)
  assert.ok(starts.every((l) => l.endsWith('project_dir=-')), starts.join('\n'))
  const walk = starts.filter((l) => l.startsWith('start a walk '))
  assert.ok(walk.length > 0 && walk.every((l) => l.includes(' walk_mark=x ')), walk.join('\n'))
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /agent_walk\.env may not set CLAUDE_PROJECT_DIR.*ignored/)
})

function program(root, children, deps) {
  mkdirSync(join(root, 'docs/features/big'))
  writeFileSync(join(root, 'docs/features/big/MANIFEST.md'), `tier: program\nnext: x\n${children.map((c) => `child: ${c} — spec`).join('\n')}\n`)
  const rows = children.map((c, i) => `| ${i + 1} | ${c} | md | app | x | ${deps[c] ?? '—'} |`).join('\n')
  writeFileSync(join(root, 'docs/features/big/PROGRAM.md'), `# big — program\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n${rows}\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'program')
}

test('a program chain runs to the end in one fleet run: the child starts after its dependency merges', () => {
  const root = makeRepo(['api', 'ui'])
  program(root, ['api', 'ui'], { ui: 'api' })
  const dry = runFleet(root, ['api', 'ui', '--dry-run'], {})
  assert.match(dry.stdout, /✓ api → builder\/api/)
  assert.match(dry.stdout, /⏳ ui → builder\/ui, once api merges/)
  const r = runFleet(root, ['api', 'ui'], { api: HAPPY, ui: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'api')
  assertLanded(r, 'ui')
  const lastApi = r.calls.findLastIndex((l) => l.startsWith('end api '))
  const firstUi = r.calls.findIndex((l) => l.startsWith('start ui '))
  assert.ok(firstUi > lastApi, r.calls.join('\n'))
})

test('a child whose dependency parks is parked too, saying why', () => {
  const root = makeRepo(['api', 'ui'])
  program(root, ['api', 'ui'], { ui: '#1' })
  const r = runFleet(root, ['api', 'ui'], { api: ['audited', 'BLOCK:needs a human'] })
  assert.equal(r.fleet.features.api.status, 'parked')
  assert.equal(r.fleet.features.ui.status, 'parked')
  assert.equal(r.fleet.features.ui.reason, 'waits on api (parked), which never merged — next: settle api, then pick both in /builder:agent')
  assert.ok(!r.calls.some((l) => l.startsWith('start ui ')), 'ui never ran')
  assert.equal(r.fleet.features.ui.worktree, null, 'no worktree before its dependency ships')
})

test('a child whose dependency is not in the run is refused', () => {
  const root = makeRepo(['api', 'ui'])
  program(root, ['api', 'ui'], { ui: 'api' })
  const dry = runFleet(root, ['ui', '--dry-run'], {})
  assert.match(dry.stdout, /✗ ui — waits on api \(spec\) — not in this run/)
})

test('a merge your uncommitted changes would clobber parks; the next run merges it', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'docs/features/_archive/a'), { recursive: true })
  writeFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'my local edit\n') // the ship writes this path
  const first = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(first.fleet.features.a.status, 'parked')
  assert.match(first.fleet.features.a.reason, /merging into main failed: .* — your uncommitted changes are in the way — next: commit or stash them, then \/builder:fleet/)
  assert.equal(readFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'utf8'), 'my local edit\n', 'your change is untouched')
  unlinkSync(join(root, 'docs/features/_archive/a/SPEC.md'))
  const second = runFleet(root, [], { a: HAPPY })
  assert.equal(second.status, 0, second.stderr)
  assertLanded(second, 'a')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(a\)/)
})

test('a feature that ships after the human switched branches still lands on the target', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, '.stub/switch.sh'), `git -C ${root} switch -q -c elsewhere\n`)
  // Switch the human's checkout away while the ship run is underway.
  const r = runFleet(root, ['a'], { a: [...HAPPY.slice(0, -1), 'SWITCH-THEN-SHIP'] })
  assertLanded(r, 'a')
  assert.equal(git(root, 'branch', '--show-current'), 'elsewhere', 'the checkout is left where the human put it')
  assert.match(git(root, 'log', '--oneline', '-1', 'main'), /merge\(a\): agent-verified, not human-tested/)
  assert.match(git(root, 'show', 'main:docs/features/_archive/a/SPEC.md'), /SHIPPED/)
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, 'a two-parent merge commit')
})

test('a fleet with unfinished work refuses another target, naming the --into that continues it', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: ['audited', 'BLOCK:later'] })
  git(root, 'branch', 'release')
  const r = runFleet(root, ['--into', 'release'], {})
  assert.equal(r.status, 2)
  assert.match(r.stderr, /This fleet merges into main, not release — finish or clear it first, or continue it with --into main/)
})

test('the fleet lands on merge_into (default base_branch), whatever is checked out', () => {
  const root = makeRepo(['a'])
  git(root, 'switch', '-q', '-c', 'elsewhere')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'a')
  assert.match(git(root, 'log', '--oneline', '-1', 'main'), /merge\(a\): agent-verified/)
  assert.equal(git(root, 'branch', '--show-current'), 'elsewhere', 'the checkout is left alone')
  assert.doesNotMatch(git(root, 'log', '--oneline', '-1', 'elsewhere'), /merge\(a\)/)
  assert.equal(git(root, 'branch', '--list', 'builder/a'), '', 'merged into main, so deleted — though main is not checked out')
})

test('--into names the target for one run; merge_into in the config sets the default', () => {
  const root = makeRepo(['a', 'b'])
  git(root, 'branch', 'release')
  git(root, 'branch', 'develop')
  const r = runFleet(root, ['a', '--into', 'release'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(git(root, 'log', '--oneline', '-1', 'release'), /merge\(a\)/)
  assert.doesNotMatch(git(root, 'log', '--oneline', '-1', 'main'), /merge\(a\)/)
  assert.equal(git(root, 'branch', '--list', 'builder/a'), '', 'in release, so deleted')
  // A fresh fleet (the last one finished) picks up merge_into.
  const cfg = join(root, '.claude/builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^---\n/, '---\nmerge_into: develop\n'))
  git(root, 'commit', '-qam', 'merge into develop')
  const r2 = runFleet(root, ['b'], { b: HAPPY })
  assert.equal(r2.status, 0, r2.stderr)
  assert.match(git(root, 'log', '--oneline', '-1', 'develop'), /merge\(b\)/)
})

test('a detached HEAD can launch a fleet; a missing target refuses with the fix', () => {
  const root = makeRepo(['a', 'b'])
  git(root, 'checkout', '-q', '--detach')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(git(root, 'log', '--oneline', '-1', 'main'), /merge\(a\)/)
  const bad = runFleet(root, ['b', '--into', 'nope'], { b: HAPPY })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /The branch to merge into, nope, does not exist — create it \(git branch nope\) or set merge_into in \.claude\/builder\.md/)
})

test('@delta gates get their baseline measured at fleet start, once per target sha', () => {
  const root = makeRepo(['a'])
  const cfg = join(root, '.claude/builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('---\nbody\n', '---\n\n## Quality gates\n\n### app — fast\n\n```\necho 7   # a count @delta\n```\n'))
  git(root, 'commit', '-qam', 'delta gate')
  const first = runFleet(root, ['a'], { a: ['audited', 'BLOCK:wait'] })
  assert.equal(first.fleet.features.a.status, 'parked', first.stderr)
  const baseline = join(root, '.builder/gates/baseline.json')
  assert.ok(existsSync(baseline))
  const b1 = JSON.parse(readFileSync(baseline, 'utf8'))
  assert.equal(b1.values['echo 7'], 7)
  runFleet(root, [], { a: ['BLOCK:wait'] })
  assert.equal(JSON.parse(readFileSync(baseline, 'utf8')).when, b1.when, 'not re-measured while the target sha is unchanged')
  assert.doesNotMatch(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /measuring @delta/, 'the baseline note is gone once it is measured')
})

test('an older fleet\'s "worktree was kept" notes give way to the repo line, which names what is still there', () => {
  const root = makeRepo(['a'])
  const first = runFleet(root, ['a'], { a: ['audited', 'BLOCK:wait'] })
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  fj.notes = ['x merged; its worktree /nowhere/x was kept (it has changes) — remove it with git worktree remove', `y merged; its worktree ${first.fleet.features.a.worktree} was kept (it has changes) — remove it with git worktree remove`]
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify(fj))
  runFleet(root, [], { a: ['BLOCK:wait'] })
  const status = readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8')
  assert.doesNotMatch(status, /was kept \(it has changes\)/)
  assert.match(status, /^- repo: .*→ \/builder:tidy$/m, 'the parked feature is still there, and the repo line says so')
})

// ---- adding to a running fleet: the inbox ----------------------------------------------------

const ENV = (root, env = {}) => ({ ...process.env, CLAUDE_PROJECT_DIR: root, FLEET_CLAUDE: STUB, STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), ...env })
const until = async (pred, what, ms = 15000) => {
  for (const deadline = Date.now() + ms; !pred(); ) {
    assert.ok(Date.now() < deadline, what)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('a spec named while a fleet runs joins its queue and is picked up when a slot frees', async () => {
  const root = makeRepo(['a', 'b', 'c'])
  const scenario = { a: ['CHATTY:4000:audited', ...HAPPY.slice(1)], b: HAPPY, c: HAPPY }
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const fleet = spawn('node', [FLEET, 'a', '--parallel', '1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: ENV(root, { FLEET_INBOX_POLL_MS: '100' }) })
  let out = ''
  fleet.stdout.on('data', (d) => (out += d))
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  const calls = join(root, '.stub/calls.log')
  await until(() => existsSync(calls) && /^start a build/m.test(readFileSync(calls, 'utf8')), 'a never started')

  // A dry run says what a second invocation would do.
  const dry = runFleet(root, ['b', '--dry-run'], scenario)
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /adds to the running fleet \(pid \d+\)/)
  assert.match(dry.stdout, /✓ b → builder\/b/)

  // Naming specs queues them and returns at once — no second fleet, no wait.
  const add = runFleet(root, ['b', 'c'], scenario)
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /↳ b — queued for the running fleet \(pid \d+\)/)
  assert.match(add.stdout, /↳ c — queued for the running fleet/)
  assert.equal(existsSync(join(root, '.builder/fleet/inbox/b')), true)

  // Naming them again is not an error, and not a second copy.
  const again = runFleet(root, ['b'], scenario)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /b — already (queued for|in) the running fleet/)

  // Naming nothing while it runs is still the old refusal.
  const bare = runFleet(root, [], scenario)
  assert.equal(bare.status, 3)
  assert.match(bare.stderr, /Another fleet is running in this repo \(pid \d+\)\. Name specs to add them/)

  assert.equal(await exited, 0, out)
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.deepEqual(fj.features, {}, 'every landed row left fleet.json')
  assert.deepEqual(Object.keys(archiveOf(root)).sort(), ['a', 'b', 'c'])
  assert.equal(existsSync(join(root, '.builder/fleet/inbox/b')), false, 'the inbox entry was consumed')
  const log = readFileSync(calls, 'utf8')
  assert.ok(/^start b build/m.test(log) && /^start c build/m.test(log), 'both additions ran')
  const merges = git(root, 'log', '--first-parent', '--oneline', '-3').split('\n')
  assert.deepEqual(merges.map((l) => /merge\((\w)\)/.exec(l)?.[1]).sort(), ['a', 'b', 'c'], 'all three merged into main')
})

test('an added spec that fails admission is refused with the reason and never queued', async () => {
  const root = makeRepo(['a', 'bad'])
  writeFileSync(join(root, 'docs/features/bad/MANIFEST.md'), 'size: md\nstate: spec\nnext: x\nnote: dirty\n') // uncommitted
  const scenario = { a: ['CHATTY:1500:audited', ...HAPPY.slice(1)] }
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const fleet = spawn('node', [FLEET, 'a'], { cwd: root, stdio: 'ignore', env: ENV(root, { FLEET_INBOX_POLL_MS: '100' }) })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  await until(() => existsSync(join(root, '.stub/calls.log')), 'a never started')
  const add = runFleet(root, ['bad'], scenario)
  assert.equal(add.status, 0)
  assert.match(add.stdout + add.stderr, /✗ bad — .*uncommitted changes/)
  assert.equal(existsSync(join(root, '.builder/fleet/inbox/bad')), false)
  assert.equal(await exited, 0)
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.equal('bad' in fj.features, false)
})

test('an inbox left by a fleet that died is drained at the next start', () => {
  const root = makeRepo(['a', 'b'])
  mkdirSync(join(root, '.builder/fleet/inbox'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/inbox/b'), '{}')
  const r = runFleet(root, ['a'], { a: HAPPY, b: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'a')
  assertLanded(r, 'b')
  assert.equal(existsSync(join(root, '.builder/fleet/inbox/b')), false)
})

test('a parked feature named again while the fleet runs is unparked and re-queued', async () => {
  const root = makeRepo(['a', 'p'])
  const scenario = { a: ['CHATTY:2500:audited', ...HAPPY.slice(1)], p: ['BLOCK:"needs a human — next: /builder:agent"', ...HAPPY] }
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const fleet = spawn('node', [FLEET, 'a', 'p', '--parallel', '2'], { cwd: root, stdio: 'ignore', env: ENV(root, { FLEET_INBOX_POLL_MS: '100' }) })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  const fj = () => JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  await until(() => existsSync(join(root, '.builder/fleet/fleet.json')) && fj().features.p?.status === 'parked', 'p never parked')
  // Named again with its block still set: the running fleet clears it and retries.
  const add = runFleet(root, ['p'], scenario)
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /↳ p — re-queued for the running fleet/)
  assert.equal(await exited, 0)
  assert.equal(fj().features.p, undefined)
  assert.ok(archiveOf(root).p)
  assert.match(git(root, 'log', '--format=%s', 'main'), /^chore\(p\): unparked for a fleet retry — was: needs a human — next: \/builder:agent$/m)
  assert.match(readFileSync(join(root, '.stub/calls.log'), 'utf8'), /^start p build .*prior=yes/m, 'the run after the unpark is told why it parked')
})

test('naming a parked feature again unparks it: the block is cleared in a commit and the next run is told why', () => {
  const root = makeRepo(['a'])
  const scenario = { a: ['audited', 'BLOCK:plan wants to split — next: /builder:agent', 'planned', 'READY-PENDING', 'verified', 'SHIP'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked')
  const dry = runFleet(root, ['a', '--dry-run'], scenario)
  assert.match(dry.stdout, /↻ a — unparks and retries — it was parked: plan wants to split/)
  const second = runFleet(root, ['a'], scenario)
  assert.equal(second.status, 0, second.stderr)
  assertLanded(second, 'a')
  assert.match(git(root, 'log', '--format=%s', 'main'), /^chore\(a\): unparked for a fleet retry — was: plan wants to split — next: \/builder:agent$/m)
  const starts = second.calls.filter((l) => l.startsWith('start'))
  assert.match(starts[2], /prior=yes/, 'the first run after the unpark carries the old reason')
  assert.match(starts[0], /prior=-/, 'the first fleet run had nothing to carry')
})

test('a spec blocked where it was written is admitted when named, and unparked in its worktree', () => {
  const root = makeRepo(['b'])
  const mf = join(root, 'docs/features/b/MANIFEST.md')
  writeFileSync(mf, `${readFileSync(mf, 'utf8')}blocked: "agent walk failed twice — the items still failing — clears when a human walks it"\n`)
  git(root, 'commit', '-qam', 'b parked by an older builder')
  const dry = runFleet(root, ['b', '--dry-run'], { b: HAPPY })
  assert.match(dry.stdout, /✓ b → builder\/b — unparks it — it was parked: agent walk failed twice/)
  const r = runFleet(root, ['b'], { b: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'b')
})

test('a parked feature not named stays parked', () => {
  const root = makeRepo(['a', 'b'])
  const first = runFleet(root, ['a', 'b'], { a: ['BLOCK:x — next: y'], b: ['BLOCK:x — next: y'] })
  assert.equal(first.fleet.features.a.status, 'parked')
  const second = runFleet(root, ['b'], { a: ['BLOCK:x — next: y'], b: ['BLOCK:x — next: y', 'audited', 'planned', 'READY-PENDING', 'verified', 'SHIP'] })
  assert.equal(second.fleet.features.a.status, 'parked', 'a was not named')
  assertLanded(second, 'b')
})

test('unparking starts the agent walk round cap over: rounds walked before it are recorded as history', () => {
  const root = makeRepo(['w'])
  const scenario = { w: ['READY-PENDING', 'BLOCK:agent walk failed five rounds — next: a human walk', 'BLOCK:still failing — next: a human walk'] }
  const first = runFleet(root, ['w'], scenario)
  const wt = first.fleet.features.w.worktree
  for (const n of [1, 2, 5]) mkdirSync(join(wt, `.builder/w/agent-walk/round-${n}`), { recursive: true })
  const second = runFleet(root, ['w'], scenario)
  assert.equal(second.fleet.features.w.status, 'parked')
  assert.equal(readFileSync(join(wt, '.builder/w/agent-walk/unparked-after'), 'utf8'), '5\n')
})

// ---- the park record and automatic retries -----------------------------------------------

const wtFile = (r, feature, name) => join(r.fleet.features[feature].worktree, 'docs/features', feature, name)

test('a park is retried automatically, up to agent_walk.auto_unpark times in one fleet run', () => {
  const root = makeRepo(['a'], { lines: ['auto_unpark: 1'] })
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:plan wants to split — next: /builder:agent', 'planned', 'READY-PENDING', 'verified', 'SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'a')
  const log = git(root, 'log', '--format=%s', 'main')
  assert.match(log, /^chore\(a\): unparked for a fleet retry — was: plan wants to split/m)
  assert.match(r.calls.filter((l) => l.startsWith('start'))[2], /prior=yes/)
})

test('an automatic retry stops at the cap and the feature stays parked with the newest reason', () => {
  const root = makeRepo(['a'], { lines: ['auto_unpark: 1'] })
  const r = runFleet(root, ['a'], { a: ['BLOCK:first — next: x', 'BLOCK:second — next: y'] })
  assert.equal(r.fleet.features.a.status, 'parked')
  assert.equal(r.fleet.features.a.reason, 'second — next: y')
  assert.equal(r.calls.filter((l) => l.startsWith('start')).length, 2)
})

test('a human-step park is never retried automatically', () => {
  const root = makeRepo(['a'], { lines: ['auto_unpark: 2'] })
  const r = runFleet(root, ['a'], { a: ['PARK-HUMAN:the web app commits by hand — next: commit phase 2, then /builder:agent', 'audited'] })
  assert.equal(r.fleet.features.a.status, 'parked')
  assert.equal(r.calls.filter((l) => l.startsWith('start')).length, 1)
})

test('low persistence (rush) gets no automatic retry', () => {
  const root = makeRepo(['a'], { lines: ['auto_unpark: 2'], manifest: ['profile: rush'] })
  const r = runFleet(root, ['a'], { a: ['BLOCK:stuck', 'audited'] })
  assert.equal(r.fleet.features.a.status, 'parked')
  assert.equal(r.calls.filter((l) => l.startsWith('start')).length, 1)
  assert.equal(r.calls.filter((l) => /unpark/.test(l)).length, 0)
})

test('a park waiting for your walk is a human step, never retried', () => {
  const root = makeRepo(['a'], { lines: ['auto_unpark: 2'], manifest: ['profile: thorough-you'] })
  const reason = 'waiting for your walk — next: /builder:resume --path docs/features/a'
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:' + reason, 'planned'] })
  assert.equal(r.fleet.features.a.status, 'parked')
  assert.equal(r.fleet.features.a.reason, reason)
  assert.equal(r.calls.filter((l) => l.startsWith('start')).length, 2, 'the audited run and the parking run, no retry')
  assert.match(readFileSync(wtFile(r, 'a', 'PARKED.md'), 'utf8'), /^kind: human-step$/m)
})

test('the fleet writes a park record when the parking run left none; an unpark adds to its history', () => {
  const root = makeRepo(['a'])
  const first = runFleet(root, ['a'], { a: ['audited', 'BLOCK:the pane opens on a struck preview — next: a human walk'] })
  const rec = readFileSync(wtFile(first, 'a', 'PARKED.md'), 'utf8')
  assert.match(rec, /^# a — parked$/m)
  assert.match(rec, /^kind: stuck$/m)
  assert.match(rec, /^blocked: "the pane opens on a struck preview — next: a human walk"$/m)
  assert.match(rec, /^## What is stuck\nthe pane opens on a struck preview$/m)
  assert.match(rec, /^## Evidence\n- the run that parked it: .*a-02\.log/m)
  assert.match(rec, /^## Recommended next step\na human walk$/m)
  assert.match(rec, /^## History\n- \d{4}-\d{2}-\d{2} parked — the pane opens on a struck preview$/m)
  assert.equal(git(first.fleet.features.a.worktree, 'status', '--porcelain', '--', 'docs'), '', 'the record is committed')
  const second = runFleet(root, ['a'], { a: ['audited', 'BLOCK:the pane opens on a struck preview — next: a human walk', 'BLOCK:still the pane — next: a human walk'] })
  const again = readFileSync(wtFile(second, 'a', 'PARKED.md'), 'utf8')
  assert.match(again, /unparked by a person — named to \/builder:agent or \/builder:fleet/)
  assert.match(again, /^blocked: "still the pane — next: a human walk"$/m, 'the second park rewrote the record')
  assert.match(again, /parked — the pane opens on a struck preview[\s\S]*parked — still the pane/, 'history kept growing')
})

test('a park record the parking run wrote itself is kept as written', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: ['PARK-RECORD:the pane default — next: a human walk'] })
  assert.match(readFileSync(wtFile(r, 'a', 'PARKED.md'), 'utf8'), /written by the run/)
})

test('a feature already in the archive is refused as shipped', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'docs/features/_archive/z'), { recursive: true })
  writeFileSync(join(root, 'docs/features/_archive/z/SPEC.md'), '# z — spec\n> ✅ SHIPPED 2026-09-01 — PR #3 · none\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'z archived')
  const r = runFleet(root, ['z', '--dry-run'], {})
  assert.match(r.stdout, /✗ z — .*already shipped/)
})

test('a child whose dependency landed in an earlier fleet run starts at once', () => {
  const root = makeRepo(['api', 'ui'])
  program(root, ['api', 'ui'], { ui: 'api' })
  assertLanded(runFleet(root, ['api'], { api: HAPPY }), 'api')
  const r = runFleet(root, ['ui'], { ui: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'ui')
})

test('a done row an older fleet left is archived on the next run, its logs with it', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet/logs'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/logs/old-01.log'), 'x')
  writeFileSync(join(root, '.builder/fleet/logs/old-b-01.log'), 'another feature')
  writeFileSync(
    join(root, '.builder/fleet/fleet.json'),
    JSON.stringify({ target: 'release', features: { old: { status: 'done', runs: 5, branch: 'builder/old', worktree: null, pr: '#9', reason: null, merged: 'abc1234' } } })
  )
  const r = runFleet(root, [], {})
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.fleet.features, {})
  assert.equal(r.fleet.archived, 1)
  assert.deepEqual({ ...r.archived.old, landedAt: '-' }, { feature: 'old', branch: 'builder/old', target: 'release', merged: 'abc1234', pr: '#9', runs: 5, runsThisTime: 0, timing: [], lanes: {}, size: null, profile: 'thorough', tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0, landedAt: '-' })
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/old/old-01.log')))
  assert.ok(existsSync(join(root, '.builder/fleet/logs/old-b-01.log')), 'a feature whose name starts the same keeps its logs')
})

test('--status --archived lists the latest landings', () => {
  const root = makeRepo(['a', 'b'])
  runFleet(root, ['a', 'b'], { a: HAPPY, b: HAPPY })
  const st = runFleet(root, ['--status'], {})
  assert.match(st.stdout, /^2 archived \(last: [ab], just now\) · --status --archived for the latest 20$/m)
  const ar = runFleet(root, ['--status', '--archived', '1'], {})
  assert.equal(ar.status, 0, ar.stderr)
  assert.match(ar.stdout, /# builder fleet — archive: latest 1 of 2/)
  assert.match(ar.stdout, /\| [ab] \| thorough \| \d+s \| 9k \| [0-9a-f]{7,} \| — \| just now \|/)
  const none = runFleet(makeRepo(['c']), ['--status', '--archived'], {})
  assert.match(none.stdout, /No feature has landed from this fleet yet\./)
})

test('archived logs older than keep_logs are pruned at fleet start', () => {
  const root = makeRepo(['a'], { lines: ['keep_logs: 1'] })
  const base = join(root, '.builder/fleet/logs/_archive')
  for (const n of ['stale', 'fresh']) {
    mkdirSync(join(base, n), { recursive: true })
    writeFileSync(join(base, n, `${n}-01.log`), 'x')
  }
  const old = new Date(Date.now() - 3 * 86400000)
  utimesSync(join(base, 'stale'), old, old)
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(join(base, 'stale')), false)
  assert.ok(existsSync(join(base, 'fresh')))
  assert.ok(existsSync(join(base, 'a', 'a-01.log')), 'this run’s landing is archived after the prune')
})

test('--pause parks a feature at its next run with a reason starting revising', async () => {
  const root = makeRepo(['a'])
  const scenario = { a: ['audited', 'SLOW:planned', 'building'] }
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const fleet = spawn('node', [FLEET, 'a'], { cwd: root, stdio: 'ignore', env: ENV(root, { STUB_SLOW_MS: '2500', FLEET_KEEP_STOPPED_WORKTREES: '1' }) })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  const calls = join(root, '.stub/calls.log')
  await until(() => existsSync(calls), 'a never started')
  const p = runFleet(root, ['--pause', 'a'], scenario, { STUB_SLOW_MS: '2500' })
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /pause requested: a/)
  assert.equal(existsSync(join(root, '.builder/fleet/requests/a.pause')), true)
  await exited
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.equal(fj.features.a.status, 'parked')
  assert.match(fj.features.a.reason, /^revising — next: \/builder:revise --path docs\/features\/a$/)
  const steps = readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('start'))
  assert.ok(steps.length <= 2, `runs stopped before building: ${steps.length} starts`)
  assert.match(readFileSync(wtFile({ fleet: fj }, 'a', 'PARKED.md'), 'utf8'), /^kind: human-step$/m)
})

test('--pause on a feature that is not in the fleet says so and writes nothing', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['--pause', 'zzz'], {})
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /nothing to pause/)
  assert.equal(existsSync(join(root, '.builder/fleet/requests/zzz.pause')), false)
  const bad = runFleet(root, ['--pause', '../x'], {})
  assert.notEqual(bad.status, 0)
})

test('naming a paused feature again deletes the request and carries it to merged', () => {
  const root = makeRepo(['a'])
  const first = runFleet(root, ['a'], { a: ['audited', 'BLOCK:stuck — next: x'] })
  assert.equal(first.fleet.features.a.status, 'parked')
  const p = runFleet(root, ['--pause', 'a'], {})
  assert.match(p.stdout, /pause requested: a/)
  const req = join(root, '.builder/fleet/requests/a.pause')
  assert.equal(existsSync(req), true)
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(existsSync(req), false, 'the request is gone')
  assertLanded(r, 'a')
})

test('a pause filed while the feature heads for the walk lane parks it before reset, start or stop', async () => {
  const root = makeRepo(['a'], { reset: 'touch reset-ran', stop: 'touch stop-ran', lines: ['start: touch start-ran; sleep 30', 'smoke: test -f start-ran'] })
  const scenario = { a: ['SLOW:READY-PENDING', 'BLOCK:walked'] }
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const fleet = spawn('node', [FLEET, 'a'], { cwd: root, stdio: 'ignore', env: ENV(root, { STUB_SLOW_MS: '2500', FLEET_KEEP_STOPPED_WORKTREES: '1' }) })
  const exited = new Promise((r) => fleet.on('exit', (code) => r(code)))
  await until(() => existsSync(join(root, '.stub/calls.log')), 'a never started')
  const p = runFleet(root, ['--pause', 'a'], scenario)
  assert.match(p.stdout, /pause requested: a$/m)
  await exited
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.equal(fj.features.a.status, 'parked')
  assert.match(fj.features.a.reason, /^revising/)
  const wt = fj.features.a.worktree
  for (const f of ['reset-ran', 'start-ran', 'stop-ran']) assert.equal(existsSync(join(wt, f)), false, `${f} never ran`)
  assert.equal(readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n').filter((l) => l.startsWith('start')).length, 1, 'one run only')
})

test('--pause with no fleet running says so; an inherited name is not a feature', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: ['audited', 'BLOCK:stuck — next: x'] })
  const p = runFleet(root, ['--pause', 'a'], {})
  assert.match(p.stdout, /pause requested: a — no fleet is running; it parks when the fleet next runs it/)
  const c = runFleet(root, ['--pause', 'constructor'], {})
  assert.match(c.stdout, /nothing to pause/)
})

// ---- 4.9.0 final review ------------------------------------------------------------------------

test('every run is told where the fleet keeps its requests: BUILDER_FLEET_DIR, which agent_walk.env cannot move', () => {
  const root = makeRepo(['a'], { lines: ['env: BUILDER_FLEET_DIR=/nope'] })
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const starts = r.calls.filter((l) => l.startsWith('start'))
  assert.ok(starts.some((l) => / walk /.test(l)), 'a walk-lane run was checked')
  for (const l of starts) {
    const dir = / fleet_dir=(\S+)/.exec(l)?.[1]
    assert.ok(dir === join(root, '.builder/fleet') || dir === join(realpathSync(root), '.builder/fleet'), l)
  }
})

test('a pause filed while a shipped feature waits to merge parks it as revising; it does not land', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'docs/features/_archive/a'), { recursive: true })
  writeFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'my local edit\n')
  const first = runFleet(root, ['a'], { a: HAPPY })
  assert.match(first.fleet.features.a.reason, /your uncommitted changes are in the way/)
  unlinkSync(join(root, 'docs/features/_archive/a/SPEC.md'))
  assert.match(runFleet(root, ['--pause', 'a'], {}).stdout, /pause requested: a/)
  const second = runFleet(root, [], { a: HAPPY })
  assert.equal(second.fleet.features.a.status, 'parked')
  assert.match(second.fleet.features.a.reason, /^revising — next: \/builder:revise --path docs\/features\/a$/)
  assert.equal(second.archived.a, undefined, 'not landed')
  assert.doesNotMatch(git(root, 'log', '--oneline', '-1', 'main'), /merge\(a\)/)
})

test('a feature that already landed on the target is refused, naming the merge that brings it in', () => {
  const root = makeRepo(['a'])
  git(root, 'checkout', '-q', '-b', 'work')
  assertLanded(runFleet(root, ['a'], { a: HAPPY }), 'a')
  assert.ok(existsSync(join(root, 'docs/features/a/MANIFEST.md')), 'work still holds the live copy')
  const dry = runFleet(root, ['a', '--dry-run'], {})
  assert.match(dry.stdout, /✗ a — a already landed on main — merge main into this branch to pick up the shipped spec/)
})

test('a feature archive.jsonl says landed is refused even when the target holds no archived folder', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/archive.jsonl'), JSON.stringify({ feature: 'a', target: 'main', merged: 'abc1234' }) + '\n')
  const dry = runFleet(root, ['a', '--dry-run'], {})
  assert.match(dry.stdout, /✗ a — a already landed on main — merge main into this branch/)
})

test('a go-ahead whose target is not this run’s is refused, naming the --into that runs it', () => {
  const root = makeRepo(['a'], { manifest: ['target: release'] })
  git(root, 'branch', 'release')
  const dry = runFleet(root, ['a', '--dry-run'], {})
  assert.match(dry.stdout, /✗ a — a's go-ahead lands it on release — run with --into release/)
  const into = runFleet(root, ['a', '--into', 'release', '--dry-run'], {})
  assert.match(into.stdout, /✓ a → builder\/a/)
  const none = makeRepo(['b'], { manifest: ['target: none'] })
  assert.match(runFleet(none, ['b', '--dry-run'], {}).stdout, /✓ b → builder\/b/)
})

test('a feature waiting for your walk keeps its worktree when the fleet ends', () => {
  const root = makeRepo(['a'], { manifest: ['profile: thorough-you'] })
  const reason = 'waiting for your walk — next: /builder:resume --path docs/features/a'
  const r = runFleet(root, ['a'], { a: ['audited', 'BLOCK:' + reason] }, { FLEET_KEEP_STOPPED_WORKTREES: '0' })
  assert.equal(r.fleet.features.a.status, 'parked')
  assert.ok(r.fleet.features.a.worktree && existsSync(r.fleet.features.a.worktree), 'the worktree your walk runs in stays')
  const other = makeRepo(['b'])
  const s = runFleet(other, ['b'], { b: ['audited', 'BLOCK:stuck — next: x'] }, { FLEET_KEEP_STOPPED_WORKTREES: '0' })
  assert.equal(s.fleet.features.b.worktree, null, 'any other park still loses its worktree')
})

// ---- 4.9.2: migrations a landing brings reach the dev DB this checkout serves ----------------
function readinessRepo(mode, sql = 'CREATE TABLE "a" ();') {
  const root = makeRepo(['a'])
  const cfg = join(root, '.claude/builder.md')
  const apply = `node -e "require('fs').writeFileSync('applied.txt','yes')"`
  const regen = `node -e "require('fs').writeFileSync('regenerated.txt','yes')"`
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('---\nbody\n',
    `---\n\n## Walk readiness\n\n\`\`\`\nmigrations: db/migrations\napply:      ${apply}\napply_mode: ${mode}   # test\nregenerate: ${regen}\n\`\`\`\n`))
  git(root, 'commit', '-qam', 'readiness')
  git(root, 'checkout', '-q', '-b', 'builder/a')
  mkdirSync(join(root, 'db/migrations/001'), { recursive: true })
  writeFileSync(join(root, 'db/migrations/001/migration.sql'), sql)
  git(root, 'add', 'db')
  git(root, 'commit', '-qm', 'a migration')
  git(root, 'checkout', '-q', 'main')
  return root
}

test('a landing that brings a migration applies it here under apply_mode agent, then regenerates', () => {
  const root = readinessRepo('agent')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assertLanded(r, 'a')
  assert.ok(existsSync(join(root, 'applied.txt')), 'apply ran in the main checkout')
  assert.ok(existsSync(join(root, 'regenerated.txt')), 'regenerate ran after it')
  assert.ok(r.fleet.notes.some((n) => /a: applied 1 new migration to the dev DB here/.test(n)), JSON.stringify(r.fleet.notes))
})

test('apply_mode ask leaves a note naming the command; a drop is never run under agent', () => {
  const ask = readinessRepo('ask')
  const r = runFleet(ask, ['a'], { a: HAPPY })
  assertLanded(r, 'a')
  assert.ok(!existsSync(join(ask, 'applied.txt')))
  assert.ok(r.fleet.notes.some((n) => /⚠ a: 1 new migration landed — the dev DB is behind: run/.test(n)), JSON.stringify(r.fleet.notes))
  const drop = readinessRepo('agent', 'DROP TABLE "a";')
  const d = runFleet(drop, ['a'], { a: HAPPY })
  assertLanded(d, 'a')
  assert.ok(!existsSync(join(drop, 'applied.txt')))
  assert.ok(d.fleet.notes.some((n) => /drops or rewrites data, so it was not applied/.test(n)), JSON.stringify(d.fleet.notes))
})

// ---- agents never take a feature a session is building, or one branch several features share ----
test('a feature a session is building is refused; one only specced in a session is not', () => {
  const root = makeRepo(['a', 's'])
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: building\ngo-ahead: x\nnext: x\n')
  git(root, 'commit', '-qam', 'building')
  for (const f of ['a', 's']) {
    mkdirSync(join(root, '.builder', f), { recursive: true })
    writeFileSync(join(root, '.builder', f, 'ledger.md'), 'x\n')
  }
  const r = runFleet(root, ['a', 's', '--dry-run'], {})
  assert.match(r.stdout + r.stderr, /docs\/features\/a is being built in a session right now/)
  assert.doesNotMatch(r.stdout + r.stderr, /docs\/features\/s is being built/)
})

test('a built feature on a branch other unfinished features share is refused, naming them', () => {
  const root = makeRepo(['a', 'b'])
  git(root, 'branch', 'feat/x')
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: built\nbranch: feat/x\nnext: x\n')
  writeFileSync(join(root, 'docs/features/b/MANIFEST.md'), 'size: md\nstate: building\nbranch: feat/x\nnext: x\n')
  git(root, 'commit', '-qam', 'shared')
  const r = runFleet(root, ['a', '--dry-run'], {})
  assert.match(r.stdout + r.stderr, /docs\/features\/a is on feat\/x with b — .* merge feat\/x into main first/)
})
