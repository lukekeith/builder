import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { specCommits, killableGroup, prepareClone, finishCase } from '../bench-case.mjs'
import { featureRange } from '../bench-replay-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = realpathSync(join(HERE, '..', '..'))
const CASE = join(REPO, 'scripts', 'bench-case.mjs')
const STUB = join(HERE, 'fixtures', 'bench', 'stub-fleet-land.mjs')
const HANG = join(HERE, 'fixtures', 'bench', 'stub-fleet-hang.mjs')
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' }).trim()
const put = (f, s) => {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, s)
}
const MD = '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: {claude_args}\n  env: PORT=4917\n---\n\n# config\n'

/** A project repo (its builder.md `md`) with feature f merged --no-ff, its archive row, and a BENCH_LOCAL with profile p and case c1. */
function fixture({ md = MD } = {}) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bench-case-')))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  put(join(repo, '.claude', 'builder.md'), md)
  put(join(repo, '.gitignore'), '.builder/\n')
  put(join(repo, 'README.md'), 'r\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'checkout', '-qb', 'builder/f')
  put(join(repo, 'docs', 'features', 'f', 'SPEC.md'), '# f\n\none\ntwo\n')
  put(join(repo, 'docs', 'features', 'f', 'MANIFEST.md'), 'size: sm\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'spec')
  put(join(repo, 'src', 'a.js'), 'export const a = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'code')
  // the original run's plan, longer than any the stub writes: it must never be counted
  put(join(repo, 'docs', 'features', 'f', 'PLAN.md'), Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n') + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'plan')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge f', 'builder/f')
  const merged = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'tag', 'v1.0.0', merged)
  const setRow = (o = {}) => put(join(repo, '.builder', 'fleet', 'archive.jsonl'), JSON.stringify({ feature: 'f', merged, wallMs: 600000, costUsd: 2, timing: [], ...o }) + '\n')
  setRow()
  const local = join(tmp, 'local')
  const writeProfile = (o = {}) => put(join(local, 'projects', 'p.json'), JSON.stringify({ repo, agent_walk: { env: 'PORT=5999' }, db_prefix: 'bench_', ...o }))
  writeProfile()
  put(join(local, 'cases', 'c1.json'), JSON.stringify({ id: 'c1', size: 'sm', kind: 'archived', project: 'p', feature: 'f', covers: 'one file' }))
  const out = join(tmp, 'out')
  const clones = join(tmp, 'clones')
  // the clone for --out <tmp>/out: $BENCH_TMP/<out's parent's name>/<out's name>/clone
  const clone = join(clones, basename(tmp), 'out', 'clone')
  const run = (args, env = {}) => spawnSync('node', [CASE, ...args], { encoding: 'utf8', env: { ...process.env, BENCH_LOCAL: local, BENCH_TMP: clones, BENCH_KEEP_CLONES: '1', BENCH_FLEET: STUB, BENCH_INSTALLED_PLUGINS: '/nonexistent', ...env } })
  return { tmp, local, repo, merged, setRow, writeProfile, out, clone, run, range: featureRange(repo, merged) }
}

test('specCommits: the leading spec-only commits', () => {
  const { repo, range } = fixture()
  assert.deepEqual(specCommits(repo, 'docs/features', 'f', range.commits), [range.commits[0]])
})

test('a case runs in a clone and never touches the repo', () => {
  const { repo, out, clone, run } = fixture()
  const before = git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain')
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain'), before)
  const res = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
  assert.equal(res.status, 'done')
  assert.equal(res.measure.wallMs, 300000)
  assert.equal(res.baseline.wallMs, 600000)
  assert.equal(res.specLines > 0, true)
  assert.equal(res.planLines, 10)
  assert.deepEqual({ id: res.id, size: res.size, kind: res.kind, project: res.project, control: res.control }, { id: 'c1', size: 'sm', kind: 'archived', project: 'p', control: false })
  assert.deepEqual(res.estimate, { minutes: 10, usd: 2 })
  assert.equal(git(clone, 'remote'), '')
  assert.match(readFileSync(join(clone, '.claude', 'builder.md'), 'utf8'), /claude_args: --permission-mode bypassPermissions --settings \S+ --plugin-dir /)
  assert.ok(!existsSync(join(clone, 'src', 'a.js'))) // the code commit is not in the clone's start
  const args = JSON.parse(readFileSync(join(clone, '.builder', 'fleet', 'stub-args.json'), 'utf8'))
  assert.deepEqual(args.argv, ['f', '--into', 'main', '--parallel', '1'])
  assert.equal(args.projectDir, clone)
})

test('an unsafe profile is refused before a clone is made', () => {
  const { out, clone, run, writeProfile } = fixture()
  writeProfile({ agent_walk: { env: 'DATABASE_URL=postgres://localhost/app_dev' } })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /database app_dev is not a bench database/)
  assert.ok(!existsSync(clone))
})

test('an --out inside the project repo is refused, and the repo is untouched', () => {
  const { repo, run } = fixture()
  const before = git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain')
  const r = run(['c1', '--builder', REPO, '--out', join(repo, 'bench-out')])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /inside the project repo/)
  assert.equal(git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain'), before)
})

test('a missing case or profile is a refusal', () => {
  const { out, run, writeProfile } = fixture()
  assert.equal(run(['nope', '--builder', REPO, '--out', out]).status, 2)
  writeProfile({ repo: undefined })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /repo/)
})

test('a squash-merged feature fails prep with the reason, exit 0, status failed', () => {
  const { repo, out, clone, run, setRow } = fixture()
  setRow({ merged: git(repo, 'rev-parse', 'HEAD~1') })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*not a merge commit/)
  assert.ok(!existsSync(clone))
})

test('--dry-run prints what the clone will touch and runs nothing', () => {
  const { out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out, '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /PORT=5999/)
  assert.match(r.stdout, /^ {2}teardown: \(none\)$/m)
  assert.match(r.stdout, /^ {2}ports: +5999$/m)
  assert.ok(!existsSync(join(out, 'result.json')))
  assert.ok(!existsSync(clone))
})

test('the clone lives outside every repo, under BENCH_TMP — never under the builder repo — and result.json and the logs stay in --out', () => {
  const { tmp, out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_KEEP_CLONES: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(out, 'result.json')))
  assert.ok(existsSync(join(out, 'fleet.out')))
  assert.ok(existsSync(join(clone, '.git')))
  assert.ok(!clone.startsWith(REPO + sep))
  // with no BENCH_TMP: $TMPDIR/bench-suite/<suite>/<item>/clone
  const d = run(['c1', '--builder', REPO, '--out', join(tmp, 's1', 'it'), '--dry-run'], { BENCH_TMP: '', TMPDIR: join(tmp, 't') })
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, new RegExp(`clone: +${join(tmp, 't', 'bench-suite', 's1', 'it', 'clone')}$`, 'm'))
  // --clone-root names it; one inside any git repo is refused
  const x = run(['c1', '--builder', REPO, '--out', join(tmp, 'o3'), '--clone-root', join(REPO, 'bench', 'local', 'results', 'x')])
  assert.equal(x.status, 2)
  assert.match(x.stderr, /refused: the clone .* would be inside the git repo /)
  assert.ok(!existsSync(join(REPO, 'bench', 'local', 'results', 'x')))
})

test('planLines counts only plans made after prep — not the original run\'s, reachable from a tag or another branch', () => {
  const { out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).planLines, 10)
  assert.equal(git(clone, 'tag'), '')
  assert.equal(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'), 'refs/heads/main')
})

test('a setup that runs past BENCH_SETUP_TIMEOUT_MS fails prep: setup timed out', () => {
  const { out, run, writeProfile } = fixture()
  writeProfile({ setup: 'sleep 5' })
  const t0 = Date.now()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_SETUP_TIMEOUT_MS: '300' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(Date.now() - t0 < 4500, 'the setup was not cut short')
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, 'failed: setup timed out')
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

test('a fleet that runs past its timeout is killed with everything it started', async () => {
  const { out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_FLEET: HANG, BENCH_CASE_FLEET_TIMEOUT_MS: '1500' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*timed out/)
  const pid = Number(readFileSync(join(clone, '.builder', 'fleet', 'child.pid'), 'utf8'))
  assert.ok(pid > 0)
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(alive(pid), false, `the fleet's child ${pid} outlived it`)
})

const pgidOf = (pid) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())

test('killableGroup: never pgid ≤ 1, this process\'s own group or its parent\'s', () => {
  for (const p of [-1, 0, 1, 1.5, NaN, undefined, null, '7']) assert.equal(killableGroup(p), false, String(p))
  assert.equal(killableGroup(pgidOf(process.pid)), false)
  assert.equal(killableGroup(pgidOf(process.ppid)), false)
  assert.equal(killableGroup(999999), true)
})

test('a timed-out fleet\'s recorded groups are killed — but never pgid 1 or the runner\'s own group', async () => {
  const { out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_FLEET: HANG, BENCH_CASE_FLEET_TIMEOUT_MS: '1500', STUB_FLEET_PGIDS: '1', STUB_EXTRA_PGID: String(pgidOf(process.pid)) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*timed out/)
  const session = Number(readFileSync(join(clone, '.builder', 'fleet', 'session.pid'), 'utf8'))
  for (let i = 0; i < 40 && alive(session); i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(alive(session), false, `the session group ${session} outlived the fleet`)
  // still here: neither pgid 1 nor this runner's group was signalled
})

test('setup, teardown and every placed file are checked like the config, each reason saying where', () => {
  const { tmp, out, run, writeProfile } = fixture()
  put(join(tmp, 'local', 'projects', 'bench.env'), 'PORT=5999\nDATABASE_URL=postgres://localhost/app_dev\n')
  put(join(tmp, 'local', 'projects', 'tool.bin'), Buffer.from([0x7f, 0x45, 0x00, 0x01]).toString('latin1') + 'postgres://localhost/app_dev')
  writeProfile({ setup: 'docker compose up -d', teardown: 'dropdb app_dev', files: { '.env': 'bench.env', 'bin/tool': 'tool.bin' } })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /refused: setup: docker command names no bench_ container: docker compose up -d/)
  assert.match(r.stderr, /refused: teardown: database app_dev is not a bench database/)
  assert.match(r.stderr, /refused: files\/\.env: database app_dev is not a bench database/)
  assert.doesNotMatch(r.stderr, /bin\/tool/) // a binary is not read as text
  assert.ok(!existsSync(join(out, 'result.json')))
})

test('a profile\'s env reaches setup, teardown and the fleet; the shell\'s DATABASE_URL, DIRECT_URL, TEST_DATABASE_URL and PG* never do', () => {
  const { tmp, out, clone, run, writeProfile } = fixture()
  const keys = 'DATABASE_URL DIRECT_URL TEST_DATABASE_URL PGHOST PGDATABASE BENCH_MARK'
  const dump = (f) => `for k in ${keys}; do printf '%s=%s\\n' "$k" "$(printenv $k)"; done > ${join(tmp, f)}`
  writeProfile({ env: { BENCH_MARK: 'on', DATABASE_URL: 'postgres://localhost:5432/bench_p' }, setup: dump('setup.env'), teardown: dump('teardown.env') })
  const shell = { DATABASE_URL: 'postgres://localhost/app_dev', DIRECT_URL: 'postgres://localhost/app_dev', TEST_DATABASE_URL: 'postgres://localhost/app_test', PGHOST: 'localhost', PGDATABASE: 'app_dev' }
  const r = run(['c1', '--builder', REPO, '--out', out], shell)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, 'done')
  const want = 'DATABASE_URL=postgres://localhost:5432/bench_p\nDIRECT_URL=\nTEST_DATABASE_URL=\nPGHOST=\nPGDATABASE=\nBENCH_MARK=on\n'
  assert.equal(readFileSync(join(tmp, 'setup.env'), 'utf8'), want)
  assert.equal(readFileSync(join(tmp, 'teardown.env'), 'utf8'), want)
  const { env } = JSON.parse(readFileSync(join(clone, '.builder', 'fleet', 'stub-args.json'), 'utf8'))
  assert.deepEqual(env, { DATABASE_URL: 'postgres://localhost:5432/bench_p', BENCH_MARK: 'on' })
})

test('a profile\'s env is checked like the config — each reason says env: — and the dry run shows it', () => {
  const { out, clone, run, writeProfile } = fixture()
  writeProfile({ env: { DATABASE_URL: 'postgres://localhost/app_dev', API_PORT: 6123 } })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /^refused: env: database app_dev is not a bench database \(bench_\*\)$/m)
  assert.ok(!existsSync(clone))
  writeProfile({ env: { NESTED: { a: 1 } } })
  assert.match(run(['c1', '--builder', REPO, '--out', out]).stderr, /^refused: env: NESTED must be a string$/m)
  writeProfile({ env: ['DATABASE_URL=x'] })
  assert.match(run(['c1', '--builder', REPO, '--out', out]).stderr, /^refused: env must be \{ "NAME": "value" \}$/m)
  writeProfile({ env: { DATABASE_URL: 'postgres://localhost/bench_p', API_PORT: 6123 } })
  const d = run(['c1', '--builder', REPO, '--out', out, '--dry-run'])
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /^ {2}env: +DATABASE_URL=postgres:\/\/localhost\/bench_p API_PORT=6123$/m)
  assert.match(d.stdout, /^ {2}ports: +5999 6123$/m)
})

test('claude_args keeps the project\'s own flags after the runner\'s — never its --permission-mode, --settings or --plugin-dir', () => {
  const own = '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: --permission-mode default --mcp-config .claude/walk-mcp.json --plugin-dir /mine --settings=/x.json\n---\n\n# config\n'
  const { out, clone, run } = fixture({ md: own })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  const settings = join(clone, '.claude', 'bench-settings.json')
  assert.match(readFileSync(join(clone, '.claude', 'builder.md'), 'utf8'), new RegExp(`^  claude_args: --permission-mode bypassPermissions --settings ${settings} --plugin-dir ${REPO} --mcp-config \\.claude/walk-mcp\\.json$`, 'm'))
})

test('a profile\'s agent_walk.claude_args replaces the project\'s own, after the runner\'s flags', () => {
  const own = '---\nproject: p\nregistry: docs/features\nagent_walk:\n  claude_args: --mcp-config .claude/walk-mcp.json\n---\n'
  const { out, run, writeProfile } = fixture({ md: own })
  writeProfile({ agent_walk: { env: 'PORT=5999', claude_args: '--mcp-config .claude/bench-mcp.json --plugin-dir /elsewhere' } })
  const d = run(['c1', '--builder', REPO, '--out', out, '--dry-run'])
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, new RegExp(`^ {4}claude_args: --permission-mode bypassPermissions --settings \\S+ --plugin-dir ${REPO} --mcp-config \\.claude/bench-mcp\\.json$`, 'm'))
  assert.doesNotMatch(d.stdout, /walk-mcp|elsewhere/)
})

const waitFor = async (fn, ms = 15000) => {
  for (const t0 = Date.now(); !fn(); await new Promise((res) => setTimeout(res, 50))) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${fn}`)
}

test('whatever the setup started is stopped after the case, and the teardown runs in the clone', async () => {
  const { tmp, out, run, writeProfile } = fixture()
  const pidFile = join(tmp, 'setup-sleep.pid')
  writeProfile({ setup: `sleep 60 & echo $! > ${pidFile}`, teardown: `pwd > ${join(tmp, 'teardown.txt')}` })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, 'done')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await waitFor(() => !alive(pid))
  assert.match(readFileSync(join(tmp, 'teardown.txt'), 'utf8'), /\/out\/clone\n$/)
  assert.ok(existsSync(join(out, 'teardown.out')))
})

test('a setup that fails still has what it started stopped', async () => {
  const { tmp, out, run, writeProfile } = fixture()
  const pidFile = join(tmp, 'setup-sleep.pid')
  writeProfile({ setup: `sleep 60 & echo $! > ${pidFile}; exit 3` })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: setup failed \(exit 3\)/)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await waitFor(() => !alive(pid))
})

test('the clone is removed once result.json is written — the logs stay — unless BENCH_KEEP_CLONES=1', () => {
  const { tmp, out, clone, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_KEEP_CLONES: '' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(out, 'result.json')))
  assert.ok(existsSync(join(out, 'fleet.out')))
  assert.ok(!existsSync(clone))
  assert.ok(!existsSync(dirname(clone)), 'the empty clone root is removed too')
  const kept = run(['c1', '--builder', REPO, '--out', join(tmp, 'out2')], { BENCH_KEEP_CLONES: '1' })
  assert.equal(kept.status, 0, kept.stderr)
  assert.ok(existsSync(join(tmp, 'clones', basename(tmp), 'out2', 'clone', '.git')))
})

test('SIGTERM stops the case: its fleet, the fleet\'s session groups and the setup\'s, the teardown run, result.json failed: stopped', async () => {
  const { tmp, local, out, clone, writeProfile } = fixture()
  const pidFile = join(tmp, 'setup-sleep.pid')
  writeProfile({ setup: `sleep 60 & echo $! > ${pidFile}`, teardown: `echo torn > ${join(tmp, 'teardown.txt')}` })
  const child = spawn('node', [CASE, 'c1', '--builder', REPO, '--out', out], { stdio: 'ignore', env: { ...process.env, BENCH_LOCAL: local, BENCH_TMP: join(tmp, 'clones'), BENCH_KEEP_CLONES: '1', BENCH_FLEET: HANG, BENCH_INSTALLED_PLUGINS: '/nonexistent', BENCH_CASE_KILL_GRACE_MS: '500', STUB_FLEET_PGIDS: '1', STUB_EXTRA_PGID: String(pgidOf(process.pid)) } })
  const exited = new Promise((res) => child.on('exit', res))
  const sessionFile = join(clone, '.builder', 'fleet', 'session.pid')
  await waitFor(() => existsSync(sessionFile) && readFileSync(sessionFile, 'utf8').length > 0)
  const session = Number(readFileSync(sessionFile, 'utf8'))
  const fleetChild = Number(readFileSync(join(clone, '.builder', 'fleet', 'child.pid'), 'utf8'))
  const setupSleep = Number(readFileSync(pidFile, 'utf8'))
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, 'failed: stopped')
  assert.equal(readFileSync(join(tmp, 'teardown.txt'), 'utf8'), 'torn\n')
  await waitFor(() => ![session, fleetChild, setupSleep].some(alive))
})

/** A detached `sleep 60` — its own process group, nothing to do with any clone. */
const outsider = () => spawn('sleep', ['60'], { stdio: 'ignore', detached: true })

test('a setup that leaves nothing running records no group, so nothing is signalled after the fleet', async () => {
  const { tmp, local, clone } = fixture()
  const profile = JSON.parse(readFileSync(join(local, 'projects', 'p.json'), 'utf8'))
  const env = { BENCH_FLEET: process.env.BENCH_FLEET, BENCH_INSTALLED_PLUGINS: process.env.BENCH_INSTALLED_PLUGINS }
  Object.assign(process.env, { BENCH_FLEET: STUB, BENCH_INSTALLED_PLUGINS: '/nonexistent' })
  try {
    const prep = await prepareClone({ profile: { ...profile, setup: 'true' }, profileDir: join(local, 'projects'), caseDef: { id: 'c1', kind: 'archived', feature: 'f' }, builder: REPO, dest: clone, out: join(tmp, 'out'), listening: [] })
    assert.equal(prep.failure, null)
    assert.equal(prep.setupPgid, null)
  } finally {
    for (const [k, v] of Object.entries(env)) v == null ? delete process.env[k] : (process.env[k] = v)
  }
})

test('a recorded setup group with no member in the clone — its pid reused — is never signalled', async () => {
  const { tmp, clone, run } = fixture()
  assert.equal(run(['c1', '--builder', REPO, '--out', join(tmp, 'out')]).status, 0)
  const other = outsider()
  try {
    const logged = []
    const err = console.error
    console.error = (...a) => logged.push(a.join(' '))
    try {
      await finishCase({ clone, teardown: null, setupPgid: other.pid, out: join(tmp, 'out') })
    } finally {
      console.error = err
    }
    assert.equal(alive(other.pid), true, 'an unrelated group was signalled')
    assert.match(logged.join('\n'), new RegExp(`not signalling process group ${other.pid}: no member runs in the clone`))
  } finally {
    other.kill('SIGKILL')
  }
})

test('a fleet.json pgid whose group has no member in the clone is not killed on a timeout; the fleet\'s own session group is', async () => {
  const { out, clone, run } = fixture()
  const other = outsider()
  try {
    const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_FLEET: HANG, BENCH_CASE_FLEET_TIMEOUT_MS: '1500', BENCH_CASE_KILL_GRACE_MS: '300', STUB_FLEET_PGIDS: '1', STUB_EXTRA_PGID: String(other.pid) })
    assert.equal(r.status, 0, r.stderr)
    const session = Number(readFileSync(join(clone, '.builder', 'fleet', 'session.pid'), 'utf8'))
    for (let i = 0; i < 40 && alive(session); i++) await new Promise((res) => setTimeout(res, 50))
    assert.equal(alive(session), false, 'the session group in the clone outlived the fleet')
    assert.equal(alive(other.pid), true, 'a group outside the clone was killed')
    assert.match(r.stderr, new RegExp(`not signalling process group ${other.pid}: no member runs in the clone`))
  } finally {
    other.kill('SIGKILL')
  }
})
