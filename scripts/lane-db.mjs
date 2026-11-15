// scripts/lane-db.mjs
/**
 * A test database per worktree (docs/specs/2026-11-14-group-lanes-design.md D14). Pure: names, URLs and the
 * shell commands for a lane's database; the fleet runs them. The create and drop commands go through psql
 * and the migrate command is verify.db.prepare, because that is all verify.db defines (scripts/verify/config.mjs:
 * `{ kind: postgres, url, env: [vars], inputs, prepare, max }`, with envpool.mjs doing the same CREATE/DROP).
 */
import { createHash } from 'node:crypto'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
const MAX = 63 // Postgres identifier limit; MySQL allows 64.

/** `<base>_ln_<root hash6>_<feature>_<hash8>`: the root hash keeps two checkouts on one server apart. */
export function laneDbName({ base, root, feature }) {
  const b = clean(base) || 'test'
  const f = clean(feature)
  const h6 = sha1(String(root)).slice(0, 6)
  const h8 = sha1(`${root}\0${feature}`).slice(0, 8)
  const tail = `_${h6}`
  const fixed = (bs, fs) => `${bs}_ln${tail}${fs ? `_${fs}` : ''}_${h8}`
  // The sanitised feature gives way first, then the base — never the hashes.
  let fs = f
  while (fs && fixed(b, fs).length > MAX) fs = fs.slice(0, -1).replace(/_+$/, '')
  let bs = b
  while (bs.length > 1 && fixed(bs, fs).length > MAX) bs = bs.slice(0, -1)
  return fixed(bs, fs)
}

const SERVER = /^(postgres|postgresql|mysql|mariadb):\/\//i
const FILE = /^(sqlite|file):/i

/** The URL with its database replaced by `name`, or null when the scheme is not one it knows. */
export function laneDbUrl(url, name) {
  const s = typeof url === 'string' ? url.trim() : ''
  if (SERVER.test(s)) {
    const m = /^([a-z]+:\/\/[^/?#]*)(\/[^?#]*)?(.*)$/i.exec(s)
    return `${m[1]}/${name}${m[3]}`
  }
  if (FILE.test(s)) {
    const m = /^([^?#]*?)([^/?#:]*?)(\.[^./?#]+)?([?#].*)?$/.exec(s)
    return `${m[1]}${name}${m[3] ?? ''}${m[4] ?? ''}`
  }
  return null
}

/** The database name in the URL (the `base` for laneDbName), or null when unrecognised. */
export function baseOf(url) {
  const s = typeof url === 'string' ? url.trim() : ''
  if (SERVER.test(s)) {
    const m = /^[a-z]+:\/\/[^/?#]*\/([^?#]*)/i.exec(s)
    return m && m[1] ? decodeURIComponent(m[1]) : null
  }
  if (FILE.test(s)) {
    const m = /([^/?#:]*?)(\.[^./?#]+)?([?#].*)?$/.exec(s)
    return m && m[1] ? m[1] : null
  }
  return null
}

/** True when each worktree already gets its own database: test_db_env, or a database worktree_env value with {feature}. */
export function isolated(agentWalk) {
  if (!agentWalk) return false
  if (agentWalk.testDbEnv) return true
  return Object.entries(agentWalk.worktreeEnv ?? {}).some(([k, v]) => /DATABASE|(^|_)DB(_|$)/i.test(k) && String(v).includes('{feature}'))
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * Shell commands to create, migrate and drop the lane database `name` on the server `url` names.
 * verify.db is postgres-only, so any other URL, or no verify.db, gives nulls; no `prepare` gives no migrate.
 * The migrate command runs in the worktree, with every verify.db.env variable set to the lane URL.
 */
export function laneDbPlan({ verifyDb, url, name }) {
  const none = { create: null, migrate: null, drop: null }
  if (!verifyDb || !/^postgres(ql)?:\/\//i.test(String(url ?? ''))) return none
  const lane = laneDbUrl(url, name)
  const sql = (s) => `psql ${q(url)} -v ON_ERROR_STOP=1 -c ${q(s)}`
  const vars = (verifyDb.env?.length ? verifyDb.env : ['DATABASE_URL']).map((v) => `${v}=${q(lane)}`).join(' ')
  return {
    create: sql(`CREATE DATABASE "${name}"`),
    migrate: verifyDb.prepare ? `${vars} ${verifyDb.prepare}` : null,
    drop: sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  }
}
