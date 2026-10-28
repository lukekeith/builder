// scripts/bench-replay-core.mjs
/**
 * The gate replay's decisions, free of the CLI (docs/specs/2026-10-27-verifier-design.md §Benchmark 1):
 * which commits an archived feature made, where its phases closed, and where the old gates ran.
 */
import { git } from './verify/git.mjs'

export function featureRange(repo, merged) {
  const [, base, tip] = git(repo, 'rev-list', '--parents', '-n1', merged).split(' ')
  if (!tip) throw new Error(`${merged} is not a merge commit`)
  const commits = git(repo, 'rev-list', '--reverse', '--first-parent', `${base}..${tip}`).split('\n').filter(Boolean)
  return { base, tip, commits }
}

const appOf = (file, apps) => apps.filter((a) => a.path && a.path !== '.' && (file === a.path || file.startsWith(`${a.path}/`))).sort((x, y) => y.path.length - x.path.length)[0]?.name ?? apps.find((a) => a.path === '.')?.name ?? null

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
  const touched = [...new Set(boundaries.map((b) => b.app))].sort((a, b) => apps.findIndex((x) => x.name === a) - apps.findIndex((x) => x.name === b))
  const tip = shas.at(-1)
  pts.push({ sha: tip, args: touched, label: 'end gates' }, { sha: tip, args: ['--deep', ...touched], label: 'verify deep' })
  return pts
}

const m = (ms) => `${Math.round(ms / 60000)}m`
export function summarize(rows) {
  const t = rows.reduce(
    (a, r) => ({
      cb: a.cb + r.control.blockingMs,
      cr: a.cr + r.control.reds,
      tb: a.tb + r.treatment.blockingMs,
      bg: a.bg + r.treatment.backgroundMs,
      ...Object.fromEntries(['regressions', 'flakes', 'known', 'debt', 'broken'].map((k) => [k, a[k] + r.treatment[k]])),
    }),
    { cb: 0, cr: 0, tb: 0, bg: 0, regressions: 0, flakes: 0, known: 0, debt: 0, broken: 0 },
  )
  const row = (name, cb, cr, tb, bg, x) => `| ${name} | ${m(cb)} | ${cr} | ${m(tb)} | ${m(bg)} | ${x.regressions} | ${x.flakes} | ${x.known} | ${x.debt} | ${x.broken} |`
  return [
    '| Feature | Old gates: blocking | Old gates: red runs | Verifier: blocking (phase + merge) | Verifier: background (commit) | Regressions | Flakes | Known | Newly found debt | Env-broken |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => row(r.feature, r.control.blockingMs, r.control.reds, r.treatment.blockingMs, r.treatment.backgroundMs, r.treatment)),
    row('**total**', t.cb, t.cr, t.tb, t.bg, t),
    '',
    `blocking time: ${t.cb ? Math.round((1 - t.tb / t.cb) * 100) : 0}% less · red results the verifier did not count against a feature: ${t.flakes + t.known + t.debt} · regressions it attributed to a commit: ${t.regressions}`,
  ].join('\n')
}
