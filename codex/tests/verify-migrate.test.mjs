import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { migrateGates, migrationReview, applyMigration } from '../scripts/verify/migrate.mjs'
import { parseBlock, normalizeVerify, verifyLines } from '../scripts/verify/config.mjs'

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify', 'migrate.mjs')

const BODY = `## Quality gates
### server — fast
\`\`\`
npm run typecheck                                                        # the workspace type-checks @typecheck
node --test --experimental-strip-types "apps/server/test/*.test.ts"      # server routes
\`\`\`
### client — fast
\`\`\`
cd client && npx vitest run              # unit
cd client && npm run guard 2>&1 | grep -c '✗'   # guard findings @delta
\`\`\`
### Deep set (verify only)
\`\`\`
npx playwright test {tests}   # the UI suite @scoped e2e/**/*.spec.ts @walk
cd backend && npx jest --ci   # unit suites @known-red
\`\`\`
## Walk readiness
`

const parse = (yaml) => normalizeVerify(parseBlock(yaml.split('\n').slice(1)))

test('old gate blocks become a verify: block that parses', () => {
  const { yaml, notes } = migrateGates(BODY, ['server', 'client'])
  const v = parse(yaml)
  const s = Object.fromEntries(v.suites.map((x) => [x.name, x]))
  assert.equal(s['server-test'].runner, 'node-test')
  assert.equal(s['server-test'].files, 'apps/server/test/*.test.ts')
  assert.equal(s['server-test'].args, '--experimental-strip-types')
  assert.equal(s['client-vitest'].cwd, 'client')
  assert.equal(s['deep-playwright'].runner, 'playwright')
  assert.equal(s['deep-playwright'].files, 'e2e/**/*.spec.ts')
  assert.deepEqual(s['deep-playwright'].tiers, ['merge'])
  assert.equal(s['deep-jest'].cwd, 'backend')
  const c = Object.fromEntries(v.checks.map((x) => [x.name, x]))
  assert.deepEqual(c['server-typecheck'].tiers, ['commit', 'phase', 'merge'])
  assert.equal(c['client-guard'].compare, 'lines')
  assert.ok(notes.some((n) => /client-guard.*print findings/.test(n)))
  assert.ok(notes.some((n) => /known-red.*learned/.test(n)))
  assert.ok(notes.some((n) => /@walk.*needs: \[walk-env\]/.test(n)))
})

test('a @scoped glob under the cd directory loses that prefix: files is relative to cwd', () => {
  const body = '## Quality gates\n### client — fast\n```\ncd client && npx vitest run   # unit @scoped client/src/**/*.test.ts\n```\n'
  const v = parse(migrateGates(body, ['client']).yaml)
  assert.equal(v.suites[0].cwd, 'client')
  assert.equal(v.suites[0].files, 'src/**/*.test.ts')
})

test('values holding , : { } [ ] are quoted so the block still parses', () => {
  const body = '## Quality gates\n### web — fast\n```\nnpm run gate:css   # css\nnode --test "test/{a,b}/*.test.mjs"   # t\n```\n'
  const v = parse(migrateGates(body, ['web']).yaml)
  assert.equal(v.checks[0].run, 'npm run gate:css')
  assert.equal(v.suites[0].files, 'test/{a,b}/*.test.mjs')
})

test('the template example verify: block parses and normalizes', () => {
  const text = readFileSync(new URL('../assets/PROJECT.template.md', import.meta.url), 'utf8')
  const lines = verifyLines(text)
  assert.ok(lines, 'template has a verify: block')
  const v = normalizeVerify(parseBlock(lines))
  assert.ok(v.suites.length && v.checks.length)
})

// Codex: $builder init --update shows the migration as a review and writes it only on approval.
const CONFIG = (extra = '') => `---
project: X
apps:
  - name: server
    path: apps/server/
  - name: client
    path: client/
flaky:
  - match: intake\\.test\\.ts
    rerun: node --test apps/server/test/intake.test.ts
${extra}---

# X

${BODY}\`\`\`
migrations: db
\`\`\`

## Global constraints

- keep
`

test('the review says in plain words what changes, each suite and check, what is removed and what to check', () => {
  const { review, ok } = migrationReview(CONFIG(), { path: '.claude/builder.md' })
  assert.equal(ok, true)
  assert.match(review, /^Moving the test setup in \.claude\/builder\.md to the verifier/)
  assert.match(review, /Before: ## Quality gates — 6 command lines \(server, client and the deep set\)/)
  assert.match(review, /After: {2}a verify: block/)
  assert.match(review, /Test suites — tracked test by test\n[\s\S]*- server-test: node-test, apps\/server\/test\/\*\.test\.ts \(app server\) — every commit, each phase close and the merged result/)
  assert.match(review, /- deep-playwright: playwright, e2e\/\*\*\/\*\.spec\.ts — only the merged result, before it lands/)
  assert.match(review, /Checks — a command that passes or fails\n[\s\S]*- client-guard: `npm run guard 2>&1` in client — fails only on a finding the target doesn't print — each phase close and the merged result/)
  assert.match(review, /Removed\n[\s\S]*- the ## Quality gates section\n[\s\S]*- flaky: \(1 entry\) — the verifier spots a flaky test itself/)
  assert.match(review, /Check before approving\n[\s\S]*client-guard: was a @delta count/)
  assert.match(review, /shared with Claude Code's builder — both read the same verify: block/)
  assert.match(review, /The block as it will be written\n {2}verify:\n {4}workers: 2/)
  assert.doesNotMatch(migrationReview(CONFIG(), { path: '.codex/builder.md' }).review, /shared with Claude Code/)
})

test('a config that already has verify: needs nothing; one with no gate lines says init writes suites from the repo', () => {
  assert.deepEqual(migrationReview(CONFIG('verify:\n  checks:\n    t: { run: "true" }\n'), { path: '.codex/builder.md' }), { ok: true, already: true, review: '.codex/builder.md already has a verify: block — nothing to migrate.' })
  const empty = migrationReview('---\nproject: X\napps:\n  - name: a\n    path: .\n---\n\n## Quality gates\n\nnone yet\n', { path: '.codex/builder.md' })
  assert.equal(empty.ok, false)
  assert.match(empty.review, /no gate commands to carry over — write the verify: block from the repo's test runners, as \$builder init does/)
})

test('applyMigration writes verify: at the end of the frontmatter and removes ## Quality gates and flaky:, nothing else', () => {
  const { yaml } = migrateGates(BODY, ['server', 'client'])
  const out = applyMigration(CONFIG(), yaml)
  assert.ok(verifyLines(out), 'verify: block present')
  assert.ok(normalizeVerify(parseBlock(verifyLines(out))).suites.length)
  assert.doesNotMatch(out, /## Quality gates|flaky:|intake/)
  assert.match(out, /\n {4}path: client\/\nverify:\n {2}workers: 2/)
  assert.match(out, /# X\n\n## Walk readiness\n```\nmigrations: db\n```\n\n## Global constraints\n\n- keep\n$/)
  const crlf = applyMigration(CONFIG().replace(/\n/g, '\r\n'), yaml)
  assert.ok(!/[^\r]\n/.test(crlf), 'a CRLF file stays CRLF')
  assert.ok(verifyLines(crlf))
  assert.throws(() => applyMigration(CONFIG('verify:\n  workers: 1\n'), yaml), /already has a verify: block/)
})

test('the CLI: --review prints the review, --write writes the selected config (or an edited --block) and refuses a block that does not parse', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vmig-')))
  mkdirSync(join(root, '.claude'))
  const file = join(root, '.claude/builder.md')
  writeFileSync(file, CONFIG())
  const run = (...a) => spawnSync(process.execPath, [MIGRATE, root, ...a], { encoding: 'utf8' })
  const r = run('--review')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Moving the test setup in \.claude\/builder\.md to the verifier/)
  assert.match(readFileSync(file, 'utf8'), /## Quality gates/, '--review never writes')
  const bad = join(root, 'bad.yaml')
  writeFileSync(bad, 'verify:\n  suites:\n    x: { runner: mocha }\n')
  const b = run('--write', '--block', bad)
  assert.equal(b.status, 1)
  assert.match(b.stderr, /runner "mocha" is not one of/)
  assert.match(readFileSync(file, 'utf8'), /## Quality gates/)
  const edited = join(root, 'edited.yaml')
  writeFileSync(edited, 'verify:\n  workers: 3\n  checks:\n    typecheck: { run: "npm run typecheck", tiers: [commit, phase, merge] }\n')
  const w = run('--write', '--block', edited)
  assert.equal(w.status, 0, w.stderr)
  assert.match(w.stdout, /wrote verify: to \.claude\/builder\.md — removed ## Quality gates and flaky:/)
  const text = readFileSync(file, 'utf8')
  assert.equal(normalizeVerify(parseBlock(verifyLines(text))).workers, 3)
  assert.doesNotMatch(text, /## Quality gates/)
  const again = run('--write')
  assert.equal(again.status, 0)
  assert.match(again.stdout, /already has a verify: block — nothing to migrate/)
})
