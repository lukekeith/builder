import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-obligations.mjs')

function run(spec) {
  const root = mkdtempSync(join(tmpdir(), 'co-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  mkdirSync(join(root, 'docs/features/f'), { recursive: true })
  writeFileSync(join(root, 'docs/features/f/SPEC.md'), spec)
  const r = spawnSync('node', [SCRIPT, 'f', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  return { ...r, findings: r.stdout ? JSON.parse(r.stdout)[0].findings : null }
}

const DECISIONS = (rows) => `# f — spec\n\n## Decisions\n| # | Decision | Ruling | Who / date |\n|---|---|---|---|\n${rows}\n`

test('a Rejected: clause naming only the option warns, and the spec still passes', () => {
  const r = run(DECISIONS('| D1 | Cache | Memoize per request. Rejected: Redis. | Luke 2026-09-29 |'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings.map((f) => [f.severity, f.rule, f.id]), [['WARN', 'rejected option gives no reason', 'D1']])
})

test('a Rejected: clause with its reason passes silently', () => {
  for (const clause of ['Rejected: Redis — a second service to run.', 'Rejected: Redis, because nothing else needs it.', 'Rejected: Redis (ops cost).', 'Rejected: Redis; it would need a second deploy.']) {
    const r = run(DECISIONS(`| D1 | Cache | Memoize per request. ${clause} | Luke 2026-09-29 |`))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.findings, [], clause)
  }
})

test('a pre-4.0 spec with §Overview and no §Idea raises nothing about §Idea', () => {
  const r = run('# f — spec\n\n## Overview\nOld.\n\n## Decisions\n| # | Decision | Ruling | Who / date |\n|---|---|---|---|\n| D1 | a | b | c |\n')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings, [])
})

test('multiple rejected options in a list (terse form) warns once', () => {
  const r = run(DECISIONS('| D1 | Render | Rejected: one per frame; one per screen. | Luke 2026-09-29 |'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings.map((f) => [f.severity, f.rule, f.id]), [['WARN', 'rejected option gives no reason', 'D1']])
})

test('Rejected alternative: or Rejected for now: or Rejected here: are matched', () => {
  for (const prefix of ['Rejected alternative:', 'Rejected for now:', 'Rejected here:']) {
    const r = run(DECISIONS(`| D1 | Cache | Memoize per request. ${prefix} Redis. | Luke 2026-09-29 |`))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.findings.map((f) => [f.severity, f.rule, f.id]), [['WARN', 'rejected option gives no reason', 'D1']], prefix)
  }
})

test('two rejection clauses in one cell: first bare, second with reason → one WARN', () => {
  const r = run(DECISIONS('| D1 | Cache | Rejected: Redis. Rejected: a file cache — lost on restart. | Luke 2026-09-29 |'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings.map((f) => [f.severity, f.rule, f.id]), [['WARN', 'rejected option gives no reason', 'D1']])
})
