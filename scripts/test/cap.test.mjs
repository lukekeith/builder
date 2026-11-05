import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const CAP = join(dirname(fileURLToPath(import.meta.url)), '..', 'cap.mjs')
const cap = (...args) => spawnSync('node', [CAP, ...args], { encoding: 'utf8' })

test('passes the command its exit code and output through', () => {
  const r = cap('5', 'echo hi; exit 3')
  assert.equal(r.status, 3)
  assert.equal(r.stdout, 'hi\n')
})

test('runs several arguments as given, without a shell', () => {
  const r = cap('5', 'node', '-e', 'process.stdout.write(process.argv[1])', 'a b')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'a b')
})

test('kills a hung command and everything it started, exit 124', () => {
  const t0 = Date.now()
  // a child that outlives its shell: only a group kill reaches it
  const r = cap('1', 'sleep 30 & echo $! ; wait')
  assert.equal(r.status, 124)
  assert.ok(Date.now() - t0 < 8000, 'returned promptly')
  assert.match(r.stderr, /killed after 1s/)
  const pid = Number(r.stdout.trim())
  assert.throws(() => process.kill(pid, 0), 'the background sleep is gone too')
})

test('a command that cannot start is 127 with the reason, never silent', () => {
  const r = cap('5', 'no-such-binary-xyz', '--x')
  assert.equal(r.status, 127)
  assert.match(r.stderr, /could not start no-such-binary-xyz/)
})

test('usage errors exit 2', () => {
  assert.equal(cap('0', 'true').status, 2)
  assert.equal(cap('5').status, 2)
  assert.throws(() => execFileSync('node', [CAP], { stdio: 'ignore' }))
})
