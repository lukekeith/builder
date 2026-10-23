import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.mjs'

test('an in-memory store inserts, updates and removes', () => {
  const s = createStore()
  assert.deepEqual(s.insert('notes', { text: 'a' }), { id: 1, text: 'a' })
  assert.deepEqual(s.update('notes', 1, { text: 'b' }), { id: 1, text: 'b' })
  assert.equal(s.remove('notes', 1), true)
  assert.equal(s.remove('notes', 1), false)
  assert.deepEqual(s.all('notes'), [])
})

test('a file store survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'store-')), 'store.json')
  createStore(file).insert('notes', { text: 'kept' })
  const again = createStore(file)
  assert.deepEqual(again.all('notes'), [{ id: 1, text: 'kept' }])
  assert.equal(again.insert('notes', { text: 'next' }).id, 2)
})
