// scripts/test/verify-run.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openLedger } from '../verify/ledger.mjs'
import { runRequest, runShell, bisect } from '../verify/run.mjs'
import { selectSuites } from '../verify/select.mjs'

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

const XML = `printf '<testsuites><testsuite name="x.spec.ts"><testcase classname="x.spec.ts" name="renders" time="0.1"><failure message="boom"/></testcase></testsuite></testsuites>' > r.xml`
/** A repo holding `files`, and a junit suite whose report always names the bare `x.spec.ts`. */
async function junitRun(files, over) {
  const mk = () => {
    const dir = project({})
    for (const f of files) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), '')
    }
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: dir })
    return dir
  }
  const pw = { name: 'e2e', runner: 'junit', cwd: '.', command: XML, report: 'r.xml', needs: [], tiers: ['commit', 'phase', 'merge'], ...over }
  return runRequest(req(), ctxFor(mk(), mk(), { verify: { suites: [pw], checks: [], timeoutMs: 60000, db: null } }))
}

test('a report naming files relative to the runner\'s testDir resolves to the repo path, so a failure on both sides is debt', async () => {
  const v = await junitRun(['tests/visual/x.spec.ts'], { files: 'tests/**/*.spec.ts' })
  assert.equal(v.status, 'green')
  assert.deepEqual(v.regressions, [])
  assert.deepEqual(v.debt, ['e2e::tests/visual/x.spec.ts::renders'])
})

test('testDir-relative names resolve under a subdirectory cwd', async () => {
  const v = await junitRun(['apps/web/test/e2e/x.spec.ts'], { cwd: 'apps/web', files: 'test/e2e/*.spec.ts' })
  assert.equal(v.status, 'green')
  assert.deepEqual(v.debt, ['e2e::apps/web/test/e2e/x.spec.ts::renders'])
})

test('a suite with no files glob resolves by the one tracked file with that name', async () => {
  const v = await junitRun(['tests/visual/x.spec.ts'], { files: null })
  assert.deepEqual(v.debt, ['e2e::tests/visual/x.spec.ts::renders'])
})

test('a same-named file outside the suite\'s glob does not win over the one inside it', async () => {
  const v = await junitRun(['x.spec.ts', 'tests/visual/x.spec.ts'], { files: 'tests/**/*.spec.ts' })
  assert.deepEqual(v.debt, ['e2e::tests/visual/x.spec.ts::renders'])
})

/** A committed repo holding empty `files`. */
function gitRepo(files) {
  const dir = project({})
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: dir })
  return dir
}

test('a junit suite at the merge tier gets its matching tracked files in {files}, not the glob', async () => {
  const dir = gitRepo(['apps/web/test/e2e/a.spec.ts', 'apps/web/test/e2e/sub/b.spec.ts', 'apps/web/test/other.ts'])
  const e2e = { name: 'e2e', runner: 'junit', cwd: 'apps/web', files: 'test/e2e/**/*.spec.ts', command: `echo {files} > seen.txt; printf '<testsuites/>' > r.xml`, report: 'r.xml', needs: [], tiers: ['merge'] }
  await runRequest(req({ tier: 'merge' }), ctxFor(dir, dir, { verify: { suites: [e2e], checks: [], timeoutMs: 60000, db: null } }))
  assert.equal(readFileSync(join(dir, 'apps/web/seen.txt'), 'utf8').trim(), 'test/e2e/a.spec.ts test/e2e/sub/b.spec.ts')
})

/** A repo with unit tests a (alone) and b (imports lib.mjs); c1 touches a, c2 touches lib.mjs. Returns the shas. */
function history() {
  const dir = project({ 'lib.mjs': 'export const x = 1\n', 'test/a.test.mjs': T(`test('ok', () => {})`), 'test/b.test.mjs': T(`import '../lib.mjs'\ntest('ok', () => {})`) })
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const commit = (f, body) => (writeFileSync(join(dir, f), body), g('add', '.'), g('commit', '-qm', f), g('rev-parse', 'HEAD'))
  g('init', '-q')
  g('add', '.')
  g('commit', '-qm', 'c0')
  const c0 = g('rev-parse', 'HEAD')
  const c1 = commit('test/a.test.mjs', T(`test('ok', () => {})\n// edited`))
  const c2 = commit('lib.mjs', 'export const x = 2\n')
  return { dir, g, c0, c1, c2 }
}
const idsRun = (ctx) => readFileSync(join(ctx.ledger.dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.run === 'p').map((r) => r.id)
const phaseCtx = (dir) => ctxFor(dir, dir, { select: selectSuites })
const green = (sha, files) => files.map((f) => ({ run: 'x', sha, tier: 'commit', id: `unit::${f}::ok`, status: 'pass' }))

test('phase tier reuses a file that passed at an earlier branch commit and nothing since reaches', async () => {
  const { dir, c0, c1, c2 } = history()
  const ctx = phaseCtx(dir)
  ctx.ledger.appendResults(green(c1, ['test/a.test.mjs', 'test/b.test.mjs']))
  const v = await runRequest(req({ id: 'p', tier: 'phase', sha: c2, base: c0, commits: [c1, c2] }), ctx)
  assert.equal(v.status, 'green')
  assert.equal(v.reused, 1) // a: lib.mjs changed after c1 and a does not import it
  assert.deepEqual(idsRun(ctx), ['unit::test/b.test.mjs::ok']) // b: reached by the change since c1
})

test('phase tier re-runs a file whose pass predates a change that reaches it', async () => {
  const { dir, c0, c2 } = history()
  const ctx = phaseCtx(dir)
  ctx.ledger.appendResults(green(c0, ['test/a.test.mjs', 'test/b.test.mjs']))
  const v = await runRequest(req({ id: 'p', tier: 'phase', sha: c2, base: c0, commits: [c2] }), ctx)
  assert.equal(v.reused, 0) // a was edited and b imports the edited lib, both after c0
})

test('the newest record of a file decides: a fail at a later commit is not walked past to an older pass', async () => {
  const { dir, c0, c1, c2 } = history()
  const ctx = phaseCtx(dir)
  ctx.ledger.appendResults(green(c1, ['test/a.test.mjs']))
  ctx.ledger.appendResults([{ run: 'x', sha: c2, tier: 'commit', id: 'unit::test/a.test.mjs::ok', status: 'fail' }])
  const v = await runRequest(req({ id: 'p', tier: 'phase', sha: c2, base: c0, commits: [c1, c2] }), ctx)
  assert.equal(v.reused, 0)
})

test('a file with only some tests recorded is reused only from a complete record, so a timed-out run records nothing', async () => {
  const dir = gitRepo(['t/a.spec.ts'])
  const xml = `printf '<testsuites><testsuite name="a"><testcase classname="t/a.spec.ts" name="one" time="0.1"/></testsuite></testsuites>' > r.xml; sleep 5`
  const e2e = { name: 'e2e', runner: 'junit', cwd: '.', files: 't/*.spec.ts', command: xml, report: 'r.xml', needs: [], tiers: ['commit'] }
  let runs = 0
  const ctx = ctxFor(dir, dir, { verify: { suites: [e2e], checks: [], timeoutMs: 500, db: null }, lease: async () => (runs++, { env: {}, release() {} }) })
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'env-broken')
  assert.match(v.broken[0].reason, /timed out after/)
  assert.equal(existsSync(join(ctx.ledger.dir, 'results.jsonl')), false)
  assert.equal(runs, 1, 'a timeout is not retried')
})

test('a cancelled request records no results', async () => {
  const dir = gitRepo(['t/a.spec.ts'])
  const xml = `printf '<testsuites><testsuite name="a"><testcase classname="t/a.spec.ts" name="one" time="0.1"><failure message="x"/></testcase><testcase classname="t/a.spec.ts" name="two" time="0.1"/></testsuite></testsuites>' > r.xml`
  const e2e = { name: 'e2e', runner: 'junit', cwd: '.', files: 't/*.spec.ts', command: xml, report: 'r.xml', needs: [], tiers: ['commit'] }
  const ac = new AbortController()
  let leases = 0
  const lease = async () => (++leases > 1 && ac.abort(), { env: {}, release() {} })
  const ctx = ctxFor(dir, dir, { signal: ac.signal, lease, verify: { suites: [e2e], checks: [], timeoutMs: 60000, db: null } })
  const v = await runRequest(req(), ctx)
  assert.equal(v.status, 'cancelled')
  assert.equal(existsSync(join(ctx.ledger.dir, 'results.jsonl')), false)
})

test('earlier commits are consulted for at most the three newest; a file only older than that is re-run', async () => {
  const { dir, g, c0 } = history()
  const shas = []
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `test/f${i}.test.mjs`), T(`test('ok', () => {})`))
    g('add', '.')
    g('commit', '-qm', `u${i}`)
    shas.push(g('rev-parse', 'HEAD'))
  }
  const all = [0, 1, 2, 3, 4].map((i) => `test/f${i}.test.mjs`)
  let calls = 0
  const ctx = ctxFor(dir, dir, { select: () => ({ unit: { files: calls++ ? [] : all, why: {} } }) })
  all.forEach((f, i) => ctx.ledger.appendResults(green(shas[i], [f])))
  const v = await runRequest(req({ id: 'p', tier: 'phase', sha: shas[4], base: c0, commits: shas }), ctx)
  assert.equal(calls - 1, 3) // graph builds for earlier commits
  assert.equal(v.reused, 4) // f4 exact, f1-f3 within the cap; f0 re-run
})

test('a pass recorded at a commit that is not an ancestor of the request is never used', async () => {
  const { dir, g, c0, c2 } = history()
  g('checkout', '-q', '-b', 'other', c0)
  writeFileSync(join(dir, 'unrelated.txt'), 'x')
  g('add', '.')
  g('commit', '-qm', 'side')
  const side = g('rev-parse', 'HEAD')
  g('checkout', '-q', c2)
  const ctx = phaseCtx(dir)
  ctx.ledger.appendResults(green(side, ['test/a.test.mjs', 'test/b.test.mjs']))
  const v = await runRequest(req({ id: 'p', tier: 'phase', sha: c2, base: c0, commits: [c2] }), ctx)
  assert.equal(v.reused, 0)
})
