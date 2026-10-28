// scripts/test/verify-serve.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

test('no verify: block at all → green and marked untested; a broken block → env-broken', async () => {
  const { root, feat } = repo()
  const l = openLedger(root)
  const r = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(r.id).verdict.status, 'green')
  assert.equal(l.getRequest(r.id).verdict.untested, true)
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\nverify:\n  suites:\n    u: { runner: mocha }\n---\n')
  const b = l.newRequest({ worktree: root, branch: 'feat', sha: feat, tier: 'commit', target: 'main' })
  await serve(root, { idleMs: 300, tickMs: 50 })
  assert.equal(l.getRequest(b.id).verdict.status, 'env-broken')
  assert.match(l.getRequest(b.id).verdict.broken[0].reason, /runner "mocha"/)
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
