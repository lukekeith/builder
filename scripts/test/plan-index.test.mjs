import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planIndex, spliceIndex, overProportion } from '../plan-slices.mjs'
import { leanRepo, run, git, readText, LEAN } from './fixtures/lean-repo.mjs'

const PLAN = readFileSync(join(LEAN, 'note-tags', 'PLAN.md'), 'utf8')
const INDEX = [
  '## Plan',
  '',
  'The plan, task by task: `docs/features/note-tags/PLAN.md` (§PLAN.md).',
  '',
  '- Phase 1 · Task 1 · Tag parsing, `add --tag`, and the tagged `list` line',
  '- Phase 1 · Task 2 · `list --tag <t>` filter',
  '- Phase 2 · Task 3 · `show` tags line, `notes tags`, old files, README, contract freeze',
].join('\n')

test('planIndex: REFERENCE §Plan — the pointer, then Phase N · Task M · <name>, one per task', () => {
  assert.equal(planIndex(PLAN, 'docs/features/note-tags'), INDEX)
})

test('planIndex: the ## Phases table decides the phase; a block Phase: line is the fallback', () => {
  const plan = ['## Phases', '', '| Phase | App | Tasks | Goal | Gates |', '|---|---|---|---|---|', '| 1 | api | 1 | x | y |', '| 2 | web | 2-3 | x | y |', '',
    '### Task 1: A', 'Phase: 9', '### Task 2: B', '### Task 3: C', '### Task 4: D', 'Phase: 3'].join('\n')
  assert.deepEqual(planIndex(plan, 'f').split('\n').slice(4), ['- Phase 1 · Task 1 · A', '- Phase 2 · Task 2 · B', '- Phase 2 · Task 3 · C', '- Phase 3 · Task 4 · D'])
})

test('spliceIndex: after §Findings & risks, before a later section; replaces an old index by its heading; idempotent', () => {
  const spec = '# x — spec\n\n## Testing\n\nt\n\n## Findings & risks\n\n| # | F | R |\n|---|---|---|\n\n## Replaced surfaces\n\nr\n\n## Fixes\n\n- [ ] a\n'
  const once = spliceIndex(spec, INDEX)
  assert.equal(once, '# x — spec\n\n## Testing\n\nt\n\n## Findings & risks\n\n| # | F | R |\n|---|---|---|\n\n' + INDEX + '\n\n## Replaced surfaces\n\nr\n\n## Fixes\n\n- [ ] a\n')
  assert.equal(spliceIndex(once, INDEX), once)
  const stale = once.replace('Task 2 · `list --tag <t>` filter', 'Task 2 · old name')
  assert.equal(spliceIndex(stale, INDEX), once)
  assert.equal(spliceIndex('# y\n\n## Idea\n\ni\n', INDEX), '# y\n\n## Idea\n\ni\n\n' + INDEX + '\n')
})

test('CLI: --index prints it; --index --write puts it in SPEC.md once, however often it runs', () => {
  const r = leanRepo('note-tags')
  const p = run('plan-slices.mjs', [r.rel, '--index'], { cwd: r.root })
  assert.equal(p.status, 0, p.stderr)
  assert.equal(p.stdout, INDEX + '\n')
  for (let i = 0; i < 2; i++) {
    const w = run('plan-slices.mjs', [r.rel, '--index', '--write'], { cwd: r.root })
    assert.equal(w.status, 0, w.stderr)
  }
  const spec = readText(join(r.folder, 'SPEC.md'))
  assert.equal(spec.split('\n## Plan\n').length, 2)
  assert.ok(spec.endsWith(INDEX + '\n'))
  assert.match(spec, /\| F2 \|.*\n\n## Plan\n/)
})

test('overProportion: a plan over 2× its SPEC (and over 16 KB) is refused; the §Plan index does not count; a tiny plan never is', () => {
  const spec = 'x'.repeat(10 * 1024)
  assert.equal(overProportion('p'.repeat(20 * 1024), spec), null, 'exactly 2× is in proportion')
  assert.match(overProportion('p'.repeat(25 * 1024), spec), /^PLAN\.md is 2\.5× its SPEC \(25\.0 KB vs 10\.0 KB\) — over 2×/)
  assert.equal(overProportion('p'.repeat(15 * 1024), 'x'.repeat(1024)), null, 'under 16 KB: never nagged')
  assert.equal(overProportion('p'.repeat(25 * 1024), spec + '\n## Plan\n\n' + '- Phase 1 · Task 1 · a\n'.repeat(10)), overProportion('p'.repeat(25 * 1024), spec))
})

test('CLI: --index --write refuses an over-long plan with exit 3 and leaves SPEC.md alone', () => {
  const r = leanRepo('note-tags')
  const before = readText(join(r.folder, 'SPEC.md'))
  writeFileSync(join(r.folder, 'PLAN.md'), PLAN + '\n```js\n' + '// transcript\n'.repeat(Math.ceil((before.length * 2.2) / 14)) + '```\n')
  const w = run('plan-slices.mjs', [r.rel, '--index', '--write'], { cwd: r.root })
  assert.equal(w.status, 3)
  assert.match(w.stderr, /over 2×, a transcript of the code \(PLAN-FORMAT §Self-review 7\)/)
  assert.equal(readText(join(r.folder, 'SPEC.md')), before)
})
