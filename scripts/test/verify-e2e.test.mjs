// scripts/test/verify-e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from '../verify/git.mjs'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify', 'verify.mjs')
const cli = (cwd, ...a) => spawnSync('node', [CLIENT, ...a], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_VERIFY_IDLE_MS: '1500' } })
const T = (body) => `import { test } from 'node:test'\nimport assert from 'node:assert'\n${body}\n`

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 've2e-')))
  const counter = join(realpathSync(mkdtempSync(join(tmpdir(), 've2e-c-'))), 'n')
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, '.claude', 'builder.md'), `---\nproject: E2E\nbase_branch: main\napps:\n  - name: app\n    path: .\nverify:\n  workers: 2\n  suites:\n    unit: { runner: node-test, files: "test/*.test.mjs", app: app, needs: [{ ports: [PORT] }] }\n---\n`)
  writeFileSync(join(root, 'src', 'math.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(root, 'test', 'math.test.mjs'), T(`import { add } from '../src/math.mjs'\ntest('adds', () => assert.equal(add(2, 2), 4))`))
  writeFileSync(join(root, 'test', 'known.test.mjs'), T(`test('inherited debt', () => assert.equal('main', 'fixed'))`))
  writeFileSync(join(root, 'test', 'flaky.test.mjs'), T(`import { readFileSync, writeFileSync, existsSync } from 'node:fs'\ntest('wobbles', () => { const n = existsSync('${counter}') ? Number(readFileSync('${counter}', 'utf8')) : 0; writeFileSync('${counter}', String(n + 1)); assert.ok(n !== 0) })`))
  writeFileSync(join(root, 'test', 'port.test.mjs'), T(`test('has its own port', () => assert.match(String(process.env.PORT), /^\\d+$/))`))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-feat`)
  git(root, 'worktree', 'add', '-qb', 'feat', wt)
  return { root, wt }
}
const commit = (wt, file, text, msg) => {
  writeFileSync(join(wt, file), text)
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', msg)
  return git(wt, 'rev-parse', 'HEAD')
}
const verdict = (wt, id) => {
  const w = cli(wt, 'wait', id, '--max', '120', '--json')
  return JSON.parse(w.stdout)
}

test('regression found and pinned to its commit; debt, flake and ports handled; the fix lands', () => {
  const { root, wt } = fixture()
  const broke = commit(wt, 'src/math.mjs', 'export const add = (a, b) => a - b\n', 'break add')
  const id1 = cli(wt, 'request', wt, 'HEAD', '--tier', 'commit').stdout.trim()
  commit(wt, 'README.md', 'hi\n', 'docs')
  const id2 = cli(wt, 'request', wt, 'HEAD', '--tier', 'commit').stdout.trim()
  const v = verdict(wt, id2)
  assert.equal(v.status, 'red')
  assert.deepEqual(v.regressions.map((r) => r.id), ['unit::test/math.test.mjs::adds'])
  assert.equal(v.regressions[0].introducedBy, broke)
  assert.equal(verdict(wt, id1).status, 'red')

  commit(wt, 'src/math.mjs', 'export const add = (a, b) => a + b\n', 'fix add')
  const phase = verdict(wt, cli(wt, 'request', wt, 'HEAD', '--tier', 'phase').stdout.trim())
  assert.equal(phase.status, 'green', JSON.stringify(phase))

  const merge = cli(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold').stdout.trim()
  const m = verdict(wt, merge)
  assert.equal(m.status, 'green', JSON.stringify(m))
  assert.ok(m.debt.includes('unit::test/known.test.mjs::inherited debt') || m.known.includes('unit::test/known.test.mjs::inherited debt'))
  assert.ok(m.flakes.includes('unit::test/flaky.test.mjs::wobbles'))
  assert.equal(m.regressions.length, 0)
  const rel = cli(wt, 'release', merge)
  assert.equal(rel.status, 0, rel.stdout + rel.stderr)
  assert.equal(git(root, 'rev-parse', 'main'), m.merged)
  const st = JSON.parse(cli(wt, 'status', '--json').stdout)
  assert.ok(st.flakes.includes('unit::test/flaky.test.mjs::wobbles'))
  assert.ok(st.known.includes('unit::test/known.test.mjs::inherited debt'))
})
