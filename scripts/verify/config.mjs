// scripts/verify/config.mjs
/**
 * The verifier's config — the `verify:` block of `.claude/builder.md`'s frontmatter
 * (docs/specs/2026-10-27-verifier-design.md §Config).
 *
 * config.mjs's frontmatter parser reads one level of nesting; this block needs maps of maps and
 * one-line flow maps (`server: { runner: node-test, needs: [db] }`), so it has its own small
 * parser: indented maps, flow maps and lists, quoted scalars. Quote a flow value holding , : { } [ ].
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const RUNNERS = ['node-test', 'vitest', 'jest', 'phpunit', 'xcodebuild', 'playwright', 'junit']
export const TIERS = ['commit', 'phase', 'merge']

/** A trailing ` # comment`, outside quotes, removed. */
export function stripComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'") q = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

const scalar = (s) => {
  const t = s.trim()
  if (/^"[\s\S]*"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"')
  if (/^'[\s\S]*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'")
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === '' || t === '~' || t === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

/** `{ a: 1, b: [x, { c: d }] }`, `[a, b]`, or a scalar. */
export function parseFlow(src) {
  let i = 0
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++
  }
  const atom = (stops) => {
    ws()
    const start = i
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++]
      while (i < src.length && src[i] !== q) i++
      i++
      return scalar(src.slice(start, i))
    }
    while (i < src.length && !stops.includes(src[i])) i++
    return scalar(src.slice(start, i))
  }
  // A bare value inside a map stops at ':' too, so "{ a: 1 b: 2 }" is an error rather than the string "1 b: 2".
  const value = (stops = ',}]') => {
    ws()
    if (src[i] === '{') return map()
    if (src[i] === '[') return list()
    return atom(stops)
  }
  const map = () => {
    i++
    const out = {}
    for (;;) {
      ws()
      if (src[i] === '}') {
        i++
        return out
      }
      const key = String(atom(':}'))
      if (src[i] !== ':') throw new Error(`expected ':' after "${key}" in ${src}`)
      i++
      out[key] = value(',}]:')
      ws()
      if (src[i] === ':') throw new Error(`quote the value of "${key}" — it holds ':' (in ${src})`)
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        return out
      }
      throw new Error(`expected ',' or '}' in ${src}`)
    }
  }
  const list = () => {
    i++
    const out = []
    for (;;) {
      ws()
      if (src[i] === ']') {
        i++
        return out
      }
      out.push(value())
      ws()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === ']') {
        i++
        return out
      }
      throw new Error(`expected ',' or ']' in ${src}`)
    }
  }
  const v = value()
  ws()
  if (i < src.length) throw new Error(`unexpected "${src.slice(i)}" in ${src}`)
  return v
}

/** Indented `key: value` lines → nested maps; a value opening with { or [ is a flow value. */
export function parseBlock(lines) {
  const rows = lines
    .map(stripComment)
    .filter((l) => l.trim())
    .map((l) => ({ indent: l.length - l.trimStart().length, body: l.trim() }))
  let i = 0
  const map = (indent) => {
    const out = {}
    while (i < rows.length && rows[i].indent >= indent) {
      const { body, indent: at } = rows[i]
      if (at > indent) throw new Error(`unexpected indentation at "${body}"`)
      const kv = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/.exec(body)
      if (!kv) throw new Error(`expected "key: value" at "${body}"`)
      i++
      const raw = (kv[2] ?? '').trim()
      if (raw === '') out[kv[1]] = i < rows.length && rows[i].indent > at ? map(rows[i].indent) : null
      else out[kv[1]] = /^[{[]/.test(raw) ? parseFlow(raw) : scalar(raw)
    }
    return out
  }
  return rows.length ? map(rows[0].indent) : {}
}

/** The lines under `verify:` in a config's frontmatter, or null when there is none. */
export function verifyLines(text) {
  // A config saved on Windows has CRLF line ends; read it as the same config.
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n?/g, '\n'))
  if (!m) return null
  const lines = m[1].split('\n')
  const at = lines.findIndex((l) => /^verify:\s*(#.*)?$/.test(l))
  if (at < 0) return null
  const out = []
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !/^\s/.test(l) && !l.startsWith('#')) break
    out.push(l)
  }
  return out
}

export function durationMs(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'number') return v * 1000
  const m = /^(\d+)\s*(ms|s|m|h)$/.exec(String(v))
  if (!m) throw new Error(`"${v}" is not a duration (e.g. 90s, 15m)`)
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]
}

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const tiersOf = (v, dflt, where) => {
  const t = v == null ? dflt : list(v)
  for (const x of t) if (!TIERS.includes(x)) throw new Error(`${where}: tier "${x}" is not one of ${TIERS.join(', ')}`)
  return t
}
const needOf = (n, where) => {
  if (n === 'db' || n === 'walk-env' || n === 'simulator') return { kind: n }
  if (n && typeof n === 'object' && Array.isArray(n.ports)) return { kind: 'ports', names: n.ports.map(String) }
  if (typeof n === 'string' && n) return { kind: 'hook', name: n }
  throw new Error(`${where}: can't read need ${JSON.stringify(n)}`)
}

/** A capacity: a positive whole number — zero would queue every run that needs it forever. */
const capacity = (v, dflt, where) => {
  const n = v ?? dflt
  if (!Number.isInteger(n) || n < 1) throw new Error(`${where} must be a positive integer (it is ${JSON.stringify(v)})`)
  return n
}

export function normalizeVerify(raw) {
  const r = raw ?? {}
  const suites = Object.entries(r.suites ?? {}).map(([name, s]) => {
    const where = `verify.suites.${name}`
    if (!s || typeof s !== 'object') throw new Error(`${where}: expected a map`)
    if (!RUNNERS.includes(s.runner)) throw new Error(`${where}: runner "${s.runner}" is not one of ${RUNNERS.join(', ')}`)
    if (s.runner === 'junit' && (!s.command || !s.report)) throw new Error(`${where}: a junit suite needs command (with {files}) and report`)
    if (s.runner === 'xcodebuild' && (!s.scheme || !s.target)) throw new Error(`${where}: an xcodebuild suite needs scheme and target`)
    return {
      name,
      runner: s.runner,
      files: s.files ?? null,
      app: s.app ?? null,
      cwd: s.cwd ?? '.',
      args: s.args ?? '',
      needs: list(s.needs).map((n) => needOf(n, where)),
      tiers: tiersOf(s.tiers, [...TIERS], where),
      command: s.command ?? null,
      report: s.report ?? null,
      scheme: s.scheme ?? null,
      target: s.target ?? null,
      destination: s.destination ?? null,
    }
  })
  const checks = Object.entries(r.checks ?? {}).map(([name, c]) => {
    const where = `verify.checks.${name}`
    if (!c?.run) throw new Error(`${where}: needs run`)
    const compare = c.compare ?? 'exit'
    if (!['exit', 'lines'].includes(compare)) throw new Error(`${where}: compare is exit or lines`)
    return { name, run: String(c.run), cwd: c.cwd ?? '.', compare, match: c.match ?? null, tiers: tiersOf(c.tiers, ['phase', 'merge'], where), needs: list(c.needs).map((n) => needOf(n, where)) }
  })
  if (!suites.length && !checks.length) throw new Error('verify: declares no suites and no checks')
  const db = r.db ? { kind: r.db.kind ?? 'postgres', url: r.db.url, env: list(r.db.env ?? 'DATABASE_URL'), inputs: list(r.db.inputs), prepare: r.db.prepare ?? null, max: capacity(r.db.max, 4, 'verify.db.max') } : null
  if (db && (db.kind !== 'postgres' || !db.url)) throw new Error('verify.db: kind postgres with a url')
  const all = [...suites, ...checks]
  if (all.some((x) => x.needs.some((n) => n.kind === 'db')) && !db) throw new Error('verify: a suite needs db but verify.db is not set')
  if (all.some((x) => x.needs.some((n) => n.kind === 'simulator')) && !r.simulator) throw new Error('verify: a suite needs simulator but verify.simulator is not set')
  const hooks = [...new Set(all.flatMap((x) => x.needs.filter((n) => n.kind === 'hook').map((n) => n.name)))]
  if (hooks.length && !r.env?.lease) {
    throw new Error(`verify: a suite needs ${hooks.map((h) => `"${h}"`).join(', ')} — not db, walk-env, simulator or { ports: [...] }, so it is a hook resource, and verify.env.lease is not set`)
  }
  const workers = capacity(r.workers, 2, 'verify.workers')
  return {
    workers,
    timeoutMs: durationMs(r.timeout, 15 * 60000),
    setup: r.setup ?? null,
    setupInputs: list(r.setup_inputs ?? ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'Podfile.lock']),
    db,
    simulator: r.simulator ? { base: String(r.simulator.base), max: capacity(r.simulator.max, 2, 'verify.simulator.max') } : null,
    env: r.env ? { lease: r.env.lease ?? null, release: r.env.release ?? null, max: capacity(r.env.max, workers, 'verify.env.max') } : null,
    suites,
    checks,
  }
}

/** What an un-migrated 5.x config says: its tests are named in a form the verifier does not read. */
export const OLD_FORMAT = 'this config still uses ## Quality gates — run /builder:init --update to migrate it to verify:'

export function loadVerify(root) {
  const p = join(root, '.claude', 'builder.md')
  if (!existsSync(p)) return { ok: false, reason: 'no .claude/builder.md — run /builder:init' }
  const text = readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')
  const lines = verifyLines(text)
  // A 5.x config names its gates (and flaky list) outside verify: — reading it as "nothing to
  // test" would land every merge untested, so it is broken until it is migrated.
  if (!lines && (/^##\s+Quality gates\b/m.test(text) || /^flaky:/m.test(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''))) return { ok: false, reason: OLD_FORMAT }
  if (!lines) return { ok: false, reason: '.claude/builder.md has no verify: block — run /builder:init --update' }
  try {
    return { ok: true, verify: normalizeVerify(parseBlock(lines)) }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}
