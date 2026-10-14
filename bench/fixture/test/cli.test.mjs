import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes() {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  return (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NOTES_FILE: file } }).trim()
}

test('add prints the new id and list shows the note', () => {
  const run = notes()
  assert.equal(run('add', 'buy milk'), '1')
  assert.equal(run('add', 'call mum'), '2')
  assert.equal(run('list'), '1  buy milk\n2  call mum')
})

test('show prints one note and rm removes it', () => {
  const run = notes()
  run('add', 'buy milk')
  run('add', 'call mum')
  assert.equal(run('show', '2'), 'call mum')
  assert.equal(run('rm', '1'), 'removed 1')
  assert.equal(run('list'), '2  call mum')
})

test('show of a missing id fails with a message', () => {
  const run = notes()
  assert.throws(() => run('show', '9'), /no note 9/)
})

test('no command prints usage and fails', () => {
  const run = notes()
  assert.throws(() => run(), /usage: notes/)
})
