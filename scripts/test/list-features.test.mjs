import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'list-features.mjs')

function repo(manifests, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lf-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  for (const [name, body] of Object.entries(manifests)) {
    mkdirSync(join(root, 'docs/features', name), { recursive: true })
    writeFileSync(join(root, 'docs/features', name, 'MANIFEST.md'), `size: md\nnext: x\n${body}\n`)
  }
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, 'docs/features', path), body)
  const r = spawnSync('node', [LIST, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 0, r.stderr)
  return Object.fromEntries(JSON.parse(r.stdout).features.map((f) => [f.feature, f]))
}

test('a parked feature says so, with its reason', () => {
  const rows = repo({ p: 'state: audited\nblocked: "plan wants to split — clears when you split it"' })
  assert.equal(rows.p.nextStep, '⛔ parked — plan wants to split — clears when you split it')
})

test('an agent-signed-off feature is not reported as human-walked; agent mode takes it to merged', () => {
  const rows = repo({
    a: 'state: built\nwalk: agent-pass 2026-09-26 abc123\nagent-walk: on 2026-09-26',
    s: 'state: signed-off\nwalk: agent-pass 2026-09-26 abc123\nagent-walk: on 2026-09-26',
    v: 'state: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc123\npr: #5\nagent-walk: on 2026-09-26',
    h: 'state: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc123\npr: #6\nagent-walk: off',
  })
  assert.equal(rows.a.lastDone, 'Agent-walked — not human-tested')
  assert.equal(rows.a.nextStep, 'Agent sign-off, then deep verify')
  assert.equal(rows.s.lastDone, 'Agent signed off — not human-tested')
  assert.equal(rows.v.nextStep, 'Ship and merge into the fleet branch (agent)')
  assert.equal(rows.h.nextStep, 'Review the PR, then /builder:signoff')
})

test('an agent-walk run at built says the agent walks next', () => {
  const rows = repo({ b: 'state: built\nready: yes 2026-09-26 abc\nagent-walk: on 2026-09-26' })
  assert.equal(rows.b.nextStep, 'Agent walk (fleet)')
})

test('a program child waiting on an unshipped dependency says so; its dependency does not wait', () => {
  const rows = repo({
    big: 'tier: program\nchild: api — building\nchild: ui — spec',
    api: 'state: building',
    ui: 'state: spec',
  }, {
    'big/PROGRAM.md': '# big — program\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n| 1 | api | md | app | x | — |\n| 2 | ui | md | app | y | api |\n',
  })
  assert.deepEqual(rows.ui.waitsOn, [{ name: 'api', state: 'building' }])
  assert.equal(rows.ui.nextStep, '⏳ waits on api (building)')
  assert.deepEqual(rows.api.waitsOn, [])
})
