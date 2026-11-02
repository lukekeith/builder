// codex/tests/verify-codex.test.mjs — what the Codex copy of the verifier adds to upstream's:
// one config file chosen by Codex's precedence, and a detached service that outlives its client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from '../scripts/verify/git.mjs'
import { loadVerify } from '../scripts/verify/config.mjs'
import { configPath, checkedOutBranch, loadConfig } from '../scripts/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'scripts', 'verify', 'verify.mjs')
const MIGRATE = join(HERE, '..', 'scripts', 'verify', 'migrate.mjs')
const cfg = (verify) => `---\nproject: X\nbase_branch: main\napps:\n  - name: a\n    path: .\n${verify}---\n`
const put = (root, rel, text) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)))

test('verify: is read from the config Codex selects — .codex/builder.md, then .builder/config.md, then .claude/builder.md', () => {
  const root = tmp('vcodex-')
  put(root, '.claude/builder.md', cfg('verify:\n  checks:\n    claude: { run: "true" }\n'))
  assert.equal(configPath(root), '.claude/builder.md')
  assert.deepEqual(loadVerify(root).verify.checks.map((c) => c.name), ['claude'])
  put(root, '.builder/config.md', cfg('verify:\n  checks:\n    portable: { run: "true" }\n'))
  assert.equal(configPath(root), '.builder/config.md')
  assert.deepEqual(loadVerify(root).verify.checks.map((c) => c.name), ['portable'])
  put(root, '.codex/builder.md', cfg('verify:\n  checks:\n    codex: { run: "true" }\n'))
  assert.equal(configPath(root), '.codex/builder.md')
  assert.deepEqual(loadVerify(root).verify.checks.map((c) => c.name), ['codex'])
  // loadConfig and the verifier agree on the file.
  assert.equal(loadConfig(root).sourcePath, '.codex/builder.md')
})

test('a malformed .codex/builder.md is an error — never a fall-through to a valid .claude/builder.md', () => {
  const root = tmp('vcodex-')
  put(root, '.claude/builder.md', cfg('verify:\n  checks:\n    ok: { run: "true" }\n'))
  put(root, '.codex/builder.md', cfg('verify:\n  suites:\n    u: { runner: mocha }\n'))
  const bad = loadVerify(root)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /runner "mocha"/)
  put(root, '.codex/builder.md', 'no frontmatter at all\n')
  assert.equal(loadVerify(root).reason, '.codex/builder.md has no verify: block — run $builder init --update')
  assert.equal(loadConfig(root).ok, false)
  put(root, '.codex/builder.md', cfg('') + '## Quality gates\n- `npm test`\n')
  assert.match(loadVerify(root).reason, /still uses ## Quality gates — run \$builder init --update/)
})

test('no config at all names the Codex path and $builder init', () => {
  assert.equal(loadVerify(tmp('vcodex-')).reason, 'no .codex/builder.md — run $builder init')
})

test('migrate.mjs migrates the gates of the config Codex selects', () => {
  const root = tmp('vcodex-')
  const gates = (cmd) => cfg('') + `## Quality gates\n### a — fast\n\`\`\`\n${cmd}   # tests\n\`\`\`\n`
  put(root, '.claude/builder.md', gates('node --test "test/claude/*.test.mjs"'))
  put(root, '.codex/builder.md', gates('node --test "test/codex/*.test.mjs"'))
  const r = spawnSync(process.execPath, [MIGRATE, root], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /test\/codex\/\*\.test\.mjs/)
  assert.doesNotMatch(r.stdout, /test\/claude/)
  const none = spawnSync(process.execPath, [MIGRATE, tmp('vcodex-')], { encoding: 'utf8' })
  assert.equal(none.status, 2)
  assert.match(none.stderr, /no \.codex\/builder\.md — run \$builder init/)
})

test('checkedOutBranch is the branch of the main worktree, also when asked from a feature worktree', () => {
  const root = tmp('vcodex-')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'builder/x', wt)
  assert.equal(checkedOutBranch(root), 'main')
  assert.equal(checkedOutBranch(wt), 'main')
  assert.equal(checkedOutBranch(tmp('vcodex-')), null)
})

test('a request with no --target under merge_into: current targets the branch checked out in the main worktree', () => {
  const root = tmp('vcodex-')
  git(root, 'init', '-q', '-b', 'dev')
  put(root, '.codex/builder.md', cfg('merge_into: current\nverify:\n  checks:\n    ok: { run: "true", tiers: [commit] }\n'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'builder/x', wt)
  const r = spawnSync(process.execPath, [CLIENT, 'request', wt, 'HEAD', '--tier', 'commit'], { cwd: wt, encoding: 'utf8', env: { ...process.env, BUILDER_VERIFY_IDLE_MS: '300' } })
  assert.equal(r.status, 0, r.stderr)
  const req = JSON.parse(readFileSync(join(root, '.builder', 'verify', 'requests', `${r.stdout.trim()}.json`), 'utf8'))
  assert.equal(req.target, 'dev')
})

// ── The service lifetime ─────────────────────────────────────────────────────────────────────────
// Every Codex tool call is its own process. These prove what a plain macOS/Linux process tree does:
// the service a `request` starts is detached, so it outlives the client — even when the client's
// whole process group is killed, as a harness ending a tool call may do — and a later, separate
// `wait` reads its verdict; with nothing left to do it exits by itself. They do NOT prove that a
// Codex sandbox leaves a detached process running after a tool call (codex/README.md).

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (f, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return f()
}
const pidOf = (root) => {
  try {
    return Number(readFileSync(join(root, '.builder', 'verify', 'serve.pid'), 'utf8')) || null
  } catch {
    return null
  }
}
/** A repo whose only check takes ~2 s, so the request is still running after its client is gone. */
function slowRepo() {
  const root = tmp('vsurv-')
  git(root, 'init', '-q', '-b', 'main')
  put(root, '.codex/builder.md', cfg('verify:\n  workers: 1\n  checks:\n    slow: { run: "sleep 2 && test -f b.txt", tiers: [commit, phase, merge] }\n'))
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  const wt = join(root, '..', `${root.split('/').pop()}-wt`)
  git(root, 'worktree', 'add', '-qb', 'builder/slow', wt)
  writeFileSync(join(wt, 'b.txt'), '1\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'b')
  return { root, wt }
}
const ENV = { ...process.env, BUILDER_VERIFY_IDLE_MS: '1000' }

test('the service a request starts outlives that client process; a separate wait reads its verdict; then it exits idle', async () => {
  const { root, wt } = slowRepo()
  const r = spawnSync(process.execPath, [CLIENT, 'request', wt, 'HEAD', '--tier', 'commit'], { cwd: wt, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, r.stderr)
  const id = r.stdout.trim()
  // The client has exited (spawnSync returned); the service it started is another, live process.
  const pid = await until(() => pidOf(root))
  assert.ok(pid, 'a service took the lock')
  assert.notEqual(pid, r.pid)
  assert.ok(alive(pid), 'the service is alive after its client exited')
  const running = await until(() => JSON.parse(readFileSync(join(root, '.builder', 'verify', 'requests', `${id}.json`), 'utf8')).state === 'running')
  assert.ok(running, 'the request is running with no client attached')
  const w = spawnSync(process.execPath, [CLIENT, 'wait', id, '--max', '60'], { cwd: wt, encoding: 'utf8', env: ENV })
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /GREEN/)
  // Nothing queued or running: it drops its lock and exits on its own.
  assert.ok(await until(() => !existsSync(join(root, '.builder', 'verify', 'serve.pid'))), 'serve.pid removed when idle')
  assert.ok(await until(() => !alive(pid)), 'the idle service exited')
})

test('the service survives SIGKILL of the client\'s whole process group', async () => {
  const { root, wt } = slowRepo()
  // The client runs inside a shell that leads its own process group, as a tool call's command does;
  // once the request is filed the whole group is killed.
  const sh = spawn('sh', ['-c', `"${process.execPath}" "${CLIENT}" request "${wt}" HEAD --tier commit; sleep 60`], { cwd: wt, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  sh.stdout.on('data', (d) => (out += d))
  const id = await until(() => /^\S+\n/.test(out) && out.trim())
  assert.ok(id, 'the request was filed')
  const pid = await until(() => pidOf(root))
  assert.ok(pid)
  const exited = new Promise((r) => sh.on('exit', (code, signal) => r(signal)))
  process.kill(-sh.pid, 'SIGKILL')
  assert.equal(await exited, 'SIGKILL', 'the client group is gone')
  assert.ok(alive(pid), 'the service is not in the killed group')
  const w = spawnSync(process.execPath, [CLIENT, 'wait', id, '--max', '60'], { cwd: wt, encoding: 'utf8', env: ENV })
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /GREEN/)
  const req = JSON.parse(readFileSync(join(root, '.builder', 'verify', 'requests', `${id}.json`), 'utf8'))
  assert.equal(req.crashes, undefined, 'the same service finished it — it never died and restarted')
  assert.ok(await until(() => !alive(pid)), 'the idle service exited')
})
