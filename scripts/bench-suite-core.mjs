// Benchmark suite core: case catalogue, estimates, lane packing, budget fill. Pure — no I/O.
import { runTotals, median } from './bench-core.mjs'

export const SIZES = ['xs', 'sm', 'md', 'lg', 'xl']

// ── estimates ──
const cents = (n) => Math.round(n * 100) / 100
const sum = (xs) => xs.reduce((a, x) => a + x, 0)

/** An archive row's estimate: wallMs (else Σ timing ms) → whole minutes up; costUsd (else Σ timing cost) → cents. */
export function estimateFromRow(row) {
  const timing = row.timing ?? []
  const ms = row.wallMs > 0 ? row.wallMs : sum(timing.map((t) => t.ms ?? 0))
  if (!(ms > 0)) return null
  const tc = sum(timing.map((t) => t.tokens?.costUsd ?? 0))
  const usd = row.costUsd > 0 ? row.costUsd : tc > 0 ? tc : null
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

const DB_URL = /\b(?:postgres(?:ql)?|mysql2?|mariadb|mongodb|redis|rediss)(?:\+\w+)?:\/\/[^\s'"]*/g

/** Why a clone's config must not run: it would touch something of the human's. Empty means safe. `builderMd` is the text after applyProfile; `listening` the TCP ports now listening. */
export function safetyRefusals(builderMd, profile, { listening = [] } = {}) {
  const prefix = profile?.db_prefix
  if (!prefix) return ['profile has no db_prefix']
  const { fm, bare } = splitFm(builderMd.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  if (bare) return ['no front matter — cannot check the config']
  const lines = fm.filter((l) => !l.trim().startsWith('#'))
  const out = []
  const add = (m) => { if (!out.includes(m)) out.push(m) }
  const inUse = new Set(listening.map(Number))
  for (const l of lines) for (const u of l.match(DB_URL) ?? []) {
    const name = /^[^:]+:\/\/[^/\s]*(?:\/([^\s?'"]*))?/.exec(u)?.[1] || ''
    if (!name.startsWith(prefix)) add(`database ${name || '(default)'} is not a bench database (${prefix}*)`)
  }
  for (const l of lines) {
    const bare = l.replace(DB_URL, ' ')
    for (const m of bare.matchAll(/[A-Z_]*PORT=(\d+)|--port[= ](\d+)|(?:localhost|127\.0\.0\.1):(\d+)/g)) {
      const port = Number(m[1] ?? m[2] ?? m[3])
      if (inUse.has(port)) add(`port ${port} is in use now`)
    }
  }
  for (const l of lines) for (const seg of l.split(/&&|;|\|/)) {
    const m = /(?:^|[\s(:])(docker-compose\b.*|docker\s+(?:start|stop|restart|kill|pause|unpause|exec|run|rm|rmi|compose|volume|network|container|system|prune)\b.*)/.exec(seg)
    if (m && !m[1].includes(prefix)) add(`docker command names no ${prefix} container: ${m[1].trim()}`)
  }
  if (lines.some((l) => /\bsimctl\b.*\bbooted\b/.test(l))) add('simctl targets the booted simulator — name a bench device UDID')
  const at = fm.findIndex((l) => /^agent_walk:/.test(l))
  const ca = at < 0 ? undefined : fm.slice(at + 1, blockEnd(fm, at)).map((l) => /^\s+claude_args:\s*(.*?)\s*(#.*)?$/.exec(l)).find(Boolean)
  if (!ca || !ca[1] || ca[1] === '{claude_args}') add("agent_walk.claude_args is not set — sessions would load the user's plugins")
  return out
}
