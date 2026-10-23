import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { load, save } from '../src/store.mjs'

const scratch = () => join(mkdtempSync(join(tmpdir(), 'store-')), 'notes.json')

test('load of a missing file is an empty store', () => {
  assert.deepEqual(load(scratch()), { nextId: 1, notes: [] })
})

test('save then load round-trips the store', () => {
  const file = scratch()
  save({ nextId: 3, notes: [{ id: 2, text: 'x' }] }, file)
  assert.deepEqual(load(file), { nextId: 3, notes: [{ id: 2, text: 'x' }] })
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
})
