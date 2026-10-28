// scripts/bench-replay-core.mjs
/**
 * The gate replay's decisions, free of the CLI (docs/specs/2026-10-27-verifier-design.md §Benchmark 1):
 * which commits an archived feature made, where its phases closed, and where the old gates ran.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './verify/git.mjs'

export function featureRange(repo, merged) {
  const [, base, tip] = git(repo, 'rev-list', '--parents', '-n1', merged).split(' ')
  if (!tip) throw new Error(`${merged} is not a merge commit`)
  const commits = git(repo, 'rev-list', '--reverse', '--first-parent', `${base}..${tip}`).split('\n').filter(Boolean)
  return { base, tip, commits }
}

/** An app path as the config may spell it: `apps/server/`, `./apps/server`, `.` and `./` (the root) all normalise to a bare relative path, '.' for the root. */
export const normPath = (p) => String(p ?? '').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.'

const appOf = (file, apps) => apps.map((a) => ({ name: a.name, path: normPath(a.path) })).filter((a) => a.path !== '.' && (file === a.path || file.startsWith(`${a.path}/`))).sort((x, y) => y.path.length - x.path.length)[0]?.name ?? apps.find((a) => normPath(a.path) === '.')?.name ?? null

export function phaseBoundaries(commits, apps, registry) {
  const out = []
  let cur = null
  let last = -1
  commits.forEach((c, i) => {
    const code = c.files.filter((f) => !f.startsWith(`${registry}/`))
    const owners = [...new Set(code.map((f) => appOf(f, apps)).filter(Boolean))]
    if (!owners.length) {
      if (cur) last = i
      return
    }
    const app = owners[0]
    if (cur && app !== cur) out.push({ index: last, app: cur })
    cur = app
    last = i
  })
  if (cur) out.push({ index: last, app: cur })
  return out
}

export function controlPoints(boundaries, shas, apps) {
  const pts = boundaries.map((b) => ({ sha: shas[b.index], args: [b.app], label: `phase ${b.app}` }))
  const touched = touchedApps(boundaries, apps)
  const tip = shas.at(-1)
  // No phase mapped to an app: an app-less gate.mjs call measures nothing (it exits 2), so gate every app the config lists, and say so in the label.
  const note = boundaries.length ? '' : ' (no app touched: all apps)'
  pts.push({ sha: tip, args: touched, label: `end gates${note}` }, { sha: tip, args: ['--deep', ...touched], label: `verify deep${note}` })
  return pts
}

/** The apps the old gates run for at the end: those the phases touched, else every app the config lists. */
export function touchedApps(boundaries, apps) {
  const t = [...new Set(boundaries.map((b) => b.app))].sort((a, b) => apps.findIndex((x) => x.name === a) - apps.findIndex((x) => x.name === b))
  return t.length ? t : apps.map((a) => a.name)
}

/** True when `child` is `parent` or under it — the replay never writes inside the repo it reads. */
export const isInside = (parent, child) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/**
 * What the verifier learns across features (ledger.mjs): the target's known failures and the flake
 * list. In real use `.builder/verify/` persists in the repo; a fresh clone per feature would re-learn
 * them every time. results.jsonl, requests/, lines/ and the service's files are per-run: not carried.
 */
const CARRY_FILES = ['known-failures.json', 'flakes.json']

export function saveCarry(verifyDir, carryDir) {
  mkdirSync(carryDir, { recursive: true })
  for (const f of CARRY_FILES) if (existsSync(join(verifyDir, f))) copyFileSync(join(verifyDir, f), join(carryDir, f))
}

/** Copies the carried files into a clone's verify dir; returns how many known ids and flaky ids that seeded. */
export function seedCarry(carryDir, verifyDir) {
  let n = 0
  for (const f of CARRY_FILES) {
    if (!existsSync(join(carryDir, f))) continue
    mkdirSync(verifyDir, { recursive: true })
    copyFileSync(join(carryDir, f), join(verifyDir, f))
    try {
      const j = JSON.parse(readFileSync(join(carryDir, f), 'utf8'))
      n += f === 'flakes.json' ? Object.keys(j).length : Object.values(j).reduce((a, k) => a + (k.ids?.length ?? 0), 0)
    } catch {}
  }
  return n
}

/** The verdict `verify wait --json` printed: the JSON object after any `pending:` lines, from the WHOLE stdout (a verdict outgrows any tail kept for errors). null when there is none. */
export function verdictOf(stdout) {
  const at = String(stdout ?? '').search(/^\{/m)
  if (at < 0) return null
  try {
    return JSON.parse(stdout.slice(at))
  } catch {
    return null
  }
}

const m = (ms) => `${Math.round(ms / 60000)}m`
export function summarize(all) {
  const errored = all.filter((r) => r.error)
  const rows = all.filter((r) => !r.error)
  const t = rows.reduce(
    (a, r) => ({
      cb: a.cb + r.control.blockingMs,
      cr: a.cr + r.control.reds,
      un: a.un + (r.control.unrun ?? 0),
      tb: a.tb + r.treatment.blockingMs,
      bg: a.bg + r.treatment.backgroundMs,
      ...Object.fromEntries(['regressions', 'flakes', 'known', 'debt', 'broken'].map((k) => [k, a[k] + r.treatment[k]])),
    }),
    { cb: 0, cr: 0, un: 0, tb: 0, bg: 0, regressions: 0, flakes: 0, known: 0, debt: 0, broken: 0 },
  )
  // `unrun` closes the row: old-gate runs that neither passed nor failed (no deep set, a signal, a timeout).
  const row = (name, cb, cr, tb, bg, x, un) => `| ${name} | ${m(cb)} | ${cr} | ${m(tb)} | ${m(bg)} | ${x.regressions} | ${x.flakes} | ${x.known} | ${x.debt} | ${x.broken} | ${un} |`
  return [
    '| Feature | Old gates: blocking | Old gates: red runs | Verifier: blocking (phase + merge) | Verifier: background (commit) | Regressions | Flakes | Known | Newly found debt | Env-broken | Old gates: unrun |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => row(r.feature, r.control.blockingMs, r.control.reds, r.treatment.blockingMs, r.treatment.backgroundMs, r.treatment, r.control.unrun ?? 0)),
    row('**total**', t.cb, t.cr, t.tb, t.bg, t, t.un),
    '',
    `blocking time: ${t.cb ? Math.round((1 - t.tb / t.cb) * 100) : 0}% less · red results the verifier did not count against a feature: ${t.flakes + t.known + t.debt} · regressions it attributed to a commit: ${t.regressions}`,
    ...(errored.length ? ['', `errored (not in the table): ${errored.map((r) => `${r.feature} — ${r.error}`).join('; ')}`] : []),
  ].join('\n')
}
