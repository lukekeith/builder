import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseProfile, PRESETS, FLOORS, LEVERS, profileLabel, planSize, section, recommend, estimate, parseArgs, historyPath, TEST_LEVERS, RECOMMENDED, parseTests, formatTests, planLabel, parseTestPlan, presetLevers, runtimeTestPlan, cost, rowLabel } from '../scripts/profile.mjs'

const script = fileURLToPath(new URL('../scripts/profile.mjs', import.meta.url))
const table = (name, rows) => `## ${name}\n| A | B | C | D |\n|---|---|---|---|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`
const apps = (n) => table('Apps', Array.from({ length: n }, (_, i) => [`app${i}`, '✅']))
const contract = (auth = 'signed-in user', verb = 'GET', consumer = 'web') => table('Contract', [[verb, '/items', consumer, auth]])
const plan = (n = 3) => Array.from({ length: n }, (_, i) => `### Task ${i + 1}: item\nFiles: app/a.ts\n`).join('\n')
const rec = (specText, planText = plan(), cfg = {}) => recommend({ specText, planText, cfg })
const row = (extra = {}) => ({ tests: 'slice=own end=touched review=end', size: { tasks: 2 }, lanes: { build: 120000, ship: 120000 }, tokens: { input: 300, output: 100 }, ...extra })
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'profiles-'))
  const dir = join(root, 'feature')
  mkdirSync(dir)
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'builder.md'), '---\napps:\n  - name: web\n    role: app\n---\n')
  writeFileSync(join(dir, 'SPEC.md'), apps(1))
  writeFileSync(join(dir, 'PLAN.md'), plan())
  return { root, dir }
}

test('presets retain upstream lever values and all mandatory floors', () => {
  assert.deepEqual(PRESETS.rush, { testing: 'none', review: 'final', models: 'economy', verify: 'floors', persist: 'low', unruled: 'recommend', landing: 'local' })
  assert.deepEqual(PRESETS.standard, { testing: 'risky', review: 'per-task', models: 'default', verify: 'full', persist: 'default', unruled: 'recommend', landing: 'local' })
  assert.deepEqual(PRESETS.thorough, { ...PRESETS.standard, testing: 'full', verify: 'everything' })
  assert.deepEqual(PRESETS['thorough-you'], { ...PRESETS.thorough, testing: 'full+human' })
  assert.deepEqual(FLOORS, { typecheck: true, fastGates: true, finalReview: true, releasedParity: true, projectRequirements: true })
  for (const preset of Object.keys(PRESETS)) assert.deepEqual(parseProfile(preset).floors, FLOORS)
  assert.deepEqual(LEVERS.landing, ['local'])
})

test('old manifests without a profile and explicit none preserve thorough behavior', () => {
  for (const value of [undefined, null, '', '  ', 'none']) {
    assert.deepEqual(parseProfile(value), { preset: 'thorough', levers: PRESETS.thorough, floors: FLOORS, warning: null })
  }
  assert.equal(profileLabel(undefined), '—')
  assert.equal(profileLabel('bad'), 'thorough')
  assert.equal(profileLabel('thorough-you'), 'thorough + you')
})

test('custom begins at standard, ignores invalid levers with a warning, and cannot weaken floors', () => {
  const result = parseProfile('custom testing=none review=per-task+second models=strong verify=floors persist=low unruled=park landing=local fastGates=false landing=pr junk')
  assert.equal(result.preset, 'custom')
  assert.deepEqual(result.levers, { testing: 'none', review: 'per-task+second', models: 'strong', verify: 'floors', persist: 'low', unruled: 'park', landing: 'local' })
  assert.match(result.warning, /ignored custom values fastGates=false, landing=pr, junk/)
  assert.deepEqual(result.floors, FLOORS)
  assert.deepEqual(parseProfile('custom').levers, PRESETS.standard)
  const bad = parseProfile('speedy')
  assert.equal(bad.preset, 'thorough')
  assert.match(bad.warning, /unknown profile/)
  const copy = parseProfile('rush')
  copy.levers.testing = 'changed'
  copy.floors.fastGates = false
  assert.equal(PRESETS.rush.testing, 'none')
  assert.equal(FLOORS.fastGates, true)
})

test('sections and plan size exclude neighboring sections and deduplicate phase apps', () => {
  const text = table('Phases', [['1', 'web'], ['2', 'web'], ['3', 'server']]) + '\n## Other\n' + plan(4)
  assert.deepEqual(planSize(text), { tasks: 4, phases: 3, apps: 2 })
  assert.equal(section(text, 'Absent'), '')
  assert.doesNotMatch(section(text, 'Phases'), /Task/)
})

test('the recommendation is the fast plan, or build_profile_default mapped; signals raise only end', () => {
  assert.deepEqual(rec(apps(1)), { tests: { slice: 'own', end: 'touched', review: 'end' }, signals: [], reason: 'the recommended plan' })
  assert.deepEqual(rec(apps(2), plan(), { buildProfileDefault: 'thorough' }).tests, { slice: 'own+app', end: 'everything', review: 'slice' })
  assert.deepEqual(rec(apps(2), plan(), { buildProfileDefault: 'rush' }).tests, { slice: 'own+app', end: 'touched', review: 'end', models: 'economy', persist: 'low' })
})

test('ordinary session authentication does not imply permission-sensitive work', () => {
  for (const auth of ['signed-in user', 'session', 'authenticated user', 'user token']) {
    assert.deepEqual(rec(apps(1) + contract(auth)).signals, [])
  }
  for (const auth of ['role: writer', 'roles required', 'admin only', 'permissions: write', 'owner', 'scope: edit']) {
    const r = rec(apps(1) + contract(auth))
    assert.deepEqual(r.signals, ['auth or delete'])
    assert.equal(r.tests.end, 'risk')
  }
})

test('risk signals raise end to at least risk: breaking schema, task migration, released consumer, apps, delete', () => {
  const schema = (verb) => table('Schema & API changes', [['1', verb, 'Note.tags', 'wire']])
  const cases = [
    [apps(1) + schema('EDIT'), plan(), 'breaking schema change'],
    [apps(1) + schema('RENAME'), plan(), 'breaking schema change'],
    [apps(1), '### Task 1: Migration\nFiles: db/a.sql', 'migration'],
    [apps(1), '### Task 1: Add column\n**Files:** db/migrations/a.sql', 'migration'],
    [apps(1) + contract('session', 'GET', '`desktop` / web'), plan(), 'released consumer'],
    [apps(3), plan(), '3 apps'],
    [apps(1) + contract('session', 'DELETE'), plan(), 'auth or delete'],
  ]
  for (const [spec, taskPlan, signal] of cases) {
    const value = rec(spec, taskPlan, { buildProfileDefault: 'rush', released: ['desktop'] })
    assert.equal(value.tests.end, 'risk')
    assert.ok(value.signals.includes(signal))
    assert.match(value.reason, /end raised to risk/)
  }
  assert.deepEqual(rec(apps(1) + schema('ADD')).signals, [], 'an ADD is new surface nothing relies on yet')
  assert.equal(rec(apps(1) + contract(), plan() + '\nMigration is unnecessary').tests.end, 'touched')
  assert.equal(rec(apps(3), plan(), { buildProfileDefault: 'thorough' }).tests.end, 'everything', 'a raise never lowers')
})

test('tests values parse, format and label; unknown pairs warn and fall back to the recommended plan', () => {
  assert.deepEqual(RECOMMENDED, { slice: 'own', end: 'touched', review: 'end', models: 'default', persist: 'default', unruled: 'recommend' })
  assert.deepEqual(TEST_LEVERS.walk, ['you'])
  const t = parseTests('slice=own+app end=risk review=slice+second models=strong walk=you (the owner asked) junk end=bad')
  assert.deepEqual(t.levers, { ...RECOMMENDED, slice: 'own+app', end: 'risk', review: 'slice+second', models: 'strong', walk: 'you' })
  assert.match(t.warning, /ignored tests values junk, end=bad/)
  assert.equal(formatTests(t.levers), 'slice=own+app end=risk review=slice+second models=strong walk=you')
  assert.equal(formatTests({}), 'slice=own end=touched review=end')
  assert.equal(planLabel(t.levers), 'own+app · risk · slice+second · you')
})

test('old profiles map onto the test plan; tests wins; a go-ahead without either is thorough', () => {
  assert.deepEqual(presetLevers('rush'), { ...RECOMMENDED, slice: 'own+app', end: 'touched', review: 'end', models: 'economy', persist: 'low' })
  assert.deepEqual(presetLevers('thorough-you'), { ...RECOMMENDED, slice: 'own+app', end: 'everything', review: 'slice', walk: 'you' })
  assert.equal(parseTestPlan({ tests: 'slice=none end=none review=end', profile: 'thorough' }).label, 'none · none · end')
  assert.equal(parseTestPlan({ profile: 'standard' }).label, 'own+app · risk · slice')
  assert.equal(parseTestPlan({}).label, '—')
  assert.equal(parseTestPlan({ 'go-ahead': 'luke 2026-10-26' }).label, 'own+app · everything · slice')
  assert.equal(parseTestPlan({ build: 'here', tests: 'slice=own' }).label, 'here')
  assert.deepEqual(parseTestPlan({}).floors, FLOORS)
})

test('the runtime record: start\'s profile placeholder is no choice, an approval or a build under way is', () => {
  assert.equal(runtimeTestPlan({ profile: 'thorough', phase: 'spec' }).label, '—')
  assert.equal(runtimeTestPlan({ profile: 'thorough', phase: 'building' }).label, 'own+app · everything · slice')
  assert.equal(runtimeTestPlan({ profile: 'thorough-you', profileApproved: true }).levers.walk, 'you')
  assert.equal(runtimeTestPlan({ tests: 'slice=own end=risk review=end', profile: 'rush', profileApproved: true }).label, 'own · risk · end')
})

test('cost counts suite runs and reviews, and minutes only when every app has a recorded duration', () => {
  const phases = '## Phases\n| Phase | Slice | App | Tasks | Goal | Gates |\n|---|---|---|---|---|---|\n| 1 | S01 | server | 1–2 | goal | fast |\n| 2 | S01 | web | 3 | goal | fast |\n'
  const p = phases + '\n' + plan(3)
  assert.deepEqual(planSize(p), { tasks: 3, phases: 2, apps: 2 }, 'Codex Phases put Slice before App')
  const fast = cost({ planText: p, levers: {}, durations: {} })
  assert.deepEqual(fast, { slices: 3, apps: 2, phases: 2, ownRuns: 3, suiteRuns: 2, reviews: 1, walk: 'none', minutes: null })
  const heavy = cost({ planText: p, levers: { slice: 'own+app', end: 'everything', review: 'slice' }, durations: { server: { total: 60000 }, web: { total: 120000 } } })
  assert.equal(heavy.suiteRuns, 4); assert.equal(heavy.reviews, 4); assert.equal(heavy.walk, 'full'); assert.equal(heavy.minutes, 6)
  assert.equal(cost({ planText: p, levers: { slice: 'none', end: 'none' } }).suiteRuns, 0)
})

const L = 'own · touched · end'
test('estimates require three comparable records with nonzero observed time and tokens', () => {
  assert.equal(estimate([], L, 4), null)
  assert.equal(estimate([row(), row()], L, 4), null)
  const invalid = [row({ tests: 'slice=own end=risk review=end' }), row({ size: { tasks: 0 } }), row({ lanes: { build: 0 } }), row({ tokens: { input: 0 } }), row({ lanes: { build: -5 } }), row({ tokens: { input: Infinity } }), row({ lanes: {} }), null]
  assert.equal(estimate([row(), row(), ...invalid], L, 4), null)
  assert.deepEqual(estimate([row(), row(), row(), ...invalid], L, 4), { minutes: 8, tokens: 800, n: 3 })
  // An old row's profile is compared by the plan it maps to.
  const old = { ...row(), tests: undefined, profile: 'rush' }
  assert.equal(rowLabel(old), 'own+app · touched · end')
  assert.deepEqual(estimate([old, old, old], 'own+app · touched · end', 4), { minutes: 8, tokens: 800, n: 3 })
  for (const tasks of [0, -1, Infinity, '4']) assert.equal(estimate([row(), row(), row()], L, tasks), null)
})

test('estimates scale median per-task observations and never invent cost', () => {
  const rows = [row(), row({ lanes: { build: 1200000 }, tokens: { input: 1000 } }), row()]
  assert.deepEqual(estimate(rows, L, 5), { minutes: 10, tokens: 1000, n: 3 })
  assert.deepEqual(estimate(rows.map((r) => ({ ...r, cost: 0.1 })), L, 5), { minutes: 10, tokens: 1000, n: 3, cost: 0.25 })
  assert.ok(!Object.hasOwn(estimate([row({ cost: 0.1 }), row({ cost: 0.1 }), row()], L, 5), 'cost'))
  assert.ok(!Object.hasOwn(estimate(rows.map((r) => ({ ...r, cost: '0.1' })), L, 5), 'cost'))
})

test('CLI options reject missing, duplicate, unknown, contradictory, and misplaced values', () => {
  for (const args of [[], ['--recommend'], ['--levers', '--root', '/x'], ['--recommend', '/x', '--estimate', '/x'], ['--wat', '/x'], ['--levers', '/x', '--root', '/a', '--root', '/b'], ['--recommend', '/x', '--profile', 'rush'], ['--recommend', '/x', '--tests', 'slice=own'], ['--cost', '/x', '--tests', 'a', '--profile', 'rush'], ['--levers', '/x', '--history', '/y']]) assert.throws(() => parseArgs(args))
  assert.deepEqual(parseArgs(['--cost', '/x', '--tests', 'slice=own end=risk']), { mode: '--cost', folder: '/x', tests: 'slice=own end=risk' })
  assert.deepEqual(parseArgs(['--levers=/x', '--profile=custom testing=risky', '--root', '/r']), { mode: '--levers', folder: '/x', profile: 'custom testing=risky', root: '/r' })
  assert.equal(cli('--help').status, 0)
  assert.equal(cli('--recommend').status, 2)
})

test('CLI levers: the manifest\'s tests or old profile, or an explicit one, warning safely on bad values', () => {
  const { dir } = fixture()
  let run = cli('--levers', dir)
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).label, '—')
  writeFileSync(join(dir, 'MANIFEST.md'), 'profile: rush\n')
  assert.equal(JSON.parse(cli('--levers', dir).stdout).label, 'own+app · touched · end')
  writeFileSync(join(dir, 'MANIFEST.md'), 'tests: slice=own end=risk review=end\nprofile: rush\n')
  assert.equal(JSON.parse(cli('--levers', dir).stdout).source, 'tests')
  run = cli('--levers', dir, '--tests', 'slice=nope end=risk')
  assert.equal(run.status, 0)
  assert.match(run.stderr, /ignored tests value slice=nope/)
  assert.equal(JSON.parse(run.stdout).levers.slice, 'own')
})

test('CLI cost uses the recorded gate durations', () => {
  const { root, dir } = fixture()
  writeFileSync(join(dir, 'PLAN.md'), '## Phases\n| Phase | Slice | App | Tasks | Goal | Gates |\n|---|---|---|---|---|---|\n| 1 | S01 | web | 1–3 | goal | fast |\n\n' + plan(3))
  mkdirSync(join(root, '.builder', 'gates'), { recursive: true })
  writeFileSync(join(root, '.builder', 'gates', 'durations.json'), JSON.stringify({ web: { total: 120000 } }))
  const out = JSON.parse(cli('--cost', dir, '--root', root, '--tests', 'slice=own+app end=touched review=end').stdout)
  assert.equal(out.suiteRuns, 2); assert.equal(out.minutes, 4)
})

test('CLI reports malformed or missing authoritative config rather than recommending silently', () => {
  const { root, dir } = fixture()
  let run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 0)
  assert.deepEqual(JSON.parse(run.stdout).tests, { slice: 'own', end: 'touched', review: 'end' })
  writeFileSync(join(root, '.codex', 'builder.md'), 'bad config')
  run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 2)
  assert.match(run.stderr, /frontmatter/)
  assert.equal(run.stdout, '')
  const missing = mkdtempSync(join(tmpdir(), 'profiles-missing-'))
  run = cli('--recommend', dir, '--root', missing)
  assert.equal(run.status, 2)
  assert.match(run.stderr, /No .codex\/builder.md/)
})

test('CLI warns on an invalid configured default and falls back to the recommended plan', () => {
  const { root, dir } = fixture()
  writeFileSync(join(dir, 'SPEC.md'), apps(2))
  writeFileSync(join(root, '.codex', 'builder.md'), '---\nbuild_profile_default: thorough-you\napps:\n  - name: web\n---\n')
  const run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 0)
  assert.match(run.stderr, /build_profile_default.*thorough-you.*ignoring/)
  assert.equal(JSON.parse(run.stdout).reason, 'the recommended plan')
})

test('CLI estimate reads explicit history, ignores malformed lines, and handles insufficient observations', () => {
  const { root, dir } = fixture()
  const history = join(root, 'history.jsonl')
  writeFileSync(history, [row(), row(), row()].map(JSON.stringify).join('\n') + '\nbad json\n')
  let run = cli('--estimate', dir, '--root', root, '--history', 'history.jsonl', '--tests', 'slice=own end=touched review=end')
  assert.equal(run.status, 0)
  assert.deepEqual(JSON.parse(run.stdout), { minutes: 6, tokens: 600, n: 3 })
  assert.equal(JSON.parse(cli('--estimate', dir, '--root', root).stdout), null)
  run = cli('--estimate', dir, '--root', root, '--history', 'missing.jsonl')
  assert.equal(run.status, 2)
  assert.match(run.stderr, /ENOENT/)
})

test('canonical Git-common history wins over legacy fleet records and works in linked worktrees', () => {
  const { root } = fixture()
  execFileSync('git', ['init', '-q', root])
  const canonical = join(root, '.git', 'builder-codex', 'archive.jsonl')
  const legacy = join(root, '.builder', 'fleet', 'archive.jsonl')
  mkdirSync(join(root, '.builder', 'fleet'), { recursive: true })
  writeFileSync(legacy, '')
  assert.equal(historyPath(root), legacy)
  mkdirSync(join(root, '.git', 'builder-codex'))
  writeFileSync(canonical, '')
  assert.equal(historyPath(root), canonical)
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' })
  const worktree = join(root, 'linked')
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' })
  assert.equal(realpathSync(historyPath(worktree)), realpathSync(canonical))
})
