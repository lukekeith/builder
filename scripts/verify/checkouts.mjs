/**
 * Run checkouts — the clean copies a worker tests, never the agent's live worktree (spec §The
 * units) — and landing: the merge queue fast-forwards the target to exactly the commit it tested.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { git, tryGit, sh } from './git.mjs'
import { checkedOutBranch } from '../config.mjs'

/**
 * Beside the main checkout, not in it: a checkout inside the consumer's tree is seen by its file
 * watchers, globs and tools (and by every test that walks the repo). State stays in .builder/verify/.
 */
export const checkoutsDir = (root) => `${root}-verify/co`

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

/**
 * agent_walk.copy's untracked files (a .env, certs, a local binary) from the main checkout into a
 * test checkout, as the fleet gives its worktrees — else tests that need them fail on branch and
 * target alike and are filed as known. A missing source is skipped; a file tracked at the
 * checkout's HEAD is never overwritten. Run after every move: `clean` removes what isn't ignored.
 */
export function copyLocal(root, path, rels) {
  if (!rels?.length) return
  const tracked = new Set((tryGit(path, 'ls-files', '-z') ?? '').split('\0').filter(Boolean))
  for (const rel of rels) {
    const src = join(root, rel)
    if (!existsSync(src)) continue
    // An untracked symlink left by the last copy would make cpSync see src and dest as one file
    // (it writes links as absolute ones): removed first, entry by entry. Tracked paths are skipped.
    cpSync(src, join(path, rel), {
      recursive: true,
      filter: (from) => {
        const r = relative(root, from)
        if (tracked.has(r)) return false
        const to = join(path, r)
        try {
          if (lstatSync(to).isSymbolicLink()) rmSync(to)
        } catch {}
        return true
      },
    })
  }
}

/** Merge `branchSha` onto `targetSha`. Only unmerged files make a conflict; any other failure throws with git's words. */
export function mergedCheckout(path, targetSha, branchSha, message) {
  checkoutAt(path, targetSha)
  try {
    git(path, 'merge', '--no-ff', '-m', message, branchSha)
    return { sha: git(path, 'rev-parse', 'HEAD') }
  } catch (err) {
    const files = (tryGit(path, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
    tryGit(path, 'merge', '--abort')
    if (!files.length) throw new Error(`merge of ${branchSha} failed: ${gitWords(err)}`)
    return { conflict: true, files }
  }
}

const gitWords = (err) => String(err.stderr || err.message).trim()

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

/** Fast-forward `target` to `tested` only if it still points at `expectedOld` and `tested` descends from it. */
export function land(root, target, tested, expectedOld) {
  const cur = tryGit(root, 'rev-parse', `refs/heads/${target}`)
  if (cur !== expectedOld) return { ok: false, reason: `${target} moved (${cur?.slice(0, 7)} is not ${expectedOld.slice(0, 7)})` }
  if (tryGit(root, 'merge-base', '--is-ancestor', expectedOld, tested) === null) return { ok: false, reason: `not a fast-forward of ${target}` }
  // Checked out in a linked worktree: moving the ref would leave that tree's files behind its branch.
  const elsewhere = (tryGit(root, 'worktree', 'list', '--porcelain') ?? '')
    .split('\n\n')
    .slice(1)
    .find((b) => b.split('\n').includes(`branch refs/heads/${target}`))
  if (elsewhere) return { ok: false, reason: `${target} is checked out in ${elsewhere.split('\n')[0].replace(/^worktree /, '')} — switch that worktree to another branch, then land again` }
  try {
    if (checkedOutBranch(root) === target) git(root, 'merge', '--ff-only', '--quiet', tested)
    else git(root, 'update-ref', `refs/heads/${target}`, tested, expectedOld)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `${target} moved or refused the fast-forward: ${gitWords(err)}` }
  }
}
