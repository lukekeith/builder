import { execFileSync, execSync } from 'node:child_process'
import { dirname } from 'node:path'

const ID = ['-c', 'user.name=builder-verify', '-c', 'user.email=verify@localhost']
export const git = (cwd, ...a) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export const tryGit = (cwd, ...a) => {
  try {
    return git(cwd, ...a)
  } catch {
    return null
  }
}
/** The main checkout of the repo `cwd` belongs to — where `.builder/verify/` lives for every worktree. */
export const mainRoot = (cwd) => dirname(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
/**
 * A shell command, synchronously; stdout, or a throw carrying its output. `timeout` (default the
 * verifier's own 15 m; callers pass verify.timeoutMs) kills it, so one hung `npm ci` or lease hook
 * can't freeze the service — a sync call blocks the whole event loop while it runs.
 */
export const sh = (cmd, { cwd, env = process.env, timeout = 15 * 60000 } = {}) => {
  try {
    return execSync(cmd, { cwd, env, timeout, killSignal: 'SIGKILL', encoding: 'utf8', shell: '/bin/bash', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.code === 'ETIMEDOUT') {
      const err = new Error(`timed out after ${timeout / 1000}s: ${cmd}`)
      Object.assign(err, { stdout: e.stdout, stderr: e.stderr, status: e.status })
      throw err
    }
    throw e
  }
}
