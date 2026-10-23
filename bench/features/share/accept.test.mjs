import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../apps/cli/src/cli.mjs', import.meta.url).pathname
const SERVER = new URL('../apps/server/src/server.mjs', import.meta.url).pathname
const T0 = '2026-03-01T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString()
const scratch = (name) => join(mkdtempSync(join(tmpdir(), 'share-')), name)

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

// every server a test starts, killed at the end whatever failed — a live child would keep the run open
const children = new Set()
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
})

/** The server on a free port, NOTES_NOW and STORE_FILE as given; `stop()` ends it. */
async function startServer({ now = T0, storeFile = null } = {}) {
  const port = await freePort()
  const env = { ...process.env, PORT: String(port), NOTES_NOW: now, SLOW_TESTS_MS: '0' }
  if (storeFile) env.STORE_FILE = storeFile
  else delete env.STORE_FILE
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`the server did not come up on ${port}:\n${out}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const stop = () =>
    new Promise((r) => {
      if (child.exitCode !== null) return r()
      child.once('exit', r)
      child.kill('SIGKILL')
    })
  return { url, stop }
}

/** A CLI user: its own NOTES_FILE (seeded when given a store), pointed at `server`. */
function user(server, seed = null) {
  const file = scratch('notes.json')
  if (seed) writeFileSync(file, JSON.stringify(seed))
  const env = (extra) => {
    const e = { ...process.env, NOTES_FILE: file, ...extra }
    if (server) e.NOTES_SERVER = server.url
    else delete e.NOTES_SERVER
    return e
  }
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: env(), timeout: 20000 }).trim()
  /** Runs a command that must fail: → { status, stderr }. */
  run.fails = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: env(), timeout: 20000 })
    } catch (e) {
      return { status: e.status, stderr: String(e.stderr ?? '') }
    }
    throw new Error(`notes ${args.join(' ')} succeeded but should have failed`)
  }
  return run
}

/** A raw HTTP call → { status, body }. */
async function http(server, method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers['x-owner-token'] = token
  const r = await fetch(server.url + path, { signal: AbortSignal.timeout(10000), method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: r.status, body: parsed }
}

test('share prints a code and another user fetches the note', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const alice = user(server)
  const bob = user(server)
  alice('add', 'buy milk')
  alice('add', 'call mum')
  const code = alice('share', '2')
  assert.match(code, /^[a-z0-9]{8}$/)
  bob('add', 'own note')
  assert.equal(bob('fetch', code), '2')
  assert.equal(bob('list'), '1  own note\n2  call mum')
  assert.notEqual(alice('share', '1'), code, 'every share has its own code')
})

test('shares lists your own unexpired shares, oldest first, with the expiry day', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const alice = user(server)
  const bob = user(server)
  alice('add', 'first')
  alice('add', 'second')
  const a = alice('share', '1', '--days', '3')
  const b = alice('share', '2')
  bob('add', 'bobs')
  bob('share', '1')
  assert.equal(alice('shares'), `${a}  2026-03-04  first\n${b}  2026-03-08  second`)
  assert.equal(user(server)('shares'), '')
})

test('unshare deletes your share; another owner cannot', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const alice = user(server)
  const bob = user(server)
  alice('add', 'secret')
  const code = alice('share', '1')
  const denied = bob.fails('unshare', code)
  assert.equal(denied.status, 1)
  assert.ok(denied.stderr.trim(), 'a message on stderr')
  assert.equal(bob('fetch', code), '1', 'still shared after a refused unshare')
  assert.equal(alice('unshare', code), `unshared ${code}`)
  assert.equal(alice('shares'), '')
  assert.match(user(server).fails('fetch', code).stderr, new RegExp(`no share ${code}`))
  assert.equal(alice.fails('unshare', code).status, 1)
})

test('a share expires after its days, and survives a restart until then', async () => {
  const storeFile = scratch('store.json')
  let server = await startServer({ now: T0, storeFile })
  const a = user(server)
  a('add', 'short lived')
  a('add', 'long lived')
  const short = a('share', '1', '--days', '1')
  const long = a('share', '2', '--days', '5')
  await server.stop()

  // half a day later: both still there, across a restart
  server = await startServer({ now: at(DAY / 2), storeFile })
  const b = user(server)
  assert.equal(b('fetch', short), '1')
  await server.stop()

  // two days later: the 1-day share is gone, the 5-day one is not
  server = await startServer({ now: at(2 * DAY), storeFile })
  try {
    const c = user(server)
    const f = c.fails('fetch', short)
    assert.equal(f.status, 1)
    assert.match(f.stderr, /expired/i)
    assert.equal(c('fetch', long), '1')
    assert.equal((await http(server, 'GET', `/shares/${short}`)).status, 410)
  } finally {
    await server.stop()
  }
})

test('the shares list drops expired shares', async () => {
  const storeFile = scratch('store.json')
  let server = await startServer({ now: T0, storeFile })
  const file = scratch('notes.json')
  const as = (srv) => (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NOTES_FILE: file, NOTES_SERVER: srv.url }, timeout: 20000 }).trim()
  as(server)('add', 'one')
  as(server)('add', 'two')
  as(server)('share', '1', '--days', '1')
  const keep = as(server)('share', '2', '--days', '10')
  await server.stop()
  server = await startServer({ now: at(3 * DAY), storeFile })
  try {
    assert.equal(as(server)('shares'), `${keep}  2026-03-11  two`)
  } finally {
    await server.stop()
  }
})

test('CLI errors: missing note, unknown code, bad days, no server configured, server down', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const alice = user(server)
  alice('add', 'a note')
  const missing = alice.fails('share', '9')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no note 9/)
  assert.match(alice.fails('fetch', 'zzzz0000').stderr, /no share zzzz0000/)
  assert.equal(alice.fails('share', '1', '--days', '0').status, 1)
  assert.equal(alice.fails('share', '1', '--days', '31').status, 1)

  const offline = user(null)
  offline('add', 'x')
  const unset = offline.fails('share', '1')
  assert.equal(unset.status, 1)
  assert.match(unset.stderr, /NOTES_SERVER/)

  const down = user({ url: `http://127.0.0.1:${await freePort()}` })
  down('add', 'x')
  const r = down.fails('shares')
  assert.equal(r.status, 1)
  assert.ok(r.stderr.trim(), 'a message on stderr')
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
})

test('an old notes file without an owner keeps working and can share', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const old = user(server, { nextId: 2, notes: [{ id: 1, text: 'old' }] })
  assert.equal(old('list'), '1  old')
  const code = old('share', '1')
  assert.equal(old('shares'), `${code}  2026-03-08  old`)
  assert.equal(user(server)('fetch', code), '1')
})

test('the API: create, read, list, delete, with the owner token', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  const made = await http(server, 'POST', '/shares', { body: { text: 'hello', days: 2 }, token: 'tok-a' })
  assert.equal(made.status, 201)
  assert.match(made.body.code, /^[a-z0-9]{8}$/)
  assert.equal(made.body.expiresAt, '2026-03-03T12:00:00.000Z')
  const dflt = await http(server, 'POST', '/shares', { body: { text: 'later' }, token: 'tok-a' })
  assert.equal(dflt.body.expiresAt, '2026-03-08T12:00:00.000Z')

  assert.deepEqual(await http(server, 'GET', `/shares/${made.body.code}`), { status: 200, body: { code: made.body.code, text: 'hello', expiresAt: '2026-03-03T12:00:00.000Z' } })
  const list = await http(server, 'GET', '/shares', { token: 'tok-a' })
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.map((s) => [s.code, s.text, s.expiresAt]), [
    [made.body.code, 'hello', '2026-03-03T12:00:00.000Z'],
    [dflt.body.code, 'later', '2026-03-08T12:00:00.000Z'],
  ])
  assert.deepEqual((await http(server, 'GET', '/shares', { token: 'tok-b' })).body, [])

  assert.equal((await http(server, 'DELETE', `/shares/${made.body.code}`, { token: 'tok-b' })).status, 403)
  assert.equal((await http(server, 'DELETE', `/shares/${made.body.code}`, { token: 'tok-a' })).status, 204)
  assert.equal((await http(server, 'GET', `/shares/${made.body.code}`)).status, 404)
  assert.equal((await http(server, 'DELETE', `/shares/${made.body.code}`, { token: 'tok-a' })).status, 404)
})

test('the API: 401 without a token, 400 on bad input, errors as { error }', async (t) => {
  const server = await startServer()
  t.after(server.stop)
  assert.equal((await http(server, 'POST', '/shares', { body: { text: 'x' } })).status, 401)
  assert.equal((await http(server, 'GET', '/shares')).status, 401)
  const made = await http(server, 'POST', '/shares', { body: { text: 'x' }, token: 't' })
  assert.equal((await http(server, 'DELETE', `/shares/${made.body.code}`)).status, 401)
  for (const days of [0, 31, 2.5, 'x']) assert.equal((await http(server, 'POST', '/shares', { body: { text: 'x', days }, token: 't' })).status, 400, `days ${JSON.stringify(days)}`)
  assert.equal((await http(server, 'POST', '/shares', { body: { text: '   ' }, token: 't' })).status, 400)
  const unknown = await http(server, 'GET', '/shares/zzzz0000')
  assert.equal(unknown.status, 404)
  assert.equal(typeof unknown.body?.error, 'string')
})
