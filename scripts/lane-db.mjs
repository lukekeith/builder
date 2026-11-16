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

/** The root's hash in every lane database name of this checkout: `_ln_<hash6>_` (laneDbName). */
export const laneRootTag = (root) => `_ln_${sha1(String(root)).slice(0, 6)}_`

/**
 * What it takes to create, migrate, drop and list the lane databases on the server `url` names.
 * verify.db is postgres-only, so any other URL, or no verify.db, gives nulls. `migrate` is
 * verify.db.prepare, run in the worktree with `migrateEnv` — every verify.db.env variable, and
 * `testDbEnv` when given, set to the lane URL — merged into its env, never as a shell prefix (that
 * reaches only a compound command's first part). `list` prints every lane database this checkout
 * (`root`) made, one name a line, for the reaper.
 */
export function laneDbPlan({ verifyDb, url, name, testDbEnv = null, root = null }) {
  const none = { create: null, migrate: null, migrateEnv: {}, drop: null, list: null }
  if (!verifyDb || !/^postgres(ql)?:\/\//i.test(String(url ?? ''))) return none
  const lane = name ? laneDbUrl(url, name) : null
  const sql = (s) => `psql ${q(url)} -v ON_ERROR_STOP=1 -c ${q(s)}`
  const vars = [...new Set([...(verifyDb.env?.length ? verifyDb.env : ['DATABASE_URL']), ...(testDbEnv ? [testDbEnv] : [])])]
  const like = root ? laneRootTag(root).replace(/_/g, '\\_') : null
  return {
    create: name ? sql(`CREATE DATABASE "${name}"`) : null,
    migrate: name && verifyDb.prepare ? verifyDb.prepare : null,
    migrateEnv: lane ? Object.fromEntries(vars.map((v) => [v, lane])) : {},
    drop: name ? sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) : null,
    list: like ? `psql ${q(url)} -v ON_ERROR_STOP=1 -Atc ${q(`SELECT datname FROM pg_database WHERE datname LIKE '%${like}%'`)}` : null,
  }
}
