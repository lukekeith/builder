// scripts/test/verify-git.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sh } from '../verify/git.mjs'

test('sh: a command past its timeout is killed and throws promptly, saying so', () => {
  const t0 = Date.now()
  assert.throws(() => sh('sleep 5; true', { timeout: 200 }), /timed out after 0\.2s/)
  assert.ok(Date.now() - t0 < 2000)
})

test('sh: a command inside its timeout returns its stdout', () => {
  assert.equal(sh('echo hi', { timeout: 5000 }).trim(), 'hi')
})
