import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notes } from './helpers.mjs'

test('show of a missing id fails with a message', () => {
  assert.throws(() => notes()('show', '9'), /no note 9/)
})

test('rm of a missing id fails with a message', () => {
  assert.throws(() => notes()('rm', '9'), /no note 9/)
})

test('no command prints usage and fails', () => {
  assert.throws(() => notes()(), /usage: notes/)
})

test('add with no text prints usage and fails', () => {
  assert.throws(() => notes()('add'), /usage: notes/)
})
