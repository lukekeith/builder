import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laneOf, decide, loadFleet, saveFleet, renderStatus, fleetDir } from '../fleet-core.mjs'

test('laneOf routes each state', () => {
  assert.equal(laneOf({ state: 'spec' }), 'build')
  assert.equal(laneOf({ state: 'building' }), 'build')
  assert.equal(laneOf({ state: 'building', ready: 'pending "dev env (fleet walk lane)"' }), 'walk')
  assert.equal(laneOf({ state: 'built' }), 'walk')
  assert.equal(laneOf({ state: 'verified' }), 'walk')
  assert.equal(laneOf({ state: 'verified', pr: '#3' }), 'done')
  assert.equal(laneOf({ state: 'shipped' }), 'done')
  assert.equal(laneOf({ state: 'audited', blocked: '"x"' }), 'blocked')
  assert.equal(laneOf({ state: 'audited', blocked: 'none' }), 'build')
  assert.equal(laneOf({ state: 'weird' }), 'unknown')
})

const base = { lane: 'build', exit: 0, failures: 0, runs: 1, cap: 12, progressed: true }
const mf = (s) => `size: md\n${s}\nnext: x\n`

test('a failed run is retried once, then fails', () => {
  assert.deepEqual(decide({ ...base, exit: 3, manifestText: mf('state: spec') }), { action: 'retry' })
  const d = decide({ ...base, exit: 3, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /failed \(exit 3\) twice/)
})

test('a timeout counts as a failure', () => {
  const d = decide({ ...base, exit: null, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /timed out twice/)
})

test('blocked parks with the reason, unquoted', () => {
  const d = decide({ ...base, manifestText: mf('state: audited\nblocked: "plan wants to split"') })
  assert.deepEqual(d, { action: 'park', reason: 'plan wants to split' })
})

test('a PR means done', () => {
  assert.deepEqual(decide({ ...base, lane: 'walk', manifestText: mf('state: verified\npr: #7') }), { action: 'done', pr: '#7' })
})

test('the build lane hands off once the feature needs the dev env', () => {
  const d = decide({ ...base, manifestText: mf('state: building\nready: pending "dev env (fleet walk lane)"') })
  assert.deepEqual(d, { action: 'handoff' })
})

test('no progress parks', () => {
  const d = decide({ ...base, progressed: false, manifestText: mf('state: planned') })
  assert.equal(d.action, 'park')
  assert.match(d.reason, /no progress/)
})

test('the run cap parks', () => {
  const d = decide({ ...base, runs: 12, manifestText: mf('state: planned') })
  assert.deepEqual(d, { action: 'park', reason: 'run cap (12) reached' })
})

test('progress under the cap runs again', () => {
  assert.deepEqual(decide({ ...base, manifestText: mf('state: planned') }), { action: 'again' })
})

test('a missing manifest or unknown state parks', () => {
  assert.equal(decide({ ...base, manifestText: null }).action, 'park')
  assert.match(decide({ ...base, manifestText: mf('state: weird') }).reason, /weird/)
})

test('saveFleet writes fleet.json atomically, STATUS.md, and the .builder ignore', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const fleet = {
    features: {
      b: { status: 'parked', runs: 2, branch: 'builder/b', worktree: '/w/b', pr: null, reason: 'x | y' },
      a: { status: 'done', runs: 7, branch: 'builder/a', worktree: '/w/a', pr: '#1', reason: null },
    },
    notes: ['No agent_walk.reset — dev-DB state accumulates from one walk to the next.'],
  }
  saveFleet(root, fleet)
  assert.deepEqual(loadFleet(root), fleet)
  assert.equal(existsSync(join(fleetDir(root), 'fleet.json.tmp')), false)
  assert.equal(readFileSync(join(root, '.builder/.gitignore'), 'utf8'), '*\n')
  const status = readFileSync(join(fleetDir(root), 'STATUS.md'), 'utf8')
  assert.match(status, /2 feature\(s\): 1 done · 1 parked|2 feature\(s\): 1 parked · 1 done/)
  assert.ok(status.indexOf('| a |') < status.indexOf('| b |'), 'rows sorted by feature')
  assert.match(status, /x \\\| y/, 'pipes escaped')
  assert.match(status, /- No agent_walk.reset/)
})

test('loadFleet on a fresh repo is empty', () => {
  assert.deepEqual(loadFleet(mkdtempSync(join(tmpdir(), 'fc-'))), { features: {} })
})

test('renderStatus with nothing in it', () => {
  assert.match(renderStatus({ features: {} }), /0 feature\(s\): none/)
})
