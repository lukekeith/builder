// scripts/test/verify-client.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from '../verify/git.mjs'
import { openLedger } from '../verify/ledger.mjs'
import { summarize, exitFor, ensureService } from '../verify/verify.mjs'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify', 'verify.mjs')
const CONFIG = `---\nproject: X\nbase_branch: main\napps:\n  - name: a\n    path: .\nverify:\n  workers: 1\n  checks:\n    ok: { run: "test -f b.txt", tiers: [commit, phase, merge] }\n---\n`
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vcli-')))
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), CONFIG)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'feat', wt)
  writeFileSync(join(wt, 'b.txt'), '1\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'b')
  return { root, wt }
}
const cli = (cwd, ...a) => spawnSync('node', [CLIENT, ...a], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_VERIFY_IDLE_MS: '500' } })

test('request from a worktree starts the service; wait returns the green verdict', () => {
  const { root, wt } = repo()
  const r = cli(wt, 'request', wt, 'HEAD', '--tier', 'commit')
  assert.equal(r.status, 0, r.stderr)
  const id = r.stdout.trim()
  const w = cli(wt, 'wait', id, '--max', '60')
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /GREEN/)
  const v = cli(wt, 'verdict', 'feat', '--json')
  assert.equal(JSON.parse(v.stdout).status, 'green')
  assert.ok(openLedger(root).getRequest(id))
})

test('verdict with nothing recorded: 75 while one is queued, 5 when none exists', () => {
  const { root, wt } = repo()
  assert.equal(cli(wt, 'verdict', 'nope').status, 5)
  openLedger(root).newRequest({ worktree: wt, branch: 'q', sha: 'x', tier: 'commit', target: 'main' })
  assert.equal(cli(wt, 'verdict', 'q').status, 75)
})

test('verdict --tier: a newer phase verdict does not satisfy --tier merge', () => {
  const { root, wt } = repo()
  const ledger = openLedger(root)
  const base = { regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 1 }
  const m = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'aaa', tier: 'merge', target: 'main' })
  ledger.saveRequest({ ...m, state: 'done', verdict: { ...base, request: m.id, branch: 'd', sha: 'aaa', tier: 'merge', status: 'red' } })
  const p = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'bbb', tier: 'phase', target: 'main' })
  ledger.saveRequest({ ...p, state: 'done', verdict: { ...base, request: p.id, branch: 'd', sha: 'bbb', tier: 'phase', status: 'green' } })
  assert.equal(cli(wt, 'verdict', 'd').status, 0, 'untiered: the latest of any tier')
  const r = cli(wt, 'verdict', 'd', '--tier', 'merge')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^verify merge aaa d: RED/)
  assert.equal(cli(wt, 'verdict', 'e', '--tier', 'merge').status, 5)
  assert.equal(cli(wt, 'verdict', 'd', '--tier', 'bogus').status, 2)
})

test('verdict exit 75 prints each pending request with its id; --tier filters the pending list too', () => {
  const { root, wt } = repo()
  const q = openLedger(root).newRequest({ worktree: wt, branch: 'q', sha: 'x', tier: 'merge', target: 'main' })
  const r = cli(wt, 'verdict', 'q', '--tier', 'merge')
  assert.equal(r.status, 75)
  assert.match(r.stdout, new RegExp(`^pending: merge queued ${q.id}$`, 'm'))
  assert.equal(cli(wt, 'verdict', 'q', '--tier', 'phase').status, 5)
})

test('verdict names a newer pending request after an older finished one; --tier without a value is usage', () => {
  const { root, wt } = repo()
  const ledger = openLedger(root)
  const m = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'aaa', tier: 'merge', target: 'main' })
  ledger.saveRequest({ ...m, state: 'done', verdict: { request: m.id, branch: 'd', sha: 'aaa', tier: 'merge', status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 1 } })
  const q = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'bbb', tier: 'merge', target: 'main' })
  const r = cli(wt, 'verdict', 'd', '--tier', 'merge')
  assert.equal(r.status, 0, 'the exit is still the finished verdict\'s')
  assert.match(r.stdout, /^verify merge aaa d: GREEN/)
  assert.match(r.stdout, new RegExp(`^pending: merge queued ${q.id}$`, 'm'))
  assert.doesNotMatch(r.stdout, new RegExp(`pending: merge \\w+ ${m.id}`))
  assert.equal(cli(wt, 'verdict', 'd', '--tier').status, 2)
})

test('--tree snapshots uncommitted work without touching the branch', () => {
  const { root, wt } = repo()
  const head = git(wt, 'rev-parse', 'HEAD')
  writeFileSync(join(wt, 'c.txt'), 'dirty\n')
  git(wt, 'add', 'c.txt')
  const id = cli(wt, 'request', wt, 'HEAD', '--tier', 'commit', '--tree').stdout.trim()
  const req = openLedger(root).getRequest(id)
  assert.notEqual(req.sha, head)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
  cli(wt, 'wait', id, '--max', '60')
})

test('summarize and exitFor', () => {
  assert.equal(exitFor('green'), 0)
  assert.equal(exitFor('red'), 1)
  assert.equal(exitFor('env-broken'), 3)
  assert.equal(exitFor('conflict'), 4)
  assert.equal(exitFor('gone'), 5)
  assert.equal(exitFor('cancelled'), 6)
  const s = summarize({ tier: 'commit', sha: 'abcdef1234', branch: 'f', status: 'red', ms: 41000, regressions: [{ id: 'u::t.ts::x', msg: 'line1\nline2', introducedBy: '1234567abc', note: 'flaky test this branch owns' }], flakes: ['a'], known: ['b', 'c'], debt: [], broken: [], selection: { u: { files: 3, why: null } }, reused: 0 })
  assert.match(s, /^verify commit abcdef1 f: RED · 1 regression · 1 flake · 2 known · 41s/)
  assert.match(s, /✗ u::t\.ts::x — introduced by 1234567 \(flaky test this branch owns\)/)
  assert.match(s, /selection: u 3 files/)
})

test('summarize shows the failing lines of a red check, not its banner', () => {
  const base = { tier: 'commit', sha: 'abcdef1234', branch: 'f', status: 'red', ms: 1, flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0 }
  const msg = '> x@1 test\n> node --test\n\nstarting\nrunning\n  ✗ test/x.test.mjs > y\n    expected 1, got 2\nmore\nnoise'
  const s = summarize({ ...base, regressions: [{ id: 'c', msg, raw: true, introducedBy: '1234567abc' }] })
  assert.match(s, /✗ test\/x\.test\.mjs > y/)
  assert.match(s, /expected 1, got 2/)
  assert.doesNotMatch(s, /npm|> x@1|starting/)
  const tail = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
  const t = summarize({ ...base, regressions: [{ id: 'c', msg: tail, raw: true, introducedBy: '1234567abc' }] })
  assert.match(t, /l9/)
  assert.match(t, /l4/)
  assert.doesNotMatch(t, /l3\b/)
  // Raw check output: node's ✖ and a lowercase error count, each with the line that follows it.
  const node = summarize({ ...base, regressions: [{ id: 'c', raw: true, msg: '> build\nok\n✖ parses tags (2ms)\n  got [] for "a,b"\nok 2\ntypecheck error: TS2322\n  src/a.ts:3 string is not number', introducedBy: '1234567abc' }] })
  for (const x of ['✖ parses tags', 'got [] for "a,b"', 'typecheck error: TS2322', 'src/a.ts:3']) assert.ok(node.includes(x), x)
  assert.doesNotMatch(node, /> build|ok 2/)
})

test('summarize keeps the values of a test failure — a node-test AssertionError and a jest toBe — not only the line that names it', () => {
  const base = { tier: 'commit', sha: 'abcdef1234', branch: 'f', status: 'red', ms: 1, flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0 }
  const nodeMsg = "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at TestContext.<anonymous> (file:///repo/test/x.test.mjs:5:10)\n    at Test.runInAsyncScope (node:async_hooks:206:9)"
  const n = summarize({ ...base, regressions: [{ id: 'u::x', msg: nodeMsg, introducedBy: '1234567abc' }] })
  assert.match(n, /Expected values to be strictly equal/)
  assert.match(n, /1 !== 2/)
  assert.doesNotMatch(n, /runInAsyncScope/)
  const deep = summarize({ ...base, regressions: [{ id: 'u::y', msg: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n+   a: 1\n-   a: 2\n  }\n    at x (file:///y.mjs:1:1)', introducedBy: '1234567abc' }] })
  assert.match(deep, /\+ {3}a: 1/)
  assert.match(deep, /- {3}a: 2/)
  const jestMsg = 'expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1\n\n  at Object.<anonymous> (src/sum.test.js:3:13)'
  const j = summarize({ ...base, regressions: [{ id: 'u::z', msg: jestMsg, introducedBy: '1234567abc' }] })
  for (const x of ['toBe(expected)', 'Expected: 2', 'Received: 1']) assert.ok(j.includes(x), x)
  assert.doesNotMatch(j, /sum\.test\.js:3:13/)
})

test('summarize keeps the first stack frame of a thrown error — where it was thrown — and only for a thrown error', () => {
  const base = { tier: 'commit', sha: 'abcdef1234', branch: 'f', status: 'red', ms: 1, flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0 }
  const thrown = "TypeError: Cannot read properties of undefined (reading 'split')\n    at tagsOf (file:///repo/src/tags.mjs:12:5)\n    at TestContext.<anonymous> (file:///repo/test/tags.test.mjs:8:3)\n    at Test.runInAsyncScope (node:async_hooks:206:9)"
  const t = summarize({ ...base, regressions: [{ id: 'u::t', msg: thrown, introducedBy: '1234567abc' }] })
  assert.match(t, /TypeError: Cannot read properties of undefined/)
  assert.match(t, /^ {10}at tagsOf \(file:\/\/\/repo\/src\/tags\.mjs:12:5\)$/m)
  assert.doesNotMatch(t, /tags\.test\.mjs:8:3|runInAsyncScope/, 'only the first frame')
  const plain = summarize({ ...base, regressions: [{ id: 'u::e', msg: 'Error: boom\n    at go (file:///repo/src/go.mjs:1:1)', introducedBy: '1234567abc' }] })
  assert.match(plain, /at go \(file:\/\/\/repo\/src\/go\.mjs:1:1\)/)
  // An assertion failure is not a thrown error: its values are the story, its frames are the test's own.
  const assertion = summarize({ ...base, regressions: [{ id: 'u::a', msg: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at TestContext.<anonymous> (file:///repo/test/x.test.mjs:5:10)', introducedBy: '1234567abc' }] })
  assert.doesNotMatch(assertion, /x\.test\.mjs:5:10/)
})

test('cancel never overwrites a finished request and cancels a queued one at once', () => {
  const { root, wt } = repo()
  const ledger = openLedger(root)
  const done = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'x', tier: 'commit', target: 'main' })
  const verdict = { request: done.id, branch: 'd', sha: 'x', tier: 'commit', status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 1 }
  ledger.saveRequest({ ...done, state: 'done', verdict })
  assert.equal(cli(wt, 'cancel', done.id).status, 0)
  assert.equal(ledger.getRequest(done.id).state, 'done')
  assert.equal(ledger.getRequest(done.id).verdict.status, 'green')
  const q = ledger.newRequest({ worktree: wt, branch: 'q', sha: 'x', tier: 'commit', target: 'main' })
  assert.equal(cli(wt, 'cancel', q.id).status, 0)
  assert.equal(ledger.getRequest(q.id).state, 'cancelled')
  assert.equal(ledger.getRequest(q.id).verdict.status, 'cancelled')
})

test('wait rejects a --max that is not a positive number', () => {
  const { wt } = repo()
  assert.equal(cli(wt, 'wait', 'whatever', '--max', 'abc').status, 2)
  assert.equal(cli(wt, 'wait', 'whatever', '--max', '0').status, 2)
})

test('wait on a cancelled request with no verdict starts the service, which answers it (exit 6)', () => {
  const { root, wt } = repo()
  const ledger = openLedger(root)
  const q = ledger.newRequest({ worktree: wt, branch: 'c', sha: 'x', tier: 'commit', target: 'main' })
  ledger.saveRequest({ ...q, state: 'cancelled' })
  const w = cli(wt, 'wait', q.id, '--max', '20')
  assert.equal(w.status, 6, w.stdout + w.stderr)
})

test('cancel on a finished request reports its real state', () => {
  const { root, wt } = repo()
  const ledger = openLedger(root)
  const d = ledger.newRequest({ worktree: wt, branch: 'd', sha: 'x', tier: 'commit', target: 'main' })
  ledger.saveRequest({ ...d, state: 'done', verdict: { status: 'green' } })
  assert.match(cli(wt, 'cancel', d.id).stdout, /already done \(green\)/)
})

test('release lands a held green merge; a moved target exits 7', () => {
  const { root, wt } = repo()
  const id = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  assert.equal(cli(wt, 'wait', id, '--max', '60').status, 0)
  const before = git(root, 'rev-parse', 'main')
  const rel = cli(wt, 'release', id)
  assert.equal(rel.status, 0, rel.stdout + rel.stderr)
  assert.match(rel.stdout, /^landed [0-9a-f]{7}/)
  assert.notEqual(git(root, 'rev-parse', 'main'), before)
  assert.equal(cli(wt, 'release', id).status, 2)
  const id2 = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  cli(wt, 'wait', id2, '--max', '60')
  writeFileSync(join(root, 'moved.txt'), 'x\n')
  git(root, 'add', 'moved.txt')
  git(root, 'commit', '-qm', 'moved')
  const moved = cli(wt, 'release', id2)
  assert.equal(moved.status, 7)
  assert.match(moved.stdout, /target moved/)
  assert.equal(openLedger(root).getRequest(id2).verdict.held, false, 'a stale held merge is not offered again')
})

test('release refused by uncommitted changes in the checkout exits 1 and says so; the target stays', () => {
  const { root, wt } = repo()
  const id = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  assert.equal(cli(wt, 'wait', id, '--max', '60').status, 0)
  const before = git(root, 'rev-parse', 'main')
  writeFileSync(join(root, 'b.txt'), 'mine\n') // untracked here, and the merge brings b.txt
  const rel = cli(wt, 'release', id)
  assert.equal(rel.status, 1, rel.stdout + rel.stderr)
  // The overlap is named, one JSON line the fleet reads, after the human-readable line.
  assert.match(rel.stdout, /refused the fast-forward \(your uncommitted changes overlap this feature\)\noverlap: \["b\.txt"\]\n$/)
  assert.equal(git(root, 'rev-parse', 'main'), before)
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'mine\n')
})

test('carry lands a held merge whose branch gained only registry commits; a code commit exits 2', () => {
  const { root, wt } = repo()
  const id = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold', '--message', 'merge(feat): x').stdout.trim()
  assert.equal(cli(wt, 'wait', id, '--max', '60').status, 0)
  mkdirSync(join(wt, 'docs/features/x'), { recursive: true })
  writeFileSync(join(wt, 'docs/features/x/SPEC.md'), '# x\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'ship x')
  const head = git(wt, 'rev-parse', 'HEAD')
  const c = cli(wt, 'carry', id)
  assert.equal(c.status, 0, c.stdout + c.stderr)
  assert.match(c.stdout, /^landed [0-9a-f]{7} on main \(carried 1 doc commit\)/)
  assert.equal(git(root, 'merge-base', '--is-ancestor', head, 'main'), '', 'main carries the doc commit')
  assert.equal(git(root, 'log', '-1', '--format=%s', 'main'), 'merge(feat): x')
  const v = openLedger(root).getRequest(id).verdict
  assert.deepEqual([v.held, v.landed, v.carried], [false, git(root, 'rev-parse', 'main'), head])

  const two = repo()
  const id2 = cli(two.wt, 'request', two.wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  assert.equal(cli(two.wt, 'wait', id2, '--max', '60').status, 0)
  writeFileSync(join(two.wt, 'code.js'), 'x\n')
  git(two.wt, 'add', '.')
  git(two.wt, 'commit', '-qm', 'code')
  const before = git(two.root, 'rev-parse', 'main')
  const bad = cli(two.wt, 'carry', id2)
  assert.equal(bad.status, 2, bad.stdout + bad.stderr)
  assert.match(bad.stdout, /code changed since the tested sha — request the merge again/)
  assert.equal(git(two.root, 'rev-parse', 'main'), before)
})

test('carry: a code file renamed into the registry is a code change — exit 2, nothing lands, no longer held', () => {
  const { root, wt } = repo()
  const id = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  assert.equal(cli(wt, 'wait', id, '--max', '60').status, 0)
  mkdirSync(join(wt, 'docs/features/x'), { recursive: true })
  git(wt, 'mv', 'b.txt', 'docs/features/x/b.txt')
  git(wt, 'commit', '-qm', 'move code into the registry')
  const before = git(root, 'rev-parse', 'main')
  const c = cli(wt, 'carry', id)
  assert.equal(c.status, 2, c.stdout + c.stderr)
  assert.match(c.stdout, /code changed since the tested sha/)
  assert.equal(git(root, 'rev-parse', 'main'), before)
  assert.equal(openLedger(root).getRequest(id).verdict.held, false)
})

const until = async (f, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return f()
}
const pidOf = (root) => {
  try {
    return Number(readFileSync(join(root, '.builder', 'verify', 'serve.pid'), 'utf8'))
  } catch {
    return null
  }
}

test('wait on a request that keeps taking the service down: env-broken after the second crash, naming it — not "still running"', () => {
  const { root, wt } = repo()
  // A check that kills the service running it: every restart re-runs it and dies again.
  writeFileSync(join(root, '.claude', 'builder.md'), CONFIG.replace('run: "test -f b.txt"', 'run: "kill -9 $PPID"'))
  const r = cli(wt, 'request', wt, 'HEAD', '--tier', 'commit')
  assert.equal(r.status, 0, r.stderr)
  const w = cli(wt, 'wait', r.stdout.trim(), '--max', '60')
  assert.equal(w.status, 3, w.stdout + w.stderr)
  assert.match(w.stdout, /ENV-BROKEN/)
  assert.match(w.stdout, /the verifier service died 2 times running this request/)
})

test('wait that times out on a request the service has crashed on says so, with the crash', () => {
  const { root, wt } = repo()
  const l = openLedger(root)
  const q = l.newRequest({ worktree: wt, branch: 'feat', sha: git(wt, 'rev-parse', 'HEAD'), tier: 'phase', target: 'main' })
  l.saveRequest({ ...q, state: 'running', startedAt: new Date().toISOString(), pid: process.pid, crashes: 1, lastCrash: 'Error: spawn /bin/bash ENOENT' })
  // A live, fresh lock: no service is started, so the request stays where it is.
  writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), String(process.pid))
  const w = cli(wt, 'wait', q.id, '--max', '1')
  assert.equal(w.status, 75)
  assert.match(w.stdout, /the verifier service died 1 time running it/)
  assert.match(w.stdout, /spawn \/bin\/bash ENOENT/)
  assert.doesNotMatch(w.stdout, /still running — call wait again/)
})

test('ensureService: a serve.pid naming a live but foreign pid, untouched for over 60 s, is stale — a service starts', async () => {
  const { root } = repo()
  openLedger(root)
  const p = join(root, '.builder', 'verify', 'serve.pid')
  writeFileSync(p, String(process.ppid))
  const old = new Date(Date.now() - 120000)
  utimesSync(p, old, old)
  process.env.BUILDER_VERIFY_IDLE_MS = '500'
  ensureService(root)
  const pid = await until(() => { const n = pidOf(root); return n && n !== process.ppid ? n : null })
  assert.ok(pid, 'a new service took the lock')
  await until(() => !existsSync(p))
})

test('a service sent SIGTERM drops its lock and exits', async () => {
  const { root } = repo()
  openLedger(root)
  process.env.BUILDER_VERIFY_IDLE_MS = '60000'
  ensureService(root)
  const pid = await until(() => pidOf(root))
  assert.ok(pid)
  process.kill(pid, 'SIGTERM')
  assert.ok(await until(() => !existsSync(join(root, '.builder', 'verify', 'serve.pid'))), 'serve.pid removed')
})

test('the service starts with a scrubbed env: a walk-env key or DATABASE_URL in the starting client never reaches a test run', () => {
  const { root, wt } = repo()
  const out = join(root, '..', `${root.split('/').pop()}-env.txt`)
  writeFileSync(join(root, '.claude', 'builder.md'), `---\nproject: X\nbase_branch: main\napps:\n  - name: a\n    path: .\nagent_walk:\n  env: WALK_SECRET=walk\n  worktree_env: WT_SECRET=wt\nverify:\n  workers: 1\n  checks:\n    ok: { run: "printenv WALK_SECRET WT_SECRET DATABASE_URL CLAUDE_PROJECT_DIR > '${out}'; true", tiers: [commit, phase, merge] }\n---\n`)
  git(root, 'commit', '-qam', 'config')
  git(wt, 'merge', '-q', 'main')
  const env = { ...process.env, BUILDER_VERIFY_IDLE_MS: '500', WALK_SECRET: 'leak', WT_SECRET: 'leak', DATABASE_URL: 'postgres://leak', CLAUDE_PROJECT_DIR: '/leak' }
  const r = spawnSync('node', [CLIENT, 'request', wt, 'HEAD', '--tier', 'commit'], { cwd: wt, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const w = cli(wt, 'wait', r.stdout.trim(), '--max', '60')
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.equal(readFileSync(out, 'utf8'), '')
})

test('wait --json prints a verdict larger than a pipe buffer whole', () => {
  const { root, wt } = repo()
  const dir = join(root, '.builder', 'verify', 'requests')
  mkdirSync(dir, { recursive: true })
  const known = Array.from({ length: 3000 }, (_, i) => `server::apps/server/test/t${i}.test.ts::a test name long enough to fill the pipe ${i}`)
  const verdict = { request: 'big', branch: 'feat', sha: 'x', tier: 'commit', status: 'green', regressions: [], flakes: [], known, debt: [], broken: [], selection: {}, reused: 0, ms: 1 }
  writeFileSync(join(dir, 'big.json'), JSON.stringify({ id: 'big', branch: 'feat', sha: 'x', tier: 'commit', state: 'done', verdict }))
  const r = cli(wt, 'wait', 'big', '--json')
  assert.ok(r.stdout.length > 65536, `stdout ${r.stdout.length} bytes, exit ${r.status}: ${r.stderr.slice(-300)}`)
  assert.equal(JSON.parse(r.stdout).known.length, 3000)
})

// ---- the landing branch a request compares against ---------------------------------------------

const STACK_CONFIG = (extra = '') => `---\nproject: X\nbase_branch: main\n${extra}apps:\n  - name: server\n    path: server\n  - name: iphone\n    path: iphone\nverify:\n  workers: 1\n  suites:\n    server: { runner: node-test, files: "server/*.test.mjs", app: server }\n    iphone: { runner: node-test, files: "iphone/*.test.mjs", app: iphone }\n---\n`
const unitTest = (n) => `import { test } from 'node:test'\ntest('${n}', () => {})\n`
/**
 * main → feature/stack (two iPhone-only commits, not on main) → builder/x in a worktree: its
 * MANIFEST.md (with `target`, when given) and one server-only commit. The shape of a feature stacked
 * on unmerged work, landing on that work's branch rather than main.
 */
function stackedRepo({ target = 'feature/stack', config = STACK_CONFIG() } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vcli-')))
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), config)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'checkout', '-qb', 'feature/stack')
  mkdirSync(join(root, 'iphone'))
  for (const n of ['a', 'b']) {
    writeFileSync(join(root, 'iphone', `${n}.test.mjs`), unitTest(`iphone ${n}`))
    git(root, 'add', '.')
    git(root, 'commit', '-qm', `iphone ${n}`)
  }
  git(root, 'checkout', '-q', 'main')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'builder/x', wt, 'feature/stack')
  mkdirSync(join(wt, 'docs', 'features', 'x'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'features', 'x', 'MANIFEST.md'), `state: building\nbranch: builder/x\n${target ? `target: ${target}\n` : ''}`)
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'docs(x): manifest')
  mkdirSync(join(wt, 'server'))
  writeFileSync(join(wt, 'server', 's.test.mjs'), unitTest('server s'))
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'server s')
  return { root, wt }
}
const requested = (root, r) => {
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return openLedger(root).getRequest(r.stdout.trim())
}

test('a commit request with no --target compares against the feature\'s target: — a server-only commit on a stacked branch selects no iPhone tests', () => {
  const { root, wt } = stackedRepo()
  const req = requested(root, cli(wt, 'request', wt, 'HEAD', '--tier', 'commit'))
  assert.equal(req.target, 'feature/stack')
  const w = cli(wt, 'wait', req.id, '--max', '120', '--json')
  const v = JSON.parse(w.stdout)
  assert.equal(v.status, 'green', w.stdout + w.stderr)
  assert.equal(v.selection.server?.files, 1, JSON.stringify(v.selection))
  assert.equal(v.selection.iphone?.files ?? 0, 0, `the iPhone commits below the branch are not its changes: ${JSON.stringify(v.selection)}`)
})

test('a phase request with no --target compares against the feature\'s target: too', () => {
  const { root, wt } = stackedRepo()
  assert.equal(requested(root, cli(wt, 'request', wt, 'HEAD', '--tier', 'phase')).target, 'feature/stack')
})

test('an explicit --target still wins over the manifest — against main, the iPhone commits below count as changed (the over-selection a missing target caused)', () => {
  const { root, wt } = stackedRepo()
  const req = requested(root, cli(wt, 'request', wt, 'HEAD', '--tier', 'commit', '--target', 'main'))
  assert.equal(req.target, 'main')
  const v = JSON.parse(cli(wt, 'wait', req.id, '--max', '120', '--json').stdout)
  assert.equal(v.selection.iphone?.files, 2, JSON.stringify(v.selection))
})

test('the fleet\'s --into (BUILDER_TARGET in its agents\' env) wins over the manifest; an empty one is ignored', () => {
  const { root, wt } = stackedRepo({ target: 'feature/elsewhere' })
  const env = (v) => spawnSync('node', [CLIENT, 'request', wt, 'HEAD', '--tier', 'commit'], { cwd: wt, encoding: 'utf8', env: { ...process.env, BUILDER_VERIFY_IDLE_MS: '500', BUILDER_TARGET: v } })
  assert.equal(requested(root, env('feature/stack')).target, 'feature/stack')
  assert.equal(requested(root, env('')).target, 'feature/elsewhere')
})

test('a feature with no target: falls back to merge_into, then base_branch', () => {
  const into = stackedRepo({ target: null, config: STACK_CONFIG('merge_into: develop\n') })
  assert.equal(requested(into.root, cli(into.wt, 'request', into.wt, 'HEAD', '--tier', 'commit')).target, 'develop')
  const base = stackedRepo({ target: null })
  assert.equal(requested(base.root, cli(base.wt, 'request', base.wt, 'HEAD', '--tier', 'commit')).target, 'main')
})
