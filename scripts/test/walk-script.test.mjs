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

test('walk-script: note-tags (one app) under --agent-walk — the verification script is the walk, no E steps, no per-app test items', () => {
  const r = leanRepo('note-tags')
  const out = run('walk-script.mjs', [r.rel], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^wrote .*walk\.md — 7 items in 1 app \(7 \[risk\]\) \(one app: the verification script is its walk — no cross-app section, the per-app test items left to the verifier\)/m)
  const w = readText(WALK(r))
  assert.match(w, /^# note-tags — walk script\n/)
  assert.match(w, /\n## notes\n\nWhere: `\.\/` — this checkout \(app\)\.\n/)
  assert.match(w, /<!-- orchestrator: notes[^>]*-->\n<!-- \/orchestrator -->/)
  assert.match(w, /The verification script \(SPEC §Testing — Human-verification script/)
  assert.match(w, /\n1\. \[risk\] `node src\/cli\.mjs add buy milk --tag shop --tag home` → `1`\n/)
  assert.match(w, /\n7\. \[risk\] `add x --tag Bad; echo \$\?` → `invalid tag: Bad` on stderr, `1`\.\n/)
  assert.doesNotMatch(w, /Cross-app|\nE1\.|Stored shape/)
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
  assert.match(run('walk-script.mjs', [r.rel, '--cross-app'], { cwd: r.root }).stdout, /one app: the verification script is its walk/)
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

test('walk-script: two apps with the cross-app section — the per-app test items are the verifier\'s, not walk items', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const out = run('walk-script.mjs', [r.rel, '--cross-app', '--print'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /§Testing's 6 server test items — what its tests prove — are the verifier's; server is walked in the cross-app section below\./)
  assert.doesNotMatch(out.stdout, /Newest first|POST: 201 shape|Token: first server command/)
  assert.match(out.stdout, /— 0 items in 2 apps \(0 \[risk\]\) \+ cross-app E1–E/)
  // without the cross-app section there is nothing else to walk: the per-app items stay
  const off = run('walk-script.mjs', [r.rel, '--no-cross-app', '--print'], { cwd: r.root })
  assert.match(off.stdout, /Newest first:[\s\S]*POST: 201 shape/)
})

test('walk-script: an app item no test is named for — a check on a screen — stays a walk item beside the cross-app section', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const sp = join(r.folder, 'SPEC.md')
  writeFileSync(sp, readText(sp).replace(/\*\*Cross-app E2E walk\*\*/, '**cli by hand**: in a narrow terminal:\n- a long note wraps under its code in `shares`\n\n**Cross-app E2E walk**'))
  const out = run('walk-script.mjs', [r.rel, '--cross-app', '--print'], { cwd: r.root })
  assert.match(out.stdout, /\n## cli\n[\s\S]*Newest first:\n\n1\. a long note wraps under its code in `shares`\n/)
  assert.match(out.stdout, /§Testing's \d+ cli test items — what its tests prove — are the verifier's\.\n/)
  assert.doesNotMatch(out.stdout, /`share` prints only a code/)
})

test('parseTesting: a fenced script is one step per line; a later human-verification note is not more steps; a test run is [verifier]', () => {
  const s = spec('share').replace(/\*\*Cross-app E2E walk\*\*[\s\S]*?(?=\n## |$)/, [
    '**The cross-app E2E walk** — two scratch notes files.',
    '```',
    'NOTES_FILE=A notes add "buy milk"   → 1',
    'NOTES_FILE=A notes share 1          → a code alone',
    'node --test apps/cli/test/fetch.test.mjs   → the expiry test passes',
    '```',
    '',
    '**The human-verification script** is that walk, plus expiry: run `node --test apps/server/test/shares-env.test.mjs`; restart by hand.',
    '',
  ].join('\n'))
  const t = parseTesting(s, ['server', 'cli'])
  assert.equal(t.cross.intro, 'The cross-app E2E walk')
  assert.deepEqual(t.cross.steps, ['NOTES_FILE=A notes add "buy milk"   → 1', 'NOTES_FILE=A notes share 1          → a code alone', 'node --test apps/cli/test/fetch.test.mjs   → the expiry test passes'])
  const r = leanRepo('share', { feature: 'note-sharing' })
  writeFileSync(join(r.folder, 'SPEC.md'), s)
  const out = run('walk-script.mjs', [r.rel, '--cross-app', '--print'], { cwd: r.root })
  assert.match(out.stdout, /\nE3\. \[verifier\] node --test apps\/cli\/test\/fetch\.test\.mjs/)
  assert.match(out.stdout, /\nE1\. NOTES_FILE=A notes add "buy milk"/)
  assert.doesNotMatch(out.stdout, /E4\.|restart by hand|```/)
})

test('walk-script: an in-scope app §Testing says nothing about gets a section that says so', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace(/^agent-walk:.*$/m, 'agent-walk: off'))
  const sp = join(r.folder, 'SPEC.md')
  writeFileSync(sp, readText(sp).replace(/\*\*cli\*\* \(`apps\/cli[\s\S]*?(?=\*\*Cross-app)/, ''))
  run('walk-script.mjs', [r.rel], { cwd: r.root })
  assert.match(readText(WALK(r)), /\n## cli\n[\s\S]*SPEC §Testing names nothing to walk in cli/)
})

test('walk-script: a fleet build (BUILDER_FLEET_DIR) writes the cross-app section with no agent-walk line; without either it does not', () => {
  const r = leanRepo('share', { feature: 'note-sharing' })
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).split('\n').filter((l) => !l.startsWith('agent-walk:')).join('\n'))
  run('walk-script.mjs', [r.rel], { cwd: r.root, env: { BUILDER_FLEET_DIR: '' } })
  assert.doesNotMatch(readText(WALK(r)), /Cross-app/)
  run('walk-script.mjs', [r.rel], { cwd: r.root, env: { BUILDER_FLEET_DIR: '/tmp/fleet' } })
  assert.match(readText(WALK(r)), /Cross-app/)
})
