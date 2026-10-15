import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStream, deriveSteps, sessionTotals, parseTap, runTotals, median, summarize, renderReport, renderStatusTable } from '../bench-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM = readFileSync(join(HERE, 'fixtures/bench/session.jsonl'), 'utf8')
const T0 = Date.parse('2026-10-13T10:00:00.000Z')

test('parseStream keeps the session, model, result and every event with a timestamp and a parent', () => {
  const p = parseStream(STREAM)
  assert.equal(p.sessionId, 'sess-1')
  assert.equal(p.model, 'claude-sonnet-5-5')
  assert.equal(p.result.num_turns, 7)
  assert.equal(p.events.length, 12)
  assert.equal(p.events[1].t, T0 + 5000)
  assert.equal(p.events[1].top, true)
  assert.equal(p.events[7].top, false)
  assert.equal(p.events[7].parent, 't4')
  assert.deepEqual(p.events[2].blocks[0], { kind: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming', args: 'tags' } })
})

test('parseStream skips blank and non-JSON lines', () => {
  const p = parseStream('\n[fleet] could not start\n' + STREAM.split('\n')[0] + '\n')
  assert.equal(p.events.length, 1)
})

test('steps open on each top-level Skill call; time before the first is (prompt)', () => {
  const steps = deriveSteps(parseStream(STREAM), { prompt: '/superpowers:brainstorming tags' })
  assert.deepEqual(steps.map((s) => s.name), ['/superpowers:brainstorming', 'superpowers:brainstorming', 'superpowers:writing-plans'])
  assert.equal(steps[0].start, T0)
  assert.equal(steps[0].end, T0 + 10000)
  assert.equal(steps[1].ms, 110000)
  assert.equal(steps[2].end, T0 + 300000)
})

test('a step counts its top-level turns and every tool call inside it, subagents included', () => {
  const [, brainstorm, plan] = deriveSteps(parseStream(STREAM), { prompt: 'x' })
  assert.equal(brainstorm.turns, 2)
  assert.deepEqual(brainstorm.toolCalls, { Skill: 1, Read: 1 })
  assert.deepEqual(plan.toolCalls, { Skill: 1, Agent: 1, Edit: 1, Bash: 1 })
  assert.deepEqual(plan.files, ['/tmp/x/src/cli.mjs'])
  assert.deepEqual(plan.commands, ['npm test'])
  assert.deepEqual(plan.tests, ['npm test'])
  assert.deepEqual(plan.subagents, [{ type: 'general-purpose', first: 'Implement task 1: add --tag' }])
})

test('gaps are the longest waits between consecutive events in the step, naming what came before', () => {
  const [, brainstorm] = deriveSteps(parseStream(STREAM), { prompt: 'x' })
  assert.deepEqual(brainstorm.gaps[0], { ms: 60000, after: 'Read /tmp/x/src/cli.mjs' })
  assert.ok(brainstorm.gaps.length <= 5)
})

test('a session that never calls Skill is one step named after its prompt', () => {
  const lines = STREAM.split('\n').filter((l) => l && !l.includes('"name":"Skill"'))
  const steps = deriveSteps(parseStream(lines.join('\n')), { prompt: '/gsd-plan-phase 1' })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].name, '/gsd-plan-phase')
  assert.equal(steps[0].ms, 300000)
})

test('a Skill-less session with a non-slash prompt is named after its first line; a slash prompt after its command', () => {
  const lines = STREAM.split('\n').filter((l) => l && !l.includes('"name":"Skill"')).join('\n')
  assert.equal(deriveSteps(parseStream(lines), { prompt: 'Build this\nmore\nlines' })[0].name, 'Build this')
  assert.equal(deriveSteps(parseStream(lines), { prompt: '/builder:brainstorm --auto Notes can carry tags.\nmore\nlines' })[0].name, '/builder:brainstorm')
})

test('files are relative to the root (also through /private); a heredoc that mentions npm test is not a test run', () => {
  const steps = deriveSteps(parseStream(STREAM), { prompt: 'x', root: '/tmp/x' })
  assert.deepEqual(steps[2].files, ['src/cli.mjs'])
  const priv = deriveSteps(parseStream(STREAM.replaceAll('/tmp/x', '/private/var/x')), { prompt: 'x', root: '/var/x' })
  assert.deepEqual(priv[2].files, ['src/cli.mjs'])
  const ev = (cmd) => JSON.stringify({ type: 'assistant', parent_tool_use_id: null, timestamp: '2026-10-13T10:00:01.000Z', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: cmd } }] } })
  const init = STREAM.split('\n')[0]
  const s = deriveSteps(parseStream([init, ev("cat > x.mjs <<'EOF'\nnpm test\nEOF"), ev('npm test 2>&1 | tail -5')].join('\n')), { prompt: 'x' })
  assert.equal(s[0].commands.length, 2)
  assert.deepEqual(s[0].tests, ['npm test 2>&1 | tail -5'])
})

test('parseStream exposes the init plugins', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's', timestamp: '2026-10-13T10:00:00.000Z', plugins: [{ name: 'a', version: '1', path: '/a' }] }
  assert.deepEqual(parseStream(JSON.stringify(init)).plugins, [{ name: 'a', version: '1', path: '/a' }])
  assert.deepEqual(parseStream(STREAM).plugins, [])
})

test('no (prompt) step when the first event is a Skill', () => {
  const lines = STREAM.split('\n').filter(Boolean)
  const first = JSON.parse(lines[2])
  first.timestamp = '2026-10-13T10:00:00.000Z'
  const steps = deriveSteps(parseStream([lines[0], JSON.stringify(first), ...lines.slice(3)].join('\n')), { prompt: 'x' })
  assert.equal(steps[0].name, 'superpowers:brainstorming')
})

test('a stream with no result event is cut: totals from the last event, zero tokens', () => {
  const lines = STREAM.split('\n').filter(Boolean).slice(0, -1)
  const p = parseStream(lines.join('\n'))
  const t = sessionTotals(p)
  assert.equal(t.ended, 'cut')
  assert.equal(t.ms, 300000)
  assert.equal(t.turns, 6)
  assert.deepEqual(t.tokens, { input: 0, output: 0, cacheRead: 0 })
  assert.equal(t.costUsd, 0)
  const steps = deriveSteps(p, { prompt: 'x' })
  assert.equal(steps.at(-1).end, T0 + 300000)
})

test('sessionTotals reads the result event when there is one', () => {
  const t = sessionTotals(parseStream(STREAM))
  assert.deepEqual(t, { ms: 300000, turns: 7, tokens: { input: 100, output: 900, cacheRead: 5000 }, costUsd: 0.5, ended: 'result' })
})

test('sessionTotals: a session that waited past its result event is timed by the stream (max of duration_ms and the event span)', () => {
  const ev = (t, o) => JSON.stringify({ timestamp: new Date(T0 + t).toISOString(), ...o })
  const text = [ev(0, { type: 'system', subtype: 'init', session_id: 's' }), ev(518000, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'x' }] } }), ev(518000, { type: 'result', subtype: 'success', duration_ms: 19000, num_turns: 1, usage: {}, session_id: 's' })].join('\n')
  assert.equal(sessionTotals(parseStream(text)).ms, 518000)
})

test('summarize and renderReport flag sessions that overlapped (summed time > 1.1 x wall)', () => {
  const o = run('builder-rush', 1, { ms: 100, sessions: [{ name: 'brainstorm', totals: { ms: 200 }, steps: [] }, { name: 'fleet 01', totals: { ms: 50 }, steps: [] }] })
  const rows = summarize([o])
  assert.match(rows[0].flagged, /sessions overlapped/)
  const md = renderReport({ ...DATA, runs: [o] })
  assert.match(md, /⚠ sessions overlapped \(a session waited on a fleet it launched\): per-step times are not additive/)
  assert.match(md, /\| builder-rush ⚠ \|/)
  assert.equal(summarize([run('builder-rush', 1, { ms: 100, sessions: [{ name: 'a', totals: { ms: 105 }, steps: [] }] })])[0].flagged, null)
})

test('renderReport prints the stopped-early line', () => {
  const md = renderReport({ ...DATA, runs: [run('gsd', 1, { ms: 100, stoppedEarly: 'phase verified after new-project', sessions: [] })] })
  assert.match(md, /stopped early: phase verified after new-project — the remaining sessions were not run/)
})

test('parseTap reads the pass and fail counts', () => {
  assert.deepEqual(parseTap('TAP version 13\nok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n'), { passed: 1, failed: 1, total: 2 })
  assert.deepEqual(parseTap(''), { passed: 0, failed: 0, total: 0 })
})

test('runTotals sums the sessions', () => {
  const s = (ms, turns, input, output, cacheRead, costUsd) => ({ totals: { ms, turns, tokens: { input, output, cacheRead }, costUsd, ended: 'result' } })
  assert.deepEqual(runTotals([s(10, 1, 1, 2, 3, 0.1), s(20, 2, 10, 20, 30, 0.2)]), { ms: 30, turns: 3, tokens: { input: 11, output: 22, cacheRead: 33 }, costUsd: 0.30000000000000004 })
})

test('median', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.ok(Number.isNaN(median([])))
})

const run = (config, rep, over = {}) => ({
  config, pipeline: config.split('-')[0], profile: config.startsWith('builder') ? config.split('-')[1] : null, rep, status: 'done', path: 'pipeline',
  startedAt: 0, endedAt: 0, ms: 100, sessions: [{ name: 'a', steps: [{ name: 'builder:audit', ms: 40 }, { name: 'builder:build', ms: 60 }] }],
  totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1 }, score: { accept: { passed: 7, failed: 0, total: 7 }, fixture: { passed: 4, failed: 0, total: 4 } }, copy: '/tmp/c', gitLog: [], ...over,
})

test('summarize gives one row per config with medians over reps and the longest step', () => {
  const rows = summarize([run('builder-rush', 1), run('builder-rush', 2, { ms: 300, totals: { ms: 300, turns: 30, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 3 } }), run('gsd', 1)])
  assert.equal(rows.length, 2)
  const rush = rows.find((r) => r.config === 'builder-rush')
  assert.equal(rush.n, 2)
  assert.equal(rush.ms, 200)
  assert.equal(rush.costUsd, 2)
  assert.deepEqual(rush.longest, { name: 'builder:build', ms: 60 })
  assert.deepEqual(rush.steps, { 'builder:audit': 40, 'builder:build': 60 })
  assert.deepEqual(rush.accept, { passed: 7, total: 7 })
})

test('summarize flags an in-chat builder row and carries a not-done status', () => {
  const rows = summarize([run('builder-rush', 1, { path: 'in-chat' }), run('gsd', 1, { status: 'not run: npx failed', score: { accept: null, fixture: null } })])
  assert.equal(rows[0].flagged, 'built in chat (sized xs/sm) — not the pipeline; resize the feature')
  assert.equal(rows[1].status, 'not run: npx failed')
  assert.equal(rows[1].accept, null)
})

test('summarize medians scores and steps over the reps that have them, not zero-filled', () => {
  const rows = summarize([run('builder-rush', 1), run('builder-rush', 2, { status: 'not run: x', score: { accept: null, fixture: null }, sessions: [], totals: null })])
  const r = rows[0]
  assert.deepEqual(r.accept, { passed: 7, total: 7 })
  assert.deepEqual(r.steps, { 'builder:audit': 40, 'builder:build': 60 })
  assert.equal(r.status, 'not run: x')
  assert.equal(r.n, 2)
})

test('summarize: a step one rep never reached does not halve its median', () => {
  const rows = summarize([run('gsd', 1), run('gsd', 2, { sessions: [{ name: 'a', steps: [{ name: 'builder:audit', ms: 40 }] }] })])
  assert.equal(rows[0].steps['builder:build'], 60)
})

const DATA = {
  runId: '2026-10-13-1200-tags', feature: 'tags', model: 'claude-sonnet-5-5', startedAt: 1, endedAt: 2,
  versions: { builder: '4.11.0', superpowers: '6.4.1', gsd: '1.7.0' },
  runs: [
    run('builder-rush', 1, { sessions: [{ name: 'brainstorm', prompt: '/builder:brainstorm --auto …', totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1, ended: 'result' },
      steps: [{ name: 'builder:brainstorm', start: 0, end: 40, ms: 40, turns: 3, toolCalls: { Read: 2, Skill: 1 }, files: ['src/cli.mjs'], commands: ['ls'], tests: [], subagents: [], gaps: [{ ms: 30, after: 'Read src/cli.mjs' }] },
              { name: 'builder:build', start: 40, end: 100, ms: 60, turns: 7, toolCalls: { Agent: 2, Edit: 4, Bash: 3 }, files: ['src/cli.mjs', 'test/cli.test.mjs'], commands: ['npm test'], tests: ['npm test'], subagents: [{ type: 'general-purpose', first: 'Implement task 1' }], gaps: [] }], tail: [] }] }),
    run('gsd', 1, { status: 'timed out', score: { accept: { passed: 2, failed: 5, total: 7 }, fixture: { passed: 4, failed: 0, total: 4 } }, sessions: [{ name: '/gsd-plan-phase 1', prompt: '/gsd-plan-phase 1', totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1, ended: 'cut' }, steps: [{ name: '/gsd-plan-phase 1', start: 0, end: 100, ms: 100, turns: 10, toolCalls: {}, files: [], commands: [], tests: [], subagents: [], gaps: [] }], tail: ['last line'] }] }),
  ],
}

test('renderReport has the summary table, the steps table and a section per config', () => {
  const md = renderReport(DATA)
  assert.match(md, /^# benchmark 2026-10-13-1200-tags — tags/m)
  assert.match(md, /builder 4\.11\.0 · superpowers 6\.4\.1 · gsd 1\.7\.0 · claude-sonnet-5-5/)
  assert.match(md, /\| Config \| Status \| Wall \| Turns \| Tokens \(in\+out\) \| Cost \| Accept \| Fixture tests \| Longest step \|/)
  assert.match(md, /\| builder-rush \| done \| 0s \| 10 \| 3 \| \$1\.00 \| 7\/7 \| 4\/4 \| builder:build 0s \|/)
  assert.match(md, /\| gsd \| timed out \|/)
  assert.match(md, /\| Config \| builder:brainstorm \| builder:build \| \/gsd-plan-phase 1 \|/)
  assert.match(md, /\| builder-rush \| 0s \| 0s \| — \|/)
  assert.match(md, /^## builder-rush$/m)
  assert.match(md, /builder:build\*\* — 0s, 7 turns, Edit 4 · Bash 3 · Agent 2/)
  assert.match(md, /files: src\/cli\.mjs, test\/cli\.test\.mjs/)
  assert.match(md, /subagents: general-purpose — Implement task 1/)
  assert.match(md, /longest waits: 0s after Read src\/cli\.mjs/)
  assert.match(md, /^## gsd — timed out$/m)
  assert.match(md, /last line/)
})

test('renderReport flags an in-chat row and prints medians with n', () => {
  const md = renderReport({ ...DATA, runs: [run('builder-rush', 1, { path: 'in-chat' }), run('builder-rush', 2, { path: 'in-chat' })] })
  assert.match(md, /\| builder-rush ⚠ \| done \|/)
  assert.match(md, /median of 2 reps/)
  assert.match(md, /⚠ builder-rush: built in chat/)
})

test('renderStatusTable adds the config now running', () => {
  const s = renderStatusTable(DATA, { config: 'superpowers', rep: 1, session: 'superpowers', startedAt: Date.now() - 65000 })
  assert.match(s, /\| builder-rush \|/)
  assert.match(s, /running: superpowers \(session superpowers, 1m\)/)
  assert.match(renderStatusTable(DATA, null), /not running/)
})

test('renderReport keeps a multi-line step name inside its table cell and prints plugins and install time', () => {
  const r = run('gsd', 1, { installMs: 5000, sessions: [{ name: 'a', prompt: 'p', plugins: ['stub 1.0'], totals: { ms: 1, turns: 1, tokens: { input: 1, output: 1, cacheRead: 0 }, costUsd: 0, ended: 'result' }, steps: [{ name: 'line one\nline two', ms: 5, turns: 1, toolCalls: {}, files: [], commands: [], tests: [], subagents: [], gaps: [] }], tail: [] }] })
  const md = renderReport({ ...DATA, runs: [r] })
  assert.match(md, /\| Config \| line one line two \|/)
  assert.match(md, /^plugins: stub 1\.0$/m)
  assert.match(md, /install 5s/)
})
