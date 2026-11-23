import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { classifyRuns, verifierCost, classifyCommand, streamCost, fleetCost, renderCost } from '../test-cost-core.mjs'
import { sinceOf } from '../test-cost.mjs'

const at = (min) => new Date(Date.UTC(2026, 10, 23, 4, min)).toISOString()
const reqOf = (id, o) => ({ id, state: 'done', createdAt: at(o.c ?? o.s), startedAt: at(o.s), doneAt: o.d == null ? undefined : at(o.d), tier: o.tier ?? 'commit', branch: 'b', sha: o.sha ?? 'aaa', verdict: o.status && { status: o.status, ms: (o.d - o.s) * 60000, selection: o.sel ?? {}, broken: o.broken ?? [], ...(o.base && { base: o.base }) } })

test('classifyRuns: the same code running already is concurrent; after a green, a repeat; after an env-broken, a retry; a new sha is first', () => {
  const runs = classifyRuns([
    reqOf('a', { s: 0, d: 20, status: 'env-broken' }),
    reqOf('b', { s: 10, d: 30, status: 'env-broken' }), // a still running
    reqOf('c', { s: 31, d: 40, status: 'green' }), // after b's env-broken
    reqOf('d', { s: 41, d: 45, status: 'green' }), // after c's green
    reqOf('e', { s: 50, d: 55, status: 'red', sha: 'bbb' }),
  ])
  assert.deepEqual(runs.map((r) => r.kind), ['first', 'concurrent', 'retry', 'repeat-green', 'first'])
})

test('classifyRuns: a merge run is keyed by the target it merged onto — main moving makes it new code', () => {
  const runs = classifyRuns([
    reqOf('a', { tier: 'merge', s: 0, d: 10, status: 'env-broken', base: 't1' }),
    reqOf('b', { tier: 'merge', s: 11, d: 20, status: 'env-broken', base: 't2' }),
    reqOf('c', { tier: 'merge', s: 21, d: 30, status: 'green', base: 't2' }),
  ])
  assert.deepEqual(runs.map((r) => r.kind), ['first', 'first', 'retry'])
})

test('verifierCost: no-verdict, duplicate and retry minutes, and per-suite time only from verdicts that record it', () => {
  const c = verifierCost([
    reqOf('a', { s: 0, d: 20, status: 'env-broken', sel: { server: { files: 266, ms: 900000, judgeMs: 0, outcome: 'timed-out' }, old: { files: 3 } } }),
    reqOf('b', { s: 10, d: 30, status: 'env-broken' }),
    reqOf('c', { s: 31, d: 40, status: 'green', sel: { server: { files: 4, ms: 60000, judgeMs: 5000, outcome: 'ran' } } }),
    { id: 'q', state: 'queued', createdAt: at(50), tier: 'commit', sha: 'zzz' },
  ])
  assert.equal(c.runs.length, 3, 'a request that never started is not a run')
  assert.equal(c.runMs, 49 * 60000)
  assert.equal(c.noVerdictMs, 40 * 60000)
  assert.equal(c.duplicateMs, 20 * 60000)
  assert.equal(c.retryMs, 9 * 60000)
  assert.deepEqual(c.suites.server, { n: 2, ms: 960000, judgeMs: 5000, timedOut: 1, files: 270 })
  assert.equal(c.suites.old, undefined)
})

test('classifyCommand: waits, broad and targeted test runs, typecheck', () => {
  assert.equal(classifyCommand('node "$B"/scripts/verify/verify.mjs wait mwss; echo $?'), 'verifier-wait')
  assert.equal(classifyCommand('node $B/scripts/job.mjs wait end-gates --max 600'), 'gate-wait')
  assert.equal(classifyCommand('node --test --experimental-strip-types "packages/mcp/test/**/*.test.ts" | tail'), 'test:broad')
  assert.equal(classifyCommand('cd x && npm test'), 'test:broad')
  assert.equal(classifyCommand('node $B/scripts/cap.mjs 120 \'node --test --experimental-strip-types apps/server/test/a.test.ts\''), 'test:targeted')
  assert.equal(classifyCommand('npx playwright test e2e/a.spec.ts'), 'test:e2e')
  assert.equal(classifyCommand('npm run typecheck 2>&1 | tail -15'), 'typecheck')
  assert.equal(classifyCommand('git status --short'), 'other')
})

const use = (id, name, input, ts, parent = null) => ({ type: 'assistant', timestamp: ts, parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id, ts, parent = null) => ({ type: 'user', timestamp: ts, parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })

test('streamCost: orchestrator waits, agent time by role, and a subagent\'s test runs credited to its role', () => {
  const c = streamCost([
    { type: 'system', timestamp: at(0) },
    use('a1', 'Agent', { description: 'Task 1: implement' }, at(1)),
    use('t1', 'Bash', { command: 'node --test test/**/*.test.ts' }, at(2), 'a1'),
    result('t1', at(5), 'a1'),
    use('t2', 'Bash', { command: 'node --test test/a.test.ts' }, at(5), 'a1'),
    result('t2', at(6), 'a1'),
    result('a1', at(8)),
    use('r1', 'Agent', { description: 'Review task 1' }, at(8)),
    result('r1', at(10)),
    use('w', 'Bash', { command: 'node $B/scripts/verify/verify.mjs wait x' }, at(10)),
    result('w', at(40)),
    use('dead', 'Bash', { command: 'node --test x' }, at(40)), // killed: no result
    { type: 'result', timestamp: at(50) },
  ])
  assert.equal(c.wallMs, 50 * 60000)
  assert.equal(c.waitMs, 30 * 60000)
  assert.deepEqual(c.agentMs, { implementer: { n: 1, ms: 7 * 60000 }, reviewer: { n: 1, ms: 2 * 60000 } })
  assert.deepEqual(c.byRole.implementer, { 'test:broad': { n: 1, ms: 3 * 60000 }, 'test:targeted': { n: 1, ms: 60000 } })
  assert.deepEqual(c.byRole.orchestrator, { 'verifier-wait': { n: 1, ms: 30 * 60000 } })
})

test('fleetCost sums a feature\'s runs into its share; renderCost prints the four KPIs', () => {
  const run = (w0, w1, end) => [{ timestamp: at(0) }, use('w', 'Bash', { command: 'node verify/verify.mjs wait x' }, at(w0)), result('w', at(w1)), { timestamp: at(end) }]
  const fleet = fleetCost([
    { feature: 'f', run: 1, events: run(1, 7, 10) },
    { feature: 'f', run: 2, events: run(0, 20, 30) },
  ])
  assert.equal(fleet.features.f.runs, 2)
  assert.equal(fleet.waitMs, 26 * 60000)
  assert.equal(fleet.share, 26 / 40)
  const md = renderCost({ verifier: verifierCost([reqOf('a', { s: 0, d: 20, status: 'env-broken', broken: [{ suite: 'server-test', reason: 'timed out after 15m' }] })]), fleet, since: null })
  assert.match(md, /Verification share .*\| 65% \(26\.0 of 40\.0 min\)/)
  assert.match(md, /No-verdict minutes .*\| 20\.0 min · 100% of verifier time/)
  assert.match(md, /server-test: timed out after 15m/)
})

test('sinceOf: 7d, 12h, 2w or a date; anything else is refused', () => {
  const now = Date.UTC(2026, 10, 23)
  assert.equal(sinceOf('7d', now), new Date(now - 7 * 86400e3).toISOString())
  assert.equal(sinceOf('12h', now), new Date(now - 12 * 3600e3).toISOString())
  assert.equal(sinceOf('2026-11-20'), '2026-11-20T00:00:00.000Z')
  assert.equal(sinceOf(null), null)
  assert.throws(() => sinceOf('soon'), /--since/)
})

test('the CLI reads a repo\'s ledger and fleet logs, live and archived, and prints the report', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-cost-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, '.builder', 'verify', 'requests'), { recursive: true })
  mkdirSync(join(root, '.builder', 'fleet', 'logs', '_archive', 'old'), { recursive: true })
  writeFileSync(join(root, '.builder', 'verify', 'requests', 'a.json'), JSON.stringify(reqOf('a', { s: 0, d: 10, status: 'green' })))
  const lines = (evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n{"partial'
  writeFileSync(join(root, '.builder', 'fleet', 'logs', 'live-01.jsonl'), lines([{ timestamp: at(0) }, { timestamp: at(10) }]))
  writeFileSync(join(root, '.builder', 'fleet', 'logs', '_archive', 'old', 'old-03.jsonl'), lines([{ timestamp: at(0) }, { timestamp: at(5) }]))
  writeFileSync(join(root, '.builder', 'fleet', 'logs', 'live-sync.log'), 'not a stream')
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'test-cost.mjs'), '--json'], { cwd: root, encoding: 'utf8' })
  const j = JSON.parse(out)
  assert.equal(j.verifier.runs.length, 1)
  assert.deepEqual(Object.keys(j.fleet.features).sort(), ['live', 'old'])
  assert.match(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'test-cost.mjs')], { cwd: root, encoding: 'utf8' }), /## KPIs/)
})
