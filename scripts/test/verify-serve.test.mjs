// scripts/test/verify-serve.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { git } from '../verify/git.mjs'
import { openLedger } from '../verify/ledger.mjs'
import { serve, takeLock } from '../verify/serve.mjs'

const VERIFY = { workers: 2, timeoutMs: 60000, setup: null, setupInputs: [], db: null, simulator: null, env: null, suites: [], checks: [{ name: 'ok', run: 'true', cwd: '.', compare: 'exit', match: null, tiers: ['commit', 'phase', 'merge'], needs: [] }] }
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vsrv-')))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'checkout', '-qb', 'feat')
  writeFileSync(join(root, 'b.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'b')
  const feat = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  return { root, feat }
}
const opts = (o = {}) => ({ idleMs: 300, tickMs: 50, verify: VERIFY, ...o })

test('a commit request runs and is done with a green verdict; the service exits when idle', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  assert.equal(await serve(root, opts()), 'idle')
  const done = l.getRequest(r.id)
  assert.equal(done.state, 'done')
  assert.equal(done.verdict.status, 'green')
  assert.equal(done.verdict.sha, feat)
})

test('a merge request lands: main fast-forwards to the tested merge commit', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const old = git(root, 'rev-parse', 'main')
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'merge', target: 'main', message: 'merge(feat): agent-verified' })
  await serve(root, opts())
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green')
  assert.equal(v.landed, git(root, 'rev-parse', 'main'))
  assert.notEqual(v.landed, old)
  assert.equal(git(root, 'log', '-1', '--format=%s', 'main'), 'merge(feat): agent-verified')
})

test('a red merge does not land; a missing commit is gone', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const old = git(root, 'rev-parse', 'main')
  const red = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'test ! -f b.txt' }] }
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'merge', target: 'main' })
  const g = l.newRequest({ worktree: root, branch: 'x', sha: 'f'.repeat(40), tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: red, run: undefined }))
  assert.equal(l.getRequest(r.id).verdict.status, 'red')
  assert.equal(git(root, 'rev-parse', 'main'), old)
  assert.equal(l.getRequest(g.id).verdict.status, 'gone')
})

test('crash recovery: a request left running is re-queued and run', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  l.saveRequest({ ...r, state: 'running', startedAt: new Date().toISOString(), pid: 999999 })
  await serve(root, opts())
  assert.equal(l.getRequest(r.id).state, 'done')
})

test('crash recovery counts: the first restart re-queues the request; one that took the service down twice is env-broken, never run a third time', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'phase', target: 'main' })
  l.saveRequest({ ...r, state: 'running', startedAt: new Date().toISOString(), pid: 999999 })
  writeFileSync(join(root, '.builder', 'verify', 'serve.log'), "node:events:497\n      throw er; // Unhandled 'error' event\n      ^\n\nError: spawn /bin/bash ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n")
  let runs = 0
  const once = async () => {
    runs++
    throw new Error('never run a third time')
  }
  // First restart: re-queued, and the count kept on the request.
  await serve(root, opts({ run: async (req) => ({ request: req.id, branch: req.branch, sha: req.sha, tier: req.tier, status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0 }) }))
  assert.equal(l.getRequest(r.id).crashes, 1)
  assert.equal(l.getRequest(r.id).verdict.status, 'green')
  // A second crash on the same request: no third run.
  const q = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'phase', target: 'main' })
  l.saveRequest({ ...q, state: 'running', startedAt: new Date().toISOString(), pid: 999999, crashes: 1 })
  await serve(root, opts({ run: once }))
  assert.equal(runs, 0)
  const done = l.getRequest(q.id)
  assert.equal(done.state, 'done')
  assert.equal(done.crashes, 2)
  assert.equal(done.verdict.status, 'env-broken')
  assert.match(done.verdict.broken[0].reason, /the verifier service died 2 times running this request/)
  assert.match(done.verdict.broken[0].reason, /spawn \/bin\/bash ENOENT/)
})

test('folded requests finish with the survivor verdict', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const a = l.newRequest({ worktree: root, branch: 'feat', sha: git(root, 'rev-parse', 'feat~1'), tier: 'commit', target: 'main' })
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, opts())
  assert.equal(l.getRequest(a.id).state, 'done')
  assert.equal(l.getRequest(a.id).verdict.request, b.id)
})

test('a cancelled request stops with a cancelled verdict', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const slow = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'sleep 5' }] }
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'merge', target: 'main' })
  setTimeout(() => l.saveRequest({ ...l.getRequest(r.id), state: 'cancelled' }), 400)
  const t0 = Date.now()
  await serve(root, opts({ verify: slow }))
  assert.ok(Date.now() - t0 < 4000)
  assert.equal(l.getRequest(r.id).state, 'cancelled')
  assert.equal(l.getRequest(r.id).verdict.status, 'cancelled')
})

test('no .claude/builder.md → env-broken; a config with neither gates nor verify: → green and marked untested; a broken block → env-broken', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const n = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(n.id).verdict.status, 'env-broken')
  assert.equal(l.getRequest(n.id).verdict.broken[0].reason, 'no .claude/builder.md — run /builder:init')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\n---\n')
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(r.id).verdict.status, 'green')
  assert.equal(l.getRequest(r.id).verdict.untested, true)
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\nverify:\n  suites:\n    u: { runner: mocha }\n---\n')
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(b.id).verdict.status, 'env-broken')
  assert.match(l.getRequest(b.id).verdict.broken[0].reason, /runner "mocha"/)
})

test('an un-migrated 5.x config (## Quality gates, no verify:) runs nothing and lands nothing: env-broken, saying how to migrate', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const old = git(root, 'rev-parse', 'main')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\n---\n## Quality gates\n\n- `npm test`\n')
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'merge', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'env-broken')
  assert.equal(v.broken[0].reason, 'this config still uses ## Quality gates — run /builder:init --update to migrate it to verify:')
  assert.equal(git(root, 'rev-parse', 'main'), old)
})

test('one service per repo: a live lock refuses a second', () => {
  const { root } = repo()
  openLedger(root)
  assert.equal(takeLock(root), true)
  assert.equal(takeLock(root), true) // same pid re-takes
  writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), String(process.ppid))
  assert.equal(takeLock(root), false)
  writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), '999999')
  assert.equal(takeLock(root), true)
})

test('a queued survivor cancelled by its client: the request folded into it is requeued and runs', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const a = l.newRequest({ worktree: root, branch: 'feat', sha: git(root, 'rev-parse', 'feat~1'), tier: 'commit', target: 'main' })
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  l.saveRequest({ ...l.getRequest(a.id), state: 'folded', foldedInto: b.id })
  l.saveRequest({ ...l.getRequest(b.id), state: 'cancelled', foldedFrom: [a.id] })
  await serve(root, opts())
  const ra = l.getRequest(a.id)
  assert.equal(ra.state, 'done')
  assert.equal(ra.verdict.status, 'green')
  assert.equal(ra.verdict.request, a.id)
  assert.equal(l.getRequest(b.id).verdict.status, 'cancelled')
})

test('a running survivor cancelled: the request folded into it is requeued and runs on its own sha', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  // Slow only where b.txt exists (the survivor's sha), quick at the folded one's.
  const slow = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'if [ -f b.txt ]; then sleep 5; fi' }] }
  const a = l.newRequest({ worktree: root, branch: 'feat', sha: git(root, 'rev-parse', 'feat~1'), tier: 'commit', target: 'main' })
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  setTimeout(() => l.saveRequest({ ...l.getRequest(b.id), state: 'cancelled' }), 400)
  const t0 = Date.now()
  await serve(root, opts({ verify: slow }))
  assert.ok(Date.now() - t0 < 4000)
  assert.equal(l.getRequest(b.id).verdict.status, 'cancelled')
  assert.deepEqual(l.getRequest(b.id).verdict.broken, [])
  const ra = l.getRequest(a.id)
  assert.equal(ra.state, 'done')
  assert.equal(ra.verdict.request, a.id)
  assert.equal(ra.verdict.status, 'green')
})

test('a broken verify: block finishes folded requests too', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\nverify:\n  suites:\n    u: { runner: mocha }\n---\n')
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  const a = l.newRequest({ worktree: root, branch: 'feat', sha: git(root, 'rev-parse', 'feat~1'), tier: 'commit', target: 'main', state: 'folded', foldedInto: b.id })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(a.id).state, 'done')
  assert.equal(l.getRequest(a.id).verdict.status, 'env-broken')
})

test('a cancel that raced a service write still gets a cancelled verdict', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main', state: 'cancelled' })
  await serve(root, opts())
  assert.equal(l.getRequest(r.id).verdict.status, 'cancelled')
})

test('a merge that conflicts is a conflict verdict naming the files; main does not move', async () => {
  const { root } = repo()
  git(root, 'checkout', '-q', 'feat')
  writeFileSync(join(root, 'a.txt'), 'feat\n')
  git(root, 'commit', '-qam', 'a on feat')
  const tip = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  writeFileSync(join(root, 'a.txt'), 'main\n')
  git(root, 'commit', '-qam', 'a on main')
  const old = git(root, 'rev-parse', 'main')
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: tip, tier: 'merge', target: 'main' })
  await serve(root, opts())
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'conflict')
  assert.deepEqual(v.files, ['a.txt'])
  assert.equal(git(root, 'rev-parse', 'main'), old)
})

test('a target branch that does not exist is env-broken and says so', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'nope' })
  await serve(root, opts())
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'env-broken')
  assert.equal(v.broken[0].reason, 'target branch "nope" does not exist')
})

test('the lock: a live pid whose serve.pid has not been touched for over 60 s is a dead holder (pid reuse)', () => {
  const { root } = repo()
  openLedger(root)
  const p = join(root, '.builder', 'verify', 'serve.pid')
  writeFileSync(p, String(process.ppid))
  const old = new Date(Date.now() - 120000)
  utimesSync(p, old, old)
  assert.equal(takeLock(root), true)
})

test('the service touches serve.pid while it runs, so a long run never looks stale', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const slow = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'sleep 1.5' }] }
  l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  const p = join(root, '.builder', 'verify', 'serve.pid')
  const done = serve(root, opts({ verify: slow, heartbeatMs: 100 }))
  await new Promise((r) => setTimeout(r, 200))
  const old = new Date(Date.now() - 120000)
  utimesSync(p, old, old)
  await new Promise((r) => setTimeout(r, 600))
  assert.ok(Date.now() - statSync(p).mtimeMs < 5000, 'touched again since')
  await done
})

test('the lock: an empty, fresh serve.pid counts as held', () => {
  const { root } = repo()
  openLedger(root)
  writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), '')
  assert.equal(takeLock(root), false)
})

test('the lock: two processes racing for it — exactly one wins', async () => {
  const { root } = repo()
  openLedger(root)
  const go = Date.now() + 600
  const mod = pathToFileURL(join(import.meta.dirname, '..', 'verify', 'serve.mjs')).href
  // The child holds on after taking it, so its pid is still alive while the parent tries.
  const src = `import { takeLock } from ${JSON.stringify(mod)}; while (Date.now() < ${go}) {} ; console.log(takeLock(${JSON.stringify(root)})); setTimeout(() => {}, 1500)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] })
  const theirs = new Promise((res) => {
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      if (out.includes('\n')) res(out.trim() === 'true')
    })
  })
  while (Date.now() < go) {}
  const mine = takeLock(root)
  const childWon = await theirs
  child.kill()
  assert.equal([mine, childWon].filter(Boolean).length, 1)
})

test('a held merge runs and stays held: green, target untouched, targetSha recorded', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const old = git(root, 'rev-parse', 'main')
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'merge', target: 'main', hold: true })
  await serve(root, opts())
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green')
  assert.equal(v.held, true)
  assert.equal(v.landed, undefined)
  assert.equal(v.targetSha, old)
  assert.equal(git(root, 'rev-parse', 'main'), old)
})

test('walk-env leases fill {feature} from a builder/<feature> branch; any other branch is env-broken, saying why', async () => {
  const { root, feat } = repo()
  git(root, 'branch', 'builder/x', feat)
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\nbase_branch: main\napps:\n  - name: a\n    path: .\nagent_walk:\n  env: WALK_DB=db_{feature} PLAIN=1\n---\n')
  const walk = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'test "$WALK_DB" = db_x && test "$PLAIN" = 1', needs: [{ kind: 'walk-env' }] }] }
  const l = openLedger(root)
  const ok = l.newRequest({ worktree: root, branch: 'builder/x', sha: feat, tier: 'commit', target: 'main' })
  const bad = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: walk }))
  assert.equal(l.getRequest(ok.id).verdict.status, 'green', JSON.stringify(l.getRequest(ok.id).verdict))
  assert.deepEqual(l.getRequest(ok.id).verdict.debt, [], 'the check passed — {feature} was filled')
  const v = l.getRequest(bad.id).verdict
  assert.equal(v.status, 'env-broken', JSON.stringify(v))
  assert.match(v.broken.map((b) => b.reason).join('\n'), /agent_walk\.env needs \{feature\} — only fleet branches \(builder\/<feature>\) can lease the walk env/)
})

test('a request on the target itself (branch === target, no --since) selects what the last commit reaches, not nothing', async () => {
  const { root } = repo()
  mkdirSync(join(root, 't'))
  const t = (n) => `import { test } from 'node:test'\ntest('${n}', () => {})\n`
  // Separate commits: files changed together are co-changed, and impact selects both.
  writeFileSync(join(root, 't', 'a.test.mjs'), t('a'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test a')
  writeFileSync(join(root, 't', 'b.test.mjs'), t('b'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test b')
  writeFileSync(join(root, 't', 'b.test.mjs'), t('b2'))
  git(root, 'commit', '-qam', 'touch b')
  const head = git(root, 'rev-parse', 'HEAD')
  const suite = { workers: 1, timeoutMs: 60000, setup: null, setupInputs: [], db: null, simulator: null, env: null, checks: [], suites: [{ name: 'u', runner: 'node-test', files: 't/*.test.mjs', app: null, cwd: '.', args: '', needs: [], tiers: ['commit', 'phase', 'merge'], command: null, report: null, scheme: null, target: null, destination: null }] }
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'main', sha: head, tier: 'phase', target: 'main' })
  await serve(root, opts({ verify: suite }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.selection.u.files, 1, JSON.stringify(v.selection))
})

test('a service whose lock was taken over stops: running requests go back to queued, the new owner\'s pid stays', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const slow = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'sleep 30' }] }
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  const other = spawn('sleep', ['30'])
  try {
    const done = serve(root, opts({ idleMs: 60000, verify: slow }))
    for (let i = 0; i < 100 && l.getRequest(r.id).state !== 'running'; i++) await new Promise((x) => setTimeout(x, 50))
    assert.equal(l.getRequest(r.id).state, 'running')
    const p = join(root, '.builder', 'verify', 'serve.pid')
    writeFileSync(p, String(other.pid))
    const t0 = Date.now()
    assert.equal(await done, 'superseded')
    assert.ok(Date.now() - t0 < 10000)
    const after = l.getRequest(r.id)
    assert.equal(after.state, 'queued')
    assert.equal(after.verdict, undefined)
    assert.equal(readFileSync(p, 'utf8'), String(other.pid))
  } finally {
    other.kill()
  }
})

test('a superseded service leaves a request the new owner already restarted', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const slow = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'sleep 30' }] }
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  const other = spawn('sleep', ['30'])
  try {
    const done = serve(root, opts({ idleMs: 60000, verify: slow }))
    for (let i = 0; i < 100 && l.getRequest(r.id).state !== 'running'; i++) await new Promise((x) => setTimeout(x, 50))
    l.saveRequest({ ...l.getRequest(r.id), state: 'running', pid: other.pid, startedAt: '2099-01-01T00:00:00.000Z' })
    writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), String(other.pid))
    assert.equal(await done, 'superseded')
    const after = l.getRequest(r.id)
    assert.equal(after.state, 'running')
    assert.equal(after.pid, other.pid)
  } finally {
    other.kill()
  }
})

test('agent_walk.copy files reach the checkout a request runs in', async () => {
  const { root, feat } = repo()
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\nbase_branch: main\napps:\n  - name: a\n    path: .\nagent_walk:\n  copy: local.env\n---\n')
  writeFileSync(join(root, 'local.env'), 'K=1\n') // untracked in the main checkout
  const needs = { ...VERIFY, checks: [{ ...VERIFY.checks[0], run: 'test -f local.env' }] }
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: needs }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.deepEqual(v.debt, [], 'the check passed here — the file was copied in')
})

// ---- the commit tier's base: the newest green that is an ancestor -----------------------------

const unit = (files = 't/*.test.mjs') => ({ workers: 1, timeoutMs: 60000, setup: null, setupInputs: [], db: null, simulator: null, env: null, checks: [], suites: [{ name: 'u', runner: 'node-test', files, app: null, cwd: '.', args: '', needs: [], tiers: ['commit', 'phase', 'merge'], command: null, report: null, scheme: null, target: null, destination: null }] })
const testFile = (n) => `import { test } from 'node:test'\ntest('${n}', () => {})\n`
/** Record a green verdict for `sha` on `branch`, as a finished request. */
function green(l, { root, branch, sha, tier = 'commit' }) {
  const r = l.newRequest({ worktree: root, branch, sha, tier, target: 'main' })
  l.saveRequest({ ...r, state: 'done', verdict: { request: r.id, branch, sha, tier, status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 1 } })
}
/**
 * `branch` (cut from main, or main itself) with t/a and t/b added in separate commits (c1, c2),
 * a `git stash create` snapshot of uncommitted work on c2 (what `request --tree` records), then c3,
 * which touches `touch`. Separate commits: files changed together are co-changed.
 */
function snapshotRepo(branch, touch) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vsrv-')))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'readme.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  if (branch !== 'main') git(root, 'checkout', '-qb', branch)
  mkdirSync(join(root, 't'))
  writeFileSync(join(root, 't', 'a.test.mjs'), testFile('a'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test a')
  const c1 = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 't', 'b.test.mjs'), testFile('b'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test b')
  writeFileSync(join(root, 'scratch.txt'), 'uncommitted\n')
  git(root, 'add', 'scratch.txt')
  const snapshot = git(root, 'stash', 'create')
  git(root, 'reset', '-q', '--hard')
  writeFileSync(join(root, 't', `${touch}.test.mjs`), testFile(`${touch}2`))
  git(root, 'commit', '-qam', `touch ${touch}`)
  const c3 = git(root, 'rev-parse', 'HEAD')
  if (branch !== 'main') git(root, 'checkout', '-q', 'main')
  return { root, c1, snapshot, c3 }
}

test('commit tier: a --tree snapshot as the newest green is skipped — the base is the newest green that is an ancestor', async () => {
  const { root, c1, snapshot, c3 } = snapshotRepo('feat', 'b')
  const l = openLedger(root)
  green(l, { root, branch: 'feat', sha: c1 })
  green(l, { root, branch: 'feat', sha: snapshot }) // newest, and not an ancestor of c3
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c3, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.selection.u.files, 1, `since c1 only t/b changed — not the whole branch: ${JSON.stringify(v.selection)}`)
})

test('commit tier: no green that is an ancestor → the base is still the merge-base', async () => {
  const { root, snapshot, c3 } = snapshotRepo('feat', 'b')
  const l = openLedger(root)
  green(l, { root, branch: 'feat', sha: snapshot })
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c3, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.selection.u.files, 2, `the whole branch: ${JSON.stringify(v.selection)}`)
})

test('on the target itself: a --tree snapshot as the newest green is skipped — the range starts at the newest ancestor green, not sha^', async () => {
  const { root, c1, snapshot, c3 } = snapshotRepo('main', 'a')
  const l = openLedger(root)
  green(l, { root, branch: 'main', sha: c1 })
  green(l, { root, branch: 'main', sha: snapshot })
  const r = l.newRequest({ worktree: root, branch: 'main', sha: c3, tier: 'phase', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.selection.u.files, 2, `since c1: t/b added, t/a touched — not only the last commit: ${JSON.stringify(v.selection)}`)
})

/** feat: c1 adds t/a.test.mjs (code), c2 changes only the registry (docs/features/x/MANIFEST.md). */
function docsRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vsrv-')))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'readme.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'checkout', '-qb', 'feat')
  mkdirSync(join(root, 't'))
  writeFileSync(join(root, 't', 'a.test.mjs'), testFile('a'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test a')
  const c1 = git(root, 'rev-parse', 'HEAD')
  mkdirSync(join(root, 'docs', 'features', 'x'), { recursive: true })
  writeFileSync(join(root, 'docs', 'features', 'x', 'MANIFEST.md'), 'state: built\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'docs: manifest')
  const c2 = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  return { root, c1, c2 }
}
const greenVerdict = (r, sha, extra) => ({ request: r.id, branch: 'feat', sha, tier: r.tier, status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], reused: 0, ms: 5, ...extra })

test('a commit request whose range since the last green changed only the registry is green without a run', async () => {
  const { root, c1, c2 } = docsRepo()
  const l = openLedger(root)
  green(l, { root, branch: 'feat', sha: c1 })
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c2, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.docsOnly, true)
  assert.deepEqual(v.selection, {}, 'nothing ran')
})

test('a docs commit whose range still holds untested code runs as before', async () => {
  const { root, c2 } = docsRepo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c2, tier: 'commit', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.docsOnly, undefined)
  assert.equal(v.selection.u.files, 1)
})

test('a phase request at a sha a green run already covered (whole suite) reuses its verdict; a narrower earlier run does not', async () => {
  const { root, c1 } = docsRepo()
  const l = openLedger(root)
  const whole = l.newRequest({ worktree: root, branch: 'feat', sha: c1, tier: 'commit', target: 'main' })
  l.saveRequest({ ...whole, state: 'done', verdict: greenVerdict(whole, c1, { selection: { u: { files: 'all', why: 'x' } } }) })
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c1, tier: 'phase', target: 'main' })
  await serve(root, opts({ verify: unit() }))
  const v = l.getRequest(r.id).verdict
  assert.equal(v.status, 'green', JSON.stringify(v))
  assert.equal(v.reusedFrom, whole.id)
  assert.equal(v.tier, 'phase', "the verdict is this request's")

  const { root: root2, c1: d1 } = docsRepo()
  const l2 = openLedger(root2)
  const narrow = l2.newRequest({ worktree: root2, branch: 'feat', sha: d1, tier: 'commit', target: 'main' })
  // one file, selected from a base after the phase tier's merge-base: a narrower range
  l2.saveRequest({ ...narrow, state: 'done', verdict: greenVerdict(narrow, d1, { selection: { u: { files: 1, why: 'x' } }, base: d1 }) })
  const r2 = l2.newRequest({ worktree: root2, branch: 'feat', sha: d1, tier: 'phase', target: 'main' })
  await serve(root2, opts({ verify: unit() }))
  const v2 = l2.getRequest(r2.id).verdict
  assert.equal(v2.status, 'green', JSON.stringify(v2))
  assert.equal(v2.reusedFrom, undefined)
})

test('a phase request is not reused from a commit-tier run when the phase tier has checks the commit tier does not run', async () => {
  const { root, c1 } = docsRepo()
  const l = openLedger(root)
  const whole = l.newRequest({ worktree: root, branch: 'feat', sha: c1, tier: 'commit', target: 'main' })
  l.saveRequest({ ...whole, state: 'done', verdict: greenVerdict(whole, c1, { selection: { u: { files: 'all', why: 'x' } } }) })
  const cfg = { ...unit(), checks: [{ name: 'lint', run: 'true', cwd: '.', compare: 'exit', match: null, tiers: ['phase', 'merge'], needs: [] }] }
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: c1, tier: 'phase', target: 'main' })
  await serve(root, opts({ verify: cfg }))
  assert.equal(l.getRequest(r.id).verdict.reusedFrom, undefined)
})
