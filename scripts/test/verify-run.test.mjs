// scripts/test/verify-run.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger } from '../verify/ledger.mjs'
import { runRequest, runShell, bisect } from '../verify/run.mjs'

const T = (body) => `import { test } from 'node:test'\nimport assert from 'node:assert'\n${body}\n`
function project(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vrun-')))
  mkdirSync(join(dir, 'test'))
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
  return dir
}
const suite = { name: 'unit', runner: 'node-test', files: 'test/*.test.mjs', cwd: '.', args: '', needs: [], tiers: ['commit', 'phase', 'merge'] }
function ctxFor(checkout, target, o = {}) {
  const ledger = openLedger(realpathSync(mkdtempSync(join(tmpdir(), 'vrun-l-'))))
  return {
    verify: { suites: [suite], checks: [], timeoutMs: 60000, db: null },
    pool: {},
    ledger,
    checkout,
    targetSha: 'tgt',
    signal: null,
    baseEnv: {},
    lease: async () => ({ env: {}, release() {} }),
    select: (co, base, suites) => Object.fromEntries(suites.map((s) => [s.name, { files: 'all', why: 'test' }])),
    targetCheckout: async () => target,
    atCommit: async () => {},
    ...o,
  }
}
const req = (o = {}) => ({ id: 'r1', branch: 'f', sha: 'abc', tier: 'commit', target: 'main', base: 'b0', commits: ['abc'], changed: [], ...o })

test('green: every test passes', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  const v = await runRequest(req(), ctxFor(co, co))
  assert.equal(v.status, 'green')
  assert.deepEqual(v.regressions, [])
  assert.equal(v.selection.unit.files, 'all')
})

test('a failure here but not on the target is a regression, introduced by the request commit', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('adds', () => assert.equal(1, 2))`) })
  const target = project({ 'test/a.test.mjs': T(`test('adds', () => {})`) })
  const v = await runRequest(req(), ctxFor(co, target))
  assert.equal(v.status, 'red')
  assert.equal(v.regressions.length, 1)
  assert.equal(v.regressions[0].id, 'unit::test/a.test.mjs::adds')
  assert.equal(v.regressions[0].introducedBy, 'abc')
  assert.match(v.regressions[0].msg, /2/)
})

test('failing on the target too: debt — added to known failures, verdict green', async () => {
  const body = T(`test('old', () => assert.equal(1, 2))`)
  const co = project({ 'test/a.test.mjs': body })
  const ctx = ctxFor(co, project({ 'test/a.test.mjs': body }))
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'green')
  assert.deepEqual(v.debt, ['unit::test/a.test.mjs::old'])
  assert.ok(ctx.ledger.known('main').ids.has('unit::test/a.test.mjs::old'))
  const again = await runRequest(req({ id: 'r2' }), ctx)
  assert.deepEqual(again.known, ['unit::test/a.test.mjs::old'])
})

test('a test that fails then passes on the same commit is listed as a flake, unless the branch owns it', async () => {
  const counter = join(realpathSync(mkdtempSync(join(tmpdir(), 'vrun-c-'))), 'n')
  const flaky = T(`import { readFileSync, writeFileSync, existsSync } from 'node:fs'\ntest('wobbles', () => { const n = existsSync('${counter}') ? Number(readFileSync('${counter}', 'utf8')) : 0; writeFileSync('${counter}', String(n + 1)); assert.ok(n % 2 === 1) })`)
  const co = project({ 'test/f.test.mjs': flaky })
  const ctx = ctxFor(co, co)
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'green')
  assert.deepEqual(v.flakes, ['unit::test/f.test.mjs::wobbles'])
  assert.equal(ctx.ledger.isFlaky('unit::test/f.test.mjs::wobbles'), true)
  writeFileSync(counter, '0')
  const owned = await runRequest(req({ id: 'r3', changed: ['test/f.test.mjs'] }), ctxFor(co, co))
  assert.equal(owned.status, 'red')
  assert.equal(owned.regressions[0].note, 'flaky test this branch owns')
})

test('no report → broken, retried once; still broken → env-broken, never red', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  let calls = 0
  const ctx = ctxFor(co, co, { verify: { suites: [{ ...suite, args: '--no-such-flag-xyz' }], checks: [], timeoutMs: 60000, db: null }, lease: async () => (calls++, { env: {}, release() {} }) })
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'env-broken')
  assert.equal(calls, 2)
  assert.match(v.broken[0].reason, /no report|empty report/)
})

test('checks: exit compare, and lines compare uses match and the target output', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  const target = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  writeFileSync(join(co, 'lint.txt'), '✗ old finding\n✗ new finding\nDone in 3.1s\n')
  writeFileSync(join(target, 'lint.txt'), '✗ old finding\nDone in 2.0s\n')
  const ctx = ctxFor(co, target, { verify: { suites: [], timeoutMs: 60000, db: null, checks: [
    { name: 'lint', run: 'cat lint.txt', cwd: '.', compare: 'lines', match: '✗', tiers: ['commit'], needs: [] },
    { name: 'types', run: 'exit 0', cwd: '.', compare: 'exit', match: null, tiers: ['commit'], needs: [] },
  ] } })
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'red')
  assert.deepEqual(v.regressions.map((r) => r.id), ['check::lint'])
  assert.match(v.regressions[0].msg, /new finding/)
  assert.doesNotMatch(v.regressions[0].msg, /Done in/)
})

test('phase tier reuses tests already green at this sha', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`), 'test/b.test.mjs': T(`test('ok', () => {})`) })
  const ctx = ctxFor(co, co, { select: () => ({ unit: { files: ['test/a.test.mjs', 'test/b.test.mjs'], why: {} } }) })
  ctx.ledger.appendResults([{ run: 'x', sha: 'abc', tier: 'commit', id: 'unit::test/a.test.mjs::ok', status: 'pass' }])
  const v = await runRequest(req({ tier: 'phase' }), ctx)
  assert.equal(v.status, 'green')
  assert.equal(v.reused, 1)
  assert.equal(v.selection.unit.files, 1)
})

test('bisect finds the first commit where each regression fails', async () => {
  const regs = [{ id: 'a' }, { id: 'b' }]
  let at = null
  const failsFrom = { a: 2, b: 3 }
  await bisect(regs, ['c1', 'c2', 'c3'], { atCommit: async (s) => { at = Number(s.slice(1)) }, statusAt: async (g) => (at >= failsFrom[g.id] ? 'fail' : 'pass') })
  assert.deepEqual(regs.map((g) => g.introducedBy), ['c2', 'c3'])
  assert.equal(at, 3)
})

test('bisect leaves the checkout at the last commit, and stops once cancelled', async () => {
  const calls = []
  const regs = [{ id: 'a' }]
  await bisect(regs, ['c1', 'c2', 'c3'], { atCommit: async (s) => calls.push(s), statusAt: async () => 'fail' })
  assert.deepEqual(calls, ['c1', 'c3'])
  assert.equal(regs[0].introducedBy, 'c1')
  const ac = new AbortController()
  ac.abort()
  calls.length = 0
  const stopped = [{ id: 'a' }]
  await bisect(stopped, ['c1', 'c2', 'c3'], { signal: ac.signal, atCommit: async (s) => calls.push(s), statusAt: async () => 'fail' })
  assert.deepEqual(calls, ['c3'])
  assert.equal(stopped[0].introducedBy, 'c3')
})

test('runShell kills on timeout', async () => {
  const r = await runShell('sleep 5', { cwd: tmpdir(), timeoutMs: 200 })
  assert.equal(r.timedOut, true)
})

test('runShell removes its abort listener when the run ends', async () => {
  const ac = new AbortController()
  await runShell('true', { cwd: tmpdir(), signal: ac.signal })
  await runShell('true', { cwd: tmpdir(), signal: ac.signal })
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0)
})

test('a failing test in a file the branch adds is a regression, not broken', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`), 'test/new.test.mjs': T(`test('fresh', () => assert.equal(1, 2))`) })
  const target = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  const v = await runRequest(req({ changed: ['test/new.test.mjs'] }), ctxFor(co, target))
  assert.equal(v.status, 'red')
  assert.deepEqual(v.regressions.map((r) => r.id), ['unit::test/new.test.mjs::fresh'])
  assert.deepEqual(v.broken, [])
})

test('a lines check whose target run times out is broken, and the target output is not cached', async () => {
  const co = project({})
  const target = project({})
  writeFileSync(join(co, 'lint.txt'), '✗ finding\n')
  writeFileSync(join(target, 'lint.txt'), '✗ finding\n')
  writeFileSync(join(target, 'slow'), '')
  const ctx = ctxFor(co, target, { verify: { suites: [], timeoutMs: 1000, db: null, checks: [
    { name: 'lint', run: 'if [ -f slow ]; then sleep 5; fi; cat lint.txt', cwd: '.', compare: 'lines', match: '✗', tiers: ['commit'], needs: [] },
  ] } })
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'env-broken')
  assert.deepEqual(v.regressions, [])
  assert.match(v.broken[0].reason, /check::lint: the run on the target timed out/)
  assert.equal(ctx.ledger.readLines('tgt', 'lint'), null)
})

test('cancelled while judging the first suite\'s failures: nothing more is judged or leased', async () => {
  const fails = (n) => T(`test('f${n}', () => assert.equal(1, 2))`)
  const co = project({ 'test/a.test.mjs': fails(1), 'test/b.test.mjs': fails(2), 'test/c.test.mjs': fails(3) })
  const ac = new AbortController()
  let calls = 0
  const ctx = ctxFor(co, co, {
    signal: ac.signal,
    verify: { suites: [suite, { ...suite, name: 'second' }], checks: [], timeoutMs: 60000, db: null },
    // The suite run is lease 1; the first single-test re-run (judging begins) is lease 2 — cancel there.
    lease: async () => (++calls === 2 && ac.abort(), { env: {}, release() {} }),
  })
  const t0 = Date.now()
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'cancelled')
  assert.equal(calls, 2)
  assert.deepEqual([v.regressions, v.flakes, v.debt, v.broken], [[], [], [], []])
  assert.ok(Date.now() - t0 < 10000)
})

test('the request\'s report dir is removed even when the run throws', async () => {
  const co = project({ 'test/a.test.mjs': T(`test('ok', () => {})`) })
  const ctx = ctxFor(co, co, { select: () => { throw new Error('boom') } })
  await assert.rejects(runRequest(req({ id: 'thrown' }), ctx), /boom/)
  assert.equal(existsSync(join(ctx.ledger.dir, 'reports', 'thrown')), false)
})
