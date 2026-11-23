import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { summarizeFloor, summarizeContention, summarizeSerial, spread, renderBench } from '../test-bench-core.mjs'

const run = (wallMs, o = {}) => ({ wallMs, timedOut: false, tests: 10, pass: 10, fail: 0, starved: 0, files: {}, peakConn: 5, baseConn: 2, ...o })

test('summarizeFloor: mean, spread, flaky tests across reps, slowest files; a cut rep is left out of the times', () => {
  const s = summarizeFloor(
    [run(1000, { files: { a: 900, b: 100 } }), run(1200, { files: { a: 1100, b: 100 } }), run(60000, { timedOut: true })],
    [[{ id: 'a::x', status: 'pass' }, { id: 'b::y', status: 'pass' }], [{ id: 'a::x', status: 'fail' }, { id: 'b::y', status: 'pass' }]],
  )
  assert.equal(s.meanMs, 1100)
  assert.equal(s.minMs, 1000)
  assert.equal(s.maxMs, 1200)
  assert.equal(s.timedOut, 1)
  assert.equal(s.cv, 0.129)
  assert.deepEqual(s.flaky, ['a::x'])
  assert.deepEqual(s.slowest[0], { file: 'a', ms: 667 })
})

test('summarizeContention: slowdown against one run; fits is the largest n within tolerance, never one that starved or was cut', () => {
  const s = summarizeContention([
    { n: 1, runs: [run(100)] },
    { n: 2, runs: [run(110), run(115)] },
    { n: 3, runs: [run(115), run(118), run(119, { starved: 4 })] },
    { n: 4, runs: [run(400), run(410), run(420), run(430)] },
  ])
  assert.deepEqual(s.rows.map((r) => r.slowdown), [1, 1.13, 1.17, 4.15])
  assert.equal(s.rows[2].starved, 4)
  assert.equal(s.fits, 2)
  assert.equal(summarizeContention([{ n: 2, runs: [run(1)] }]).fits, 0, 'no n=1 level: nothing to compare against')
})

test('summarizeSerial: the whole run against Σ files alone, scaled up from a sample', () => {
  const s = summarizeSerial({ wholeMs: 900, alone: [{ file: 'a', wallMs: 100 }, { file: 'b', wallMs: 200 }], totalFiles: 6 })
  assert.equal(s.sumAloneMs, 900)
  assert.equal(s.ratio, 1)
  assert.equal(s.sampled, true)
  assert.equal(s.slowest[0].file, 'b')
})

test('spread takes every k-th file, not the first n', () => {
  assert.deepEqual(spread(['a', 'b', 'c', 'd', 'e', 'f'], 3), ['a', 'c', 'e'])
  assert.deepEqual(spread(['a', 'b'], 5), ['a', 'b'])
  assert.deepEqual(spread(['a', 'b'], null), ['a', 'b'])
})

test('renderBench prints each experiment\'s headline', () => {
  const meta = { repo: 'r', suite: 'u', sha: 'abcdef123456', at: 'now' }
  assert.match(renderBench('contention', meta, summarizeContention([{ n: 1, runs: [run(100)] }])), /Largest n within 1\.2× of one run, none starved or cut: \*\*1\*\*/)
  assert.match(renderBench('serial', meta, summarizeSerial({ wholeMs: 100, alone: [{ file: 'a', wallMs: 100 }], totalFiles: 1 })), /ratio \*\*1\*\*/)
})

// A repo with a verify: block and a node-test suite of three files, each sleeping a little.
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbench-')))
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), '---\nproject: x\napps:\n  - name: a\n    path: .\nverify:\n  suites:\n    u: { runner: node-test, files: "t/*.test.mjs" }\n---\n')
  mkdirSync(join(root, 't'))
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, 't', `${n}.test.mjs`), `import test from 'node:test'\ntest('${n}', async () => { await new Promise((r) => setTimeout(r, 150)) })\n`)
  g('add', '.')
  g('commit', '-qm', 'init')
  return root
}
const cli = (root, ...args) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'test-bench.mjs'), ...args, '--repo', root], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } })

test('the CLI runs floor, contention and serial on a real suite in its own checkouts, and appends a row for each', { timeout: 120000 }, () => {
  const root = repo()
  try {
    const f = cli(root, 'floor', '--suite', 'u', '--reps', '2', '--json')
    assert.equal(f.status, 0, f.stderr)
    const fl = JSON.parse(f.stdout)
    assert.equal(fl.reps, 2)
    assert.equal(fl.tests, 3)
    assert.ok(fl.meanMs > 150)
    const c = cli(root, 'contention', '--suite', 'u', '--levels', '1,2')
    assert.equal(c.status, 0, c.stderr)
    assert.match(c.stdout, /\| 2 \| /)
    const s = cli(root, 'serial', '--suite', 'u', '--files', '2', '--json')
    assert.equal(s.status, 0, s.stderr)
    const se = JSON.parse(s.stdout)
    assert.equal(se.files, 2)
    assert.equal(se.totalFiles, 3)
    assert.equal(se.sampled, true)
    const rows = readFileSync(join(root, '.builder', 'bench', 'test-bench.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(rows.map((r) => r.exp), ['floor', 'contention', 'serial'])
    assert.ok(rows.every((r) => r.suite === 'u' && r.sha.length === 40 && !r.forced))
  } finally {
    rmSync(`${root}-bench`, { recursive: true, force: true })
  }
})

test('the CLI refuses while the repo\'s verifier has work, unless --force, which marks the row; an unknown suite names the ones there are', { timeout: 60000 }, () => {
  const root = repo()
  try {
    mkdirSync(join(root, '.builder', 'verify', 'requests'), { recursive: true })
    writeFileSync(join(root, '.builder', 'verify', 'requests', 'x.json'), JSON.stringify({ id: 'x', state: 'running' }))
    const r = cli(root, 'floor', '--suite', 'u', '--reps', '1')
    assert.equal(r.status, 2)
    assert.match(r.stderr, /refused: the verifier has 1 request\(s\) queued or running/)
    const forced = cli(root, 'floor', '--suite', 'u', '--reps', '1', '--force', '--json')
    assert.equal(forced.status, 0, forced.stderr)
    assert.deepEqual(JSON.parse(forced.stdout).forced, ['the verifier has 1 request(s) queued or running'])
    assert.match(cli(root, 'floor', '--suite', 'nope').stderr, /--suite: one of u/)
  } finally {
    rmSync(`${root}-bench`, { recursive: true, force: true })
  }
})
