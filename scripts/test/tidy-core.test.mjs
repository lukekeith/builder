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

// ---- the inventory ----------------------------------------------------------------------------
import { inventory, summaryLine } from '../tidy-core.mjs'
import { rmSync } from 'node:fs'

const CFG = { registry: 'docs/features', baseBranch: 'main' }
/** A branch off main carrying one commit; `manifest` (feature → text) is written under the registry. */
function branch(root, name, { manifest = {}, file } = {}) {
  git(root, 'switch', '-q', '-c', name, 'main')
  for (const [f, text] of Object.entries(manifest)) {
    mkdirSync(join(root, 'docs/features', f), { recursive: true })
    writeFileSync(join(root, 'docs/features', f, 'MANIFEST.md'), text)
  }
  writeFileSync(join(root, file ?? `${name.replace(/\W/g, '-')}.txt`), name)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `on ${name}`)
  git(root, 'switch', '-q', 'main')
}

function fixture() {
  const root = repo()
  git(root, 'branch', 'feat/old') // already in main
  branch(root, 'builder/r', { manifest: { r: 'size: md\nstate: verified\nverify: READY 2026-10-03\nnext: x\n' } })
  branch(root, 'builder/p', { manifest: { p: 'size: md\nstate: audited\nblocked: "D3 is open — next: answer D3 in the SPEC, then /builder:agent"\nnext: x\n' } })
  branch(root, 'builder/i', { manifest: { i: 'size: md\nstate: planned\nnext: x\n' } })
  branch(root, 'feat/x', { manifest: { x: 'size: md\nstate: building\nbranch: feat/x\nnext: x\n' } })
  branch(root, 'spike')
  branch(root, 'builder/run', { manifest: { run: 'size: md\nstate: building\nnext: x\n' } })
  git(root, 'worktree', 'add', '-q', `${root}-wt-p`, 'builder/p')
  git(root, 'worktree', 'add', '-q', `${root}-wt-old`, 'feat/old')
  git(root, 'worktree', 'add', '-q', '--detach', `${root}-wt-detached`)
  git(root, 'worktree', 'add', '-q', '-b', 'gone-wt', `${root}-wt-gone`)
  rmSync(`${root}-wt-gone`, { recursive: true, force: true })
  return root
}
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
