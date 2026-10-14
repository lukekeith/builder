import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes(seed = null) {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  if (seed) writeFileSync(file, JSON.stringify(seed))
  return (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NOTES_FILE: file } }).trim()
}

test('add --tag stores tags and list shows them sorted', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop', '--tag', 'home')
  run('add', 'call mum')
  assert.equal(run('list'), '1  buy milk #home #shop\n2  call mum')
})

test('list --tag filters', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop')
  run('add', 'call mum', '--tag', 'family')
  run('add', 'buy bread', '--tag', 'shop')
  assert.equal(run('list', '--tag', 'shop'), '1  buy milk #shop\n3  buy bread #shop')
})

test('show prints tags on a second line', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop', '--tag', 'home')
  run('add', 'call mum')
  assert.equal(run('show', '1'), 'buy milk\ntags: home, shop')
  assert.equal(run('show', '2'), 'call mum')
})

test('tags lists every tag with its count', () => {
  const run = notes()
  run('add', 'a', '--tag', 'shop')
  run('add', 'b', '--tag', 'shop', '--tag', 'home')
  assert.equal(run('tags'), 'home  1\nshop  2')
})

test('tags prints nothing when no note is tagged', () => {
  const run = notes()
  run('add', 'a')
  assert.equal(run('tags'), '')
})

test('an invalid tag fails', () => {
  const run = notes()
  assert.throws(() => run('add', 'a', '--tag', 'Bad Tag'))
})

test('an old notes file without tags still works', () => {
  const run = notes({ nextId: 2, notes: [{ id: 1, text: 'old' }] })
  assert.equal(run('list'), '1  old')
  assert.equal(run('show', '1'), 'old')
  assert.equal(run('tags'), '')
})
