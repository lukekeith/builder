import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isTestOutput, clearWorktree } from '../tidy-core.mjs'
import { git, repo, fixture } from './fixtures/tidy-repo.mjs'

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

// ---- the inventory ----------------------------------------------------------------------------
import { inventory, summaryLine } from '../tidy-core.mjs'

const CFG = { registry: 'docs/features', baseBranch: 'main' }
const byName = (items) => Object.fromEntries(items.map((i) => [i.name, i]))

test('the inventory puts every branch and worktree in one group, with the action it needs', () => {
  const root = fixture()
  const fleet = { features: { run: { status: 'building', branch: 'builder/run' } } }
  const items = byName(inventory(root, CFG, 'main', { fleet, lockAlive: true }))
  assert.equal(items.main, undefined, 'the target is not listed')
  const g = (n) => [items[n]?.group, items[n]?.action]
  assert.deepEqual(g('feat/old'), ['merged', 'delete'])
  assert.equal(items['feat/old'].worktree, `${root}-wt-old`)
  assert.deepEqual(g('builder/r'), ['ready', 'merge'])
  assert.equal(items['builder/r'].feature, 'r')
  assert.deepEqual(g('builder/p'), ['parked', 'remove-worktree'])
  assert.match(items['builder/p'].why, /D3 is open/)
  assert.match(items['builder/p'].next, /answer D3/)
  assert.deepEqual(g('builder/i'), ['in-progress', 'ask'])
  assert.deepEqual(g('feat/x'), ['in-progress', 'ask'])
  assert.equal(items['feat/x'].feature, 'x', 'found by its manifest\'s branch: line')
  assert.deepEqual(g('spike'), ['unknown', 'ask'])
  assert.equal(items.spike.ahead, 1)
  assert.deepEqual(g('builder/run'), ['running', 'none'])
  assert.deepEqual(g(`${root}-wt-detached`), ['dead', 'remove-worktree'])
  assert.deepEqual(g(`${root}-wt-gone`), ['dead', 'remove-worktree'])
  assert.deepEqual(g('gone-wt'), ['merged', 'delete'], 'the gone worktree\'s branch never got a commit of its own')
})

test('a fleet whose lock is dead does not keep its rows running; the checked-out branch is current', () => {
  const root = fixture()
  git(root, 'switch', '-q', 'spike')
  const items = byName(inventory(root, CFG, 'main', { fleet: { features: { run: { status: 'building', branch: 'builder/run' } } }, lockAlive: false }))
  assert.deepEqual([items['builder/run'].group, items['builder/run'].action], ['in-progress', 'ask'])
  assert.deepEqual([items.spike.group, items.spike.action], ['current', 'none'])
})

test('summaryLine counts what needs doing, or says the repo is clean', () => {
  const root = fixture()
  assert.equal(
    summaryLine(inventory(root, CFG, 'main', { fleet: { features: { run: { status: 'building', branch: 'builder/run' } } }, lockAlive: true })),
    'repo: 2 merged branches to delete · 2 dead worktrees · 1 ready to merge · 1 parked · 2 in progress · 1 unknown → /builder:tidy'
  )
  assert.equal(summaryLine([{ group: 'running' }, { group: 'current' }]), 'repo: clean')
})
