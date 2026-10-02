#!/usr/bin/env node
/**
 * statusline — builder's segment of Claude Code's status line (through the launcher
 * /builder:statusline installs, which puts it after the previous status line on the same row):
 * `builder` and one bar of overall progress, then fleet features with their step, a build in the
 * chat whose ledger moved in the last 5 minutes, and running gates and jobs. Prints nothing when
 * nothing runs — and nothing, exit 0, on any error.
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
import { readProgress, featureProgress, progressBar } from './fleet-core.mjs'
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

function fleetItems(main, registry, bootTime) {
  const lock = join(main, '.builder', 'fleet', 'lock')
  if (!current(lock, bootTime) || !alive(read(lock))) return null
  const fleet = readJson(join(main, '.builder', 'fleet', 'fleet.json'))
  if (!fleet) return null
  const rows = Object.entries(fleet.features ?? {})
  const items = [`⚙ fleet ${rows.filter(([, f]) => f.status === 'done').length}/${rows.length}`]
  const pcts = []
  for (const [name, f] of rows) {
    const p = readProgress(f.worktree ?? main, registry, name, f.status)
    pcts.push(p.pct)
    if (['done', 'queued', 'waiting'].includes(f.status)) continue
    if (f.status === 'parked' || f.status === 'failed') { items.push(`⛔ ${name}`); continue }
    items.push(`${name} ${p.label}`)
  }
  return { items, pcts, names: new Set(rows.map(([n]) => n)), worktrees: rows.map(([, f]) => f.worktree).filter(Boolean) }
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
    const p = featureProgress({ status: 'building', manifestText, planText: read(join(main, registry, name, 'PLAN.md')), ledgerText: read(ledger) })
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
    const fleet = fleetItems(roots.main, cfg.registry, bootTime)
    const gateRoots = [...new Set([roots.root, roots.main, ...(fleet?.worktrees ?? [])])]
    const builds = buildItems(roots.main, cfg.registry, now, fleet?.names ?? new Set())
    const items = [
      ...(fleet?.items ?? []),
      ...builds.items,
      ...gateRoots.flatMap((r) => gateItems(r, now, bootTime)),
    ]
    if (!items.length) return ''
    // One bar for everything with progress — the mean of the fleet's features and in-chat builds.
    // Gates and jobs alone have none, and get the name without a bar.
    const pcts = [...(fleet?.pcts ?? []), ...builds.pcts]
    const head = pcts.length ? `builder ${progressBar(pcts.reduce((a, b) => a + b, 0) / pcts.length)}` : 'builder'
    return fit([head, ...items], width)
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
