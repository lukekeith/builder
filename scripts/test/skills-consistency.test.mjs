import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('CONVERSATION.md carries every section the two conversation skills cite', () => {
  const c = read('skills/brainstorm/CONVERSATION.md')
  for (const s of ['The record', 'Rounds', 'Approaches', 'Confirm', 'Size and the small path', 'Steering and --auto']) assert.match(c, new RegExp(`^## ${s}$`, 'm'), s)
  for (const v of ['exploring', 'confirmed', 'sized', 'parked', 'handed-off']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
  for (const v of ['open', 'settled', 'assumed', 'stated', 'confirmed', 'contradicted', 'unverifiable']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
})

test('REFERENCE §SPEC.md opens with §Idea and keeps rulings operational', () => {
  const r = read('skills/resume/REFERENCE.md')
  const spec = r.slice(r.indexOf('## SPEC.md'), r.indexOf('### §Apps'))
  assert.ok(spec.indexOf('## Idea') > 0 && spec.indexOf('## Idea') < spec.indexOf('## Apps'), '§Idea comes before §Apps')
  assert.doesNotMatch(spec, /^## Overview/m)
  assert.match(spec, /In your words/)
  assert.match(spec, /Target ≤ 350 lines/)
  assert.match(spec, /why the rejected option lost/)
  assert.match(spec, /NEVER quote the user's prompt as the ruling/)
})

test('brainstorm is the exploration conversation: no REFERENCE load, no design flag, sizing after confirm', () => {
  const b = read('skills/brainstorm/SKILL.md')
  assert.match(b, /^name: brainstorm$/m)
  assert.match(b, /CONVERSATION\.md/)
  assert.doesNotMatch(b, /Load REFERENCE/)
  assert.doesNotMatch(b, /Phase 1P|Prototype mode|design\.resolver/)
  assert.match(b, /\/builder:intake/)
  assert.match(b, /\/builder:spec/)
  assert.ok(b.indexOf('## Intent') < b.indexOf('## Size'), 'intent comes before sizing')
})

test('intake verifies claims, owns prototype mode, and shares the record', () => {
  const i = read('skills/intake/SKILL.md')
  assert.match(i, /^name: intake$/m)
  assert.match(i, /CONVERSATION\.md/)
  for (const s of ['confirmed', 'contradicted', 'unverifiable', 'stated']) assert.match(i, new RegExp(`\\b${s}\\b`))
  assert.match(i, /SCOPE-SELECTION\.md/)
  assert.match(i, /source: intake/)
  assert.match(i, /\/builder:spec/)
  for (const re of [/DONE check/, /never REFERENCE wholesale/, /replaces §1–§3/, /§Prototype seams/]) assert.match(i, re)
})

test('spec needs a sized record, loads REFERENCE, writes §Idea first and hands off', () => {
  const s = read('skills/spec/SKILL.md')
  assert.match(s, /^name: spec$/m)
  assert.match(s, /status: sized/)
  assert.match(s, /Load REFERENCE/)
  assert.match(s, /§Idea/)
  assert.match(s, /check-obligations\.mjs/)
  assert.match(s, /handed-off/)
  assert.match(s, /\/builder:resume --path/)
  assert.match(s, /confirmed/)
  assert.match(s, /OPEN/)
  assert.match(s, /sized xl/)
  assert.match(s, /contradicted/)
  assert.match(s, /fixed in the design/)
  assert.doesNotMatch(s, /--size xl/)
})

test('no skill routes a design ref to brainstorm; resume knows the record; help names the entries', () => {
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const p = `skills/${dir}/SKILL.md`
    if (!existsSync(join(ROOT, p))) continue
    assert.doesNotMatch(read(p), /\/builder:brainstorm --<(design\.)?flag>/, p)
  }
  const r = read('skills/resume/SKILL.md')
  assert.match(r, /brainstorm\.md/)
  assert.match(r, /\/builder:spec/)
  assert.match(r, /\/builder:intake/)
  const h = read('skills/help/SKILL.md')
  assert.match(h, /\/builder:intake/)
  assert.match(h, /\/builder:spec/)
  assert.match(read('.claude-plugin/plugin.json'), /"version": "4\.0\.0"/)
  assert.match(read('CHANGELOG.md'), /^## 4\.0\.0$/m)
  const sizeDocs = readdirSync(join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((p) => existsSync(join(ROOT, p)))
  for (const p of [...sizeDocs, 'skills/resume/REFERENCE.md', 'README.md']) assert.doesNotMatch(read(p), /--size\b/, p)
})

test('every status value is handled somewhere, and every section cited in CONVERSATION.md exists', () => {
  const skills = ['brainstorm/SKILL.md', 'brainstorm/CONVERSATION.md', 'intake/SKILL.md', 'spec/SKILL.md', 'resume/SKILL.md'].map((p) => read(`skills/${p}`)).join('\n')
  for (const s of ['exploring', 'confirmed', 'sized', 'parked', 'handed-off']) assert.match(skills, new RegExp(`\\b${s}\\b`), s)
  // Real headings only: the record template's fenced `## Intent … ## Size` are not sections of the file.
  const conv = read('skills/brainstorm/CONVERSATION.md').replace(/```[\s\S]*?```/g, '')
  const headings = conv.match(/^## .+$/gm).map((h) => h.slice(3).trim())
  // A citation is a chain — `CONVERSATION §Approaches, §Confirm and §Size and the small path` — and a
  // section name may itself contain " and", so each link must START with a real heading (longest wins).
  let cited = 0
  for (const p of ['brainstorm/SKILL.md', 'intake/SKILL.md']) {
    const text = read(`skills/${p}`).replace(/\s+/g, ' ')
    for (const m of text.matchAll(/CONVERSATION §/g)) {
      let rest = text.slice(m.index + m[0].length)
      for (;;) {
        const h = headings.filter((x) => rest.startsWith(x) && !/[A-Za-z]/.test(rest[x.length] ?? '')).sort((a, b) => b.length - a.length)[0]
        assert.ok(h, `${p} cites CONVERSATION §${rest.slice(0, 40)}`)
        cited++
        rest = rest.slice(h.length)
        const link = /^(?:,| and|, and) §/.exec(rest)
        if (!link) break
        rest = rest.slice(link[0].length)
      }
    }
  }
  assert.ok(cited >= 9, `found ${cited} CONVERSATION citations`)
})
