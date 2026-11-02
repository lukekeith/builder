import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, mainRoot } from '../scripts/verify/git.mjs'
import { ensureCheckout, checkoutAt, mergedCheckout, setupIfNeeded, changedFiles, land, landOverlap, commitExists, checkoutsDir, copyLocal } from '../scripts/verify/checkouts.mjs'

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

test('land refuses a sha that does not descend from the expected tip, leaving the target alone', () => {
  const root = repo()
  const base = git(root, 'rev-parse', 'HEAD')
  const tip = commit(root, 'a.txt', 'two\n', 'two')
  git(root, 'checkout', '-q', '--detach', base)
  const side = commit(root, 'b.txt', 'b\n', 'side')
  git(root, 'checkout', '-q', 'main')
  const r = land(root, 'main', side, tip)
  assert.deepEqual(r, { ok: false, reason: 'not a fast-forward of main' })
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), tip)
  git(root, 'checkout', '-q', '--detach')
  assert.equal(land(root, 'main', side, tip).ok, false)
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), tip)
})

test('mergedCheckout throws, not a conflict, when the merge fails for another reason', () => {
  const root = repo()
  const base = git(root, 'rev-parse', 'HEAD')
  const co = ensureCheckout(root, 5)
  assert.throws(() => mergedCheckout(co, base, 'f'.repeat(40), 'm'), /merge of f+ failed/)
})

test('checkoutAt keeps ignored files and removes untracked ones', () => {
  const root = repo()
  const first = commit(root, '.gitignore', 'node_modules/\n', 'ignore')
  const co = ensureCheckout(root, 6)
  checkoutAt(co, first)
  mkdirSync(join(co, 'node_modules'))
  writeFileSync(join(co, 'node_modules', 'x'), 'x')
  writeFileSync(join(co, 'junk.txt'), 'x')
  checkoutAt(co, first)
  assert.equal(existsSync(join(co, 'node_modules', 'x')), true)
  assert.equal(existsSync(join(co, 'junk.txt')), false)
})

test('checkouts live beside the main checkout (<root>-verify/co/<slot>), never inside its tree', () => {
  const root = repo()
  assert.equal(checkoutsDir(root), `${root}-verify/co`)
  const co = ensureCheckout(root, 2)
  assert.equal(co, join(`${root}-verify`, 'co', '2'))
  assert.equal(existsSync(join(root, '.builder', 'verify', 'co')), false)
  assert.equal(git(root, 'status', '--porcelain', '--ignored'), '', 'nothing in the consumer tree')
  assert.equal(mainRoot(co), mainRoot(root))
})

test('land refuses a target checked out in a linked worktree — moving it there would leave that tree behind its branch', () => {
  const root = repo()
  git(root, 'checkout', '-qb', 'side')
  const base = git(root, 'rev-parse', 'main')
  const wt = `${root}-rel`
  git(root, 'worktree', 'add', '-q', wt, 'main')
  git(root, 'checkout', '-qb', 'feat')
  const tested = commit(root, 'b.txt', 'b\n', 'b')
  const r = land(root, 'main', tested, base)
  assert.equal(r.ok, false)
  assert.match(r.reason, new RegExp(`main is checked out in ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(git(root, 'rev-parse', 'main'), base)
})

test('copyLocal brings agent_walk.copy files in: missing skipped, tracked never overwritten, directories whole, redone after a clean', () => {
  const root = repo()
  writeFileSync(join(root, '.gitignore'), 'ignored.env\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'ignore')
  writeFileSync(join(root, 'a.txt'), 'edited locally\n') // tracked, differs from the commit
  writeFileSync(join(root, 'ignored.env'), 'K=1\n')
  writeFileSync(join(root, 'plain.env'), 'P=1\n') // untracked and not ignored: `clean` takes it
  mkdirSync(join(root, 'certs/sub'), { recursive: true })
  writeFileSync(join(root, 'certs/sub/c.pem'), 'pem')
  const co = ensureCheckout(root, 0)
  const rels = ['a.txt', 'ignored.env', 'plain.env', 'nope.bin', 'certs']
  const sha = git(root, 'rev-parse', 'HEAD')
  checkoutAt(co, sha)
  copyLocal(root, co, rels)
  assert.equal(readFileSync(join(co, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(readFileSync(join(co, 'ignored.env'), 'utf8'), 'K=1\n')
  assert.equal(readFileSync(join(co, 'certs/sub/c.pem'), 'utf8'), 'pem')
  assert.equal(existsSync(join(co, 'nope.bin')), false)
  checkoutAt(co, sha)
  assert.equal(existsSync(join(co, 'ignored.env')), true)
  assert.equal(existsSync(join(co, 'plain.env')), false)
  copyLocal(root, co, rels)
  assert.equal(readFileSync(join(co, 'plain.env'), 'utf8'), 'P=1\n')
  copyLocal(root, co, [])
})

test('copyLocal: an ignored symlink survives a second move on the slot, and a dangling link inside a copied directory does not throw', () => {
  const root = repo()
  writeFileSync(join(root, '.gitignore'), '.env\nlinks\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'ignore')
  writeFileSync(join(root, 'env.local'), 'K=1\n')
  symlinkSync('env.local', join(root, '.env'))
  mkdirSync(join(root, 'links'))
  symlinkSync('gone', join(root, 'links/dangling'))
  writeFileSync(join(root, 'links/real'), 'r')
  const co = ensureCheckout(root, 0)
  const sha = git(root, 'rev-parse', 'HEAD')
  for (let i = 0; i < 3; i++) {
    checkoutAt(co, sha)
    copyLocal(root, co, ['.env', 'env.local', 'links'])
    assert.equal(readFileSync(join(co, '.env'), 'utf8'), 'K=1\n')
    assert.equal(readFileSync(join(co, 'links/real'), 'utf8'), 'r')
    assert.equal(lstatSync(join(co, 'links/dangling')).isSymbolicLink(), true)
  }
})

/** A main checkout on main and a feature commit that changes a.txt and adds n.txt — the shape a land sees. */
function overlapRepo() {
  const root = repo()
  const base = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'other.txt'), 'o\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'other')
  const old = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-qb', 'feat')
  writeFileSync(join(root, 'a.txt'), 'feature\n')
  writeFileSync(join(root, 'n.txt'), 'new\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'feat')
  const tested = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  return { root, base, old, tested }
}
const snapshot = (root) => ({ status: git(root, 'status', '--porcelain', '-uall'), head: git(root, 'rev-parse', 'HEAD'), a: readFileSync(join(root, 'a.txt'), 'utf8') })

test('landOverlap: a tracked file edited in the checkout that the feature also changes overlaps', () => {
  const { root, old, tested } = overlapRepo()
  writeFileSync(join(root, 'a.txt'), 'mine\n')
  assert.deepEqual(landOverlap(root, old, tested), ['a.txt'])
})

test('landOverlap: a staged change overlaps too', () => {
  const { root, old, tested } = overlapRepo()
  writeFileSync(join(root, 'a.txt'), 'mine\n')
  git(root, 'add', 'a.txt')
  assert.deepEqual(landOverlap(root, old, tested), ['a.txt'])
})

test('landOverlap: an untracked file overlaps only when the feature adds that same path', () => {
  const { root, old, tested } = overlapRepo()
  writeFileSync(join(root, 'n.txt'), 'my own\n')
  writeFileSync(join(root, 'scratch.txt'), 'x\n')
  assert.deepEqual(landOverlap(root, old, tested), ['n.txt'])
})

test('landOverlap: a dirty file the feature does not touch is no overlap, and the land goes through around it', () => {
  const { root, old, tested } = overlapRepo()
  writeFileSync(join(root, 'other.txt'), 'mine\n')
  writeFileSync(join(root, 'scratch.txt'), 'x\n')
  assert.deepEqual(landOverlap(root, old, tested), [])
  assert.deepEqual(land(root, 'main', tested, old), { ok: true })
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), tested)
  assert.equal(readFileSync(join(root, 'other.txt'), 'utf8'), 'mine\n')
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'feature\n')
})

test('land refuses an overlap before any git write: target, HEAD and the working tree stay exactly as they were', () => {
  const { root, old, tested } = overlapRepo()
  writeFileSync(join(root, 'a.txt'), 'mine\n')
  writeFileSync(join(root, 'n.txt'), 'my own\n')
  git(root, 'add', 'n.txt')
  const before = snapshot(root)
  const r = land(root, 'main', tested, old)
  assert.deepEqual(r, { ok: false, overlap: ['a.txt', 'n.txt'], reason: 'your uncommitted changes overlap this feature' })
  assert.deepEqual(snapshot(root), before)
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), old)
})
