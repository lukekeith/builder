import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync, unlinkSync } from 'node:fs'
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
function makeRepo(features, { reset, stop, lines = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  const hooks = [reset && `  reset: ${reset}`, stop && `  stop: ${stop}`, ...lines.map((l) => `  ${l}`)].filter(Boolean).join('\n')
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

const HAPPY = ['audited', 'planned', 'building', 'READY-PENDING', 'built', 'signed-off', 'verified', 'SHIP']

test('a feature with an open PR is taken on to merged, not refused', () => {
  const root = makeRepo(['o'])
  writeFileSync(join(root, 'docs/features/o/MANIFEST.md'), 'size: md\nstate: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc\npr: #5\nbranch: builder/o\nnext: x\n')
  git(root, 'commit', '-qam', 'o has a draft PR')
  const r = runFleet(root, ['o'], { o: ['SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.o.status, 'done')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(o\): agent-verified, not human-tested/)
  assert.match(r.calls[0], /^start o build /, 'the ship lane, without the dev env')
})

test('a spec goes from spec to merged through the build, walk and ship lanes', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const a = r.fleet.features.a
  assert.equal(a.status, 'done')
  assert.equal(a.runs, 8)
  // The stub reports a --no-dev-env run as 'build': the ship lane runs without the dev env too.
  const lanes = r.calls.filter((l) => l.startsWith('start')).map((l) => l.split(' ')[2])
  assert.deepEqual(lanes, ['build', 'build', 'build', 'build', 'walk', 'walk', 'walk', 'build'])
  assert.ok(r.calls.filter((l) => l.startsWith('end')).every((l) => l.endsWith('into=main')), 'every run is told the target')
  // Landed on the branch the fleet ran from, as one merge commit; the worktree and branch are gone.
  assert.equal(git(root, 'branch', '--show-current'), 'main')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(a\): agent-verified, not human-tested/)
  assert.match(readFileSync(join(root, 'docs/features/a/SPEC.md'), 'utf8'), /SHIPPED/)
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(git(root, 'branch', '--list', 'builder/a'), '')
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /\| a \| done \| 8 \|/)
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
  assert.equal(r.fleet.features.c2.status, 'done', r.fleet.features.c2.reason)
})

test('a run that keeps talking outlives the idle timeout; a silent one does not', () => {
  const root = makeRepo(['t1', 't2'])
  const env = { FLEET_IDLE_TIMEOUT_MS: '400' }
  const r = runFleet(root, ['t1', 't2'], { t1: ['CHATTY:1200:audited', ...HAPPY.slice(1)], t2: ['HANG', 'HANG'] }, env)
  assert.equal(r.fleet.features.t1.status, 'done', r.fleet.features.t1.reason)
  assert.equal(r.fleet.features.t2.status, 'failed')
  assert.match(r.fleet.features.t2.reason, /timed out twice/)
  const log = readFileSync(join(root, '.builder/fleet/logs/t1-01.log'), 'utf8')
  assert.match(log, /· still working/)
  assert.match(log, /did audited/)
  assert.equal(log.match(/did audited/g).length, 1, 'the result repeating the last assistant text is printed once')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/t1-01.jsonl')))
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
  assert.equal(second.fleet.features.a.status, 'done')
  assert.equal(second.fleet.features.a.runs, 6, 'run count continues across fleet runs')
  assert.equal(second.fleet.features.a.runsThisTime, 4, 'the cap counts this fleet run only')
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
  assert.equal(second.fleet.features.a.status, 'done')
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
  assert.match(r.stdout, /✓ k → builder\/k/)
  assert.match(r.stdout, /merges into: feat\/k/)
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
  assert.equal(r.fleet.features.u.branch, 'feat/u')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(u\)/)
  assert.ok(git(root, 'branch', '--list', 'feat/u'), 'a branch the fleet did not create is kept')
  assert.equal(r.calls.find((l) => l.startsWith('start')).split(' ')[2], 'walk', 'went straight to the walk lane')
})

test('a planned feature joins the build lane where it is', () => {
  const root = makeRepo(['p'])
  writeFileSync(join(root, 'docs/features/p/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: auto (recommended) 2026-09-26\nnext: x\n')
  git(root, 'commit', '-qam', 'p planned')
  const r = runFleet(root, ['p'], { p: ['building', 'READY-PENDING', 'verified', 'SHIP'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.p.branch, 'builder/p')
  assert.equal(r.fleet.features.p.runs, 4)
})

test('a manifest branch: before building is the spec branch, not a build branch', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nbranch: specs/batch\nnext: x\n')
  git(root, 'commit', '-qam', 'a audited on the spec branch')
  const r = runFleet(root, ['a', '--dry-run'], {})
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ a → builder\/a/)
})

test('two features resolving to one branch: the second is refused', () => {
  const root = makeRepo(['p1', 'p2'])
  for (const f of ['p1', 'p2']) writeFileSync(join(root, `docs/features/${f}/MANIFEST.md`), 'size: md\nstate: building\nbranch: feat/shared\nnext: x\n')
  git(root, 'commit', '-qam', 'both building on one branch')
  git(root, 'branch', 'feat/shared')
  const r = runFleet(root, ['p1', 'p2', '--dry-run'], {})
  assert.match(r.stdout, /✓ p1 → feat\/shared/)
  assert.match(r.stdout, /✗ p2 — p1 and p2 both resolve to branch feat\/shared/)
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

test('a target sync that conflicts parks the feature, naming the cause', () => {
  const root = makeRepo(['u'])
  laggingBranch(root, 'u', () => {
    git(root, 'switch', '-q', 'feat/u')
    writeFileSync(join(root, 'shared.txt'), 'theirs\n')
    git(root, 'commit', '-qam', 'u edits shared')
    git(root, 'switch', '-q', 'main')
    writeFileSync(join(root, 'shared.txt'), 'ours\n')
  })
  const r = runFleet(root, ['u'], { u: HAPPY })
  assert.equal(r.fleet.features.u.status, 'parked')
  assert.match(r.fleet.features.u.reason, /merging main \(what other features merged\) conflicted/)
  assert.equal(r.calls.length, 0, 'no run on a tree that could not be synced')
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
  assert.equal(r.fleet.features.s.status, 'done')
  assert.equal(r.fleet.features.s.startPgid, undefined)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
  assert.ok(existsSync(join(root, '.builder/fleet/logs/s-start.log')), 'start output is logged')
})

test('start is killed even when the walk parks', async () => {
  const { root, pidFile } = await walkEnvRepo('s')
  const r = runFleet(root, ['s'], { s: ['READY-PENDING', 'BLOCK:agent walk failed twice'] }, FAST)
  assert.equal(r.fleet.features.s.status, 'parked')
  assert.equal(r.fleet.features.s.reason, 'agent walk failed twice')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
})

test('a smoke that never passes parks the feature and skips the walk', async () => {
  const { root, pidFile } = await walkEnvRepo('s', { smoke: 'exit 1' })
  const r = runFleet(root, ['s'], { s: HAPPY }, { ...FAST, FLEET_SMOKE_TIMEOUT_MS: '1500' })
  assert.equal(r.fleet.features.s.status, 'parked')
  assert.match(r.fleet.features.s.reason, /^walk env didn't come up — see .*s-start\.log$/)
  assert.equal(r.calls.filter((l) => l.split(' ')[2] === 'walk').length, 0, 'no walk-lane run')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(alive(pid), false, 'the start process is gone')
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
  assert.equal(r.fleet.features.api.status, 'done')
  assert.equal(r.fleet.features.ui.status, 'done')
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
  assert.equal(r.fleet.features.ui.reason, 'waits on api (parked)')
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
  writeFileSync(join(root, 'docs/features/a/SPEC.md'), 'my local edit\n') // the ship writes SPEC.md
  const first = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(first.fleet.features.a.status, 'parked')
  assert.match(first.fleet.features.a.reason, /merging into main failed: .* — clears when that is fixed; re-run the fleet/)
  assert.equal(readFileSync(join(root, 'docs/features/a/SPEC.md'), 'utf8'), 'my local edit\n', 'your change is untouched')
  unlinkSync(join(root, 'docs/features/a/SPEC.md'))
  const second = runFleet(root, [], { a: HAPPY })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.fleet.features.a.status, 'done')
  assert.match(git(root, 'log', '--oneline', '-1'), /merge\(a\)/)
})

test('a fleet with unfinished work refuses to run from another branch', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: ['audited', 'BLOCK:later'] })
  git(root, 'switch', '-q', '-c', 'elsewhere')
  const r = runFleet(root, [], {})
  assert.equal(r.status, 2)
  assert.match(r.stderr, /This fleet merges into main, but elsewhere is checked out/)
})
