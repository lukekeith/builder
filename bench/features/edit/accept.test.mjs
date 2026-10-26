import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes() {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  const env = { ...process.env, NOTES_FILE: file }
  const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env }).trim()
  run.raw = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
  return run
}

test('edit replaces the text, keeps the id, and says so', () => {
  const run = notes()
  run('add', 'buy milk')
  run('add', 'call mum')
  assert.equal(run('edit', '1', 'buy', 'oat', 'milk'), 'edited 1')
  assert.equal(run('show', '1'), 'buy oat milk')
  assert.equal(run('list'), '1  buy oat milk\n2  call mum')
})

test('edit of an unknown id fails like show and rm', () => {
  const run = notes()
  run('add', 'buy milk')
  const r = run.raw('edit', '9', 'x')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no note 9/)
})

test('edit with no text fails with the usage line, which names edit', () => {
  const run = notes()
  run('add', 'buy milk')
  for (const args of [['edit', '1'], ['edit', '1', '   ']]) {
    const r = run.raw(...args)
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /usage:.*edit/)
  }
  assert.equal(run('show', '1'), 'buy milk')
})
