import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notes } from './helpers.mjs'

test('show prints one note and rm removes it', () => {
  const run = notes()
  run('add', 'buy milk')
  run('add', 'call mum')
  assert.equal(run('show', '2'), 'call mum')
  assert.equal(run('rm', '1'), 'removed 1')
  assert.equal(run('list'), '2  call mum')
})

test('ids are never reused after rm', () => {
  const run = notes()
  run('add', 'a')
  run('rm', '1')
  assert.equal(run('add', 'b'), '2')
})
