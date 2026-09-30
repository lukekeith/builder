import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseGates, inputLines, inputsHash, isDirty, mainRoot, runGateSet, readMemo, expandPlaceholders } from '../gates-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, '..', 'gate.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

const BODY = `
# t — builder config

## Quality gates

Prose here is ignored.

### server — fast

\`\`\`
npm run typecheck                          # the whole workspace type-checks
node --test "apps/server/test/*.test.ts"   # server services
\`\`\`

A second block under the same heading is NOT read:

\`\`\`
echo nope
\`\`\`

### web - fast

\`\`\`
npx tsc -p web --noEmit 2>&1 | grep -c "error TS"   # must not grow @delta
npm run gate:css   # the stylesheet rules @known-red
# a comment line inside the block
\`\`\`

### Deep set (verify only)

\`\`\`
npx playwright test     # the UI smoke suite
\`\`\`

## Walk readiness

\`\`\`
status: x
\`\`\`
`

test('parseGates reads each app fast block, the deep set, notes and markers', () => {
  const g = parseGates(BODY)
  assert.deepEqual(Object.keys(g.fast), ['server', 'web'])
  assert.deepEqual(g.fast.server, [
    { cmd: 'npm run typecheck', note: 'the whole workspace type-checks', delta: false, knownRed: false },
    { cmd: 'node --test "apps/server/test/*.test.ts"', note: 'server services', delta: false, knownRed: false },
  ])
  assert.deepEqual(g.fast.web, [
    { cmd: 'npx tsc -p web --noEmit 2>&1 | grep -c "error TS"', note: 'must not grow', delta: true, knownRed: false },
    { cmd: 'npm run gate:css', note: 'the stylesheet rules', delta: false, knownRed: true },
  ])
  assert.deepEqual(g.deep, [{ cmd: 'npx playwright test', note: 'the UI smoke suite', delta: false, knownRed: false }])
})

test('parseGates on a body with no section is empty, not undefined', () => {
  assert.deepEqual(parseGates('# nothing\n'), { fast: {}, deep: [] })
  assert.deepEqual(parseGates(null), { fast: {}, deep: [] })
})

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gates-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  for (const p of ['apps/server/a.txt', 'apps/web/b.txt', 'packages/db/c.txt', 'docs/features/f/SPEC.md', 'package.json']) {
    mkdirSync(join(root, dirname(p)), { recursive: true })
    writeFileSync(join(root, p), `${p}\n`)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}
const commit = (root, p, text) => {
  writeFileSync(join(root, p), text)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `edit ${p}`)
}

test('inputLines carves out other apps and the registry, keeps shared code', () => {
  const root = repo()
  const server = () => inputsHash(inputLines(root, { exclude: ['docs/features', 'apps/web/'] }), [])
  const h0 = server()
  commit(root, 'docs/features/f/SPEC.md', 'docs only\n')
  assert.equal(server(), h0, 'a docs commit does not touch the server gate')
  commit(root, 'apps/web/b.txt', 'web only\n')
  assert.equal(server(), h0, "another app's commit does not touch the server gate")
  commit(root, 'packages/db/c.txt', 'shared\n')
  const h1 = server()
  assert.notEqual(h1, h0, 'shared code invalidates')
  commit(root, 'apps/server/a.txt', 'own\n')
  assert.notEqual(server(), h1, 'the app itself invalidates')
  assert.notEqual(inputsHash(inputLines(root, { exclude: ['docs/features', 'apps/web/'] }), [{ cmd: 'x' }]), server(), 'a changed gate command invalidates')
})

test('isDirty and mainRoot', () => {
  const root = repo()
  assert.equal(isDirty(root), false)
  writeFileSync(join(root, 'package.json'), 'changed\n')
  assert.equal(isDirty(root), true)
  git(root, 'checkout', '--', 'package.json')
  assert.equal(realpathSync(mainRoot(root)), realpathSync(root))
  const wt = `${root}-wt`
  git(root, 'worktree', 'add', '-q', '-b', 'b', wt)
  assert.equal(realpathSync(mainRoot(wt)), realpathSync(root))
})

test('runGateSet: green, red with a tail, known-red not counted, delta against a baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-run-'))
  const r = runGateSet(
    [
      { cmd: 'echo ok', note: '', delta: false, knownRed: false },
      { cmd: 'echo boom; exit 3', note: '', delta: false, knownRed: false },
      { cmd: 'echo debt; exit 1', note: '', delta: false, knownRed: true },
      { cmd: 'echo "errors: 14"', note: '', delta: true, knownRed: false },
      { cmd: 'echo 15', note: '', delta: true, knownRed: false },
      { cmd: 'echo 9', note: '', delta: true, knownRed: false },
    ],
    { cwd: dir, logDir: join(dir, 'logs'), baseline: { 'echo "errors: 14"': 14, 'echo 15': 14 } }
  )
  assert.equal(r.exit, 1)
  assert.equal(r.red, 2)
  assert.match(r.lines[0], /^✓ echo ok/)
  assert.match(r.lines[1], /^✗ echo boom; exit 3 exit 3 .*\n\s+boom/)
  assert.match(r.lines[2], /^~ echo debt; exit 1 exit 1 — KNOWN-RED/)
  assert.match(r.lines[3], /^✓ .*→ 14 \(baseline 14/)
  assert.match(r.lines[4], /^✗ echo 15 → 15 exceeds baseline 14/)
  assert.match(r.lines[5], /^✓ echo 9 → 9 \(no baseline yet/)
  assert.deepEqual(r.newBaselines, { 'echo 9': 9 })
  assert.match(readFileSync(join(dir, 'logs', '02.log'), 'utf8'), /boom/)
})

test('runGateSet: a flaky match re-runs the narrow command and passes; a second failure stays red', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-flaky-'))
  const once = join(dir, 'once')
  const flaky = [{ match: 'intake\\.test\\.ts', rerun: `test -f ${once} || { touch ${once}; exit 0; }` }, { match: 'always-bad' }]
  const r = runGateSet(
    [
      { cmd: 'echo "not ok 3 - intake.test.ts"; exit 1', note: '', delta: false, knownRed: false },
      { cmd: 'echo "always-bad"; exit 1', note: '', delta: false, knownRed: false },
    ],
    { cwd: dir, flaky }
  )
  assert.equal(r.red, 1)
  assert.match(r.lines[0], /^~ .*matched flaky "intake\\.test\\.ts"; re-ran `test -f/)
  assert.match(r.lines[1], /^✗ .*matched flaky "always-bad" but the re-run failed too/)
})

// ---- the CLI, against a real config ----------------------------------------------------------

function configured(gatesBody, { flaky = '' } = {}) {
  const root = repo()
  mkdirSync(join(root, '.claude'))
  writeFileSync(
    join(root, '.claude/builder.md'),
    `---\nproject: t\nregistry: docs/features\napps:\n  - name: server\n    path: apps/server/\n    role: producer\n  - name: web\n    path: apps/web/\n    role: consumer\n${flaky}---\n\n## Quality gates\n\n${gatesBody}\n`
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'config')
  return root
}
const run = (root, ...args) => spawnSync('node', [GATE, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

test('gate.mjs runs a fast set, memoises green, quotes it while inputs are unchanged, re-runs when they change', () => {
  // The gate writes OUTSIDE the repo: an untracked file inside it would be swept up by the next commit.
  const runs = join(mkdtempSync(join(tmpdir(), 'gates-out-')), 'gate-runs.txt')
  const root = configured(`### server — fast\n\n\`\`\`\necho server-ok >> ${runs}   # proves nothing\n\`\`\`\n\n### web — fast\n\n\`\`\`\necho web-ok   # x\n\`\`\`\n`)
  const first = run(root, 'server')
  assert.equal(first.status, 0, first.stderr + first.stdout)
  assert.match(first.stdout, /▶ server — fast at [0-9a-f]{7}/)
  assert.match(first.stdout, /gate fast-server: PASS · /)
  assert.ok(readMemo(root, 'fast-server'))
  const second = run(root, 'server')
  assert.equal(second.status, 0)
  assert.match(second.stdout, /⏩ server — fast: inputs unchanged since the green run at [0-9a-f]{7}/)
  assert.match(second.stdout, /PASS \(quoted\)/)
  assert.equal(readFileSync(runs, 'utf8'), 'server-ok\n', 'quoted, not re-run')
  // web's commit leaves server quoted; a shared commit does not.
  commit(root, 'apps/web/b.txt', 'web change\n')
  assert.match(run(root, 'server').stdout, /quoted/)
  commit(root, 'packages/db/c.txt', 'db change\n')
  const third = run(root, 'server')
  assert.match(third.stdout, /▶ server — fast/)
  assert.equal(readFileSync(runs, 'utf8'), 'server-ok\nserver-ok\n')
  // --force always runs; --all covers both apps.
  assert.match(run(root, 'server', '--force').stdout, /▶ server — fast/)
  const all = run(root, '--all')
  assert.match(all.stdout, /server — fast/)
  assert.match(all.stdout, /▶ web — fast/)
})

test('gate.mjs: a red set is never quoted, exits 1, and a dirty tree is not memoised', () => {
  const root = configured('### server — fast\n\n```\ntest -f green   # passes once the file exists\n```\n')
  const red = run(root, 'server')
  assert.equal(red.status, 1)
  assert.match(red.stdout, /✗ test -f green exit 1/)
  assert.match(red.stdout, /gate fast-server: FAIL \(1 red\)/)
  assert.equal(readMemo(root, 'fast-server').exit, 1)
  writeFileSync(join(root, 'green'), '')
  const green = run(root, 'server')
  assert.equal(green.status, 0)
  assert.match(green.stdout, /▶ server/, 'a red memo is not quoted')
  writeFileSync(join(root, 'package.json'), 'dirty\n')
  const dirty = run(root, 'server')
  assert.match(dirty.stdout, /uncommitted changes — result not memoised/)
})

test('gate.mjs --deep runs the deep block; unknown app and missing block refuse with exit 2', () => {
  const root = configured('### server — fast\n\n```\ntrue   # x\n```\n\n### Deep set\n\n```\necho deep-ran   # e2e\n```\n')
  const deep = run(root, '--deep')
  assert.equal(deep.status, 0, deep.stderr)
  assert.match(deep.stdout, /▶ deep set/)
  assert.match(deep.stdout, /gate deep: PASS/)
  assert.equal(run(root, 'nope').status, 2)
  assert.equal(run(root, 'web').status, 2, 'web has no fast block in this config')
  assert.equal(run(root, '--bogus').status, 2)
})

test('gate.mjs: flaky from the config, @delta against --baseline in the main checkout, read from a worktree', () => {
  const root = configured(
    '### server — fast\n\n```\ncat count.txt   # tsc errors @delta\nsh flaky.sh   # a suite with one flaky file\n```\n',
    { flaky: 'flaky:\n  - match: intake\\.test\n    rerun: echo fine\n' }
  )
  writeFileSync(join(root, 'count.txt'), '14\n')
  writeFileSync(join(root, 'flaky.sh'), 'echo "not ok - intake.test.ts"; exit 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'fixtures')
  const base = run(root, '--baseline')
  assert.equal(base.status, 0, base.stderr + base.stdout)
  assert.match(base.stdout, /✓ cat count.txt → 14/)
  assert.ok(existsSync(join(root, '.builder/gates/baseline.json')))
  const wt = `${root}-wt`
  git(root, 'worktree', 'add', '-q', '-b', 'builder/x', wt)
  const ok = run(wt, 'server')
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /→ 14 \(baseline 14/)
  assert.match(ok.stdout, /~ sh flaky.sh exit 1, matched flaky "intake\\.test"; re-ran `echo fine`: passed/)
  writeFileSync(join(wt, 'count.txt'), '15\n')
  git(wt, 'commit', '-qam', 'more errors')
  const worse = run(wt, 'server')
  assert.equal(worse.status, 1)
  assert.match(worse.stdout, /→ 15 exceeds baseline 14/)
})

test('a <placeholder> gate line runs over the test files the branch changed under the app', () => {
  const root = configured('### server — fast\n\n```\necho RUN apps/server/<path>/<file>.test.ts   # the touched test files\n```\n')
  git(root, 'switch', '-q', '-c', 'builder/x')
  // Nothing changed yet: the line is reported, not run, and the set is green.
  const none = run(root, 'server')
  assert.equal(none.status, 0, none.stdout)
  assert.match(none.stdout, /~ echo RUN .* — no changed test files under this app since main; nothing to run/)
  commit(root, 'apps/server/a.test.ts', 'test\n')
  writeFileSync(join(root, 'apps/server/b.txt'), 'not a test\n')
  writeFileSync(join(root, 'apps/web/c.test.ts'), 'other app\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'more')
  assert.equal(expandPlaceholders('echo RUN apps/server/<path>/<file>.test.ts', { root, appPath: 'apps/server/', baseBranch: 'main' }), 'echo RUN apps/server/a.test.ts')
  const some = run(root, 'server')
  assert.equal(some.status, 0, some.stdout)
  assert.match(some.stdout, /→ echo RUN apps\/server\/a\.test\.ts/)
  assert.match(some.stdout, /✓ echo RUN apps\/server\/a\.test\.ts/)
  assert.equal(
    expandPlaceholders('cd apps/server && npx tsx --test src/<path>/<file>.test.ts', { root, appPath: 'apps/server/', baseBranch: 'main' }),
    'cd apps/server && npx tsx --test a.test.ts',
    'a cd prefix makes the files relative to that directory'
  )
  assert.equal(expandPlaceholders('cd apps/web && x <f>', { root, appPath: 'apps/server/', baseBranch: 'main' }), null, 'nothing under the cd directory')
  assert.equal(expandPlaceholders('no placeholders', { root, appPath: 'x', baseBranch: 'main' }), 'no placeholders')
  assert.equal(expandPlaceholders('x <f>', { root, appPath: 'x', baseBranch: 'no-such-branch' }), null)
})

test('gate.mjs creates .builder/gates before the first command, so a gate line can tee into it', () => {
  const root = configured('### server — fast\n\n```\necho hi | tee .builder/gates/hi.log   # tees on the first run\n```\n')
  const r = run(root, 'server')
  assert.equal(r.status, 0, r.stdout)
  assert.equal(readFileSync(join(root, '.builder/gates/hi.log'), 'utf8'), 'hi\n')
})

test('parseGates reads @scoped <glob> off a line, and keeps the rest of the note', () => {
  const g = parseGates('## Quality gates\n\n### Deep set\n\n```\nnpx playwright test {tests}   # the UI suite @scoped apps/web/test/e2e/**/*.spec.ts @delta\nnpm run gate:8   # MCP and installer @scoped packages/mcp/**\n```\n')
  assert.deepEqual(g.deep[0], { cmd: 'npx playwright test {tests}', note: 'the UI suite', delta: true, knownRed: false, scope: 'apps/web/test/e2e/**/*.spec.ts' })
  assert.equal(g.deep[1].scope, 'packages/mcp/**')
})

test('runGateSet: a @scoped line runs the tests the impact reaches, skips when none, runs whole when it must', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-scope-'))
  const scopes = {
    'e2e/**': { mode: 'some', tests: ['e2e/a.spec.ts', "e2e/it's.spec.ts"], why: {}, reason: null },
    'unit/**': { mode: 'none', tests: [], why: {}, reason: 'nothing this branch touches reaches these tests' },
    'all/**': { mode: 'whole', tests: [], why: {}, reason: 'all/harness.html changed' },
    'pkg/**': { mode: 'some', tests: ['pkg/x.ts'], why: {}, reason: null },
  }
  const r = runGateSet(
    [
      { cmd: 'echo RUN {tests}', note: '', delta: false, knownRed: false, scope: 'e2e/**' },
      { cmd: 'echo UNIT {tests}', note: '', delta: false, knownRed: false, scope: 'unit/**' },
      { cmd: 'echo ALL {tests}', note: '', delta: false, knownRed: false, scope: 'all/**' },
      { cmd: 'echo PKG', note: '', delta: false, knownRed: false, scope: 'pkg/**' },
    ],
    { cwd: dir, logDir: join(dir, 'logs'), scope: (glob) => scopes[glob] }
  )
  assert.equal(r.exit, 0)
  assert.match(r.lines.join('\n'), /✓ echo RUN 'e2e\/a\.spec\.ts' 'e2e\/it'\\''s\.spec\.ts'/)
  assert.match(r.lines.join('\n'), /~ echo UNIT \{tests\} — nothing this branch touches reaches these tests; not run/)
  assert.match(r.lines.join('\n'), /the whole suite — all\/harness\.html changed[\s\S]*✓ echo ALL \(/)
  assert.match(r.lines.join('\n'), /✓ echo PKG \(/, 'a line with no {tests} runs whole when the impact reaches its glob')
})

test('runGateSet: a @scoped @delta line with failures in the subset is judged on the whole suite against its baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-scope-'))
  // The subset prints 2 (a known-red spec is in it); the whole suite prints 5, which is the baseline.
  const gate = { cmd: 'if [ -n "{tests}" ]; then echo 2; else echo 5; fi', note: '', delta: true, knownRed: false, scope: 'e2e/**' }
  const run = (baseline) =>
    runGateSet([gate], { cwd: dir, logDir: join(dir, 'logs'), baseline, scope: () => ({ mode: 'some', tests: ['e2e/a.spec.ts'], why: {}, reason: null }) })
  const ok = run({ [gate.cmd]: 5 })
  assert.equal(ok.exit, 0, ok.lines.join('\n'))
  assert.match(ok.lines.join('\n'), /2 in the subset — re-running the whole suite to judge it against the baseline/)
  assert.match(ok.lines.join('\n'), /→ 5 \(baseline 5/)
  const zero = runGateSet([{ ...gate, cmd: 'true {tests}; echo 0' }], { cwd: dir, logDir: join(dir, 'logs'), baseline: { 'true {tests}; echo 0': 5 }, scope: () => ({ mode: 'some', tests: ['e2e/a.spec.ts'], why: {}, reason: null }) })
  assert.doesNotMatch(zero.lines.join('\n'), /re-running the whole suite/, 'a clean subset needs no whole run')
})

test('gate.mjs --deep scopes a @scoped line to what the branch reaches, writes the impact report, and --whole runs it all', () => {
  const root = configured('### server — fast\n\n```\ntrue   # x\n```\n\n### Deep set\n\n```\necho RAN {tests}   # the UI suite @scoped apps/web/test/**/*.spec.ts\n```\n')
  mkdirSync(join(root, 'apps/web/src'), { recursive: true })
  mkdirSync(join(root, 'apps/web/test'), { recursive: true })
  writeFileSync(join(root, 'apps/web/src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'apps/web/src/b.ts'), 'export const b = 1\n')
  writeFileSync(join(root, 'apps/web/test/a.spec.ts'), "import { a } from '../src/a'\n")
  writeFileSync(join(root, 'apps/web/test/b.spec.ts'), "import { b } from '../src/b'\n")
  for (const f of ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/test/a.spec.ts', 'apps/web/test/b.spec.ts']) {
    git(root, 'add', f)
    git(root, 'commit', '-qm', `add ${f}`)
  }
  git(root, 'switch', '-q', '-c', 'feat')
  writeFileSync(join(root, 'apps/web/src/a.ts'), 'export const a = 2\n')
  git(root, 'commit', '-qam', 'a changes')
  const r = run(root, '--deep')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /1 test file\(s\) this branch reaches/)
  assert.match(r.stdout, /✓ echo RAN 'apps\/web\/test\/a\.spec\.ts' \(/)
  const report = readFileSync(join(root, '.builder/gates/impact.md'), 'utf8')
  assert.match(report, /apps\/web\/test\/a\.spec\.ts — reaches apps\/web\/src\/a\.ts/)
  const whole = run(root, '--deep', '--whole', '--force')
  assert.match(whole.stdout, /✓ echo RAN \(/)
  // Nothing on the branch reaches the suite → the line is reported and not run.
  git(root, 'switch', '-q', '-c', 'feat2', 'main')
  writeFileSync(join(root, 'README.md'), 'docs\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-qm', 'docs only')
  const none = run(root, '--deep')
  assert.equal(none.status, 0, none.stderr)
  assert.match(none.stdout, /~ echo RAN \{tests\} — nothing this branch touches reaches these tests; not run/)
})
