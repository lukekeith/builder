// scripts/test/verify-e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from '../verify/git.mjs'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify', 'verify.mjs')
// PORT is removed from the CLI's env: an ambient PORT in the developer's shell would otherwise
// satisfy the port tests without the verifier leasing anything.
const cliEnv = () => {
  const env = { ...process.env, BUILDER_VERIFY_IDLE_MS: '1500' }
  delete env.PORT
  delete env.PORT_B
  return env
}
const cli = (cwd, ...a) => spawnSync('node', [CLIENT, ...a], { cwd, encoding: 'utf8', env: cliEnv() })
const T = (body) => `import { test } from 'node:test'\nimport assert from 'node:assert'\n${body}\n`

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 've2e-')))
  const counter = join(realpathSync(mkdtempSync(join(tmpdir(), 've2e-c-'))), 'n')
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, '.claude', 'builder.md'), `---\nproject: E2E\nbase_branch: main\napps:\n  - name: app\n    path: .\nverify:\n  workers: 2\n  suites:\n    unit: { runner: node-test, files: "test/*.test.mjs", app: app, needs: [{ ports: [PORT, PORT_B] }] }\n---\n`)
  writeFileSync(join(root, 'src', 'math.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(root, 'test', 'math.test.mjs'), T(`import { add } from '../src/math.mjs'\ntest('adds', () => assert.equal(add(2, 2), 4))`))
  writeFileSync(join(root, 'test', 'known.test.mjs'), T(`test('inherited debt', () => assert.equal('main', 'fixed'))`))
  writeFileSync(join(root, 'test', 'flaky.test.mjs'), T(`import { readFileSync, writeFileSync, existsSync } from 'node:fs'\ntest('wobbles', () => { const n = existsSync('${counter}') ? Number(readFileSync('${counter}', 'utf8')) : 0; writeFileSync('${counter}', String(n + 1)); assert.ok(n !== 0) })`))
  // Each port test records the PORT it ran with, outside the repo, so the test can prove the
  // verifier leased a real, distinct port to each rather than only that PORT looked numeric.
  const portsDir = realpathSync(mkdtempSync(join(tmpdir(), 've2e-p-')))
  // A lease grants one suite run its named ports, so the two tests read two names of one lease.
  for (const [n, v] of [['a', 'PORT'], ['b', 'PORT_B']]) {
    writeFileSync(join(root, 'test', `port-${n}.test.mjs`), T(`import { writeFileSync } from 'node:fs'\ntest('port ${n}', () => { writeFileSync('${join(portsDir, n)}', String(process.env.${v})); assert.match(String(process.env.${v}), /^\\d+$/) })`))
  }
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-feat`)
  git(root, 'worktree', 'add', '-qb', 'feat', wt)
  return { root, wt, portsDir, counter }
}
const commit = (wt, file, text, msg) => {
  writeFileSync(join(wt, file), text)
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', msg)
  return git(wt, 'rev-parse', 'HEAD')
}
const verdict = (wt, id) => {
  const w = cli(wt, 'wait', id, '--max', '120', '--json')
  try {
    return JSON.parse(w.stdout)
  } catch {
    throw new Error(`wait ${id} gave no JSON verdict (exit ${w.status})\nstdout: ${w.stdout}\nstderr: ${w.stderr}`)
  }
}

// The detached service exits on its own after BUILDER_VERIFY_IDLE_MS; wait for it so no service
// outlives the test or holds the temp dirs being removed.
const settle = (root) => {
  let pid
  try {
    pid = Number(readFileSync(join(root, '.builder', 'verify', 'serve.pid'), 'utf8'))
  } catch {
    return
  }
  const end = Date.now() + 30000
  while (Date.now() < end) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    spawnSync('sleep', ['0.2'])
  }
}

test('regression found and pinned to its commit; debt, flake and ports handled; the fix lands', (t) => {
  const { root, wt, portsDir, counter } = fixture()
  t.after(() => {
    settle(root)
    for (const d of [wt, root, portsDir, dirname(counter)]) rmSync(d, { recursive: true, force: true })
  })
  const ID = 'unit::test/math.test.mjs::adds'
  const request = (tier, ...extra) => cli(wt, 'request', wt, 'HEAD', '--tier', tier, ...extra).stdout.trim()

  // Single-commit path: a second branch whose whole range is the break, so it must be named.
  const wt2 = join(root, '..', `${root.split('/').pop()}-solo`)
  t.after(() => rmSync(wt2, { recursive: true, force: true }))
  git(root, 'worktree', 'add', '-qb', 'solo', wt2)
  const solo = commit(wt2, 'src/math.mjs', 'export const add = (a, b) => a - b\n', 'break add alone')
  const vs = verdict(wt2, cli(wt2, 'request', wt2, 'HEAD', '--tier', 'commit').stdout.trim())
  assert.equal(vs.status, 'red', JSON.stringify(vs))
  assert.deepEqual(vs.regressions.map((r) => r.id), [ID])
  assert.equal(vs.regressions[0].introducedBy, solo)

  // Multi-commit path: c1 innocent, c2 breaks add, c3 innocent, and ONE request at c3 with no
  // earlier green on the branch, so the range runs [c1, c2, c3] from the merge-base. Blaming the
  // oldest or the newest commit of the range would both name the wrong one.
  commit(wt, 'README.md', 'one\n', 'docs one')
  const c2 = commit(wt, 'src/math.mjs', 'export const add = (a, b) => a - b\n', 'break add')
  commit(wt, 'README.md', 'three\n', 'docs three')
  const v2 = verdict(wt, request('commit'))
  assert.equal(v2.status, 'red', JSON.stringify(v2))
  assert.deepEqual(v2.regressions.map((r) => r.id), [ID])
  assert.equal(v2.regressions[0].introducedBy, c2)

  commit(wt, 'src/math.mjs', 'export const add = (a, b) => a + b\n', 'fix add')
  const phase = verdict(wt, request('phase'))
  assert.equal(phase.status, 'green', JSON.stringify(phase))

  const merge = request('merge', '--hold')
  const m = verdict(wt, merge)
  assert.equal(m.status, 'green', JSON.stringify(m))
  assert.equal(m.regressions.length, 0)
  assert.ok(m.flakes.includes('unit::test/flaky.test.mjs::wobbles'), JSON.stringify(m.flakes))
  // The inherited failure is debt found at the merge tier; pin where it is reported.
  const KNOWN = 'unit::test/known.test.mjs::inherited debt'
  assert.ok(m.debt.includes(KNOWN) || m.known.includes(KNOWN), JSON.stringify({ debt: m.debt, known: m.known }))

  // Ports: both port tests ran, each saw a numeric leased PORT, the ports differ, and neither
  // was classed as debt or a regression (which a broken lease would produce, failing on main too).
  const ports = {}
  for (const n of ['a', 'b']) {
    assert.ok(!JSON.stringify([m.debt, m.known, m.regressions]).includes(`port-${n}`), `port-${n} was classified as failing`)
    ports[n] = readFileSync(join(portsDir, n), 'utf8')
    assert.match(ports[n], /^\d+$/)
  }
  assert.notEqual(ports.a, ports.b)

  const rel = cli(wt, 'release', merge)
  assert.equal(rel.status, 0, rel.stdout + rel.stderr)
  assert.equal(git(root, 'rev-parse', 'main'), m.merged)
  const st = JSON.parse(cli(wt, 'status', '--json').stdout)
  assert.ok(st.flakes.includes('unit::test/flaky.test.mjs::wobbles'))
  assert.ok(st.known.includes(KNOWN))
})
