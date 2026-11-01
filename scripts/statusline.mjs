#!/usr/bin/env node
/**
 * statusline — builder's segment of Claude Code's status line (through the launcher
 * /builder:statusline installs, which puts it after the previous status line on the same row):
 * `builder` and one bar of overall progress, then fleet features with their step, a build in the
 * chat whose ledger moved in the last 5 minutes, and the verifier's running requests. A feature the fleet
 * parked or failed reads `⛔ <feature>: <why>` — and stays, from fleet.json, after the fleet has
 * exited, until a new run changes the row; short of room the parks fold into `⛔ 2 parked —
 * /builder:fleet:status`. A park that needs your answer (your uncommitted changes in a landing's
 * way) leads instead: `⛔ <feature> needs you: <why cut to fit> — /builder:fleet:status`, the command
 * never cut — the why, then the name, the fleet's count, the bar and `builder` give way first.
 * A running feature with no commit or ledger tick for 45 minutes gets a ⚠.
 * Prints nothing when nothing runs or waits on you — and nothing, exit 0, on any error.
 *
 *   node <plugin>/scripts/statusline.mjs --cwd <dir> [--width <n>] [--now <ms>]
 *
 * `--width` is this segment's budget in columns; whole trailing items drop to fit, `builder` and its bar never
 * (but for a needs-you park's command, above).
 *
 * Runs every couple of seconds, so it reads a handful of known files and spawns nothing.
 */
import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { uptime } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { readProgress, rowProgress, progressBar, mergedThisRun, fleetStops, stallOf, newLandings, needsYouWhy } from './fleet-core.mjs'
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
export function fit(items, width, keep = 1) {
  for (let k = items.length; k > 0; k--) {
    const more = items.length - k
    const line = items.slice(0, k).join(' · ') + (more ? ` +${more} more` : '')
    if ([...line].length <= width || k <= keep) return line
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

/**
 * D4: the parks that need you, as one item in `budget` columns — the longest form that fits, and the
 * command to choose always whole: `⛔ <f> needs you: <why cut to fit> — /builder:fleet:status`,
 * `⛔ <f> needs you — …` (`⛔ a, b need you — …`, `⛔ 2 need you — …` for several), then the bare
 * `⛔ /builder:fleet:status`. null when even that does not fit.
 */
export const NEED_CMD = '/builder:fleet:status'
const NEED_WHY_MIN = 10
export function needItem(need, budget) {
  if (!need.length) return null
  const tail = ` — ${NEED_CMD}`
  const len = (s) => [...s].length
  const forms = []
  if (need.length === 1) {
    const head = `⛔ ${need[0].name} needs you`
    // The status line's why is the brief's, shorter: "your changes overlap it (2 files)".
    const why = needsYouWhy(need[0].why).replace(/^your uncommitted changes /, 'your changes ')
    const room = Math.min(WHY_MAX, budget - len(head) - 2 - len(tail))
    if (why && room >= NEED_WHY_MIN) forms.push(`${head}: ${clip(why, room)}${tail}`)
    forms.push(`${head}${tail}`)
  } else forms.push(`⛔ ${need.map((s) => s.name).join(', ')} need you${tail}`, `⛔ ${need.length} need you${tail}`)
  forms.push(`⛔ ${NEED_CMD}`)
  return forms.find((f) => len(f) <= budget) ?? null
}

/**
 * What landed since the status was last opened, longest form first:
 * `✔ a merged — /builder:fleet:status` → `✔ a merged` → `✔ 1 merged`.
 */
export function landedForms(landed) {
  if (!landed.length) return []
  const names = landed.map((l) => l.feature)
  const what = names.length <= 2 ? names.join(', ') : `${names.length}`
  return [`✔ ${what} merged — /builder:fleet:status`, `✔ ${what} merged`, `✔ ${names.length} merged`]
}

/** The longest landing form that fits `budget` columns; the shortest is the floor. */
export function landedItems(landed, budget = Infinity) {
  const forms = landedForms(landed)
  return forms.length ? [forms.find((f) => [...f].length <= budget) ?? forms[forms.length - 1]] : []
}

function fleetItems(main, registry, bootTime, now) {
  const fleet = readJson(join(main, '.builder', 'fleet', 'fleet.json'))
  if (!fleet) return null
  const stops = fleetStops(fleet, { main, registry })
  const lock = join(main, '.builder', 'fleet', 'lock')
  // The fleet has exited: its parked and failed rows still wait on someone, and fleet.json still
  // holds them — they stay on the line until a new run changes them. Nothing else from it does.
  // So are its landings, until /builder:fleet:status is opened: a merge happened while nobody watched.
  if (!current(lock, bootTime) || !alive(read(lock))) {
    const landed = newLandings(main, now)
    return stops.length || landed.length ? { items: [], stops, landed, pcts: [], names: new Set(), worktrees: [] } : null
  }
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

/** One `verify <tier> <branch> ⏱ <elapsed>` per request the verifier is running right now. */
export function verifyItems(main, now, bootTime = 0) {
  const dir = join(main, '.builder', 'verify', 'requests')
  return list(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ r: readJson(join(dir, f)), f }))
    // A request file older than the last boot names a pid that is gone, whatever has it now.
    .filter(({ r, f }) => r?.state === 'running' && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt)) && current(join(dir, f), bootTime) && alive(r.pid))
    .map(({ r }) => r)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((r) => `verify ${r.tier} ${r.branch} ⏱ ${elapsed(now - Date.parse(r.startedAt))}`)
}

export function render({ cwd, width = 120, now = Date.now(), bootTime = Date.now() - uptime() * 1000 }) {
  try {
    const roots = repoRoots(cwd)
    if (!roots) return ''
    const cfg = loadConfig(roots.main)
    if (!cfg.ok) return ''
    const fleet = fleetItems(roots.main, cfg.registry, bootTime, now)
    const builds = buildItems(roots.main, cfg.registry, now, fleet?.names ?? new Set())
    const rest = [...builds.items, ...verifyItems(roots.main, now, bootTime)]
    const [lead, ...running] = fleet?.items ?? []
    const all = fleet?.stops ?? []
    const need = all.filter((s) => s.needsYou)
    const stops = all.filter((s) => !s.needsYou)
    const landings = fleet?.landed ?? []
    if (!lead && !running.length && !rest.length && !all.length && !landings.length) return ''
    // One bar for everything with progress — the mean of the fleet's features and in-chat builds.
    // Verifier runs alone have none, and get the name without a bar.
    const pcts = [...(fleet?.pcts ?? []), ...builds.pcts]
    const head = pcts.length ? `builder ${progressBar(pcts.reduce((a, b) => a + b, 0) / pcts.length)}` : 'builder'
    // The parks get their room first, after `builder` and the fleet's count; the rest fit after them.
    let fixed = [head, ...(lead ? [lead] : [])]
    const after = [...running, ...rest]
    // D4: a park that needs you comes before everything but `builder`, and its command is never cut —
    // the fleet's count, then the bar, then `builder` itself give way first, so it fits down to 24 columns.
    let needs = null
    if (need.length) {
      const n = stops.length + after.length + (landings.length ? 1 : 0)
      const reserve = n ? [...` +${n} more`].length : 0
      const tries = [fixed, [head], ['builder'], []]
      // Room for a ` +N more` after it when there is more to come — unless keeping it would cost the
      // feature's name (the rest then goes) or what precedes it.
      for (const t of tries) {
        const budget = width - [...t.join(' · ')].length - (t.length ? 3 : 0)
        const roomy = needItem(need, budget - reserve)
        needs = roomy && roomy !== `⛔ ${NEED_CMD}` ? roomy : needItem(need, budget)
        if (needs) {
          fixed = [...t, needs]
          break
        }
      }
    }
    // A landing is never folded into "+N more": it gets room right after the parks and shrinks to fit.
    // The parks keep their priority, but give up room (down to their folded count) for its short form
    // and for the ` +N more` that follows when more items come after it.
    const tail = after.length ? [...` +${after.length} more`].length : 0
    const room = width - [...fixed.join(' · ')].length - 3
    const forms = landedForms(landings)
    const floor = forms.length ? [...forms[forms.length - 1]].length + 3 + tail : 0
    let parks = parkItems(stops, room)
    if (floor && parks.length && [...parks.join(' · ')].length + floor > room) parks = parkItems(stops, room - floor)
    let out
    if (!forms.length) out = fit([...fixed, ...parks, ...after], width, needs ? fixed.length : 1)
    else {
      const keep = fixed.length + parks.length + 1
      for (const form of forms) {
        out = fit([...fixed, ...parks, form, ...after], width, keep)
        if ([...out].length <= width) break
      }
    }
    // What needs you is never cut: when the rest crowds it, the rest goes.
    if (needs && [...out].length > width) out = fixed.join(' · ')
    // The last resort: a line that still does not fit is cut, never left to overflow.
    return clip(out, width)
  } catch {
    return ''
  }
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  const argv = process.argv.slice(2)
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
  const line = render({
    cwd: opt('--cwd') ?? process.cwd(),
    width: Number(opt('--width') ?? process.env.COLUMNS) || 120,
    now: Number(opt('--now')) || Date.now(),
  })
  if (line) process.stdout.write(`${line}\n`)
}
