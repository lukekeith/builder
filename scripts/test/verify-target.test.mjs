// scripts/test/verify-target.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landingTarget, manifestTarget } from '../verify/target.mjs'

function registry(features) {
  const wt = mkdtempSync(join(tmpdir(), 'vtgt-'))
  for (const [name, body] of Object.entries(features)) {
    mkdirSync(join(wt, 'docs', 'features', name), { recursive: true })
    if (body != null) writeFileSync(join(wt, 'docs', 'features', name, 'MANIFEST.md'), body)
  }
  mkdirSync(join(wt, 'docs', 'features', '_archive', 'old'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'features', '_archive', 'old', 'MANIFEST.md'), 'branch: feat/x\ntarget: wrong\n')
  return wt
}
const cfg = (mergeInto = 'main') => ({ ok: true, registry: 'docs/features', mergeInto })

test('manifestTarget: the feature whose branch: is this one, or the fleet\'s builder/<feature>; quotes stripped; archived folders skipped', () => {
  const wt = registry({ a: 'branch: feat/x\ntarget: "feature/stack"\n', b: 'branch: feat/y\ntarget: other\n', c: 'target: feature/c\n', d: null })
  assert.equal(manifestTarget(wt, 'docs/features', 'feat/x'), 'feature/stack')
  assert.equal(manifestTarget(wt, 'docs/features', 'builder/c'), 'feature/c')
  assert.equal(manifestTarget(wt, 'docs/features', 'feat/none'), null)
  assert.equal(manifestTarget(join(wt, 'nowhere'), 'docs/features', 'feat/x'), null)
})

test('manifestTarget: two features on one branch naming different targets → no guess; the same one → it', () => {
  assert.equal(manifestTarget(registry({ a: 'branch: shared\ntarget: one\n', b: 'branch: shared\ntarget: two\n' }), 'docs/features', 'shared'), null)
  assert.equal(manifestTarget(registry({ a: 'branch: shared\ntarget: one\n', b: 'branch: shared\ntarget: one\n', c: 'branch: shared\ntarget: none\n' }), 'docs/features', 'shared'), 'one')
})

test('landingTarget: --target, then BUILDER_TARGET, then the manifest, then merge_into, then main', () => {
  const wt = registry({ a: 'branch: feat/x\ntarget: feature/stack\n' })
  const at = (o) => landingTarget({ wt, branch: 'feat/x', cfg: cfg('develop'), env: {}, ...o })
  assert.equal(at({ explicit: 'given' }), 'given')
  assert.equal(at({ env: { BUILDER_TARGET: 'fleet-into' } }), 'fleet-into')
  assert.equal(at({ env: { BUILDER_TARGET: '' } }), 'feature/stack')
  assert.equal(at({}), 'feature/stack')
  assert.equal(at({ branch: 'other' }), 'develop')
  assert.equal(landingTarget({ wt, branch: 'other', cfg: { ok: false }, env: {} }), 'main')
})
