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
const row = (extra = {}) => ({ tests: 'walk=none review=end', size: { tasks: 2 }, lanes: { build: 120000, ship: 120000 }, tokens: { input: 300, output: 100 }, ...extra })
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
  assert.deepEqual(FLOORS, { finalReview: true, freshMerge: true, releasedParity: true, projectRequirements: true })
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
  const result = parseProfile('custom testing=none review=per-task+second models=strong verify=floors persist=low unruled=park landing=local freshMerge=false landing=pr junk')
  assert.equal(result.preset, 'custom')
  assert.deepEqual(result.levers, { testing: 'none', review: 'per-task+second', models: 'strong', verify: 'floors', persist: 'low', unruled: 'park', landing: 'local' })
  assert.match(result.warning, /ignored custom values freshMerge=false, landing=pr, junk/)
  assert.deepEqual(result.floors, FLOORS)
  assert.deepEqual(parseProfile('custom').levers, PRESETS.standard)
  const bad = parseProfile('speedy')
  assert.equal(bad.preset, 'thorough')
  assert.match(bad.warning, /unknown profile/)
  const copy = parseProfile('rush')
  copy.levers.testing = 'changed'
  copy.floors.freshMerge = false
  assert.equal(PRESETS.rush.testing, 'none')
  assert.equal(FLOORS.freshMerge, true)
})

test('sections and plan size exclude neighboring sections and deduplicate phase apps', () => {
  const text = table('Phases', [['1', 'web'], ['2', 'web'], ['3', 'server']]) + '\n## Other\n' + plan(4)
  assert.deepEqual(planSize(text), { tasks: 4, phases: 3, apps: 2 })
  assert.equal(section(text, 'Absent'), '')
  assert.doesNotMatch(section(text, 'Phases'), /Task/)
})

test('the recommendation is the fast plan, or build_profile_default mapped; signals raise only walk', () => {
  assert.deepEqual(rec(apps(1)), { tests: { walk: 'none', review: 'end' }, signals: [], reason: 'the recommended plan' })
  assert.deepEqual(rec(apps(2), plan(), { buildProfileDefault: 'thorough' }).tests, { walk: 'full', review: 'slice' })
  assert.deepEqual(rec(apps(2), plan(), { buildProfileDefault: 'rush' }).tests, { walk: 'none', review: 'end', models: 'economy', persist: 'low' })
})

test('ordinary session authentication does not imply permission-sensitive work', () => {
  for (const auth of ['signed-in user', 'session', 'authenticated user', 'user token']) {
    assert.deepEqual(rec(apps(1) + contract(auth)).signals, [])
  }
  for (const auth of ['role: writer', 'roles required', 'admin only', 'permissions: write', 'owner', 'scope: edit']) {
    const r = rec(apps(1) + contract(auth))
    assert.deepEqual(r.signals, ['auth or delete'])
    assert.equal(r.tests.walk, 'risk')
  }
})

test('risk signals raise walk to at least risk: breaking schema, task migration, released consumer, apps, delete', () => {
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
    assert.equal(value.tests.walk, 'risk')
    assert.ok(value.signals.includes(signal))
    assert.match(value.reason, /walk raised to risk/)
  }
  assert.deepEqual(rec(apps(1) + schema('ADD')).signals, [], 'an ADD is new surface nothing relies on yet')
  assert.equal(rec(apps(1) + contract(), plan() + '\nMigration is unnecessary').tests.walk, 'none')
  assert.equal(rec(apps(3), plan(), { buildProfileDefault: 'thorough' }).tests.walk, 'full', 'a raise never lowers')
})

test('tests values parse, format and label as walk · review; unknown pairs warn and fall back to the recommended plan', () => {
  assert.deepEqual(RECOMMENDED, { walk: 'none', review: 'end', models: 'default', persist: 'default', unruled: 'recommend' })
  assert.deepEqual(TEST_LEVERS.walk, ['none', 'risk', 'full'])
  assert.deepEqual(TEST_LEVERS.human, ['yes'])
  assert.ok(!Object.hasOwn(TEST_LEVERS, 'slice') && !Object.hasOwn(TEST_LEVERS, 'end'), 'tests are the verifier\'s, not a lever')
  const t = parseTests('walk=risk review=slice+second models=strong human=yes (the owner asked) junk walk=bad')
  assert.deepEqual(t.levers, { ...RECOMMENDED, walk: 'risk', review: 'slice+second', models: 'strong', human: 'yes' })
  assert.match(t.warning, /ignored tests values junk, walk=bad/)
  assert.equal(formatTests(t.levers), 'walk=risk review=slice+second models=strong human=yes')
  assert.equal(formatTests({}), 'walk=none review=end')
  assert.equal(planLabel(t.levers), 'risk · slice+second · you')
  assert.equal(planLabel({}), 'none · end')
})

test('a manifest written before 6.0 maps onto walk · review: slice is dropped, end picks the walk, walk=you is human=yes', () => {
  const old = parseTests('slice=own+app end=everything review=slice walk=you')
  assert.equal(old.warning, null)
  assert.deepEqual(old.levers, { ...RECOMMENDED, walk: 'full', review: 'slice', human: 'yes' })
  for (const [end, walk] of [['none', 'none'], ['touched', 'none'], ['risk', 'risk'], ['everything', 'full']]) assert.equal(parseTests(`slice=own end=${end} review=end`).levers.walk, walk, end)
  assert.equal(parseTestPlan({ tests: 'slice=own end=risk review=app' }).label, 'risk · app')
  assert.equal(formatTests(old.levers), 'walk=full review=slice human=yes')
})

test('old profiles map onto the test plan; tests wins; a go-ahead without either is thorough', () => {
  assert.deepEqual(presetLevers('rush'), { ...RECOMMENDED, walk: 'none', review: 'end', models: 'economy', persist: 'low' })
  assert.deepEqual(presetLevers('standard'), { ...RECOMMENDED, walk: 'risk', review: 'slice' })
  assert.deepEqual(presetLevers('thorough-you'), { ...RECOMMENDED, walk: 'full', review: 'slice', human: 'yes' })
  assert.equal(parseTestPlan({ tests: 'walk=none review=end', profile: 'thorough' }).label, 'none · end')
  assert.equal(parseTestPlan({ profile: 'standard' }).label, 'risk · slice')
  assert.equal(parseTestPlan({}).label, '—')
  assert.equal(parseTestPlan({ 'go-ahead': 'luke 2026-10-26' }).label, 'full · slice')
  assert.equal(parseTestPlan({ build: 'here', tests: 'walk=none' }).label, 'here')
  assert.deepEqual(parseTestPlan({}).floors, FLOORS)
})

test('the runtime record: start\'s profile placeholder is no choice, an approval or a build under way is', () => {
  assert.equal(runtimeTestPlan({ profile: 'thorough', phase: 'spec' }).label, '—')
  assert.equal(runtimeTestPlan({ profile: 'thorough', phase: 'building' }).label, 'full · slice')
  assert.equal(runtimeTestPlan({ profile: 'thorough-you', profileApproved: true }).levers.human, 'yes')
  assert.equal(runtimeTestPlan({ tests: 'walk=risk review=end', profile: 'rush', profileApproved: true }).label, 'risk · end')
  assert.equal(runtimeTestPlan({ tests: 'slice=own end=risk review=end', profileApproved: true }).label, 'risk · end', 'a record approved before 6.0 maps on read')
})

test('cost counts reviews and how much an agent walks; tests are the verifier\'s, so no suite runs', () => {
  const phases = '## Phases\n| Phase | Slice | App | Tasks | Goal |\n|---|---|---|---|---|\n| 1 | S01 | server | 1–2 | goal |\n| 2 | S01 | web | 3 | goal |\n'
  const p = phases + '\n' + plan(3)
  assert.deepEqual(planSize(p), { tasks: 3, phases: 2, apps: 2 }, 'Codex Phases put Slice before App')
  assert.deepEqual(cost({ planText: p, levers: {} }), { slices: 3, apps: 2, phases: 2, reviews: 1, walk: 'none' })
  assert.deepEqual(cost({ planText: p, levers: { walk: 'full', review: 'slice' } }), { slices: 3, apps: 2, phases: 2, reviews: 4, walk: 'full' })
  assert.equal(cost({ planText: p, levers: { review: 'app' } }).reviews, 3)
})

const L = 'none · end'
test('estimates require three comparable records with nonzero observed time and tokens', () => {
  assert.equal(estimate([], L, 4), null)
  assert.equal(estimate([row(), row()], L, 4), null)
  const invalid = [row({ tests: 'walk=risk review=end' }), row({ size: { tasks: 0 } }), row({ lanes: { build: 0 } }), row({ tokens: { input: 0 } }), row({ lanes: { build: -5 } }), row({ tokens: { input: Infinity } }), row({ lanes: {} }), null]
  assert.equal(estimate([row(), row(), ...invalid], L, 4), null)
  assert.deepEqual(estimate([row(), row(), row(), ...invalid], L, 4), { minutes: 8, tokens: 800, n: 3 })
  // An old row's profile is compared by the plan it maps to.
  const old = { ...row(), tests: undefined, profile: 'rush' }
  assert.equal(rowLabel(old), 'none · end')
  assert.deepEqual(estimate([old, old, old], 'none · end', 4), { minutes: 8, tokens: 800, n: 3 })
  // A row recorded under the 5.x test plan is compared by the plan it maps to.
  assert.equal(rowLabel({ ...row(), tests: 'slice=own end=touched review=end' }), L)
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
  for (const args of [[], ['--recommend'], ['--levers', '--root', '/x'], ['--recommend', '/x', '--estimate', '/x'], ['--wat', '/x'], ['--levers', '/x', '--root', '/a', '--root', '/b'], ['--recommend', '/x', '--profile', 'rush'], ['--recommend', '/x', '--tests', 'walk=none'], ['--cost', '/x', '--tests', 'a', '--profile', 'rush'], ['--levers', '/x', '--history', '/y']]) assert.throws(() => parseArgs(args))
  assert.deepEqual(parseArgs(['--cost', '/x', '--tests', 'walk=risk review=end']), { mode: '--cost', folder: '/x', tests: 'walk=risk review=end' })
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
  assert.equal(JSON.parse(cli('--levers', dir).stdout).label, 'none · end')
  writeFileSync(join(dir, 'MANIFEST.md'), 'tests: walk=risk review=end\nprofile: rush\n')
  assert.equal(JSON.parse(cli('--levers', dir).stdout).source, 'tests')
  run = cli('--levers', dir, '--tests', 'walk=nope review=app')
  assert.equal(run.status, 0)
  assert.match(run.stderr, /ignored tests value walk=nope/)
  assert.equal(JSON.parse(run.stdout).levers.walk, 'none')
  assert.equal(JSON.parse(run.stdout).levers.review, 'app')
})

test('CLI cost reads the plan\'s reviews and walk, never gate durations', () => {
  const { root, dir } = fixture()
  writeFileSync(join(dir, 'PLAN.md'), '## Phases\n| Phase | Slice | App | Tasks | Goal |\n|---|---|---|---|---|\n| 1 | S01 | web | 1–3 | goal |\n\n' + plan(3))
  mkdirSync(join(root, '.builder', 'gates'), { recursive: true })
  writeFileSync(join(root, '.builder', 'gates', 'durations.json'), JSON.stringify({ web: { total: 120000 } }))
  const out = JSON.parse(cli('--cost', dir, '--root', root, '--tests', 'walk=risk review=app').stdout)
  assert.deepEqual(out, { slices: 3, apps: 1, phases: 1, reviews: 2, walk: 'risk' })
})

test('CLI reports malformed or missing authoritative config rather than recommending silently', () => {
  const { root, dir } = fixture()
  let run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 0)
  assert.deepEqual(JSON.parse(run.stdout).tests, { walk: 'none', review: 'end' })
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
  let run = cli('--estimate', dir, '--root', root, '--history', 'history.jsonl', '--tests', 'walk=none review=end')
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
