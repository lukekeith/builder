import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notes } from './helpers.mjs'

test('add prints the new id and list shows the note', () => {
  const run = notes()
  assert.equal(run('add', 'buy milk'), '1')
  assert.equal(run('add', 'call mum'), '2')
  assert.equal(run('list'), '1  buy milk\n2  call mum')
})

test('add joins its words into one note', () => {
  const run = notes()
  run('add', 'buy', 'oat', 'milk')
  assert.equal(run('list'), '1  buy oat milk')
})

test('list of an empty store prints nothing', () => {
  assert.equal(notes()('list'), '')
})
