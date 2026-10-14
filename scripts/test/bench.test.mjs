import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = realpathSync(join(HERE, '..', '..'))
const BENCH = join(REPO, 'scripts', 'bench.mjs')
const STUB = join(HERE, 'fixtures', 'bench', 'stub-claude.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** A root that is NOT the builder repo (so results go to .builder/bench) with a stub state dir. */
export function makeRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-')))
  mkdirSync(join(root, '.stub'))
  return root
}

export function runBench(root, args, scenario = {}, env = {}) {
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const r = spawnSync('node', [BENCH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, BENCH_CLAUDE: STUB, BENCH_TMP: join(root, 'tmp'), BENCH_GSD_INSTALL: 'true', BENCH_FLEET: join(HERE, 'fixtures', 'bench', 'stub-fleet.mjs'), STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), BENCH_RUN_TIMEOUT_MS: '20000', BENCH_IDLE_TIMEOUT_MS: '20000', ...env },
  })
  const calls = existsSync(join(root, '.stub/calls.log')) ? readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n') : []
  return { ...r, calls }
}

test('resultsDir: bench/results inside the builder repo, .builder/bench elsewhere', async () => {
  const { resultsDir } = await import('../bench.mjs')
  assert.equal(resultsDir(REPO), join(REPO, 'bench', 'results'))
  const root = makeRoot()
  assert.equal(resultsDir(root), join(root, '.builder', 'bench'))
})

test('prepareCopy: a git repo on main with the fixture committed, settings written, claude_args filled, REQUEST.md excluded', async () => {
  const { prepareCopy } = await import('../bench.mjs')
  const root = makeRoot()
  const { copy } = prepareCopy({ fixture: join(REPO, 'bench', 'fixture'), dest: join(root, 'c1'), claudeArgs: '--permission-mode bypassPermissions --plugin-dir /p --settings /s' })
  assert.equal(copy, join(root, 'c1'))
  assert.equal(git(copy, 'branch', '--show-current'), 'main')
  assert.equal(git(copy, 'log', '--format=%s'), 'fixture')
  assert.equal(git(copy, 'status', '--porcelain'), '')
  const settings = JSON.parse(readFileSync(join(copy, '.claude', 'bench-settings.json'), 'utf8'))
  assert.deepEqual(settings.enabledPlugins, { 'builder@claude-builder': false, 'superpowers@claude-plugins-official': false })
  assert.match(readFileSync(join(copy, '.claude', 'builder.md'), 'utf8'), /claude_args: --permission-mode bypassPermissions --plugin-dir \/p --settings \/s/)
  assert.match(readFileSync(join(copy, '.git', 'info', 'exclude'), 'utf8'), /^REQUEST\.md$/m)
  writeFileSync(join(copy, 'REQUEST.md'), 'x')
  assert.equal(git(copy, 'status', '--porcelain'), '')
})

test('prepareCopy refuses a destination with a space in it', async () => {
  const { prepareCopy } = await import('../bench.mjs')
  const root = makeRoot()
  assert.throws(() => prepareCopy({ fixture: join(REPO, 'bench', 'fixture'), dest: join(root, 'has space'), claudeArgs: '' }), /no spaces/)
})

test('runSession streams to the file, passes the flags, and sessionRecord reads it back', async () => {
  const { runSession, sessionRecord } = await import('../bench.mjs')
  const root = makeRoot()
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ hello: { skills: ['superpowers:brainstorming', 'superpowers:writing-plans'] } }))
  const out = join(root, 'session-01-sp.jsonl')
  const r = await runSession({ copy: root, name: 'sp', prompt: 'hello world', outFile: out, claudeArgs: ['--plugin-dir', '/p'], systemPrompt: 'OWNER', model: 'm1', runTimeoutMs: 20000, idleTimeoutMs: 20000, claude: STUB, env: { STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') } })
  assert.equal(r.exit, 0)
  const calls = readFileSync(join(root, '.stub/calls.log'), 'utf8')
  assert.match(calls, /hello world \| .*--output-format.*--plugin-dir.*--append-system-prompt.*--model/)
  const s = sessionRecord({ name: 'sp', lane: null, prompt: 'hello world', file: out })
  assert.deepEqual(s.steps.map((x) => x.name), ['(prompt)', 'superpowers:brainstorming', 'superpowers:writing-plans'])
  assert.equal(s.totals.ended, 'result')
  assert.equal(s.sessionId, 'stub')
})

test('runSession kills a hung session on the idle timeout and reports exit null', async () => {
  const { runSession, sessionRecord } = await import('../bench.mjs')
  const root = makeRoot()
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ hang: { skills: ['a'], hang: true } }))
  const out = join(root, 'session-01-h.jsonl')
  const r = await runSession({ copy: root, name: 'h', prompt: 'hang', outFile: out, claudeArgs: [], systemPrompt: '', model: null, runTimeoutMs: 20000, idleTimeoutMs: 500, claude: STUB, env: { STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') } })
  assert.equal(r.exit, null)
  assert.equal(sessionRecord({ name: 'h', lane: null, prompt: 'hang', file: out }).totals.ended, 'cut')
})

test('--dry-run prepares one copy, prints the sessions per config with their prompts, and runs nothing', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /builder-rush: 3 sessions/)
  assert.match(r.stdout, /\/builder:brainstorm --auto/)
  assert.match(r.stdout, /choose \*\*rush\*\*/)
  assert.match(r.stdout, /superpowers: 1 session/)
  assert.match(r.stdout, /gsd: 4 sessions/)
  assert.match(r.stdout, /\/gsd-new-project --auto @REQUEST\.md/)
  assert.match(r.stdout, /--plugin-dir/)
  assert.deepEqual(r.calls.filter((c) => !c.startsWith('plugin')), [])
})

test('run refuses an unknown feature and an unknown --only config', () => {
  const root = makeRoot()
  assert.match(runBench(root, ['run', 'nope', '--dry-run']).stderr, /no feature 'nope'/)
  assert.match(runBench(root, ['run', 'tags', '--only', 'x', '--dry-run']).stderr, /unknown config 'x'/)
})
