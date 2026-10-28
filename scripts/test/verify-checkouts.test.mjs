import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, mainRoot } from '../verify/git.mjs'
import { ensureCheckout, checkoutAt, mergedCheckout, setupIfNeeded, changedFiles, land, commitExists } from '../verify/checkouts.mjs'

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vco-')))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'one')
  return root
}
const commit = (cwd, file, text, msg) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', msg)
  return git(cwd, 'rev-parse', 'HEAD')
}

test('a checkout is a reusable detached worktree that moves to any commit, clean', () => {
  const root = repo()
  const first = git(root, 'rev-parse', 'HEAD')
  const second = commit(root, 'a.txt', 'two\n', 'two')
  const co = ensureCheckout(root, 0)
  assert.equal(ensureCheckout(root, 0), co)
  checkoutAt(co, first)
  assert.equal(readFileSync(join(co, 'a.txt'), 'utf8'), 'one\n')
  writeFileSync(join(co, 'junk.txt'), 'x')
  checkoutAt(co, second)
  assert.equal(readFileSync(join(co, 'a.txt'), 'utf8'), 'two\n')
  assert.equal(existsSync(join(co, 'junk.txt')), false)
  assert.equal(mainRoot(co), mainRoot(root))
  assert.equal(commitExists(root, second), true)
  assert.equal(commitExists(root, 'f'.repeat(40)), false)
})

test('mergedCheckout merges the branch onto the target tip, or reports a conflict', () => {
  const root = repo()
  git(root, 'checkout', '-qb', 'feat')
  const feat = commit(root, 'b.txt', 'b\n', 'b')
  git(root, 'checkout', '-q', 'main')
  const tip = commit(root, 'c.txt', 'c\n', 'c')
  const co = ensureCheckout(root, 1)
  const m = mergedCheckout(co, tip, feat, 'Merge feat into main')
  assert.ok(m.sha)
  assert.equal(git(co, 'log', '-1', '--format=%s'), 'Merge feat into main')
  git(root, 'checkout', '-qb', 'clash', tip)
  const clash = commit(root, 'a.txt', 'clash\n', 'clash')
  git(root, 'checkout', '-q', 'main')
  const tip2 = commit(root, 'a.txt', 'main\n', 'main side')
  const c = mergedCheckout(co, tip2, clash, 'm')
  assert.equal(c.conflict, true)
  assert.deepEqual(c.files, ['a.txt'])
  assert.equal(git(co, 'status', '--porcelain'), '')
})

test('setup runs once per change to its inputs', () => {
  const root = repo()
  commit(root, 'package-lock.json', '{}\n', 'lock')
  const co = ensureCheckout(root, 2)
  checkoutAt(co, git(root, 'rev-parse', 'HEAD'))
  const runs = []
  const v = { setup: 'npm ci', setupInputs: ['package-lock.json'] }
  assert.equal(setupIfNeeded(co, v, (cmd) => runs.push(cmd)), true)
  assert.equal(setupIfNeeded(co, v, (cmd) => runs.push(cmd)), false)
  checkoutAt(co, commit(root, 'package-lock.json', '{"a":1}\n', 'lock2'))
  assert.equal(setupIfNeeded(co, v, (cmd) => runs.push(cmd)), true)
  assert.deepEqual(runs, ['npm ci', 'npm ci'])
})

test('changedFiles and land: fast-forward by compare-and-swap; refused when the target moved', () => {
  const root = repo()
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-qb', 'feat')
  const feat = commit(root, 'b.txt', 'b\n', 'b')
  git(root, 'checkout', '-q', '--detach')
  assert.deepEqual(changedFiles(root, base, feat), ['b.txt'])
  const co = ensureCheckout(root, 3)
  const m = mergedCheckout(co, base, feat, 'Merge feat')
  assert.deepEqual(land(root, 'main', m.sha, base), { ok: true })
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), m.sha)
  const r = land(root, 'main', feat, base)
  assert.equal(r.ok, false)
  assert.match(r.reason, /moved/)
})

test('land in the main checkout uses merge --ff-only there', () => {
  const root = repo()
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'branch', 'feat')
  const co = ensureCheckout(root, 4)
  checkoutAt(co, base)
  writeFileSync(join(co, 'z.txt'), 'z\n')
  git(co, 'add', '.')
  git(co, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'z')
  const tested = git(co, 'rev-parse', 'HEAD')
  assert.deepEqual(land(root, 'main', tested, base), { ok: true })
  assert.equal(readFileSync(join(root, 'z.txt'), 'utf8'), 'z\n')
})
