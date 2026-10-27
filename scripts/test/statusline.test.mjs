import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { render, repoRoots, elapsed, fit } from '../statusline.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-10-02T12:00:00Z')
const BOOT = NOW - 24 * 3600 * 1000 // fixed, so fixture pid files never read as older than the real boot
const DEAD = 2 ** 22 + 12345 // above any real pid on macOS/Linux defaults

function write(root, p, text, mtime = NOW) {
  mkdirSync(dirname(join(root, p)), { recursive: true })
  writeFileSync(join(root, p), text)
  utimesSync(join(root, p), mtime / 1000, mtime / 1000)
}
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-')))
  mkdirSync(join(root, '.git'))
  write(root, '.claude/builder.md', '---\nproject: t\nregistry: docs/features\napps:\n  - name: web\n    path: apps/web/\n    role: app\n---\n')
  return root
}
const plan = (n) => Array.from({ length: n }, (_, i) => `### Task ${i + 1}: t\n`).join('\n')
const ledger = (n) => Array.from({ length: n }, (_, i) => `Task ${i + 1}: complete\n`).join('')
function feature(root, name, state, { tasks = 9, done = 0, ledgerAt = NOW } = {}) {
  write(root, `docs/features/${name}/MANIFEST.md`, `size: md\nstate: ${state}\nnext: x\n`)
  write(root, `docs/features/${name}/PLAN.md`, plan(tasks))
  if (done) write(root, `.builder/${name}/progress.md`, ledger(done), ledgerAt)
}

test('an idle repo, a dir outside any repo, and a repo without a config render nothing', () => {
  assert.equal(render({ cwd: repo(), now: NOW, bootTime: BOOT }), '')
  assert.equal(render({ cwd: realpathSync(mkdtempSync(join(tmpdir(), 'none-'))), now: NOW, bootTime: BOOT }), '')
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'bare-')))
  mkdirSync(join(bare, '.git'))
  assert.equal(render({ cwd: bare, now: NOW, bootTime: BOOT }), '')
})

test('a live fleet leads with builder and one overall bar, then done/total, each in-flight feature\'s step, parked ones marked', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: {
    a: { status: 'done' }, b: { status: 'building', worktree: null }, c: { status: 'parked' }, d: { status: 'queued' },
  } }))
  feature(root, 'b', 'building', { tasks: 9, done: 4 })
  const line = render({ cwd: root, now: NOW, bootTime: BOOT })
  // What waits on you comes before what is running.
  assert.match(line, /^builder [▓░]{10} \d+% · ⚙ fleet 1\/4 · ⛔ c · b build 4\/9$/)
})

const PARKED = { features: {
  c: { status: 'parked', reason: 'the spec leaves open whether a revoked certificate can be downloaded [D3] — next: answer D3 in SPEC §Decisions, then /builder:agent' },
  d: { status: 'failed', reason: 'run timed out twice — both no output for 30 min (the idle timeout) — see /x/logs/d-02.log — next: /builder:agent to retry' },
} }

test('a park reads ⛔ <feature>: <why>, and stays after the fleet has exited', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(DEAD))
  write(root, '.builder/fleet/fleet.json', JSON.stringify(PARKED))
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT, width: 200 }), 'builder · ⛔ c: the spec leaves open whether a revoked certificate can be d… · ⛔ d: run timed out twice — both no output for 30 min (the idle t…', 'a why is never more than 60 columns')
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { c: { status: 'parked', reason: 'plan wants to split — next: /builder:revise' }, e: { status: 'parked' } } }))
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder · ⛔ c: plan wants to split · ⛔ e')
  write(root, '.builder/fleet/fleet.json', JSON.stringify(PARKED))
  // Short of room, each why is cut to its share; shorter still, they fold into a count.
  const mid = render({ cwd: root, now: NOW, bootTime: BOOT, width: 80 })
  assert.match(mid, /^builder · ⛔ c: [^·]+… · ⛔ d: [^·]+…$/)
  assert.ok([...mid].length <= 80, mid)
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT, width: 60 }), 'builder · ⛔ 1 parked, 1 failed — /builder:fleet:status')
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT, width: 30 }), 'builder · ⛔ 1 parked, 1 failed')
  // A new run that clears them clears the line.
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { c: { status: 'queued' } } }))
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), '')
})

test('a running feature whose HEAD, ledger and workspace have not moved for 45 minutes gets a ⚠', () => {
  const root = repo()
  const wt = join(root, 'wt-b')
  const old = NOW - 50 * 60 * 1000
  write(root, 'wt-b/.git', `gitdir: ${join(root, '.git/worktrees/b')}\n`)
  write(root, '.git/worktrees/b/logs/HEAD', 'x\n', old)
  write(root, 'wt-b/docs/features/b/MANIFEST.md', 'size: md\nstate: building\nnext: x\n')
  write(root, 'wt-b/.builder/b/progress.md', 'Task 1: complete\n', old)
  utimesSync(join(wt, '.builder/b'), old / 1000, old / 1000)
  write(root, '.builder/fleet/lock', String(process.pid))
  const fleet = (startedAt) => JSON.stringify({ features: { b: { status: 'building', worktree: wt, runStartedAt: new Date(startedAt).toISOString() } } })
  write(root, '.builder/fleet/fleet.json', fleet(NOW - 70 * 60 * 1000))
  assert.match(render({ cwd: root, now: NOW, bootTime: BOOT }), / · ⚠ b build$/)
  // A run that started 10 minutes ago has not been quiet for 45.
  write(root, '.builder/fleet/fleet.json', fleet(NOW - 10 * 60 * 1000))
  assert.match(render({ cwd: root, now: NOW, bootTime: BOOT }), / · b build$/)
})

test('a fleet whose process is gone shows nothing (stale fleet.json)', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(DEAD))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'building' } } }))
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), '')
})

test('an in-chat build shows while its ledger is fresh, and drops off after 5 minutes or once built', () => {
  const root = repo()
  feature(root, 'sheet-order', 'building', { tasks: 6, done: 2 })
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder ▓▓▓░░░░░░░ 33% · sheet-order build 2/6')
  assert.equal(render({ cwd: root, now: NOW + 5 * 60 * 1000 + 1, bootTime: BOOT }), '')
  feature(root, 'sheet-order', 'built', { tasks: 6, done: 6 })
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), '')
})

test('a running gate and a running job show with elapsed time; dead or finished ones do not', () => {
  const root = repo()
  write(root, '.builder/gates/running.json', JSON.stringify({ sets: 'deep set', pid: process.pid, startedAt: new Date(NOW - 185000).toISOString() }))
  write(root, '.builder/jobs/verify.pid', String(process.pid), NOW - 45000)
  write(root, '.builder/jobs/old.pid', String(process.pid))
  write(root, '.builder/jobs/old.exit', '0\n')
  write(root, '.builder/jobs/gone.pid', String(DEAD))
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder · gate deep set ⏱ 3m · job verify ⏱ 45s')
})

test('from inside a fleet worktree (.git is a file) it reads the main checkout', () => {
  const main = repo()
  write(main, '.builder/fleet/lock', String(process.pid))
  write(main, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'walking' } } }))
  const wt = join(main, '.claude/worktrees/b')
  write(main, '.claude/worktrees/b/.git', `gitdir: ${join(main, '.git/worktrees/b')}\n`)
  assert.deepEqual(repoRoots(join(wt, 'apps')), { root: wt, main })
  assert.match(render({ cwd: wt, now: NOW, bootTime: BOOT }), /^builder [▓░]{10} \d+% · ⚙ fleet 0\/1 · b /)
})

test('fit drops whole trailing items and says how many; elapsed is compact', () => {
  assert.equal(fit(['⚙ fleet 0/3', 'aaaa', 'bbbb', 'cccc'], 26), '⚙ fleet 0/3 · aaaa +2 more')
  assert.equal(fit(['one'], 2), 'one')
  assert.deepEqual([elapsed(45000), elapsed(185000), elapsed(72 * 60000)], ['45s', '3m', '1h12m'])
})

test('the CLI prints the line, and prints nothing (exit 0) on garbage', () => {
  const root = repo()
  feature(root, 'x', 'building', { tasks: 2, done: 1, ledgerAt: Date.now() })
  const ok = spawnSync('node', [join(SCRIPTS, 'statusline.mjs'), '--cwd', root], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, 'builder ▓▓▓▓░░░░░░ 43% · x build 1/2\n')
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', '{ not json')
  const bad = spawnSync('node', [join(SCRIPTS, 'statusline.mjs'), '--cwd', root], { encoding: 'utf8' })
  assert.equal(bad.status, 0)
  assert.equal(bad.stderr, '')
  assert.equal(bad.stdout, 'builder ▓▓▓▓░░░░░░ 43% · x build 1/2\n', 'an unreadable fleet.json is no fleet segment, not "fleet 0/0"')
})

test('a lock, marker or job pid file older than the last boot is stale, whatever process has that pid now', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(process.pid), NOW - 60000)
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'building' } } }))
  write(root, '.builder/gates/running.json', JSON.stringify({ sets: 'deep set', pid: process.pid, startedAt: new Date(NOW - 60000).toISOString() }), NOW - 60000)
  write(root, '.builder/jobs/verify.pid', String(process.pid), NOW - 60000)
  assert.equal(render({ cwd: root, now: NOW, bootTime: NOW - 1000 }), '')
  assert.match(render({ cwd: root, now: NOW, bootTime: NOW - 120000 }), /^builder [▓░]{10} \d+% · ⚙ fleet 0\/1/)
})

test('after the fleet exits, what it merged stays on the line until /builder:fleet:status is opened', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(DEAD))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: {} }))
  const row = (feature, at) => JSON.stringify({ feature, merged: 'abc1234', target: 'main', landedAt: new Date(at).toISOString(), walk: { rounds: [] } })
  write(root, '.builder/fleet/archive.jsonl', [row('old', NOW - 3 * 86400000), row('pc', NOW - 3600000)].join('\n') + '\n')
  // Never opened: the last day's landings — not the repo's whole history.
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder · ✔ pc merged — /builder:fleet:status')
  // Opened since: nothing new.
  write(root, '.builder/fleet/seen', 'x', NOW - 60000)
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), '')
  // Two more land after that: both named; a third folds into a count.
  write(root, '.builder/fleet/archive.jsonl', [row('pc', NOW - 3600000), row('a', NOW - 30000), row('b', NOW - 20000)].join('\n') + '\n')
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder · ✔ a, b merged — /builder:fleet:status')
  write(root, '.builder/fleet/archive.jsonl', [row('a', NOW - 30000), row('b', NOW - 20000), row('c', NOW - 10000)].join('\n') + '\n')
  assert.equal(render({ cwd: root, now: NOW, bootTime: BOOT }), 'builder · ✔ 3 merged — /builder:fleet:status')
})
