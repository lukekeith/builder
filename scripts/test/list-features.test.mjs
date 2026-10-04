import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'list-features.mjs')

function setup(manifests, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lf-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  mkdirSync(join(root, 'docs/features'), { recursive: true })
  for (const [name, body] of Object.entries(manifests)) {
    mkdirSync(join(root, 'docs/features', name), { recursive: true })
    writeFileSync(join(root, 'docs/features', name, 'MANIFEST.md'), `size: md\nnext: x\n${body}\n`)
  }
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'docs/features', path)), { recursive: true })
    writeFileSync(join(root, 'docs/features', path), body)
  }
  return root
}
const list = (root, ...args) => spawnSync('node', [LIST, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

function repo(manifests, files = {}) {
  const r = list(setup(manifests, files), '--json')
  assert.equal(r.status, 0, r.stderr)
  return Object.fromEntries(JSON.parse(r.stdout).features.map((f) => [f.feature, f]))
}

test('a parked feature says so, with its reason', () => {
  const rows = repo({ p: 'state: audited\nblocked: "plan wants to split — clears when you split it"' })
  assert.equal(rows.p.nextStep, '⛔ parked — plan wants to split — clears when you split it')
})

test('an agent-signed-off feature is not reported as human-walked; agent mode takes it to merged', () => {
  const rows = repo({
    a: 'state: built\nwalk: agent-pass 2026-09-26 abc123\nagent-walk: on 2026-09-26',
    s: 'state: signed-off\nwalk: agent-pass 2026-09-26 abc123\nagent-walk: on 2026-09-26',
    v: 'state: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc123\npr: #5\nagent-walk: on 2026-09-26',
    h: 'state: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc123\npr: #6\nagent-walk: off',
  })
  assert.equal(rows.a.lastDone, 'Agent-walked — not human-tested')
  assert.equal(rows.a.nextStep, 'Agent sign-off, then deep verify')
  assert.equal(rows.s.lastDone, 'Agent signed off — not human-tested')
  assert.equal(rows.v.nextStep, 'Ship and merge into the fleet branch (agent)')
  assert.equal(rows.h.nextStep, 'Review the PR, then /builder:signoff')
})

test('an agent-walk run at built says the agent walks next', () => {
  const rows = repo({ b: 'state: built\nready: yes 2026-09-26 abc\nagent-walk: on 2026-09-26' })
  assert.equal(rows.b.nextStep, 'Agent walk (fleet)')
})

test('a program child waiting on an unshipped dependency says so; its dependency does not wait', () => {
  const rows = repo({
    big: 'tier: program\nchild: api — building\nchild: ui — spec',
    api: 'state: building',
    ui: 'state: spec',
  }, {
    'big/PROGRAM.md': '# big — program\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n| 1 | api | md | app | x | — |\n| 2 | ui | md | app | y | api |\n',
  })
  assert.deepEqual(rows.ui.waitsOn, [{ name: 'api', state: 'building' }])
  assert.equal(rows.ui.nextStep, '⏳ waits on api (building)')
  assert.deepEqual(rows.api.waitsOn, [])
})

const SHIPPED = (n, date, pr) => `# ${n} — spec\n> ✅ SHIPPED ${date} — PR #${pr} · none\n`

test('archived features are never rows; --status counts them in one line', () => {
  const root = setup({ live: 'state: building' }, {
    '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4),
    '_archive/older/SPEC.md': SHIPPED('older', '2026-08-01', 2),
  })
  const json = list(root, '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).features.map((f) => f.feature), ['live'])
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /📦 2 shipped features archived · list-features\.mjs --archived lists them/)
})

test('--archived lists the archive newest first; --limit caps it', () => {
  const root = setup({}, {
    '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4),
    '_archive/mid/SPEC.md': SHIPPED('mid', '2026-08-15', 3),
    '_archive/older/SPEC.md': SHIPPED('older', '2026-08-01', 2),
  })
  const r = list(root, '--archived', '--limit', '2')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /3 archived — newest first, showing 2/)
  assert.match(r.stdout, /\| old \| 2026-09-01 \| #4 \| `docs\/features\/_archive\/old` \|/)
  assert.ok(r.stdout.indexOf('| old |') < r.stdout.indexOf('| mid |'))
  assert.doesNotMatch(r.stdout, /\| older \|/)
  const j = JSON.parse(list(root, '--archived', '--json').stdout)
  assert.equal(j.total, 3)
  assert.deepEqual(j.archived.map((a) => a.feature), ['old', 'mid', 'older'])
})

test('with nothing in flight, --status still says how many shipped', () => {
  const root = setup({}, { '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4) })
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /Nothing in progress in t — 1 shipped/)
})

const draft = (root, name, header) => {
  mkdirSync(join(root, '.builder', name), { recursive: true })
  writeFileSync(join(root, '.builder', name, 'brainstorm.md'), `# ${name} — brainstorm\n${header}\n\n## Intent\nx\n`)
}

test('a conversation in progress is listed in --json and --status with its command', () => {
  const root = setup({ live: 'state: building' })
  draft(root, 'idea', 'status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 2 of 7')
  const json = JSON.parse(list(root, '--json').stdout).features
  const idea = json.find((f) => f.feature === 'idea')
  assert.equal(idea.layout, 'brainstorm')
  assert.equal(idea.nextStep, 'Continue the brainstorm')
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /\| \*\*idea\*\* \|.*brainstorming \(2\/7 settled\).*`\/builder:brainstorm --path docs\/features\/idea`/)
})

test('a registry with only a conversation in progress is not "nothing"', () => {
  const root = setup({})
  draft(root, 'idea', 'status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 0 of 3')
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /1 in progress/)
})

test('a new SPEC with §Idea instead of §Overview describes itself from its Why', () => {
  const root = setup({ f: 'state: spec' }, { 'f/SPEC.md': '# f — spec\n\n## Idea\n**Why.** Owners need to see which sheets changed since the last issue. More text.\n\n## Apps\n' })
  const f = JSON.parse(list(root, '--json').stdout).features.find((r) => r.feature === 'f')
  assert.equal(f.description, 'Owners need to see which sheets changed since the last issue.')
})

test('a live feature with a revision conversation still open says to finish it', () => {
  const root = setup({ f: 'state: audited', g: 'state: audited' }, { 'kept/NOTES.md': '# kept — notes\n\nA parked idea.\n' })
  draft(root, 'kept', 'status: parked\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 2 of 8')
  draft(root, 'f', 'status: exploring\nsource: brainstorm\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 1 of 4')
  draft(root, 'g', 'status: handed-off\nsource: brainstorm\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 4 of 4')
  const rows = Object.fromEntries(JSON.parse(list(root, '--json').stdout).features.map((r) => [r.feature, r]))
  assert.equal(rows.f.nextStep, 'Finish the revision conversation')
  assert.equal(rows.f.command, '/builder:brainstorm --path docs/features/f')
  assert.equal(rows.f.lastDone, 'Audit done')
  assert.equal(rows.g.nextStep, 'Settle open decisions, then plan')
  assert.equal(rows.g.command, '/builder:resume --path docs/features/g')
  assert.notEqual(rows.kept.nextStep, 'Finish the revision conversation', 'a parked idea kept as notes is not a revision')
})

test('a conversation stopped at understanding (handed-off, no folder) is not listed', () => {
  const root = setup({ live: 'state: building' })
  draft(root, 'understood', 'status: handed-off\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 5 of 5')
  const json = JSON.parse(list(root, '--json').stdout).features
  assert.deepEqual(json.map((f) => f.feature), ['live'])
})

test('a vendored copy behind the newest release on this machine says so in --status and --json', async () => {
  const { cpSync } = await import('node:fs')
  const root = setup({ live: 'state: planned' })
  const copy = join(root, 'plugins/builder')
  cpSync(join(dirname(LIST)), join(copy, 'scripts'), { recursive: true, filter: (p) => !p.includes(`${join('scripts', 'test')}`) })
  mkdirSync(join(copy, '.claude-plugin'), { recursive: true })
  writeFileSync(join(copy, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'builder', version: '4.1.1' }))
  const config = mkdtempSync(join(tmpdir(), 'lf-config-'))
  const rel = join(config, 'plugins/cache/m/builder/4.2.0')
  mkdirSync(join(rel, '.claude-plugin'), { recursive: true })
  mkdirSync(join(rel, 'scripts'), { recursive: true })
  writeFileSync(join(rel, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'builder', version: '4.2.0' }))
  writeFileSync(join(rel, 'scripts/vendor.mjs'), '')
  const run = (...args) => spawnSync('node', [join(copy, 'scripts/list-features.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: config } })
  const status = run('--status')
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /⬆️ builder 4\.2\.0 is available — this repo carries 4\.1\.1\. Run \/builder:vendor to update it\./)
  assert.deepEqual(JSON.parse(run('--json').stdout).builder, { vendored: true, have: '4.1.1', latest: '4.2.0', behind: true })
  // Run as a plugin install (not inside the repo), there is no line.
  assert.doesNotMatch(list(root, '--status').stdout, /⬆️/)
})

test('a feature with a go-ahead reports its build profile; before one, null', () => {
  const rows = repo({
    a: 'state: planned\ngo-ahead: x\nprofile: rush',
    b: 'state: planned\ngo-ahead: x',
    c: 'state: audited\nprofile: rush',
    d: 'state: planned\ngo-ahead: x\nprofile: bogus',
  })
  assert.equal(rows.a.profile, 'rush')
  assert.equal(rows.b.profile, 'thorough')
  assert.equal(rows.c.profile, null)
  assert.equal(rows.d.profile, 'thorough')
})

test('--status shows each feature\'s profile, and a dash before a go-ahead', () => {
  const root = setup({ a: 'state: planned\ngo-ahead: x\nprofile: rush', b: 'state: audited' })
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /\| Feature \| Profile \|/)
  assert.match(st.stdout, /\| \*\*a\*\* \| rush \|/)
  assert.match(st.stdout, /\| \*\*b\*\* \| — \|/)
})

test('a feature the fleet landed elsewhere says to merge its target, not its manifest step', () => {
  const root = setup({ a: 'state: planned\ngo-ahead: t 2026-10-03', b: 'state: building' })
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/archive.jsonl'), JSON.stringify({ feature: 'a', target: 'release', merged: 'abc1234', landedAt: '2026-10-03T00:00:00Z' }) + '\n')
  const r = list(root, '--json')
  assert.equal(r.status, 0, r.stderr)
  const rows = Object.fromEntries(JSON.parse(r.stdout).features.map((f) => [f.feature, f]))
  assert.equal(rows.a.nextStep, 'Landed on release — merge release into this branch')
  assert.equal(rows.a.landed, 'release')
  assert.equal(rows.b.nextStep, 'Continue the build')
  assert.equal(rows.b.landed ?? null, null)
})
