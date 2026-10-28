import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as profile from '../profile.mjs'
import {
  TEST_LEVERS, RECOMMENDED, FLOORS, parseTests, parseTestPlan, formatTests,
  planLabel, recommend, cost, estimate, planSize, rowLabel,
} from '../profile.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'profile.mjs')

// ── the levers ──────────────────────────────────────────────────────────────────────────────────

test('TEST_LEVERS: recommended value first; RECOMMENDED is the fast plan', () => {
  assert.deepEqual(TEST_LEVERS.walk, ['none', 'risk', 'full'])
  assert.deepEqual(TEST_LEVERS.review.slice(0, 3), ['end', 'app', 'slice'])
  assert.deepEqual(TEST_LEVERS.human, ['yes'])
  assert.equal(TEST_LEVERS.slice, undefined)
  assert.equal(TEST_LEVERS.end, undefined)
  for (const k of ['walk', 'review', 'models', 'persist', 'unruled']) assert.equal(RECOMMENDED[k], TEST_LEVERS[k][0], k)
  assert.equal(RECOMMENDED.human, undefined)
  assert.deepEqual(FLOORS, { finalReview: true })
})

test('6.0: the test plan is walk · review; old manifests map onto it', () => {
  assert.deepEqual(RECOMMENDED, { walk: 'none', review: 'end', models: 'default', persist: 'default', unruled: 'recommend' })
  assert.equal(formatTests(RECOMMENDED), 'walk=none review=end')
  assert.equal(planLabel({ ...RECOMMENDED, walk: 'risk', human: 'yes' }), 'risk · end · you')
  const old = parseTests('slice=own+app end=everything review=slice walk=you')
  assert.equal(old.warning, null)
  assert.deepEqual([old.levers.walk, old.levers.review, old.levers.human], ['full', 'slice', 'yes'])
  assert.equal(parseTests('end=touched').levers.walk, 'none')
  assert.equal(parseTests('end=none').levers.walk, 'none')
  assert.equal(parseTests('end=risk').levers.walk, 'risk')
  assert.match(parseTests('walk=sometimes').warning, /walk=sometimes/)
  assert.deepEqual(FLOORS, { finalReview: true })
})

test('formatTests: the two levers always, the rest only when not the default', () => {
  assert.equal(formatTests({ ...RECOMMENDED, walk: 'full', models: 'economy', persist: 'low', unruled: 'park', human: 'yes' }),
    'walk=full review=end models=economy persist=low unruled=park human=yes')
  assert.equal(formatTests({ walk: 'none', review: 'app' }), 'walk=none review=app')
})

test('planLabel: the two values ·-joined, · you when human=yes', () => {
  assert.equal(planLabel(RECOMMENDED), 'none · end')
  assert.equal(planLabel({ ...RECOMMENDED, walk: 'full', review: 'slice', human: 'yes' }), 'full · slice · you')
})

test('parseTests: round-trips formatTests; missing keys take the recommended value', () => {
  const levers = { ...RECOMMENDED, walk: 'risk', review: 'app', models: 'strong', human: 'yes' }
  assert.deepEqual(parseTests(formatTests(levers)), { levers, warning: null })
  assert.deepEqual(parseTests('walk=full'), { levers: { ...RECOMMENDED, walk: 'full' }, warning: null })
})

test('parseTests: an unknown pair is ignored with a warning; slice= is dropped silently', () => {
  const r = parseTests('slice=own walk=sometimes review=app colour=blue')
  assert.equal(r.levers.walk, 'none')
  assert.equal(r.levers.review, 'app')
  assert.match(r.warning, /walk=sometimes/)
  assert.match(r.warning, /colour=blue/)
  assert.doesNotMatch(r.warning, /slice=own/)
})

test('parseTests: a parenthetical note on the line is not a pair', () => {
  assert.deepEqual(parseTests('walk=risk review=end (recommended)'), { levers: { ...RECOMMENDED, walk: 'risk' }, warning: null })
})

// ── the manifest ────────────────────────────────────────────────────────────────────────────────

test('parseTestPlan: every source carries the floors', () => {
  for (const mf of [{ tests: 'walk=none' }, { profile: 'rush' }, { 'go-ahead': 'x' }, {}])
    assert.deepEqual(parseTestPlan(mf).floors, FLOORS)
})

test('parseTestPlan: a tests line wins over a profile line', () => {
  const p = parseTestPlan({ tests: 'walk=none review=end', profile: 'thorough', 'go-ahead': '2026-10-23' })
  assert.equal(p.source, 'tests')
  assert.equal(p.label, 'none · end')
  assert.equal(p.levers.walk, 'none')
  assert.equal(p.warning, null)
})

const MAPPING = {
  rush: 'walk=none review=end models=economy persist=low',
  standard: 'walk=risk review=slice',
  thorough: 'walk=full review=slice',
  'thorough-you': 'walk=full review=slice human=yes',
}

test('parseTestPlan: every old preset maps to its spec §6 row', () => {
  for (const [profile, tests] of Object.entries(MAPPING)) {
    const p = parseTestPlan({ profile, 'go-ahead': '2026-10-01' })
    assert.equal(p.source, 'profile', profile)
    assert.equal(formatTests(p.levers), tests, profile)
    assert.equal(p.warning, null, profile)
  }
  assert.equal(parseTestPlan({ profile: 'thorough-you' }).label, 'full · slice · you')
})

test('parseTestPlan: custom testing= translates to walk (full+human adds human=yes)', () => {
  const walk = (pairs) => parseTestPlan({ profile: `custom ${pairs} verify=floors` }).levers
  assert.equal(walk('testing=none').walk, 'none')
  assert.equal(walk('testing=risky').walk, 'risk')
  assert.equal(walk('testing=full').walk, 'full')
  assert.equal(walk('testing=full+human').walk, 'full')
  assert.equal(walk('testing=full+human').human, 'yes')
  assert.equal(walk('testing=full').human, undefined)
})

test('parseTestPlan: custom review= translates; per-task+second is kept as slice+second', () => {
  const review = (v) => parseTestPlan({ profile: `custom review=${v}` }).levers.review
  assert.equal(review('final'), 'end')
  assert.equal(review('per-task'), 'slice')
  assert.equal(review('per-task+second'), 'slice+second')
  assert.equal(formatTests(parseTestPlan({ profile: 'custom review=per-task+second' }).levers).includes('review=slice+second'), true)
})

test('parseTestPlan: custom verify= raises walk to at least its level, never lowers it', () => {
  const walk = (pairs) => parseTestPlan({ profile: `custom ${pairs}` }).levers.walk
  assert.equal(walk('testing=none verify=floors'), 'none')
  assert.equal(walk('testing=none verify=full'), 'risk')
  assert.equal(walk('testing=none verify=everything'), 'full')
  assert.equal(walk('testing=full verify=floors'), 'full')
})

test('parseTestPlan: custom keeps the old base (standard) for keys it does not name', () => {
  const p = parseTestPlan({ profile: 'custom models=strong persist=low unruled=park landing=local' })
  assert.equal(formatTests(p.levers), 'walk=risk review=slice models=strong persist=low unruled=park')
  assert.equal(p.warning, null)
})

test('parseTestPlan: a bad custom value carries the old warning', () => {
  const p = parseTestPlan({ profile: 'custom verify=none' })
  assert.match(p.warning, /verify=none/)
  assert.equal(p.levers.walk, 'risk')
})

test('parseTestPlan: an unknown profile is the thorough mapping with a warning', () => {
  const p = parseTestPlan({ profile: 'thorogh', 'go-ahead': 'x' })
  assert.equal(formatTests(p.levers), MAPPING.thorough)
  assert.match(p.warning, /unknown profile/)
})

test('parseTestPlan: neither line on a go-ahead\'d feature is the thorough mapping', () => {
  for (const profile of [undefined, 'none', '']) {
    const p = parseTestPlan({ profile, 'go-ahead': '2026-09-01' })
    assert.equal(p.source, 'default')
    assert.equal(formatTests(p.levers), MAPPING.thorough)
    assert.equal(p.label, 'full · slice')
  }
})

test('parseTestPlan: neither line and no go-ahead is the recommended plan, no label yet', () => {
  for (const mf of [{}, undefined, { 'go-ahead': 'none' }]) {
    const p = parseTestPlan(mf)
    assert.equal(p.source, 'default')
    assert.deepEqual(p.levers, RECOMMENDED)
    assert.equal(p.label, '—')
  }
})

test('parseTestPlan: build: here labels here', () => {
  assert.equal(parseTestPlan({ build: 'here', tests: MAPPING.standard }).label, 'here')
  assert.equal(parseTestPlan({ build: 'here' }).label, 'here')
})

// ── the recommendation ──────────────────────────────────────────────────────────────────────────

const spec = ({ apps = ['✅'], contract = [], schema = [] } = {}) => `# Spec

## Apps

| App | In scope | What changes | Section |
|---|---|---|---|
${apps.map((m, i) => `| app${i} | ${m} | stuff | §1 |`).join('\n')}

## Contract

| Contract | Producer | Consumers | Auth | Request | Response | Errors |
|---|---|---|---|---|---|---|
${contract.join('\n')}

## Schema & API changes

| # | ADD/EDIT/RENAME/REMOVE | Model.field | Wire | Reason | Status |
|---|---|---|---|---|---|
${schema.join('\n')}

## Decisions
`
const plan = (n) => `# Plan

## Phases

| Phase | App | Tasks | Goal | Gates |
|---|---|---|---|---|
| 1 | api | 1-${n} | go | lint |

${Array.from({ length: n }, (_, i) => `### Task ${i + 1}: thing\n\n**Files:** src/a.ts\n`).join('\n')}`
const crow = (consumers, auth = '—') => `| GET /x | api | ${consumers} | ${auth} | – | – | – |`
const BASE = { walk: 'none', review: 'end' }

test('recommend: no signal is the recommended plan', () => {
  for (const specText of [spec(), spec({ contract: [crow('web')] })]) {
    const r = recommend({ specText, planText: plan(8), cfg: {} })
    assert.deepEqual(r.tests, BASE)
    assert.deepEqual(r.signals, [])
    assert.match(r.reason, /recommended/)
  }
})

test('recommend: an EDIT, RENAME or REMOVE schema row raises only walk to risk, naming the signal', () => {
  for (const kind of ['EDIT', 'RENAME', 'REMOVE']) {
    const r = recommend({ specText: spec({ schema: [`| 1 | ${kind} | User.age | int | why | open |`] }), planText: plan(3), cfg: {} })
    assert.deepEqual(r.tests, { ...BASE, walk: 'risk' }, kind)
    assert.ok(r.signals.includes('breaking schema change'), kind)
    assert.match(r.reason, /breaking schema change/)
  }
})

test('recommend: ADD-only schema rows are not a signal — new surface nothing relies on yet', () => {
  const r = recommend({ specText: spec({ schema: ['| 1 | ADD | note.tags | string[] | why | planned |', '| 2 | ADD | CLI `notes tags` | stdout | why | planned |'] }), planText: plan(3), cfg: {} })
  assert.deepEqual(r.tests, BASE)
  assert.deepEqual(r.signals, [])
})

test('recommend: a migration task raises walk', () => {
  const planText = plan(2).replace('### Task 1: thing', '### Task 1: add migration')
  const r = recommend({ specText: spec(), planText, cfg: {} })
  assert.equal(r.tests.walk, 'risk')
  assert.ok(r.signals.includes('migration'))
})

test('recommend: a contract consumed by a released app raises walk', () => {
  const r = recommend({ specText: spec({ contract: [crow('mobile')] }), planText: plan(3), cfg: { released: ['mobile'] } })
  assert.deepEqual(r.tests, { ...BASE, walk: 'risk' })
  assert.ok(r.signals.includes('released consumer'))
})

test('recommend: three in-scope apps raises walk', () => {
  const r = recommend({ specText: spec({ apps: ['✅', '✅', '✅'] }), planText: plan(3), cfg: {} })
  assert.equal(r.tests.walk, 'risk')
  assert.ok(r.signals.includes('3 apps'))
})

test('recommend: a plain session or user Auth cell is not an auth signal', () => {
  for (const auth of ['session', 'user', 'Session cookie'])
    assert.deepEqual(recommend({ specText: spec({ contract: [crow('web', auth)] }), planText: plan(8), cfg: {} }).tests, BASE, auth)
})

test('recommend: an Auth cell naming a role or permission, or a delete verb, raises walk', () => {
  for (const auth of ['admin', 'role: editor', 'permission x.write', 'owner only', 'scope read:all']) {
    const r = recommend({ specText: spec({ contract: [crow('web', auth)] }), planText: plan(8), cfg: {} })
    assert.equal(r.tests.walk, 'risk', auth)
    assert.ok(r.signals.includes('auth or delete'))
  }
  assert.equal(recommend({ specText: spec({ contract: ['| DELETE /x | api | web | session | – | – | – |'] }), planText: plan(8), cfg: {} }).tests.walk, 'risk')
  assert.equal(recommend({ specText: spec({ contract: ['| POST /x | api | web | — | – | removes the item | – |'] }), planText: plan(8), cfg: {} }).tests.walk, 'risk')
})

test('recommend: build_profile_default is its mapping when there is no signal', () => {
  const r = recommend({ specText: spec(), planText: plan(8), cfg: { buildProfileDefault: 'thorough' } })
  assert.deepEqual(r.tests, { walk: 'full', review: 'slice' })
  assert.match(r.reason, /build_profile_default/)
  const rush = recommend({ specText: spec(), planText: plan(8), cfg: { buildProfileDefault: 'rush' } })
  assert.equal(formatTests(rush.tests), MAPPING.rush)
})

test('recommend: a signal raises walk on the configured default, never lowers it', () => {
  const schema = ['| 1 | EDIT | User.age | int | why | open |']
  assert.equal(recommend({ specText: spec({ schema }), planText: plan(3), cfg: { buildProfileDefault: 'rush' } }).tests.walk, 'risk')
  assert.equal(recommend({ specText: spec({ schema }), planText: plan(3), cfg: { buildProfileDefault: 'thorough' } }).tests.walk, 'full')
})

// ── the cost ────────────────────────────────────────────────────────────────────────────────────

const plan3 = `# Plan

## Phases

| Phase | App | Tasks | Goal | Gates |
|---|---|---|---|---|
| 1 | api | 1-4 | go | lint |
| 2 | web | 5-7 | go | lint |
| 3 | mobile | 8, 9 | go | lint |

${Array.from({ length: 9 }, (_, i) => `### Task ${i + 1}: thing\n`).join('\n')}`
const lv = (o) => ({ ...RECOMMENDED, ...o })

test('6.0: recommend raises walk to risk on a signal; cost counts reviews and the walk', () => {
  const spec = '## Schema & API changes\n\n| # | Kind |\n|---|---|\n| SC1 | EDIT |\n'
  const r = recommend({ specText: spec, planText: '', cfg: {} })
  assert.equal(r.tests.walk, 'risk')
  assert.match(r.reason, /walk raised to risk: breaking schema change/)
  const plan = '## Phases\n\n| Phase | App | Tasks | Goal |\n|---|---|---|---|\n| 1 | server | 1–2 | x |\n| 2 | web | 3 | y |\n\n### Task 1\n### Task 2\n### Task 3\n'
  assert.deepEqual(cost({ planText: plan, levers: { review: 'slice', walk: 'full' } }), { slices: 3, apps: 2, phases: 2, reviews: 4, walk: 'full' })
})

test('cost: the recommended plan is one review and no agent walk', () => {
  assert.deepEqual(cost({ planText: plan3, levers: RECOMMENDED }), { slices: 9, apps: 3, phases: 3, reviews: 1, walk: 'none' })
})

test('cost: reviews by cadence, plus the final whole-branch review', () => {
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'slice' }) }).reviews, 10)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'slice+second' }) }).reviews, 10)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'app' }) }).reviews, 4)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'end' }) }).reviews, 1)
})

test('cost: walk is the walk lever', () => {
  for (const walk of ['none', 'risk', 'full']) assert.equal(cost({ planText: plan3, levers: lv({ walk }) }).walk, walk)
})

test('planSize counts tasks, phases and apps', () => {
  assert.deepEqual(planSize(plan(4)), { tasks: 4, phases: 1, apps: 1 })
  assert.deepEqual(planSize(plan3), { tasks: 9, phases: 3, apps: 3 })
})

// ── the estimate ────────────────────────────────────────────────────────────────────────────────

const row = (tasks, key = { tests: 'walk=none review=end' }) => ({ ...key, size: { tasks }, lanes: { build: 600000, walk: 300000 }, tokens: { input: 1000000, output: 100000 } })
const OWN = 'none · end'

test('estimate: too few rows is null', () => {
  assert.equal(estimate([], OWN, 10), null)
  assert.equal(estimate([row(10), row(10)], OWN, 10), null)
})

test('estimate: three rows give the median per task times the task count', () => {
  const e = estimate([row(10), row(10), row(20)], OWN, 10)
  assert.equal(e.n, 3)
  assert.equal(e.minutes, 15)
  assert.equal(e.tokens, 1100000)
})

test('estimate: rows are keyed by their tests label — pair order and the extra levers do not split it', () => {
  const rows = [row(10), row(10, { tests: 'review=end walk=none' }), row(10, { tests: 'walk=none review=end persist=low' })]
  assert.equal(estimate(rows, OWN, 10).n, 3)
  assert.equal(estimate([...rows.slice(0, 2), row(10, { tests: 'walk=risk review=end' })], OWN, 10), null)
})

test('estimate: an old row\'s profile is mapped to its label', () => {
  const rows = [row(10, { profile: 'standard' }), row(10, { profile: 'standard' }), row(10, { tests: MAPPING.standard })]
  assert.equal(estimate(rows, 'risk · slice', 10).n, 3)
  assert.equal(estimate(rows, OWN, 10), null)
})

test('estimate: rows without size or a key are ignored', () => {
  const old = { lanes: { build: 1, walk: 1 }, tokens: { input: 1, output: 1 } }
  assert.equal(estimate([old, old, old, row(10), row(10)], OWN, 10), null)
})

test('estimate: a row whose tokens sum to 0 is not usable', () => {
  const zero = { ...row(10), tokens: { input: 0, output: 0 } }
  assert.equal(estimate([zero, zero, zero, row(10), row(10)], OWN, 10), null)
})

test('estimate: a feature with no plan yet (0 tasks) has no number, never 0 minutes', () => {
  assert.equal(estimate([row(10), row(10), row(20)], OWN, 0), null)
  assert.equal(estimate([row(10), row(10), row(20)], OWN, undefined), null)
})

// ── the old preset API is gone: an old profile: is read only through parseTestPlan / rowLabel ──

test('the old preset API is no longer exported', () => {
  for (const name of ['parseProfile', 'PRESETS', 'LEVERS', 'profileLabel', 'PROFILE_LABELS']) assert.equal(name in profile, false, name)
})

test('parseTestPlan: an unknown old profile reads as thorough, with the old warning', () => {
  const p = parseTestPlan({ profile: 'thorogh' })
  assert.match(p.warning, /unknown profile/)
  assert.equal(p.label, 'full · slice')
})

test('rowLabel: an archive row (or fleet facts) by its tests, else its old profile mapped; here; null', () => {
  assert.equal(rowLabel({ tests: 'walk=risk review=end', profile: 'rush' }), 'risk · end')
  assert.equal(rowLabel({ tests: 'slice=own end=risk review=end' }), 'risk · end')
  assert.equal(rowLabel({ profile: 'rush' }), 'none · end')
  assert.equal(rowLabel({ profile: 'thorough-you' }), 'full · slice · you')
  assert.equal(rowLabel({ profile: 'custom' }), 'risk · slice')
  assert.equal(rowLabel({ profile: 'here' }), 'here')
  assert.equal(rowLabel({ profile: null }), null)
  assert.equal(rowLabel(undefined), null)
})

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────

function fixture({ manifest = '', config = null, specText = spec({ contract: [crow('web')] }), planText = plan(8) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prof-'))
  if (config) { mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.claude/builder.md'), config) }
  mkdirSync(join(root, 'f'))
  writeFileSync(join(root, 'f/SPEC.md'), specText)
  writeFileSync(join(root, 'f/PLAN.md'), planText)
  writeFileSync(join(root, 'f/MANIFEST.md'), manifest)
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  return { root, dir: join(root, 'f'), run }
}

test('--recommend names an invalid build_profile_default on stderr and falls back to the recommended plan', () => {
  const { dir, run } = fixture({ config: '---\nproject: t\nbuild_profile_default: speedy\napps:\n  - name: app\n    path: app/\n    role: app\n---\nbody\n' })
  const r = run('--recommend', dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /build_profile_default: "speedy" is not one of rush, standard, thorough/)
  assert.deepEqual(JSON.parse(r.stdout).tests, BASE)
})

test('--levers reads the manifest\'s test plan and prints a warning on stderr', () => {
  const { dir, run } = fixture({ manifest: 'state: planned\ngo-ahead: 2026-10-23\ntests: walk=risk review=app colour=blue\n' })
  const r = run('--levers', dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.source, 'tests')
  assert.equal(out.label, 'risk · app')
  assert.deepEqual(out.floors, FLOORS)
  assert.match(r.stderr, /colour=blue/)
})

test('--cost counts the plan under --tests', () => {
  const { dir, run } = fixture({ planText: plan3 })
  const r = run('--cost', dir, '--tests', 'walk=none review=app')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { slices: 9, apps: 3, phases: 3, reviews: 4, walk: 'none' })
})

test('--estimate is null without fleet history', () => {
  const { dir, run } = fixture()
  const r = run('--estimate', dir, '--tests', 'walk=none review=end')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'null')
})

test('no mode is a usage error', () => {
  const { run } = fixture()
  assert.equal(run().status, 2)
})
