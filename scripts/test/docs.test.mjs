import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  for (const h of ['skills/build/EXECUTION.md', 'REFERENCE.md §PLAN.md', 'REFERENCE.md §MANIFEST.md', 'REFERENCE.md §Branch and ticket', 'REFERENCE.md §The verifier', 'REFERENCE.md §Walk readiness', 'REFERENCE.md §The craft skills', '.claude/builder.md'])
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

const BUILD_BEFORE = [['skills/build/EXECUTION.md', null], ...['Contract and the contract freeze', 'PLAN.md', 'SPEC.md', 'MANIFEST.md', 'Branch and ticket', 'The verifier', 'Walk readiness', 'The craft skills'].map((n) => ['skills/resume/REFERENCE.md', n]), ['<config>', null]]
const fleetRun = (args) => run('docs.mjs', args, { cwd: leanRepo('note-tags').root })

const MOVE_NEXT = 'Keep at least 3,000 of margin; when over, move text out of the bundle for `docs.mjs section` in this order: AGENT-MODE §--agent-walk\'s readiness-only rows ("Dev-DB migrations", "Starting or restarting the dev env"), then REFERENCE §Contract and the contract freeze'
const over = (n) => `${n} chars: ${n - 30000} over the 30,000 limit. ${MOVE_NEXT}`
test('the fleet build\'s first read is two Bash calls, each ≤ 30,000 chars: fleet-build --no-config, then fleet-setup (EXECUTION §Setup + the config, printed once)', () => {
  const one = fleetRun(['fleet-build', '--no-config'])
  assert.equal(one.status, 0, one.stderr)
  assert.ok(one.stdout.length <= 30000, over(one.stdout.length))
  assert.doesNotMatch(one.stdout, /^--- .*\.claude\/builder\.md/m)
  const two = fleetRun(['fleet-setup'])
  assert.equal(two.status, 0, two.stderr)
  assert.ok(two.stdout.length <= 30000, over(two.stdout.length))
  assert.match(two.stdout, /^--- skills\/build\/EXECUTION\.md §Setup \(lines/m)
  assert.equal((two.stdout.match(/^--- .*\.claude\/builder\.md/gm) ?? []).length, 1, 'the config, once')
  const fixtureConfig = readFileSync(join(import.meta.dirname, 'fixtures', 'lean', 'note-tags', 'builder.md'), 'utf8').trim()
  assert.ok(two.stdout.includes(fixtureConfig.split('\n')[0]))
})
test('fleet-build carries the loop and the rules a fleet build needs', () => {
  const out = fleetRun(['fleet-build']).stdout
  for (const h of ['§The task loop', '§The verifier', '§PLAN.md', '§Contract and the contract freeze', '§--agent-walk']) assert.match(out, new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))  // the label drops backticks, as normTitle does
  for (const h of ['§SPEC.md', '§MANIFEST.md', '§Walk readiness']) assert.doesNotMatch(out, new RegExp(`--- .*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`))
})
test('section prints one heading, and fails naming a missing one', () => {
  assert.match(fleetRun(['section', 'skills/build/SKILL.md', 'When the last phase signs']).stdout, /When the last phase signs/)
  const r = fleetRun(['section', 'skills/build/SKILL.md', 'No such heading'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /No such heading/)
})
test('build (the human bundle) is unchanged', () => assert.deepEqual(STEPS.build, BUILD_BEFORE))
