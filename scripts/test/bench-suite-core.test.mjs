import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFromRow, estimateFromRuns, pickLabel, packLanes, fillBudget, recommendControls, applyProfile, safetyRefusals } from '../bench-suite-core.mjs'

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

// profile application, safety check
const MD = '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: {claude_args}\n  env: PORT=4917\nverify:\n  workers: 2\n---\n\n# body\nverify: stays\n'
test('applyProfile: replaces and appends agent_walk keys, sets claude_args, swaps verify', () => {
  const out = applyProfile(MD, { agentWalk: { env: 'PORT=5917 DATABASE_URL=postgres://localhost/bench_p', start: 'npm start' }, verifyBlock: 'verify:\n  workers: 1\n', claudeArgs: '--plugin-dir /b' })
  assert.match(out, /^  env: PORT=5917 DATABASE_URL=postgres:\/\/localhost\/bench_p$/m)
  assert.match(out, /^  start: npm start$/m)
  assert.match(out, /^  claude_args: --plugin-dir \/b$/m)
  assert.match(out, /^verify:\n  workers: 1\n---/m)
  assert.ok(out.endsWith('# body\nverify: stays\n'))
})
test('applyProfile: no agent_walk map yet', () =>
  assert.match(applyProfile('---\nproject: p\n---\n', { agentWalk: { env: 'X=1' }, claudeArgs: '--a' }), /^agent_walk:\n  env: X=1\n  claude_args: --a\n---/m))
test('applyProfile: unknown front matter survives — lists, nested maps, keys after verify', () => {
  const md = '---\nagent_walk:\n  env: A=1\nlist:\n- a\n- b\nverify:\n  gates:\n    web: npm test\n  skip:\n  - x\nafter: kept\n---\nbody\n'
  const out = applyProfile(md, { agentWalk: { env: 'A=2' }, verifyBlock: 'verify:\n  workers: 1', claudeArgs: '--a' })
  assert.equal(out, '---\nagent_walk:\n  env: A=2\n  claude_args: --a\nlist:\n- a\n- b\nverify:\n  workers: 1\nafter: kept\n---\nbody\n')
})
test('applyProfile: verify appended before the closing rule when missing', () =>
  assert.match(applyProfile('---\nproject: p\n---\n', { agentWalk: {}, verifyBlock: 'verify:\n  workers: 1\n', claudeArgs: '--a' }), /^verify:\n  workers: 1\n---\n$/m))
const P = { db_prefix: 'bench_' }
const walk = (s) => `---\nagent_walk:\n  claude_args: --plugin-dir /b\n${s}\n---\n`
test('safety: a bench database and a free port pass', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=5917 DATABASE_URL=postgres://u@localhost:5432/bench_p'), P, { listening: [5432] }), []))
test('safety: a database that is not the bench\'s', () =>
  assert.deepEqual(safetyRefusals(walk('  env: DATABASE_URL=postgresql://localhost:5432/app_dev'), P, { listening: [5432] }), ['database app_dev is not a bench database (bench_*)']))
test('safety: a port something already listens on', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=3000'), P, { listening: [3000] }), ['port 3000 is in use now']))
test('safety: docker against a container that is not the bench\'s', () =>
  assert.deepEqual(safetyRefusals(walk('  start: docker start app-db'), P, { listening: [] }), ['docker command names no bench_ container: docker start app-db']))
test('safety: the booted simulator', () =>
  assert.deepEqual(safetyRefusals(walk('  start: xcrun simctl launch booted com.x'), P, { listening: [] }), ['simctl targets the booted simulator — name a bench device UDID']))
test('safety: claude_args still the placeholder', () =>
  assert.deepEqual(safetyRefusals('---\nagent_walk:\n  claude_args: {claude_args}\n---\n', P, { listening: [] }), ['agent_walk.claude_args is not set — sessions would load the user\'s plugins']))
test('safety: no db_prefix', () =>
  assert.deepEqual(safetyRefusals(walk(''), {}, { listening: [] }), ['profile has no db_prefix']))
test('safety: scans only the front matter', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=5917') + '\ndocker rm app localhost:3000\n', P, { listening: [3000] }), []))
test('safety: a shared db server port is fine, an app port on it is not', () =>
  assert.deepEqual(safetyRefusals(walk('  env: PORT=5432 DATABASE_URL=postgres://localhost:5432/bench_p'), P, { listening: [5432] }), ['port 5432 is in use now']))

// fix round 1
const refuse = (s, listening = []) => safetyRefusals(walk(s), P, { listening })
test('safety: a database URL with no name is the default database', () => {
  assert.deepEqual(refuse('  env: DATABASE_URL=postgres://localhost:5432'), ['database (default) is not a bench database (bench_*)'])
  assert.deepEqual(refuse('  env: REDIS_URL=redis://h:6379'), ['database (default) is not a bench database (bench_*)'])
})
test('safety: driver-suffixed and mysql2 schemes are database URLs', () => {
  assert.deepEqual(refuse('  env: U=postgresql+asyncpg://u@h/app_dev'), ['database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(refuse('  env: U=mysql2://u@h/app_dev'), ['database app_dev is not a bench database (bench_*)'])
})
test('safety: every docker command on a line must name a bench container', () => {
  assert.deepEqual(refuse('  start: docker start bench_a && docker stop app-db'), ['docker command names no bench_ container: docker stop app-db'])
  assert.deepEqual(refuse('  start: docker-compose kill'), ['docker command names no bench_ container: docker-compose kill'])
  assert.deepEqual(refuse('  start: docker volume rm data'), ['docker command names no bench_ container: docker volume rm data'])
  assert.deepEqual(refuse('  start: docker start bench_a; docker start bench_b'), [])
})
test('safety: any *PORT= variable counts', () =>
  assert.deepEqual(refuse('  env: APP_PORT=3000', [3000]), ['port 3000 is in use now']))
test('safety: front matter that cannot be found', () => {
  const none = ['no front matter — cannot check the config']
  assert.deepEqual(safetyRefusals('project: p\n', P, { listening: [] }), none)
  assert.deepEqual(safetyRefusals('', P, { listening: [] }), none)
})
test('safety: CRLF and a BOM are normalized, not skipped', () => {
  assert.deepEqual(safetyRefusals('\uFEFF' + walk('  env: PORT=3000').replace(/\n/g, '\r\n'), P, { listening: [3000] }), ['port 3000 is in use now'])
  assert.deepEqual(safetyRefusals(walk('  env: PORT=5917').replace(/\n/g, '\r\n'), P, { listening: [] }), [])
})
test('safety: a missing or empty claude_args is the same refusal', () => {
  const m = ["agent_walk.claude_args is not set — sessions would load the user's plugins"]
  assert.deepEqual(safetyRefusals('---\nagent_walk:\n  env: A=1\n---\n', P, { listening: [] }), m)
  assert.deepEqual(safetyRefusals('---\nagent_walk:\n  claude_args:\n---\n', P, { listening: [] }), m)
  assert.deepEqual(safetyRefusals('---\nproject: p\n---\n', P, { listening: [] }), m)
})
test('applyProfile: throws without claudeArgs', () => assert.throws(() => applyProfile('---\n---\n', { agentWalk: {} }), /claudeArgs/))
test('applyProfile: agent_walk with a comment or {} stays one key', () => {
  assert.equal(applyProfile('---\nagent_walk: # x\n  env: A=1\n---\n', { agentWalk: { env: 'A=2' }, claudeArgs: '--a' }), '---\nagent_walk: # x\n  env: A=2\n  claude_args: --a\n---\n')
  assert.equal(applyProfile('---\nagent_walk: {}\nz: 1\n---\n', { agentWalk: { env: 'A=2' }, claudeArgs: '--a' }), '---\nagent_walk:\n  env: A=2\n  claude_args: --a\nz: 1\n---\n')
})
