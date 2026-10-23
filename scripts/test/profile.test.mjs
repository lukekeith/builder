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
  assert.deepEqual(TEST_LEVERS.slice, ['own', 'own+app', 'full', 'none'])
  assert.deepEqual(TEST_LEVERS.end, ['touched', 'risk', 'everything', 'none'])
  assert.deepEqual(TEST_LEVERS.review.slice(0, 3), ['end', 'app', 'slice'])
  assert.deepEqual(TEST_LEVERS.walk, ['you'])
  for (const k of ['slice', 'end', 'review', 'models', 'persist', 'unruled']) assert.equal(RECOMMENDED[k], TEST_LEVERS[k][0], k)
  assert.equal(RECOMMENDED.walk, undefined)
  assert.deepEqual(FLOORS, { typecheck: true, finalReview: true })
})

test('formatTests: the three levers always, the rest only when not the default', () => {
  assert.equal(formatTests(RECOMMENDED), 'slice=own end=touched review=end')
  assert.equal(formatTests({ ...RECOMMENDED, slice: 'full', models: 'economy', persist: 'low', unruled: 'park', walk: 'you' }),
    'slice=full end=touched review=end models=economy persist=low unruled=park walk=you')
  assert.equal(formatTests({ slice: 'none', end: 'none', review: 'app' }), 'slice=none end=none review=app')
})

test('planLabel: the three values ·-joined, · you when walk=you', () => {
  assert.equal(planLabel(RECOMMENDED), 'own · touched · end')
  assert.equal(planLabel({ ...RECOMMENDED, slice: 'own+app', end: 'everything', review: 'slice', walk: 'you' }), 'own+app · everything · slice · you')
})

test('parseTests: round-trips formatTests; missing keys take the recommended value', () => {
  const levers = { ...RECOMMENDED, slice: 'full', end: 'risk', review: 'app', models: 'strong', walk: 'you' }
  assert.deepEqual(parseTests(formatTests(levers)), { levers, warning: null })
  assert.deepEqual(parseTests('end=none'), { levers: { ...RECOMMENDED, end: 'none' }, warning: null })
})

test('parseTests: an unknown pair is ignored with a warning', () => {
  const r = parseTests('slice=sometimes end=risk colour=blue')
  assert.equal(r.levers.slice, 'own')
  assert.equal(r.levers.end, 'risk')
  assert.match(r.warning, /slice=sometimes/)
  assert.match(r.warning, /colour=blue/)
})

test('parseTests: a parenthetical note on the line is not a pair', () => {
  assert.deepEqual(parseTests('slice=own end=risk review=end (recommended)'), { levers: { ...RECOMMENDED, end: 'risk' }, warning: null })
})

// ── the manifest ────────────────────────────────────────────────────────────────────────────────

test('parseTestPlan: every source carries the floors', () => {
  for (const mf of [{ tests: 'slice=none end=none' }, { profile: 'rush' }, { 'go-ahead': 'x' }, {}])
    assert.deepEqual(parseTestPlan(mf).floors, FLOORS)
})

test('parseTestPlan: a tests line wins over a profile line', () => {
  const p = parseTestPlan({ tests: 'slice=none end=none review=end', profile: 'thorough', 'go-ahead': '2026-10-23' })
  assert.equal(p.source, 'tests')
  assert.equal(p.label, 'none · none · end')
  assert.equal(p.levers.slice, 'none')
  assert.equal(p.warning, null)
})

const MAPPING = {
  rush: 'slice=own+app end=touched review=end models=economy persist=low',
  standard: 'slice=own+app end=risk review=slice',
  thorough: 'slice=own+app end=everything review=slice',
  'thorough-you': 'slice=own+app end=everything review=slice walk=you',
}

test('parseTestPlan: every old preset maps to its spec §6 row', () => {
  for (const [profile, tests] of Object.entries(MAPPING)) {
    const p = parseTestPlan({ profile, 'go-ahead': '2026-10-01' })
    assert.equal(p.source, 'profile', profile)
    assert.equal(formatTests(p.levers), tests, profile)
    assert.equal(p.warning, null, profile)
  }
  assert.equal(parseTestPlan({ profile: 'thorough-you' }).label, 'own+app · everything · slice · you')
})

test('parseTestPlan: custom testing= translates to end (full+human adds walk=you)', () => {
  const end = (pairs) => parseTestPlan({ profile: `custom ${pairs} verify=floors` }).levers
  assert.equal(end('testing=none').end, 'touched')
  assert.equal(end('testing=risky').end, 'risk')
  assert.equal(end('testing=full').end, 'everything')
  assert.equal(end('testing=full+human').end, 'everything')
  assert.equal(end('testing=full+human').walk, 'you')
  assert.equal(end('testing=full').walk, undefined)
})

test('parseTestPlan: custom review= translates; per-task+second is kept as slice+second', () => {
  const review = (v) => parseTestPlan({ profile: `custom review=${v}` }).levers.review
  assert.equal(review('final'), 'end')
  assert.equal(review('per-task'), 'slice')
  assert.equal(review('per-task+second'), 'slice+second')
  assert.equal(formatTests(parseTestPlan({ profile: 'custom review=per-task+second' }).levers).includes('review=slice+second'), true)
})

test('parseTestPlan: custom verify= raises end to at least its level, never lowers it', () => {
  const end = (pairs) => parseTestPlan({ profile: `custom ${pairs}` }).levers.end
  assert.equal(end('testing=none verify=floors'), 'touched')
  assert.equal(end('testing=none verify=full'), 'risk')
  assert.equal(end('testing=none verify=everything'), 'everything')
  assert.equal(end('testing=full verify=floors'), 'everything')
})

test('parseTestPlan: custom keeps the old base (standard) for keys it does not name', () => {
  const p = parseTestPlan({ profile: 'custom models=strong persist=low unruled=park landing=local' })
  assert.equal(formatTests(p.levers), 'slice=own+app end=risk review=slice models=strong persist=low unruled=park')
  assert.equal(p.warning, null)
})

test('parseTestPlan: a bad custom value carries the old warning', () => {
  const p = parseTestPlan({ profile: 'custom verify=none' })
  assert.match(p.warning, /verify=none/)
  assert.equal(p.levers.end, 'risk')
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
    assert.equal(p.label, 'own+app · everything · slice')
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
const BASE = { slice: 'own', end: 'touched', review: 'end' }

test('recommend: no signal is the recommended plan', () => {
  for (const specText of [spec(), spec({ contract: [crow('web')] })]) {
    const r = recommend({ specText, planText: plan(8), cfg: {} })
    assert.deepEqual(r.tests, BASE)
    assert.deepEqual(r.signals, [])
    assert.match(r.reason, /recommended/)
  }
})

test('recommend: an EDIT, RENAME or REMOVE schema row raises only end to risk, naming the signal', () => {
  for (const kind of ['EDIT', 'RENAME', 'REMOVE']) {
    const r = recommend({ specText: spec({ schema: [`| 1 | ${kind} | User.age | int | why | open |`] }), planText: plan(3), cfg: {} })
    assert.deepEqual(r.tests, { ...BASE, end: 'risk' }, kind)
    assert.ok(r.signals.includes('breaking schema change'), kind)
    assert.match(r.reason, /breaking schema change/)
  }
})

test('recommend: ADD-only schema rows are not a signal — new surface nothing relies on yet', () => {
  const r = recommend({ specText: spec({ schema: ['| 1 | ADD | note.tags | string[] | why | planned |', '| 2 | ADD | CLI `notes tags` | stdout | why | planned |'] }), planText: plan(3), cfg: {} })
  assert.deepEqual(r.tests, BASE)
  assert.deepEqual(r.signals, [])
})

test('recommend: a migration task raises end', () => {
  const planText = plan(2).replace('### Task 1: thing', '### Task 1: add migration')
  const r = recommend({ specText: spec(), planText, cfg: {} })
  assert.equal(r.tests.end, 'risk')
  assert.ok(r.signals.includes('migration'))
})

test('recommend: a contract consumed by a released app raises end', () => {
  const r = recommend({ specText: spec({ contract: [crow('mobile')] }), planText: plan(3), cfg: { released: ['mobile'] } })
  assert.deepEqual(r.tests, { ...BASE, end: 'risk' })
  assert.ok(r.signals.includes('released consumer'))
})

test('recommend: three in-scope apps raises end', () => {
  const r = recommend({ specText: spec({ apps: ['✅', '✅', '✅'] }), planText: plan(3), cfg: {} })
  assert.equal(r.tests.end, 'risk')
  assert.ok(r.signals.includes('3 apps'))
})

test('recommend: a plain session or user Auth cell is not an auth signal', () => {
  for (const auth of ['session', 'user', 'Session cookie'])
    assert.deepEqual(recommend({ specText: spec({ contract: [crow('web', auth)] }), planText: plan(8), cfg: {} }).tests, BASE, auth)
})

test('recommend: an Auth cell naming a role or permission, or a delete verb, raises end', () => {
  for (const auth of ['admin', 'role: editor', 'permission x.write', 'owner only', 'scope read:all']) {
    const r = recommend({ specText: spec({ contract: [crow('web', auth)] }), planText: plan(8), cfg: {} })
    assert.equal(r.tests.end, 'risk', auth)
    assert.ok(r.signals.includes('auth or delete'))
  }
  assert.equal(recommend({ specText: spec({ contract: ['| DELETE /x | api | web | session | – | – | – |'] }), planText: plan(8), cfg: {} }).tests.end, 'risk')
  assert.equal(recommend({ specText: spec({ contract: ['| POST /x | api | web | — | – | removes the item | – |'] }), planText: plan(8), cfg: {} }).tests.end, 'risk')
})

test('recommend: build_profile_default is its mapping when there is no signal', () => {
  const r = recommend({ specText: spec(), planText: plan(8), cfg: { buildProfileDefault: 'thorough' } })
  assert.deepEqual(r.tests, { slice: 'own+app', end: 'everything', review: 'slice' })
  assert.match(r.reason, /build_profile_default/)
  const rush = recommend({ specText: spec(), planText: plan(8), cfg: { buildProfileDefault: 'rush' } })
  assert.equal(formatTests(rush.tests), MAPPING.rush)
})

test('recommend: a signal raises end on the configured default, never lowers it', () => {
  const schema = ['| 1 | EDIT | User.age | int | why | open |']
  assert.equal(recommend({ specText: spec({ schema }), planText: plan(3), cfg: { buildProfileDefault: 'rush' } }).tests.end, 'risk')
  assert.equal(recommend({ specText: spec({ schema }), planText: plan(3), cfg: { buildProfileDefault: 'thorough' } }).tests.end, 'everything')
})

test('recommend: never slice=full', () => {
  const big = spec({ apps: ['✅', '✅', '✅', '✅'], contract: [crow('mobile', 'admin')], schema: ['| 1 | ADD | A.b | x | y | z |'] })
  for (const buildProfileDefault of [undefined, 'rush', 'standard', 'thorough'])
    assert.notEqual(recommend({ specText: big, planText: plan(30), cfg: { buildProfileDefault, released: ['mobile'] } }).tests.slice, 'full')
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

test('cost: the recommended plan — own tests per slice, one suite per app at the end, one review', () => {
  assert.deepEqual(cost({ planText: plan3, levers: RECOMMENDED }),
    { slices: 9, apps: 3, phases: 3, ownRuns: 9, suiteRuns: 3, reviews: 1, walk: 'none', minutes: null })
})

test('cost: suite runs by slice and end', () => {
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'own+app' }) }).suiteRuns, 3 + 3)
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'full' }) }).suiteRuns, 9 + 3)
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'none', end: 'none' }) }).suiteRuns, 0)
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'none' }) }).ownRuns, 0)
})

test('cost: reviews by cadence, plus the final whole-branch review', () => {
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'slice' }) }).reviews, 10)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'slice+second' }) }).reviews, 10)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'app' }) }).reviews, 4)
  assert.equal(cost({ planText: plan3, levers: lv({ review: 'end' }) }).reviews, 1)
})

test('cost: walk follows end', () => {
  assert.equal(cost({ planText: plan3, levers: lv({ end: 'risk' }) }).walk, 'risk')
  assert.equal(cost({ planText: plan3, levers: lv({ end: 'everything' }) }).walk, 'full')
  assert.equal(cost({ planText: plan3, levers: lv({ end: 'none' }) }).walk, 'none')
})

const dur = (ms) => ({ total: ms, commands: {}, at: '2026-10-23T00:00:00Z' })

test('cost: minutes are suite runs × each app\'s recorded duration', () => {
  const durations = { api: dur(120000), web: dur(60000), mobile: dur(180000) }
  // recommended: one end run per app → 2 + 1 + 3 = 6 min
  assert.equal(cost({ planText: plan3, levers: RECOMMENDED, durations }).minutes, 6)
  // full: api 4+1, web 3+1, mobile 2+1 → 10 + 4 + 9 = 23 min
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'full' }), durations }).minutes, 23)
  // own+app: one phase each + one end each → 2 × 6
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'own+app' }), durations }).minutes, 12)
})

test('cost: an app without a recorded duration makes minutes unknown; no suite runs is 0', () => {
  assert.equal(cost({ planText: plan3, levers: RECOMMENDED, durations: { api: dur(1), web: dur(1) } }).minutes, null)
  assert.equal(cost({ planText: plan3, levers: lv({ slice: 'none', end: 'none' }), durations: {} }).minutes, 0)
})

test('cost: a task block\'s App: line wins over the phase table', () => {
  const p = plan3.replace('### Task 5: thing\n', '### Task 5: thing\n\n**App:** api\n')
  const durations = { api: dur(60000), web: dur(60000 * 10), mobile: dur(0) }
  // full: api 5 tasks + 1, web 2 tasks + 1 → 6 + 30
  assert.equal(cost({ planText: p, levers: lv({ slice: 'full' }), durations }).minutes, 36)
})

test('planSize counts tasks, phases and apps', () => {
  assert.deepEqual(planSize(plan(4)), { tasks: 4, phases: 1, apps: 1 })
  assert.deepEqual(planSize(plan3), { tasks: 9, phases: 3, apps: 3 })
})

// ── the estimate ────────────────────────────────────────────────────────────────────────────────

const row = (tasks, key = { tests: 'slice=own end=touched review=end' }) => ({ ...key, size: { tasks }, lanes: { build: 600000, walk: 300000 }, tokens: { input: 1000000, output: 100000 } })
const OWN = 'own · touched · end'

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
  const rows = [row(10), row(10, { tests: 'review=end end=touched slice=own' }), row(10, { tests: 'slice=own end=touched review=end persist=low' })]
  assert.equal(estimate(rows, OWN, 10).n, 3)
  assert.equal(estimate([...rows.slice(0, 2), row(10, { tests: 'slice=full end=touched review=end' })], OWN, 10), null)
})

test('estimate: an old row\'s profile is mapped to its label', () => {
  const rows = [row(10, { profile: 'standard' }), row(10, { profile: 'standard' }), row(10, { tests: MAPPING.standard })]
  assert.equal(estimate(rows, 'own+app · risk · slice', 10).n, 3)
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
  assert.equal(p.label, 'own+app · everything · slice')
})

test('rowLabel: an archive row (or fleet facts) by its tests, else its old profile mapped; here; null', () => {
  assert.equal(rowLabel({ tests: 'slice=own end=risk review=end', profile: 'rush' }), 'own · risk · end')
  assert.equal(rowLabel({ profile: 'rush' }), 'own+app · touched · end')
  assert.equal(rowLabel({ profile: 'thorough-you' }), 'own+app · everything · slice · you')
  assert.equal(rowLabel({ profile: 'custom' }), 'own+app · risk · slice')
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
  const { dir, run } = fixture({ manifest: 'state: planned\ngo-ahead: 2026-10-23\ntests: slice=full end=risk review=app colour=blue\n' })
  const r = run('--levers', dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.source, 'tests')
  assert.equal(out.label, 'full · risk · app')
  assert.deepEqual(out.floors, FLOORS)
  assert.match(r.stderr, /colour=blue/)
})

test('--cost counts the plan under --tests; minutes null without recorded durations', () => {
  const { dir, run } = fixture({ planText: plan3 })
  const r = run('--cost', dir, '--tests', 'slice=full end=none review=app')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { slices: 9, apps: 3, phases: 3, ownRuns: 9, suiteRuns: 9, reviews: 4, walk: 'none', minutes: null })
})

test('--estimate is null without fleet history', () => {
  const { dir, run } = fixture()
  const r = run('--estimate', dir, '--tests', 'slice=own end=touched review=end')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'null')
})

test('no mode is a usage error', () => {
  const { run } = fixture()
  assert.equal(run().status, 2)
})
