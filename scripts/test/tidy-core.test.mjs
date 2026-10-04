import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isTestOutput, clearWorktree } from '../tidy-core.mjs'
import { git, repo, fixture, branch } from './fixtures/tidy-repo.mjs'

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
  mkdirSync(join(wt, 'test-results/run-1'), { recursive: true })
  writeFileSync(join(wt, 'test-results/run-1/trace.zip'), 'untracked test output')
  const r = clearWorktree(root, wt, 'a')
  assert.deepEqual(r, { removed: true, stash: null, restored: ['test-results/.last-run.json'], kept: null, why: null })
  assert.equal(existsSync(wt), false)
  assert.equal(git(root, 'stash', 'list'), '')
})

test('clearWorktree stashes a real change by name before removing the worktree', () => {
  const root = repo()
  const wt = worktree(root, 'b', 'builder/b')
  writeFileSync(join(wt, 'app.js'), 'two\n')
  writeFileSync(join(wt, 'test-results/.last-run.json'), '{"x":1}\n')
  const r = clearWorktree(root, wt, 'b', { today: new Date('2026-10-03T12:00:00Z') })
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
  assert.deepEqual(clearWorktree(root, wt, 'c'), { removed: false, stash: null, restored: [], kept: null, why: null })
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

// ---- review fixes: nothing uncommitted is lost, nothing unmerged looks merged -------------------

test('C2: clearWorktree stashes untracked files too, not just tracked changes', () => {
  const root = repo()
  const wt = `${root}-wt-u`
  git(root, 'worktree', 'add', '-q', '-b', 'feat/new', wt)
  writeFileSync(join(wt, 'brand-new.js'), 'mine\n')
  const r = clearWorktree(root, wt, 'new', { today: new Date('2026-10-03T12:00:00Z') })
  assert.equal(r.removed, true)
  assert.equal(r.stash, 'builder: new leftovers 2026-10-03')
  assert.match(git(root, 'stash', 'show', '--include-untracked', '--name-only', 'stash@{0}'), /brand-new\.js/)
})

test('C3: clearWorktree keeps the build workspace (.builder/<label>) in the main checkout', () => {
  const root = repo()
  const wt = `${root}-wt-k`
  git(root, 'worktree', 'add', '-q', '-b', 'builder/k', wt)
  mkdirSync(join(wt, '.builder/k'), { recursive: true })
  writeFileSync(join(wt, '.builder/k/progress.md'), 'Task 1: complete\nRuling: x\n')
  const r = clearWorktree(root, wt, 'k')
  assert.equal(r.removed, true)
  assert.equal(r.kept, join(root, '.builder/kept/k'))
  assert.equal(readFileSync(join(root, '.builder/kept/k/progress.md'), 'utf8'), 'Task 1: complete\nRuling: x\n')
})

test('I2: clearWorktree refuses a worktree mid-merge, and touches nothing in it', () => {
  const root = repo()
  const wt = `${root}-wt-m`
  git(root, 'worktree', 'add', '-q', '-b', 'builder/m', wt)
  writeFileSync(join(wt, 'app.js'), 'theirs\n')
  git(wt, 'commit', '-qam', 'm side')
  writeFileSync(join(root, 'app.js'), 'ours\n')
  git(root, 'commit', '-qam', 'main side')
  try { git(wt, 'merge', 'main') } catch {}
  const r = clearWorktree(root, wt, 'm')
  assert.equal(r.removed, false)
  assert.match(r.why, /merge in progress/)
  assert.ok(existsSync(wt))
  assert.equal(git(root, 'stash', 'list'), '')
})

test('C1: an unknown target is refused, never read as "nothing ahead"', () => {
  const root = fixture()
  assert.throws(() => inventory(root, CFG, 'develop'), /The branch to merge into, develop, does not exist/)
})

test('C2: a branch whose worktree holds uncommitted work is asked about, never in the safe batch', () => {
  const root = fixture()
  writeFileSync(join(`${root}-wt-old`, 'notes.txt'), 'untracked, mine\n')
  writeFileSync(join(`${root}-wt-detached`, 'app.js'), 'edited\n')
  const items = byName(inventory(root, CFG, 'main'))
  assert.deepEqual([items['feat/old'].group, items['feat/old'].action], ['merged', 'ask'])
  assert.match(items['feat/old'].why, /uncommitted work in its worktree/)
  assert.deepEqual([items[`${root}-wt-detached`].group, items[`${root}-wt-detached`].action], ['dead', 'ask'])
})

test('a tag with a branch\'s name does not confuse the inventory', () => {
  const root = fixture()
  git(root, 'tag', 'spike', 'main')
  const items = byName(inventory(root, CFG, 'main'))
  assert.equal(items.spike.group, 'unknown')
  assert.equal(items['heads/spike'], undefined)
})

test('a worktree kept for your walk is kept, never in the safe batch', () => {
  const root = fixture()
  branch(root, 'builder/w', { manifest: { w: 'size: md\nstate: built\nblocked: "waiting for your walk — next: /builder:resume --path docs/features/w"\nnext: x\n' } })
  git(root, 'worktree', 'add', '-q', `${root}-wt-w`, 'builder/w')
  const w = byName(inventory(root, CFG, 'main', { fleet: { features: {} }, lockAlive: false }))['builder/w']
  assert.deepEqual([w.group, w.action], ['parked', 'keep'])
  assert.match(w.why, /waiting for your walk/)
  assert.match(w.next, /\/builder:resume/)
})
