// Repos for the tidy tests: main with a tracked test artefact, and a fixture with one branch or
// worktree in every inventory group.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A repo on main with one commit holding a tracked test artefact, the way d2m tracks one. */
export function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tidy-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, 'test-results'))
  writeFileSync(join(root, 'test-results/.last-run.json'), '{}\n')
  writeFileSync(join(root, 'app.js'), 'one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}
/** A branch off main carrying one commit; `manifest` (feature → text) is written under the registry. */
export function branch(root, name, { manifest = {}, file } = {}) {
  git(root, 'switch', '-q', '-c', name, 'main')
  for (const [f, text] of Object.entries(manifest)) {
    mkdirSync(join(root, 'docs/features', f), { recursive: true })
    writeFileSync(join(root, 'docs/features', f, 'MANIFEST.md'), text)
  }
  writeFileSync(join(root, file ?? `${name.replace(/\W/g, '-')}.txt`), name)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `on ${name}`)
  git(root, 'switch', '-q', 'main')
}

export function fixture() {
  const root = repo()
  git(root, 'branch', 'feat/old') // already in main
  branch(root, 'builder/r', { manifest: { r: 'size: md\nstate: verified\nverify: READY 2026-10-03\nnext: x\n' } })
  branch(root, 'builder/p', { manifest: { p: 'size: md\nstate: audited\nblocked: "D3 is open — next: answer D3 in the SPEC, then /builder:agent"\nnext: x\n' } })
  branch(root, 'builder/i', { manifest: { i: 'size: md\nstate: planned\nnext: x\n' } })
  branch(root, 'feat/x', { manifest: { x: 'size: md\nstate: building\nbranch: feat/x\nnext: x\n' } })
  branch(root, 'spike')
  branch(root, 'builder/run', { manifest: { run: 'size: md\nstate: building\nnext: x\n' } })
  git(root, 'worktree', 'add', '-q', `${root}-wt-p`, 'builder/p')
  git(root, 'worktree', 'add', '-q', `${root}-wt-old`, 'feat/old')
  git(root, 'worktree', 'add', '-q', '--detach', `${root}-wt-detached`)
  git(root, 'worktree', 'add', '-q', '-b', 'gone-wt', `${root}-wt-gone`)
  rmSync(`${root}-wt-gone`, { recursive: true, force: true })
  return root
}
