import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planIndex, spliceIndex } from '../plan-slices.mjs'
import { leanRepo, run, git, readText, LEAN } from './fixtures/lean-repo.mjs'

const PLAN = readFileSync(join(LEAN, 'note-tags', 'PLAN.md'), 'utf8')
const INDEX = [
  '## Plan',
  '',
  'The plan, with its code: `docs/features/note-tags/PLAN.md` (§PLAN.md).',
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
