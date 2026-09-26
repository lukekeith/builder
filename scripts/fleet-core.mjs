/**
 * The fleet's decisions, kept free of processes and git so they can be tested directly.
 * fleet.mjs does the side effects; this module says what a manifest and a finished run MEAN.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from './manifest.mjs'

const BUILD_STATES = new Set(['spec', 'aligned', 'audited', 'planned', 'building'])
const WALK_STATES = new Set(['built', 'signed-off', 'verified'])
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')

/**
 * Which lane a feature belongs in. `building` with `ready: pending` is every phase closed and only
 * walk readiness left — that needs the dev env, so it is walk-lane work.
 */
export function laneOf(mf) {
  if (isSet(mf.blocked)) return 'blocked'
  if (isSet(mf.pr) || mf.state === 'shipped') return 'done'
  if (mf.state === 'building' && /^pending/.test(mf.ready ?? '')) return 'walk'
  if (BUILD_STATES.has(mf.state)) return 'build'
  if (WALK_STATES.has(mf.state)) return 'walk'
  return 'unknown'
}

/** What one finished `claude -p` run means for its feature. See the plan's Task 3 interface. */
export function decide({ lane, manifestText, exit, failures, runs, cap, progressed }) {
  if (exit !== 0) {
    const what = exit === null ? 'timed out' : `failed (exit ${exit})`
    return failures >= 1 ? { action: 'fail', reason: `run ${what} twice` } : { action: 'retry' }
  }
  if (manifestText == null) return { action: 'park', reason: 'MANIFEST.md missing after the run' }
  const mf = parseManifest(manifestText)
  const next = laneOf(mf)
  if (next === 'blocked') return { action: 'park', reason: unquote(mf.blocked) }
  if (next === 'done') return { action: 'done', pr: mf.pr ?? null }
  if (next === 'unknown') return { action: 'park', reason: `manifest state '${mf.state ?? ''}' is not one the fleet knows` }
  if (lane === 'build' && next === 'walk') return { action: 'handoff' }
  if (!progressed) return { action: 'park', reason: 'no progress — the run changed neither MANIFEST.md nor HEAD' }
  if (runs >= cap) return { action: 'park', reason: `run cap (${cap}) reached` }
  return { action: 'again' }
}

export const fleetDir = (root) => join(root, '.builder', 'fleet')

export function loadFleet(root) {
  const p = join(fleetDir(root), 'fleet.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { features: {} }
}

/** Atomic: a fleet killed mid-write leaves the previous fleet.json, never half of one. */
export function saveFleet(root, fleet) {
  const dir = fleetDir(root)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const tmp = join(dir, 'fleet.json.tmp')
  writeFileSync(tmp, JSON.stringify(fleet, null, 2) + '\n')
  renameSync(tmp, join(dir, 'fleet.json'))
  writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet))
}

export function renderStatus(fleet) {
  const rows = Object.entries(fleet.features).sort(([a], [b]) => a.localeCompare(b))
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const counts = {}
  for (const [, f] of rows) counts[f.status] = (counts[f.status] ?? 0) + 1
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ')
  const lines = [
    `# builder fleet — ${rows.length} feature(s): ${summary || 'none'}`,
    '',
    '| Feature | Status | Runs | PR | Reason | Evidence | Worktree |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const [name, f] of rows)
    lines.push(`| ${cell(name)} | ${cell(f.status)} | ${f.runs ?? 0} | ${cell(f.pr)} | ${cell(f.reason)} | ${cell(f.evidence)} | ${cell(f.worktree)} |`)
  if (fleet.notes?.length) lines.push('', ...fleet.notes.map((n) => `- ${n}`))
  return lines.join('\n') + '\n'
}
