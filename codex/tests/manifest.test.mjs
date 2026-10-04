import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest, isSet } from '../scripts/manifest.mjs'

test('parses key/value lines, keeps a PR reference, drops comments', () => {
  const mf = parseManifest(
    'state: built   # trailing comment\npr: #12\nhold: "PR #9 must land first"\nchild: a — spec\nchild: b — shipped\n'
  )
  assert.equal(mf.state, 'built')
  assert.equal(mf.pr, '#12')
  assert.equal(mf.hold, '"PR #9 must land first"')
  assert.deepEqual(mf.children, ['a — spec', 'b — shipped'])
})

test('reads the new blocked: and agent-walk: keys', () => {
  const mf = parseManifest('blocked: "plan wants to split — clears when you split it"\nagent-walk: on 2026-09-26\n')
  assert.equal(mf.blocked, '"plan wants to split — clears when you split it"')
  assert.equal(mf['agent-walk'], 'on 2026-09-26')
})

test('isSet treats absent, empty and none as unset', () => {
  assert.equal(isSet(undefined), false)
  assert.equal(isSet(null), false)
  assert.equal(isSet(''), false)
  assert.equal(isSet('none'), false)
  assert.equal(isSet('#4'), true)
})
