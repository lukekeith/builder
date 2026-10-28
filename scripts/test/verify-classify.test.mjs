// scripts/test/verify-classify.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../verify/classify.mjs'

const f = { id: 's::t.test.ts::x', file: 't.test.ts', name: 'x', msg: 'boom' }
const ctx = (o = {}) => {
  const calls = []
  return {
    calls,
    known: new Set(),
    isFlaky: () => false,
    branchOwns: () => false,
    rerunHere: async () => (calls.push('here'), 'fail'),
    rerunOnTarget: async () => (calls.push('target'), 'pass'),
    ...o,
  }
}

test('known on the target: ignored, nothing re-run', async () => {
  const c = ctx({ known: new Set([f.id]) })
  assert.deepEqual(await classify(f, c), { kind: 'known' })
  assert.deepEqual(c.calls, [])
})

test('already flake-listed: recorded only', async () => {
  const c = ctx({ isFlaky: () => true })
  assert.deepEqual(await classify(f, c), { kind: 'flake', listed: true })
  assert.deepEqual(c.calls, [])
})

test('passes on a re-run here: a new flake — unless the branch owns the test', async () => {
  assert.deepEqual(await classify(f, ctx({ rerunHere: async () => 'pass' })), { kind: 'flake', listed: false })
  assert.deepEqual(await classify(f, ctx({ rerunHere: async () => 'pass', branchOwns: () => true })), { kind: 'regression', note: 'flaky test this branch owns' })
})

test('fails here and on the target: debt; fails only here: regression', async () => {
  assert.deepEqual(await classify(f, ctx({ rerunOnTarget: async () => 'fail' })), { kind: 'debt' })
  const c = ctx()
  assert.deepEqual(await classify(f, c), { kind: 'regression' })
  assert.deepEqual(c.calls, ['here', 'target'])
  assert.deepEqual(await classify(f, ctx({ rerunOnTarget: async () => 'missing' })), { kind: 'regression' })
})

test('the re-run on the target could not run: broken, never a regression', async () => {
  assert.deepEqual(await classify(f, ctx({ rerunOnTarget: async () => 'broken' })), { kind: 'broken' })
})
