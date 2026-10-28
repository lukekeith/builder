/**
 * Run checkouts — the clean copies a worker tests, never the agent's live worktree (spec §The
 * units) — and landing: the merge queue fast-forwards the target to exactly the commit it tested.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { git, tryGit, sh } from './git.mjs'
import { checkedOutBranch } from '../config.mjs'

export const checkoutsDir = (root) => join(root, '.builder', 'verify', 'co')

export function ensureCheckout(root, slot) {
  const path = join(checkoutsDir(root), String(slot))
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(checkoutsDir(root), { recursive: true })
    tryGit(root, 'worktree', 'prune')
    git(root, 'worktree', 'add', '--detach', '-f', path, 'HEAD')
  }
  return path
}

export const commitExists = (root, sha) => tryGit(root, 'cat-file', '-e', `${sha}^{commit}`) !== null

/** Move a checkout to `sha`: forced, detached, untracked files gone (ignored ones — node_modules — kept). */
export function checkoutAt(path, sha) {
  tryGit(path, 'merge', '--abort')
  git(path, 'checkout', '-q', '--detach', '--force', sha)
  git(path, 'clean', '-fdq')
  return git(path, 'rev-parse', 'HEAD')
}

export function mergedCheckout(path, targetSha, branchSha, message) {
  checkoutAt(path, targetSha)
  if (tryGit(path, 'merge', '--no-ff', '-m', message, branchSha) !== null) return { sha: git(path, 'rev-parse', 'HEAD') }
  const files = (tryGit(path, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
  tryGit(path, 'merge', '--abort')
  return { conflict: true, files }
}

/** `verify.setup` in this checkout when its inputs (lockfiles by default) changed since it last ran. */
export function setupIfNeeded(path, verify, run = (cmd) => sh(cmd, { cwd: path })) {
  if (!verify.setup) return false
  const h = createHash('sha256').update(tryGit(path, 'ls-files', '-s', '--', ...verify.setupInputs) ?? '').update(verify.setup).digest('hex')
  const mark = `${path}.setup`
  if (existsSync(mark) && readFileSync(mark, 'utf8') === h) return false
  run(verify.setup)
  writeFileSync(mark, h)
  return true
}

export const changedFiles = (root, from, to) => (tryGit(root, 'diff', '--name-only', from, to) ?? '').split('\n').filter(Boolean)

/** Fast-forward `target` to `tested` only if it still points at `expectedOld`. */
export function land(root, target, tested, expectedOld) {
  const cur = tryGit(root, 'rev-parse', `refs/heads/${target}`)
  if (cur !== expectedOld) return { ok: false, reason: `${target} moved (${cur?.slice(0, 7)} is not ${expectedOld.slice(0, 7)})` }
  if (checkedOutBranch(root) === target) {
    return tryGit(root, 'merge', '--ff-only', '--quiet', tested) === null ? { ok: false, reason: `merge --ff-only refused in the main checkout — uncommitted changes there?` } : { ok: true }
  }
  return tryGit(root, 'update-ref', `refs/heads/${target}`, tested, expectedOld) === null ? { ok: false, reason: `${target} moved` } : { ok: true }
}
