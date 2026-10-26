// Context budgets. Every enabled plugin's skill descriptions sit in every session's context, and
// Claude Code drops the least-used descriptions when the listing overflows its share of the window
// — so a long description costs every user every turn, and can push another skill's out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const skills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const frontmatter = (s) => readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8').split(/^---$/m)[1] ?? ''
const description = (s) => (frontmatter(s).match(/^description: (.*)$/m) ?? [])[1] ?? ''

const EACH = 400 // chars; Anthropic's hard limit is 1,024
const TOTAL = 7500 // chars across every skill — about 2k tokens always on

test('every skill has a description of at most 400 chars', () => {
  for (const s of skills) {
    const d = description(s)
    assert.ok(d.length > 0, `${s}: no description`)
    assert.ok(d.length <= EACH, `${s}: description is ${d.length} chars (max ${EACH})`)
  }
})

test('all descriptions together stay within the always-on budget', () => {
  const total = skills.reduce((n, s) => n + description(s).length, 0)
  assert.ok(total <= TOTAL, `descriptions total ${total} chars (max ${TOTAL})`)
})

test('the maintainer-only benchmark never loads into a consumer session', () => {
  assert.match(frontmatter('benchmark'), /^disable-model-invocation: true$/m)
})

// Anthropic's skill guidance: SKILL.md under 500 lines; a reference file over 100 lines opens with a
// table of contents, so a partial read still shows what the file holds.
const VENDORED = ['test-driven-development', 'systematic-debugging'] // upstream's files, kept as written

test('every SKILL.md is under 500 lines', () => {
  for (const s of skills) {
    const n = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8').split('\n').length
    assert.ok(n < 500, `skills/${s}/SKILL.md is ${n} lines — move a section into a reference file beside it`)
  }
})

test('every reference file over 100 lines opens with a Contents line naming each section', () => {
  for (const s of skills.filter((x) => !VENDORED.includes(x)))
    for (const f of readdirSync(join(ROOT, 'skills', s)).filter((x) => x.endsWith('.md') && x !== 'SKILL.md')) {
      const t = readFileSync(join(ROOT, 'skills', s, f), 'utf8')
      if (t.split('\n').length <= 100) continue
      const toc = t.split('\n').slice(0, 15).find((l) => l.startsWith('**Contents:**'))
      assert.ok(toc, `skills/${s}/${f}: no **Contents:** line in its first 15 lines`)
      let fenced = false
      for (const l of t.split('\n')) {
        if (l.startsWith('```')) fenced = !fenced
        else if (!fenced && l.startsWith('## ')) assert.ok(toc.includes(`§${l.slice(3).trim()}`), `skills/${s}/${f}: Contents is missing §${l.slice(3).trim()}`)
      }
    }
})
