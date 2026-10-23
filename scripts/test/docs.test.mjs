import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { leanRepo, run } from './fixtures/lean-repo.mjs'
import { STEPS, bundle } from '../docs.mjs'

test('every step resolves: each mapped file and section exists in this checkout (a renamed heading fails here)', () => {
  for (const step of Object.keys(STEPS)) {
    const b = bundle(step, { config: false, prompts: true })
    assert.deepEqual(b.missing, [], `${step}: ${b.missing.join(', ')}`)
    assert.ok(b.sections.length >= 1, step)
  }
})

test('docs build: EXECUTION.md, the REFERENCE sections build names, the config — once each, with headings, no zsh-hostile separators', () => {
  const r = leanRepo('note-tags')
  const out = run('docs.mjs', ['build'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const s = out.stdout
  assert.match(s, /^# builder docs: build — \d+ sections, \d+ KB/)
  assert.match(s, /--- skills\/resume\/REFERENCE\.md §SPEC\.md \(lines \d+–\d+\) — includes §Contract and the contract freeze\n/)
  for (const h of ['skills/build/EXECUTION.md', 'REFERENCE.md §PLAN.md', 'REFERENCE.md §MANIFEST.md', 'REFERENCE.md §Branch and ticket', 'REFERENCE.md §Quality gates — the mechanism', 'REFERENCE.md §Walk readiness', 'REFERENCE.md §The craft skills', '.claude/builder.md'])
    assert.ok(s.includes(`--- ${h}`) || s.includes(`/${h}`), h)
  assert.match(s, /\n## Walk readiness\n/)
  assert.match(s, /\n# The execution engine — the task loop/)
  assert.match(s, /project: notes/)
  assert.doesNotMatch(s, /^={3,}/m)
  assert.equal(s.split('\n### §Contract and the contract freeze\n').length, 2, 'contract printed once')
  assert.doesNotMatch(s, /# Implementer subagent prompt/)
  assert.match(run('docs.mjs', ['build', '--prompts'], { cwd: r.root }).stdout, /# Implementer subagent prompt/)
})

test('docs walk-lane: §Walk readiness and build §When the last phase signs — what the walk lane read in 4 calls', () => {
  const r = leanRepo('note-tags')
  const s = run('docs.mjs', ['walk-lane', '--no-config'], { cwd: r.root }).stdout
  assert.match(s, /\n## Walk readiness\n/)
  assert.match(s, /\n## When the last phase signs\n/)
  assert.doesNotMatch(s, /\n## Build here\n/)
  assert.doesNotMatch(s, /project: notes/)
})

test('docs brainstorm: CONVERSATION.md plus exactly the four sections it names — §Sizes, §The classifier, §The review, §Walk readiness', () => {
  const s = run('docs.mjs', ['brainstorm', '--no-config'], { cwd: leanRepo('note-tags').root }).stdout
  assert.match(s, /--- skills\/brainstorm\/CONVERSATION\.md/)
  assert.match(s, /\n## Sizes\n/)
  assert.match(s, /\n## The classifier\n/)
  assert.match(s, /\n## The review — what an approval shows\n/)
  assert.match(s, /\n## Walk readiness\n/)
  assert.doesNotMatch(s, /\n## Flags\n/)
})

test('docs: --list names every step and what it prints; an unknown step is a usage error', () => {
  const r = leanRepo('note-tags')
  const l = run('docs.mjs', ['--list'], { cwd: r.root })
  assert.equal(l.status, 0)
  for (const step of Object.keys(STEPS)) assert.match(l.stdout, new RegExp(`^${step}\\b`, 'm'))
  assert.equal(run('docs.mjs', ['nope'], { cwd: r.root }).status, 2)
  assert.equal(run('docs.mjs', [], { cwd: r.root }).status, 2)
})
