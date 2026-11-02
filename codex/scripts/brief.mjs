#!/usr/bin/env node
/**
 * Appends what a worker must know about this machine to its task brief: the project config's
 * §Environment landmines, verbatim, and the ledger's `## env notes`. A fresh worker has never met
 * them, and the commonest kind — a service that does not reload, a tool that must run from a
 * particular directory, a cache that must be rebuilt first — makes a test pass or fail against a lie.
 *
 *   node brief.mjs <brief-file> [--ledger <featurePath>/ledger.md] [--root <worktree>]
 *
 * Run it after `task-brief` (which stays the upstream copy) and before the dispatch. Safe to re-run:
 * the blocks it wrote before are replaced, never repeated. Nothing to add leaves the brief as it was.
 * Claude's dispatch.mjs writes the same two blocks into its briefs.
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath } from './config.mjs'

const LANDMINES = "## Environment landmines (the project config's, verbatim)"
const NOTES = "## Environment notes (the ledger's)"

/** The body of a `## Environment landmines` section, trimmed; '' when absent. */
export function landminesOf(configText) {
  const lines = String(configText ?? '').replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((l) => /^##\s+Environment landmines\s*$/i.test(l.trimEnd()))
  if (at < 0) return ''
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break }
  return lines.slice(at + 1, end).join('\n').trim()
}

/** Every bullet (with its indented continuation lines) under each `## env notes` heading; '' when none. */
export function envNotesOf(ledgerText) {
  const lines = String(ledgerText ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (let at = 0; at < lines.length; at++) {
    if (!/^##\s+env notes(\s*\(.*\))?\s*$/i.test(lines[at])) continue
    let i = at + 1
    while (i < lines.length && !lines[i].trim()) i++
    let any = false
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (/^- /.test(l) || (any && /^\s+\S/.test(l))) { out.push(l); any = true }
      else break
    }
    at = i - 1
  }
  return out.join('\n')
}

/** The two blocks as they go into a brief; '' when both are empty. */
export function briefContext({ landmines, envNotes }) {
  const parts = []
  if (landmines) parts.push(LANDMINES, '', landmines, '')
  if (envNotes) parts.push(NOTES, '', envNotes, '')
  return parts.join('\n')
}

/** The brief without blocks a previous run appended (they always go last). */
const withoutContext = (text) => {
  const at = [LANDMINES, NOTES].map((h) => text.indexOf(`\n${h}\n`)).filter((i) => i >= 0)
  return at.length ? text.slice(0, Math.min(...at) + 1).replace(/\n+$/, '\n') : text
}

export function main(argv) {
  const brief = argv[0]
  const opt = (f) => { const i = argv.indexOf(f); return i > 0 ? argv[i + 1] : undefined }
  if (!brief || brief.startsWith('--')) throw Object.assign(new Error('usage: brief.mjs <brief-file> [--ledger <ledger.md>] [--root <worktree>]'), { usage: true })
  if (!existsSync(brief)) throw Object.assign(new Error(`no such brief: ${brief} — write it with task-brief first`), { usage: true })
  const root = resolve(opt('--root') ?? process.cwd())
  const rel = configPath(root)
  const landmines = rel ? landminesOf(readFileSync(join(root, rel), 'utf8')) : ''
  const ledger = opt('--ledger')
  const envNotes = ledger && existsSync(ledger) ? envNotesOf(readFileSync(ledger, 'utf8')) : ''
  const base = withoutContext(readFileSync(brief, 'utf8'))
  const extra = briefContext({ landmines, envNotes })
  const next = extra ? `${base.replace(/\n*$/, '\n')}\n${extra}` : base
  writeFileSync(brief, next)
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(`builder: ${error.message}`); process.exitCode = 2 }
}
