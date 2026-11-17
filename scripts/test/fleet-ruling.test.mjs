import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseRulings, rulingLine, rulingsFile } from '../fleet-ruling.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet-ruling.mjs')

test('rulingLine and parseRulings: one line a ruling, read back as each feature’s paths, once each', () => {
  const l1 = rulingLine({ date: '2026-11-16', feature: 'tags', paths: ['./app/shared.js', 'api\\routes.js'], ruling: 'tags owns the shared\n  helper' })
  assert.equal(l1, '- 2026-11-16 tags: tags owns the shared helper (paths: app/shared.js, api/routes.js)\n')
  const l2 = rulingLine({ date: '2026-11-16', feature: 'tags', paths: ['app/shared.js', 'app/x.js'], ruling: 'and x (see D3)' })
  const l3 = rulingLine({ date: '2026-11-16', feature: 'share', paths: ['app/y.js'], ruling: 'y' })
  assert.deepEqual(parseRulings(`# rulings\n${l1}${l2}${l3}not a ruling\n`), { tags: ['app/shared.js', 'api/routes.js', 'app/x.js'], share: ['app/y.js'] })
  // Parentheses in the ruling and in a path (a route group): the last `(paths: …)` holds the paths.
  const l4 = rulingLine({ date: '2026-11-16', feature: 'auth', paths: ['app/(auth)/login.tsx'], ruling: 'login moves (see D3)' })
  assert.deepEqual(parseRulings(l4), { auth: ['app/(auth)/login.tsx'] })
})

test('fleet-ruling.mjs appends to $BUILDER_FLEET_DIR/rulings.md; with no fleet, to the repo’s .builder/fleet from a worktree too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruling-'))
  const r = spawnSync('node', [SCRIPT, 'tags', 'app/shared.js', '--', 'tags', 'owns', 'it'], { encoding: 'utf8', env: { ...process.env, BUILDER_FLEET_DIR: dir } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(dir, 'rulings.md'), 'utf8'), /^- \d{4}-\d{2}-\d{2} tags: tags owns it \(paths: app\/shared\.js\)\n$/)
  spawnSync('node', [SCRIPT, 'tags', 'app/x.js', '--', 'x too'], { env: { ...process.env, BUILDER_FLEET_DIR: dir } })
  assert.deepEqual(parseRulings(readFileSync(join(dir, 'rulings.md'), 'utf8')).tags, ['app/shared.js', 'app/x.js'])

  const repo = mkdtempSync(join(tmpdir(), 'ruling-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  const wt = `${repo}-wt`
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'w', wt], { cwd: repo })
  const env = { ...process.env }
  delete env.BUILDER_FLEET_DIR
  assert.equal(rulingsFile({ env, cwd: wt }), join(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim(), '.builder/fleet/rulings.md'))
})

test('fleet-ruling.mjs refuses a call with no paths, no ruling, a bad feature name or a path out of the repo', () => {
  const env = { ...process.env, BUILDER_FLEET_DIR: mkdtempSync(join(tmpdir(), 'ruling-')) }
  for (const args of [['tags', '--', 'no paths'], ['tags', 'app/a.js'], ['tags', 'app/a.js', '--'], ['ta gs', 'a', '--', 'x'], ['tags', '/etc/x', '--', 'x'], ['tags', '../x', '--', 'x'], ['tags', 'api\\..\\x', '--', 'x'], ['tags', 'a,b.js', '--', 'x']]) {
    const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env })
    assert.equal(r.status, 2, args.join(' '))
  }
  assert.equal(existsSync(join(env.BUILDER_FLEET_DIR, 'rulings.md')), false)
})
