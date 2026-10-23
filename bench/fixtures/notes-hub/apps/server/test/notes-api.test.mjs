import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from './helpers.mjs'

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5)

test('POST /notes creates a note and GET reads it back', async (t) => {
  const s = await serve({ now: () => NOW })
  t.after(s.close)
  const made = await s.call('POST', '/notes', { text: '  buy milk ' })
  assert.deepEqual(made, { status: 201, body: { id: 1, text: 'buy milk', createdAt: '2026-01-02T03:04:05.000Z' } })
  assert.deepEqual((await s.call('GET', '/notes/1')).body.text, 'buy milk')
  assert.deepEqual((await s.call('GET', '/notes')).body.map((n) => n.id), [1])
})

test('DELETE /notes/:id removes the note', async (t) => {
  const s = await serve()
  t.after(s.close)
  await s.call('POST', '/notes', { text: 'a' })
  assert.equal((await s.call('DELETE', '/notes/1')).status, 204)
  assert.deepEqual((await s.call('GET', '/notes')).body, [])
})
