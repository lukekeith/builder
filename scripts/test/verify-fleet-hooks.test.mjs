// scripts/test/verify-fleet-hooks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../verify/git.mjs'
import { requestMerge, mergeVerdict, awaitVerdict, release } from '../verify/fleet-hooks.mjs'

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
