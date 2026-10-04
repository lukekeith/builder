import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseProfile, PRESETS, FLOORS, LEVERS, profileLabel, planSize, section, recommend, estimate, parseArgs, historyPath } from '../scripts/profile.mjs'

const script = fileURLToPath(new URL('../scripts/profile.mjs', import.meta.url))
const table = (name, rows) => `## ${name}\n| A | B | C | D |\n|---|---|---|---|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`
const apps = (n) => table('Apps', Array.from({ length: n }, (_, i) => [`app${i}`, '✅']))
const contract = (auth = 'signed-in user', verb = 'GET', consumer = 'web') => table('Contract', [[verb, '/items', consumer, auth]])
const plan = (n = 3) => Array.from({ length: n }, (_, i) => `### Task ${i + 1}: item\nFiles: app/a.ts\n`).join('\n')
const rec = (specText, planText = plan(), cfg = {}) => recommend({ specText, planText, cfg })
const row = (extra = {}) => ({ profile: 'standard', size: { tasks: 2 }, lanes: { build: 120000, ship: 120000 }, tokens: { input: 300, output: 100 }, ...extra })
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
  assert.deepEqual(FLOORS, { fastGates: true, finalReview: true, releasedParity: true, projectRequirements: true })
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

test('recommendation uses rush for one small app without a contract, then configured/default standard', () => {
  assert.equal(rec(apps(1)).preset, 'rush')
  assert.equal(rec(apps(1), plan(6)).preset, 'standard')
  assert.equal(rec(apps(2), plan(), { buildProfileDefault: 'rush' }).preset, 'rush')
  assert.equal(rec(apps(2), plan(), { buildProfileDefault: 'thorough' }).preset, 'thorough')
})

test('ordinary session authentication does not imply permission-sensitive work', () => {
  for (const auth of ['signed-in user', 'session', 'authenticated user', 'user token']) {
    assert.deepEqual(rec(apps(1) + contract(auth)), { preset: 'standard', signals: [] })
  }
  for (const auth of ['role: writer', 'roles required', 'admin only', 'permissions: write', 'owner', 'scope: edit']) {
    assert.deepEqual(rec(apps(1) + contract(auth)), { preset: 'thorough', signals: ['auth or delete'] })
  }
})

test('risk signals override configured rush: schema, task migration, released consumer, apps, delete', () => {
  const cases = [
    [apps(1) + table('Schema & API changes', [['new column']]), plan(), 'schema change'],
    [apps(1), '### Task 1: Migration\nFiles: db/a.sql', 'migration'],
    [apps(1), '### Task 1: Add column\n**Files:** db/migrations/a.sql', 'migration'],
    [apps(1) + contract('session', 'GET', '`desktop` / web'), plan(), 'released consumer'],
    [apps(3), plan(), '3 apps'],
    [apps(1) + contract('session', 'DELETE'), plan(), 'auth or delete'],
  ]
  for (const [spec, taskPlan, signal] of cases) {
    const value = rec(spec, taskPlan, { buildProfileDefault: 'rush', released: ['desktop'] })
    assert.equal(value.preset, 'thorough')
    assert.ok(value.signals.includes(signal))
  }
  assert.equal(rec(apps(1) + contract(), plan() + '\nMigration is unnecessary').preset, 'standard')
})

test('estimates require three comparable records with nonzero observed time and tokens', () => {
  assert.equal(estimate([], 'standard', 4), null)
  assert.equal(estimate([row(), row()], 'standard', 4), null)
  const invalid = [row({ profile: 'rush' }), row({ size: { tasks: 0 } }), row({ lanes: { build: 0 } }), row({ tokens: { input: 0 } }), row({ lanes: { build: -5 } }), row({ tokens: { input: Infinity } }), row({ lanes: {} }), null]
  assert.equal(estimate([row(), row(), ...invalid], 'standard', 4), null)
  assert.deepEqual(estimate([row(), row(), row(), ...invalid], 'standard', 4), { minutes: 8, tokens: 800, n: 3 })
  for (const tasks of [0, -1, Infinity, '4']) assert.equal(estimate([row(), row(), row()], 'standard', tasks), null)
})

test('estimates scale median per-task observations and never invent cost', () => {
  const rows = [row(), row({ lanes: { build: 1200000 }, tokens: { input: 1000 } }), row()]
  assert.deepEqual(estimate(rows, 'standard', 5), { minutes: 10, tokens: 1000, n: 3 })
  assert.deepEqual(estimate(rows.map((r) => ({ ...r, cost: 0.1 })), 'standard', 5), { minutes: 10, tokens: 1000, n: 3, cost: 0.25 })
  assert.ok(!Object.hasOwn(estimate([row({ cost: 0.1 }), row({ cost: 0.1 }), row()], 'standard', 5), 'cost'))
  assert.ok(!Object.hasOwn(estimate(rows.map((r) => ({ ...r, cost: '0.1' })), 'standard', 5), 'cost'))
})

test('CLI options reject missing, duplicate, unknown, contradictory, and misplaced values', () => {
  for (const args of [[], ['--recommend'], ['--levers', '--root', '/x'], ['--recommend', '/x', '--estimate', '/x'], ['--wat', '/x'], ['--levers', '/x', '--root', '/a', '--root', '/b'], ['--recommend', '/x', '--profile', 'rush'], ['--levers', '/x', '--history', '/y']]) assert.throws(() => parseArgs(args))
  assert.deepEqual(parseArgs(['--levers=/x', '--profile=custom testing=risky', '--root', '/r']), { mode: '--levers', folder: '/x', profile: 'custom testing=risky', root: '/r' })
  assert.equal(cli('--help').status, 0)
  assert.equal(cli('--recommend').status, 2)
})

test('CLI resolves manifest and explicit profiles, warning safely for invalid custom values', () => {
  const { dir } = fixture()
  let run = cli('--levers', dir)
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).preset, 'thorough')
  writeFileSync(join(dir, 'MANIFEST.md'), 'profile: rush\n')
  assert.equal(JSON.parse(cli('--levers', dir).stdout).preset, 'rush')
  run = cli('--levers', dir, '--profile', 'custom testing=nope')
  assert.equal(run.status, 0)
  assert.match(run.stderr, /ignored custom value testing=nope/)
  assert.equal(JSON.parse(run.stdout).levers.testing, 'risky')
})

test('CLI reports malformed or missing authoritative config rather than recommending silently', () => {
  const { root, dir } = fixture()
  let run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 0)
  assert.equal(JSON.parse(run.stdout).preset, 'rush')
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

test('CLI warns on an invalid configured default and falls back to standard', () => {
  const { root, dir } = fixture()
  writeFileSync(join(dir, 'SPEC.md'), apps(2))
  writeFileSync(join(root, '.codex', 'builder.md'), '---\nbuild_profile_default: thorough-you\napps:\n  - name: web\n---\n')
  const run = cli('--recommend', dir, '--root', root)
  assert.equal(run.status, 0)
  assert.match(run.stderr, /build_profile_default.*thorough-you.*ignoring/)
  assert.equal(JSON.parse(run.stdout).preset, 'standard')
})

test('CLI estimate reads explicit history, ignores malformed lines, and handles insufficient observations', () => {
  const { root, dir } = fixture()
  const history = join(root, 'history.jsonl')
  writeFileSync(history, [row(), row(), row()].map(JSON.stringify).join('\n') + '\nbad json\n')
  let run = cli('--estimate', dir, '--root', root, '--history', 'history.jsonl', '--profile', 'standard')
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
