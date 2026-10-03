/**
 * tidy-core — what builder leaves on disk, and taking it away safely. Shared by the fleet (which
 * clears a feature's worktree when it lands or stops) and /builder:tidy (which clears what older
 * runs left). Nothing here pushes, touches a remote, or throws work away: test output is restored,
 * anything else uncommitted is stashed under a name that says whose it was.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirtyPaths } from './gates-core.mjs'

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/** What test runners rewrite on every run — never anyone's work. */
export const TEST_OUTPUT = ['test-results/', 'playwright-report/', 'coverage/', '.nyc_output/', '.builder/']
const JUNIT = /^junit[^/]*\.xml$/

export const isTestOutput = (path) => TEST_OUTPUT.some((p) => path.startsWith(p)) || JUNIT.test(path.split('/').pop())

const day = (d) => d.toISOString().slice(0, 10)

/**
 * Remove a worktree without losing anything in it: tracked test output is restored, any other
 * uncommitted tracked change is stashed as `builder: <label> leftovers <date>` (stashes are shared
 * by every worktree of the repo, so it is reachable from the main checkout), then the worktree goes.
 * Untracked files go with it — walk evidence, a copied .env. `{ removed, stash, restored }`.
 */
export function clearWorktree(root, wt, label, today = new Date()) {
  if (!existsSync(wt)) {
    tryGit(['worktree', 'prune'], root)
    return { removed: false, stash: null, restored: [] }
  }
  const dirty = dirtyPaths(wt)
  const restored = dirty.filter(isTestOutput)
  if (restored.length) git(['checkout', '--', ...restored], wt)
  let stash = null
  if (dirty.length > restored.length) {
    stash = `builder: ${label} leftovers ${day(today)}`
    git(['stash', 'push', '-m', stash], wt)
  }
  const removed = tryGit(['worktree', 'remove', '--force', wt], root) !== null
  tryGit(['worktree', 'prune'], root)
  return { removed, stash, restored }
}
