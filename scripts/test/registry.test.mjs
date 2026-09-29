import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCHIVE, features, isArchived, specDir, isShippedFolder } from '../registry.mjs'

const REG = 'docs/features'

function tree(paths) {
  const root = mkdtempSync(join(tmpdir(), 'reg-'))
  for (const [p, body] of Object.entries(paths)) {
    const full = join(root, REG, p)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

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
