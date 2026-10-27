import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrainstormHeader, draftRows, openRevision, BRAINSTORM_FILE } from '../brainstorm-file.mjs'

const REG = 'docs/features'
const HEAD = (lines) => `# x — brainstorm\n${lines}\n\n## Intent\nOutcome.\n\n## Tree\n| # | Branch | Depends on | Status |\n| B1 | a | — | settled |\nstatus: handed-off\n`

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), 'bf-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}

test('the header is read up to the first blank line — a status: line in the body is ignored', () => {
  const root = ws({ [`.builder/a/${BRAINSTORM_FILE}`]: HEAD('status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 6 of 11') })
  assert.deepEqual(readBrainstormHeader(join(root, '.builder/a/brainstorm.md')), {
    status: 'exploring', size: null, source: 'brainstorm', input: 'abstract idea', updated: '2026-09-29T10:00:00Z', settled: { n: 6, m: 11 }, contradicted: null,
  })
})

test('sized carries its size; intake carries its contradicted count', () => {
  const root = ws({ '.builder/b/brainstorm.md': HEAD('status: sized md\nsource: intake\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 14 of 19\ncontradicted: 3') })
  const h = readBrainstormHeader(join(root, '.builder/b/brainstorm.md'))
  assert.equal(h.status, 'sized')
  assert.equal(h.size, 'md')
  assert.equal(h.contradicted, 3)
})

test('missing, empty or status-less files read as null', () => {
  const root = ws({ '.builder/e/brainstorm.md': '', '.builder/t/brainstorm.md': '# t — brainstorm\nsour' })
  assert.equal(readBrainstormHeader(join(root, '.builder/e/brainstorm.md')), null)
  assert.equal(readBrainstormHeader(join(root, '.builder/t/brainstorm.md')), null)
  assert.equal(readBrainstormHeader(join(root, '.builder/none/brainstorm.md')), null)
})

test('draftRows: one row per conversation in progress, with its state and command', () => {
  const root = ws({
    '.builder/explore/brainstorm.md': HEAD('status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 6 of 11'),
    '.builder/check/brainstorm.md': HEAD('status: confirmed\nsource: intake\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 14 of 19\ncontradicted: 3'),
    '.builder/ready/brainstorm.md': HEAD('status: sized md\nsource: brainstorm\ninput: brief\nupdated: 2026-09-29T10:00:00Z\nsettled: 9 of 9'),
    '.builder/small/brainstorm.md': HEAD('status: sized sm\nsource: brainstorm\ninput: directed request\nupdated: 2026-09-29T10:00:00Z\nsettled: 3 of 3'),
    '.builder/later/brainstorm.md': HEAD('status: parked\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 2 of 8'),
    '.builder/done/brainstorm.md': HEAD('status: handed-off\nsource: brainstorm\ninput: brief\nupdated: 2026-09-29T10:00:00Z\nsettled: 9 of 9'),
    '.builder/revise/brainstorm.md': HEAD('status: exploring\nsource: brainstorm\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 1 of 4'),
    [`${REG}/revise/SPEC.md`]: '# revise — spec\n',
    '.builder/fleet/fleet.json': '{}',
    '.builder/gates/baseline.json': '{}',
    '.builder/broken/brainstorm.md': '',
  })
  const rows = Object.fromEntries(draftRows(root, REG).map((r) => [r.feature, r]))
  assert.deepEqual(Object.keys(rows).sort(), ['broken', 'check', 'explore', 'later', 'ready', 'small'])
  assert.equal(rows.explore.state, 'brainstorming (6/11 settled)')
  assert.equal(rows.explore.command, `/builder:brainstorm --path ${REG}/explore`)
  assert.equal(rows.check.state, 'intake (3 contradicted, 14/19 settled)')
  assert.equal(rows.check.command, `/builder:intake --path ${REG}/check`)
  assert.equal(rows.ready.state, 'sized md — spec not written')
  assert.equal(rows.ready.command, `/builder:spec --path ${REG}/ready`)
  assert.equal(rows.small.command, `/builder:brainstorm --path ${REG}/small`)
  assert.equal(rows.later.state, 'parked idea (2/8 settled)')
  assert.equal(rows.broken.state, 'unreadable brainstorm.md')
  assert.equal(rows.explore.layout, 'brainstorm')
  assert.equal(rows.explore.done, false)
  assert.equal(rows.explore.path, `${REG}/explore`)
  assert.equal(rows.explore.updatedAt, '2026-09-29T10:00:00Z')
})

test('draftRows with no .builder dir is empty', () => {
  assert.deepEqual(draftRows(mkdtempSync(join(tmpdir(), 'bf-')), REG), [])
})

test('openRevision: the header of a conversation still open on a feature, null when handed off or missing', () => {
  const root = ws({
    '.builder/rev/brainstorm.md': HEAD('status: exploring\nsource: brainstorm\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 1 of 4'),
    '.builder/gone/brainstorm.md': HEAD('status: handed-off\nsource: brainstorm\ninput: brief\nupdated: 2026-09-29T10:00:00Z\nsettled: 4 of 4'),
  })
  assert.equal(openRevision(root, 'rev').status, 'exploring')
  assert.equal(openRevision(root, 'gone'), null)
  assert.equal(openRevision(root, 'none'), null)
})

test('stopping at understanding hands the record off, so it is never listed as in progress', () => {
  const root = ws({ '.builder/understood/brainstorm.md': HEAD('status: handed-off\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 5 of 5') })
  assert.deepEqual(draftRows(root, REG), [])
})

test('a record with a Discovery body still reads its header; a status-like line in Discovery is ignored', () => {
  const body = [
    '# tags — brainstorm',
    'status: exploring',
    'source: brainstorm',
    'input: abstract idea',
    'updated: 2026-10-21T10:00:00Z',
    'settled: 0 of 6',
    '',
    '## Intent',
    'Outcome: tags on notes (assumed)',
    '',
    '## Discovery',
    'Frame: for the person using the notes CLI · pain/outcome: finding notes by topic · today: by eye · better: filter by tag (assumed)',
    'What the product already has: a list command with no filters[^1]',
    'Research: skipped (a CLI with no screens — nothing to browse)',
    'Concepts:',
    '- Tag chips — tags shown inline and filterable · built from: the list line format · standing: chosen',
    '- Folders — a notebook per topic · built from: nothing existing · standing: rejected (heavier than the pain)',
    'Concept: tag chips — notes carry tags, list filters by one. status: parked',
    '',
    '## How it works today',
    'status: sized xl',
    '',
  ].join('\n')
  const root = ws({ [`.builder/tags/${BRAINSTORM_FILE}`]: body })
  const h = readBrainstormHeader(join(root, '.builder/tags/brainstorm.md'))
  assert.equal(h.status, 'exploring')
  assert.equal(h.size, null)
  assert.equal(h.input, 'abstract idea')
})

test('a brainstorm newer than an archived namesake is a new conversation; an older one is its leftover', async () => {
  const { draftRows, newerThanArchive } = await import('../brainstorm-file.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'bf-arch-'))
  mkdirSync(join(root, 'docs', 'features', '_archive', 'tags'), { recursive: true })
  mkdirSync(join(root, '.builder', 'tags'), { recursive: true })
  const spec = join(root, 'docs', 'features', '_archive', 'tags', 'SPEC.md')
  const draft = join(root, '.builder', 'tags', 'brainstorm.md')
  writeFileSync(spec, '# tags\n> ✅ SHIPPED\n')
  writeFileSync(draft, '---\nstatus: exploring\n---\n# tags, again\n')
  const t = (s) => new Date(Date.now() - s * 1000)
  utimesSync(spec, t(3600), t(3600))
  utimesSync(draft, t(60), t(60))
  assert.equal(newerThanArchive(root, 'docs/features', 'tags'), true)
  assert.deepEqual(draftRows(root, 'docs/features').map((r) => r.feature), ['tags'])
  utimesSync(draft, t(7200), t(7200))
  assert.equal(newerThanArchive(root, 'docs/features', 'tags'), false)
  assert.deepEqual(draftRows(root, 'docs/features'), [])
})
