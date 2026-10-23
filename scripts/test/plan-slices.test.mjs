import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slices, countTests, render, leverWords, costWords } from '../plan-slices.mjs'
import { RECOMMENDED, cost } from '../profile.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'plan-slices.mjs')
const FIXTURE = join(HERE, 'fixtures', 'plan-slices', 'cert-tags')
const PLAN = readFileSync(join(FIXTURE, 'PLAN.md'), 'utf8')
const fence = (body) => '```ts\n' + body + '\n```'

// ── slices ──────────────────────────────────────────────────────────────────────────────────────

test('slices: one per ### Task N, with its app, phase, name and fenced test count', () => {
  const s = slices(PLAN)
  assert.equal(s.length, 12)
  assert.deepEqual(s[0], { n: 1, app: 'api', phase: 1, name: 'Tag and CertificateTag models + migration', tests: 3 })
  assert.deepEqual(s.map((x) => x.app), [...Array(4).fill('api'), ...Array(5).fill('web'), ...Array(3).fill('mobile')])
  assert.deepEqual(s.map((x) => x.tests), [3, 6, 4, 2, 2, 0, 3, 2, 1, 2, 3, 2])
})

test('countTests: it( test( def test_ func Test #[test], inside fences only', () => {
  const block = [
    'mentions it( and test( in prose',
    fence("it('a', () => {})\ntest('b', () => {})\ndescribe('c', () => { it.skip('d') })\nsubmit(x); latest(y)"),
    '```py\ndef test_one():\n    pass\ndef helper(): pass\n```',
    '```go\nfunc TestTwo(t *testing.T) {}\nfunc helper() {}\n```',
    '```rust\n#[test]\nfn three() {}\n```',
  ].join('\n\n')
  assert.equal(countTests(block), 5)
  assert.equal(countTests('no fences, it( test('), 0)
})

test('slices: a heading inside a fence is not a task; the app falls back to the Phases row', () => {
  const plan = [
    '## Phases', '', '| Phase | App | Tasks | Goal | Gates |', '|---|---|---|---|---|', '| 1 | api | 1-2 | x | y |', '',
    '### Task 1: First', 'Phase: 1', '', '````md', '### Task 9: an example', fence("it('x')"), '````', '',
    '### Task 2 — Second', 'App: `api`', 'Phase: 1',
  ].join('\n')
  const s = slices(plan)
  assert.deepEqual(s.map((x) => [x.n, x.name, x.app, x.tests]), [[1, 'First', 'api', 1], [2, 'Second', 'api', 0]])
})

// ── render ──────────────────────────────────────────────────────────────────────────────────────

const base = (over = {}) => {
  const s = slices(PLAN)
  const levers = { ...RECOMMENDED }
  return { feature: 'cert-tags', target: 'main', slices: s, levers, recommended: { ...RECOMMENDED }, cost: cost({ planText: PLAN, levers, durations: {} }), ...over }
}

test('render: header, app once per group, right-aligned +N tests, — for none', () => {
  const lines = render(base()).split('\n')
  assert.equal(lines[0], 'cert-tags — 12 slices in 3 apps · lands on main')
  assert.equal(lines[1], '')
  assert.match(lines[2], /^api     1  Tag and CertificateTag models \+ migration\s+\+3 tests$/)
  assert.match(lines[3], /^ {8}2  Tag create/)
  assert.match(lines[6], /^web     5  Tag chips/)
  assert.match(lines[7], /^ {8}6  Tag picker on the certificate form\s+—$/)
  assert.match(lines[11], /^mobile 10  Tag store/)
  const rows = lines.slice(2, 14)
  assert.equal(new Set(rows.map((l) => l.length)).size, 1, 'every row ends in the same column')
  assert.match(lines[10], /\+1 test$/)
})

test('render: the recommended test plan, its words and its counts', () => {
  const out = render(base())
  assert.match(out, /\nTest plan \(recommended\): each slice runs its own tests · at the end, the api, web and mobile suites once · one review at the end\n/)
  assert.match(out, /\n {2}12 quick test runs \+ 3 suite runs$/)
})

test('render: not the recommendation → no (recommended); minutes only when known', () => {
  const levers = { ...RECOMMENDED, slice: 'own+app', review: 'slice' }
  const out = render(base({ levers, cost: { ...cost({ planText: PLAN, levers, durations: {} }), minutes: 6 } }))
  assert.match(out, /\nTest plan: each slice runs its own tests, and each app's suite once its slices are done · /)
  assert.match(out, / · a review after every slice\n/)
  assert.match(out, /12 quick test runs \+ 6 suite runs \(≈ 6 min of tests\) · 13 reviews$/)
})

test('leverWords: a phrase per lever value', () => {
  const apps = ['api', 'web']
  const w = (l) => leverWords({ ...RECOMMENDED, ...l }, apps)
  assert.equal(w({}), 'each slice runs its own tests · at the end, the api and web suites once · one review at the end')
  assert.match(w({ slice: 'full' }), /^the app's suite after every slice · /)
  assert.match(w({ slice: 'none' }), /^no tests while building — a type-check only · /)
  assert.match(w({ end: 'risk' }), / · at the end, the api and web suites once, and an agent tries the risky parts · /)
  assert.match(w({ end: 'everything' }), / · at the end, everything — the deep set, the cross-app E2E and the full walk · /)
  assert.match(w({ end: 'none' }), / · nothing tested at the end — a type-check only · /)
  assert.match(w({ review: 'app' }), / · a review after each app$/)
  assert.match(w({ review: 'slice+second' }), / · two reviews after every slice$/)
  assert.match(w({ walk: 'you', models: 'economy', persist: 'low', unruled: 'park' }), / · economy models · low persistence · parks on an unruled decision · you walk it before it lands$/)
  assert.equal(leverWords(RECOMMENDED, ['api']).includes('the api suite once'), true)
})

test('costWords: no runs at all reads plainly; a zero part is left out', () => {
  assert.equal(costWords({ ownRuns: 0, suiteRuns: 0, reviews: 1, minutes: null }), 'no test runs')
  assert.equal(costWords({ ownRuns: 0, suiteRuns: 2, reviews: 1, minutes: 0 }), '2 suite runs (≈ <1 min of tests)')
  assert.equal(costWords({ ownRuns: 1, suiteRuns: 1, reviews: 2, minutes: null }), '1 quick test run + 1 suite run · 2 reviews')
})

test('render: over 30 slices, each app shows its first 3 and last 1 with … n more', () => {
  const s = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, app: i < 25 ? 'api' : 'web', phase: i < 25 ? 1 : 2, name: `Slice ${i + 1}`, tests: 1 }))
  const lines = render(base({ slices: s })).split('\n')
  assert.equal(lines[0], 'cert-tags — 40 slices in 2 apps · lands on main')
  const rows = lines.slice(2, lines.indexOf('', 2))
  assert.deepEqual(rows.map((l) => l.replace(/\s+\+1 test$/, '').trimEnd()), [
    'api  1  Slice 1', '     2  Slice 2', '     3  Slice 3', '     …  21 more', '    25  Slice 25',
    'web 26  Slice 26', '    27  Slice 27', '    28  Slice 28', '     …  11 more', '    40  Slice 40',
  ])
})

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const run = (dir, args = [], root = join(dir, '..', '..', '..')) => spawnSync(process.execPath, [SCRIPT, dir, ...args], { encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

function repo({ manifest = 'status: planned\n', config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plan-slices-'))
  const dir = join(root, 'docs', 'features', 'cert-tags')
  mkdirSync(dir, { recursive: true })
  cpSync(FIXTURE, dir, { recursive: true })
  writeFileSync(join(dir, 'MANIFEST.md'), manifest)
  if (config) {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'builder.md'), `---\nproject: t\n${config}apps:\n  - name: api\n    path: api\n---\n`)
  }
  return { root, dir }
}

test('CLI: no tests: line → the recommendation, marked (recommended)', () => {
  const { dir } = repo()
  const r = run(dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^cert-tags — 12 slices in 3 apps · lands on main\n/)
  // The fixture spec has three apps in scope — a signal that raises the end to the risky parts.
  assert.match(r.stdout, /Test plan \(recommended\): each slice runs its own tests · at the end, the api, web and mobile suites once, and an agent tries the risky parts · one review at the end/)
})

test('CLI: --tests wins over the manifest; the manifest tests: line over the recommendation', () => {
  const { dir } = repo({ manifest: 'tests: slice=none end=none review=app\n' })
  assert.match(run(dir).stdout, /Test plan: no tests while building — a type-check only · nothing tested at the end — a type-check only · a review after each app\n {2}no test runs · 4 reviews/)
  assert.match(run(dir, ['--tests', 'slice=full end=risk review=end']).stdout, /Test plan: the app's suite after every slice/)
})

test('CLI: an old profile: line maps through parseTestPlan', () => {
  const { dir } = repo({ manifest: 'profile: thorough\ngo-ahead: luke 2026-10-01\n' })
  assert.match(run(dir).stdout, /Test plan: each slice runs its own tests, and each app's suite once its slices are done · at the end, everything/)
})

test('CLI: target = manifest target:, else merge_into, else base_branch', () => {
  assert.match(run(repo({ manifest: 'target: release\n', config: 'merge_into: develop\n' }).dir).stdout, /lands on release\n/)
  assert.match(run(repo({ config: 'base_branch: trunk\nmerge_into: develop\n' }).dir).stdout, /lands on develop\n/)
  assert.match(run(repo({ config: 'base_branch: trunk\n' }).dir).stdout, /lands on trunk\n/)
})

test('CLI: minutes from the recorded fast-set durations', () => {
  const { root, dir } = repo()
  mkdirSync(join(root, '.builder', 'gates'), { recursive: true })
  const d = (ms) => ({ total: ms, commands: {}, at: 'x' })
  writeFileSync(join(root, '.builder', 'gates', 'durations.json'), JSON.stringify({ api: d(120000), web: d(120000), mobile: d(120000) }))
  assert.match(run(dir, ['--tests', 'slice=own end=touched review=end']).stdout, /12 quick test runs \+ 3 suite runs \(≈ 6 min of tests\)\n$/)
})

test('CLI: --json → { feature, target, slices, levers, recommended, cost }', () => {
  const { dir } = repo({ manifest: 'tests: slice=own end=touched review=end\n' })
  const out = JSON.parse(run(dir, ['--json']).stdout)
  assert.deepEqual(Object.keys(out), ['feature', 'target', 'slices', 'levers', 'recommended', 'cost'])
  assert.equal(out.feature, 'cert-tags')
  assert.equal(out.slices.length, 12)
  assert.equal(out.levers.end, 'touched')
  assert.equal(out.recommended.end, 'risk')
  assert.equal(out.cost.suiteRuns, 3)
})

test('CLI: no folder → usage, exit 2; no PLAN.md → says so, exit 1', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2)
  const empty = mkdtempSync(join(tmpdir(), 'plan-slices-empty-'))
  const r = run(empty)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no PLAN\.md/)
})
