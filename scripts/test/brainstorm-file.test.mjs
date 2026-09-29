import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrainstormHeader, draftRows, BRAINSTORM_FILE } from '../brainstorm-file.mjs'

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
