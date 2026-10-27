import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'archive.mjs')
const REG = 'docs/features'
const DAY = 86400000

const git = (root, args, env = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const archive = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, BUILDER_TODAY: '2026-10-27', CLAUDE_PLUGIN_ROOT: '' } })
const text = (root, p) => readFileSync(join(root, p), 'utf8')

/** Commit `files` (registry-relative) as of `daysAgo`. */
function commit(root, files, daysAgo, msg) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, REG, p)), { recursive: true })
    writeFileSync(join(root, REG, p), body)
  }
  const when = new Date(Date.now() - daysAgo * DAY).toISOString()
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when })
}

const SPEC = (n, header = '') => `# ${n} — spec\n${header}> md · no ticket\n\n## Idea\nx\n\n## Plan\n\n- Phase 1 · Task 1\n\n## Testing\ny\n`

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arch-')))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 't@t'])
  git(root, ['config', 'user.name', 't'])
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  writeFileSync(join(root, '.gitignore'), '.builder/\n')
  commit(root, {
    's/MANIFEST.md': 'size: md\nstate: shipped\nnext: x\n',
    's/SPEC.md': SPEC('s'),
    's/PLAN.md': 'plan\n',
    'v/MANIFEST.md': 'size: md\nstate: verified\nverify: READY 2026-10-20\nticket: none\nnext: x\n',
    'v/SPEC.md': `# v — spec\n> ✅ SIGNED OFF 2026-10-19 — abc1234 · by Luke: "works"\n> md · no ticket\n\n## Idea\nx\n`,
    'v/continue.md': 'notes\n',
    'v/TASK3-RESULT.md': 'r\n',
    'm/MANIFEST.md': 'size: md\nstate: built\nwalk: none\nnext: x\n',
    'm/SPEC.md': SPEC('m'),
    'm/PLAN.md': 'plan\n',
    'conv/MANIFEST.md': 'size: md\nstate: built\nnext: x\n',
    'conv/SPEC.md': '# conv — spec\n> md\n\n## Apps\n- api — see 01-api.md\n',
    'conv/01-api.md': 'the analysis\n',
    'conv/STATUS.md': 'old ledger\n',
    'a/MANIFEST.md': 'size: md\nstate: planned\nnext: x\n',
    'a/SPEC.md': SPEC('a'),
    'a/PLAN.md': 'plan\n',
    'l/01-notes.md': 'notes\n',
    'l/02-more.md': 'more\n',
    '_archive/old/SPEC.md': '# old — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    '_archive/old/PLAN.md': 'left behind\n',
  }, 100, 'old work')
  commit(root, { 'r/MANIFEST.md': 'size: md\nstate: built\nnext: x\n', 'r/SPEC.md': SPEC('r'), 'f/MANIFEST.md': 'size: md\nstate: building\nnext: x\n', 'f/SPEC.md': SPEC('f') }, 1, 'recent work')
  for (const n of ['v', 'old', 'f']) mkdirSync(join(root, '.builder', n), { recursive: true })
  return root
}

test('plan: finished folders in the recommended tier, abandoned and legacy only on request, in-flight left alone', () => {
  const root = fixture()
  const r = archive(root, 'plan', '--json')
  assert.equal(r.status, 0, r.stderr)
  const p = JSON.parse(r.stdout)
  const by = Object.fromEntries(p.items.map((i) => [i.path, `${i.tier}/${i.action}`]))
  assert.deepEqual(by, {
    [`${REG}/s`]: 'finished/archive',
    [`${REG}/v`]: 'finished/ship',
    [`${REG}/m`]: 'finished/close',
    [`${REG}/conv`]: 'finished/close',
    [`${REG}/a`]: 'old/drop',
    [`${REG}/l`]: 'old/move',
    [`${REG}/_archive/old`]: 'finished/trim',
    '.builder/old': 'finished/workspace',
  })
  const left = Object.fromEntries(p.left.map((l) => [l.name, l.why]))
  assert.match(left.r, /built, last moved .* still in hand/)
  assert.match(left.f, /building — in flight/)
  const md = archive(root, 'plan')
  assert.match(md.stdout, /\*\*Finished\*\* — archived on your go-ahead/)
  assert.match(md.stdout, /\| docs\/features\/m \| Merged, never verified — close as is: built and in main; never walked \| CLOSED — merged [0-9a-f]+, not walked \|/)
  assert.match(md.stdout, /^registry: 6 finished · 2 old to archive → \/builder:archive$/m)
  assert.equal(archive(root, 'plan', '--summary').stdout.trim(), 'registry: 6 finished · 2 old to archive → /builder:archive')
})

test('apply: one commit — each keeps only its SPEC under its header, moved into _archive; workspaces go; a converted SPEC keeps the docs it names', () => {
  const root = fixture()
  const before = Number(git(root, ['rev-list', '--count', 'HEAD']))
  const r = archive(root, 'apply', `${REG}/s`, 'v', 'm', 'conv', 'old', '.builder/old')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1)
  assert.match(git(root, ['log', '-1', '--format=%s']), /^docs\(archive\): 5 folders — s, v, m, conv and 1 more$/)
  assert.equal(git(root, ['status', '--porcelain']), '')
  const files = git(root, ['ls-files', REG]).split('\n')
  assert.deepEqual(files.filter((f) => !/\/(a|l|r|f)\//.test(f)).sort(), [
    `${REG}/_archive/conv/01-api.md`,
    `${REG}/_archive/conv/SPEC.md`,
    `${REG}/_archive/m/SPEC.md`,
    `${REG}/_archive/old/SPEC.md`,
    `${REG}/_archive/s/SPEC.md`,
    `${REG}/_archive/v/SPEC.md`,
  ])
  const v = text(root, `${REG}/_archive/v/SPEC.md`).split('\n')[1]
  assert.match(v, /^> ✅ SHIPPED 2026-10-27 — merged [0-9a-f]+ · no ticket · signed off by Luke: "works"$/)
  const m = text(root, `${REG}/_archive/m/SPEC.md`)
  assert.match(m.split('\n')[1], /^> ✅ CLOSED 2026-10-27 — merged [0-9a-f]+, not walked$/)
  assert.doesNotMatch(m, /^## Plan$/m, 'the §Plan index goes with PLAN.md')
  assert.match(m, /^## Testing$/m)
  assert.match(text(root, `${REG}/_archive/s/SPEC.md`).split('\n')[1], /^> ✅ SHIPPED 2026-10-27 — merged [0-9a-f]+$/)
  assert.equal(existsSync(join(root, '.builder/v')), false)
  assert.equal(existsSync(join(root, '.builder/old')), false)
  assert.ok(existsSync(join(root, '.builder/f')), 'an in-flight workspace stays')
  assert.equal(archive(root, 'plan', '--summary').stdout.trim(), 'registry: 2 old to archive → /builder:archive')
})

test('apply the old tier: abandoned gets DROPPED, a folder with no SPEC moves whole; --drop drops an in-flight one with its reason', () => {
  const root = fixture()
  const r = archive(root, 'apply', 'a', 'l')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(text(root, `${REG}/_archive/a/SPEC.md`).split('\n')[1], /^> ✖ DROPPED 2026-10-27 — no activity since \d{4}-\d\d-\d\d$/)
  assert.equal(existsSync(join(root, REG, '_archive/a/PLAN.md')), false)
  assert.ok(existsSync(join(root, REG, '_archive/l/01-notes.md')))
  assert.ok(existsSync(join(root, REG, '_archive/l/02-more.md')))
  const f = archive(root, 'apply', 'f', '--drop', 'superseded by g')
  assert.equal(f.status, 0, f.stdout + f.stderr)
  assert.match(text(root, `${REG}/_archive/f/SPEC.md`).split('\n')[1], /^> ✖ DROPPED 2026-10-27 — superseded by g$/)
  assert.equal(existsSync(join(root, '.builder/f')), false)
})

test('apply refuses off the target or with registry changes uncommitted, and a name it left alone; nothing is touched', () => {
  const root = fixture()
  writeFileSync(join(root, REG, 'f/SPEC.md'), 'edited\n')
  const dirty = archive(root, 'apply', 's')
  assert.equal(dirty.status, 1)
  assert.match(dirty.stdout, /uncommitted changes under docs\/features/)
  git(root, ['checkout', '--', REG])
  git(root, ['switch', '-q', '-c', 'other'])
  const off = archive(root, 'apply', 's')
  assert.equal(off.status, 1)
  assert.match(off.stdout, /archive runs on main/)
  git(root, ['switch', '-q', 'main'])
  const r = archive(root, 'apply', 'r', 's')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ r — left alone: built, last moved/)
  assert.match(r.stdout, /✓ s — archived/)
  assert.ok(existsSync(join(root, REG, 'r/MANIFEST.md')))
})

test('apply prunes archived fleet logs past keep_logs', () => {
  const root = fixture()
  const logs = join(root, '.builder/fleet/logs/_archive/x')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'x-01.log'), 'x')
  const old = new Date(Date.now() - 40 * DAY)
  utimesSync(join(logs, 'x-01.log'), old, old)
  const r = archive(root, 'apply', 's')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /✓ fleet logs — 1 archived log file pruned/)
  assert.equal(existsSync(join(logs, 'x-01.log')), false)
})
