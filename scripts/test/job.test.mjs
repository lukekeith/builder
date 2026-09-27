import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const JOB = join(dirname(fileURLToPath(import.meta.url)), '..', 'job.mjs')

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'job-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}
const job = (root, ...args) => spawnSync('node', [JOB, ...args], { cwd: root, encoding: 'utf8' })

test('start returns at once; wait reports the exit code and the log tail', () => {
  const root = repo()
  const s = job(root, 'start', 'g1', '--', 'echo hello; exit 3')
  assert.equal(s.status, 0, s.stderr)
  const w = job(root, 'wait', 'g1')
  assert.equal(w.status, 3)
  assert.match(w.stdout, /^g1: exit 3/m)
  assert.match(w.stdout, /hello/)
  assert.ok(existsSync(join(root, '.builder/jobs/g1.log')))
  assert.equal(readFileSync(join(root, '.builder/.gitignore'), 'utf8'), '*\n')
})

test('wait gives up after --max with "still running" and exit 75; a later wait gets the result', () => {
  const root = repo()
  job(root, 'start', 'slow', '--', 'sleep 2; echo done')
  const first = job(root, 'wait', 'slow', '--max', '1')
  assert.equal(first.status, 75)
  assert.match(first.stdout, /slow: still running .* call wait again/)
  const second = job(root, 'wait', 'slow')
  assert.equal(second.status, 0, second.stdout)
  assert.match(second.stdout, /done/)
})

test('a job whose process died without an exit code says so', () => {
  const root = repo()
  job(root, 'start', 'k', '--', 'sleep 30')
  const pid = Number(readFileSync(join(root, '.builder/jobs/k.pid'), 'utf8'))
  process.kill(-pid, 'SIGKILL')
  const w = job(root, 'wait', 'k', '--max', '5')
  assert.equal(w.status, 70)
  assert.match(w.stdout, /k: died without an exit code/)
})

test('starting a name that is still running is refused; a finished one can be re-run', () => {
  const root = repo()
  job(root, 'start', 'r', '--', 'sleep 2')
  const again = job(root, 'start', 'r', '--', 'true')
  assert.equal(again.status, 2)
  assert.match(again.stderr, /r is still running/)
  job(root, 'wait', 'r')
  const rerun = job(root, 'start', 'r', '--', 'echo second')
  assert.equal(rerun.status, 0, rerun.stderr)
  assert.match(job(root, 'wait', 'r').stdout, /second/)
})

test('an unknown job or a bad name is a usage error', () => {
  const root = repo()
  assert.equal(job(root, 'wait', 'nope').status, 2)
  assert.equal(job(root, 'start', 'a/b', '--', 'true').status, 2)
  assert.equal(job(root, 'start', 'x').status, 2)
})
