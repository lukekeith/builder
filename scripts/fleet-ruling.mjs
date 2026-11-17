#!/usr/bin/env node
// scripts/fleet-ruling.mjs
/**
 * Record a ruling that reaches outside a feature's footprint (docs/specs/2026-11-14-group-lanes-design.md
 * D11): `fleet-ruling.mjs <feature> <path>… -- <ruling>` appends
 * `- <YYYY-MM-DD> <feature>: <ruling> (paths: a, b)` to the fleet's rulings.md — `$BUILDER_FLEET_DIR`
 * under a fleet, else `.builder/fleet/` at the repo root. At its next run boundary the fleet adds those
 * paths to the feature's footprint (D10), so a feature now touching another's files groups with it,
 * or waits for it to land, instead of meeting it as a conflict at landing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINE = /^- (\d{4}-\d{2}-\d{2}) ([A-Za-z0-9._-]+): (.*) \(paths: ([^()]*)\)\s*$/

/** rulings.md as `{ feature: [paths] }` — every path a feature's rulings named, in order, once each. */
export function parseRulings(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const m = LINE.exec(line.trim())
    if (!m) continue
    const paths = m[4].split(',').map((p) => p.trim()).filter(Boolean)
    const have = (out[m[2]] ??= [])
    for (const p of paths) if (!have.includes(p)) have.push(p)
  }
  return out
}

/** One rulings.md line. A path is repo-relative, forward slashes, no `./`; a ruling is one line. */
export function rulingLine({ date, feature, paths, ruling }) {
  const clean = paths.map((p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean)
  return `- ${date} ${feature}: ${String(ruling).replace(/\s+/g, ' ').trim()} (paths: ${clean.join(', ')})\n`
}

/** Where rulings.md lives: the fleet's own dir when one runs this, else the repo's `.builder/fleet`. */
export function rulingsFile({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.BUILDER_FLEET_DIR) return join(env.BUILDER_FLEET_DIR, 'rulings.md')
  // A worktree's toplevel is the worktree: the fleet's dir is in the main checkout, beside .git.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
  return join(resolve(common, '..'), '.builder', 'fleet', 'rulings.md')
}

/** The rulings recorded so far, read as parseRulings does; none when there is no file. */
export function readRulings(file) {
  return existsSync(file) ? parseRulings(readFileSync(file, 'utf8')) : {}
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const cut = argv.indexOf('--')
  const [feature, ...paths] = cut < 0 ? argv : argv.slice(0, cut)
  const ruling = cut < 0 ? '' : argv.slice(cut + 1).join(' ').trim()
  if (!feature || !/^[A-Za-z0-9._-]+$/.test(feature) || !paths.length || !ruling) {
    console.error('Usage: fleet-ruling.mjs <feature> <path>… -- <ruling>   (a ruling that touches paths outside the feature’s footprint)')
    process.exit(2)
  }
  if (paths.some((p) => p.startsWith('/') || p.split('/').includes('..'))) {
    console.error('fleet-ruling: paths are repo-relative — no absolute path, no ..')
    process.exit(2)
  }
  const file = rulingsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const line = rulingLine({ date: new Date().toISOString().slice(0, 10), feature, paths, ruling })
  appendFileSync(file, line)
  process.stdout.write(`recorded in ${file}: ${line}`)
}
