// scripts/test/verify-config.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripComment, parseFlow, parseBlock, verifyLines, normalizeVerify, loadVerify, durationMs } from '../verify/config.mjs'

const CONFIG = `---
project: X
base_branch: main
apps:
  - name: server
    path: apps/server
verify:
  workers: 3                      # test workers
  timeout: 15m
  setup: npm ci
  db:
    kind: postgres
    url: postgres://app:app@localhost:5432/app
    env: [TEST_DATABASE_URL]
    inputs: "packages/db/prisma/**"
    prepare: npm run db:migrate:test
    max: 6
  suites:
    server:    { runner: node-test,  files: "apps/server/test/*.test.ts", app: server, needs: [db], args: "--experimental-strip-types" }
    e2e:       { runner: playwright, app: web, needs: [db, { ports: [PORT, WEB_PORT] }], tiers: [merge] }
  checks:
    typecheck: { run: npm run typecheck, tiers: [commit, phase, merge] }
    css:       { run: "npm run gate:css", compare: lines, match: "✗" }
agent_walk:
  start: npm run dev
---
# body
`

test('stripComment keeps # inside quotes', () => {
  assert.equal(stripComment(`a: "x # y"   # note`), `a: "x # y"`)
  assert.equal(stripComment(`a: b#c`), `a: b#c`)
})

test('parseFlow reads nested flow maps and lists, quoted values keep , : { }', () => {
  assert.deepEqual(parseFlow(`{ a: 1, b: [x, { ports: [P, Q] }], c: "x, y: {z}" }`), { a: 1, b: ['x', { ports: ['P', 'Q'] }], c: 'x, y: {z}' })
  assert.deepEqual(parseFlow(`[a, b]`), ['a', 'b'])
  assert.throws(() => parseFlow(`{ a: [1] b: 2 }`), /expected ','/)
})

test('parseFlow tells you to quote a bare value holding a colon', () => {
  assert.throws(() => parseFlow('{ run: npm run test:unit }'), /quote the value of "run"/)
})

test('verifyLines takes the block up to the next top-level key', () => {
  const lines = verifyLines(CONFIG)
  assert.ok(lines.some((l) => l.includes('suites:')))
  assert.ok(!lines.some((l) => l.includes('agent_walk')))
  assert.equal(verifyLines('---\nproject: x\n---\n'), null)
})

test('normalizeVerify fills defaults and reads needs', () => {
  const v = normalizeVerify(parseBlock(verifyLines(CONFIG)))
  assert.equal(v.workers, 3)
  assert.equal(v.timeoutMs, 15 * 60000)
  assert.deepEqual(v.db.env, ['TEST_DATABASE_URL'])
  const server = v.suites.find((s) => s.name === 'server')
  assert.deepEqual(server.tiers, ['commit', 'phase', 'merge'])
  assert.deepEqual(server.needs, [{ kind: 'db' }])
  assert.equal(server.args, '--experimental-strip-types')
  const e2e = v.suites.find((s) => s.name === 'e2e')
  assert.deepEqual(e2e.needs, [{ kind: 'db' }, { kind: 'ports', names: ['PORT', 'WEB_PORT'] }])
  assert.deepEqual(e2e.tiers, ['merge'])
  const css = v.checks.find((c) => c.name === 'css')
  assert.equal(css.compare, 'lines')
  assert.equal(css.match, '✗')
  assert.deepEqual(css.tiers, ['phase', 'merge'])
})

test('normalizeVerify refuses what it cannot run', () => {
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'mocha' } } }), /runner "mocha"/)
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'node-test', needs: ['db'] } } }), /verify\.db is not set/)
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'node-test', tiers: ['nightly'] } } }), /tier "nightly"/)
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'junit' } } }), /command/)
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'node-test', needs: ['simulator'] } } }), /verify\.simulator/)
  assert.throws(() => normalizeVerify({ suites: { a: { runner: 'node-test', needs: ['dbb'] } } }), /"dbb"/)
  assert.throws(() => normalizeVerify({}), /no suites and no checks/)
})

test('durationMs reads 90s / 15m / 2h', () => {
  assert.equal(durationMs('90s'), 90000)
  assert.equal(durationMs('2h'), 7200000)
  assert.equal(durationMs(null, 5), 5)
  assert.throws(() => durationMs('soon'), /not a duration/)
})

test('loadVerify reads .claude/builder.md and explains a missing block', () => {
  const root = mkdtempSync(join(tmpdir(), 'vcfg-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), CONFIG)
  const r = loadVerify(root)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.verify.suites.length, 2)
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\n---\n')
  assert.match(loadVerify(root).reason, /no verify: block/)
})
