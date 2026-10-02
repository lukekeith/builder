import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, lstatSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'statusline-install.mjs')
const GSD = { type: 'command', command: 'node "/x/gsd-statusline.js"' }

function config(settings) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')))
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n')
  return dir
}
const run = (dir, ...args) => spawnSync('node', [INSTALL, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
const settings = (dir) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

test('on wraps the existing line and copies the launcher; off restores it exactly', () => {
  const dir = config({ model: 'opus', statusLine: GSD })
  const on = run(dir, 'on')
  assert.equal(on.status, 0, on.stderr)
  const s = settings(dir)
  assert.equal(s.model, 'opus', 'other keys kept')
  assert.equal(s.statusLine.command, `node "${join(dir, 'builder', 'statusline.mjs')}"`)
  assert.equal(s.statusLine.refreshInterval, 2)
  assert.ok(existsSync(join(dir, 'builder', 'statusline.mjs')))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'builder', 'statusline.prev.json'), 'utf8')), { statusLine: GSD })
  const off = run(dir, 'off')
  assert.equal(off.status, 0, off.stderr)
  assert.deepEqual(settings(dir), { model: 'opus', statusLine: GSD })
  assert.ok(!existsSync(join(dir, 'builder', 'statusline.prev.json')))
})

test('with no previous status line, off removes the key again (and works with no settings file at all)', () => {
  const dir = config({ model: 'opus' })
  run(dir, 'on')
  run(dir, 'off')
  assert.deepEqual(settings(dir), { model: 'opus' })
  const none = config()
  assert.equal(run(none, 'on').status, 0)
  assert.equal(run(none, 'off').status, 0)
  assert.deepEqual(settings(none), {})
})

test('on twice keeps the original saved line; bare toggles', () => {
  const dir = config({ statusLine: GSD })
  run(dir, 'on')
  const again = run(dir, 'on')
  assert.match(again.stdout, /already on/)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'builder', 'statusline.prev.json'), 'utf8')), { statusLine: GSD })
  assert.match(run(dir).stdout, /off/)
  assert.deepEqual(settings(dir).statusLine, GSD)
  assert.match(run(dir).stdout, /on/)
  assert.match(settings(dir).statusLine.command, /builder/)
})

test('off refuses when the status line is no longer builder\'s; unparseable settings are never written', () => {
  const dir = config({ statusLine: GSD })
  run(dir, 'on')
  const other = { type: 'command', command: 'my-own-line' }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: other }))
  const off = run(dir, 'off')
  assert.equal(off.status, 1)
  assert.match(off.stdout + off.stderr, /isn't builder's/)
  assert.deepEqual(settings(dir).statusLine, other)
  const broken = config('{ nope')
  assert.equal(run(broken, 'on').status, 1)
  assert.equal(readFileSync(join(broken, 'settings.json'), 'utf8'), '{ nope')
})

test('status reports on/off and the wrapped command', () => {
  const dir = config({ statusLine: GSD })
  assert.match(run(dir, 'status').stdout, /^builder status line: off/m)
  run(dir, 'on')
  const s = run(dir, 'status').stdout
  assert.match(s, /^builder status line: on/m)
  assert.match(s, /gsd-statusline\.js/)
})

test('on refuses to save builder\'s own launcher as the previous line, however its path is written', () => {
  const dir = config()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${dir}//builder/statusline.mjs"` } }))
  const on = run(dir, 'on')
  assert.equal(on.status, 0, on.stdout + on.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'builder', 'statusline.prev.json'), 'utf8')), { statusLine: null })
})

test('a symlinked settings.json stays a symlink, and its target keeps its mode', () => {
  const dir = config()
  const dot = realpathSync(mkdtempSync(join(tmpdir(), 'dot-')))
  writeFileSync(join(dot, 'settings.json'), JSON.stringify({ statusLine: GSD }))
  chmodSync(join(dot, 'settings.json'), 0o600)
  symlinkSync(join(dot, 'settings.json'), join(dir, 'settings.json'))
  assert.equal(run(dir, 'on').status, 0)
  assert.ok(lstatSync(join(dir, 'settings.json')).isSymbolicLink(), 'still a symlink')
  assert.match(JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')).statusLine.command, /builder/)
  assert.equal(statSync(join(dot, 'settings.json')).mode & 0o777, 0o600)
  assert.equal(run(dir, 'off').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')), { statusLine: GSD })
})
