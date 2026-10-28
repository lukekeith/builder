import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { migrateGates } from '../verify/migrate.mjs'
import { parseBlock, normalizeVerify, verifyLines } from '../verify/config.mjs'

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
  const text = readFileSync(new URL('../../PROJECT.template.md', import.meta.url), 'utf8')
  const lines = verifyLines(text)
  assert.ok(lines, 'template has a verify: block')
  const v = normalizeVerify(parseBlock(lines))
  assert.ok(v.suites.length && v.checks.length)
})
