import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
/**
 * `--tree`: the worktree as it stands — staged, unstaged AND untracked files (.gitignore'd ones left
 * out) — as a commit on HEAD, without touching the index, the branch or the files. `git stash create`
 * leaves untracked files out, so a task's new files were missing from its own test run and the
 * build failed as env-broken. HEAD itself when nothing differs from it.
 */
export function treeSnapshot(wt) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tree-'))
  const index = join(dir, 'index')
  try {
    const real = resolve(wt, git(wt, 'rev-parse', '--git-path', 'index'))
    if (existsSync(real)) copyFileSync(real, index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const g = (...a) => execFileSync('git', [...identity(wt), ...a], { cwd: wt, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    g('add', '-A', '--', '.')
    const tree = g('write-tree')
    const head = git(wt, 'rev-parse', 'HEAD')
    if (tree === git(wt, 'rev-parse', 'HEAD^{tree}')) return head
    return g('commit-tree', tree, '-p', head, '-m', 'verify --tree: the worktree as it stood, untracked files included')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
