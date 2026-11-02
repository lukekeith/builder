// A worker's brief carries the project's environment landmines and the ledger's env notes, so the
// coordinator never repeats them and a fresh worker meets them before they bite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { envNotesOf, landminesOf, briefContext } from '../scripts/brief.mjs'

const script = fileURLToPath(new URL('../scripts/brief.mjs', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
const CONFIG = '---\napps:\n  - name: web\n---\n\n## Global constraints\n\n- keep it small\n\n## Environment landmines\n\n- The API does not reload: restart it after a schema change.\n- Run prisma from `apps/api`.\n\n## Standing traps\n\n- never this\n'
const LEDGER = '# ledger\n\nTask 1: complete (commits a..b)\n\n## env notes\n\n- The test DB needs `pnpm db:reset` first.\n  Then `pnpm db:seed`.\n- Port 5433, not 5432.\n\nTask 2: complete (commits b..c)\n'

function fixture(t, { config = CONFIG, ledger = LEDGER } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brief-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (config !== null) { mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex', 'builder.md'), config) }
  const feature = join(root, 'docs', 'features', 'f'); mkdirSync(feature, { recursive: true })
  if (ledger !== null) writeFileSync(join(feature, 'ledger.md'), ledger)
  const brief = join(root, '.builder', 'f', 'task-1-brief.md'); mkdirSync(join(root, '.builder', 'f'), { recursive: true })
  writeFileSync(brief, '### Task 1: do it\nApp: web\n')
  return { root, ledger: join(feature, 'ledger.md'), brief }
}

test('the landmines section is read verbatim from the config Codex selects, stopping at the next section', () => {
  assert.equal(landminesOf(CONFIG), '- The API does not reload: restart it after a schema change.\n- Run prisma from `apps/api`.')
  assert.equal(landminesOf('---\napps: []\n---\n## Standing traps\n- x\n'), '')
})

test('env notes are the bullets (and their continuation lines) under every ## env notes heading', () => {
  assert.equal(envNotesOf(LEDGER), '- The test DB needs `pnpm db:reset` first.\n  Then `pnpm db:seed`.\n- Port 5433, not 5432.')
  assert.equal(envNotesOf('# ledger\nTask 1: complete\n'), '')
  assert.equal(envNotesOf('## Env notes (this machine)\n- a\n\n## env notes\n- b\n'), '- a\n- b')
})

test('briefContext names each block as the project config\'s or the ledger\'s', () => {
  const text = briefContext({ landmines: '- a', envNotes: '- b' })
  assert.match(text, /^## Environment landmines \(the project config's, verbatim\)\n\n- a\n\n## Environment notes \(the ledger's\)\n\n- b\n$/)
  assert.equal(briefContext({ landmines: '', envNotes: '' }), '')
})

test('the CLI appends both blocks to the brief once; a re-run replaces them instead of duplicating', (t) => {
  const f = fixture(t)
  let run = cli(f.brief, '--ledger', f.ledger, '--root', f.root)
  assert.equal(run.status, 0, run.stderr)
  const once = readFileSync(f.brief, 'utf8')
  assert.match(once, /^### Task 1: do it\nApp: web\n\n## Environment landmines \(the project config's, verbatim\)\n\n- The API does not reload/)
  assert.match(once, /## Environment notes \(the ledger's\)\n\n- The test DB needs `pnpm db:reset` first\.\n {2}Then `pnpm db:seed`\.\n- Port 5433, not 5432\.\n$/)
  writeFileSync(f.ledger, LEDGER + '\n## env notes\n- Redis must be up.\n')
  run = cli(f.brief, '--ledger', f.ledger, '--root', f.root)
  assert.equal(run.status, 0, run.stderr)
  const twice = readFileSync(f.brief, 'utf8')
  assert.equal(twice.match(/## Environment landmines/g).length, 1)
  assert.match(twice, /- Redis must be up\.\n$/)
})

test('the CLI leaves the brief alone when there is nothing to add, and refuses a missing brief', (t) => {
  const f = fixture(t, { config: null, ledger: null })
  const run = cli(f.brief, '--ledger', f.ledger, '--root', f.root)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(readFileSync(f.brief, 'utf8'), '### Task 1: do it\nApp: web\n')
  assert.equal(cli(join(f.root, 'nope.md'), '--root', f.root).status, 2)
  assert.equal(cli().status, 2)
})
