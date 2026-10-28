import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold, pickNext } from '../verify/schedule.mjs'

let t = 0
const r = (o) => ({ id: `r${++t}`, createdAt: new Date(1e12 + t * 1000).toISOString(), state: 'queued', target: 'main', ...o })

test('queued commit requests on one branch fold into the newest, carrying every commit in order', () => {
  const a = r({ branch: 'f', tier: 'commit', sha: 's1' })
  const b = r({ branch: 'g', tier: 'commit', sha: 'x1' })
  const c = r({ branch: 'f', tier: 'commit', sha: 's2' })
  const d = r({ branch: 'f', tier: 'phase', sha: 's2' })
  const e = r({ branch: 'f', tier: 'commit', sha: 's3' })
  const { keep, folded } = fold([a, b, c, d, e])
  assert.equal(keep.length, 3)
  const survivor = keep.find((x) => x.branch === 'f' && x.tier === 'commit')
  assert.equal(survivor.id, e.id)
  assert.deepEqual(survivor.commits, ['s1', 's2', 's3'])
  assert.deepEqual(survivor.foldedFrom, [a.id, c.id])
  assert.deepEqual(folded, [{ id: a.id, into: c.id }, { id: c.id, into: e.id }])
  assert.ok(keep.some((x) => x.id === d.id))
  assert.ok(keep.some((x) => x.id === b.id))
})

test('merge before phase before commit; oldest first within a tier', () => {
  const c = r({ branch: 'f', tier: 'commit' })
  const p = r({ branch: 'g', tier: 'phase' })
  const m = r({ branch: 'h', tier: 'merge' })
  assert.equal(pickNext([c, p, m], { running: [] }).id, m.id)
  assert.equal(pickNext([c, p], { running: [] }).id, p.id)
})

test('one merge per target at a time', () => {
  const m1 = r({ branch: 'h', tier: 'merge' })
  const m2 = r({ branch: 'i', tier: 'merge' })
  const m3 = r({ branch: 'j', tier: 'merge', target: 'release' })
  const c = r({ branch: 'f', tier: 'commit' })
  assert.equal(pickNext([m2, m3, c], { running: [m1] }).id, m3.id)
  assert.equal(pickNext([m2, c], { running: [m1] }).id, c.id)
})
