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
/** A shell command, synchronously; stdout, or a throw carrying its output. */
export const sh = (cmd, { cwd, env = process.env } = {}) => execSync(cmd, { cwd, env, encoding: 'utf8', shell: '/bin/bash', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
