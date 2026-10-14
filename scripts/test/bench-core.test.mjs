import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStream, deriveSteps, sessionTotals, parseTap, runTotals, median, summarize } from '../bench-core.mjs'

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
  assert.deepEqual(steps.map((s) => s.name), ['(prompt)', 'superpowers:brainstorming', 'superpowers:writing-plans'])
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
  assert.equal(steps[0].name, '/gsd-plan-phase 1')
  assert.equal(steps[0].ms, 300000)
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
