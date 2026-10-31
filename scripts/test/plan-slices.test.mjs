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

test('countTests: the six-part task shape counts the it( lines in its Tests fences', () => {
  const block = [
    '### Task 1: x', 'App: api', 'Phase: 1', '',
    '**Tests:**',
    "- `rejects both assignees` — 422 (Behaviour 1)", fence("it('rejects both', () => { expect(a).toBe(422) })"),
    "- `accepts one` — 200 (Behaviour 2)", fence("it('accepts one', () => { expect(b).toBe(200) })"),
  ].join('\n')
  assert.equal(countTests(block), 2)
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
  assert.match(out, /\nTest plan \(recommended\): tests run beside the build, everything on the merged result · no agent walk · one review at the end\n/)
  assert.match(out, /\n {2}one review$/)
})

test('render: not the recommendation → no (recommended); the cost line is the reviews', () => {
  const levers = { ...RECOMMENDED, walk: 'full', review: 'slice' }
  const out = render(base({ levers, cost: cost({ planText: PLAN, levers }) }))
  assert.match(out, /\nTest plan: tests run beside the build, everything on the merged result · an agent walks all of it · /)
  assert.match(out, / · a review after every slice\n/)
  assert.match(out, /\n {2}13 reviews$/)
})

test('leverWords: a phrase per lever value', () => {
  const w = (l) => leverWords({ ...RECOMMENDED, ...l })
  assert.equal(w({}), 'tests run beside the build, everything on the merged result · no agent walk · one review at the end')
  assert.match(w({ walk: 'risk' }), / · an agent walks the risky parts · /)
  assert.match(w({ walk: 'full' }), / · an agent walks all of it · /)
  assert.match(w({ review: 'app' }), / · a review after each app$/)
  assert.match(w({ review: 'slice+second' }), / · two reviews after every slice$/)
  assert.match(w({ human: 'yes', models: 'economy', persist: 'low', unruled: 'park' }), / · economy models · low persistence · parks on an unruled decision · you walk it before it lands$/)
})

test('costWords: one review reads plainly; more are counted', () => {
  assert.equal(costWords({ reviews: 1 }), 'one review')
  assert.equal(costWords({ reviews: 13 }), '13 reviews')
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
  // The fixture spec has three apps in scope — a signal that raises the walk to the risky parts.
  assert.match(r.stdout, /Test plan \(recommended\): tests run beside the build, everything on the merged result · an agent walks the risky parts · one review at the end/)
})

test('CLI: --tests wins over the manifest; the manifest tests: line over the recommendation', () => {
  const { dir } = repo({ manifest: 'tests: walk=none review=app\n' })
  assert.match(run(dir).stdout, /Test plan: tests run beside the build, everything on the merged result · no agent walk · a review after each app\n {2}4 reviews/)
  assert.match(run(dir, ['--tests', 'walk=full review=end']).stdout, /Test plan: tests run beside the build, everything on the merged result · an agent walks all of it/)
})

test('CLI: an old profile: line maps through parseTestPlan', () => {
  const { dir } = repo({ manifest: 'profile: thorough\ngo-ahead: luke 2026-10-01\n' })
  assert.match(run(dir).stdout, /Test plan: tests run beside the build, everything on the merged result · an agent walks all of it · a review after every slice/)
})

test('CLI: target = manifest target:, else merge_into, else base_branch', () => {
  assert.match(run(repo({ manifest: 'target: release\n', config: 'merge_into: develop\n' }).dir).stdout, /lands on release\n/)
  assert.match(run(repo({ config: 'base_branch: trunk\nmerge_into: develop\n' }).dir).stdout, /lands on develop\n/)
  assert.match(run(repo({ config: 'base_branch: trunk\n' }).dir).stdout, /lands on trunk\n/)
})

test('CLI: --json → { feature, target, slices, levers, recommended, cost }', () => {
  const { dir } = repo({ manifest: 'tests: walk=none review=end\n' })
  const out = JSON.parse(run(dir, ['--json']).stdout)
  assert.deepEqual(Object.keys(out), ['feature', 'target', 'slices', 'levers', 'recommended', 'cost'])
  assert.equal(out.feature, 'cert-tags')
  assert.equal(out.slices.length, 12)
  assert.equal(out.levers.walk, 'none')
  assert.equal(out.recommended.walk, 'risk')
  assert.equal(out.cost.reviews, 1)
})

test('CLI: no folder → usage, exit 2; no PLAN.md → says so, exit 1', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2)
  const empty = mkdtempSync(join(tmpdir(), 'plan-slices-empty-'))
  const r = run(empty)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no PLAN\.md/)
})

test('--brief: the header and every task\'s head, never its steps or code', async () => {
  const { planBrief } = await import('../plan-slices.mjs')
  const plan = readFileSync(new URL('./fixtures/lean/note-tags/PLAN.md', import.meta.url), 'utf8')
  const b = planBrief(plan)
  assert.match(b, /^# note-tags — implementation plan\n/)
  assert.doesNotMatch(b, /Global Constraints/i, 'the brief carries the constraints, not the outline')
  assert.doesNotMatch(b, /No dependencies/)
  assert.match(b, /\n## Phases\n\n\| Phase \| App \| Tasks \| Goal \| Gates \|/)
  const lines = b.match(/^\d+ · \S+ · \d+ · .+ · .* · \d+ files$/gm)
  assert.equal(lines.length, 3, 'exactly one line per task')
  assert.doesNotMatch(b, /\*\*Files:\*\*|\*\*Interfaces:\*\*|### Task/)
  assert.ok(b.length <= 30000)
  assert.doesNotMatch(b, /- \[ \] \*\*Step 1/, 'no step reaches the outline')
  assert.doesNotMatch(b, /```js/, 'no code reaches the outline')
  assert.ok(b.length < plan.length / 2)
})

test('--scan: shared files, interfaces handed between tasks, Files outside the App, steps naming unlisted paths', async () => {
  const { planScan } = await import('../plan-slices.mjs')
  const plan = [
    '# p', '', '## Phases', '', '| Phase | App | Tasks | Goal | Gates |', '|---|---|---|---|---|', '| 1 | api | 1–2 | g | t |', '| 2 | web | 3 | g | t |', '',
    '### Task 1: model', 'App: api', 'Phase: 1', '', '**Files:**', '- Create: `api/model.py`', '- Test: `api/tests/test_model.py`', '', '**Interfaces:**', '- Produces:', '  - `Invoice(id: int)` — the row', '  - `total(inv) -> int`', '', '- [ ] **Step 1: test** — edit `api/tests/test_model.py` and `api/conftest.py`',
    '### Task 2: route', 'App: api', 'Phase: 1', '', '**Files:**', '- Modify: `api/model.py:3-9`', '- Create: `web/leak.ts`', '', '**Interfaces:**', '- Consumes: `Invoice(id)` from Task 1; `db.session` (existing)', '- Produces: `GET /invoices`', '', '- [ ] **Step 1: x**',
    '### Task 3: screen', 'App: web', 'Phase: 2', '', '**Files:**', '- Create: `web/Invoices.tsx`', '', '**Interfaces:**', '- Consumes: `total(inv)`, `later()`', '', '- [ ] **Step 1: x**',
    '### Task 4: late', 'App: web', 'Phase: 2', '', '**Files:**', '- Create: `web/late.ts`', '', '**Interfaces:**', '- Produces: `later()`', '', '- [ ] **Step 1: x**',
  ].join('\n')
  const out = planScan(plan, [{ name: 'api', path: 'api/' }, { name: 'web', path: './web' }])
  assert.match(out, /\| shared file \| 1, 2 \| `api\/model\.py` is in each one's Files/)
  assert.match(out, /\| interface \| 1 → 2 \| `Invoice` — the same spelling in both blocks/)
  assert.match(out, /\| interface \| 1 → 3 \| `total` — the same spelling/)
  assert.match(out, /\| interface \| 4 → 3 \| task 3 consumes `later` before task 4 produces it/)
  assert.doesNotMatch(out, /db\.session/, 'a name no task produces is existing code, not a row')
  assert.match(out, /\| app boundary \| 2 \| App: api \(api\/\) but Files lists `web\/leak\.ts`/)
  assert.match(out, /\| files ↔ steps \| 1 \| steps name `api\/conftest\.py`, not in Files/)
  assert.match(out, /rows to rule on · checked clean: none/)
})

test('--brief ends a task\'s head at its first step however the plan writes steps', async () => {
  const { planBrief } = await import('../plan-slices.mjs')
  const plan = ['# p', '', '### Task 1: a', 'App: api', '', '**Files:**', '- Create: `api/a.py`', '', '**Step 1: Write the test**', '', '```py', 'def test_a(): ...', '```',
    '### Task 2: b', 'App: api', '', '**Files:**', '- Create: `api/b.py`', '', 'Then:', '', '```py', 'SECRET_CODE = 1', '```'].join('\n')
  const b = planBrief(plan)
  assert.match(b, /^1 · api · 0 · a · — · 1 files$/m)
  assert.match(b, /^2 · api · 0 · b · — · 1 files$/m)
  assert.doesNotMatch(b, /def test_a|SECRET_CODE|\*\*Step 1/)
})

test('the six-part shape: Pattern sits after the head, adds no files↔steps row; backticked names pair across tasks', async () => {
  const { planScan, planBrief } = await import('../plan-slices.mjs')
  const fmt = readFileSync(join(HERE, '..', '..', 'skills', 'plan', 'PLAN-FORMAT.md'), 'utf8')
  const ex = /````markdown\n### Task N[\s\S]*?\n````/.exec(fmt)[0].replace(/^````markdown\n/, '').replace(/\n````$/, '')
  assert.ok(ex.indexOf('**Pattern:**') < ex.indexOf('**Tests:**'), 'the format puts Pattern above Tests')
  const task = (n, extra) => ex.replace('Task N', `Task ${n}`).replace('<name>', 'x').replace('App: <app>', 'App: api') + extra
  const plan = ['# p', '', '## Phases', '', '| Phase | App | Tasks | Goal |', '|---|---|---|---|', '| 1 | api | 1–2 | g |', '',
    task(1, '').replace('Phase: <n>', 'Phase: 1'), '', task(2, '').replace('Phase: <n>', 'Phase: 1')].join('\n')
  assert.doesNotMatch(planScan(plan), /files ↔ steps \| 1 \| steps name/)
  assert.doesNotMatch(planBrief(plan), /path\/to\/similar\.ts:40/, 'the brief ends at Behaviour, before Pattern')
  const two = [
    '### Task 1: a', 'App: api', 'Phase: 1', '', '**Files:**', '- Create: `api/a.ts` — a', '', '**Interfaces:**', '- Produces: `parseTags` — takes the raw tag string, returns the list of normalised tags', '', '- [ ] **Step 1: x**',
    '### Task 2: b', 'App: api', 'Phase: 1', '', '**Files:**', '- Create: `api/b.ts` — b', '', '**Interfaces:**', '- Consumes: `parseTags` — from Task 1', '', '- [ ] **Step 1: x**',
  ].join('\n')
  assert.match(planScan(two), /\| interface \| 1 → 2 \| `parseTags` — the same spelling/)
})

test('--brief cuts a task\'s head at **Behaviour:**, keeping a fence under Interfaces', async () => {
  const { planBrief } = await import('../plan-slices.mjs')
  const plan = ['# p', '', '### Task 1: a', 'App: api', 'Phase: 1', '', '**Files:**', '- Create: `api/a.ts` — a', '', '**Interfaces:**', '- Produces: `Wire` — the shape', '', '```ts', 'type Wire = { id: string }', '```', '', 'after the fence', '', '**Behaviour:**', '- BEHAVIOUR_RULE (D1)', '', '**Tests:**', '- TEST_LINE', '', '- [ ] **Step 1: x**'].join('\n')
  const b = planBrief(plan)
  assert.match(b, /^1 · api · 1 · a · — · 1 files$/m)
  assert.doesNotMatch(b, /type Wire|after the fence|BEHAVIOUR_RULE|TEST_LINE/)
})

test('--brief: an old plan with no step markers ends its head at the first fence, and --scan still sees its body', async () => {
  const { planBrief, planScan } = await import('../plan-slices.mjs')
  const plan = ['# p', '', '### Task 1: a', 'App: api', '', '**Files:**', '- Create: `api/a.py`', '', '**Interfaces:**', '- Produces: `thing`', '', '```py', 'def test_old(): ...  # edit api/other.py', '```', 'Edit `api/other.py` too.'].join('\n')
  const b = planBrief(plan)
  assert.match(b, /^1 · api · 0 · a · — · 1 files$/m)
  assert.doesNotMatch(b, /test_old|thing/)
  assert.match(planScan(plan), /steps name `api\/other\.py`, not in Files/)
})

test('--brief: the US spelling **Behavior:** ends the head too', async () => {
  const { planBrief } = await import('../plan-slices.mjs')
  const plan = ['# p', '', '### Task 1: a', 'App: api', '', '**Files:**', '- Create: `api/a.ts`', '', '**Interfaces:**', '- Produces: `x`', '', '**Behavior:**', '- RULE_TEXT (D1)', '', '- [ ] **Step 1: x**'].join('\n')
  assert.match(planBrief(plan), /^1 · api · 0 · a · — · 1 files$/m)
  assert.doesNotMatch(planBrief(plan), /RULE_TEXT/)
})

test('--brief: 60 tasks stay one line each and under 30,000 characters', async () => {
  const { planBrief } = await import('../plan-slices.mjs')
  const tasks = Array.from({ length: 60 }, (_, i) => `### Task ${i + 1}: ${'Long title '.repeat(6)}${i}\n\nApp: api\nPhase: 1\nRecipe: none\n\n**Files:**\n- Create: \`src/a${i}.mjs\`\n- Test: \`t/a${i}.test.mjs\`\n\n**Interfaces:**\n- Produces: \`f${i}()\`\n\n- [ ] **Step 1: do**\n`).join('\n')
  const b = planBrief(`# big\n\n## Global Constraints\n\n- keep\n\n## Phases\n\n| Phase | App |\n|---|---|\n| 1 | api |\n\n## Tasks\n\n${tasks}`)
  assert.equal(b.match(/^\d+ · \S+ · \d+ · .+ · .* · \d+ files$/gm).length, 60)
  assert.match(b, /^7 · api · 1 · .+ · none · 2 files$/m)
  assert.doesNotMatch(b, /keep/)
  assert.match(b, /## Phases/)
  assert.ok(b.length <= 30000)
})
