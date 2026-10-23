import '../../../test-support/slow.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from './helpers.mjs'

test('GET /health answers ok', async (t) => {
  const s = await serve()
  t.after(s.close)
  assert.deepEqual(await s.call('GET', '/health'), { status: 200, body: { ok: true } })
})
