import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneDbName, laneDbUrl, baseOf, isolated, laneDbPlan } from '../lane-db.mjs'

test('laneDbName: base, root hash, feature, feature hash', () => {
  const n = laneDbName({ base: 'app_test', root: '/r/one', feature: 'user-tags' })
  assert.match(n, /^app_test_ln_[0-9a-f]{6}_user_tags_[0-9a-f]{8}$/)
})

test('laneDbName: two roots give different names for the same feature', () => {
  const a = laneDbName({ base: 'x', root: '/r/one', feature: 'f' })
  const b = laneDbName({ base: 'x', root: '/r/two', feature: 'f' })
  assert.notEqual(a, b)
  assert.equal(a, laneDbName({ base: 'x', root: '/r/one', feature: 'f' }))
})

test('laneDbName: lowercase, [a-z0-9_] only, runs collapse to one underscore, empty base is test', () => {
  const n = laneDbName({ base: '', root: '/r', feature: 'Add  Tags/V2.1' })
  assert.match(n, /^test_ln_[0-9a-f]{6}_add_tags_v2_1_[0-9a-f]{8}$/)
  assert.match(laneDbName({ base: 'My-DB', root: '/r', feature: 'f' }), /^my_db_ln_/)
})

test('laneDbName: capped at 63 characters, the hashes survive, distinct long features differ', () => {
  const long = 'a'.repeat(200)
  const a = laneDbName({ base: 'b', root: '/r', feature: long + '1' })
  const b = laneDbName({ base: 'b', root: '/r', feature: long + '2' })
  assert.ok(a.length <= 63)
  assert.notEqual(a, b)
  assert.match(a, /_[0-9a-f]{8}$/)
  assert.match(a, /^b_ln_[0-9a-f]{6}_/)
})

test('laneDbUrl: postgres and mysql keep credentials and query', () => {
  assert.equal(laneDbUrl('postgres://u:p@h:5432/app?sslmode=disable', 'x_ln'), 'postgres://u:p@h:5432/x_ln?sslmode=disable')
  assert.equal(laneDbUrl('postgresql://h/app', 'n'), 'postgresql://h/n')
  assert.equal(laneDbUrl('mysql://u@h/app?a=1&b=2', 'n'), 'mysql://u@h/n?a=1&b=2')
  assert.equal(laneDbUrl('mariadb://h:3306/app', 'n'), 'mariadb://h:3306/n')
})

test('laneDbUrl: sqlite and file replace the basename stem', () => {
  assert.equal(laneDbUrl('sqlite:./data/app.db', 'n'), 'sqlite:./data/n.db')
  assert.equal(laneDbUrl('file:/var/x/dev.sqlite', 'n'), 'file:/var/x/n.sqlite')
  assert.equal(laneDbUrl('file:./app', 'n'), 'file:./n')
})

test('laneDbUrl: unrecognised is null', () => {
  assert.equal(laneDbUrl('redis://h/0', 'n'), null)
  assert.equal(laneDbUrl('nonsense', 'n'), null)
  assert.equal(laneDbUrl('', 'n'), null)
  assert.equal(laneDbUrl(undefined, 'n'), null)
})

test('baseOf: the database name in the URL', () => {
  assert.equal(baseOf('postgres://u:p@h/app_test?x=1'), 'app_test')
  assert.equal(baseOf('sqlite:./data/app.db'), 'app')
  assert.equal(baseOf('redis://h/0'), null)
})

test('isolated: test_db_env, or a database worktree_env value with {feature}', () => {
  assert.equal(isolated({ testDbEnv: 'DATABASE_URL' }), true)
  assert.equal(isolated({ worktreeEnv: { DATABASE_URL: 'postgres://h/app_{feature}' } }), true)
  assert.equal(isolated({ worktreeEnv: { TEST_DB: 'x_{feature}' } }), true)
  assert.equal(isolated({ worktreeEnv: { PORT: '{feature}' } }), false)
  assert.equal(isolated({ worktreeEnv: { DATABASE_URL: 'postgres://h/app' } }), false)
  assert.equal(isolated({}), false)
  assert.equal(isolated(undefined), false)
})

test('laneDbPlan: create and drop through psql, migrate is verify.db.prepare with the lane URL in every env var', () => {
  const p = laneDbPlan({ verifyDb: { url: 'postgres://u:p@h/app', env: ['DATABASE_URL', 'TEST_DATABASE_URL'], prepare: 'npm run migrate' }, url: 'postgres://u:p@h/app', name: 'app_ln_x' })
  assert.match(p.create, /^psql 'postgres:\/\/u:p@h\/app' -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "app_ln_x"'$/)
  assert.match(p.drop, /DROP DATABASE IF EXISTS "app_ln_x" WITH \(FORCE\)/)
  assert.equal(p.migrate, "DATABASE_URL='postgres://u:p@h/app_ln_x' TEST_DATABASE_URL='postgres://u:p@h/app_ln_x' npm run migrate")
})

test('laneDbPlan: no prepare gives no migrate; no verify.db or a non-postgres URL gives nulls', () => {
  const url = 'postgres://h/app'
  assert.equal(laneDbPlan({ verifyDb: { url, env: ['DATABASE_URL'], prepare: null }, url, name: 'n' }).migrate, null)
  assert.deepEqual(laneDbPlan({ verifyDb: null, url, name: 'n' }), { create: null, migrate: null, drop: null })
  assert.deepEqual(laneDbPlan({ verifyDb: { url: 'mysql://h/a', env: ['D'], prepare: 'x' }, url: 'mysql://h/a', name: 'n' }), { create: null, migrate: null, drop: null })
})
