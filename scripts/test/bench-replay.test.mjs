// scripts/test/bench-replay.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../verify/git.mjs'
import { featureRange, phaseBoundaries, controlPoints, touchedApps, normPath, summarize, isInside, saveCarry, seedCarry, verdictOf } from '../bench-replay-core.mjs'

const apps = [{ name: 'server', path: 'server' }, { name: 'web', path: 'web' }]

test('phase boundaries: runs of one app; docs-only commits join the run before them', () => {
  const cs = [
    { sha: 'a', files: ['docs/features/x/SPEC.md'] },
    { sha: 'b', files: ['server/a.ts'] },
    { sha: 'c', files: ['server/b.ts', 'docs/features/x/MANIFEST.md'] },
    { sha: 'd', files: ['docs/features/x/progress.md'] },
    { sha: 'e', files: ['web/a.tsx'] },
    { sha: 'f', files: ['web/b.tsx'] },
  ]
  assert.deepEqual(phaseBoundaries(cs, apps, 'docs/features'), [{ index: 3, app: 'server' }, { index: 5, app: 'web' }])
  const pts = controlPoints(phaseBoundaries(cs, apps, 'docs/features'), cs.map((c) => c.sha), apps)
  assert.deepEqual(pts.map((p) => [p.sha, p.args.join(' '), p.label]), [
    ['d', 'server', 'phase server'],
    ['f', 'web', 'phase web'],
    ['f', 'server web', 'end gates'],
    ['f', '--deep server web', 'verify deep'],
  ])
})

test('featureRange reads a merge commit', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'brp-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  writeFileSync(join(root, 'a'), '1')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'a')
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-qb', 'f')
  for (const n of ['b', 'c']) {
    writeFileSync(join(root, n), n)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', n)
  }
  const tip = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  git(root, 'merge', '--no-ff', '-qm', 'm', 'f')
  const r = featureRange(root, git(root, 'rev-parse', 'HEAD'))
  assert.equal(r.base, base)
  assert.equal(r.tip, tip)
  assert.equal(r.commits.length, 2)
})

test('summarize: a row per feature and totals', () => {
  const md = summarize([
    { feature: 'x', control: { blockingMs: 600000, reds: 2 }, treatment: { blockingMs: 120000, backgroundMs: 300000, regressions: 1, flakes: 1, known: 2, debt: 0, broken: 0 } },
    { feature: 'y', control: { blockingMs: 300000, reds: 0 }, treatment: { blockingMs: 60000, backgroundMs: 60000, regressions: 0, flakes: 0, known: 0, debt: 1, broken: 0 } },
  ])
  assert.match(md, /\| x \| 10m \| 2 \| 2m \| 5m \| 1 \| 1 \| 2 \| 0 \| 0 \|/)
  assert.match(md, /\| \*\*total\*\* \| 15m \| 2 \| 3m \| 6m \| 1 \| 1 \| 2 \| 1 \| 0 \|/)
  assert.match(md, /blocking time: 80% less/)
})

test('summarize: unrun control runs get a column; errored features are listed, not tabulated', () => {
  const md = summarize([
    { feature: 'x', control: { blockingMs: 60000, reds: 0, unrun: 1 }, treatment: { blockingMs: 0, backgroundMs: 0, regressions: 0, flakes: 0, known: 0, debt: 0, broken: 0 } },
    { feature: 'bad', error: 'setup exited 3' },
  ])
  assert.match(md, /Old gates: unrun \|/)
  assert.match(md, /\| x \| 1m \| 0 \| 0m \| 0m \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \|/)
  assert.doesNotMatch(md, /\| bad \|/)
  assert.match(md, /errored \(not in the table\): bad — setup exited 3/)
})

test('isInside: the repo itself and anything under it, not a sibling with the same prefix', () => {
  assert.equal(isInside('/r/app', '/r/app'), true)
  assert.equal(isInside('/r/app', '/r/app/.builder/bench'), true)
  assert.equal(isInside('/r/app', '/r/app-bench'), false)
})

test('app paths with a trailing slash or ./ still map files to their app', () => {
  assert.deepEqual(['apps/server/', './apps/web', '.', './', ''].map(normPath), ['apps/server', 'apps/web', '.', '.', '.'])
  const slashed = [{ name: 'server', path: 'apps/server/' }, { name: 'web', path: './apps/web/' }]
  const cs = [{ sha: 'a', files: ['apps/server/x.ts'] }, { sha: 'b', files: ['apps/web/y.tsx'] }]
  assert.deepEqual(phaseBoundaries(cs, slashed, 'docs/features'), [{ index: 0, app: 'server' }, { index: 1, app: 'web' }])
})

test('with no phase mapped to an app, the end gates run every configured app and say why', () => {
  assert.deepEqual(touchedApps([], apps), ['server', 'web'])
  const pts = controlPoints([], ['a'], apps)
  assert.deepEqual(pts.map((p) => [p.args.join(' '), p.label]), [
    ['server web', 'end gates (no app touched: all apps)'],
    ['--deep server web', 'verify deep (no app touched: all apps)'],
  ])
})

test('carry: the learned known failures and flakes move to the next clone; per-run files do not', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'carry-')))
  const one = join(tmp, 'one')
  mkdirSync(join(one, 'requests'), { recursive: true })
  writeFileSync(join(one, 'known-failures.json'), JSON.stringify({ 'replay-target': { sha: 'x', ids: ['s::a::1', 's::a::2'] } }))
  writeFileSync(join(one, 'flakes.json'), JSON.stringify({ 's::b::3': { flips: 1, cleanStreak: 0 } }))
  writeFileSync(join(one, 'results.jsonl'), '{}\n')
  writeFileSync(join(one, 'requests', 'r.json'), '{}')
  const carry = join(tmp, 'carry')
  saveCarry(one, carry)
  assert.equal(existsSync(join(carry, 'results.jsonl')), false)
  assert.equal(existsSync(join(carry, 'requests')), false)
  const two = join(tmp, 'two')
  assert.equal(seedCarry(carry, two), 3)
  assert.deepEqual(JSON.parse(readFileSync(join(two, 'known-failures.json'), 'utf8'))['replay-target'].ids, ['s::a::1', 's::a::2'])
  assert.equal(existsSync(join(two, 'results.jsonl')), false)
})

test('carry: nothing learned yet seeds nothing', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'carry-')))
  saveCarry(join(tmp, 'none'), join(tmp, 'carry'))
  assert.equal(seedCarry(join(tmp, 'carry'), join(tmp, 'two')), 0)
})

test('verdictOf: a verdict longer than any output tail still parses, past a pending line before it', () => {
  const v = { status: 'green', known: Array.from({ length: 200 }, (_, i) => `server::apps/server/test/t${i}.test.ts::a long test name ${i}`) }
  const stdout = `pending: commit running abc\n${JSON.stringify(v, null, 2)}\n`
  assert.ok(stdout.length > 4000)
  assert.deepEqual(verdictOf(stdout), v)
  assert.equal(verdictOf('no json here'), null)
})
