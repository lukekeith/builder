// scripts/test/verify-envpool.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPool, freePort } from '../verify/envpool.mjs'

const V = (o = {}) => ({ workers: 2, db: { kind: 'postgres', url: 'postgres://u:p@localhost:5432/app', env: ['TEST_DATABASE_URL'], inputs: [], prepare: 'npm run migrate', max: 2 }, simulator: { base: 'iPhone 16', max: 1 }, env: { lease: './up.sh', release: './down.sh', max: 1 }, ...o })
function fakes() {
  const sql = [], cmds = []
  const dbs = new Set()
  const psql = (url, s) => {
    sql.push(s)
    if (/SELECT 1 FROM pg_database WHERE datname = '(.+)'/.test(s)) return dbs.has(RegExp.$1) ? '1' : ''
    if (/SELECT datname/.test(s)) return [...dbs].join('\n')
    let m
    if ((m = /CREATE DATABASE "([^"]+)"/.exec(s))) dbs.add(m[1])
    if ((m = /DROP DATABASE IF EXISTS "([^"]+)"/.exec(s))) dbs.delete(m[1])
    if ((m = /ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(s))) (dbs.delete(m[1]), dbs.add(m[2]))
    return ''
  }
  const sh = (cmd, o = {}) => {
    cmds.push({ cmd, env: o.env })
    if (cmd.startsWith('xcrun simctl clone')) return 'UDID-1\n'
    if (cmd === './up.sh') return 'API_URL=http://x\nnoise\n'
    return ''
  }
  return { sql, cmds, dbs, psql, sh }
}

test('a db lease is a template clone, its URL under each configured name; release drops it', async () => {
  const f = fakes()
  const pool = createPool(V(), { sh: f.sh, psql: f.psql })
  const tpl = pool.ensureTemplate('/co', 'abcdef0123456789')
  assert.equal(tpl, 'app_vt_tpl_abcdef012345')
  assert.ok(f.cmds.some((c) => c.cmd === 'npm run migrate' && new RegExp(`app_vt_tpl_abcdef012345_b_${process.pid}$`).test(c.env.TEST_DATABASE_URL)))
  assert.equal(pool.ensureTemplate('/co', 'abcdef0123456789'), tpl)
  assert.equal(f.cmds.filter((c) => c.cmd === 'npm run migrate').length, 1)
  const l = await pool.lease([{ kind: 'db' }], { template: tpl, cwd: '/co' })
  assert.match(l.env.TEST_DATABASE_URL, /^postgres:\/\/u:p@localhost:5432\/app_vt_\d+_1$/)
  assert.ok(f.sql.some((s) => /CREATE DATABASE "app_vt_\d+_1" TEMPLATE "app_vt_tpl_abcdef012345"/.test(s)))
  l.release()
  l.release()
  assert.equal(f.sql.filter((s) => /DROP DATABASE IF EXISTS "app_vt_\d+_1"/.test(s)).length, 1)
})

test('capacity: leases beyond max return null until one is released', async () => {
  const f = fakes()
  const pool = createPool(V(), { sh: f.sh, psql: f.psql })
  const a = await pool.lease([{ kind: 'walk-env' }], {})
  assert.equal(pool.canLease([{ kind: 'walk-env' }]), false)
  assert.equal(await pool.lease([{ kind: 'walk-env' }], {}), null)
  a.release()
  assert.ok(await pool.lease([{ kind: 'walk-env' }], {}))
})

test('ports, simulator and hook leases', async () => {
  const f = fakes()
  const pool = createPool(V(), { sh: f.sh, psql: f.psql })
  const l = await pool.lease([{ kind: 'ports', names: ['PORT', 'WEB_PORT'] }, { kind: 'simulator' }, { kind: 'hook', name: 'redis' }], { cwd: '/co' })
  assert.match(l.env.PORT, /^\d+$/)
  assert.notEqual(l.env.PORT, l.env.WEB_PORT)
  assert.equal(l.env.SIMULATOR_UDID, 'UDID-1')
  assert.equal(l.env.API_URL, 'http://x')
  l.release()
  assert.ok(f.cmds.some((c) => c.cmd === 'xcrun simctl delete UDID-1'))
  assert.ok(f.cmds.some((c) => c.cmd === './down.sh' && c.env.API_URL === 'http://x' && c.env.BUILDER_NEED === 'redis'))
})

test('a failed lease releases what it took', async () => {
  const f = fakes()
  const pool = createPool(V(), { sh: (cmd, o) => { if (cmd === './up.sh') throw new Error('no redis'); return f.sh(cmd, o) }, psql: f.psql })
  await assert.rejects(pool.lease([{ kind: 'simulator' }, { kind: 'hook', name: 'redis' }], { cwd: '/co' }), /no redis/)
  assert.ok(f.cmds.some((c) => c.cmd === 'xcrun simctl delete UDID-1'))
  assert.equal(pool.canLease([{ kind: 'simulator' }]), true)
})

test('dropOrphans drops leftover clones, keeps templates', () => {
  const f = fakes()
  f.dbs.add('app_vt_123_4')
  f.dbs.add('app_vt_tpl_abc')
  const pool = createPool(V(), { sh: f.sh, psql: f.psql, alive: () => false })
  assert.deepEqual(pool.dropOrphans(), ['app_vt_123_4'])
  assert.deepEqual([...f.dbs], ['app_vt_tpl_abc'])
})

test('freePort gives distinct usable ports', async () => {
  const [a, b] = await Promise.all([freePort(), freePort()])
  assert.ok(a > 0 && b > 0)
  assert.notEqual(a, b)
})

test('dropOrphans matches the base name literally and clears crashed template builds', () => {
  const f = fakes()
  const v = V({ db: { ...V().db, url: 'postgres://u:p@localhost:5432/my_app' } })
  for (const d of ['myXapp_vt_1_1', 'my_app_vt_1_1', 'my_app_vt_tpl_abc_b_1', 'my_app_vt_tpl_abc_building', 'my_app_vt_tpl_abc']) f.dbs.add(d)
  const pool = createPool(v, { sh: f.sh, psql: f.psql, alive: () => false })
  assert.deepEqual(pool.dropOrphans().sort(), ['my_app_vt_1_1', 'my_app_vt_tpl_abc_b_1', 'my_app_vt_tpl_abc_building'])
  assert.deepEqual([...f.dbs].sort(), ['myXapp_vt_1_1', 'my_app_vt_tpl_abc'])
})

test('a database name that is not a plain identifier is refused', () => {
  const f = fakes()
  const bad = V({ db: { ...V().db, url: 'postgres://u:p@localhost:5432/ap%22p' } })
  assert.throws(() => createPool(bad, { sh: f.sh, psql: f.psql }), /verify\.db\.url: the database name "ap"p" must be letters, digits or _ \(at most 30\)/)
})

test('db capacity holds under concurrent leases', async () => {
  const f = fakes()
  const v = V({ db: { ...V().db, max: 1 } })
  const pool = createPool(v, { sh: f.sh, psql: f.psql })
  const r = await Promise.all([pool.lease([{ kind: 'db' }], { template: 't' }), pool.lease([{ kind: 'db' }], { template: 't' })])
  assert.equal(r.filter(Boolean).length, 1)
})

test('dropOrphans leaves the clones and template builds of a live process alone — another repo service may own them', () => {
  const f = fakes()
  for (const d of ['app_vt_42_1', 'app_vt_7_1', 'app_vt_tpl_abc_b_42', 'app_vt_tpl_abc_b_7', 'app_vt_tpl_abc']) f.dbs.add(d)
  const pool = createPool(V(), { sh: f.sh, psql: f.psql, alive: (pid) => pid === 42 })
  assert.deepEqual(pool.dropOrphans().sort(), ['app_vt_7_1', 'app_vt_tpl_abc_b_7'])
  assert.deepEqual([...f.dbs].sort(), ['app_vt_42_1', 'app_vt_tpl_abc', 'app_vt_tpl_abc_b_42'])
})

test('a psql failure never puts the connection password in its message', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { psql } = await import('../verify/envpool.mjs')
  const bin = mkdtempSync(join(tmpdir(), 'vpsql-'))
  writeFileSync(join(bin, 'psql'), '#!/bin/sh\necho "could not connect: $1" >&2\nexit 2\n')
  chmodSync(join(bin, 'psql'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    assert.throws(
      () => psql('postgres://app:s3cret-pw@localhost:5432/app', 'SELECT 1'),
      (e) => !/s3cret-pw/.test(e.message) && /app:\*\*\*@localhost/.test(e.message),
    )
  } finally {
    process.env.PATH = path
  }
})

test('psql missing from PATH says verify.db needs it', async () => {
  const { psql } = await import('../verify/envpool.mjs')
  const saved = process.env.PATH
  process.env.PATH = '/nonexistent-dir'
  try {
    assert.throws(() => psql('postgres://localhost/x', 'select 1'), /^Error: verify\.db needs the psql command on PATH$/)
  } finally {
    process.env.PATH = saved
  }
})
