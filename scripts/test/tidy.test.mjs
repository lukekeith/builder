import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git, repo, fixture } from './fixtures/tidy-repo.mjs'

const TIDY = join(dirname(fileURLToPath(import.meta.url)), '..', 'tidy.mjs')
const configure = (root) => {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  return root
}
const tidy = (root, ...args) => spawnSync('node', [TIDY, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

test('plan --json lists every item with its group and action', () => {
  const root = configure(fixture())
  const r = tidy(root, 'plan', '--json')
  assert.equal(r.status, 0, r.stderr)
  const { target, items } = JSON.parse(r.stdout)
  assert.equal(target, 'main')
  const g = Object.fromEntries(items.map((i) => [i.name, `${i.group}/${i.action}`]))
  assert.equal(g['feat/old'], 'merged/delete')
  assert.equal(g['builder/r'], 'ready/merge')
  assert.equal(g.spike, 'unknown/ask')
})

test('delete-branch removes a merged branch and its worktree, and refuses an unmerged one', () => {
  const root = configure(fixture())
  const r = tidy(root, 'apply', 'delete-branch', 'feat/old', 'spike')
  assert.equal(r.status, 1, 'one refusal')
  assert.match(r.stdout, /✓ feat\/old — deleted \(and its worktree\)/)
  assert.match(r.stdout, /✗ spike — 1 commit not in main; delete it only with force-delete-branch/)
  assert.equal(git(root, 'branch', '--list', 'feat/old'), '')
  assert.equal(existsSync(`${root}-wt-old`), false)
  assert.ok(git(root, 'branch', '--list', 'spike'))
})

test('force-delete-branch deletes unmerged work and says how much', () => {
  const root = configure(fixture())
  const r = tidy(root, 'apply', 'force-delete-branch', 'spike')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ spike — deleted, with 1 commit that was not in main/)
  assert.equal(git(root, 'branch', '--list', 'spike'), '')
})

test('remove-worktree keeps the branch and stashes a real change; dead worktrees are pruned', () => {
  const root = configure(fixture())
  writeFileSync(join(`${root}-wt-p`, 'app.js'), 'edited\n')
  const r = tidy(root, 'apply', 'remove-worktree', 'builder/p', `${root}-wt-gone`, `${root}-wt-detached`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ builder\/p — worktree removed; uncommitted changes are in stash "builder: p leftovers/)
  assert.equal(existsSync(`${root}-wt-p`), false)
  assert.ok(git(root, 'branch', '--list', 'builder/p'), 'the branch stays')
  assert.doesNotMatch(git(root, 'worktree', 'list'), /wt-gone|wt-detached/)
})

test('merge: a branch carrying the target merges --no-ff and goes; one that does not is handed to the fleet', () => {
  const root = configure(repo())
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'config')
  git(root, 'switch', '-q', '-c', 'builder/r')
  mkdirSync(join(root, 'docs/features/r'), { recursive: true })
  writeFileSync(join(root, 'docs/features/r/MANIFEST.md'), 'size: md\nstate: verified\nnext: x\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'r verified')
  git(root, 'switch', '-q', '-c', 'builder/s', 'main')
  mkdirSync(join(root, 'docs/features/s'), { recursive: true })
  writeFileSync(join(root, 'docs/features/s/MANIFEST.md'), 'size: md\nstate: verified\nnext: x\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 's verified')
  git(root, 'switch', '-q', 'main')
  writeFileSync(join(root, 'app.js'), 'main moved\n')
  git(root, 'commit', '-qam', 'main moved')
  // r is brought up to date with main; s is left behind it.
  git(root, 'switch', '-q', 'builder/r')
  git(root, 'merge', '-q', 'main', '-m', 'r takes main')
  git(root, 'switch', '-q', 'main')
  const r = tidy(root, 'apply', 'merge', 'builder/r', 'builder/s')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓ builder\/r — merged into main/)
  assert.match(git(root, 'log', '--oneline', '-1', 'main'), /merge\(r\): merged by \/builder:tidy/)
  assert.equal(git(root, 'branch', '--list', 'builder/r'), '')
  assert.match(r.stdout, /→ builder\/s — behind main: the fleet brings it up to date and merges it/)
  assert.match(r.stdout, /^handed: s$/m)
})

test('C1: tidy refuses a target that does not exist, and deletes nothing', () => {
  const root = configure(fixture())
  const plan = tidy(root, 'plan', '--into', 'develop')
  assert.equal(plan.status, 2)
  assert.match(plan.stderr, /develop, does not exist/)
  const del = tidy(root, 'apply', 'delete-branch', 'spike', '--into', 'develop')
  assert.equal(del.status, 2)
  assert.ok(git(root, 'branch', '--list', 'spike'), 'spike survives')
})

test('apply refuses anything the inventory says is running', () => {
  const root = configure(fixture())
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ features: { run: { status: 'building', branch: 'builder/run' } } }))
  writeFileSync(join(root, '.builder/fleet/lock'), String(process.pid))
  const r = tidy(root, 'apply', 'force-delete-branch', 'builder/run')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ builder\/run — running now/)
  assert.ok(git(root, 'branch', '--list', 'builder/run'))
})
