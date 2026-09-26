import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLEET = join(HERE, '..', 'fleet.mjs')
const STUB = join(HERE, 'fixtures', 'stub-claude.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function makeRepo(features, { reset, stop } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  const hooks = [reset && `  reset: ${reset}`, stop && `  stop: ${stop}`].filter(Boolean).join('\n')
  writeFileSync(
    join(root, '.claude/builder.md'),
    `---\nproject: fleet-test\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto\n` +
      `agent_walk:\n  driver: none\n  claude_args: --stub-flag\n  worktrees: ${root}-wt\n${hooks}\n---\nbody\n`
  )
  for (const f of features) {
    mkdirSync(join(root, 'docs/features', f), { recursive: true })
    writeFileSync(join(root, 'docs/features', f, 'MANIFEST.md'), `size: md\nstate: spec\nnext: /builder:resume --path docs/features/${f}\n`)
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
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FLEET_CLAUDE: STUB, STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), ...env },
  })
  const fj = join(root, '.builder/fleet/fleet.json')
  const calls = existsSync(join(root, '.stub/calls.log')) ? readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n') : []
  return { ...r, fleet: existsSync(fj) ? JSON.parse(readFileSync(fj, 'utf8')) : null, calls }
}

const HAPPY = ['audited', 'planned', 'building', 'READY-PENDING', 'built', 'verified', 'PR:#1']

test('a spec goes from spec to a draft PR through both lanes', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const a = r.fleet.features.a
  assert.equal(a.status, 'done')
  assert.equal(a.pr, '#1')
  assert.equal(a.runs, 7)
  assert.equal(git(a.worktree, 'branch', '--show-current'), 'builder/a')
  const lanes = r.calls.filter((l) => l.startsWith('start')).map((l) => l.split(' ')[2])
  assert.deepEqual(lanes, ['build', 'build', 'build', 'build', 'walk', 'walk', 'walk'])
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /\| a \| done \| 7 \| #1 \|/)
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

test('a run that fails twice fails, naming the log', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', 'FAIL'] })
  assert.equal(r.fleet.features.d.status, 'failed')
  assert.match(r.fleet.features.d.reason, /failed \(exit 3\) twice — see .*d-02\.log/)
})

test('a run that fails once is retried and carries on', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', ...HAPPY] })
  assert.equal(r.fleet.features.d.status, 'done')
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

test('walk lane runs one feature at a time', () => {
  const root = makeRepo(['w1', 'w2', 'w3'])
  const slow = ['READY-PENDING', 'SLOW:built', 'SLOW:verified', 'SLOW:PR:#9']
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
  const scenario = { a: ['audited', 'BLOCK:plan wants to split', 'planned', 'READY-PENDING', 'PR:#2'] }
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
  assert.equal(second.fleet.features.a.status, 'done')
  assert.equal(second.fleet.features.a.pr, '#2')
  assert.equal(second.fleet.features.a.runs, 5, 'run count continues across fleet runs')
  assert.equal(second.fleet.features.a.runsThisTime, 3, 'the cap counts this fleet run only')
})

test('a feature parked at the run cap gets a fresh cap on the next fleet run', () => {
  const root = makeRepo(['a'])
  const churn = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'planned' : 'audited'))
  const scenario = { a: [...churn, 'building', 'READY-PENDING', 'verified', 'PR:#8'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked')
  assert.match(first.fleet.features.a.reason, /run cap \(12\) reached/)
  const second = runFleet(root, [], scenario)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.fleet.features.a.status, 'done')
  assert.equal(second.fleet.features.a.pr, '#8')
  assert.equal(second.fleet.features.a.runs, 16, 'lifetime runs for the table')
  assert.equal(second.fleet.features.a.runsThisTime, 4)
})

test('a worktree on another branch is refused, the rest proceed', () => {
  const root = makeRepo(['a', 'g'])
  git(root, 'worktree', 'add', '-q', '-b', 'other', `${root}-wt/g`)
  const r = runFleet(root, ['a', 'g'], { a: HAPPY })
  assert.match(r.stderr, /g — .*exists on branch 'other'/)
  assert.equal(r.fleet.features.g, undefined)
  assert.equal(r.fleet.features.a.status, 'done')
})

test('--dry-run creates nothing', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--dry-run'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /draft PRs/i)
  assert.match(r.stdout, /✓ a → builder\/a/)
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(r.calls.length, 0)
})

test('refusals: uncommitted, already has a PR, branch checked out here', () => {
  const root = makeRepo(['a', 'h', 'k'])
  writeFileSync(join(root, 'docs/features/h/MANIFEST.md'), 'size: md\nstate: verified\npr: #3\nnext: x\n')
  writeFileSync(join(root, 'docs/features/k/MANIFEST.md'), 'size: md\nstate: building\nbranch: feat/k\nnext: x\n')
  git(root, 'commit', '-qam', 'h has a PR, k underway')
  git(root, 'switch', '-q', '-c', 'feat/k')
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nnext: x\n')
  const r = runFleet(root, ['a', 'h', 'k', '--dry-run'], {})
  assert.match(r.stdout, /✗ a — .*uncommitted changes/)
  assert.match(r.stdout, /✗ h — .*already has a PR \(#3\)/)
  assert.match(r.stdout, /✗ k — feat\/k is checked out in this folder/)
})

test('a feature already underway continues on its own branch, in the lane it is in', () => {
  const root = makeRepo(['u'])
  git(root, 'switch', '-q', '-c', 'feat/u')
  writeFileSync(join(root, 'docs/features/u/MANIFEST.md'), 'size: md\nstate: built\nready: yes 2026-09-26 abc\nbranch: feat/u\nnext: x\n')
  git(root, 'commit', '-qam', 'u built')
  git(root, 'switch', '-q', 'main')
  git(root, 'merge', '-q', '--ff-only', 'feat/u')
  const r = runFleet(root, ['u'], { u: ['verified', 'PR:#4'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.u.branch, 'feat/u')
  assert.equal(git(r.fleet.features.u.worktree, 'branch', '--show-current'), 'feat/u')
  assert.ok(r.calls.filter((l) => l.startsWith('start')).every((l) => l.split(' ')[2] === 'walk'), 'went straight to the walk lane')
  assert.equal(r.fleet.features.u.pr, '#4')
})

test('a planned feature joins the build lane where it is', () => {
  const root = makeRepo(['p'])
  writeFileSync(join(root, 'docs/features/p/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: auto (recommended) 2026-09-26\nnext: x\n')
  git(root, 'commit', '-qam', 'p planned')
  const r = runFleet(root, ['p'], { p: ['building', 'READY-PENDING', 'verified', 'PR:#6'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.p.branch, 'builder/p')
  assert.equal(r.fleet.features.p.runs, 4)
})

test('a manifest branch: before planned is the spec branch, not a build branch', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nbranch: specs/batch\nnext: x\n')
  git(root, 'commit', '-qam', 'a audited on the spec branch')
  const r = runFleet(root, ['a', '--dry-run'], {})
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ a → builder\/a/)
})

test('two features resolving to one branch: the second is refused', () => {
  const root = makeRepo(['p1', 'p2'])
  for (const f of ['p1', 'p2']) writeFileSync(join(root, `docs/features/${f}/MANIFEST.md`), 'size: md\nstate: planned\nbranch: feat/shared\nnext: x\n')
  git(root, 'commit', '-qam', 'both planned on one branch')
  git(root, 'branch', 'feat/shared')
  const r = runFleet(root, ['p1', 'p2', '--dry-run'], {})
  assert.match(r.stdout, /✓ p1 → feat\/shared/)
  assert.match(r.stdout, /✗ p2 — p1 and p2 both resolve to branch feat\/shared/)
})

test('a second fleet is refused while one holds the lock', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/lock'), String(process.pid))
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /Another fleet is running/)
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
    assert.equal(r.fleet.features.a.pgid, undefined, 'no pgid left recorded once runs settle')
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

test('--status prints the last table', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: HAPPY })
  const r = runFleet(root, ['--status'], {})
  assert.match(r.stdout, /\| a \| done/)
})

test('no agent_walk block refuses with the fix', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  const r = runFleet(root, ['a'], {})
  assert.equal(r.status, 2)
  assert.match(r.stderr, /\/builder:init --update/)
})
