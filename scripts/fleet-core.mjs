/**
 * The fleet's decisions, kept free of processes and git so they can be tested directly.
 * fleet.mjs does the side effects; this module says what a manifest and a finished run MEAN.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from './manifest.mjs'

const BUILD_STATES = new Set(['spec', 'aligned', 'audited', 'planned', 'building'])
const WALK_STATES = new Set(['built', 'signed-off'])
const SHIP_STATES = new Set(['verified'])
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')

/**
 * Which lane a feature belongs in. `building` with `ready: pending` is every phase closed and only
 * walk readiness left — that needs the dev env, so it is walk-lane work. `verified` is the ship
 * lane: the PR, CI, the ship commit and the merge need no dev env, so they run in the parallel pool
 * and never hold the one-at-a-time walk lane while CI runs. An open PR is not done — merged is.
 */
export function laneOf(mf) {
  if (isSet(mf.blocked)) return 'blocked'
  if (mf.state === 'shipped') return 'done'
  if (mf.state === 'building' && /^pending/.test(mf.ready ?? '')) return 'walk'
  if (BUILD_STATES.has(mf.state)) return 'build'
  if (WALK_STATES.has(mf.state)) return 'walk'
  if (SHIP_STATES.has(mf.state)) return 'ship'
  return 'unknown'
}

/** The PR a SHIPPED SPEC header names ('#12'), or null when the header is not SHIPPED. `/builder:ship`
 *  removes MANIFEST.md, so after the ship commit this header is the only record. */
export function shippedPr(specText) {
  const head = (specText ?? '').slice(0, 800)
  if (!/✅\s*\*{0,2}SHIPPED/.test(head)) return null
  return /PR\s*(#\d+)/.exec(head)?.[1] ?? 'shipped'
}

/** What one finished `claude -p` run means for its feature. See the plan's Task 3 interface. */
export function decide({ lane, manifestText, specText = null, exit, failures, stalls = 0, runs, cap, progressed }) {
  // Shipped is done however the run ended — one that timed out after the ship commit must not be
  // retried into a second one.
  const shipped = manifestText == null ? shippedPr(specText) : null
  if (shipped) return { action: 'done', pr: shipped }
  const mf = manifestText == null ? null : parseManifest(manifestText)
  if (mf && laneOf(mf) === 'done') return { action: 'done', pr: mf.pr ?? null }
  if (exit !== 0) {
    const what = exit === null ? 'timed out' : `failed (exit ${exit})`
    return failures >= 1 ? { action: 'fail', reason: `run ${what} twice` } : { action: 'retry' }
  }
  if (mf == null) return { action: 'park', reason: 'MANIFEST.md missing after the run' }
  const next = laneOf(mf)
  if (next === 'blocked') return { action: 'park', reason: unquote(mf.blocked) }
  if (next === 'unknown') return { action: 'park', reason: `manifest state '${mf.state ?? ''}' is not one the fleet knows` }
  if (next !== lane) return { action: 'handoff', to: next }
  // One stall is often a run that ended mid-step (a turn that stopped to wait); the next run
  // resumes from the ledger. Two in a row is a real stall.
  if (!progressed) return stalls >= 1 ? { action: 'park', reason: 'no progress — two runs in a row changed neither MANIFEST.md nor HEAD' } : { action: 'stalled' }
  if (runs >= cap) return { action: 'park', reason: `run cap (${cap}) reached` }
  return { action: 'again' }
}

export const fleetDir = (root) => join(root, '.builder', 'fleet')

export function loadFleet(root) {
  const p = join(fleetDir(root), 'fleet.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { features: {} }
}

/** Atomic: a fleet killed mid-write leaves the previous fleet.json, never half of one. */
export function saveFleet(root, fleet, progress = null) {
  const dir = fleetDir(root)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const tmp = join(dir, 'fleet.json.tmp')
  writeFileSync(tmp, JSON.stringify(fleet, null, 2) + '\n')
  renameSync(tmp, join(dir, 'fleet.json'))
  writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet, progress))
}

// ---- progress ----------------------------------------------------------------------------------
//
// How far along the pipeline a feature is, as a percentage of STEPS — not of time. Each manifest
// state has a floor; inside `building` the span up to 70 scales with the ledger's `Task N: complete`
// lines against the plan's `### Task N` headings. The weights are a judgment of where the effort
// usually falls (a sixth before the build, more than half in it, the rest walk → verify → merge).
const STAGE_FLOOR = { spec: 0, aligned: 5, audited: 10, planned: 15, building: 15, built: 75, 'signed-off': 80, verified: 90, shipped: 100 }
const BUILD_TOP = 70

const taskIds = (text, re) => new Set([...(text ?? '').matchAll(re)].map((m) => Number(m[1])))

/**
 * `{ pct, label }` for one feature from what the fleet knows (its status) and what the worktree
 * says (manifest, plan, ledger — any may be null). Pure; readProgress does the file reads.
 */
export function featureProgress({ status, manifestText = null, planText = null, ledgerText = null }) {
  if (status === 'done') return { pct: 100, label: 'merged' }
  if (manifestText == null) return { pct: 0, label: '—' }
  const mf = parseManifest(manifestText)
  const state = mf.state ?? ''
  // The build writes `state: building` at a phase close or a stop, not at its first task — so a
  // `planned` manifest whose ledger already has completed tasks is a build in its first phase.
  if (state === 'building' || state === 'planned') {
    if (/^pending/.test(mf.ready ?? '')) return { pct: BUILD_TOP + 2, label: 'walk readiness' }
    const total = taskIds(planText, /^#{2,4}\s+Task\s+(\d+)\b/gm).size
    const done = Math.min(total, taskIds(ledgerText, /^\W*Task\s+(\d+):\s*complete\b/gm).size)
    if (state === 'planned' && !done) return { pct: STAGE_FLOOR.planned, label: 'planned' }
    if (!total) return { pct: STAGE_FLOOR.building, label: 'build' }
    return { pct: Math.round(STAGE_FLOOR.building + ((BUILD_TOP - STAGE_FLOOR.building) * done) / total), label: `build ${done}/${total}` }
  }
  if (state === 'built' && /^agent-pass|^pass/.test(mf.walk ?? '')) return { pct: 78, label: 'walked' }
  if (state === 'verified' && isSet(mf.pr)) return { pct: 95, label: 'PR open' }
  return { pct: STAGE_FLOOR[state] ?? 0, label: state || '—' }
}

/** featureProgress fed from disk: `<base>/<registry>/<feature>/{MANIFEST,PLAN}.md` and the
 *  git-ignored ledger `<base>/.builder/<feature>/progress.md`. `base` is the worktree, or the
 *  repo root before one exists. */
export function readProgress(base, registry, feature, status) {
  const read = (...p) => (existsSync(join(base, ...p)) ? readFileSync(join(base, ...p), 'utf8') : null)
  return featureProgress({
    status,
    manifestText: read(registry, feature, 'MANIFEST.md'),
    planText: read(registry, feature, 'PLAN.md'),
    ledgerText: read('.builder', feature, 'progress.md'),
  })
}

/** Ten cells and the number: `▓▓▓▓░░░░░░ 43%`. */
export function progressBar(pct) {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return `${'▓'.repeat(n)}${'░'.repeat(10 - n)} ${Math.round(pct)}%`
}

/**
 * The table a terminal renders: only columns that carry information. `PR` and `Evidence` are gone —
 * agent mode opens no PR since 3.0, and nothing ever wrote evidence — and the worktree root is said
 * once above the table instead of repeated per row; a row shows `worktree` only when it has one.
 * Wide, always-empty columns were what squeezed `Runs` onto two lines in the CLI's table renderer.
 *
 * `progress(name, f)` → `{ pct, label }` adds a Progress column and an overall bar (the mean) to the
 * heading; without it the table is as before.
 */
export function renderStatus(fleet, progress = null) {
  const rows = Object.entries(fleet.features).sort(([a], [b]) => a.localeCompare(b))
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const counts = {}
  for (const [, f] of rows) counts[f.status] = (counts[f.status] ?? 0) + 1
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ')
  const roots = new Set(rows.map(([, f]) => f.worktree && f.worktree.replace(/\/[^/]+\/?$/, '')).filter(Boolean))
  const prog = progress ? Object.fromEntries(rows.map(([name, f]) => [name, progress(name, f) ?? { pct: 0, label: '—' }])) : null
  const overall = prog && rows.length ? progressBar(rows.reduce((s, [name]) => s + prog[name].pct, 0) / rows.length) : ''
  const lines = [`# builder fleet — ${rows.length} feature(s): ${summary || 'none'}${overall ? ` · ${overall}` : ''}`]
  if (fleet.target) lines.push('', `merges into **${fleet.target}**${roots.size ? ` · worktrees under ${[...roots].join(', ')}` : ''}`)
  const col = prog ? ' Progress |' : ''
  lines.push('', `| Feature | Status |${col} Runs | Reason | Worktree |`, `|---|---|${prog ? '---|' : ''}---|---|---|`)
  for (const [name, f] of rows) {
    const reason = f.pr && f.pr !== 'shipped' ? `${f.reason ? `${f.reason} · ` : ''}PR ${f.pr}` : f.reason
    const p = prog ? ` ${progressBar(prog[name].pct)} · ${cell(prog[name].label)} |` : ''
    lines.push(`| ${cell(name)} | ${cell(f.status)} |${p} ${f.runs ?? 0} | ${cell(reason)} | ${f.worktree ? 'yes' : '—'} |`)
  }
  if (fleet.notes?.length) lines.push('', ...fleet.notes.map((n) => `- ${n}`))
  return lines.join('\n') + '\n'
}
