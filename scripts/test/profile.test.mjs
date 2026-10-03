import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, FLOORS, parseProfile, recommend, estimate, planSize } from '../profile.mjs'

test('parseProfile: absent or none is thorough with no warning', () => {
  for (const v of [undefined, 'none']) {
    const p = parseProfile(v)
    assert.equal(p.preset, 'thorough')
    assert.equal(p.warning, null)
  }
})

test('parseProfile: an unknown profile is thorough with a warning', () => {
  const p = parseProfile('thorogh')
  assert.equal(p.preset, 'thorough')
  assert.match(p.warning, /unknown profile/)
})

test('parseProfile: custom keeps the other levers at standard', () => {
  const p = parseProfile('custom testing=risky review=final')
  assert.equal(p.preset, 'custom')
  assert.deepEqual(p.levers, { ...PRESETS.standard, testing: 'risky', review: 'final' })
})

test('parseProfile: a bad custom value is dropped with a warning, floors intact', () => {
  const p = parseProfile('custom verify=none')
  assert.equal(p.levers.verify, PRESETS.standard.verify)
  assert.match(p.warning, /verify=none/)
  assert.deepEqual(p.floors, FLOORS)
})

test('parseProfile: every preset carries the floors', () => {
  for (const name of Object.keys(PRESETS)) {
    const p = parseProfile(name)
    assert.equal(p.preset, name)
    assert.deepEqual(p.floors, FLOORS)
  }
})

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

test('recommend: a schema row is thorough', () => {
  const r = recommend({ specText: spec({ schema: ['| 1 | ADD | User.age | int | why | open |'] }), planText: plan(3), cfg: {} })
  assert.equal(r.preset, 'thorough')
  assert.ok(r.signals.includes('schema change'))
})

test('recommend: a contract consumed by a released app is thorough', () => {
  const r = recommend({ specText: spec({ contract: [crow('mobile')] }), planText: plan(3), cfg: { released: ['mobile'] } })
  assert.equal(r.preset, 'thorough')
})

test('recommend: three in-scope apps is thorough', () => {
  const r = recommend({ specText: spec({ apps: ['✅', '✅', '✅'] }), planText: plan(3), cfg: {} })
  assert.equal(r.preset, 'thorough')
  assert.ok(r.signals.includes('3 apps'))
})

test('recommend: one app, no contract, four tasks is rush', () => {
  assert.equal(recommend({ specText: spec(), planText: plan(4), cfg: {} }).preset, 'rush')
})

test('recommend: one app, a contract row, eight tasks is standard, or the configured default', () => {
  const specText = spec({ contract: [crow('web')] })
  assert.equal(recommend({ specText, planText: plan(8), cfg: {} }).preset, 'standard')
  assert.equal(recommend({ specText, planText: plan(8), cfg: { buildProfileDefault: 'thorough' } }).preset, 'thorough')
})

test('planSize counts tasks, phases and apps', () => {
  assert.deepEqual(planSize(plan(4)), { tasks: 4, phases: 1, apps: 1 })
})

const row = (tasks) => ({ profile: 'standard', size: { tasks }, lanes: { build: 600000, walk: 300000 }, tokens: { input: 1000000, output: 100000 } })

test('estimate: too few rows is null', () => {
  assert.equal(estimate([], 'standard', 10), null)
  assert.equal(estimate([row(10), row(10)], 'standard', 10), null)
})

test('estimate: three rows give the median per task times the task count', () => {
  const e = estimate([row(10), row(10), row(20)], 'standard', 10)
  assert.equal(e.n, 3)
  assert.equal(e.minutes, 15)
  assert.equal(e.tokens, 1100000)
})

test('estimate: rows without size or profile are ignored', () => {
  const old = { lanes: { build: 1, walk: 1 }, tokens: { input: 1, output: 1 } }
  assert.equal(estimate([old, old, old, row(10), row(10)], 'standard', 10), null)
})
