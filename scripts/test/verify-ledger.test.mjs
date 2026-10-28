import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, FLAKE_CLEAR } from '../verify/ledger.mjs'

const fresh = () => openLedger(mkdtempSync(join(tmpdir(), 'vlg-')))

test('results append and read back by sha', () => {
  const l = fresh()
  l.appendResults([{ run: 'r1', sha: 'a', id: 'x', status: 'pass' }, { run: 'r1', sha: 'b', id: 'x', status: 'fail' }])
  assert.deepEqual([...l.resultsAt('a')], [['x', 'pass']])
  assert.equal(readFileSync(join(l.dir, '..', '.gitignore'), 'utf8'), '*\n')
})

test('known failures per target: set, add, remove', () => {
  const l = fresh()
  l.setKnown('main', 's1', ['a', 'b'])
  l.addKnown('main', ['c'])
  l.removeKnown('main', ['a'])
  assert.deepEqual([...l.known('main').ids].sort(), ['b', 'c'])
  assert.equal(l.known('other').ids.size, 0)
})

test('a flake is listed on its first flip and cleared after FLAKE_CLEAR clean runs in a row', () => {
  const l = fresh()
  l.recordFlip('t')
  assert.equal(l.isFlaky('t'), true)
  for (let i = 0; i < FLAKE_CLEAR - 1; i++) l.recordClean(['t'])
  assert.equal(l.isFlaky('t'), true)
  l.recordFlip('t')
  assert.equal(l.flakes().t.cleanStreak, 0)
  assert.equal(l.flakes().t.flips, 2)
  for (let i = 0; i < FLAKE_CLEAR; i++) l.recordClean(['t', 'not-listed'])
  assert.equal(l.isFlaky('t'), false)
  assert.equal(l.isFlaky('not-listed'), false)
})

test('requests: create, save, list in order; verdictFor and lastGreen read done ones', () => {
  const l = fresh()
  const a = l.newRequest({ branch: 'f', sha: 's1', tier: 'commit', target: 'main' })
  const b = l.newRequest({ branch: 'f', sha: 's2', tier: 'commit', target: 'main' })
  assert.equal(a.state, 'queued')
  assert.deepEqual(l.requests().map((r) => r.id), [a.id, b.id])
  assert.equal(l.verdictFor('f'), null)
  l.saveRequest({ ...a, state: 'done', verdict: { status: 'green', sha: 's1' } })
  l.saveRequest({ ...b, state: 'done', verdict: { status: 'red', sha: 's2' } })
  assert.equal(l.verdictFor('f').status, 'red')
  assert.equal(l.verdictFor('f', 's1').status, 'green')
  assert.equal(l.lastGreen('f').sha, 's1')
})

test('check output lines cached per target sha', () => {
  const l = fresh()
  assert.equal(l.readLines('s', 'lint'), null)
  l.writeLines('s', 'lint', ['a', 'b'])
  assert.deepEqual([...l.readLines('s', 'lint')], ['a', 'b'])
})
