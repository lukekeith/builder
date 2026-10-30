import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFromRow, estimateFromRuns, pickLabel, packLanes, fillBudget, recommendControls, applyProfile, safetyRefusals, measureFromRow, measureFromRuns, topSpend, renderSuiteReport, statusCategory, caseFleetTimeoutMs, textRefusals, portsNamed, walkClaudeArgs, applyReplacements, bodyWarnings, frontMatterText, mcpConfigs, mcpScanText, caseEnv } from '../bench-suite-core.mjs'

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
  assert.deepEqual(safetyRefusals(walk('  start: xcrun simctl launch booted com.x'), P, { listening: [] }), ['simctl targets the booted simulator — name the bench device by its bench_ name']))
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
})
test('safety: a Redis URL names no database — none, or a numbered one, passes; its port rule still applies', () => {
  assert.deepEqual(refuse('  env: REDIS_URL=redis://h:6379'), [])
  assert.deepEqual(refuse('  env: REDIS_URL=redis://h:6379/ CACHE_URL=rediss://u:p@h:6380/2'), [])
  assert.deepEqual(refuse('  env: REDIS_URL=redis://h:6379/app_cache'), ['database app_cache is not a bench database (bench_*)'])
  assert.deepEqual(refuse('  env: REDIS_URL=redis://localhost:6379 PORT=6379', [6379]), ['port 6379 is in use now'])
  assert.deepEqual(refuse('  env: DATABASE_URL=mysql://localhost:3306'), ['database (default) is not a bench database (bench_*)'])
})
test('safety: SQLite — :memory: and a .sqlite / .db file — is not a Postgres database name', () => {
  assert.deepEqual(refuse('  env: DB_DATABASE=:memory:'), [])
  assert.deepEqual(refuse('  env: DB_DATABASE=storage/test.sqlite DATABASE=tmp/app.db'), [])
  assert.deepEqual(refuse('  env: DB_DATABASE=app_dev'), ['database app_dev is not a bench database (bench_*)'])
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

// results and the report tables
const row = (wallMin, cost, stages) => ({ wallMs: wallMin * 60000, costUsd: cost, tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 0 }, orchestrator: { turns: 4 }, byKind: { implementer: { turns: 20, sumCtx: 1000 }, reviewer: { turns: 6, sumCtx: 400 } }, stages, quality: { fixRounds: 2 } })
test('measureFromRow', () => {
  const m = measureFromRow(row(60, 9, { build: 3600000 }))
  assert.equal(m.tokens, 1515); assert.equal(m.turns, 30); assert.equal(m.wallMs, 3600000)
})
test('measureFromRow: an old row has nulls, not zeros', () => {
  const m = measureFromRow({ feature: 'x' })
  assert.deepEqual([m.wallMs, m.costUsd, m.tokens, m.turns], [null, null, null, null])
})
test('measureFromRuns: the median done run, session numbers dropped from stage names', () => {
  const run = (ms, st) => ({ config: 'builder', status: 'done', ms, sessions: st.map(([name, t]) => ({ name, totals: { ms: t, turns: 2, tokens: { input: 1, output: 1, cacheRead: 2 }, costUsd: 1 } })) })
  const m = measureFromRuns({ runs: [run(10, [['a', 1]]), run(300, [['fleet 01', 100], ['fleet 02', 50], ['walk', 5]]), run(900, [['a', 1]]), { config: 'builder', status: 'failed', ms: 1, sessions: [] }] })
  assert.equal(m.wallMs, 300); assert.deepEqual(m.stages, { fleet: 150, walk: 5 }); assert.equal(m.tokens, 12); assert.equal(m.turns, 6)
  assert.equal(measureFromRuns({ runs: [] }).wallMs, null)
})
test('topSpend: by stage minutes and by dispatch kind, controls left out', () => {
  const r = (id, stages, control = false) => ({ id, control, measure: measureFromRow(row(1, 1, stages)) })
  const t = topSpend([r('a', { build: 60 * 60000, plan: 10 * 60000 }), r('b', { build: 30 * 60000, walk: 20 * 60000 }), r('a@main', { build: 999 * 60000 }, true)], 2)
  assert.deepEqual(t.minutes, [{ where: 'build', minutes: 90 }, { where: 'walk', minutes: 20 }])
  assert.deepEqual(t.tokens, [{ where: 'implementer dispatches', tokens: 2000 }, { where: 'reviewer dispatches', tokens: 800 }])
})
test('renderSuiteReport: no project names in the committed report, — for missing numbers', () => {
  const res = [{ id: 'c1', size: 'md', kind: 'archived', project: 'secretproj', control: false, status: 'done', measure: measureFromRow(row(50, 8, { build: 1 })), baseline: measureFromRow({ feature: 'x' }), specLines: 120, planLines: 300 }]
  const md = renderSuiteReport(res, { names: false })
  assert.doesNotMatch(md, /secretproj/)
  assert.match(md, /\| c1 \| md \|/)
  assert.match(md, /—/)
  assert.doesNotMatch(md, /NaN|undefined/)
  assert.match(renderSuiteReport(res, { names: true }), /secretproj/)
})
test('renderSuiteReport: deltas against baseline and control, the estimate verdict, sections in order', () => {
  const mk = (id, min, control, extra = {}) => ({ id, size: 'sm', project: 'p', control, status: 'done', measure: measureFromRow(row(min, 10, { endGates: min * 6000, verify: min * 4000 })), baseline: measureFromRow(row(100, 20, {})), specLines: 10, planLines: 25, ...extra })
  const md = renderSuiteReport([mk('c1', 50, false, { estimate: { minutes: 45, usd: 5 } }), mk('c1@main', 100, true)], { names: false })
  assert.match(md, /-50%/); assert.match(md, /within ±25%/); assert.match(md, /2\.5/); assert.match(md, /17%/)
  const at = ['## Cases', '## Stages', '## Plan format', '## Gate share', '## Top 5'].map((h) => md.indexOf(h))
  assert.deepEqual([...at].sort((a, b) => a - b), at); assert.ok(at[0] >= 0)
  assert.doesNotMatch(md, /NaN|undefined|\bp\b \|/)
})

// final fix wave
test('renderSuiteReport: names: false prints only the status category — a status\'s detail stays in the named report', () => {
  const r = (id, status) => ({ id, size: 'sm', project: 'secretproj', control: false, status, measure: null })
  const res = [r('a', 'done'), r('b', 'failed: could not clone the repo: /Users/x/secretproj does not exist'), r('c', 'refused: the clone /Users/x/secretproj/clone is inside the project repo'), r('d', 'parked: spec leaves secretproj\'s auth open'), r('e', 'failed: the fleet timed out after 3600s'), r('f', 'timed out'), r('g', 'stopped'), r('h', 'waiting'), r('i', 'failed: setup timed out')]
  const md = renderSuiteReport(res, { names: false })
  assert.doesNotMatch(md, /secretproj|\/Users/)
  const statusOf = (id) => new RegExp(`^\\| ${id} \\| sm \\| ([^|]+) \\|`, 'm').exec(md)[1].trim()
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(statusOf), ['done', 'failed', 'refused', 'parked', 'timed out', 'timed out', 'stopped', 'waiting', 'timed out'])
  assert.match(renderSuiteReport(res, { names: true }), /could not clone the repo: \/Users\/x\/secretproj does not exist/)
})
test('statusCategory: an unknown status is failed, never its text', () => {
  assert.equal(statusCategory('something odd /Users/x'), 'failed')
  assert.equal(statusCategory(undefined), 'failed')
  assert.equal(statusCategory('failed: stopped'), 'stopped')
})
test('estimateFromRow: human wait — stages.parked and walkQueueMs — is left out, never below Σ timing ms', () => {
  assert.deepEqual(estimateFromRow({ wallMs: 120 * 60000, stages: { build: 30 * 60000, parked: 50 * 60000 }, walkQueueMs: 10 * 60000, costUsd: 1 }), { minutes: 60, usd: 1 })
  assert.deepEqual(estimateFromRow({ wallMs: 100 * 60000, stages: { parked: 90 * 60000 }, timing: [{ ms: 40 * 60000 }], costUsd: 1 }), { minutes: 40, usd: 1 })
  assert.deepEqual(estimateFromRow({ wallMs: 61 * 60000, costUsd: 1 }), { minutes: 61, usd: 1 })
})
test('caseFleetTimeoutMs: 3× the estimate, at least an hour; no estimate is 6 h', () => {
  assert.equal(caseFleetTimeoutMs({ minutes: 30, usd: 1 }), 90 * 60000)
  assert.equal(caseFleetTimeoutMs({ minutes: 10, usd: 1 }), 60 * 60000)
  assert.equal(caseFleetTimeoutMs(null), 6 * 60 * 60000)
  assert.equal(caseFleetTimeoutMs({ minutes: 0 }), 6 * 60 * 60000)
})
test('safety: every form that names a port in use — docker -p, any-host and IPv6 binds, lsof and fuser forms', () => {
  const inUse = (s) => refuse(s, [3141])
  const m = ['port 3141 is in use now']
  for (const s of [
    '  start: docker run --name bench_db -p 3141:5432 postgres',
    '  start: docker run --name bench_db -p 127.0.0.1:3141:5432 postgres',
    '  start: docker run --name bench_db --publish=3141:5432 postgres',
    '  start: node server.js --host 0.0.0.0:3141',
    '  start: curl http://[::1]:3141/health',
    '  stop: lsof -nP -tiTCP:3141 -sTCP:LISTEN | xargs kill',
    '  stop: lsof -iTCP:3141 | xargs kill',
    '  stop: lsof -i tcp:3141 | xargs kill',
    '  stop: lsof -t -i :3141 | xargs kill',
    '  stop: lsof -ti:3141 | xargs kill',
    '  stop: fuser -k 3141/tcp',
    '  stop: npx kill-port 3141',
  ]) assert.deepEqual(inUse(s), m, s)
  assert.deepEqual(refuse('  stop: lsof -nP -tiTCP:3142 | xargs kill', [3141]), [])
  assert.deepEqual(refuse('  start: mkdir -p tmp && npm start', [3141]), [])
})
test('safety: PGDATABASE and *_DATABASE must name a bench database', () => {
  assert.deepEqual(refuse('  env: PGDATABASE=app_dev'), ['database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(refuse("  env: MYSQL_DATABASE='app'"), ['database app is not a bench database (bench_*)'])
  assert.deepEqual(refuse('  env: DB_DATABASE=bench_p PGDATABASE=bench_q'), [])
})
test('safety: createdb and dropdb must name a bench database', () => {
  assert.deepEqual(refuse('  start: dropdb --if-exists -h localhost app_dev && createdb bench_p'), ['database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(refuse('  start: dropdb --if-exists -U me bench_p && createdb -O me bench_p'), [])
})
test('textRefusals: setup, teardown and a placed file are scanned, each reason says where', () => {
  const t = (where, text, listening = []) => textRefusals(where, text, P, { listening })
  assert.deepEqual(t('setup', 'npm ci && docker compose up -d'), ['setup: docker command names no bench_ container: docker compose up -d'])
  assert.deepEqual(t('teardown', 'dropdb app_dev'), ['teardown: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(t('files/.env', '# a comment: PORT=3141\nPORT=3141\nDATABASE_URL=postgres://localhost/app_dev\nPGDATABASE=app_dev\n', [3141]), ['files/.env: database app_dev is not a bench database (bench_*)', 'files/.env: port 3141 is in use now'])
  assert.deepEqual(t('setup', 'createdb bench_p && npm ci'), [])
  assert.deepEqual(textRefusals('setup', 'docker compose up', {}, { listening: [] }), [])
})
test('portsNamed: the ports a text names, database URLs and comments left out', () => {
  assert.deepEqual(portsNamed('---\nagent_walk:\n  env: PORT=4010 DATABASE_URL=postgres://localhost:5432/bench_p\n  # PORT=9999\n  stop: lsof -ti:4011 | xargs kill\n---\n'), [4010, 4011])
})
test('safety: a database client\'s -p / --port is the shared server\'s, like a database URL\'s port', () => {
  assert.deepEqual(refuse('  start: createdb -p 5432 bench_p && psql -p 5432 bench_p -c "select 1" && PORT=4010 npm start', [5432]), [])
  assert.deepEqual(refuse('  start: psql --port=5432 bench_p; docker run --name bench_x -p 5432:5432 pg', [5432]), ['port 5432 is in use now'])
})
test('safety: a database server\'s port variable (PGPORT, DB_PORT…) is the shared server\'s too; an app\'s is not', () => {
  assert.deepEqual(refuse('  env: PGPORT=5432 DB_PORT=5432 POSTGRES_PORT=5432', [5432]), [])
  assert.deepEqual(refuse('  env: API_PORT=5432', [5432]), ['port 5432 is in use now'])
})
test('safety: only Postgres clients\' -p is the shared server\'s; server-stopping commands are refused outright', () => {
  const has = (s, listening, m) => assert.ok(refuse(s, listening).some((x) => m.test(x)), `${s} → ${JSON.stringify(refuse(s, listening))}`)
  has('  stop: mysqladmin --port 3306 shutdown', [3306], /^port 3306 is in use now$/)
  has('  stop: mysqladmin --port 3306 shutdown', [], /^stops a database server: mysqladmin --port 3306 shutdown$/)
  has('  stop: redis-cli -p 6379 shutdown', [6379], /^port 6379 is in use now$/)
  has('  stop: redis-cli -p 6380 flushall', [], /^stops a database server: redis-cli -p 6380 flushall$/)
  has('  start: docker run --name bench_m -p 3306:3306 mysql:8', [3306], /^port 3306 is in use now$/)
  has('  stop: pg_ctl -D /data -o "-p 5432" stop', [5432], /^port 5432 is in use now$/)
  has('  stop: pg_ctl -D /data restart', [], /^stops a database server: pg_ctl -D \/data restart$/)
  assert.deepEqual(refuse('  start: psql -p 5432 bench_a_x -c "select 1"', [5432]), [])
})

test('walkClaudeArgs: the runner\'s flags, then the profile\'s claude_args when set, else the project\'s own — the runner\'s flags never twice', () => {
  const runner = '--permission-mode bypassPermissions --settings /c/s.json --plugin-dir /b'
  const md = (ca) => `---\nagent_walk:\n  env: A=1\n  claude_args: ${ca}  # walk sessions\n---\n`
  assert.equal(walkClaudeArgs(runner, md('--mcp-config .claude/walk-mcp.json')), `${runner} --mcp-config .claude/walk-mcp.json`)
  assert.equal(walkClaudeArgs(runner, md('--permission-mode=plan --mcp-config m.json --settings s.json --plugin-dir /p --model x')), `${runner} --mcp-config m.json --model x`)
  assert.equal(walkClaudeArgs(runner, md('{claude_args}')), runner)
  assert.equal(walkClaudeArgs(runner, '---\nproject: p\n---\n'), runner)
  assert.equal(walkClaudeArgs(runner, md('--mcp-config own.json'), '--mcp-config bench.json --plugin-dir /x'), `${runner} --mcp-config bench.json`)
})

test('applyReplacements: literal, every occurrence, front matter and body; each must match once', () => {
  const md = '---\nagent_walk:\n  start: npm run dev -- --port 3000\n---\nWalk readiness: open localhost:3000 ($& stays) and psql app_dev.\n'
  const r = applyReplacements(md, [['3000', '4010'], ['psql app_dev', 'psql bench_p'], ['($& stays)', '(a.b*)']])
  assert.deepEqual(r.refusals, [])
  assert.equal(r.md, '---\nagent_walk:\n  start: npm run dev -- --port 4010\n---\nWalk readiness: open localhost:4010 (a.b*) and psql bench_p.\n')
  assert.deepEqual(applyReplacements(md, [['nope', 'x'], ['3000', '4010']]).refusals, ['replace: "nope" not found'])
  assert.deepEqual(applyReplacements(md, undefined), { md, refusals: [] })
  for (const bad of [{ a: 'b' }, [['a']], [['', 'x']], [['a', 1]], 'a']) assert.deepEqual(applyReplacements(md, bad).refusals, ['replace must be [["from", "to"], …] — each from a non-empty string, each to a string'], JSON.stringify(bad))
})
test('bodyWarnings: the same rules over the body, each reason body: — the front matter left to safetyRefusals', () => {
  const md = walk('  env: PORT=5917') + '\n## Walk readiness\n\nRun `docker compose up -d`, then DATABASE_URL=postgres://localhost/app_dev npm run dev on localhost:3000.\n'
  assert.deepEqual(bodyWarnings(md, P, { listening: [3000, 5917] }), ['body: database app_dev is not a bench database (bench_*)', 'body: port 3000 is in use now', 'body: docker command names no bench_ container: docker compose up -d , then DATABASE_URL=postgres://localhost/app_dev npm run dev on localhost:3000.'])
  assert.deepEqual(safetyRefusals(md, P, { listening: [3000] }), [])
  assert.deepEqual(bodyWarnings(walk(''), P), [])
  assert.deepEqual(bodyWarnings(md, {}), [])
})
test('frontMatterText: only the front matter — ports named in the body never count', () => {
  const md = walk('  env: PORT=5917') + '\nopen localhost:3000\n'
  assert.deepEqual(portsNamed(frontMatterText(md)), [5917])
  assert.equal(frontMatterText('no front matter\nlocalhost:3000\n'), '')
})

test('safety: shutdown is refused only with a database client or server in the segment, or as SQL in a -c / -e / --eval string', () => {
  const stops = (s) => assert.ok(refuse(s).some((x) => x.startsWith('stops a database server: ')), `${s} → ${JSON.stringify(refuse(s))}`)
  for (const s of [
    '  stop: mysqladmin -u root shutdown',
    '  stop: redis-cli shutdown nosave',
    '  stop: valkey-cli SHUTDOWN',
    '  stop: mongosh --eval "db.shutdownServer()"',
    '  stop: mongo admin --eval "db.adminCommand({shutdown: 1})"',
    '  stop: mysql -u root -e "SHUTDOWN"',
    '  stop: psql bench_p -c "select 1; SHUTDOWN"',
    '  stop: pg_ctl -D /data stop',
    '  stop: redis-cli flushdb',
    '  stop: echo x | redis-cli -n 2 flushall',
  ]) stops(s)
  assert.deepEqual(refuse('  stop: xcrun simctl shutdown bench_iphone'), [])
  assert.deepEqual(refuse('  stop: xcrun simctl shutdown bench_iphone && xcrun simctl delete bench_iphone'), [])
  assert.deepEqual(refuse('  stop: xcrun simctl shutdown booted'), ['simctl targets the booted simulator — name the bench device by its bench_ name'])
  assert.deepEqual(refuse('  stop: xcrun simctl shutdown all'), ['simctl shutdown names no bench_ device: xcrun simctl shutdown all'])
  assert.deepEqual(refuse('  stop: xcrun simctl shutdown "My iPhone"'), ['simctl shutdown names no bench_ device: xcrun simctl shutdown "My iPhone"'])
  assert.deepEqual(refuse('  stop: sudo shutdown -h now'), ['shuts down or restarts the machine: sudo shutdown -h now'])
})

// review round: probes through textRefusals, db_prefix bench_, 5432 / 3306 / 6379 listening
const probe = (text) => textRefusals('setup', text, P, { listening: [5432, 3306, 6379] })
test('safety: only :memory: or a relative SQLite path is exempt — never an absolute, ~ or .. path, never PG* or POSTGRES_DB', () => {
  const not = (name) => [`setup: database ${name} is not a bench database (bench_*)`]
  assert.deepEqual(probe('DB_DATABASE=/Users/me/www/proj/database/database.sqlite'), not('/Users/me/www/proj/database/database.sqlite'))
  assert.deepEqual(probe('DB_DATABASE=~/proj/dev.sqlite3'), not('~/proj/dev.sqlite3'))
  assert.deepEqual(probe('DB_DATABASE=../proj/dev.db'), not('../proj/dev.db'))
  assert.deepEqual(probe('DB_DATABASE=tmp/../../proj/dev.db'), not('tmp/../../proj/dev.db'))
  assert.deepEqual(probe('DB_DATABASE=$HOME/dev.db'), not('$HOME/dev.db'))
  assert.deepEqual(probe('PGDATABASE=app_dev.db'), not('app_dev.db'))
  assert.deepEqual(probe('POSTGRES_DB=app_dev.db'), not('app_dev.db'))
  assert.deepEqual(probe('DB_DATABASE=:memory: SQLITE_DATABASE=storage/test.sqlite DATABASE=tmp/app.db'), [])
})
test('safety: POSTGRES_DB, PGSERVICE and a URL\'s ?dbname= / &dbname= name a database too', () => {
  assert.deepEqual(probe('POSTGRES_DB=app_dev'), ['setup: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(probe('TEST_POSTGRES_DB=app_test'), ['setup: database app_test is not a bench database (bench_*)'])
  assert.deepEqual(probe('PGSERVICE=dev'), ['setup: database dev is not a bench database (bench_*)'])
  assert.deepEqual(probe('DATABASE_URL=postgres://h/bench_x?dbname=app_dev'), ['setup: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(probe('DATABASE_URL=postgres://h/bench_x?sslmode=off&dbname=app_dev'), ['setup: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(probe('REDIS_URL=redis://h:6379/0?dbname=app_dev'), ['setup: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(probe('POSTGRES_DB=bench_x PGSERVICE=bench_svc DATABASE_URL=postgres://h/bench_x?dbname=bench_y'), [])
})
test('safety: SHUTDOWN piped into a database client, and a server binary\'s own shutdown, are refused', () => {
  const stops = (s) => assert.ok(probe(s).some((x) => x.startsWith('setup: stops a database server: ')), `${s} → ${JSON.stringify(probe(s))}`)
  stops("printf 'SHUTDOWN\\n' | redis-cli")
  stops('echo "SHUTDOWN;" | mysql -u root')
  stops('mongod --shutdown --dbpath /data/db')
  stops('/usr/sbin/mysqld --shutdown')
  stops('redis-server --port 6380 && redis-cli -p 6380 shutdown')
  stops('postgres -D /data & kill -INT $! && echo shutdown')
  assert.deepEqual(probe('xcrun simctl shutdown bench_iphone && psql bench_p -c "select 1"'), [])
})
test('safety: the machine\'s shutdown, halt or reboot — by path, through sudo with flags — is refused', () => {
  for (const s of ['/sbin/shutdown -h now', 'sudo -n shutdown -r now', 'sudo -u root /sbin/halt', 'sudo --non-interactive reboot', 'halt', 'npm ci && /usr/sbin/reboot'])
    assert.ok(probe(s).some((x) => /^setup: shuts down or restarts the machine: /.test(x)), `${s} → ${JSON.stringify(probe(s))}`)
  assert.deepEqual(probe('npm run shutdown-hooks && echo reboot later'), [])
})
test('mcpConfigs and mcpScanText: every --mcp-config value; a JSON config\'s leaves read as KEY=value', () => {
  assert.deepEqual(mcpConfigs('--plugin-dir /b --mcp-config a.json b.json --model x --mcp-config=c.json'), ['a.json', 'b.json', 'c.json'])
  assert.deepEqual(mcpConfigs('--model x'), [])
  const text = JSON.stringify({ mcpServers: { db: { args: ['--port', 3000], env: { POSTGRES_DB: 'app_dev' } } } })
  assert.deepEqual(probe(mcpScanText(text)), ['setup: database app_dev is not a bench database (bench_*)'])
  assert.deepEqual(textRefusals('mcp', mcpScanText(text), P, { listening: [3000] }), ['mcp: database app_dev is not a bench database (bench_*)', 'mcp: port 3000 is in use now'])
  assert.equal(mcpScanText('not json'), 'not json')
})
test('caseEnv: no database variable is inherited — DATABASE_URL, DIRECT_URL, TEST_DATABASE_URL, PG*, REDIS_URL, MONGODB_URI, MONGO_URL, MYSQL_*, DB_* — unless the profile sets it', () => {
  const shell = { PATH: '/bin', HOME: '/h', DATABASE_URL: 'x', DIRECT_URL: 'x', TEST_DATABASE_URL: 'x', PGHOST: 'x', REDIS_URL: 'x', MONGODB_URI: 'x', MONGO_URL: 'x', MYSQL_PWD: 'x', MYSQL_HOST: 'x', DB_HOST: 'x', DB_DATABASE: 'x', REDIS_URL_OTHER: 'kept', MYDB_HOST: 'kept' }
  assert.deepEqual(caseEnv(shell, { DB_DATABASE: ':memory:' }, '/c'), { PATH: '/bin', HOME: '/h', REDIS_URL_OTHER: 'kept', MYDB_HOST: 'kept', DB_DATABASE: ':memory:', CLAUDE_PROJECT_DIR: '/c' })
})
test('safety: shutdown, halt or reboot after exec, nohup, env, command or time is the machine\'s', () => {
  for (const s of ['exec /sbin/reboot', 'nohup shutdown -h now', 'env shutdown -h now', 'env -i PATH=/bin shutdown -h now', 'command halt', 'time reboot', 'nohup sudo -n /sbin/shutdown -r now', 'FORCE=1 reboot'])
    assert.ok(probe(s).some((x) => /^setup: shuts down or restarts the machine: /.test(x)), `${s} → ${JSON.stringify(probe(s))}`)
  assert.deepEqual(probe('exec npm start && env FOO=1 node reboot-check.js'), [])
})
test('safety: brew services stop|restart, mysql.server stop|restart and pg_ctlcluster stop|restart are refused', () => {
  assert.deepEqual(probe('brew services stop postgresql@16'), ['setup: stops a service: brew services stop postgresql@16'])
  assert.deepEqual(probe('brew services restart anything'), ['setup: stops a service: brew services restart anything'])
  assert.deepEqual(probe('mysql.server stop'), ['setup: stops a database server: mysql.server stop'])
  assert.deepEqual(probe('mysql.server restart'), ['setup: stops a database server: mysql.server restart'])
  assert.deepEqual(probe('pg_ctlcluster 16 main stop'), ['setup: stops a database server: pg_ctlcluster 16 main stop'])
  assert.deepEqual(probe('sudo pg_ctlcluster 16 main restart'), ['setup: stops a database server: sudo pg_ctlcluster 16 main restart'])
  assert.deepEqual(probe('brew services list && brew services start bench_redis'), [])
})
test('caseEnv: POSTGRES_*, SUPABASE_DB_URL, REDIS_HOST and REDIS_PORT are not inherited either, unless the profile sets them', () => {
  const shell = { PATH: '/bin', POSTGRES_USER: 'x', POSTGRES_PASSWORD: 'x', POSTGRES_DB: 'x', SUPABASE_DB_URL: 'x', REDIS_HOST: 'x', REDIS_PORT: 'x', SUPABASE_URL: 'kept' }
  assert.deepEqual(caseEnv(shell, { REDIS_PORT: '6380' }, '/c'), { PATH: '/bin', SUPABASE_URL: 'kept', REDIS_PORT: '6380', CLAUDE_PROJECT_DIR: '/c' })
})
test('safety: pkill / killall and launchctl stopping a database service are refused', () => {
  for (const s of ['pkill postgres', 'pkill -f postgresql', 'killall -9 mysqld', 'sudo killall mariadbd', 'pkill redis-server', 'killall mongod', 'pkill -x valkey-server',
    'launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.postgresql@16.plist', 'launchctl bootout gui/501/homebrew.mxcl.redis', 'launchctl stop homebrew.mxcl.mysql', 'launchctl kill TERM gui/501/homebrew.mxcl.mongodb-community'])
    assert.ok(probe(s).some((x) => x === `setup: stops a database service: ${s}`), `${s} → ${JSON.stringify(probe(s))}`)
  assert.deepEqual(probe('pkill -f "node server.js" && killall bench_worker && launchctl list'), [])
})
