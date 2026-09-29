import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spy } from './fixtures/spy-reads.mjs'
import { waitsOn } from '../program.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST = join(HERE, '..', 'list-features.mjs')
const SPY = pathToFileURL(join(HERE, 'fixtures', 'spy-reads.mjs')).href
const REG = 'docs/features'
const N = 2000

/** A live program (api archived, ui in flight, ui depending on api and on archived f7) over N archived features. */
function bigRepo() {
  const root = mkdtempSync(join(tmpdir(), 'scale-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  const put = (p, body) => {
    mkdirSync(dirname(join(root, REG, p)), { recursive: true })
    writeFileSync(join(root, REG, p), body)
  }
  for (let i = 0; i < N; i++) put(`_archive/f${i}/SPEC.md`, `# f${i} — spec\n> ✅ SHIPPED 2026-09-01 — PR #${i} · none\n`)
  put('_archive/api/SPEC.md', '# api — spec\n> ✅ SHIPPED 2026-09-02 — PR #1 · none\n')
  put('big/MANIFEST.md', 'tier: program\nnext: x\nchild: api — building\nchild: ui — spec\n')
  put('big/PROGRAM.md', '# big — program\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n| 1 | api | md | app | x | — |\n| 2 | ui | md | app | y | api, f7 |\n')
  put('ui/MANIFEST.md', 'size: md\nstate: spec\nnext: x\n')
  return root
}

const insideArchive = (paths) => paths.filter((p) => p.includes(`/${REG}/_archive/`))

test('waitsOn over a big archive reads nothing inside it', () => {
  const root = bigRepo()
  const seen = []
  const restore = spy((p) => seen.push(p))
  let deps
  try {
    deps = waitsOn(root, REG, 'ui')
  } finally {
    restore()
  }
  assert.deepEqual(deps, [])
  assert.ok(seen.some((p) => p.endsWith('big/MANIFEST.md')), 'the spy saw the program read')
  assert.deepEqual(insideArchive(seen), [])
})

test('list-features --json and --status over a big archive read nothing inside it', () => {
  const root = bigRepo()
  for (const mode of ['--json', '--status']) {
    const out = join(root, `spy${mode}.log`)
    const r = spawnSync('node', ['--import', SPY, LIST, mode], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, SPY_OUT: out } })
    assert.equal(r.status, 0, r.stderr)
    const seen = readFileSync(out, 'utf8').split('\n').filter(Boolean)
    assert.ok(seen.some((p) => p.endsWith('ui/MANIFEST.md')), `${mode}: the spy saw the live read`)
    assert.deepEqual(insideArchive(seen), [], mode)
    if (mode === '--status') assert.match(r.stdout, new RegExp(`📦 ${N + 1} shipped features archived`))
  }
})
