/**
 * Isolated environments (spec §Environments): a Postgres database cloned from a template per
 * lease, free ports by name, a cloned simulator, the walk env (one at a time), and project hooks
 * for anything else. Capacity is counted here; a lease the pool can't grant now returns null.
 */
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { sh as shell } from './git.mjs'

export const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

export const psql = (url, sql) => {
  try {
    return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    // psql says why on stderr; the default message is only "Command failed".
    throw new Error(`${e.message}${e.stderr ? `\n${String(e.stderr).trim()}` : ''}`)
  }
}

// Hash of the staged/committed content of the files a template is built from: when it changes,
// the template is stale and a new one is built.
export const inputsHash = (checkout, globs) => createHash('sha256').update(execFileSync('git', ['ls-files', '-s', '--', ...globs], { cwd: checkout, encoding: 'utf8' })).digest('hex')

const dbName = (url) => decodeURIComponent(new URL(url).pathname.slice(1))
const withDb = (url, name) => {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

export function createPool(verify, { sh = shell, psql: pg = psql, ports = freePort } = {}) {
  const used = { db: 0, simulator: 0, 'walk-env': 0, hook: 0 }
  const cap = { db: verify.db?.max ?? 0, simulator: verify.simulator?.max ?? 0, 'walk-env': 1, hook: verify.env?.max ?? verify.workers }
  const counted = (needs) => needs.map((n) => n.kind).filter((k) => k in used)
  const base = verify.db ? dbName(verify.db.url) : null
  // Names go straight into SQL, so only plain identifiers; 30 keeps every derived name under
  // Postgres's 63-byte limit.
  if (base !== null && !/^[A-Za-z0-9_]{1,30}$/.test(base)) throw new Error(`verify.db.url: the database name "${base}" must be letters, digits or _ (at most 30)`)
  let seq = 0

  const pool = {
    canLease(needs) {
      const want = {}
      for (const k of counted(needs)) want[k] = (want[k] ?? 0) + 1
      return Object.entries(want).every(([k, n]) => used[k] + n <= cap[k])
    },
    async lease(needs, { template = null, cwd } = {}) {
      if (!pool.canLease(needs)) return null
      for (const k of counted(needs)) used[k]++
      const env = {}
      const undo = []
      const unwind = () => {
        for (const u of undo.reverse()) {
          try {
            u()
          } catch {}
        }
        for (const k of counted(needs)) used[k]--
      }
      try {
        for (const n of needs) {
          if (n.kind === 'db') {
            const name = `${base}_vt_${process.pid}_${++seq}`
            pg(verify.db.url, `CREATE DATABASE "${name}" TEMPLATE "${template}"`)
            undo.push(() => pg(verify.db.url, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
            for (const v of verify.db.env) env[v] = withDb(verify.db.url, name)
          } else if (n.kind === 'ports') {
            for (const v of n.names) env[v] = String(await ports())
          } else if (n.kind === 'simulator') {
            const udid = sh(`xcrun simctl clone ${JSON.stringify(verify.simulator.base)} vt-${process.pid}-${++seq}`, { cwd }).trim()
            undo.push(() => sh(`xcrun simctl delete ${udid}`, { cwd }))
            env.SIMULATOR_UDID = udid
          } else if (n.kind === 'hook') {
            const out = sh(verify.env.lease, { cwd, env: { ...process.env, BUILDER_NEED: n.name } })
            const pairs = Object.fromEntries(
              out
                .split('\n')
                .map((l) => /^([A-Za-z_]\w*)=(.*)$/.exec(l.trim()))
                .filter(Boolean)
                .map((m) => [m[1], m[2]]),
            )
            Object.assign(env, pairs)
            if (verify.env.release) undo.push(() => sh(verify.env.release, { cwd, env: { ...process.env, ...pairs, BUILDER_NEED: n.name } }))
          }
          // walk-env: an exclusive slot; the env vars are agent_walk's, added by the service.
        }
      } catch (e) {
        unwind()
        throw e
      }
      let released = false
      return {
        env,
        release() {
          if (released) return
          released = true
          unwind()
        },
      }
    },
    templateName: (hash) => `${base}_vt_tpl_${hash.slice(0, 12)}`,
    ensureTemplate(checkout, hash) {
      const tpl = pool.templateName(hash)
      if (pg(verify.db.url, `SELECT 1 FROM pg_database WHERE datname = '${tpl}'`) === '1') return tpl
      const building = `${tpl}_building`
      pg(verify.db.url, `DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`)
      pg(verify.db.url, `CREATE DATABASE "${building}"`)
      try {
        if (verify.db.prepare) sh(verify.db.prepare, { cwd: checkout, env: { ...process.env, ...Object.fromEntries(verify.db.env.map((v) => [v, withDb(verify.db.url, building)])) } })
        pg(verify.db.url, `ALTER DATABASE "${building}" RENAME TO "${tpl}"`)
      } catch (e) {
        pg(verify.db.url, `DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`)
        throw e
      }
      return tpl
    },
    dropOrphans() {
      if (!verify.db) return []
      // Filter in JS: the base name may contain "_", a LIKE wildcard that would match other projects.
      const names = pg(verify.db.url, 'SELECT datname FROM pg_database')
        .split('\n')
        .filter((n) => n.startsWith(`${base}_vt_`) && (!n.startsWith(`${base}_vt_tpl_`) || n.endsWith('_building')))
      for (const n of names) pg(verify.db.url, `DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`)
      return names
    },
  }
  return pool
}
