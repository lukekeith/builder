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
  assert.equal(render({ cwd: repo(), now: NOW }), '')
  assert.equal(render({ cwd: realpathSync(mkdtempSync(join(tmpdir(), 'none-'))), now: NOW }), '')
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'bare-')))
  mkdirSync(join(bare, '.git'))
  assert.equal(render({ cwd: bare, now: NOW }), '')
})

test('a live fleet shows done/total, each in-flight feature with its bar and step, parked ones marked', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: {
    a: { status: 'done' }, b: { status: 'building', worktree: null }, c: { status: 'parked' }, d: { status: 'queued' },
  } }))
  feature(root, 'b', 'building', { tasks: 9, done: 4 })
  const line = render({ cwd: root, now: NOW })
  assert.match(line, /^⚙ fleet 1\/4 · b [▓░]{10} build 4\/9 · ⛔ c$/)
})

test('a fleet whose process is gone shows nothing (stale fleet.json)', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(DEAD))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'building' } } }))
  assert.equal(render({ cwd: root, now: NOW }), '')
})

test('an in-chat build shows while its ledger is fresh, and drops off after 5 minutes or once built', () => {
  const root = repo()
  feature(root, 'sheet-order', 'building', { tasks: 6, done: 2 })
  assert.equal(render({ cwd: root, now: NOW }), 'sheet-order build 2/6')
  assert.equal(render({ cwd: root, now: NOW + 5 * 60 * 1000 + 1 }), '')
  feature(root, 'sheet-order', 'built', { tasks: 6, done: 6 })
  assert.equal(render({ cwd: root, now: NOW }), '')
})

test('a running gate and a running job show with elapsed time; dead or finished ones do not', () => {
  const root = repo()
  write(root, '.builder/gates/running.json', JSON.stringify({ sets: 'deep set', pid: process.pid, startedAt: new Date(NOW - 185000).toISOString() }))
  write(root, '.builder/jobs/verify.pid', String(process.pid), NOW - 45000)
  write(root, '.builder/jobs/old.pid', String(process.pid))
  write(root, '.builder/jobs/old.exit', '0\n')
  write(root, '.builder/jobs/gone.pid', String(DEAD))
  assert.equal(render({ cwd: root, now: NOW }), 'gate deep set ⏱ 3m · job verify ⏱ 45s')
})

test('from inside a fleet worktree (.git is a file) it reads the main checkout', () => {
  const main = repo()
  write(main, '.builder/fleet/lock', String(process.pid))
  write(main, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'walking' } } }))
  const wt = join(main, '.claude/worktrees/b')
  write(main, '.claude/worktrees/b/.git', `gitdir: ${join(main, '.git/worktrees/b')}\n`)
  assert.deepEqual(repoRoots(join(wt, 'apps')), { root: wt, main })
  assert.match(render({ cwd: wt, now: NOW }), /^⚙ fleet 0\/1 · b /)
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
  assert.equal(ok.stdout, 'x build 1/2\n')
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', '{ not json')
  const bad = spawnSync('node', [join(SCRIPTS, 'statusline.mjs'), '--cwd', root], { encoding: 'utf8' })
  assert.equal(bad.status, 0)
  assert.equal(bad.stderr, '')
  assert.equal(bad.stdout, 'x build 1/2\n', 'an unreadable fleet.json is no fleet segment, not "fleet 0/0"')
})
