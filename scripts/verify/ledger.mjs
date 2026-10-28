/**
 * Everything the verifier knows, as files under <main checkout>/.builder/verify/ (spec §The
 * ledgers): every test result, the target's known failures by test ID, the flake list, the
 * requests with their verdicts, and the target's output lines for `compare: lines` checks.
 * Writes are atomic (temp + rename); the service and the clients share them without locks.
 * Single-writer rule: known-failures.json and flakes.json are written only by the service; a
 * request file is written once by one client, then only by the service; results.jsonl is
 * appended by the service (readers skip a partial last line).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export const FLAKE_CLEAR = 20
export const verifyDir = (root) => join(root, '.builder', 'verify')

const readJson = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return d
  }
}
// Temp + rename, so a reader never sees a half-written file.
const writeAtomic = (p, text) => {
  const t = `${p}.${process.pid}.${randomBytes(2).toString('hex')}.tmp`
  writeFileSync(t, text)
  renameSync(t, p)
}
const writeJson = (p, v) => writeAtomic(p, JSON.stringify(v, null, 2) + '\n')

// Requests sort by createdAt, so two made in the same millisecond would fall back to a random id
// and could swap places. Bump the clock so each request this process makes is strictly later.
let lastMs = 0
const nextMs = () => (lastMs = Math.max(Date.now(), lastMs + 1))

export function openLedger(root) {
  const dir = verifyDir(root)
  mkdirSync(join(dir, 'requests'), { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const P = {
    results: join(dir, 'results.jsonl'),
    known: join(dir, 'known-failures.json'),
    flakes: join(dir, 'flakes.json'),
    req: (id) => join(dir, 'requests', `${id}.json`),
    // v2: lines from the whole output (ec15caf). Sets cached before were built from a 20,000-character tail and are not trusted.
    lines: (sha, name) => join(dir, 'lines-v2', sha, `${name}.txt`),
  }

  const requests = (filter = () => true) =>
    readdirSync(join(dir, 'requests'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(dir, 'requests', f), null))
      .filter(Boolean)
      .filter(filter)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))

  const editKnown = (target, fn) => {
    const all = readJson(P.known, {})
    const cur = all[target] ?? { sha: null, ids: [] }
    all[target] = { sha: cur.sha, ids: [...fn(new Set(cur.ids))].sort() }
    writeJson(P.known, all)
  }

  return {
    dir,
    appendResults(rows) {
      if (rows.length) appendFileSync(P.results, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    },
    /** Test id → latest status, for each of `shas`, read in one pass (the file only grows). */
    resultsAtAll(shas) {
      const by = new Map([...shas].map((s) => [s, new Map()]))
      if (!existsSync(P.results)) return by
      for (const l of readFileSync(P.results, 'utf8').split('\n')) {
        if (!l) continue
        let r
        try {
          r = JSON.parse(l)
        } catch {
          continue // a line another process is still appending
        }
        by.get(r.sha)?.set(r.id, r.status)
      }
      return by
    },
    resultsAt(sha) {
      return this.resultsAtAll([sha]).get(sha)
    },
    known(target) {
      const k = readJson(P.known, {})[target]
      return { sha: k?.sha ?? null, ids: new Set(k?.ids ?? []) }
    },
    setKnown(target, sha, ids) {
      const all = readJson(P.known, {})
      all[target] = { sha, ids: [...ids].sort() }
      writeJson(P.known, all)
    },
    addKnown: (target, ids) => editKnown(target, (s) => (ids.forEach((i) => s.add(i)), s)),
    removeKnown: (target, ids) => editKnown(target, (s) => (ids.forEach((i) => s.delete(i)), s)),
    flakes: () => readJson(P.flakes, {}),
    isFlaky: (id) => Boolean(readJson(P.flakes, {})[id]),
    recordFlip(id) {
      const all = readJson(P.flakes, {})
      const f = all[id] ?? { since: new Date().toISOString(), flips: 0, cleanStreak: 0 }
      all[id] = { ...f, flips: f.flips + 1, cleanStreak: 0 }
      writeJson(P.flakes, all)
    },
    recordClean(ids) {
      const all = readJson(P.flakes, {})
      let changed = false
      for (const id of ids) {
        if (!all[id]) continue
        changed = true
        all[id].cleanStreak += 1
        if (all[id].cleanStreak >= FLAKE_CLEAR) delete all[id]
      }
      if (changed) writeJson(P.flakes, all)
    },
    newRequest(fields) {
      const ms = nextMs()
      const id = `${ms.toString(36)}-${randomBytes(3).toString('hex')}`
      const req = { id, state: 'queued', createdAt: new Date(ms).toISOString(), ...fields }
      writeJson(P.req(id), req)
      return req
    },
    saveRequest: (req) => writeJson(P.req(req.id), req),
    getRequest: (id) => readJson(P.req(id), null),
    requests,
    verdictFor(branch, sha = null) {
      const done = requests((r) => r.branch === branch && r.state === 'done' && r.verdict && (!sha || r.sha === sha))
      return done.at(-1)?.verdict ?? null
    },
    lastGreen(branch, tiers = ['commit', 'phase']) {
      return requests((r) => r.branch === branch && r.state === 'done' && tiers.includes(r.tier) && r.verdict?.status === 'green').at(-1) ?? null
    },
    readLines(sha, name) {
      const p = P.lines(sha, name)
      return existsSync(p) ? new Set(readFileSync(p, 'utf8').split('\n').filter(Boolean)) : null
    },
    writeLines(sha, name, lines) {
      mkdirSync(dirname(P.lines(sha, name)), { recursive: true })
      writeAtomic(P.lines(sha, name), [...lines].join('\n') + '\n')
    },
  }
}
