#!/usr/bin/env node
/**
 * The session brief's feature lists, for the project at the last argument.
 *
 *   brief-features.mjs <project>           the in-flight features, up to five, most recent first, one
 *                                          line each — name, state, next step. Read from
 *                                          list-features.mjs --json, so the brief and /builder:status
 *                                          never disagree. A feature the fleet has stopped is left
 *                                          to --parks, which says more about it.
 *   brief-features.mjs --landed <project>  what the fleet merged since /builder:fleet:status was last
 *                                          opened, one line each — where, the sha, and that nobody
 *                                          has tested it. The fleet tells no session when it lands.
 *   brief-features.mjs --parks <project>   what the fleet parked or failed, from its fleet.json, one
 *                                          line each — why, and the next step. The fleet runs
 *                                          detached and tells no session when it parks; a park its
 *                                          own runs found (a merge it could not finish, a walk env
 *                                          that would not start, no progress) is on no manifest's
 *                                          `blocked:` line, so this is the only place a new
 *                                          session hears of it. A park that needs you (your uncommitted
 *                                          changes in a landing's way) reads `⛔ <f> needs you — <why> —
 *                                          /builder:fleet:status to choose`; set-aside changes that came
 *                                          back with conflicts follow while their stash is kept.
 *                                          fleet.json and .git's stash log only — no git, no spawn.
 *
 * Prints nothing on any error (the hook stays silent).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX = 5
const args = process.argv.slice(2)
const parksMode = args.includes('--parks')
const landedMode = args.includes('--landed')
const project = args.filter((a) => !a.startsWith('--'))[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd()

/** The fleet's parked and failed rows ([] when there is no fleet, or it can't be read); with `notes`,
 *  `{ stops, notes }` — the notes that wait on you too (set-aside changes back with conflicts). */
async function stops({ notes = false } = {}) {
  try {
    const { fleetStops, setAsideConflicts } = await import('../scripts/fleet-core.mjs')
    const { repoRoots } = await import('../scripts/statusline.mjs')
    // The fleet keeps its state in the main checkout, wherever this session was opened.
    const main = repoRoots(project)?.main ?? project
    const { loadConfig } = await import('../scripts/config.mjs')
    const cfg = loadConfig(main)
    const fleet = JSON.parse(readFileSync(join(main, '.builder', 'fleet', 'fleet.json'), 'utf8'))
    const rows = fleetStops(fleet, { main, registry: cfg.ok ? cfg.registry : null })
    return notes ? { stops: rows, notes: setAsideConflicts(fleet, main) } : rows
  } catch {
    return notes ? { stops: [], notes: [] } : []
  }
}

try {
  if (landedMode) {
    // What merged since /builder:fleet:status was last opened — the fleet tells no session when it lands.
    const { newLandings, landingLine } = await import('../scripts/fleet-core.mjs')
    const { repoRoots } = await import('../scripts/statusline.mjs')
    const lines = newLandings(repoRoots(project)?.main ?? project).map(landingLine)
    if (lines.length) process.stdout.write(lines.join('\n'))
  } else if (parksMode) {
    // A needs-you park waits on an answer, not a retry: it is raised with its choices (D3).
    const { needsYouWhy } = await import('../scripts/fleet-core.mjs')
    const found = await stops({ notes: true })
    const lines = [
      ...found.stops.map((s) => s.needsYou
        ? `- ⛔ ${s.name} needs you — ${needsYouWhy(s.why)} — /builder:fleet:status to choose`
        : `- ⛔ ${s.name} ${s.status}${s.why ? ` — ${s.why}` : ''} — next: ${s.next}`),
      ...found.notes.map((n) => `- ${n}`),
    ]
    if (lines.length) process.stdout.write(lines.join('\n'))
  } else {
    const stopped = new Set((await stops()).map((s) => s.name))
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'list-features.mjs')
    const r = spawnSync(process.execPath, [script, '--json'], {
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      encoding: 'utf8',
      timeout: 8000, // under the hook's own 10 s: a slow list drops the list, never the brief
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (r.status === 0 && r.stdout.trim()) {
      const open = (JSON.parse(r.stdout).features ?? [])
        .filter((f) => !f.done && f.feature && !stopped.has(f.feature))
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      const lines = open.slice(0, MAX).map((f) => {
        // list-features' state cell reads `planned · size md · …` — the brief keeps the step.
        const step = String(f.state ?? '').split(' · ')[0].replace(/\s+/g, ' ').trim()
        const state = step ? ` (${step})` : ''
        const next = f.nextStep && f.nextStep !== '—' ? ` — next: ${f.nextStep}` : ''
        const cmd = f.command && f.command !== '—' ? ` · ${f.command}` : ''
        return `- ${f.feature}${state}${next}${cmd}`
      })
      if (open.length > MAX) lines.push(`- … and ${open.length - MAX} more — /builder:status lists them all`)
      if (lines.length) process.stdout.write(lines.join('\n'))
    }
  }
} catch {
  // silent: the brief goes out without the list
}
