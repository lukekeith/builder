import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isTestOutput, clearWorktree } from '../tidy-core.mjs'

export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A repo on main with one commit holding a tracked test artefact, the way d2m tracks one. */
export function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tidy-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, 'test-results'))
  writeFileSync(join(root, 'test-results/.last-run.json'), '{}\n')
  writeFileSync(join(root, 'app.js'), 'one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}
const worktree = (root, name, branch) => {
  const wt = `${root}-wt-${name}`
  git(root, 'worktree', 'add', '-q', '-b', branch, wt)
  return wt
}

test('isTestOutput knows the usual runner output and nothing else', () => {
  for (const p of ['test-results/.last-run.json', 'playwright-report/index.html', 'coverage/lcov.info', '.nyc_output/x.json', '.builder/gates/e2e.log', 'junit.xml', 'reports/junit-web.xml'])
    assert.equal(isTestOutput(p), true, p)
  for (const p of ['app.js', 'src/test-results.ts', 'docs/coverage.md', 'junit.xml.bak']) assert.equal(isTestOutput(p), false, p)
})

test('clearWorktree restores test output and removes the worktree, no stash', () => {
  const root = repo()
  const wt = worktree(root, 'a', 'builder/a')
  writeFileSync(join(wt, 'test-results/.last-run.json'), '{"status":"failed"}\n')
  writeFileSync(join(wt, 'scratch.png'), 'untracked evidence')
  const r = clearWorktree(root, wt, 'a')
  assert.deepEqual(r, { removed: true, stash: null, restored: ['test-results/.last-run.json'] })
  assert.equal(existsSync(wt), false)
  assert.equal(git(root, 'stash', 'list'), '')
})

test('clearWorktree stashes a real change by name before removing the worktree', () => {
  const root = repo()
  const wt = worktree(root, 'b', 'builder/b')
  writeFileSync(join(wt, 'app.js'), 'two\n')
  writeFileSync(join(wt, 'test-results/.last-run.json'), '{"x":1}\n')
  const r = clearWorktree(root, wt, 'b', new Date('2026-10-03T12:00:00Z'))
  assert.equal(r.removed, true)
  assert.equal(r.stash, 'builder: b leftovers 2026-10-03')
  assert.deepEqual(r.restored, ['test-results/.last-run.json'])
  assert.match(git(root, 'stash', 'list'), /builder: b leftovers 2026-10-03/)
  assert.match(git(root, 'stash', 'show', '-p', 'stash@{0}'), /\+two/)
  assert.equal(existsSync(wt), false)
})

test('clearWorktree on a path that is already gone prunes and says not removed', () => {
  const root = repo()
  const wt = worktree(root, 'c', 'builder/c')
  execFileSync('rm', ['-rf', wt])
  assert.deepEqual(clearWorktree(root, wt, 'c'), { removed: false, stash: null, restored: [] })
  assert.doesNotMatch(git(root, 'worktree', 'list'), /wt-c/)
})
