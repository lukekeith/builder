import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = realpathSync(join(HERE, '..', '..'))
const SUITE = join(REPO, 'scripts', 'bench-suite.mjs')
const STUB = join(HERE, 'fixtures', 'bench', 'stub-case.mjs')
const put = (f, s) => {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) {
  const t0 = Date.now()
  for (;;) {
    try {
      if (fn()) return
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${fn}`)
    await sleep(25)
  }
}

/** A builder checkout in tmp: a git repo on main with one commit. */
function builderRepo(tmp) {
  const repo = join(tmp, 'builder')
  mkdirSync(repo)
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'b\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, git, sha: git('rev-parse', 'HEAD').trim() }
}

/**
 * A tmp BENCH_LOCAL with c1, c2 (project projA: 30m, 10m) and c3 (projB: 20m), a tmp BENCH_SUITE_OUT, the stub as the
 * case runner, and a tmp builder repo that plan and run get as --builder unless a test names one; the suite runs on its
 * pinned worktree, $TMPDIR/bench-builder-<sha12>.
 */
function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bench-suite-')))
  const builder = builderRepo(tmp)
  const pinned = join(tmp, `bench-builder-${builder.sha.slice(0, 12)}`)
  const local = join(tmp, 'local')
  const out = join(tmp, 'out')
  const state = join(tmp, 'state')
  mkdirSync(state)
  const writeCase = (id, o = {}) => put(join(local, 'cases', `${id}.json`), { id, size: 'sm', kind: 'archived', project: 'projA', feature: id, covers: 'x', estimate: { minutes: 10, usd: 1 }, ...o })
  writeCase('c1', { size: 'md', estimate: { minutes: 30, usd: 2 } })
  writeCase('c2', { estimate: { minutes: 10, usd: 1 } })
  writeCase('c3', { project: 'projB', estimate: { minutes: 20, usd: 1.5 } })
  put(join(local, 'projects', 'projA.json'), {})
  put(join(local, 'projects', 'projB.json'), {})
  put(join(local, 'projects', 'unsafe.json'), { db_prefix: 'bench_', builderMd: '---\nverify:\n  db: DATABASE_URL=postgres://localhost/prod_db npm test\nagent_walk:\n  claude_args: --x\n---\n' })
  const suite = (args, env = {}) => {
    const withBuilder = ['plan', 'run'].includes(args[0]) && !args.includes('--builder') && !args.includes('--resume') ? [...args, '--builder', builder.repo] : args
    return spawnSync('node', [SUITE, ...withBuilder], { cwd: tmp, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, BENCH_LOCAL: local, BENCH_SUITE_OUT: out, BENCH_CASE: STUB, STUB_STATE: state, STUB_CASE_MS: '20', ...env } })
  }
  const readLog = () => {
    const f = join(state, 'case.log')
    const lines = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []
    const of = (kind, id) => lines.filter((l) => l[0] === kind && l[1] === id)
    return {
      lines,
      start: (id) => Number(of('start', id)[0]?.[3]),
      end: (id) => Number(of('end', id)[0]?.[2]),
      ended: (id) => of('end', id).length > 0,
      starts: (id) => of('start', id).length,
      ends: (id) => of('end', id).length,
      builders: (id) => of('builder', id).map((l) => l[2]),
      timeouts: (id) => of('timeout', id).map((l) => l[2]),
      cloneRoots: (id) => of('clone-root', id).map((l) => l[2]),
    }
  }
  const results = join(local, 'results')
  const suiteJson = () => {
    const id = readdirSync(results).filter((n) => existsSync(join(results, n, 'suite.json'))).sort().at(-1)
    return JSON.parse(readFileSync(join(results, id, 'suite.json'), 'utf8'))
  }
  const dateDir = () => `${suiteJson().id.slice(0, 10)}-suite`
  const settled = () => until(() => !existsSync(join(results, 'lock')))
  return { tmp, builder, pinned, local, out, state, writeCase, suite, readLog, suiteJson, dateDir, results, settled }
}

test('list shows fixtures and local cases with size and estimate', () => {
  const { suite } = setup()
  const r = suite(['list'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^sm · tags — one app, one feature · /m)
  assert.match(r.stdout, /^xs · edit — one small command, built in the chat · /m)
  assert.match(r.stdout, /^md · c1 — x · ~30m · ~\$2$/m)
  const lines = r.stdout.trim().split('\n')
  assert.ok(lines.findIndex((l) => l.startsWith('xs ')) < lines.findIndex((l) => l.startsWith('sm ')))
  assert.ok(lines.indexOf(lines.find((l) => l.includes(' c2 '))) < lines.indexOf(lines.find((l) => l.includes(' c3 '))))
  const json = JSON.parse(suite(['list', '--json']).stdout)
  assert.deepEqual(json.find((c) => c.id === 'tags').project, 'fixtures')
  assert.deepEqual(json.find((c) => c.id === 'c3').estimate, { minutes: 20, usd: 1.5 })
})

test('a case with an unknown size is listed and skipped, never run', () => {
  const { suite, writeCase } = setup()
  writeCase('odd', { size: 'huge' })
  assert.match(suite(['list']).stdout, /odd — x · unknown size/)
  const r = suite(['plan', '--all', '--lanes', '2'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /skipped: .*odd — unknown size/)
  assert.doesNotMatch(r.stdout, /lane \d:.* odd /)
})

test('plan: --budget fits, refuses an unsafe case, recommends controls', () => {
  const { suite, writeCase } = setup()
  const p = suite(['plan', '--budget', '2h', '--lanes', '2'])
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /lane 1:.*\n.*ends ~\d\d:\d\d · ~\$/)
  assert.match(p.stdout, /controls recommended.*c2.*c1/)
  assert.doesNotMatch(suite(['plan', 'c1', '--control', 'c1']).stdout, /controls recommended/)
  writeCase('bad', { project: 'unsafe' })
  const r = suite(['plan', 'bad'])
  assert.equal(r.status, 2)
  assert.match(r.stdout + r.stderr, /not a bench database/)
})

test('plan and run refuse a bad --lanes, an unknown case and a control outside the selection', () => {
  const { suite, local } = setup()
  for (const lanes of ['0', 'x', '1.5']) {
    const r = suite(['plan', 'c1', '--lanes', lanes])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--lanes must be a whole number of 1 or more/)
  }
  assert.match(suite(['plan', 'nope']).stderr, /no case 'nope'/)
  assert.match(suite(['plan', 'c1', '--control', 'c2']).stderr, /control c2 is not in the selection/)
  assert.equal(suite(['run', 'c1', '--lanes', '0', '--detach']).status, 2)
  assert.equal(existsSync(join(local, 'results')), false)
})

test('run refuses before it launches anything when a dry run refuses', () => {
  const { suite, writeCase, readLog, local } = setup()
  writeCase('bad', { project: 'unsafe' })
  const r = suite(['run', 'c1,bad', '--detach'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /not a bench database/)
  assert.equal(readLog().lines.length, 0)
  assert.equal(existsSync(join(local, 'results')), false)
})

test('run: two lanes, never two of one project at once, report at the end with no project names', async () => {
  // c1, c2 project A (30m, 10m); c3 project B (20m); STUB_CASE_MS=20 → 1 estimated minute = 20 ms
  const { suite, tmp, readLog, out, dateDir, suiteJson, results, settled } = setup()
  const r = suite(['run', 'c1,c2,c3', '--lanes', '2', '--detach'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^suite started detached \(pid \d+\) — \S+-suite · \/builder:benchmark --status$/m)
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
  const log = readLog()
  assert.ok(log.end('c1') <= log.start('c2')) // same project, serialized
  assert.ok(log.start('c3') < log.end('c1')) // other project, in parallel
  const committed = readFileSync(join(out, dateDir(), 'REPORT.md'), 'utf8')
  assert.doesNotMatch(committed, /projA|projB/)
  assert.match(committed, /\| c1 \| md \| done \|/)
  const s = suiteJson()
  assert.deepEqual(s.items.map((i) => [i.id, i.lane, i.status]), [['c1', 1, 'done'], ['c2', 1, 'done'], ['c3', 2, 'done']])
  assert.ok(s.items.every((i) => i.startedAt > 0 && i.endedAt >= i.startedAt && i.out === join(results, s.id, i.id)))
  assert.match(readFileSync(join(results, s.id, 'REPORT.md'), 'utf8'), /\| c1 \| md \| projA \| done \|/)
  const st = suite(['status']).stdout
  assert.match(st, /lane 1: done c1 · done c2/)
  assert.doesNotMatch(st, /⚠/)
  // each case's fleet timeout: 3× its estimate, at least an hour
  assert.deepEqual([log.timeouts('c1'), log.timeouts('c2')], [[String(90 * 60000)], [String(60 * 60000)]])
  // each clone under $TMPDIR/bench-suite/<suite>/<item>, outside every repo; result.json stays under results
  assert.deepEqual(log.cloneRoots('c1'), [join(tmp, 'bench-suite', s.id, 'c1')])
})

test('the project mutex holds when a case runs long', async () => {
  // packed: lane 1 c3 (B, 4m) then c2 (A, 1m) at 4m; lane 2 c1 (A, 3m) then c4 (C, 2m). c1 runs 10× its estimate,
  // so lane 1 reaches c2 while c1 still runs — only the mutex keeps them apart
  const { suite, writeCase, readLog, out, dateDir, suiteJson, settled } = setup()
  writeCase('c1', { estimate: { minutes: 3, usd: 1 } })
  writeCase('c2', { estimate: { minutes: 1, usd: 1 } })
  writeCase('c3', { project: 'projB', estimate: { minutes: 4, usd: 1 } })
  writeCase('c4', { project: 'projC', estimate: { minutes: 2, usd: 1 } })
  const r = suite(['run', 'c1,c2,c3,c4', '--lanes', '2', '--detach'], { STUB_CASE_LONG: 'c1' })
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
  assert.deepEqual(suiteJson().items.map((i) => [i.id, i.lane]), [['c3', 1], ['c2', 1], ['c1', 2], ['c4', 2]])
  const log = readLog()
  assert.ok(log.end('c3') < log.end('c1')) // lane 1 was free for c2 before c1 ended
  assert.ok(log.end('c1') <= log.start('c2'))
})

test('a case process that dies leaves its item failed and the suite goes on', async () => {
  const { suite, out, dateDir, suiteJson, results, settled } = setup()
  suite(['run', 'c1,c3', '--lanes', '1', '--detach'], { STUB_CASE_DIE: 'c1' })
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
  assert.deepEqual(suiteJson().items.map((i) => [i.id, i.status]), [['c1', 'failed: case process died'], ['c3', 'done']])
  assert.match(readFileSync(join(out, dateDir(), 'REPORT.md'), 'utf8'), /\| c1 \| md \| failed \|/)
  assert.match(readFileSync(join(results, suiteJson().id, 'REPORT.md'), 'utf8'), /\| c1 \| md \| projA \| failed: case process died \|/)
})

test('status after the suite process dies; --resume runs only the rest', async () => {
  const { suite, readLog, out, dateDir, suiteJson, results, settled } = setup()
  suite(['run', 'c1,c2,c3', '--lanes', '1', '--detach'])
  // packed c1 (30m), c3 (20m), c2 (10m) on one lane; kill once c3 is recorded done
  await until(() => suiteJson().items.find((i) => i.id === 'c3').status === 'done')
  const { pid, id } = suiteJson()
  process.kill(-pid, 'SIGKILL')
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
  const st = suite(['status']).stdout
  assert.match(st, /⚠ suite stopped mid-run — 1 unfinished; \/builder:benchmark --resume \S+ runs them/)
  assert.match(st, /lane 1: .*done c1 · done c3/)
  const r = suite(['run', '--resume', id, '--detach'])
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
  const log = readLog()
  assert.equal(log.starts('c1'), 1)
  assert.equal(log.starts('c3'), 1)
  assert.equal(log.ends('c2'), 1) // c2 may have started before the kill; it finishes exactly once
  const c2 = suiteJson().items.find((i) => i.id === 'c2')
  assert.equal(c2.status, 'done')
  if (log.starts('c2') === 2) assert.equal(c2.out, join(results, id, 'c2-2'))
  assert.match(suite(['status']).stdout, /lane 1: done c1 · done c3 · done c2/)
})

test('a control runs the same case on a main checkout, serialized with it, as <id>@main', async () => {
  const { suite, tmp, pinned, readLog, local, results, suiteJson, settled } = setup()
  const main = join(tmp, 'bench-builder-main')
  mkdirSync(main)
  const r = suite(['run', 'c2', '--control', 'c2', '--lanes', '2', '--detach'])
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const s = suiteJson()
  assert.deepEqual(s.items.map((i) => i.id).sort(), ['c2', 'c2@main'])
  const log = readLog()
  assert.deepEqual(log.builders('c2').sort(), [pinned, main].sort())
  const t = log.lines.filter((l) => l[1] === 'c2' && ['start', 'end'].includes(l[0])).map((l) => l[0])
  assert.deepEqual(t, ['start', 'end', 'start', 'end'])
  const ctl = JSON.parse(readFileSync(join(results, s.id, 'c2@main', 'result.json'), 'utf8'))
  assert.equal(ctl.id, 'c2@main')
  assert.equal(ctl.control, true)
  assert.match(readFileSync(join(results, s.id, 'REPORT.md'), 'utf8'), /\| c2@main \|/)
  assert.ok(existsSync(join(local, 'results', s.id, 'c2', 'result.json')))
})

test('a fixture case runs bench.mjs in the pinned checkout and measures its newest runs.json against the one before', async () => {
  const { suite, builder, pinned, results, suiteJson, readLog, settled } = setup()
  put(join(builder.repo, 'bench', 'results', '2000-01-01-0000-edit', 'runs.json'), { feature: 'edit', runs: [{ config: 'builder', status: 'done', ms: 600000, sessions: [] }] })
  builder.git('add', '-A')
  builder.git('commit', '-qm', 'an earlier run')
  const r = suite(['run', 'edit', '--detach'], { BENCH_FIXTURE_RUNNER: STUB })
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const sha12 = builder.git('rev-parse', 'HEAD').trim().slice(0, 12)
  assert.deepEqual(readLog().builders('edit'), [pinned.replace(/[0-9a-f]{12}$/, sha12)])
  // the run is copied back beside the builder's own results, where the next estimate reads it
  assert.ok(existsSync(join(builder.repo, 'bench', 'results', '9999-12-31-2359-edit', 'runs.json')))
  const res = JSON.parse(readFileSync(join(results, suiteJson().id, 'edit', 'result.json'), 'utf8'))
  assert.deepEqual({ id: res.id, size: res.size, kind: res.kind, project: res.project, control: res.control, status: res.status }, { id: 'edit', size: 'xs', kind: 'fixture', project: 'fixtures', control: false, status: 'done' })
  assert.equal(res.measure.wallMs, 180000)
  assert.equal(res.baseline.wallMs, 600000)
})

test('a second run waits for nothing: it refuses while a suite holds the lock', async () => {
  const { suite, out, dateDir, settled } = setup()
  suite(['run', 'c1', '--detach'], { STUB_CASE_MS: '100' })
  const r = suite(['run', 'c3', '--detach'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /a suite is running \(pid \d+, \S+\) — \/builder:benchmark --status/)
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
})

test('run without --detach is refused — a suite outlives this session', () => {
  const { suite, readLog, local } = setup()
  for (const args of [['run', 'c1'], ['run', '--resume', 'x']]) {
    const r = suite(args)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /run needs --detach — a suite outlives this session/)
  }
  assert.equal(readLog().lines.length, 0)
  assert.equal(existsSync(join(local, 'results')), false)
})

test('a throw inside one item fails that item; its lane goes on and the reports are still written', async () => {
  const { suite, out, dateDir, suiteJson, results, settled } = setup()
  // lane 1: c1 (30m) then c2; lane 2: c3. c2's out path becomes a dangling symlink while c1 runs, so its folder can't be made
  const r = suite(['run', 'c1,c2,c3', '--lanes', '2', '--detach'])
  assert.equal(r.status, 0, r.stderr)
  symlinkSync('/nonexistent/bench-suite-out', join(results, suiteJson().id, 'c2'))
  await until(() => existsSync(join(out, dateDir(), 'REPORT.md')))
  await settled()
  const by = Object.fromEntries(suiteJson().items.map((i) => [i.id, i.status]))
  assert.equal(by.c1, 'done')
  assert.equal(by.c3, 'done')
  assert.match(by.c2, /^failed: .*ENOENT/)
  assert.match(readFileSync(join(out, dateDir(), 'REPORT.md'), 'utf8'), /\| c2 \| sm \| failed \|/)
  assert.doesNotMatch(readFileSync(join(out, dateDir(), 'REPORT.md'), 'utf8'), /ENOENT|nonexistent/)
})

test('a control still runs after $TMPDIR was purged under a registered main worktree', async () => {
  const { suite, tmp, builder, readLog, results, suiteJson, settled } = setup()
  const { repo, git } = builder
  const main = join(tmp, 'bench-builder-main')
  git('worktree', 'add', '-q', '--detach', main, 'main')
  rmSync(main, { recursive: true, force: true })
  const r = suite(['run', 'c2', '--control', 'c2', '--builder', repo, '--detach'])
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  assert.deepEqual(suiteJson().items.map((i) => [i.id, i.status]), [['c2', 'done'], ['c2@main', 'done']])
  assert.ok(readLog().builders('c2').includes(main))
  assert.ok(existsSync(join(main, 'README.md')))
})

test('a reused main checkout that cannot check out main fails the control, not runs it on a stale commit', async () => {
  const { suite, tmp, builder, pinned, readLog, results, suiteJson, settled } = setup()
  const { repo } = builder
  const main = join(tmp, 'bench-builder-main')
  mkdirSync(main)
  writeFileSync(join(main, '.git'), 'gitdir: /nonexistent/worktree\n')
  const r = suite(['run', 'c2', '--control', 'c2', '--builder', repo, '--detach'])
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const by = Object.fromEntries(suiteJson().items.map((i) => [i.id, i.status]))
  assert.equal(by.c2, 'done')
  assert.match(by['c2@main'], /^failed: no main checkout for controls: .+/)
  assert.deepEqual(readLog().builders('c2'), [pinned])
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

test('stop: the running case is stopped, nothing more starts, the reports are written and the lock released', async () => {
  const { suite, readLog, out, dateDir, suiteJson, results } = setup()
  // one lane: c1 (30m = 6 s at 200 ms a minute), then c3, then c2
  const r = suite(['run', 'c1,c2,c3', '--lanes', '1', '--detach'], { STUB_CASE_MS: '200' })
  assert.equal(r.status, 0, r.stderr)
  await until(() => suiteJson().items[0].pid > 0 && readLog().starts('c1') === 1)
  const { pid, items } = suiteJson()
  const casePid = items[0].pid
  const st = suite(['stop'])
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /suite \S+ stopped/)
  assert.equal(alive(pid), false)
  assert.equal(alive(casePid), false)
  assert.equal(existsSync(join(results, 'lock')), false)
  assert.deepEqual(suiteJson().items.map((i) => [i.id, i.status]), [['c1', 'stopped'], ['c3', 'waiting'], ['c2', 'waiting']])
  const log = readLog()
  assert.equal(log.lines.filter((l) => l[0] === 'stopped' && l[1] === 'c1').length, 1)
  assert.equal(log.starts('c3') + log.starts('c2'), 0)
  assert.match(readFileSync(join(out, dateDir(), 'REPORT.md'), 'utf8'), /\| c1 \| md \| stopped \|/)
  assert.match(suite(['status']).stdout, /⚠ suite stopped mid-run — 3 unfinished; \/builder:benchmark --resume \S+ runs them/)
  assert.match(suite(['stop']).stdout, /no suite is running/)
})

test('--resume refuses while a case a recorded attempt started is still alive', async () => {
  const { suite, suiteJson, results, settled } = setup()
  assert.equal(suite(['run', 'c2', '--detach']).status, 0)
  await until(() => suiteJson().items[0].status === 'done')
  await settled()
  const s = suiteJson()
  // a case process outliving its suite (the suite was SIGKILLed): its command line names its --out
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', s.items[0].out], { stdio: 'ignore' })
  try {
    s.items[0] = { ...s.items[0], status: 'running', pid: orphan.pid }
    writeFileSync(join(results, s.id, 'suite.json'), JSON.stringify(s))
    const r = suite(['run', '--resume', s.id, '--detach'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, new RegExp(`c2 is still running \\(pid ${orphan.pid}\\) — /builder:benchmark --stop`))
    // a recorded pid now held by an unrelated process is not the case's
    s.items[0].pid = process.pid
    writeFileSync(join(results, s.id, 'suite.json'), JSON.stringify(s))
    assert.doesNotMatch(suite(['run', '--resume', s.id, '--detach']).stderr, /still running/)
    await settled()
  } finally {
    orphan.kill('SIGKILL')
  }
})

test('plan and run refuse two picked projects whose profiles name the same port — they may run at once', () => {
  const { suite, local, readLog } = setup()
  const md = (port) => `---\nagent_walk:\n  claude_args: --x\n  env: PORT=${port}\n---\n`
  put(join(local, 'projects', 'projA.json'), { db_prefix: 'bench_', builderMd: md(4010) })
  put(join(local, 'projects', 'projB.json'), { db_prefix: 'bench_', builderMd: md(4010) })
  for (const cmd of [['plan', 'c1,c3'], ['run', 'c1,c3', '--detach']]) {
    const r = suite(cmd)
    assert.equal(r.status, 2, cmd.join(' '))
    assert.match(r.stderr, /projects projA and projB both use port 4010 — they may run at once/)
  }
  assert.equal(readLog().lines.length, 0)
  assert.equal(suite(['plan', 'c1,c2']).status, 0) // one project's cases never overlap
  put(join(local, 'projects', 'projB.json'), { db_prefix: 'bench_', builderMd: md(4020) })
  assert.equal(suite(['plan', 'c1,c3']).status, 0)
})

test('plan shows what each archived case\'s clone will touch — its dry run — and where clones go', () => {
  const { suite, tmp, local } = setup()
  put(join(local, 'projects', 'projA.json'), { db_prefix: 'bench_', builderMd: '---\nagent_walk:\n  claude_args: --x\n  env: PORT=4010\n---\n' })
  const r = suite(['plan', 'c1,c3'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^c1 — dry run\n {2}ports: {2}4010$/m)
  assert.match(r.stdout, /^c3 — dry run$/m)
  assert.match(r.stdout, new RegExp(`clones: ${join(tmp, 'bench-suite')}/<suite-id>/<item>/clone`))
})

test('plan shows a dry run\'s body: warnings and counts them; they never refuse, and a port named only in the body never collides', () => {
  const { suite, local } = setup()
  const fm = '---\nagent_walk:\n  claude_args: --x\n  env: PORT=4010\n---\n'
  put(join(local, 'projects', 'projA.json'), { db_prefix: 'bench_', builderMd: `${fm}\nWalk readiness: DATABASE_URL=postgres://localhost/app_dev, docker compose up\n` })
  put(join(local, 'projects', 'projB.json'), { db_prefix: 'bench_', builderMd: '---\nagent_walk:\n  claude_args: --x\n---\nopen localhost:4010\n' })
  const r = suite(['plan', 'c1,c3'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^ {2}body: database app_dev is not a bench database \(bench_\*\)$/m)
  assert.match(r.stdout, /^dry runs: c1 ok — 2 body warnings, add a replace for each to its profile · c3 ok$/m)
})

test('run prints each case\'s body warnings as plan does, and records them in suite.json and the case\'s result.json', async () => {
  const { suite, local, suiteJson, settled } = setup()
  put(join(local, 'projects', 'projA.json'), { db_prefix: 'bench_', builderMd: '---\nagent_walk:\n  claude_args: --x\n---\nWalk readiness: DATABASE_URL=postgres://localhost/app_dev, docker compose up\n' })
  const r = suite(['run', 'c1,c3', '--detach'])
  assert.equal(r.status, 0, r.stderr)
  const lines = ['body: database app_dev is not a bench database (bench_*)', 'body: docker command names no bench_ container: docker compose up']
  assert.match(r.stdout, /^c1: 2 body warnings — the config's prose names something of yours; add a replace for each to its profile$/m)
  for (const l of lines) assert.ok(r.stdout.includes(`\n  ${l}\n`), r.stdout)
  assert.doesNotMatch(r.stdout, /^c3: /m)
  await settled()
  const s = suiteJson()
  const c1 = s.items.find((it) => it.id === 'c1')
  assert.deepEqual(c1.warnings, lines)
  assert.equal(s.items.find((it) => it.id === 'c3').warnings, undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(c1.out, 'result.json'), 'utf8')).warnings, lines)
})

test('the builder under test is pinned: a detached worktree at its HEAD, a dirty tree refused unless --allow-dirty, both SHAs in both reports', async () => {
  const { suite, tmp, builder, pinned, readLog, results, out, suiteJson, settled } = setup()
  const sha12 = builder.sha.slice(0, 12)
  writeFileSync(join(builder.repo, 'README.md'), 'changed\n')
  for (const cmd of [['plan', 'c2'], ['run', 'c2', '--detach']]) {
    const r = suite(cmd)
    assert.equal(r.status, 2, cmd.join(' '))
    assert.match(r.stderr, /has uncommitted changes — commit or stash them, or pass --allow-dirty/)
  }
  assert.equal(readLog().lines.length, 0)
  builder.git('checkout', '--', 'README.md')
  const r = suite(['run', 'c2', '--control', 'c2', '--detach'])
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const s = suiteJson()
  assert.deepEqual(s.treatment, { sha: builder.sha, dirty: false })
  assert.equal(s.mainSha, builder.sha)
  assert.deepEqual(readLog().builders('c2').sort(), [pinned, join(tmp, 'bench-builder-main')].sort())
  assert.ok(!existsSync(pinned), 'the pinned worktree is removed when the suite ends')
  assert.doesNotMatch(builder.git('worktree', 'list'), new RegExp(`bench-builder-${sha12}`))
  const committed = readFileSync(join(out, `${s.id.slice(0, 10)}-suite`, 'REPORT.md'), 'utf8')
  for (const md of [committed, readFileSync(join(results, s.id, 'REPORT.md'), 'utf8')]) {
    assert.match(md, new RegExp(`^builder under test: ${sha12}$`, 'm'))
    assert.match(md, new RegExp(`^builder main \\(controls\\): ${sha12}$`, 'm'))
  }
  // --allow-dirty runs the tree as it is, unpinned, and says so
  writeFileSync(join(builder.repo, 'README.md'), 'changed\n')
  const d = suite(['run', 'c3', '--allow-dirty', '--detach'])
  assert.equal(d.status, 0, d.stderr)
  await until(() => suiteJson().id !== s.id && existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  assert.deepEqual(suiteJson().treatment, { sha: builder.sha, dirty: true })
  assert.deepEqual(readLog().builders('c3'), [builder.repo])
  assert.match(suite(['run', '--resume', s.id, '--allow-dirty', '--detach']).stderr, /--resume takes only the suite id/)
  assert.match(readFileSync(join(results, suiteJson().id, 'REPORT.md'), 'utf8'), new RegExp(`^builder under test: ${sha12} \\+ uncommitted changes \\(unpinned\\)$`, 'm'))
})

test('plan notes when this shell sets DATABASE_URL, DIRECT_URL, TEST_DATABASE_URL or PG* — no case inherits them', () => {
  const { suite } = setup()
  const r = suite(['plan', 'c1'], { DATABASE_URL: 'postgres://localhost/app_dev', PGHOST: 'localhost', DIRECT_URL: 'postgres://localhost/app_dev' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^this shell sets DATABASE_URL, DIRECT_URL, PGHOST — no case inherits them: setup, teardown and the fleet start without them, and a profile's env sets its own$/m)
})

test('a second suite on one date gets its own committed report, <date>-HHMM-suite; a rebuilt report stays where it was', async () => {
  const { suite, out, results, suiteJson, settled } = setup()
  assert.equal(suite(['run', 'c2', '--detach']).status, 0)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const first = suiteJson().id
  assert.equal(suite(['run', 'c3', '--detach']).status, 0)
  await until(() => suiteJson().id !== first && existsSync(join(results, suiteJson().id, 'REPORT.md')))
  await settled()
  const second = suiteJson().id
  assert.match(second, /^\d{4}-\d\d-\d\d-\d{4}-suite(-\d+)?$/)
  const day = join(out, `${first.slice(0, 10)}-suite`, 'REPORT.md')
  const own = join(out, second, 'REPORT.md')
  assert.match(readFileSync(day, 'utf8'), /\| c2 \|/)
  assert.doesNotMatch(readFileSync(day, 'utf8'), /\| c3 \|/)
  assert.match(readFileSync(own, 'utf8'), /\| c3 \|/)
  const rebuilt = suite(['report', first])
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.match(rebuilt.stdout, new RegExp(`report: ${day}`))
  assert.doesNotMatch(readFileSync(day, 'utf8'), /\| c3 \|/)
})

/** A project repo in `dir` with feature f merged --no-ff (spec commit, then code) and its archive row. */
function projectRepo(dir) {
  mkdirSync(dir)
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  put(join(dir, '.claude', 'builder.md'), '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: {claude_args}\n---\n\n# config\n')
  put(join(dir, '.gitignore'), '.builder/\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('checkout', '-qb', 'builder/f')
  put(join(dir, 'docs', 'features', 'f', 'SPEC.md'), '# f\n\none\n')
  git('add', '-A')
  git('commit', '-qm', 'spec')
  put(join(dir, 'src', 'a.js'), 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'code')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'merge f', 'builder/f')
  put(join(dir, '.builder', 'fleet', 'archive.jsonl'), JSON.stringify({ feature: 'f', merged: git('rev-parse', 'HEAD'), wallMs: 600000, costUsd: 2, timing: [] }) + '\n')
  const state = () => [git('rev-parse', 'HEAD'), git('status', '--porcelain'), git('branch', '-a'), git('worktree', 'list'), readFileSync(join(dir, '.builder', 'fleet', 'archive.jsonl'), 'utf8')].join('\n')
  return { dir, state }
}

test('end to end: the suite runs the real case runner on two projects in two lanes — both land, the reports are written, the repos untouched', async () => {
  const { suite, tmp, local, out, results, suiteJson, settled } = setup()
  const a = projectRepo(join(tmp, 'proj-a'))
  const b = projectRepo(join(tmp, 'proj-b'))
  put(join(local, 'projects', 'pa.json'), { repo: a.dir, db_prefix: 'bench_a_', agent_walk: { env: 'PORT=59611' } })
  put(join(local, 'projects', 'pb.json'), { repo: b.dir, db_prefix: 'bench_b_', agent_walk: { env: 'PORT=59612' } })
  put(join(local, 'cases', 'e1.json'), { size: 'sm', project: 'pa', feature: 'f', covers: 'one file', estimate: { minutes: 10, usd: 1 } })
  put(join(local, 'cases', 'e2.json'), { size: 'md', project: 'pb', feature: 'f', covers: 'one file' })
  const before = [a.state(), b.state()]
  const env = { BENCH_CASE: '', BENCH_FLEET: join(HERE, 'fixtures', 'bench', 'stub-fleet-land.mjs'), BENCH_INSTALLED_PLUGINS: '/nonexistent', BENCH_KEEP_CLONES: '' }
  const p = suite(['plan', 'e1,e2', '--lanes', '2'], env)
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /^ {4}env: PORT=59611$/m) // the agent_walk line the profile applies
  assert.match(p.stdout, /^e2 \(md, pb\) — dry run/m)
  assert.match(p.stdout, /dry runs: e1 ok · e2 ok/)
  const r = suite(['run', 'e1,e2', '--lanes', '2', '--detach'], env)
  assert.equal(r.status, 0, r.stderr)
  await until(() => existsSync(join(results, suiteJson().id, 'REPORT.md')), 60000)
  await settled()
  const s = suiteJson()
  assert.deepEqual(s.items.map((i) => [i.id, i.status]).sort(), [['e1', 'done'], ['e2', 'done']])
  assert.deepEqual(s.items.map((i) => i.lane).sort(), [1, 2]) // e2's estimate came from its archive row
  for (const it of s.items) {
    const res = JSON.parse(readFileSync(join(it.out, 'result.json'), 'utf8'))
    assert.equal(res.measure.wallMs, 300000)
    assert.equal(res.baseline.wallMs, 600000)
    assert.ok(!existsSync(join(tmp, 'bench-suite', s.id, it.id)), `${it.id}'s clone was removed`)
  }
  const committed = readFileSync(join(out, `${s.id.slice(0, 10)}-suite`, 'REPORT.md'), 'utf8')
  assert.match(committed, /\| e1 \| sm \| done \|/)
  assert.match(committed, /\| e2 \| md \| done \|/)
  assert.doesNotMatch(committed, /\bpa\b|\bpb\b|proj-a|proj-b|\/private|\/var\//)
  assert.match(readFileSync(join(results, s.id, 'REPORT.md'), 'utf8'), /\| e1 \| sm \| pa \| done \|/)
  assert.deepEqual([a.state(), b.state()], before)
})
