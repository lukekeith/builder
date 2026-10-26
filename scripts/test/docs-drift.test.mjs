// The docs a user reads first are checked against the skills that exist, so a count, a command or a
// renamed skill can't go stale in them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const skills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'skills', d.name, 'SKILL.md'))).map((d) => d.name)
const DOCS = ['README.md', 'docs/guide.md', 'skills/help/SKILL.md']

test('the README names every skill', () => {
  const readme = read('README.md')
  for (const s of skills) assert.match(readme, new RegExp(`/builder:${s}\\b`), `README.md never names /builder:${s}`)
})

test('no doc names a /builder: command that does not exist', () => {
  for (const f of DOCS)
    for (const [, name] of read(f).matchAll(/\/builder:([a-z][a-z-]*[a-z])/g))
      assert.ok(skills.includes(name), `${f} names /builder:${name}, which is not a skill`)
})

test('no doc states a skill count', () => {
  // Counts went stale twice ("19 skills", "13 pipeline skills" with 30 in the tree) — say what, not how many.
  for (const f of [...DOCS, '.claude-plugin/plugin.json'])
    assert.doesNotMatch(read(f), /\b\d+ (pipeline |craft )?skills\b/, f)
})

test('the guide has one way to vendor, and the template names no retired profile wording', () => {
  assert.doesNotMatch(read('docs/guide.md'), /^### Vendoring it instead$/m)
  assert.doesNotMatch(read('PROJECT.template.md'), /when the spec doesn't call for Thorough/)
})
