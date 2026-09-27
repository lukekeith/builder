import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitsOn } from '../program.mjs'

const REG = 'docs/features'

/** `children` maps a child to its program-manifest state; `deps` to its Depends on cell. */
function registry({ children, deps, folders = {}, cellFor = (c) => c }) {
  const root = mkdtempSync(join(tmpdir(), 'prog-'))
  const prog = join(root, REG, 'big')
  mkdirSync(prog, { recursive: true })
  writeFileSync(
    join(prog, 'MANIFEST.md'),
    `tier: program\nnext: x\n${Object.entries(children).map(([c, s]) => `child: ${c} — ${s}`).join('\n')}\n`
  )
  const rows = Object.keys(children).map((c, i) => `| ${i + 1} | ${cellFor(c)} | md | app | does ${c} | ${deps[c] ?? '—'} |`)
  writeFileSync(
    join(prog, 'PROGRAM.md'),
    `# big — program\n> tier: program\n\n## Overview\nx\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## Shared decisions\n| # | Decision | Ruling | Who / date |\n|---|---|---|---|\n| 1 | a | b | c |\n`
  )
  for (const [name, files] of Object.entries(folders)) {
    mkdirSync(join(root, REG, name), { recursive: true })
    for (const [f, body] of Object.entries(files)) writeFileSync(join(root, REG, name, f), body)
  }
  return root
}

test('a feature in no program waits on nothing', () => {
  const root = registry({ children: { a: 'spec' }, deps: {} })
  assert.deepEqual(waitsOn(root, REG, 'loner'), [])
})

test('a child whose dependencies have not shipped waits on each, with its state', () => {
  const root = registry({ children: { a: 'building', b: 'spec', c: 'spec' }, deps: { c: 'a, b' } })
  assert.deepEqual(waitsOn(root, REG, 'c'), [
    { name: 'a', state: 'building' },
    { name: 'b', state: 'spec' },
  ])
  assert.deepEqual(waitsOn(root, REG, 'a'), [])
})

test('Depends on can name rows by number, mixed with names', () => {
  const root = registry({ children: { a: 'shipped', b: 'audited', c: 'spec' }, deps: { c: '#1 2' } })
  assert.deepEqual(waitsOn(root, REG, 'c'), [{ name: 'b', state: 'audited' }])
})

test('a dependency shipped per the program manifest is met', () => {
  const root = registry({ children: { a: 'shipped', c: 'spec' }, deps: { c: 'a' } })
  assert.deepEqual(waitsOn(root, REG, 'c'), [])
})

test("a dependency whose own folder shows it shipped is met, even when the child line lags", () => {
  const root = registry({
    children: { a: 'verified', b: 'verified', c: 'spec' },
    deps: { c: 'a, b' },
    folders: { a: { 'SPEC.md': '# a — spec\n> ✅ **SHIPPED** 2026-09-01 · PR #12\n' }, b: { 'MANIFEST.md': 'size: md\nstate: shipped\n' } },
  })
  assert.deepEqual(waitsOn(root, REG, 'c'), [])
})

test('a token that names no child holds the child back rather than letting it run', () => {
  const root = registry({ children: { a: 'shipped', c: 'spec' }, deps: { c: 'a, typo' } })
  assert.deepEqual(waitsOn(root, REG, 'c'), [{ name: 'typo', state: 'no such child or feature' }])
})

test('a dependency outside the program is a registry feature, met once it shipped; a parenthetical is a note', () => {
  const root = registry({
    children: { a: 'planned', c: 'spec' },
    deps: { a: 'lib (shipped)', c: 'a, other' },
    folders: {
      lib: { 'MANIFEST.md': 'tier: program\nchild: x — shipped\n', 'PROGRAM.md': '# lib — program\n> ✅ SHIPPED 2026-09-26 — PR #1\n' },
      other: { 'MANIFEST.md': 'size: md\nstate: building\n' },
    },
  })
  assert.deepEqual(waitsOn(root, REG, 'a'), [])
  assert.deepEqual(waitsOn(root, REG, 'c'), [
    { name: 'a', state: 'planned' },
    { name: 'other', state: 'building' },
  ])
})

test('the feature cell may be a link or code span', () => {
  const root = registry({
    children: { a: 'planned', c: 'spec' },
    deps: { c: '`a`' },
    cellFor: (c) => (c === 'a' ? '[`a`](../a/)' : `\`${c}\``),
  })
  assert.deepEqual(waitsOn(root, REG, 'c'), [{ name: 'a', state: 'planned' }])
})
