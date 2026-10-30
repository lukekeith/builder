import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { specCommits, killableGroup } from '../bench-case.mjs'
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

/** A project repo with feature f merged --no-ff, its archive row, and a BENCH_LOCAL with profile p and case c1. */
function fixture() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bench-case-')))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  put(join(repo, '.claude', 'builder.md'), MD)
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
  const run = (args, env = {}) => spawnSync('node', [CASE, ...args], { encoding: 'utf8', env: { ...process.env, BENCH_LOCAL: local, BENCH_FLEET: STUB, BENCH_INSTALLED_PLUGINS: '/nonexistent', ...env } })
  return { tmp, repo, merged, setRow, writeProfile, out, run, range: featureRange(repo, merged) }
}

test('specCommits: the leading spec-only commits', () => {
  const { repo, range } = fixture()
  assert.deepEqual(specCommits(repo, 'docs/features', 'f', range.commits), [range.commits[0]])
})

test('a case runs in a clone and never touches the repo', () => {
  const { repo, out, run } = fixture()
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
  const clone = join(out, 'clone')
  assert.equal(git(clone, 'remote'), '')
  assert.match(readFileSync(join(clone, '.claude', 'builder.md'), 'utf8'), /claude_args: --permission-mode bypassPermissions --settings \S+ --plugin-dir /)
  assert.ok(!existsSync(join(clone, 'src', 'a.js'))) // the code commit is not in the clone's start
  const args = JSON.parse(readFileSync(join(clone, '.builder', 'fleet', 'stub-args.json'), 'utf8'))
  assert.deepEqual(args.argv, ['f', '--into', 'main', '--parallel', '1'])
  assert.equal(args.projectDir, clone)
})

test('an unsafe profile is refused before a clone is made', () => {
  const { out, run, writeProfile } = fixture()
  writeProfile({ agent_walk: { env: 'DATABASE_URL=postgres://localhost/app_dev' } })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /database app_dev is not a bench database/)
  assert.ok(!existsSync(join(out, 'clone')))
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
  const { repo, out, run, setRow } = fixture()
  setRow({ merged: git(repo, 'rev-parse', 'HEAD~1') })
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*not a merge commit/)
  assert.ok(!existsSync(join(out, 'clone')))
})

test('--dry-run prints what the clone will touch and runs nothing', () => {
  const { out, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out, '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /PORT=5999/)
  assert.ok(!existsSync(join(out, 'result.json')))
  assert.ok(!existsSync(join(out, 'clone')))
})

test('planLines counts only plans made after prep — not the original run\'s, reachable from a tag or another branch', () => {
  const { out, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).planLines, 10)
  const clone = join(out, 'clone')
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
  const { out, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_FLEET: HANG, BENCH_CASE_FLEET_TIMEOUT_MS: '1500' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*timed out/)
  const pid = Number(readFileSync(join(out, 'clone', '.builder', 'fleet', 'child.pid'), 'utf8'))
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
  const { out, run } = fixture()
  const r = run(['c1', '--builder', REPO, '--out', out], { BENCH_FLEET: HANG, BENCH_CASE_FLEET_TIMEOUT_MS: '1500', STUB_FLEET_PGIDS: '1', STUB_EXTRA_PGID: String(pgidOf(process.pid)) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')).status, /^failed: .*timed out/)
  const session = Number(readFileSync(join(out, 'clone', '.builder', 'fleet', 'session.pid'), 'utf8'))
  for (let i = 0; i < 40 && alive(session); i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(alive(session), false, `the session group ${session} outlived the fleet`)
  // still here: neither pgid 1 nor this runner's group was signalled
})
