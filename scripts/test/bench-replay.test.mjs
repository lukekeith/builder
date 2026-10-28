// scripts/test/bench-replay.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../verify/git.mjs'
import { featureRange, phaseBoundaries, controlPoints, summarize, isInside } from '../bench-replay-core.mjs'

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
