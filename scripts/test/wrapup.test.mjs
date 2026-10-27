import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { wrapSteps } from '../wrapup.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrapup.mjs')
const R = { apply: 'migrate apply', regenerate: 'prisma generate', restart: 'docker restart srv', fixtures: 'fixtures reset', smoke: 'curl health' }
const landed = [{ feature: 'groups-edit', target: 'main' }]

test('wrapSteps: every step in the order they stand on each other, with the commands from §Walk readiness', () => {
  const notes = ['⚠ groups-browse: 1 new migration landed — the dev DB is behind: run `migrate apply`', 'repo: 1 merged branch to delete → /builder:tidy']
  const { steps, held } = wrapSteps({ readiness: R, notes, landed, target: 'main', checkedOut: 'feat/x', tidyItems: [{ group: 'merged', action: 'delete', name: 'builder/groups-edit' }, { group: 'unknown', action: 'ask', name: 'spike' }] })
  assert.deepEqual(steps.map((s) => s.id), ['switch', 'migrate', 'restart', 'fixtures', 'smoke', 'tidy'])
  assert.deepEqual(steps.find((s) => s.id === 'migrate').commands, ['migrate apply', 'prisma generate'])
  assert.deepEqual(steps.find((s) => s.id === 'switch').commands, ['git switch main'])
  assert.match(steps.find((s) => s.id === 'tidy').commands[0], /tidy\.mjs" apply delete-branch "builder\/groups-edit"$/)
  assert.deepEqual(steps.find((s) => s.id === 'tidy').settles, ['repo: 1 merged branch to delete → /builder:tidy'])
  assert.deepEqual(held.map((h) => h.why), ['each needs a question of its own — /builder:tidy'])
})

test('wrapSteps holds what a wrap-up must not do on its own, and offers nothing with nothing to do', () => {
  const destructive = '⚠ render: 3 new migrations landed and x.sql drops or rewrites data, so it was not applied — check it'
  const r = wrapSteps({ readiness: R, notes: [destructive], landed: [], target: 'main', checkedOut: 'main' })
  assert.deepEqual(r.steps, [])
  assert.match(r.held[0].why, /may drop or rewrite data/)
  const dirty = wrapSteps({ readiness: {}, notes: [], landed, target: 'main', checkedOut: 'feat/x', treeClean: false })
  assert.deepEqual(dirty.steps, [])
  assert.match(dirty.held[0].why, /uncommitted changes/)
  // The dev DB already has them: the notes settle with nothing to run.
  const up = wrapSteps({ readiness: { ...R, pending: 'check' }, notes: ['⚠ a: 1 new migration landed — run x'], landed: [], target: 'main', checkedOut: 'main', pending: false })
  assert.deepEqual(up.steps.map((s) => [s.id, s.commands.length]), [['migrate', 0]])
  assert.deepEqual(wrapSteps({ readiness: R, landed: [], target: 'main', checkedOut: 'main' }), { steps: [], held: [] })
  // No restart:/fixtures: configured → only what is.
  assert.deepEqual(wrapSteps({ readiness: { apply: 'a' }, notes: ['⚠ a: 1 new migration landed — run a'], landed, target: 'main', checkedOut: 'main' }).steps.map((s) => s.id), ['migrate'])
})

function repo(readiness) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wrap-')))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), `---\nproject: t\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n---\n\n## Walk readiness\n\n\`\`\`\n${readiness}\n\`\`\`\n`)
  writeFileSync(join(root, '.gitignore'), '.builder/\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  return root
}
const wrap = (root, ...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

test('run: the chosen steps in order, the notes they settled cleared, the wrap-up marked done; a failure stops the rest', () => {
  const root = repo('apply:      echo applied >> ran.txt\nrestart:    echo restarted >> ran.txt\nfixtures:   exit 3\nsmoke:      echo smoke >> ran.txt')
  const note = '⚠ a: 1 new migration landed — the dev DB is behind: run `x`'
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ features: {}, notes: [note, 'other note'] }))
  writeFileSync(join(root, '.builder/fleet/archive.jsonl'), JSON.stringify({ feature: 'a', target: 'main', landedAt: new Date().toISOString() }) + '\n')
  const plan = JSON.parse(wrap(root, 'plan', '--json').stdout)
  assert.deepEqual(plan.steps.map((s) => s.id), ['migrate', 'restart', 'fixtures', 'smoke'])
  const r = wrap(root, 'run', 'all')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✓ migrate — [^\n]+\n✓ restart — [^\n]+\n✗ fixtures — failed; see [^\n]+wrapup\.log\n– smoke — not run: fixtures failed first/)
  assert.equal(readFileSync(join(root, 'ran.txt'), 'utf8'), 'applied\nrestarted\n')
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8')).notes, ['other note'], 'the migration note is settled, the rest stay')
  assert.ok(!existsSync(join(root, '.builder/fleet/wrapped')), 'a failed wrap-up is not done')
  // Run what is left; done, the next plan has nothing from these landings.
  const again = wrap(root, 'run', 'restart', 'smoke')
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.ok(existsSync(join(root, '.builder/fleet/wrapped')))
  assert.match(wrap(root, 'plan').stdout, /^Nothing to wrap up\./)
  assert.equal(wrap(root, 'run', 'bogus').status, 2)
})

test('dismiss marks the wrap-up done without running anything', () => {
  const root = repo('fixtures:   echo f >> ran.txt')
  writeFileSync(join(root, '.builder/fleet/fleet.json'), JSON.stringify({ features: {}, notes: [] }))
  writeFileSync(join(root, '.builder/fleet/archive.jsonl'), JSON.stringify({ feature: 'a', target: 'main', landedAt: new Date(Date.now() - 1000).toISOString() }) + '\n')
  assert.match(wrap(root, 'plan').stdout, /fixtures — reset the dev fixtures/)
  assert.equal(wrap(root, 'dismiss').status, 0)
  assert.match(wrap(root, 'plan').stdout, /^Nothing to wrap up\./)
  assert.ok(!existsSync(join(root, 'ran.txt')))
})
