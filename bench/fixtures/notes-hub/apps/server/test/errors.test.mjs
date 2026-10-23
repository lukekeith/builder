import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from './helpers.mjs'

test('unknown note, unknown route and wrong method', async (t) => {
  const s = await serve()
  t.after(s.close)
  assert.deepEqual(await s.call('GET', '/notes/9'), { status: 404, body: { error: 'no note 9' } })
  assert.equal((await s.call('GET', '/nope')).status, 404)
  assert.equal((await s.call('PUT', '/notes')).status, 405)
})

test('bad bodies are 400s', async (t) => {
  const s = await serve()
  t.after(s.close)
  assert.equal((await s.call('POST', '/notes', '{not json')).status, 400)
  assert.equal((await s.call('POST', '/notes', { text: '  ' })).status, 400)
})
