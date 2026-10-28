import { execFileSync, execSync } from 'node:child_process'
import { dirname } from 'node:path'

const run = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const FALLBACK = { 'user.name': 'builder-verify', 'user.email': 'verify@localhost' }
const ids = new Map()
/**
 * The identity a commit here needs: none when the repo (or the user) has one, so a landed merge
 * carries the user's name as the old fleet merge did; builder-verify only for a key nobody set —
 * a fresh CI box, where git would otherwise refuse to commit. Looked up once per cwd.
 */
const identity = (cwd) => {
  const key = String(cwd)
  if (!ids.has(key)) {
    const has = (k) => {
      try {
        return run(cwd, ['config', k]) !== ''
      } catch {
        return false
      }
    }
    ids.set(key, Object.entries(FALLBACK).filter(([k]) => !has(k)).flatMap(([k, v]) => ['-c', `${k}=${v}`]))
  }
  return ids.get(key)
}
export const git = (cwd, ...a) => run(cwd, [...identity(cwd), ...a])
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
