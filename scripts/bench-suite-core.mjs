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
