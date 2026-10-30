// Benchmark suite core: case catalogue, estimates, lane packing, budget fill. Pure — no I/O.
import { runTotals, median } from './bench-core.mjs'
import { duration, formatTokens } from './fleet-core.mjs'

export const SIZES = ['xs', 'sm', 'md', 'lg', 'xl']

// ── estimates ──
const cents = (n) => Math.round(n * 100) / 100
const sum = (xs) => xs.reduce((a, x) => a + x, 0)

/** A row's wall ms (else Σ timing ms) and cost (else Σ timing cost); each null when it has no source. */
function wallCost(row) {
  const timing = row.timing ?? []
  const ms = row.wallMs > 0 ? row.wallMs : sum(timing.map((t) => t.ms ?? 0))
  const tc = sum(timing.map((t) => t.tokens?.costUsd ?? 0))
  const usd = row.costUsd > 0 ? row.costUsd : tc > 0 ? tc : null
  return { ms: ms > 0 ? ms : null, usd }
}

/**
 * An archive row's estimate: wallMs (else Σ timing ms) less the human wait in it — stages.parked and
 * walkQueueMs — but never below Σ timing ms, → whole minutes up; costUsd (else Σ timing cost) → cents.
 */
export function estimateFromRow(row) {
  const { ms: wall, usd } = wallCost(row)
  if (wall == null) return null
  const wait = (row.stages?.parked > 0 ? row.stages.parked : 0) + (row.walkQueueMs > 0 ? row.walkQueueMs : 0)
  const work = sum((row.timing ?? []).map((t) => t.ms ?? 0))
  const ms = Math.max(wall - wait, work, 0) || wall
  return { minutes: Math.ceil(ms / 60000), usd: usd == null ? null : cents(usd) }
}

/** A runs.json estimate: median ms and median cost over the config's done runs. */
export function estimateFromRuns(runsJson, config = 'builder') {
  const done = (runsJson?.runs ?? []).filter((r) => r.config === config && r.status === 'done')
  if (!done.length) return null
  const ms = median(done.map((r) => r.ms ?? 0))
  const usd = median(done.map((r) => runTotals(r.sessions ?? []).costUsd))
  return { minutes: Math.ceil(ms / 60000), usd: usd > 0 ? cents(usd) : null }
}

/** The fleet timeout the suite gives a case: 3× its estimate, at least an hour; with no estimate, 6 h — a hung case never holds its lane for the case runner's 24 h. */
export function caseFleetTimeoutMs(estimate) {
  const m = estimate?.minutes
  return (m > 0 ? Math.max(3 * m, 60) : 6 * 60) * 60000
}

/** One pick line for a case. */
export function pickLabel(c) {
  const head = `${c.size} · ${c.id} — ${c.covers}`
  if (!c.estimate) return `${head} · no estimate yet`
  return `${head} · ~${c.estimate.minutes}m · ~$${c.estimate.usd ?? '?'}`
}

// ── lane packing ──
/** Longest first onto the lane that can start it earliest; one project never overlaps itself. */
export function packLanes(items, lanes) {
  const order = [...items].sort((a, b) => b.estimate.minutes - a.estimate.minutes || a.id.localeCompare(b.id))
  const out = Array.from({ length: lanes }, () => [])
  const free = Array(lanes).fill(0), projectFree = new Map()
  for (const it of order) {
    const starts = free.map((f) => Math.max(f, projectFree.get(it.project) ?? 0))
    const lane = starts.indexOf(Math.min(...starts))
    const start = starts[lane], end = start + it.estimate.minutes
    out[lane].push({ id: it.id, project: it.project, start, end }); free[lane] = end; projectFree.set(it.project, end)
  }
  return { lanes: out, wallMinutes: Math.max(0, ...out.flat().map((x) => x.end)), usd: cents(sum(items.map((i) => i.estimate.usd ?? 0))) }
}

// ── budget fill ──
/** Pick cases round-robin across sizes (xl first, shortest first within a size) while the packed wall time fits. */
export function fillBudget(cases, { minutes, lanes }) {
  const picked = [], skipped = []
  const queues = new Map(SIZES.map((s) => [s, []]))
  for (const c of cases) {
    if (!c.estimate) skipped.push({ id: c.id, reason: 'no estimate' })
    else queues.get(c.size)?.push(c)
  }
  for (const q of queues.values()) q.sort((a, b) => a.estimate.minutes - b.estimate.minutes || a.id.localeCompare(b.id))
  let took = true
  while (took) {
    took = false
    for (const size of [...SIZES].reverse()) {
      const c = queues.get(size).shift()
      if (!c) continue
      if (packLanes([...picked, c], lanes).wallMinutes <= minutes) { picked.push(c); took = true }
      else skipped.push({ id: c.id, reason: `does not fit ${minutes}m` })
    }
  }
  return { picked, skipped }
}

/** Two picked projects whose profiles name one port may run at once: one reason per shared port. `ports` maps project → ports. */
export function portCollisions(ports) {
  const by = new Map()
  for (const [project, ps] of ports) for (const p of ps) by.set(p, [...(by.get(p) ?? []), project])
  return [...by].filter(([, ps]) => new Set(ps).size > 1).sort((a, b) => a[0] - b[0])
    .map(([port, ps]) => { const u = [...new Set(ps)].sort(); return `projects ${u.slice(0, -1).join(', ')} and ${u.at(-1)} both use port ${port} — they may run at once` })
}

// ── controls ──
/** Per size, in SIZES order, the archived case with the smallest estimate. */
export function recommendControls(cases) {
  const out = []
  for (const size of SIZES) {
    const best = cases.filter((c) => c.kind === 'archived' && c.size === size && c.estimate)
      .sort((a, b) => a.estimate.minutes - b.estimate.minutes || a.id.localeCompare(b.id))[0]
    if (best) out.push(best.id)
  }
  return out
}

// ── profile application and the safety check ──
// The front matter is the YAML between the first two `---` lines; only agent_walk (a map of one-line scalars) and verify (a whole top-level block) are edited, every other line is kept as it is.
const splitFm = (md) => {
  const m = /^---\n([\s\S]*?\n)?---(\n|$)/.exec(md)
  if (!m) return { fm: [], rest: md, bare: true }
  return { fm: (m[1] ?? '').split('\n').slice(0, -1), rest: md.slice(m[0].length), tail: m[2] }
}
/** The end (exclusive) of the top-level block that starts at line `i`: indented lines, blank lines and `- ` items belong to it. */
const blockEnd = (lines, i) => {
  let end = i + 1
  for (let j = i + 1; j < lines.length; j++) {
    if (/^(\s|-\s|-$)/.test(lines[j]) && lines[j].trim() !== '') end = j + 1
    else if (lines[j].trim() !== '') break
  }
  return end
}

/** A clone's builder.md with the profile's agent_walk keys and claude_args set and the verify block swapped; the body is untouched. */
export function applyProfile(builderMd, { agentWalk = {}, verifyBlock, claudeArgs }) {
  if (!claudeArgs) throw new Error('applyProfile: claudeArgs is required')
  const { fm, rest, tail = '\n' } = splitFm(builderMd)
  const set = { ...agentWalk, claude_args: claudeArgs }
  let at = fm.findIndex((l) => /^agent_walk:\s*(\{\s*\})?\s*(#.*)?$/.test(l))
  if (at < 0) { fm.push('agent_walk:'); at = fm.length - 1 }
  else fm[at] = fm[at].replace(/^agent_walk:\s*\{\s*\}/, 'agent_walk:')
  for (const [k, v] of Object.entries(set)) {
    const end = blockEnd(fm, at)
    const own = fm.findIndex((l, i) => i > at && i < end && l.startsWith(`  ${k}:`))
    if (own >= 0) fm[own] = `  ${k}: ${v}`
    else fm.splice(end, 0, `  ${k}: ${v}`)
  }
  if (verifyBlock != null) {
    const block = verifyBlock.replace(/\n+$/, '').split('\n')
    const v = fm.findIndex((l) => /^verify:/.test(l))
    if (v >= 0) fm.splice(v, blockEnd(fm, v) - v, ...block)
    else fm.push(...block)
  }
  return `---\n${fm.join('\n')}\n---${tail}${rest}`
}

/** A config's agent_walk.claude_args (its comment dropped), or '' when it has none. */
export const ownClaudeArgs = (md) => {
  const { fm } = splitFm(normalize(md))
  const at = fm.findIndex((l) => /^agent_walk:/.test(l))
  if (at < 0) return ''
  return fm.slice(at + 1, blockEnd(fm, at)).map((l) => /^\s+claude_args:\s*(.*?)\s*(#.*)?$/.exec(l)?.[1]).find((x) => x != null) ?? ''
}
/** The flags the runner owns — a session's permissions, settings and plugins — and the unset placeholder, dropped from a claude_args. */
const RUNNER_FLAG = /^--(?:permission-mode|settings|plugin-dir)$/
const withoutRunnerFlags = (args) => {
  const words = String(args ?? '').split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < words.length; i++) {
    if (RUNNER_FLAG.test(words[i])) i++
    else if (!/^--(?:permission-mode|settings|plugin-dir)=/.test(words[i]) && words[i] !== '{claude_args}') out.push(words[i])
  }
  return out.join(' ')
}
/** The clone's agent_walk.claude_args: the runner's flags, then the profile's claude_args when set, else the project's own in `baseMd` — either without the runner's flags. */
export function walkClaudeArgs(runner, baseMd, profileArgs) {
  const rest = withoutRunnerFlags(profileArgs != null && String(profileArgs).trim() ? profileArgs : ownClaudeArgs(baseMd))
  return rest ? `${runner} ${rest}` : runner
}

/** A config's front matter alone (without its `---` rules), '' with none — what a port is taken from; the body is prose. */
export const frontMatterText = (md) => splitFm(normalize(md)).fm.join('\n')

/** A profile's `replace` — [["from", "to"], …] — applied in order to the whole builder.md as literal text; each must match at least once. → { md, refusals } */
export function applyReplacements(md, replace) {
  if (replace == null) return { md, refusals: [] }
  const ok = Array.isArray(replace) && replace.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && p[0] !== '' && typeof p[1] === 'string')
  if (!ok) return { md, refusals: ['replace must be [["from", "to"], …] — each from a non-empty string, each to a string'] }
  const refusals = []
  for (const [from, to] of replace) {
    if (!md.includes(from)) refusals.push(`replace: "${from}" not found`)
    else md = md.split(from).join(to)
  }
  return { md, refusals }
}

const DB_URL = /\b(?:postgres(?:ql)?|mysql2?|mariadb|mongodb|redis|rediss)(?:\+\w+)?:\/\/[^\s'"]*/g
/** PGDATABASE, DATABASE, any *_DATABASE, *POSTGRES_DB and PGSERVICE set to a name (DATABASE_URL is a URL, checked above). */
const DB_VAR = /\b((?:[A-Z0-9]+_)*(?:(?:PG)?DATABASE|POSTGRES_DB)|PGSERVICE)=(['"]?)([^\s'";&|()]*)/g
/**
 * A SQLite database is not a server database's name — but only in memory, or a file at a relative path inside
 * the clone: an absolute, ~, $VAR or .. path may be the human's own file. Never for a Postgres variable.
 */
const sqliteInClone = (variable, v) => !/^PG|POSTGRES_DB$/.test(variable) && (v === ':memory:' || (/\.(?:sqlite3?|db)$/.test(v) && !/^[/~$]/.test(v) && !v.split('/').includes('..')))
/** createdb / dropdb options that take a value; the first other word is the database. */
const PG_VALUE_OPTS = new Set(['-h', '-p', '-U', '-O', '-T', '-E', '-l', '-D', '-S', '--host', '--port', '--username', '--owner', '--template', '--encoding', '--locale', '--tablespace', '--maintenance-db', '--strategy', '--icu-locale', '--locale-provider'])
/** Every form a line names a port in: *PORT=, --port, a localhost / any-host / IPv6 bind, docker -p, and lsof / fuser / kill-port targets. */
const PORT_RES = [
  /(?<![A-Z0-9_])(?!(?:PG|DB|DATABASE|POSTGRES|MYSQL|REDIS|MONGO)_?PORT=)[A-Z0-9_]*PORT=['"]?(\d+)/g,
  /--port[= ]['"]?(\d+)/g,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/g,
  /(?:^|[\s"'])(?:-p|--publish)[\s=]+(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+)/g,
  /(?:tcp|udp):(\d+)/gi,
  /(?:^|\s)-[a-zA-Z]*i\s*:(\d+)/g,
  /\b(\d+)\/(?:tcp|udp)\b/g,
  /\bkill-port\s+(\d+)/g,
]
const uncommented = (lines) => lines.filter((l) => !l.trim().startsWith('#'))
const normalize = (s) => String(s ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** A Postgres client whose database name is checked: its -p / --port is the shared database server's. No other client is exempt. */
const DB_CLIENT = /(?:^|[\s(])(?:psql|createdb|dropdb|pg_dump|pg_restore)(?=\s|$)/
/** A command that empties or stops a database server outright — never the bench's to run, whatever port it names. */
const SERVER_STOP = /\b(?:flushall|flushdb)\b|\bpg_ctl\b.*\b(?:stop|restart|kill)\b/i
/**
 * `shutdown` stops a database server only on a line with one of its clients or servers — piped in, in a -c / --eval
 * string, or as the server's own flag (`simctl shutdown` is a simulator's, and is left out of the line).
 */
const DB_TOOL = /(?:^|[\s(/])(?:mysqladmin|mysql|mysqld|redis-cli|redis-server|valkey-cli|mongosh|mongo|mongod|psql|pg_ctl|postgres)(?=\s|$)/
const SHUTDOWN = /\bshutdown(?:Server)?\b/i
/** The machine's own shutdown, halt, reboot or poweroff — by path, or through sudo with its flags. */
const HALT = /^(?:\S*\/)?(?:shutdown|halt|reboot|poweroff)$/
const haltsMachine = (seg) => {
  const words = seg.split(/\s+/).filter(Boolean)
  return HALT.test(words[0] ?? '') || (/^(?:\S*\/)?sudo$/.test(words[0] ?? '') && words.slice(1).some((w) => HALT.test(w)))
}
const OPT_PORT = new Set([PORT_RES[1], PORT_RES[3]])
/** The ports named in lines, database URLs and a database client's -p / --port left out (a shared database server's port is fine). */
const portsIn = (lines) => [...new Set(lines.flatMap((l) => l.replace(DB_URL, ' ').split(/&&|\|\||;|\|/).flatMap((seg) =>
  PORT_RES.filter((re) => !(DB_CLIENT.test(seg) && OPT_PORT.has(re))).flatMap((re) => [...seg.matchAll(re)].map((m) => Number(m[1]))))))]

/** The ports a text names (comments and database URLs left out). */
export function portsNamed(text) {
  return portsIn(uncommented(normalize(text).split('\n')))
}

/** Why lines would touch something of the human's: a database not carrying the prefix, a port in use, docker on a non-bench container, the booted simulator. */
function lineRefusals(lines, prefix, inUse) {
  const out = []
  const add = (m) => { if (!out.includes(m)) out.push(m) }
  const notBench = (name) => add(`database ${name || '(default)'} is not a bench database (${prefix}*)`)
  for (const l of lines) for (const u of l.match(DB_URL) ?? []) {
    // a URL in prose may end a sentence or a clause: its trailing punctuation is not the name's
    const name = (/^[^:]+:\/\/[^/\s]*(?:\/([^\s?'"]*))?/.exec(u)?.[1] || '').replace(/[,.;:)\]`]+$/, '')
    // a dbname in the query names the database as much as the path does
    for (const q of u.matchAll(/[?&]dbname=([^&\s'"#]*)/g)) if (!q[1].startsWith(prefix)) notBench(q[1])
    // Redis databases are numbered, not named: no path, or a number, names none of the human's
    if (/^rediss?:/i.test(u) && /^\d*$/.test(name)) continue
    if (!name.startsWith(prefix)) notBench(name)
  }
  for (const l of lines) for (const m of l.replace(DB_URL, ' ').matchAll(DB_VAR)) if (!m[3].startsWith(prefix) && !sqliteInClone(m[1], m[3])) notBench(m[3])
  for (const l of lines) for (const seg of l.split(/&&|\|\||;|\|/)) {
    const words = /\b(?:createdb|dropdb)\b(.*)/.exec(seg)?.[1].trim().split(/\s+/).filter(Boolean)
    if (!words) continue
    let name = null
    for (let i = 0; i < words.length && name == null; i++) {
      if (PG_VALUE_OPTS.has(words[i])) i++
      else if (!words[i].startsWith('-')) name = words[i].replace(/^['"]|['"]$/g, '')
    }
    if (name == null || !name.startsWith(prefix)) notBench(name)
  }
  for (const port of portsIn(lines)) if (inUse.has(port)) add(`port ${port} is in use now`)
  const bare = (seg) => seg.replace(/^\s*[\w-]+:\s+/, '').trim()
  for (const l of lines) {
    const segs = l.split(/&&|\|\||;|\|/)
    const unsim = segs.filter((seg) => !/\bsimctl\s+shutdown\b/.test(seg)).join(' ; ')
    if (SHUTDOWN.test(unsim) && DB_TOOL.test(unsim)) add(`stops a database server: ${bare(l)}`)
    for (const seg of segs) {
      if (SERVER_STOP.test(seg)) add(`stops a database server: ${bare(seg)}`)
      if (haltsMachine(bare(seg))) add(`shuts down or restarts the machine: ${bare(seg)}`)
      const sim = /\bsimctl\s+shutdown\s+(\S+)/.exec(seg)?.[1]
      if (sim && sim !== 'booted' && !sim.includes(prefix)) add(`simctl shutdown names no ${prefix} device: ${bare(seg)}`)
    }
  }
  for (const l of lines) for (const seg of l.split(/&&|;|\|/)) {
    const m = /(?:^|[\s(:])(docker-compose\b.*|docker\s+(?:start|stop|restart|kill|pause|unpause|exec|run|rm|rmi|compose|volume|network|container|system|prune)\b.*)/.exec(seg)
    if (m && !m[1].includes(prefix)) add(`docker command names no ${prefix} container: ${m[1].trim()}`)
  }
  if (lines.some((l) => /\bsimctl\b.*\bbooted\b/.test(l))) add('simctl targets the booted simulator — name a bench device UDID')
  return out
}

/** The same rules over a profile's other text — its setup, teardown or a placed file — each reason prefixed with where it was found. Empty without a db_prefix (safetyRefusals says so). */
export function textRefusals(where, text, profile, { listening = [] } = {}) {
  const prefix = profile?.db_prefix
  if (!prefix || text == null) return []
  return lineRefusals(uncommented(normalize(text).split('\n')), prefix, new Set(listening.map(Number))).map((m) => `${where}: ${m}`)
}

/** A variable a case never inherits from the shell — a database named there is the human's; only a profile's `env` sets one. */
export const strippedEnv = (k) => k === 'DATABASE_URL' || k === 'DIRECT_URL' || k === 'TEST_DATABASE_URL' || /^PG[A-Z0-9_]+$/.test(k)

/** A profile's `env` checked for shape → { env: { NAME: 'value' }, refusals }; numbers and booleans become strings. */
export function profileEnv(env) {
  if (env == null) return { env: {}, refusals: [] }
  if (typeof env !== 'object' || Array.isArray(env)) return { env: {}, refusals: ['env must be { "NAME": "value" }'] }
  const out = {}
  const refusals = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) refusals.push(`env: ${k} is not a variable name`)
    else if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = String(v)
    else refusals.push(`env: ${k} must be a string`)
  }
  return { env: out, refusals }
}

/** The environment of a case's setup, teardown and fleet: the shell's without strippedEnv, the profile's env over it, CLAUDE_PROJECT_DIR the clone. */
export function caseEnv(base, env, clone) {
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !strippedEnv(k))), ...env, CLAUDE_PROJECT_DIR: clone }
}

/** A profile's env as the NAME=value lines the safety rules scan. */
export const envLines = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')

/** Why a clone's config must not run: it would touch something of the human's. Empty means safe. `builderMd` is the text after applyProfile; `listening` the TCP ports now listening. */
export function safetyRefusals(builderMd, profile, { listening = [] } = {}) {
  const prefix = profile?.db_prefix
  if (!prefix) return ['profile has no db_prefix']
  const { fm, bare } = splitFm(normalize(builderMd))
  if (bare) return ['no front matter — cannot check the config']
  const out = lineRefusals(uncommented(fm), prefix, new Set(listening.map(Number)))
  const add = (m) => { if (!out.includes(m)) out.push(m) }
  const at = fm.findIndex((l) => /^agent_walk:/.test(l))
  const ca = at < 0 ? undefined : fm.slice(at + 1, blockEnd(fm, at)).map((l) => /^\s+claude_args:\s*(.*?)\s*(#.*)?$/.exec(l)).find(Boolean)
  if (!ca || !ca[1] || ca[1] === '{claude_args}') add("agent_walk.claude_args is not set — sessions would load the user's plugins")
  return out
}

/** The same rules over the config's body — prose an agent may still run literally — as warnings, each `body: …`; the profile's `replace` rewrites what they name. */
export function bodyWarnings(builderMd, profile, { listening = [] } = {}) {
  const prefix = profile?.db_prefix
  if (!prefix) return []
  const { rest, bare } = splitFm(normalize(builderMd))
  if (bare) return []
  // markdown's inline code marks are not part of a command: `docker compose up` is docker compose up
  return lineRefusals(rest.split('\n').map((l) => l.replace(/`/g, ' ')), prefix, new Set(listening.map(Number))).map((m) => `body: ${m}`)
}

// ── results and the report ──
const num = (x) => (Number.isFinite(x) ? x : null)
const anyOf = (xs) => (xs.some((x) => x != null) ? sum(xs.map((x) => x ?? 0)) : null)

/** An archive row as a Measure; a field with no source is null. */
export function measureFromRow(row) {
  const { ms, usd } = wallCost(row)
  const t = row.tokens
  const kinds = Object.values(row.byKind ?? {})
  const own = t ? sum([t.input, t.output, t.cacheRead, t.cacheCreation].map((x) => x ?? 0)) : null
  const ctx = row.byKind ? sum(kinds.map((k) => k.sumCtx ?? 0)) : null
  const turnsOwn = num(row.orchestrator?.turns)
  const turnsKinds = row.byKind ? sum(kinds.map((k) => k.turns ?? 0)) : null
  return {
    wallMs: ms,
    costUsd: usd,
    turns: anyOf([turnsOwn, turnsKinds]),
    tokens: anyOf([own, ctx]),
    stages: row.stages ?? null,
    byKind: row.byKind ?? null,
    quality: row.quality ?? null,
  }
}

/** A runs.json's median done run as a Measure; stages are session totals.ms keyed by session name minus its trailing number. */
export function measureFromRuns(runsJson, config = 'builder') {
  const done = (runsJson?.runs ?? []).filter((r) => r.config === config && r.status === 'done').sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
  if (!done.length) return { wallMs: null, costUsd: null, turns: null, tokens: null, stages: null, byKind: null, quality: null }
  const run = done[done.length >> 1]
  const sessions = run.sessions ?? []
  const t = runTotals(sessions)
  const stages = {}
  for (const s of sessions) {
    const k = String(s.name ?? '').replace(/\s+\d+$/, '')
    stages[k] = (stages[k] ?? 0) + (s.totals?.ms ?? 0)
  }
  const tok = t.tokens.input + t.tokens.output + t.tokens.cacheRead
  return {
    wallMs: run.ms > 0 ? run.ms : null,
    costUsd: t.costUsd > 0 ? t.costUsd : null,
    turns: sessions.length ? t.turns : null,
    tokens: sessions.length ? tok : null,
    stages: sessions.length ? stages : null,
    byKind: null,
    quality: null,
  }
}

/** The places the most minutes (stages) and tokens (dispatch kinds) went, controls left out. */
export function topSpend(results, n = 5) {
  const mins = {}
  const toks = {}
  for (const r of results) {
    if (r.control || !r.measure) continue
    for (const [k, ms] of Object.entries(r.measure.stages ?? {})) mins[k] = (mins[k] ?? 0) + (ms ?? 0)
    for (const [k, v] of Object.entries(r.measure.byKind ?? {})) toks[`${k} dispatches`] = (toks[`${k} dispatches`] ?? 0) + (v.sumCtx ?? 0)
  }
  const top = (o, key, f) => Object.entries(o).map(([where, v]) => ({ where, [key]: f(v) })).filter((x) => x[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, n)
  return { minutes: top(mins, 'minutes', (ms) => Math.round(ms / 60000)), tokens: top(toks, 'tokens', (v) => v) }
}

const STAGE_COLUMNS = ['brainstorm', 'spec', 'audit', 'plan', 'build', 'finalReview', 'endGates', 'walk', 'verify', 'ship', 'merge', 'parked']
const DASH = '—'
const cell = (s) => String(s ?? DASH).replace(/\|/g, '\\|')
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
const delta = (v, base) => (v == null || base == null || !(base > 0) ? DASH : `${v >= base ? '+' : '-'}${Math.round((Math.abs(v - base) / base) * 100)}%`)
const dur = (ms) => (ms == null ? DASH : duration(ms))
const usd = (x) => (x == null ? DASH : `$${x.toFixed(2)}`)
const count = (x) => (x == null ? DASH : String(x))
const tokStr = (x) => (x == null ? DASH : formatTokens(x))

/** The estimate against the measured wall: within ±25% / over / under. */
function estimateVerdict(r) {
  const est = r.estimate
  const ms = r.measure?.wallMs
  if (!est?.minutes || ms == null) return DASH
  const ratio = ms / (est.minutes * 60000)
  return `${duration(est.minutes * 60000)} ${Math.abs(ratio - 1) <= 0.25 ? 'within ±25%' : ratio > 1 ? 'over' : 'under'}`
}

const METRICS = [['wallMs', dur], ['tokens', tokStr], ['turns', count], ['costUsd', usd]]

/** A status as its category alone — done, failed, refused, parked, timed out, stopped, waiting, running — never its detail (git stderr, paths, refusal text). */
export function statusCategory(status) {
  const s = String(status ?? '')
  if (/^(done|stopped|waiting|running)$/.test(s)) return s
  if (s === 'failed: stopped') return 'stopped'
  if (/^timed out\b/.test(s) || /^failed:.*\btimed out\b/.test(s)) return 'timed out'
  const head = /^(failed|refused|parked)\b/.exec(s)?.[1]
  return head ?? 'failed'
}

/** The builder the suite ran — `{ treatment: { sha, dirty }, mainSha }` — as the report's header lines. */
const builderHeader = ({ treatment, mainSha } = {}) => {
  const short = (sha) => sha.slice(0, 12)
  const under = treatment?.sha ? `${short(treatment.sha)}${treatment.dirty ? ' + uncommitted changes (unpinned)' : ''}` : 'not a git checkout (unpinned)'
  return [`builder under test: ${under}`, '', ...(mainSha ? [`builder main (controls): ${short(mainSha)}`, ''] : [])]
}

/** The suite report as markdown; with names: false a result's project never appears, nor its status's detail. `builder` adds the SHAs it ran on. */
export function renderSuiteReport(results, { names = false, builder } = {}) {
  const controlOf = (r) => results.find((c) => c.control && c !== r && c.id.startsWith(`${r.id}@`))
  const out = ['# Benchmark suite report', '', ...(builder ? builderHeader(builder) : [])]
  const head = ['id', 'size', ...(names ? ['project'] : []), 'status', 'wall', 'tokens', 'turns', 'cost', 'Δ wall vs baseline', 'Δ tokens vs baseline', 'Δ turns vs baseline', 'Δ cost vs baseline', 'Δ wall vs control', 'Δ tokens vs control', 'Δ turns vs control', 'Δ cost vs control', 'estimate']
  const rows = results.map((r) => {
    const m = r.measure
    const ctl = r.control ? null : controlOf(r)?.measure
    return [
      r.id, r.size, ...(names ? [r.project] : []), names ? r.status : statusCategory(r.status),
      ...METRICS.map(([k, f]) => f(m?.[k])),
      ...METRICS.map(([k]) => delta(m?.[k], r.baseline?.[k])),
      ...METRICS.map(([k]) => delta(m?.[k], ctl?.[k])),
      estimateVerdict(r),
    ]
  })
  out.push('## Cases', '', table(head, rows), '')

  out.push('## Stages', '', table(['id', ...STAGE_COLUMNS], results.map((r) => [r.id, ...STAGE_COLUMNS.map((k) => (r.measure?.stages?.[k] > 0 ? duration(r.measure.stages[k]) : DASH))])), '')

  const ratio = (r) => (r.specLines > 0 && r.planLines != null ? (r.planLines / r.specLines).toFixed(1) : DASH)
  out.push('## Plan format', '', table(['id', 'spec lines', 'plan lines', 'plan ÷ spec', 'fix rounds'], results.map((r) => [r.id, count(r.specLines), count(r.planLines), ratio(r), count(r.measure?.quality?.fixRounds)])), '')

  const gate = (r) => {
    const s = r.measure?.stages
    const w = r.measure?.wallMs
    if (!s || !(w > 0) || (s.endGates == null && s.verify == null)) return DASH
    return `${Math.round((((s.endGates ?? 0) + (s.verify ?? 0)) / w) * 100)}%`
  }
  out.push('## Gate share', '', table(['id', 'endGates + verify ÷ wall'], results.map((r) => [r.id, gate(r)])), '')

  const top = topSpend(results, 5)
  out.push('## Top 5', '', 'Minutes by stage', '', table(['where', 'minutes'], top.minutes.map((x) => [x.where, x.minutes])), '', 'Tokens by dispatch kind', '', table(['where', 'tokens'], top.tokens.map((x) => [x.where, formatTokens(x.tokens)])), '')
  return out.join('\n')
}
