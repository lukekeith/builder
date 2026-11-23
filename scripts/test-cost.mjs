#!/usr/bin/env node
/**
 * test-cost — where this repo's test time went: the verifier's runs and the fleet's runs, read from
 * what builder already records (spec docs/specs/2026-11-23-test-efficiency-bench-design.md §E0).
 *
 *   node <plugin>/scripts/test-cost.mjs [--root <repo>] [--since 7d|<ISO date>] [--json]
 *
 * --root defaults to the main checkout of the repo the cwd is in (a fleet worktree reads its main
 * checkout's ledger). Read-only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifierCost, fleetCost, renderCost } from './test-cost-core.mjs'

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const readLines = (p) => {
  const out = []
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue
    try {
      out.push(JSON.parse(l))
    } catch {} // a line still being written
  }
  return out
}

export function sinceOf(arg, now = Date.now()) {
  if (!arg) return null
  const m = /^(\d+)([hdw])$/.exec(arg)
  if (m) return new Date(now - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]]).toISOString()
  const t = Date.parse(arg)
  if (Number.isNaN(t)) throw new Error(`--since: ${arg} is neither 7d/12h/2w nor a date`)
  return new Date(t).toISOString()
}

export function mainCheckout(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return dirname(common)
  } catch {
    return cwd
  }
}

/** Every <feature>-NN.jsonl under the fleet's logs, live and archived. */
function streamFiles(logs) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const m = /^(.+)-(\d+)\.jsonl$/.exec(e.name)
        if (m) out.push({ path: p, feature: m[1], run: Number(m[2]) })
      }
    }
  }
  walk(logs)
  return out
}

export function collect(root, since = null) {
  const reqDir = join(root, '.builder', 'verify', 'requests')
  const requests = existsSync(reqDir)
    ? readdirSync(reqDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(reqDir, f))).filter(Boolean).filter((r) => !since || (r.startedAt ?? r.createdAt ?? '') >= since)
    : []
  const streams = []
  for (const s of streamFiles(join(root, '.builder', 'fleet', 'logs'))) {
    const events = readLines(s.path)
    const first = events.find((x) => x?.timestamp)?.timestamp
    if (since && (!first || first < since)) continue
    streams.push({ feature: s.feature, run: s.run, events })
  }
  return { requests, streams }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : null
  }
  try {
    const root = resolve(opt('--root') ?? mainCheckout(process.cwd()))
    const since = sinceOf(opt('--since'))
    const { requests, streams } = collect(root, since)
    const verifier = verifierCost(requests)
    const fleet = fleetCost(streams)
    if (argv.includes('--json')) console.log(JSON.stringify({ root, since, verifier, fleet }, null, 2))
    else console.log(renderCost({ verifier, fleet, since: since && `${since.slice(0, 16)} (${basename(root)})` }))
  } catch (e) {
    console.error(`test-cost: ${e.message}`)
    process.exit(2)
  }
}
