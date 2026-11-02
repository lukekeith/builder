// scripts/test/release-notes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notesFor } from '../release-notes.mjs'

const CL = '# Changelog\n\nintro\n\n## 2.0.0\n\n**Big.** Lead.\n\n- one\n\n## 1.10.0\n\nolder\n\n## 1.9.0\n\n## 1.0.0\n\nfirst\n'
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-notes.mjs')

test('notesFor: the section under its heading, up to the next version, trimmed', () => {
  assert.equal(notesFor(CL, '2.0.0'), '**Big.** Lead.\n\n- one')
  assert.equal(notesFor(CL, '1.10.0'), 'older')
  assert.equal(notesFor(CL, '1.0.0'), 'first')
  assert.equal(notesFor(CL.replace(/\n/g, '\r\n'), '1.10.0'), 'older')
})

test('notesFor: no section, or an empty one, is null — never a prefix match', () => {
  assert.equal(notesFor(CL, '3.0.0'), null)
  assert.equal(notesFor(CL, '1.9.0'), null)
  assert.equal(notesFor(CL, '1.1'), null)
})

test('the CLI prints the notes, and refuses a version with none', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'rn-')), 'CHANGELOG.md')
  writeFileSync(f, CL)
  const ok = spawnSync(process.execPath, [SCRIPT, '2.0.0', '--changelog', f], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(ok.stdout, '**Big.** Lead.\n\n- one\n')
  const none = spawnSync(process.execPath, [SCRIPT, '1.9.0', '--changelog', f], { encoding: 'utf8' })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no notes under "## 1\.9\.0"/)
})

test('the real changelog has notes for the version in plugin.json', async () => {
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const { version } = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.ok(notesFor(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version), `CHANGELOG.md has no notes for ${version}`)
})
