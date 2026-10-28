import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../verify/git.mjs'
import { selectSuites, fromCwd } from '../verify/select.mjs'

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'vsel-'))
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.mjs'), 'export const b = 1\n')
  writeFileSync(join(root, 'test', 'a.test.mjs'), "import { a } from '../src/a.mjs'\n")
  writeFileSync(join(root, 'test', 'b.test.mjs'), "import { b } from '../src/b.mjs'\n")
  writeFileSync(join(root, 'package.json'), '{}\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}
const suites = [{ name: 'unit', files: 'test/*.test.mjs', cwd: '.' }, { name: 'e2e', files: null, cwd: '.' }]

test('only the tests a change reaches; a suite without a glob runs whole', () => {
  const { root, base } = repo()
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 2\n')
  git(root, 'commit', '-qam', 'a')
  const s = selectSuites(root, base, suites)
  assert.deepEqual(s.unit.files, ['test/a.test.mjs'])
  assert.equal(s.e2e.files, 'all')
})

test('a change the graph cannot see past selects the whole suite; nothing reached selects none', () => {
  const { root, base } = repo()
  writeFileSync(join(root, 'package.json'), '{"x":1}\n')
  git(root, 'commit', '-qam', 'deps')
  assert.equal(selectSuites(root, base, suites).unit.files, 'all')
  const r2 = repo()
  writeFileSync(join(r2.root, 'README.md'), 'hi\n')
  git(r2.root, 'add', '.')
  git(r2.root, 'commit', '-qm', 'docs')
  assert.deepEqual(selectSuites(r2.root, r2.base, suites).unit.files, [])
})

test('fromCwd makes repo paths relative to a suite cwd', () => {
  assert.deepEqual(fromCwd('server', ['server/test/a.ts']), ['test/a.ts'])
  assert.deepEqual(fromCwd('.', ['x.ts']), ['x.ts'])
})
