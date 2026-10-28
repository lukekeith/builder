// scripts/test/verify-adapters.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { parseJUnit, parseJestJson, parseXcresult } from '../verify/reports.mjs'
import { ADAPTERS, leafOf, q } from '../verify/adapters.mjs'

const suite = (o) => ({ name: 's', runner: 'node-test', files: 'test/*.test.mjs', cwd: '.', args: '', needs: [], tiers: [], ...o })

test('parseJUnit: vitest-style classname file, failure message, skipped', () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="test/a.test.ts" tests="3">
    <testcase classname="test/a.test.ts" name="a &gt; adds" time="0.012"/>
    <testcase classname="test/a.test.ts" name="a &gt; fails" time="0.5"><failure message="expected 1 to be 2">AssertionError: expected 1 to be 2</failure></testcase>
    <testcase classname="test/a.test.ts" name="a &gt; later" time="0"><skipped/></testcase>
  </testsuite></testsuites>`
  const r = parseJUnit(xml)
  assert.deepEqual(r.map((x) => [x.file, x.name, x.status, x.ms]), [
    ['test/a.test.ts', 'a > adds', 'pass', 12],
    ['test/a.test.ts', 'a > fails', 'fail', 500],
    ['test/a.test.ts', 'a > later', 'skip', 0],
  ])
  assert.match(r[1].msg, /expected 1 to be 2/)
})

test('parseJUnit: phpunit-style absolute file attr is made relative to root', () => {
  const xml = `<testsuites><testsuite name="T" file="/repo/tests/FooTest.php"><testcase name="testBar" class="FooTest" file="/repo/tests/FooTest.php" time="0.1"><error type="E">boom</error></testcase></testsuite></testsuites>`
  const [r] = parseJUnit(xml, { root: '/repo' })
  assert.equal(r.file, 'tests/FooTest.php')
  assert.equal(r.status, 'fail')
})

test('parseJestJson and parseXcresult', () => {
  const jest = JSON.stringify({ testResults: [{ name: '/repo/src/x.test.ts', assertionResults: [{ fullName: 'x works', status: 'passed', duration: 4 }, { fullName: 'x breaks', status: 'failed', duration: 2, failureMessages: ['nope'] }] }] })
  assert.deepEqual(parseJestJson(jest, { root: '/repo' }).map((r) => [r.file, r.name, r.status]), [['src/x.test.ts', 'x works', 'pass'], ['src/x.test.ts', 'x breaks', 'fail']])
  const xc = JSON.stringify({ testNodes: [{ nodeType: 'Test Plan', name: 'P', children: [{ nodeType: 'Unit test bundle', name: 'AppTests', children: [{ nodeType: 'Test Suite', name: 'LoginTests', children: [
    { nodeType: 'Test Case', name: 'testOk()', result: 'Passed', durationInSeconds: 0.2 },
    { nodeType: 'Test Case', name: 'testBad()', result: 'Failed', children: [{ nodeType: 'Failure Message', name: 'XCTAssertEqual failed' }] },
  ] }] }] }] })
  assert.deepEqual(parseXcresult(xc).map((r) => [r.file, r.name, r.status, r.msg]), [['LoginTests.swift', 'testOk()', 'pass', null], ['LoginTests.swift', 'testBad()', 'fail', 'XCTAssertEqual failed']])
})

test('commands: files, whole suite, single-test grep escapes regex and quotes', () => {
  const nt = ADAPTERS['node-test'].command({ suite: suite({ args: '--experimental-strip-types' }), files: ['test/a.test.mjs'], grep: `x > handles (a|b) in "it's"`, report: '/tmp/r.jsonl' })
  assert.match(nt, /^node --test --test-reporter=/)
  assert.match(nt, /--experimental-strip-types/)
  assert.match(nt, /--test-name-pattern='handles \\\(a\\\|b\\\) in "it'\\''s"'/)
  assert.match(nt, / 'test\/a\.test\.mjs'$/)
  assert.match(ADAPTERS['node-test'].command({ suite: suite(), files: null, grep: null, report: '/r' }), / 'test\/\*\.test\.mjs'$/)
  assert.match(ADAPTERS.vitest.command({ suite: suite({ runner: 'vitest' }), files: ['a.test.ts'], grep: null, report: '/r' }), /^npx vitest run --reporter=junit --outputFile='\/r'.* 'a\.test\.ts'$/)
  assert.match(ADAPTERS.jest.command({ suite: suite({ runner: 'jest' }), files: ['a.test.ts'], grep: null, report: '/r' }), /--runTestsByPath 'a\.test\.ts'/)
  assert.match(ADAPTERS.phpunit.command({ suite: suite({ runner: 'phpunit' }), files: ['tests/FooTest.php', 'tests/BarTest.php'], grep: null, report: '/r' }), /--filter '\(FooTest\|BarTest\)'/)
  assert.match(ADAPTERS.phpunit.command({ suite: suite({ runner: 'phpunit' }), files: ['tests/FooTest.php'], grep: 'testBar', report: '/r' }), /--filter 'FooTest::testBar'/)
  const xc = ADAPTERS.xcodebuild.command({ suite: suite({ runner: 'xcodebuild', scheme: 'App', target: 'AppTests', destination: 'platform=iOS Simulator,name=iPhone 16' }), files: ['LoginTests.swift'], grep: 'testBad()', report: '/r.json' })
  assert.match(xc, /-only-testing:'AppTests\/LoginTests\/testBad'/)
  assert.match(xc, /xcresulttool get test-results tests --path/)
  assert.match(ADAPTERS.playwright.command({ suite: suite({ runner: 'playwright' }), files: null, grep: 'a › b', report: '/r' }), /^PLAYWRIGHT_JUNIT_OUTPUT_NAME='\/r' npx playwright test --reporter=junit --grep 'b'/)
  assert.equal(ADAPTERS.junit.command({ suite: suite({ runner: 'junit', command: 'make test FILES={files} ONLY={grep}', report: 'out.xml' }), files: ['a b.t'], grep: null, report: 'x' }), `make test FILES='a b.t' ONLY=`)
  assert.equal(leafOf('a > b > c'), 'c')
})

test('node-test runs for real: per-test file, name path, status', () => {
  // realpath: the runner reports resolved paths (macOS /var → /private/var)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vad-')))
  // inside a node --test run NODE_TEST_CONTEXT makes a child node --test skip its reporters
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'test', 'a.test.mjs'), `import { test, describe } from 'node:test'\nimport assert from 'node:assert'\ndescribe('math', () => { test('adds', () => assert.equal(1 + 1, 2)); test('breaks', () => assert.equal(1, 2)) })\n`)
  const report = join(dir, 'r.jsonl')
  const cmd = ADAPTERS['node-test'].command({ suite: suite(), files: ['test/a.test.mjs'], grep: null, report })
  try { execSync(cmd, { cwd: dir, env, stdio: 'ignore', shell: '/bin/bash' }) } catch {}
  const r = ADAPTERS['node-test'].parse(readFileSync(report, 'utf8'), { root: dir })
  assert.deepEqual(r.map((x) => [x.file, x.name, x.status]).sort(), [['test/a.test.mjs', 'math > adds', 'pass'], ['test/a.test.mjs', 'math > breaks', 'fail']])
  const one = ADAPTERS['node-test'].command({ suite: suite(), files: ['test/a.test.mjs'], grep: 'math > breaks', report })
  try { execSync(one, { cwd: dir, env, stdio: 'ignore', shell: '/bin/bash' }) } catch {}
  const only = ADAPTERS['node-test'].parse(readFileSync(report, 'utf8'), { root: dir }).filter((x) => x.status !== 'skip')
  assert.deepEqual(only.map((x) => x.name), ['math > breaks'])
})
