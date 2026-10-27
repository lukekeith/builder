#!/usr/bin/env node
/**
 * statusline — builder's segment of Claude Code's status line (through the launcher
 * /builder:statusline installs, which puts it after the previous status line on the same row):
 * `builder` and one bar of overall progress, then fleet features with their step, a build in the
 * chat whose ledger moved in the last 5 minutes, and running gates and jobs. A feature the fleet
 * parked or failed reads `⛔ <feature>: <why>` — and stays, from fleet.json, after the fleet has
 * exited, until a new run changes the row; short of room the parks fold into `⛔ 2 parked —
 * /builder:fleet:status`. A running feature with no commit or ledger tick for 45 minutes gets a ⚠.
 * Prints nothing when nothing runs or waits on you — and nothing, exit 0, on any error.
 *
 *   node <plugin>/scripts/statusline.mjs --cwd <dir> [--width <n>] [--now <ms>]
 *
 * `--width` is this segment's budget in columns; whole trailing items drop to fit, `builder` and its bar never.
 *
 * Runs every couple of seconds, so it reads a handful of known files and spawns nothing.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { uptime } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { readProgress, rowProgress, progressBar, mergedThisRun, fleetStops, stallOf } from './fleet-core.mjs'
import { parseManifest } from './manifest.mjs'

export const FRESH_MS = 5 * 60 * 1000

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
const list = (d) => {
  try { return readdirSync(d) } catch { return [] }
}
/** A pid file written before the last boot names a process that is gone, whatever has that pid now. */
const current = (p, bootTime) => {
  try { return statSync(p).mtimeMs >= bootTime } catch { return false }
}
const alive = (pid) => {
  if (!(Number(pid) > 0)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** `{ root, main }` — the checkout holding `dir`, and the main checkout when that is a worktree. */
export function repoRoots(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const g = join(d, '.git')
    if (existsSync(g)) {
      if (statSync(g).isDirectory()) return { root: d, main: d }
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'))
      // <main>/.git/worktrees/<name>
      return { root: d, main: m ? dirname(dirname(dirname(resolve(d, m[1].trim())))) : d }
    }
    if (dirname(d) === d) return null
  }
}

export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Items joined by ` · `; over `width`, whole trailing items go and ` +N more` says so. */
export function fit(items, width) {
  for (let k = items.length; k > 0; k--) {
    const more = items.length - k
    const line = items.slice(0, k).join(' · ') + (more ? ` +${more} more` : '')
    if ([...line].length <= width || k === 1) return line
  }
  return ''
}

/** At most `n` columns of `s`, an ellipsis standing in for what was cut. */
export function clip(s, n) {
  const c = [...String(s)]
  return c.length <= n ? String(s) : n <= 1 ? '…'.slice(0, n) : `${c.slice(0, n - 1).join('').trimEnd()}…`
}

/** `⛔ 2 parked — /builder:fleet:status` / `⛔ 1 parked, 1 failed …` — what the parks fold into when
 *  their whys don't fit; without the command when even that doesn't. */
const stopCount = (stops, budget) => {
  const n = (s) => stops.filter((x) => x.status === s).length
  const count = `⛔ ${[n('parked') && `${n('parked')} parked`, n('failed') && `${n('failed')} failed`].filter(Boolean).join(', ')}`
  const full = `${count} — /builder:fleet:status`
  return [...full].length <= budget ? full : count
}

/**
 * The parks as items in `budget` columns: each `⛔ <name>: <why>` with its why cut to an equal share
 * (at most WHY_MAX), the bare `⛔ <name>` for one with no why; when even a short why each won't fit,
 * one folded item. The parks come before the running features: they are what waits on you.
 */
const WHY_MAX = 60
const WHY_MIN = 20 // a why cut shorter than this says nothing: fold instead
export function parkItems(stops, budget) {
  if (!stops.length) return []
  const sep = 3 * (stops.length - 1)
  const share = Math.floor((budget - sep) / stops.length)
  const items = []
  for (const s of stops) {
    const head = `⛔ ${s.name}`
    const room = Math.min(WHY_MAX, share - [...head].length - 2)
    if (!s.why) items.push(head)
    else if (room >= WHY_MIN) items.push(`${head}: ${clip(s.why, room)}`)
    else return [stopCount(stops, budget)]
  }
  return [...items.join(' · ')].length <= budget ? items : [stopCount(stops, budget)]
}

function fleetItems(main, registry, bootTime, now) {
  const fleet = readJson(join(main, '.builder', 'fleet', 'fleet.json'))
  if (!fleet) return null
  const stops = fleetStops(fleet, { main, registry })
  const lock = join(main, '.builder', 'fleet', 'lock')
  // The fleet has exited: its parked and failed rows still wait on someone, and fleet.json still
  // holds them — they stay on the line until a new run changes them. Nothing else from it does.
  if (!current(lock, bootTime) || !alive(read(lock))) return stops.length ? { items: [], stops, pcts: [], names: new Set(), worktrees: [] } : null
  const rows = Object.entries(fleet.features ?? {})
  // The whole run: what it holds plus what it already merged, each merged feature at 100%.
  const merged = mergedThisRun(fleet)
  const total = new Set([...rows.map(([n]) => n), ...merged]).size
  const items = [`⚙ fleet ${merged.length}/${total}`]
  const pcts = merged.map(() => 100)
  for (const [name, f] of rows) {
    const p = rowProgress(main, registry, name, f)
    if (!merged.includes(name)) pcts.push(p.pct)
    if (['done', 'queued', 'waiting', 'parked', 'failed'].includes(f.status)) continue
    items.push(`${stallOf(name, f, now) ? '⚠ ' : ''}${name} ${p.label}`)
  }
  return { items, stops, pcts, names: new Set(rows.map(([n]) => n)), worktrees: rows.map(([, f]) => f.worktree).filter(Boolean) }
}

function buildItems(main, registry, now, skip) {
  const out = []
  const pcts = []
  for (const name of list(join(main, '.builder'))) {
    if (skip.has(name)) continue
    const ledger = join(main, '.builder', name, 'progress.md')
    if (!existsSync(ledger) || now - statSync(ledger).mtimeMs > FRESH_MS) continue
    const manifestText = read(join(main, registry, name, 'MANIFEST.md'))
    const state = manifestText && parseManifest(manifestText).state
    if (state !== 'planned' && state !== 'building') continue
    const p = readProgress(main, registry, name, 'building')
    out.push(`${name} ${p.label}`)
    pcts.push(p.pct)
  }
  return { items: out, pcts }
}

function gateItems(root, now, bootTime) {
  const out = []
  const marker = join(root, '.builder', 'gates', 'running.json')
  const g = readJson(marker)
  if (g && current(marker, bootTime) && alive(g.pid)) out.push(`gate ${g.sets} ⏱ ${elapsed(now - Date.parse(g.startedAt))}`)
  const jobs = join(root, '.builder', 'jobs')
  for (const f of list(jobs).filter((f) => f.endsWith('.pid')).sort()) {
    const name = f.slice(0, -4)
    if (existsSync(join(jobs, `${name}.exit`)) || !current(join(jobs, f), bootTime) || !alive(read(join(jobs, f)))) continue
    out.push(`job ${name} ⏱ ${elapsed(now - statSync(join(jobs, f)).mtimeMs)}`)
  }
  return out
}

export function render({ cwd, width = 120, now = Date.now(), bootTime = Date.now() - uptime() * 1000 }) {
  try {
    const roots = repoRoots(cwd)
    if (!roots) return ''
    const cfg = loadConfig(roots.main)
    if (!cfg.ok) return ''
    const fleet = fleetItems(roots.main, cfg.registry, bootTime, now)
    const gateRoots = [...new Set([roots.root, roots.main, ...(fleet?.worktrees ?? [])])]
    const builds = buildItems(roots.main, cfg.registry, now, fleet?.names ?? new Set())
    const rest = [...builds.items, ...gateRoots.flatMap((r) => gateItems(r, now, bootTime))]
    const [lead, ...running] = fleet?.items ?? []
    const stops = fleet?.stops ?? []
    if (!lead && !running.length && !rest.length && !stops.length) return ''
    // One bar for everything with progress — the mean of the fleet's features and in-chat builds.
    // Gates and jobs alone have none, and get the name without a bar.
    const pcts = [...(fleet?.pcts ?? []), ...builds.pcts]
    const head = pcts.length ? `builder ${progressBar(pcts.reduce((a, b) => a + b, 0) / pcts.length)}` : 'builder'
    // The parks get their room first, after `builder` and the fleet's count; the rest fit after them.
    const fixed = [head, ...(lead ? [lead] : [])]
    const parks = parkItems(stops, width - [...fixed.join(' · ')].length - 3)
    return fit([...fixed, ...parks, ...running, ...rest], width)
  } catch {
    return ''
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
  const line = render({
    cwd: opt('--cwd') ?? process.cwd(),
    width: Number(opt('--width') ?? process.env.COLUMNS) || 120,
    now: Number(opt('--now')) || Date.now(),
  })
  if (line) process.stdout.write(`${line}\n`)
}
