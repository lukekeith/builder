import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leanRepo, run, readText, LEAN } from './fixtures/lean-repo.mjs'
import { parseTesting, splitSteps, contractTokens, isRisk } from '../walk-script.mjs'
import { loadConfig } from '../config.mjs'

const WALK = (r) => join(r.root, '.builder', r.feature, 'walk.md')
const spec = (name) => readFileSync(join(LEAN, name, 'SPEC.md'), 'utf8')

test('splitSteps: on · when the script uses it, else on ; — never inside backticks', () => {
  assert.deepEqual(splitSteps('`a` → `1` · `b; c` → `2` · d'), ['`a` → `1`', '`b; c` → `2`', 'd'])
  assert.deepEqual(splitSteps('start it; with `x=1` add `y; z`; restart'), ['start it', 'with `x=1` add `y; z`', 'restart'])
})

test('parseTesting: single-app note-tags — 12 items for notes, the human-verification script as the cross-app steps', () => {
  const t = parseTesting(spec('note-tags'), ['notes'])
  assert.equal(t.apps.notes.length, 12)
  assert.match(t.apps.notes[0], /^`add buy milk --tag shop --tag home` prints `1`; `list` prints/)
  assert.match(t.cross.intro, /^Human-verification script \(run with `NOTES_FILE=\$\(mktemp -d\)\/n\.json`\)/)
  assert.equal(t.cross.steps.length, 7)
  assert.equal(t.cross.steps[6], '`add x --tag Bad; echo $?` → `invalid tag: Bad` on stderr, `1`.')
})

test('parseTesting: two apps (share) — server and cli bullets apart, the E2E paragraph split on ;', () => {
  const t = parseTesting(spec('share'), ['server', 'cli'])
  assert.equal(t.apps.server.length, 6)
  assert.equal(t.apps.cli.length, 5)
  assert.match(t.apps.server[0], /^POST: 201 shape, code format, default 7 days and `--days 30` expiry arithmetic/)
  assert.match(t.apps.cli[4], /^Token: first server command writes `ownerToken`/)
  assert.equal(t.cross.steps[0], 'start the server on `$PORT`')
  assert.equal(t.cross.steps.at(-1), '`curl -i` each route without the token → 401 `{ "error" }`.')
})

test('[risk]: a §Contract row, auth/permission, load/save/delete — and not plain output formatting', () => {
  const tokens = contractTokens(spec('note-tags'))
  assert.deepEqual(tokens.sort(), ['add', 'list', 'show', 'tags'])
  assert.equal(isRisk('`list --tag home` shows only notes with `home`', tokens), true)
  assert.equal(isRisk('Mixed list: an untagged note prints `<id>  <text>` unchanged beside tagged ones.', tokens), false)
  const share = contractTokens(spec('share'))
  assert.ok(share.includes('/shares') && share.includes('NOTES_NOW'))
  assert.equal(isRisk('GET /shares: only the caller\'s, oldest first', share), true)
  assert.equal(isRisk('a 401 without the header', []), true)
  assert.equal(isRisk('after `rm` of a note its count drops', []), true)
})

test('walk-script: note-tags under --agent-walk — per-app items newest-first with [risk], the orchestrator block, E1–E7', () => {
  const r = leanRepo('note-tags')
  const out = run('walk-script.mjs', [r.rel], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^wrote .*walk\.md — 12 items in 1 app \(11 \[risk\]\) \+ cross-app E1–E7/m)
  const w = readText(WALK(r))
  assert.match(w, /^# note-tags — walk script\n/)
  assert.match(w, /\n## notes\n\nWhere: `\.\/` — this checkout \(app\)\.\n/)
  assert.match(w, /<!-- orchestrator: notes[^>]*-->\n<!-- \/orchestrator -->/)
  assert.match(w, /\nNewest first:\n\n1\. \[risk\] Stored shape: after an untagged add/)
  assert.match(w, /\n11\. Mixed list: an untagged note prints/)
  assert.match(w, /\n12\. \[risk\] `add buy milk --tag shop --tag home` prints `1`/)
  assert.match(w, /\n## Cross-app \(verify E2E\)\n\nFrom SPEC §Testing — Human-verification script \(run with `NOTES_FILE=\$\(mktemp -d\)\/n\.json`\):\n\nE1\. `node src\/cli\.mjs add buy milk --tag shop --tag home` → `1`\n/)
  assert.match(w, /\nE7\. `add x --tag Bad; echo \$\?` → `invalid tag: Bad` on stderr, `1`\.\n/)
})

test('walk-script: without agent-walk there is no cross-app section; a re-run keeps what the orchestrator wrote', () => {
  const r = leanRepo('note-tags')
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace('agent-walk: on 2026-10-23', 'agent-walk: off'))
  run('walk-script.mjs', [r.rel], { cwd: r.root })
  let w = readText(WALK(r))
  assert.doesNotMatch(w, /Cross-app/)
  w = w.replace(/(<!-- orchestrator: notes[^>]*-->\n)/, '$1Setup: `export NOTES_FILE=$(mktemp -d)/n.json` — every command is `node src/cli.mjs …`.\n')
  writeFileSync(WALK(r), w)
  assert.equal(run('walk-script.mjs', [r.rel], { cwd: r.root }).status, 0)
  assert.equal(readText(WALK(r)), w)
  assert.match(run('walk-script.mjs', [r.rel, '--cross-app'], { cwd: r.root }).stdout, /\+ cross-app E1–E7/)
})

test('walk-script: share — a section per in-scope app with its landmines, the E2E steps; --print prints it', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const out = run('walk-script.mjs', [r.rel, '--cross-app', '--print'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /\n## server\n\nWhere: `apps\/server\/` — this checkout \(producer\)\./)
  assert.match(out.stdout, /\n## cli\n\nWhere: `apps\/cli\/` — this checkout \(consumer\)\./)
  assert.match(out.stdout, /Local facts \(the config's §Environment landmines\):\n- Test files run one at a time/)
  assert.match(out.stdout, /\nE1\. start the server on `\$PORT`\n/)
})

test('walk-script: an in-scope app §Testing says nothing about gets a section that says so', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const sp = join(r.folder, 'SPEC.md')
  writeFileSync(sp, readText(sp).replace(/\*\*cli\*\* \(`apps\/cli[\s\S]*?(?=\*\*Cross-app)/, ''))
  run('walk-script.mjs', [r.rel], { cwd: r.root })
  assert.match(readText(WALK(r)), /\n## cli\n[\s\S]*SPEC §Testing names nothing to walk in cli/)
})
