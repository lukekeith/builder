import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { ARCHIVE, features, isArchived, specDir, isShippedFolder } from '../scripts/registry.mjs'

const REG = 'docs/features'
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'registry.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function tree(paths) {
  const root = mkdtempSync(join(tmpdir(), 'reg-'))
  for (const [p, body] of Object.entries(paths)) {
    const full = join(root, REG, p)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

function repo(paths) {
  const root = tree(paths)
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}

const sweepCli = (root) => spawnSync('node', [SCRIPT, '--sweep'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

test('features lists in-flight folders only — never the archive, dot-folders or files', () => {
  const root = tree({ 'a/MANIFEST.md': 'x', 'b/SPEC.md': 'x', '_archive/old/SPEC.md': 'x', '.hidden/x.md': 'x', 'README.md': 'x' })
  assert.deepEqual(features(root, REG).sort(), ['a', 'b'])
  assert.equal(ARCHIVE, '_archive')
})

test('features of a missing registry is empty', () => {
  assert.deepEqual(features(mkdtempSync(join(tmpdir(), 'reg-')), REG), [])
})

test('isArchived and specDir: live first, then the archive, else the live path', () => {
  const root = tree({ 'live/SPEC.md': 'x', '_archive/gone/SPEC.md': 'x' })
  assert.equal(isArchived(root, REG, 'gone'), true)
  assert.equal(isArchived(root, REG, 'live'), false)
  assert.equal(specDir(root, REG, 'live'), join(root, REG, 'live'))
  assert.equal(specDir(root, REG, 'gone'), join(root, REG, '_archive', 'gone'))
  assert.equal(specDir(root, REG, 'nowhere'), join(root, REG, 'nowhere'))
})

test('isShippedFolder reads the SPEC or PROGRAM header, or a shipped manifest', () => {
  const root = tree({
    's/SPEC.md': '# s — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    'p/PROGRAM.md': '# p — program\n> ✅ **SHIPPED** 2026-09-01\n',
    'm/MANIFEST.md': 'size: md\nstate: shipped\n',
    'o/SPEC.md': '# o — spec\n> ✅ SIGNED OFF 2026-09-01\n',
  })
  for (const n of ['s', 'p', 'm']) assert.equal(isShippedFolder(join(root, REG, n)), true, n)
  assert.equal(isShippedFolder(join(root, REG, 'o')), false)
  assert.equal(isShippedFolder(join(root, REG, 'missing')), false)
})

test('--sweep moves every shipped folder and shipped program into _archive, staged not committed', () => {
  const root = repo({
    'done/SPEC.md': '# done — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    'prog/PROGRAM.md': '# prog — program\n> ✅ SHIPPED 2026-09-02\n',
    'prog/MANIFEST.md': 'tier: program\nchild: x — shipped\n',
    'live/MANIFEST.md': 'size: md\nstate: building\nnext: x\n',
    'live/SPEC.md': '# live — spec\n',
  })
  const r = sweepCli(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Moved 2 shipped folder\(s\) into docs\/features\/_archive\//)
  assert.ok(existsSync(join(root, REG, '_archive/done/SPEC.md')))
  assert.ok(existsSync(join(root, REG, '_archive/prog/PROGRAM.md')))
  assert.ok(existsSync(join(root, REG, 'live/SPEC.md')), 'in-flight work stays')
  assert.equal(existsSync(join(root, REG, 'done')), false)
  assert.match(git(root, 'status', '--porcelain'), /^R  docs\/features\/done\/SPEC\.md -> docs\/features\/_archive\/done\/SPEC\.md$/m)
  assert.equal(git(root, 'log', '--oneline').split('\n').length, 1, 'nothing committed')
})

test('--sweep archives legacy README-shipped folders, but not shipped-ready or in-flight ones', () => {
  const root = repo({
    'hdr/README.md': '# hdr\n> ✅ **SHIPPED** 2026-08-01 — PR #4\n',
    'status/README.md': '# status\n**Status:** SHIPPED 2026-08-02\n',
    'bold/README.md': '# bold\n**Status: SHIPPED — PR #9**\n',
    'ready/README.md': '# ready\n**Status:** Shipped-ready, waiting on QA\n',
    'later/README.md': '# later\n**Status:** building; SHIPPED soon\n',
  })
  assert.equal(isShippedFolder(join(root, REG, 'hdr')), true)
  const r = sweepCli(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Moved 3 shipped folder\(s\)/)
  for (const n of ['hdr', 'status', 'bold']) assert.ok(existsSync(join(root, REG, '_archive', n, 'README.md')), n)
  for (const n of ['ready', 'later']) assert.ok(existsSync(join(root, REG, n, 'README.md')), n)
})

test('--sweep refuses on uncommitted registry changes and moves nothing', () => {
  const root = repo({ 'done/SPEC.md': '# done — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n' })
  writeFileSync(join(root, REG, 'done/notes.md'), 'wip\n')
  const r = sweepCli(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /uncommitted changes under docs\/features/)
  assert.ok(existsSync(join(root, REG, 'done/SPEC.md')))
})

test('--sweep leaves a folder whose name is already archived, and says so', () => {
  const root = repo({
    'dup/SPEC.md': '# dup — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    '_archive/dup/SPEC.md': '# dup — spec\n> ✅ SHIPPED 2026-01-01 — PR #0\n',
  })
  const r = sweepCli(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /⚠ dup — docs\/features\/_archive\/dup already exists; left in place/)
  assert.match(r.stdout, /Nothing to archive/)
  assert.ok(existsSync(join(root, REG, 'dup/SPEC.md')))
})

test('registry.mjs without --sweep is a usage error', () => {
  const root = repo({ 'a/SPEC.md': 'x' })
  const r = spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Usage: registry\.mjs --sweep/)
})
