import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFromRow, estimateFromRuns, pickLabel, packLanes, fillBudget, recommendControls } from '../bench-suite-core.mjs'

// catalogue, estimates, lane packing, budget fill
test('estimateFromRow: wallMs and costUsd win', () =>
  assert.deepEqual(estimateFromRow({ wallMs: 61 * 60000, costUsd: 3.456, timing: [{ ms: 1 }] }), { minutes: 61, usd: 3.46 }))
test('estimateFromRow: an old row falls back to timing', () =>
  assert.deepEqual(estimateFromRow({ timing: [{ ms: 90000, tokens: { costUsd: 1 } }, { ms: 30000, tokens: { costUsd: 0.5 } }] }), { minutes: 2, usd: 1.5 }))
test('estimateFromRow: no time at all is no estimate', () => assert.equal(estimateFromRow({ feature: 'x', runs: 3 }), null))
test('estimateFromRow: minutes alone still make an estimate', () =>
  assert.deepEqual(estimateFromRow({ wallMs: 60000 }), { minutes: 1, usd: null }))
test('estimateFromRuns: median of done builder runs', () => {
  const s = (c) => [{ totals: { costUsd: c } }]
  const runs = { runs: [{ config: 'builder', status: 'done', ms: 600000, sessions: s(2) }, { config: 'builder', status: 'done', ms: 1200000, sessions: s(4) }, { config: 'builder', status: 'done', ms: 900000, sessions: s(3) }, { config: 'builder', status: 'failed', ms: 1, sessions: s(99) }, { config: 'gsd', status: 'done', ms: 1, sessions: s(1) }] }
  assert.deepEqual(estimateFromRuns(runs), { minutes: 15, usd: 3 })
})
test('estimateFromRuns: no done runs is no estimate', () => assert.equal(estimateFromRuns({ runs: [] }), null))
test('pickLabel', () => {
  assert.equal(pickLabel({ id: 'a', size: 'md', covers: 'two apps', estimate: { minutes: 90, usd: 12.5 } }), 'md · a — two apps · ~90m · ~$12.5')
  assert.equal(pickLabel({ id: 'b', size: 'xs', covers: 'one command', estimate: null }), 'xs · b — one command · no estimate yet')
  assert.equal(pickLabel({ id: 'c', size: 'sm', covers: 'x', estimate: { minutes: 5, usd: null } }), 'sm · c — x · ~5m · ~$?')
})
test('packLanes: longest first, onto the lane free earliest', () => {
  const c = (id, project, minutes) => ({ id, project, estimate: { minutes, usd: 1 } })
  const p = packLanes([c('s', 'A', 10), c('l', 'B', 100), c('m', 'C', 50), c('m2', 'D', 40)], 2)
  assert.deepEqual(p.lanes.map((l) => l.map((x) => x.id)), [['l'], ['m', 'm2', 's']])
  assert.equal(p.wallMinutes, 100)
  assert.equal(p.usd, 4)
})
test('packLanes: never two of one project at once, even with a lane idle', () => {
  const c = (id, minutes) => ({ id, project: 'A', estimate: { minutes, usd: 0 } })
  const p = packLanes([c('a', 60), c('b', 30)], 3)
  const all = p.lanes.flat()
  const b = all.find((x) => x.id === 'b')
  assert.equal(b.start, 60)
  assert.equal(p.wallMinutes, 90)
})
test('fillBudget: widest spread of sizes first, skips what has no estimate', () => {
  const c = (id, size, minutes, project = id) => ({ id, size, project, kind: 'archived', estimate: minutes == null ? null : { minutes, usd: 1 } })
  const r = fillBudget([c('xl1', 'xl', 700), c('lg1', 'lg', 300), c('md1', 'md', 120), c('md2', 'md', 100), c('sm1', 'sm', 40), c('xs1', 'xs', null)], { minutes: 720, lanes: 2 })
  assert.deepEqual(r.picked.map((x) => x.id).sort(), ['lg1', 'md1', 'md2', 'sm1', 'xl1'])
  assert.deepEqual(r.skipped, [{ id: 'xs1', reason: 'no estimate' }])
})
test('fillBudget: a case that would overrun is skipped with the reason', () => {
  const r = fillBudget([{ id: 'big', size: 'xl', project: 'A', estimate: { minutes: 800, usd: 1 } }], { minutes: 720, lanes: 3 })
  assert.deepEqual(r, { picked: [], skipped: [{ id: 'big', reason: 'does not fit 720m' }] })
})
test('recommendControls: the shortest archived case per size', () => {
  const c = (id, size, minutes, kind = 'archived') => ({ id, size, kind, estimate: { minutes, usd: 1 } })
  assert.deepEqual(recommendControls([c('a', 'md', 90), c('b', 'md', 60), c('c', 'lg', 200), c('f', 'sm', 5, 'fixture')]), ['b', 'c'])
})
