import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamMeter, meterTotals, reviewFacts, dispatchKind, tokensOf } from '../fleet-core.mjs'

const asst = (id, parent, ctx, content = []) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, usage: { input_tokens: 2, cache_read_input_tokens: ctx - 2, cache_creation_input_tokens: 0 }, content } })
const agent = (id, description, extra = {}) => ({ type: 'tool_use', name: 'Agent', id, input: { description, prompt: 'Read x and do what it says.', ...extra } })

test('dispatchKind reads the descriptions dispatch.mjs renders and the words the skills use', () => {
  assert.equal(dispatchKind('Implement Task 3: fix the save button'), 'implement')
  assert.equal(dispatchKind('Fix Task 3 round 2: fix the save button'), 'fix')
  assert.equal(dispatchKind('Review Task 3 (spec + quality)'), 'task-review')
  assert.equal(dispatchKind('Review phase 2 (api, tasks 4, 5)'), 'task-review')
  assert.equal(dispatchKind('Re-review Task 3 fix round 1'), 're-review')
  assert.equal(dispatchKind("Re-review the final review's fix wave"), 're-review')
  assert.equal(dispatchKind('Final review: payments'), 'final-review')
  assert.equal(dispatchKind("Fix the final review's findings: payments"), 'final-fix')
  assert.equal(dispatchKind('Audit api layer'), 'audit')
  assert.equal(dispatchKind('Write the web task blocks'), 'plan')
  assert.equal(dispatchKind('Agent walk round 1'), 'walk')
  assert.equal(dispatchKind('Verify contract + spec parity'), 'verify')
  assert.equal(dispatchKind('Explore the repo'), 'other')
  // The name after a template's opening never decides the kind.
  assert.equal(dispatchKind('Final review: checkout-fix'), 'final-review')
  assert.equal(dispatchKind('Fix Task 2 round 1: re-review banner'), 'fix')
  assert.equal(dispatchKind('Implement Task 4: final review screen'), 'implement')
  assert.equal(dispatchKind('Review Task 6 (spec + quality)'), 'task-review')
})

test('streamMeter groups turns by dispatch, dedupes streamed chunks, and keeps the tool result facts', () => {
  const m = streamMeter()
  const events = [
    asst('o1', null, 60000, [agent('t1', 'Implement Task 1: a', { model: 'sonnet', subagent_type: 'builder:implementer' })]),
    asst('s1', 't1', 4000),
    asst('s1', 't1', 4000), // the same message streamed again
    asst('s2', 't1', 9000, [{ type: 'tool_use', name: 'Bash', input: { command: 'cd api && pytest tests/test_a.py -q' } }]),
    asst('s3', 't1', 12000, [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]),
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, tool_use_result: { agentType: 'builder:implementer', resolvedModel: 'claude-sonnet-5-5', totalToolUseCount: 3, totalDurationMs: 4000, totalTokens: 12000 } },
    asst('o2', null, 70000, [agent('t2', 'Final review: f')]),
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] }, tool_use_result: { agentType: 'general-purpose', resolvedModel: 'claude-opus-5-5', totalTokens: 50000 } },
    'not an event',
    null,
  ]
  for (const e of events) m.add(e)
  const s = m.summary()
  assert.deepEqual(s.orchestrator, { turns: 2, startCtx: 60000, peakCtx: 70000, sumCtx: 130000 })
  assert.equal(s.dispatches.length, 2)
  const [impl, fin] = s.dispatches
  assert.equal(impl.kind, 'implement')
  assert.equal(impl.task, 1)
  assert.equal(impl.model, 'claude-sonnet-5-5')
  assert.equal(impl.agentType, 'builder:implementer')
  assert.equal(impl.turns, 3)
  assert.equal(impl.startCtx, 4000)
  assert.equal(impl.peakCtx, 12000)
  assert.equal(impl.sumCtx, 25000)
  assert.equal(impl.testRuns, 1)
  assert.equal(impl.toolUses, 3)
  // A child whose turns never streamed keeps its tool result's facts and says nothing it doesn't know.
  assert.equal(fin.kind, 'final-review')
  assert.equal(fin.turns, null)
  assert.equal(fin.lastCtx, 50000)
})

test('meterTotals sums per kind across runs, charges a batch walk once, and adds up cost per model', () => {
  const run = (dispatches, extra = {}) => ({ meter: { orchestrator: { turns: 10, startCtx: 1, peakCtx: 100, sumCtx: 1000 }, dispatches }, tokens: { byModel: { 'claude-opus-5-5': { costUsd: 2 } } }, ...extra })
  const d = (kind, turns, sumCtx) => ({ kind, turns, sumCtx, peakCtx: sumCtx, testRuns: 1 })
  const t = meterTotals([run([d('implement', 10, 500), d('implement', 20, 700)]), run([d('walk', 40, 4000)], { shared: 2 }), { ms: 5 }])
  assert.deepEqual(t.byKind.implement, { n: 2, turns: 30, sumCtx: 1200, peakCtx: 700, testRuns: 2 })
  assert.deepEqual(t.byKind.walk, { n: 0.5, turns: 20, sumCtx: 2000, peakCtx: 4000, testRuns: 0.5 })
  assert.deepEqual(t.orchestrator, { runs: 1.5, turns: 15, sumCtx: 1500, peakCtx: 100 })
  assert.deepEqual(t.costByModel, { 'claude-opus-5-5': 4 })
  assert.deepEqual(meterTotals(undefined), { byKind: {}, orchestrator: { runs: 0, turns: 0, sumCtx: 0, peakCtx: 0 }, costByModel: {} })
})

test('reviewFacts counts the final review by severity and the ledger fix rounds', () => {
  const finalReview = ['### Strengths', '- clean', '### Issues', '#### Critical (Must Fix)', 'None.', '#### Important (Should Fix)', '1. api/a.py:3 — x', '   - detail', '2. web/b.ts:9 — y', '#### Minor (Nice to Have)', '- z', '- **None**', '### Assessment', '- not counted'].join('\n')
  const ledger = 'Task 2: fix round 1/5 (1 addressed, 0 open)\nTask 2: complete\nTask 5: fix round 1/5 (…)\nTask 5: fix round 2/5 (…)\n'
  assert.deepEqual(reviewFacts({ finalReview, ledger }), { finalFindings: { critical: 0, important: 2, minor: 1 }, fixRounds: 3 })
  assert.deepEqual(reviewFacts({ ledger: '' }), { finalFindings: null, fixRounds: 0 })
  assert.equal(reviewFacts(), null)
})

test('tokensOf keeps cache creation and cost per model; usage stays the orchestrator thread', () => {
  const t = tokensOf({ total_cost_usd: 17, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 3.5 } } })
  assert.deepEqual(t, { input: 3, output: 4, cacheRead: 5, cacheCreation: 6, costUsd: 17, byModel: { 'claude-sonnet-5-5': { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, costUsd: 3.5 } } })
  assert.deepEqual(tokensOf(null), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, byModel: {} })
})

test('fleetStops leaves out a park settled outside the fleet — folder archived, or branch gone', async () => {
  const { fleetStops } = await import('../fleet-core.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const main = mkdtempSync(join(tmpdir(), 'stops-'))
  mkdirSync(join(main, '.git', 'refs', 'heads', 'builder'), { recursive: true })
  writeFileSync(join(main, '.git', 'refs', 'heads', 'builder', 'live'), 'abc\n')
  writeFileSync(join(main, '.git', 'packed-refs'), '# pack-refs\nabc refs/heads/builder/packed\n')
  for (const f of ['live', 'packed', 'gone-branch', '_archive/archived']) mkdirSync(join(main, 'docs', 'features', f), { recursive: true })
  const fleet = { features: {
    live: { status: 'parked', branch: 'builder/live', reason: 'x — next: y' },
    packed: { status: 'failed', branch: 'builder/packed', reason: 'z' },
    'gone-branch': { status: 'parked', branch: 'builder/gone-branch', reason: 'merged by tidy' },
    archived: { status: 'parked', branch: 'builder/live', reason: 'its folder moved to _archive' },
    running: { status: 'running', branch: 'builder/live' },
  } }
  assert.deepEqual(fleetStops(fleet, { main, registry: 'docs/features' }).map((s) => s.name), ['live', 'packed'])
  assert.equal(fleetStops(fleet).length, 4, 'without a checkout to look in, every stopped row shows')
})

test('stallOf counts a walk round\'s evidence as movement', async () => {
  const { stallOf } = await import('../fleet-core.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const wt = mkdtempSync(join(tmpdir(), 'stall-'))
  const ws = join(wt, '.builder', 'f')
  mkdirSync(join(ws, 'agent-walk', 'round-2'), { recursive: true })
  const now = Date.now()
  const old = new Date(now - 3 * 3600000)
  utimesSync(ws, old, old)
  utimesSync(join(ws, 'agent-walk'), old, old)
  const row = { status: 'walking', worktree: wt, runStartedAt: old.toISOString() }
  writeFileSync(join(ws, 'agent-walk', 'round-2', '07-cart.png'), 'x') // the walker, ten seconds ago
  utimesSync(ws, old, old)
  assert.equal(stallOf('f', row, now), null, 'a walk adding evidence is not quiet')
  utimesSync(join(ws, 'agent-walk', 'round-2'), old, old)
  const st = stallOf('f', { ...row, status: 'building' }, now)
  assert.ok(st && st.runningMs >= 3 * 3600000 - 1000, JSON.stringify(st))
})
