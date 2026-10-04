import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { impactOf, scopeTests, globToRegExp, spellings } from '../scripts/impact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMPACT = join(HERE, '..', 'scripts', 'impact.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const put = (root, files) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
const commit = (root, msg) => {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', msg)
}

/**
 * main: a schema with Certificate.issueDate, server code that reads it, unit tests reaching that code
 * by import, and two UI specs — one that an earlier feature changed together with the list view.
 * The branch makes issueDate required and changes the list view.
 */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'impact-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  put(root, {
    'package.json': '{"name":"root","private":true}\n',
    'packages/db/package.json': '{"name":"@x/db","main":"src/index.ts"}\n',
    'packages/db/src/index.ts': 'export const db = 1\n',
    'packages/db/prisma/schema.prisma': 'model Certificate {\n  id        Int       @id\n  issueDate DateTime?\n  name      String\n}\n',
    'apps/server/src/certs.ts': "import { db } from '@x/db'\nexport const issued = (c) => c.issueDate ?? db\n",
    'apps/server/src/uses-certs.ts': "import { issued } from './certs.js'\nexport const u = issued\n",
    'apps/server/src/other.ts': 'export const other = 1\n',
    'apps/server/src/dbuser.ts': "import { db } from '@x/db'\nexport const d = db\n",
    'apps/server/test/dbuser.test.ts': "import { d } from '../src/dbuser'\n",
    'apps/server/src/raw.ts': 'export const q = "select issue_date from certificate"\n',
    'apps/server/test/certs.test.ts': "import { issued } from '../src/certs.ts'\n",
    'apps/server/test/uses.test.ts': "import '../src/uses-certs'\n",
    'apps/server/test/other.test.ts': "import { other } from '../src/other'\n",
    'apps/server/test/raw.test.ts': "const { q } = require('../src/raw')\n",
    'apps/web/src/list.tsx': "export const label = 'Issue date'\n",
    'apps/web/test/e2e/certs.spec.ts': "test('the list shows it', () => {})\n",
    'apps/web/test/e2e/other.spec.ts': "test('something else', () => {})\n",
    'apps/web/test/e2e/harness.html': '<html></html>\n',
  })
  commit(root, 'init')
  put(root, { 'apps/web/src/list.tsx': "export const label = 'Issue date' // v2\n", 'apps/web/test/e2e/certs.spec.ts': "test('the list shows the issue date', () => {})\n" })
  commit(root, 'web(cert-list): show the issue date')
  git(root, 'switch', '-q', '-c', 'feat')
  put(root, {
    'packages/db/prisma/schema.prisma': 'model Certificate {\n  id        Int       @id\n  issueDate DateTime\n  name      String\n}\n',
    'apps/web/src/list.tsx': "export const label = 'Issue date' // v3\n",
  })
  commit(root, 'feat: issue date is required')
  return root
}

test('globToRegExp: **, *, ? and {a,b}', () => {
  const re = globToRegExp('apps/web/test/e2e/**/*.spec.{ts,js}')
  assert.ok(re.test('apps/web/test/e2e/a.spec.ts'))
  assert.ok(re.test('apps/web/test/e2e/deep/b.spec.js'))
  assert.ok(!re.test('apps/web/test/e2e/a.test.ts'))
  assert.ok(!re.test('apps/web/src/a.spec.ts'))
  assert.ok(globToRegExp('src/?.ts').test('src/a.ts'))
})

test('spellings: every way one identifier is written', () => {
  assert.deepEqual(spellings('issueDate').sort(), ['ISSUE_DATE', 'IssueDate', 'issue-date', 'issueDate', 'issue_date'].sort())
  assert.deepEqual(spellings('issue_date').sort(), spellings('issueDate').sort())
})

test('impactOf: changed files, the schema fields they changed, and the code that reads those fields', () => {
  const root = repo()
  const imp = impactOf(root, { baseBranch: 'main' })
  assert.deepEqual(imp.changed.sort(), ['apps/web/src/list.tsx', 'packages/db/prisma/schema.prisma'])
  assert.deepEqual(imp.schema.changes, ['Certificate.issueDate'])
  assert.match(imp.seeds.get('apps/server/src/certs.ts'), /reads Certificate\.issueDate, which this branch changed/)
  assert.ok(imp.seeds.has('apps/server/src/raw.ts'), 'the snake_case spelling counts')
  assert.equal(imp.seeds.has('apps/server/src/other.ts'), false)
})

test('scopeTests: unit tests that reach the impact by import, at any depth — and only those', () => {
  const root = repo()
  const s = scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/server/test/**/*.test.ts')
  assert.equal(s.mode, 'some')
  assert.deepEqual(s.tests, ['apps/server/test/certs.test.ts', 'apps/server/test/raw.test.ts', 'apps/server/test/uses.test.ts'])
  assert.match(s.why['apps/server/test/uses.test.ts'], /reaches apps\/server\/src\/uses-certs\.ts → apps\/server\/src\/certs\.ts/)
})

test('scopeTests: a UI spec another feature changed together with the code this branch changed', () => {
  const root = repo()
  const s = scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/web/test/e2e/**/*.spec.ts')
  assert.equal(s.mode, 'some')
  assert.deepEqual(s.tests, ['apps/web/test/e2e/certs.spec.ts'])
  assert.match(s.why['apps/web/test/e2e/certs.spec.ts'], /changed with apps\/web\/src\/list\.tsx in [0-9a-f]{7} "web\(cert-list\): show the issue date"/)
})

test('scopeTests: a package imported by name counts; nothing reached is none', () => {
  const root = repo()
  put(root, { 'packages/db/src/index.ts': 'export const db = 2\n' })
  commit(root, 'db change')
  const s = scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/server/test/**/*.test.ts')
  assert.match(s.why['apps/server/test/dbuser.test.ts'], /reaches apps\/server\/src\/dbuser\.ts → packages\/db\/src\/index\.ts$/)
  assert.equal(scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/mobile/**/*.test.ts').mode, 'none')
})

test('scopeTests: a harness loaded by name selects the specs that load it', () => {
  const root = repo()
  put(root, {
    'apps/web/test/e2e/panel-harness.html': '<script type="module" src="./panel.tsx"></script>\n',
    'apps/web/test/e2e/panel.tsx': 'export {}\n',
    'apps/web/test/e2e/panel.spec.ts': "const HARNESS = '/test/e2e/panel-harness.html'\n",
  })
  commit(root, 'the panel harness')
  put(root, { 'apps/web/test/e2e/dialogs.spec.ts': "const HARNESS = '/test/e2e/harness.html'\n" })
  commit(root, 'the dialogs spec, on the other harness')
  git(root, 'switch', '-q', '-c', 'feat2')
  put(root, { 'apps/web/test/e2e/panel.tsx': 'export const v = 2\n' })
  commit(root, 'panel harness change')
  const s = scopeTests(impactOf(root, { baseBranch: 'feat' }), 'apps/web/test/e2e/**/*.spec.ts')
  assert.equal(s.mode, 'some')
  assert.deepEqual(s.tests, ['apps/web/test/e2e/panel.spec.ts'], 'not dialogs.spec.ts, whose harness.html is a different page')
  assert.match(s.why['apps/web/test/e2e/panel.spec.ts'], /reaches apps\/web\/test\/e2e\/panel-harness\.html → apps\/web\/test\/e2e\/panel\.tsx/)
})

test('scopeTests: a changed file beside the tests that nothing loads, a runner config or a dependency means the whole suite', () => {
  const root = repo()
  put(root, { 'apps/web/test/e2e/fixture.json': '{"v":2}\n' })
  commit(root, 'a fixture the runner globs for')
  const s = scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/web/test/e2e/**/*.spec.ts')
  assert.equal(s.mode, 'whole')
  assert.match(s.reason, /apps\/web\/test\/e2e\/fixture\.json/)
  const r2 = repo()
  put(r2, { 'package.json': '{"name":"root","private":true,"dependencies":{"x":"1"}}\n' })
  commit(r2, 'dep')
  assert.equal(scopeTests(impactOf(r2, { baseBranch: 'main' }), 'apps/server/test/**/*.test.ts').mode, 'whole')
})

test('impact.mjs prints the report and exits 0', () => {
  const root = repo()
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\nbase_branch: main\napps:\n  - name: server\n    path: apps/server/\n    role: api\n    commit: auto\n---\nbody\n')
  const r = spawnSync('node', [IMPACT, 'apps/server/test/**/*.test.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /changed on this branch \(2\)/)
  assert.match(r.stdout, /schema changed under existing readers: Certificate\.issueDate/)
  assert.match(r.stdout, /apps\/server\/test\/certs\.test\.ts — /)
})

test('schema: an added model or field has no readers yet; a shared field name needs the model named', () => {
  const root = repo()
  git(root, 'switch', '-q', 'main')
  put(root, {
    'packages/db/prisma/schema.prisma': 'model Certificate {\n  id        Int       @id\n  issueDate DateTime?\n  name      String\n  rowId     Int\n}\nmodel Note {\n  id    Int @id\n  rowId Int\n}\n',
    'apps/server/src/notes.ts': 'export const n = (note) => note.rowId // Note\n',
    'apps/server/src/cert-rows.ts': 'export const r = (certificate) => certificate.rowId\n',
  })
  commit(root, 'rows')
  git(root, 'switch', '-q', '-c', 'feat3')
  put(root, {
    'packages/db/prisma/schema.prisma': 'model Certificate {\n  id        Int       @id\n  issueDate DateTime?\n  name      String\n  rowId     String\n}\nmodel Note {\n  id    Int @id\n  rowId Int\n}\nmodel RunReport {\n  id    Int @id\n  rowId Int\n  runId Int\n}\n',
    'packages/db/prisma/migrations/2_x/migration.sql': 'CREATE TABLE "RunReport" ("id" INT, "rowId" INT);\nALTER TABLE "Certificate" ALTER COLUMN "rowId" TYPE TEXT;\n',
  })
  commit(root, 'retype a row id, add a model')
  const imp = impactOf(root, { baseBranch: 'main' })
  assert.deepEqual(imp.schema.changes, ['Certificate.rowId'], 'the new RunReport and its fields are not a change under anyone')
  assert.ok(imp.seeds.has('apps/server/src/cert-rows.ts'))
  assert.equal(imp.seeds.has('apps/server/src/notes.ts'), false, 'Note.rowId is another field of the same name')
})

test('a barrel is seen through: a named import reaches only the module that provides the name; a type-only import reaches nothing', () => {
  const root = repo()
  git(root, 'switch', '-q', 'main')
  put(root, {
    'packages/contracts/package.json': '{"name":"@x/contracts","main":"src/index.ts"}\n',
    'packages/contracts/src/index.ts': "export * from './build-run'\nexport * from './other'\nexport { thing as renamed } from './thing'\n",
    'packages/contracts/src/build-run.ts': 'export const run = 1\nexport type Run = { id: number }\n',
    'packages/contracts/src/other.ts': 'export const other = 1\n',
    'packages/contracts/src/thing.ts': 'export function thing() {}\n',
  })
  commit(root, 'contracts')
  // Each consumer lands on its own, as features do — one commit apiece, so no test is tied to the
  // contracts by having changed with them.
  const consumers = {
    'apps/server/src/uses-run.ts': "import { run } from '@x/contracts'\n",
    'apps/server/src/uses-other.ts': "import { other } from '@x/contracts'\n",
    'apps/server/src/uses-type.ts': "import type { Run } from '@x/contracts'\nimport { type Run as R, other } from '@x/contracts'\n",
    'apps/server/src/uses-all.ts': "import * as c from '@x/contracts'\n",
    'apps/server/src/uses-renamed.ts': "import { renamed } from '@x/contracts'\n",
    'apps/server/test/run.test.ts': "import '../src/uses-run'\n",
    'apps/server/test/other.2.test.ts': "import '../src/uses-other'\n",
    'apps/server/test/type.test.ts': "import '../src/uses-type'\n",
    'apps/server/test/all.test.ts': "import '../src/uses-all'\n",
    'apps/server/test/renamed.test.ts': "import '../src/uses-renamed'\n",
  }
  for (const [p, body] of Object.entries(consumers)) {
    put(root, { [p]: body })
    commit(root, `add ${p}`)
  }
  git(root, 'switch', '-q', '-c', 'feat4')
  put(root, { 'packages/contracts/src/build-run.ts': 'export const run = 2\nexport type Run = { id: number }\n' })
  commit(root, 'run changes')
  const s = scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/server/test/**/*.test.ts')
  assert.deepEqual(s.tests, ['apps/server/test/all.test.ts', 'apps/server/test/run.test.ts'])
  assert.match(s.why['apps/server/test/run.test.ts'], /reaches apps\/server\/src\/uses-run\.ts → packages\/contracts\/src\/build-run\.ts$/, 'straight past the barrel')
  git(root, 'switch', '-q', '-c', 'feat5', 'main')
  put(root, { 'packages/contracts/src/thing.ts': 'export function thing() { return 2 }\n' })
  commit(root, 'thing changes')
  assert.deepEqual(scopeTests(impactOf(root, { baseBranch: 'main' }), 'apps/server/test/**/*.test.ts').tests, ['apps/server/test/all.test.ts', 'apps/server/test/renamed.test.ts'], 'an aliased re-export')
})
