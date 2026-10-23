/**
 * A throwaway git repo holding one feature from fixtures/lean/<name>: its config at
 * .claude/builder.md, its SPEC/PLAN/MANIFEST under docs/features/<feature>/, committed on main, then
 * checked out on builder/<feature> — the shape a fleet worktree has when the build starts.
 */
import { mkdtempSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = join(HERE, '..', '..')
export const LEAN = join(HERE, 'lean')

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function leanRepo(name, { feature = name, files = ['SPEC.md', 'PLAN.md', 'MANIFEST.md'], extra = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `lean-${name}-`)))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, '.claude'), { recursive: true })
  cpSync(join(LEAN, name, 'builder.md'), join(root, '.claude', 'builder.md'))
  const folder = join(root, 'docs', 'features', feature)
  mkdirSync(folder, { recursive: true })
  for (const f of files) if (existsSync(join(LEAN, name, f))) cpSync(join(LEAN, name, f), join(folder, f))
  writeFileSync(join(root, '.gitignore'), '.builder/\n')
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixture')
  git(root, 'checkout', '-qb', `builder/${feature}`)
  return { root, folder, rel: `docs/features/${feature}`, feature }
}

/** Run a script from scripts/ with node, in `cwd`. → { status, stdout, stderr } */
export function run(script, args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BUILDER_TODAY: '2026-10-23', CLAUDE_PLUGIN_ROOT: '', ...env },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

export const readText = (p) => readFileSync(p, 'utf8')
