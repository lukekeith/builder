import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs'
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

test('runSession kills what a session left running in its process group after a normal exit', async () => {
  const { runSession } = await import('../bench.mjs')
  const root = makeRoot()
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ orphan: { orphan: true } }))
  const r = await runSession({ copy: root, name: 'o', prompt: 'orphan', outFile: join(root, 'session-01-o.jsonl'), claudeArgs: [], systemPrompt: '', model: null, runTimeoutMs: 20000, idleTimeoutMs: 20000, claude: STUB, env: { STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') } })
  assert.equal(r.exit, 0)
  const pid = Number(readFileSync(join(root, '.stub/orphan.pid'), 'utf8'))
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    try {
      process.kill(pid, 0)
      await new Promise((res) => setTimeout(res, 50))
    } catch {
      gone = true
    }
  }
  assert.ok(gone, 'the grandchild is still running')
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
  assert.equal(r.calls.length, 3, 'one probe per pipeline')
  assert.ok(r.calls.every((c) => c.startsWith('reply with the single word ok')), 'only the probes')
  assert.match(r.stdout, /plugins a builder session loads:\n\s+stub-plugin 0\.0\.0/)
  assert.match(r.stdout, /plugins a gsd session loads:/)
})

test('run refuses an unknown feature and an unknown --only config', () => {
  const root = makeRoot()
  assert.match(runBench(root, ['run', 'nope', '--dry-run']).stderr, /no feature 'nope'/)
  assert.match(runBench(root, ['run', 'tags', '--only', 'x', '--dry-run']).stderr, /unknown config 'x'/)
})

const SP = { skills: ['superpowers:brainstorming', 'superpowers:writing-plans', 'superpowers:subagent-driven-development'], files: { 'src/tags.mjs': 'export const x = 1\n' }, commit: 'feat: tags' }

test('run: superpowers only — one session, scored, runs.json and REPORT.md written under .builder/bench', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.equal(data.feature, 'tags')
  assert.equal(data.runs.length, 1)
  const run = data.runs[0]
  assert.equal(run.config, 'superpowers')
  assert.equal(run.status, 'done')
  assert.deepEqual(run.sessions.map((s) => s.name), ['superpowers'])
  assert.deepEqual(run.sessions[0].steps.map((s) => s.name), ['(prompt)', ...SP.skills])
  assert.equal(run.score.fixture.total, 4)
  assert.equal(run.score.fixture.passed, 4)
  assert.ok(run.score.accept.total >= 7)
  assert.ok(run.score.accept.failed >= 5)
  assert.ok(run.gitLog.some((l) => /feat: tags/.test(l)))
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /\| superpowers \| done \|/)
  assert.match(r.calls[0], /--append-system-prompt/)
  assert.ok(existsSync(join(root, 'tmp', id, 'superpowers', 'REQUEST.md')))
})

test('run: builder — brainstorm, spec, then the fleet; its logs become sessions; the profile is in the owner prompt', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.status, 'done')
  assert.equal(run.path, 'pipeline')
  assert.deepEqual(run.sessions.map((s) => s.name), ['brainstorm', 'spec', 'fleet 01'])
  assert.equal(run.sessions[2].lane, 'walk') // from the fleet's timing record, not the step names
  assert.deepEqual(run.sessions[2].steps.map((s) => s.name), ['(prompt)', 'builder:audit', 'builder:plan', 'builder:build'])
  assert.deepEqual(run.sessions[2].steps[1].toolCalls, { Skill: 1, Edit: 1 })
  assert.equal(run.totals.turns, 1 + 1 + 3)
  assert.match(r.calls[0], /\/builder:brainstorm --auto/)
  assert.ok(r.calls.length === 2, `expected 2 claude calls, got ${r.calls.length}`)
})

test('run: builder config with no manifest after spec is in-chat — the fleet is not run', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'], files: { 'src/tags.mjs': 'x' }, commit: 'feat: tags in chat' }, '/builder:spec': { skills: [] } })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.path, 'in-chat')
  assert.equal(run.status, 'done')
  assert.deepEqual(run.sessions.map((s) => s.name), ['brainstorm'])
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /built in chat/)
})

test('run: a parked fleet feature ends the config as parked with the reason', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } }, { STUB_FLEET_PARK: '1' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.match(run.status, /^parked: spec leaves the tag format open/)
})

test('run: a failing gsd install marks the row not run and the other configs still run', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'gsd,superpowers'], { '/superpowers:brainstorming': SP }, { BENCH_GSD_INSTALL: 'sh -c "echo no network >&2; exit 1"' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.deepEqual(data.runs.map((x) => x.config), ['superpowers', 'gsd']) // the matrix's order, whatever --only says
  assert.equal(data.runs[0].status, 'done')
  assert.match(data.runs[1].status, /^not run: gsd install failed: no network/)
})

test('run: gsd — four sessions in order, REQUEST.md in the copy, the version recorded', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'gsd'], { '/gsd-new-project': { skills: [] }, '/gsd-plan-phase': { skills: [] }, '/gsd-execute-phase': { files: { 'src/tags.mjs': 'x' }, commit: 'tags' }, '/gsd-verify-work': { skills: [] } }, { BENCH_GSD_INSTALL: 'echo "gsd-core 1.7.0 installed"' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['/gsd-new-project', '/gsd-plan-phase', '/gsd-execute-phase', '/gsd-verify-work'])
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.equal(data.versions.gsd, '1.7.0')
  assert.equal(data.runs[0].sessions[1].steps[0].name, '/gsd-plan-phase 1')
})

test('run: a timed-out session ends the config as timed out; runs.json is still written', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': { skills: ['a'], hang: true } }, { BENCH_IDLE_TIMEOUT_MS: '500' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.status, 'timed out')
  assert.equal(run.sessions[0].totals.ended, 'cut')
})

test('run: --repeat 2 gives two reps and the report says median of 2', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers', '--repeat', '2'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.deepEqual(data.runs.map((x) => x.rep), [1, 2])
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /median of 2 reps/)
})

test('run: --model reaches every session, the fleet\'s included', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush', '--model', 'm1'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } })
  assert.equal(r.status, 0, r.stderr)
  const id = readdirSync(join(root, '.builder', 'bench')).find((n) => n.endsWith('-tags'))
  const cfg = readFileSync(join(root, 'tmp', id, 'builder-rush', '.claude', 'builder.md'), 'utf8')
  const line = cfg.split('\n').find((l) => /claude_args/.test(l))
  assert.equal(line.split('--model m1').length - 1, 1, line)
  assert.match(r.calls[0], /--model/)
})

test('run: a fleet script that cannot start is a failed row', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } }, { BENCH_FLEET: '/nonexistent/fleet.mjs' })
  assert.equal(r.status, 0, r.stderr)
  const id = readdirSync(join(root, '.builder', 'bench')).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(root, '.builder', 'bench', id, 'runs.json'), 'utf8')).runs[0]
  assert.match(run.status, /^failed: fleet (could not start|exit)/)
})

test('run: a config that throws is recorded as crashed and the next config still runs', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers,gsd'], {}, { BENCH_TMP: join(root, 'has space') })
  assert.equal(r.status, 0, r.stderr)
  const id = readdirSync(join(root, '.builder', 'bench')).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(root, '.builder', 'bench', id, 'runs.json'), 'utf8'))
  assert.equal(data.runs.length, 2)
  for (const x of data.runs) assert.match(x.status, /^crashed: .*no spaces/)
})

test('status: nothing has run', () => {
  const root = makeRoot()
  const r = runBench(root, ['status'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /no benchmark has run/)
})

test('status after a run shows the table and not running; report rebuilds REPORT.md', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  const s = runBench(root, ['status'])
  assert.match(s.stdout, /\| superpowers \| done \|/)
  assert.match(s.stdout, /not running/)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  writeFileSync(join(dir, id, 'REPORT.md'), 'stale')
  const rp = runBench(root, ['report', id])
  assert.equal(rp.status, 0, rp.stderr)
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /^# benchmark/)
  assert.match(rp.stdout, /\| superpowers \| done \|/)
})

test('status with a dead lock says the run stopped; a second run refuses while a live lock is held', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 999999, runId: id }))
  writeFileSync(join(dir, id, 'progress.json'), JSON.stringify({ config: 'gsd', rep: 1, session: 'plan-phase', startedAt: Date.now() }))
  assert.match(runBench(root, ['status']).stdout, /⚠ benchmark stopped mid-run \(config gsd\)/)
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.pid, runId: id }))
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /a benchmark is running \(pid/)
  assert.match(runBench(root, ['status']).stdout, /running: gsd \(session plan-phase/)
})

test('--detach starts the run in its own process and returns at once', async () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers', '--detach'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /bench started detached \(pid \d+\)/)
  const dir = join(root, '.builder', 'bench')
  for (let i = 0; i < 100 && !readdirSync(dir).some((n) => n.endsWith('-tags') && existsSync(join(dir, n, 'runs.json')) && JSON.parse(readFileSync(join(dir, n, 'runs.json'), 'utf8')).runs.length); i++) await new Promise((res) => setTimeout(res, 200))
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  assert.equal(JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0].status, 'done')
  assert.ok(existsSync(join(dir, 'bench.out')))
})

test('clean removes the copies', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.ok(existsSync(join(root, 'tmp')))
  const r = runBench(root, ['clean'])
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(root, 'tmp')))
})

test('the lock names the detached child while it runs and is gone when it ends', async () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers', '--detach'], { '/superpowers:brainstorming': { skills: ['a'], hang: true } }, { BENCH_IDLE_TIMEOUT_MS: '1500' })
  assert.equal(r.status, 0, r.stderr)
  const pid = Number(/bench started detached \(pid (\d+)\)/.exec(r.stdout)[1])
  const dir = join(root, '.builder', 'bench')
  const lock = JSON.parse(readFileSync(join(dir, 'lock'), 'utf8'))
  assert.equal(lock.pid, pid)
  assert.match(lock.runId, /-tags$/)
  const rows = () => {
    try {
      return JSON.parse(readFileSync(join(dir, lock.runId, 'runs.json'), 'utf8')).runs.length
    } catch {
      return 0
    }
  }
  for (let i = 0; i < 100 && !rows(); i++) await new Promise((res) => setTimeout(res, 200))
  assert.equal(rows(), 1)
  for (let i = 0; i < 25 && existsSync(join(dir, 'lock')); i++) await new Promise((res) => setTimeout(res, 200))
  assert.ok(!existsSync(join(dir, 'lock')))
})

test('report refuses a run id that is not a plain directory name', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  for (const id of ['../x', '.hidden']) {
    const r = runBench(root, ['report', id])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /plain directory name/)
  }
})
