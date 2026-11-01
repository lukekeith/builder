// scripts/test/verify-fleet-hooks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../verify/git.mjs'
import { requestMerge, mergeVerdict, heldMerge, awaitVerdict, release, carry } from '../verify/fleet-hooks.mjs'

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'vfh-'))
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: X\nbase_branch: main\napps:\n  - name: a\n    path: .\nverify:\n  checks:\n    ok: { run: "true", tiers: [merge] }\n---\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'builder/f', wt)
  writeFileSync(join(wt, 'f.txt'), '1\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'f')
  return { root, wt }
}

test('request once per HEAD, await, release with the fleet message', async () => {
  process.env.BUILDER_VERIFY_IDLE_MS = '500'
  const { root, wt } = repo()
  const id = requestMerge(root, wt, { target: 'main', message: 'merge(f): agent-verified, not human-tested' })
  assert.equal(requestMerge(root, wt, { target: 'main', message: 'x' }), id)
  const v = await awaitVerdict(root, id, { pollMs: 200 })
  assert.equal(v.status, 'green')
  assert.equal(v.held, true)
  assert.equal(mergeVerdict(root, 'builder/f', git(wt, 'rev-parse', 'HEAD')).request, id)
  const r = release(root, id)
  assert.equal(r.ok, true)
  assert.equal(git(root, 'log', '-1', '--format=%s', 'main'), 'merge(f): agent-verified, not human-tested')
})

test('carry: registry-only commits after the held run land without a second run; code falls through', async () => {
  process.env.BUILDER_VERIFY_IDLE_MS = '500'
  const held = async () => {
    const { root, wt } = repo()
    const id = requestMerge(root, wt, { target: 'main', message: 'merge(f): carried' })
    await awaitVerdict(root, id, { pollMs: 200 })
    return { root, wt, id }
  }
  const code = await held()
  writeFileSync(join(code.wt, 'code.js'), 'x\n')
  git(code.wt, 'add', '.')
  git(code.wt, 'commit', '-qm', 'code')
  assert.deepEqual(carry(code.root, code.id), { ok: false, moved: false, codeChanged: true, reason: `${code.id}: code changed since the tested sha — request the merge again` })
  assert.equal(heldMerge(code.root, 'builder/f'), null, 'a result code moved past is not offered again')

  const { root, wt, id } = await held()
  mkdirSync(join(wt, 'docs', 'features', 'f'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'features', 'f', 'SPEC.md'), 'shipped\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'ship f')
  assert.equal(heldMerge(root, 'builder/f').request, id)
  const r = carry(root, id)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.sha, git(root, 'rev-parse', 'main'))
  assert.equal(git(root, 'log', '-1', '--format=%s', 'main^2'), 'ship f')
  assert.equal(heldMerge(root, 'builder/f'), null)
})

test('release and carry refused by an overlap hand the fleet every file, apart from the reason', async () => {
  process.env.BUILDER_VERIFY_IDLE_MS = '500'
  const { root, wt } = repo()
  writeFileSync(join(wt, 'g.txt'), '1\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'g')
  const id = requestMerge(root, wt, { target: 'main', message: 'merge(f): x' })
  assert.equal((await awaitVerdict(root, id, { pollMs: 200 })).status, 'green')
  writeFileSync(join(root, 'f.txt'), 'mine\n') // untracked here, and the feature adds f.txt
  writeFileSync(join(root, 'g.txt'), 'mine\n')
  const before = git(root, 'rev-parse', 'main')
  const r = release(root, id)
  assert.deepEqual(r.overlap, ['f.txt', 'g.txt'])
  assert.equal(r.ok, false)
  assert.equal(r.moved, false)
  assert.doesNotMatch(r.reason, /overlap: \[/, 'the JSON line is not part of the reason')
  const c = carry(root, id)
  assert.deepEqual(c.overlap, ['f.txt', 'g.txt'])
  assert.equal(git(root, 'rev-parse', 'main'), before)
})

test('awaitVerdict on a request with no file returns null instead of waiting forever', async () => {
  const { root } = repo()
  assert.equal(await awaitVerdict(root, 'no-such-request', { pollMs: 50 }), null)
})

test('awaitVerdict gives up after maxMs (null — the caller parks) when no service ever answers', async () => {
  const { root, wt } = repo()
  const { openLedger } = await import('../verify/ledger.mjs')
  const l = openLedger(root)
  // A live, fresh lock (this process) so no service starts and the request stays queued.
  writeFileSync(join(root, '.builder', 'verify', 'serve.pid'), String(process.pid))
  const r = l.newRequest({ worktree: wt, branch: 'builder/f', sha: git(wt, 'rev-parse', 'HEAD'), tier: 'merge', target: 'main' })
  const t0 = Date.now()
  assert.equal(await awaitVerdict(root, r.id, { pollMs: 50, maxMs: 300 }), null)
  assert.ok(Date.now() - t0 < 2000)
})
