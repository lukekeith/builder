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
  const { root, wt } = repo()
  const id = requestMerge(root, wt, { target: 'main', message: 'merge(f): carried' })
  await awaitVerdict(root, id, { pollMs: 200 })
  writeFileSync(join(wt, 'code.js'), 'x\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'code')
  assert.deepEqual(carry(root, id), { ok: false, moved: false, codeChanged: true, reason: `${id}: code changed since the tested sha — request the merge again` })
  git(wt, 'reset', '-q', '--hard', 'HEAD~1')
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

test('awaitVerdict on a request with no file returns null instead of waiting forever', async () => {
  const { root } = repo()
  assert.equal(await awaitVerdict(root, 'no-such-request', { pollMs: 50 }), null)
})
