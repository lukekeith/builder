// scripts/test/verify-client.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from '../verify/git.mjs'
import { openLedger } from '../verify/ledger.mjs'
import { summarize, exitFor } from '../verify/verify.mjs'

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
