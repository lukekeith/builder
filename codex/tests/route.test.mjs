import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../scripts/route.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('mechanical work is cheap; prose implementation and reviewers have a standard floor', () => {
  assert.equal(route('mechanical').tier, 'fast')
  assert.equal(route('implementation').tier, 'standard')
  assert.equal(route('mechanical-review').tier, 'standard')
  assert.equal(route('final-review').tier, 'judgment')
})
test('project mapping and effort override defaults without changing role semantics', () => {
  assert.deepEqual(route('inventory', { models: { fast: 'local-fast', fast_effort: 'low' } }),
    { role: 'inventory', tier: 'fast', model: 'local-fast', effort: 'low', fallback: false })
})
test('escalation increases reasoning tier and unavailable roles never silently downgrade', () => {
  assert.equal(route('implementation', { escalate: true }).tier, 'judgment')
  assert.equal(route('audit', { available: ['gpt-6-luna'] }).unavailable, true)
  const fallback = route('inventory', { available: ['gpt-6.1-sol'] })
  assert.equal(fallback.model, 'gpt-6.1-sol')
  assert.equal(fallback.fallback, true)
})
test('CLI refuses malformed authoritative config instead of silently routing with defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'builder-route-'))
  try {
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.codex/builder.md'), 'not valid config\n')
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('../scripts/route.mjs', import.meta.url)), 'final-review'],
      { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /frontmatter/)
    assert.equal(result.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('custom strong model profile elevates implementation and keeps inventories economical', () => {
  assert.equal(route('implementation', { profile: 'custom models=strong' }).tier, 'judgment');
  assert.equal(route('inventory', { profile: 'custom models=strong' }).tier, 'fast');
  assert.equal(route('final-review', { profile: 'rush' }).tier, 'judgment');
});
