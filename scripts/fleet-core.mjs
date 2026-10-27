/**
 * The fleet's decisions, kept free of processes and git so they can be tested directly.
 * fleet.mjs does the side effects; this module says what a manifest and a finished run MEAN.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from './manifest.mjs'
import { ARCHIVE } from './registry.mjs'
import { rowLabel } from './profile.mjs'

const BUILD_STATES = new Set(['spec', 'aligned', 'audited', 'planned', 'building'])
const WALK_STATES = new Set(['built', 'signed-off'])
const SHIP_STATES = new Set(['verified'])
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')

/**
 * Which lane a feature belongs in. `building` with `ready: pending` is every phase closed and only
 * walk readiness left — that needs the dev env, so it is walk-lane work. `verified` is the ship
 * lane: the PR, CI, the ship commit and the merge need no dev env, so they run in the parallel pool
 * and never hold the one-at-a-time walk lane while CI runs. An open PR is not done — merged is.
 */
export function laneOf(mf, { batched = false, specText = null } = {}) {
  if (isSet(mf.blocked)) return 'blocked'
  if (mf.state === 'shipped') return 'done'
  if (mf.state === 'building' && /^pending/.test(mf.ready ?? '')) return 'walk'
  if (BUILD_STATES.has(mf.state)) return 'build'
  // Batched walks (agent_walk.start with batch > 1): the walk lane holds only what needs the running
  // env — readiness and the agent walk. A walk's fixes are worked in the parallel pool (no env), and
  // verify + ship run there too; the @walk gates verify needs ran once in the batch.
  if (batched && mf.state === 'built' && hasOpenFixes(specText)) return 'build'
  if (batched && mf.state === 'signed-off') return 'ship'
  if (WALK_STATES.has(mf.state)) return 'walk'
  if (SHIP_STATES.has(mf.state)) return 'ship'
  return 'unknown'
}

/** An open `- [ ]` under the SPEC's `## Fixes` (always its last section). */
export function hasOpenFixes(specText) {
  const i = (specText ?? '').search(/^## Fixes\s*$/m)
  return i >= 0 && /^\s*[-*] \[ \]/m.test(specText.slice(i))
}

/**
 * A park reason as `{ why, next }` — REFERENCE §How a park reads: `<why> — next: <step>`. The last
 * ` — next: ` splits it. A line written before that rule said `— clears when <what>`, which is its
 * next step. No next step → null; the caller supplies the retry.
 */
export function parkParts(reason) {
  const s = unquote(reason).trim()
  const m = /^([\s\S]*)\s—\s(?:next:\s*([\s\S]*)|(clears when\s[\s\S]*))$/.exec(s)
  if (!m) return { why: s, next: null }
  return { why: m[1].trim(), next: (m[2] ?? m[3]).trim() || null }
}
export const RETRY_NEXT = '/builder:agent — naming it again unparks it and retries'

/** The PR a SHIPPED SPEC header names ('#12'), or null when the header is not SHIPPED. `/builder:ship`
 *  removes MANIFEST.md, so after the ship commit this header is the only record. */
export function shippedPr(specText) {
  const head = (specText ?? '').slice(0, 800)
  if (!/✅\s*\*{0,2}SHIPPED/.test(head)) return null
  return /PR\s*(#\d+)/.exec(head)?.[1] ?? 'shipped'
}

/** What one finished `claude -p` run means for its feature. See the plan's Task 3 interface. */
export function decide({ lane, manifestText, specText = null, exit, failures, stalls = 0, runs, cap, progressed, folder = '<folder>', batched = false }) {
  // Shipped is done however the run ended — one that timed out after the ship commit must not be
  // retried into a second one.
  const shipped = manifestText == null ? shippedPr(specText) : null
  if (shipped) return { action: 'done', pr: shipped }
  const mf = manifestText == null ? null : parseManifest(manifestText)
  if (mf && laneOf(mf, { batched, specText }) === 'done') return { action: 'done', pr: mf.pr ?? null }
  if (exit !== 0) {
    const what = exit === null ? 'timed out' : `failed (exit ${exit})`
    return failures >= 1 ? { action: 'fail', reason: `run ${what} twice` } : { action: 'retry' }
  }
  if (mf == null) return { action: 'park', reason: 'MANIFEST.md was gone after the run — next: /builder:status to see where the feature stands' }
  const next = laneOf(mf, { batched, specText })
  if (next === 'blocked') return { action: 'park', reason: unquote(mf.blocked) }
  if (next === 'unknown') return { action: 'park', reason: `manifest state '${mf.state ?? ''}' is not one the fleet knows — next: /builder:resume --path ${folder} to set it right` }
  if (next !== lane) return { action: 'handoff', to: next }
  // One stall is often a run that ended mid-step (a turn that stopped to wait); the next run
  // resumes from the ledger. Two in a row is a real stall.
  if (!progressed) return stalls >= 1 ? { action: 'park', reason: "no progress — two runs in a row changed neither MANIFEST.md nor HEAD — next: /builder:agent to retry; the last run's log says where it stopped" } : { action: 'stalled' }
  if (runs >= cap) return { action: 'park', reason: `run cap (${cap}) reached while still making progress — next: /builder:agent to retry with a fresh cap` }
  return { action: 'again' }
}

export const fleetDir = (root) => join(root, '.builder', 'fleet')

export function loadFleet(root) {
  const p = join(fleetDir(root), 'fleet.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { features: {} }
}

/** Atomic: a fleet killed mid-write leaves the previous fleet.json, never half of one. */
export function saveFleet(root, fleet, progress = null, testsOf = null) {
  const dir = fleetDir(root)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const tmp = join(dir, 'fleet.json.tmp')
  writeFileSync(tmp, JSON.stringify(fleet, null, 2) + '\n')
  renameSync(tmp, join(dir, 'fleet.json'))
  writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet, progress, tailArchive(root, 1)[0] ?? null, Date.now(), tailArchive(root, 5), testsOf))
}

// ---- the archive -------------------------------------------------------------------------------
//
// A landed feature leaves fleet.json: one JSON line in archive.jsonl (git-ignored, written only by
// the fleet process, which lands one feature at a time), and its logs move under logs/_archive/.
// fleet.json then holds only work in flight — its size, and the cost of every save, stay flat.

const ARCHIVE_LOG = 'archive.jsonl'
const NL = 0x0a

/** The last `n` archive rows, oldest first. Reads backwards `chunk` bytes at a time as raw bytes, so
 *  a multibyte character split across chunks is joined before it is decoded. */
export function tailArchive(root, n, chunk = 64 * 1024) {
  const p = join(fleetDir(root), ARCHIVE_LOG)
  if (n <= 0 || !existsSync(p)) return []
  const fd = openSync(p, 'r')
  try {
    let pos = fstatSync(fd).size
    let data = Buffer.alloc(0)
    const newlines = () => data.reduce((k, b) => k + (b === NL ? 1 : 0), 0)
    while (pos > 0 && newlines() <= n) {
      const len = Math.min(chunk, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, pos)
      data = Buffer.concat([buf, data])
    }
    const lines = data.toString('utf8').split('\n').filter(Boolean)
    // Stopped short of the file's start: the first line is a fragment.
    return (pos > 0 ? lines.slice(1) : lines).slice(-n).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

/** Every feature's last archive row, as a Map — the whole file, not a tail: a landing may be old. */
export function landedRows(root) {
  const p = join(fleetDir(root), ARCHIVE_LOG)
  const out = new Map()
  if (!existsSync(p)) return out
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try {
      const r = JSON.parse(l)
      if (r?.feature) out.set(r.feature, r)
    } catch {}
  }
  return out
}

/** The last archive row for `feature`, or null. */
export const landedRow = (root, feature) => landedRows(root).get(feature) ?? null

/** One line per landing. A repeat of a landing already among the last 50 lines (a fleet killed
 *  between this append and its save re-archives the row on the next load) is skipped. */
export function appendArchive(root, row) {
  mkdirSync(fleetDir(root), { recursive: true })
  if (tailArchive(root, 50).some((r) => r.feature === row.feature && r.merged === row.merged)) return false
  appendFileSync(join(fleetDir(root), ARCHIVE_LOG), JSON.stringify(row) + '\n')
  return true
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** This feature's run, setup, start and sync logs into logs/_archive/<feature>/. Exact names only:
 *  `a` must not take `a-b-01.log`. Null when done (or nothing to move); else a note. */
export function archiveLogs(root, feature) {
  const logs = join(fleetDir(root), 'logs')
  if (!existsSync(logs)) return null
  const mine = new RegExp(`^${escapeRe(feature)}-(\\d+|setup|start|sync)\\.(log|jsonl)$`)
  const dest = join(logs, ARCHIVE, feature)
  try {
    const names = readdirSync(logs).filter((n) => mine.test(n))
    if (!names.length) return null
    mkdirSync(dest, { recursive: true })
    for (const n of names) renameSync(join(logs, n), join(dest, n))
    return null
  } catch (e) {
    return `${feature} merged, but its logs could not be moved into ${dest}: ${e.message}`
  }
}

/** Archived logs older than `days` go; `days` <= 0 keeps them. Best effort — the next start retries. */
export function pruneArchivedLogs(root, days, now = Date.now()) {
  if (!(days > 0)) return 0
  const base = join(fleetDir(root), 'logs', ARCHIVE)
  let removed = 0
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return 0
  }
  for (const n of names) {
    try {
      if (now - statSync(join(base, n)).mtimeMs > days * 86400000) {
        rmSync(join(base, n), { recursive: true, force: true })
        removed++
      }
    } catch {}
  }
  return removed
}

/** `just now` · `45m ago` · `10h ago` · `4d ago`. */
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return 'unknown'
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** True when `<root>/.builder/fleet/lock` names a live process. */
export function fleetAlive(root) {
  let pid = NaN
  try {
    pid = Number(readFileSync(join(fleetDir(root), 'lock'), 'utf8'))
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The warning for a fleet whose process is gone with rows mid-run — '' when none are. */
export function stoppedNote(fleet, fleetScript) {
  const mid = Object.entries(fleet.features ?? {}).filter(([, f]) => !['done', 'parked', 'failed'].includes(f.status)).map(([n]) => n).sort()
  if (!mid.length) return ''
  return `⚠ fleet stopped — its process is gone with ${mid.length} feature${mid.length > 1 ? 's' : ''} mid-run (${mid.join(', ')}). Resume: node ${fleetScript} --detach ${mid.join(' ')}`
}

/** Milliseconds as `45s`, `12m`, `1h12m`. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A feature's run timings summed per lane. */
export function laneTotals(timing) {
  const out = {}
  for (const t of timing ?? []) out[t.lane] = (out[t.lane] ?? 0) + t.ms
  return out
}

/** A `result` event's usage as { input, output, cacheRead, costUsd } — zeros without one. */
export function tokensOf(ev) {
  const u = ev?.usage ?? {}
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, costUsd: ev?.total_cost_usd ?? 0 }
}

/** `2.1M`, `340k`, `950`; `—` when absent or zero. */
export function formatTokens(n) {
  if (!n) return '—'
  if (n >= 999500) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/** `--status --archived [N]`: the latest landings, newest first. */
export function renderArchived(rows, total, now = Date.now()) {
  if (!rows.length) return 'No feature has landed from this fleet yet.\n'
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  // Tokens = input + output; cache reads are left out.
  const time = (r) => {
    const ms = Object.values(r.lanes ?? {}).reduce((a, b) => a + b, 0)
    return ms ? duration(ms) : null
  }
  const lines = [`# builder fleet — archive: latest ${rows.length} of ${Math.max(total, rows.length)}`, '', '| Feature | Tests | Time | Tokens | Merged | PR | Landed |', '|---|---|---|---|---|---|---|']
  for (const r of [...rows].reverse()) lines.push(`| ${cell(r.feature)} | ${cell(rowLabel(r))} | ${cell(time(r))} | ${formatTokens((r.tokens?.input ?? 0) + (r.tokens?.output ?? 0))} | ${cell(r.merged)} | ${cell(r.pr)} | ${cell(r.landedAt ? ago(r.landedAt, now) : null)} |`)
  return lines.join('\n') + '\n'
}

// ---- progress ----------------------------------------------------------------------------------
//
// How far along the pipeline a feature is, as a percentage of STEPS — not of time. Each manifest
// state has a floor; inside `building` the span up to 70 scales with the ledger's `Task N: complete`
// lines against the plan's `### Task N` headings. The weights are a judgment of where the effort
// usually falls (a sixth before the build, more than half in it, the rest walk → verify → merge).
const STAGE_FLOOR = { spec: 0, aligned: 5, audited: 10, planned: 15, building: 15, built: 75, 'signed-off': 80, verified: 90, shipped: 100 }
const BUILD_TOP = 70

const taskIds = (text, re) => new Set([...(text ?? '').matchAll(re)].map((m) => Number(m[1])))

/**
 * `{ pct, label }` for one feature from what the fleet knows (its status) and what the worktree
 * says (manifest, plan, ledger — any may be null). Pure; readProgress does the file reads.
 */
export function featureProgress({ status, manifestText = null, planText = null, ledgerText = null }) {
  if (status === 'done') return { pct: 100, label: 'merged' }
  if (manifestText == null) return { pct: 0, label: '—' }
  const mf = parseManifest(manifestText)
  const state = mf.state ?? ''
  // The build writes `state: building` at a phase close or a stop, not at its first task — so a
  // `planned` manifest whose ledger already has completed tasks is a build in its first phase.
  if (state === 'building' || state === 'planned') {
    if (/^pending/.test(mf.ready ?? '')) return { pct: BUILD_TOP + 2, label: 'walk readiness' }
    const total = taskIds(planText, /^#{2,4}\s+Task\s+(\d+)\b/gm).size
    const done = Math.min(total, taskIds(ledgerText, /^\W*Task\s+(\d+):\s*complete\b/gm).size)
    if (state === 'planned' && !done) return { pct: STAGE_FLOOR.planned, label: 'planned' }
    if (!total) return { pct: STAGE_FLOOR.building, label: 'build' }
    return { pct: Math.round(STAGE_FLOOR.building + ((BUILD_TOP - STAGE_FLOOR.building) * done) / total), label: `build ${done}/${total}` }
  }
  if (state === 'built' && /^agent-pass|^pass/.test(mf.walk ?? '')) return { pct: 78, label: 'walked' }
  if (state === 'verified' && isSet(mf.pr)) return { pct: 95, label: 'PR open' }
  return { pct: STAGE_FLOOR[state] ?? 0, label: state || '—' }
}

/** featureProgress fed from disk: `<base>/<registry>/<feature>/{MANIFEST,PLAN}.md` and the
 *  git-ignored ledger `<base>/.builder/<feature>/progress.md`. `base` is the worktree, or the
 *  repo root before one exists. */
export function readProgress(base, registry, feature, status) {
  const read = (...p) => (existsSync(join(base, ...p)) ? readFileSync(join(base, ...p), 'utf8') : null)
  return featureProgress({
    status,
    manifestText: read(registry, feature, 'MANIFEST.md'),
    planText: read(registry, feature, 'PLAN.md'),
    ledgerText: read('.builder', feature, 'progress.md'),
  })
}

/**
 * The features this fleet run has merged: `fleet.landedThisRun` (archiveRow adds each as it lands;
 * a new run starts it empty) plus any row still marked `done` that has not been archived yet.
 */
export function mergedThisRun(fleet) {
  const done = Object.entries(fleet.features ?? {}).filter(([, f]) => f.status === 'done').map(([n]) => n)
  return [...new Set([...(fleet.landedThisRun ?? []), ...done])]
}

/**
 * The run's overall progress: every feature it holds — in flight, queued, parked, or merged this run
 * — counted once, a merged one at 100%. Five features with one merged and four not started reads 20%,
 * and a feature added while the run goes on makes the total grow. `pctOf(name, f)` → the in-flight
 * row's percent. → `{ pct, merged, total }`; pct is null when the run holds nothing.
 */
export function fleetOverall(fleet, pctOf) {
  const merged = mergedThisRun(fleet)
  const rows = Object.entries(fleet.features ?? {}).filter(([n, f]) => f.status !== 'done' && !merged.includes(n))
  const total = rows.length + merged.length
  const sum = rows.reduce((s, [n, f]) => s + (pctOf(n, f) ?? 0), 0) + 100 * merged.length
  return { pct: total ? sum / total : null, merged: merged.length, total }
}

/** Ten cells and the number: `▓▓▓▓░░░░░░ 43%`. */
export function progressBar(pct) {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return `${'▓'.repeat(n)}${'░'.repeat(10 - n)} ${Math.round(pct)}%`
}

/**
 * The table a terminal renders: only columns that carry information. `PR` and `Evidence` are gone —
 * agent mode opens no PR since 3.0, and nothing ever wrote evidence — and the worktree root is said
 * once above the table instead of repeated per row; a row shows `worktree` only when it has one.
 * Wide, always-empty columns were what squeezed `Runs` onto two lines in the CLI's table renderer.
 *
 * `progress(name, f)` → `{ pct, label }` adds a Progress column and an overall bar (the mean) to the
 * heading; without it the table is as before. `testsOf(name, f)` → a test-plan label is the Tests
 * cell for a row the fleet has noted no facts for yet (the caller reads the manifest). A `done` row is archive material — counted in the archived line, never listed.
 */
export function renderStatus(fleet, progress = null, last = null, now = Date.now(), recent = [], testsOf = null) {
  const all = Object.entries(fleet.features).sort(([a], [b]) => a.localeCompare(b))
  const rows = all.filter(([, f]) => f.status !== 'done')
  const archived = (fleet.archived ?? 0) + (all.length - rows.length)
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const counts = {}
  for (const [, f] of rows) counts[f.status] = (counts[f.status] ?? 0) + 1
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ')
  const roots = new Set(rows.map(([, f]) => f.worktree && f.worktree.replace(/\/[^/]+\/?$/, '')).filter(Boolean))
  const prog = progress ? Object.fromEntries(rows.map(([name, f]) => [name, progress(name, f) ?? { pct: 0, label: '—' }])) : null
  // The bar covers the whole run: what is in flight here, and what it already merged (at 100%).
  const run = prog ? fleetOverall(fleet, (name) => prog[name]?.pct ?? 0) : null
  const overall = run?.pct != null ? progressBar(run.pct) : ''
  const mergedNote = run?.merged ? `${run.merged} merged this run${summary ? ' · ' : ''}` : ''
  const count = run ? run.total : rows.length
  const lines = [`# builder fleet — ${count} feature(s): ${mergedNote}${summary || (mergedNote ? '' : 'none')}${overall ? ` · ${overall}` : ''}`]
  if (fleet.target) lines.push('', `merges into **${fleet.target}**${roots.size ? ` · worktrees under ${[...roots].join(', ')}` : ''}`)
  if (archived) lines.push('', `${archived} archived${last ? ` (last: ${last.feature}, ${ago(last.landedAt, now)})` : ''} · /builder:fleet:status --archived for the latest 20`)
  // Recent landings: wall-clock start → merge where recorded (builder 5.3+: parks, restarts and
  // queueing included, by stage), else the mean agent time per lane (builder 4.6+).
  const walled = recent.filter((r) => typeof r.wallMs === 'number' && r.wallMs > 0)
  const timed = recent.filter((r) => r.lanes && Object.keys(r.lanes).length)
  if (walled.length) lines.push(`last ${walled.length} landed, mean wall-clock ${wallSummary(walled)}`)
  else if (timed.length) {
    const sums = {}
    for (const r of timed) for (const [lane, ms] of Object.entries(r.lanes)) sums[lane] = (sums[lane] ?? 0) + ms
    lines.push(`last ${timed.length} landed, mean agent time per lane: ${Object.entries(sums).map(([lane, ms]) => `${lane} ${duration(ms / timed.length)}`).join(' · ')}`)
  }
  if (!rows.length) lines.push('', 'Nothing in flight.')
  else {
    const col = prog ? ' Progress |' : ''
    lines.push('', `| Feature | Status | Tests |${col} Runs | Time | Reason | Worktree |`, `|---|---|---|${prog ? '---|' : ''}---|---|---|---|`)
    for (const [name, f] of rows) {
      // A parked row's cell is its why; the next step is listed under ## Parked, where it has room.
      const why = f.status === 'parked' ? parkParts(f.reason).why : f.reason
      const reason = f.pr && f.pr !== 'shipped' ? `${why ? `${why} · ` : ''}PR ${f.pr}` : why
      const p = prog ? ` ${progressBar(prog[name].pct)} · ${cell(prog[name].label)} |` : ''
      const spent = f.timing?.length ? duration(f.timing.reduce((s, t) => s + t.ms, 0)) : '—'
      lines.push(`| ${cell(name)} | ${cell(f.status)} | ${cell(rowLabel(f.facts) ?? testsOf?.(name, f))} |${p} ${f.runs ?? 0} | ${spent} | ${cell(reason)} | ${f.worktree ? 'yes' : '—'} |`)
    }
  }
  const parked = rows.filter(([, f]) => f.status === 'parked')
  if (parked.length) {
    lines.push('', '## Parked', '')
    for (const [name, f] of parked) {
      const { why, next } = parkParts(f.reason)
      lines.push(`- **${name}** — ${why || 'no reason recorded'}`, `  next: ${next ?? RETRY_NEXT}`)
    }
  }
  if (fleet.notes?.length) lines.push('', ...fleet.notes.map((n) => `- ${n}`))
  return lines.join('\n') + '\n'
}

/**
 * Whether a worktree needs ROOT's HEAD copy of the feature folder committed into it. A NEW branch
 * (cut from the target) needs it when the target lacks the folder or holds a different one; an
 * existing branch is left alone unless its worktree has no spec folder at all (an earlier bring-in failed; a folder with only SPEC.md is a condensed one).
 */
export function specBringIn({ targetTree, headTree, worktreeHasFolder, isNewBranch }) {
  if (isNewBranch) return !targetTree || targetTree !== headTree
  return !worktreeHasFolder
}

/**
 * The config body's `## Walk readiness` block as `{ migrations, status, apply, apply_mode,
 * regenerate, … }`: `key: value` lines inside its first fenced block, trailing `# comments` dropped,
 * a `<placeholder>` left from the template treated as unset.
 */
export function parseWalkReadiness(body) {
  const at = (body ?? '').search(/^## Walk readiness\s*$/m)
  if (at < 0) return {}
  const rest = body.slice(at).split('\n').slice(1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n')
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(section)
  const out = {}
  for (const raw of (fence ? fence[1] : '').split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(raw.replace(/\s{2,}#.*$|\s+#\s.*$/, '').trim())
    if (m && m[2] && !/^<.*>$/.test(m[2])) out[m[1]] = m[2]
  }
  return out
}

/**
 * What drops or rewrites data — never applied unattended, whatever apply_mode says. Raw SQL (also
 * inside an ORM's execute string), then each common migration tool's own operations: Alembic, Rails,
 * Knex, Django, TypeORM/Sequelize-style query runners.
 */
const DESTRUCTIVE_OPS = [
  /\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA|VIEW|CONSTRAINT|DATABASE|MATERIALIZED\s+VIEW)\b/i,
  /\bALTER\s+TABLE\b[^;]*\bDROP\b/i,
  /\bALTER\s+(TABLE|INDEX|TYPE|SCHEMA|VIEW)\b[^;]*\bRENAME\b/i,
  /\bRENAME\s+(TO|COLUMN|CONSTRAINT|TABLE)\b/i,
  /\bALTER\s+COLUMN\b[^;]*\b(TYPE|SET\s+DATA\s+TYPE)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bUPDATE\s+["'`\w.]+\s+SET\b/i,
  /\b(drop_table|drop_column|drop_constraint|drop_index|rename_table|rename_column|alter_column|remove_column|remove_columns|remove_reference|remove_index|remove_timestamps|change_column|change_table|batch_alter_table)\b/,
  /\b(dropTable|dropTableIfExists|dropColumn|dropColumns|renameColumn|renameTable|dropIndex|dropForeign|removeColumn|changeColumn|renameColumn)\b/,
  /\.alter\(\s*\)/,
  /\b(RemoveField|DeleteModel|RenameField|RenameModel|AlterField|RunPython|RunSQL)\b/,
]
/** Files that only ever run backwards: a down-only migration cannot drop anything going forward. */
const DOWN_ONLY = /\.down\.sql$|(^|\/)U\d+__[^/]*\.sql$|(^|\/)revert\//i
const KNOWN_KINDS = /\.(sql|py|rb|js|cjs|mjs|ts|cts|mts)$/i

/** Comments out, so a word in a comment or a docstring never reads as an operation. */
const stripComments = (path, text) => {
  let t = String(text ?? '')
  if (/\.py$/i.test(path)) t = t.replace(/("""|''')[\s\S]*?\1/g, '').replace(/^\s*#.*$/gm, '')
  if (/\.rb$/i.test(path)) t = t.replace(/^=begin[\s\S]*?^=end/gm, '').replace(/^\s*#.*$/gm, '')
  if (/\.(js|cjs|mjs|ts|cts|mts)$/i.test(path)) t = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  if (/\.sql$/i.test(path)) t = t.replace(/\/\*[\s\S]*?\*\//g, '')
  return t
}

/**
 * The forward half of a migration — what `apply` runs — or null when the file only runs backwards.
 * Alembic `def upgrade(` up to the next top-level def; Rails `def up` up to `def down` (`def change`
 * is the whole file); Knex/TypeORM `up` up to `down`; SQL before a down marker (`-- migrate:down`,
 * `-- +goose Down`, `-- +migrate Down`, `-- down`). Anything else — Django, Prisma's migration.sql,
 * a file whose boundary isn't found — is the whole file: when unsure, read more, not less.
 */
export function forwardHalf(path, text) {
  if (DOWN_ONLY.test(path)) return null
  const t = String(text ?? '')
  const cut = (start, end) => {
    const i = t.search(start)
    if (i < 0) return t
    const rest = t.slice(i)
    const j = rest.slice(1).search(end)
    return j < 0 ? rest : rest.slice(0, j + 1)
  }
  if (/\.py$/i.test(path)) return /^def upgrade\s*\(/m.test(t) ? cut(/^def upgrade\s*\(/m, /^def \w/m) : t
  if (/\.rb$/i.test(path)) return /^\s*def up\b/m.test(t) ? cut(/^\s*def up\b/m, /^\s*def down\b/m) : t
  if (/\.(js|cjs|mjs|ts|cts|mts)$/i.test(path)) {
    const up = /exports\.up\b|export\s+(async\s+)?function\s+up\b|export\s+const\s+up\b|(public\s+)?async\s+up\s*\(|\bup\s*[:=]\s*(async\s*)?(function|\()/m
    const down = /exports\.down\b|export\s+(async\s+)?function\s+down\b|export\s+const\s+down\b|(public\s+)?async\s+down\s*\(|\bdown\s*[:=]\s*(async\s*)?(function|\()/m
    return up.test(t) ? cut(up, down) : t
  }
  if (/\.sql$/i.test(path)) {
    const m = /^--\s*(migrate:down|\+goose\s+down|\+migrate\s+down|down\b)/im.exec(t)
    return m ? t.slice(0, m.index) : t
  }
  return t
}

/**
 * Why a migration file is not safe to apply unattended — the operation it runs going forward, or
 * that its kind is unknown — or null when it only adds. Errs towards a note: a false alarm costs
 * one command run by hand; a miss costs data.
 */
export function destructiveMigration({ path, text }) {
  const p = String(path ?? '')
  if (!KNOWN_KINDS.test(p)) return 'an unrecognised migration file — checked by hand'
  const fwd = forwardHalf(p, text)
  if (fwd == null) return null
  const body = stripComments(p, fwd)
  const hit = DESTRUCTIVE_OPS.map((re) => re.exec(body)).find(Boolean)
  return hit ? hit[0].replace(/\s+/g, ' ').trim() : null
}

/**
 * What to do about migrations a landing brought into the checkout: `files` are the new migration
 * files ({ path, text }), `readiness` is parseWalkReadiness. `apply` (apply_mode agent, additive
 * only) → the commands to run in order; otherwise a `note` naming what to run by hand.
 */
export function landedMigrations({ files, readiness }) {
  if (!files?.length) return { action: 'none' }
  const n = `${files.length} new migration${files.length === 1 ? '' : 's'}`
  const cmds = [readiness.apply, readiness.regenerate].filter(Boolean)
  const run = cmds.map((c) => `\`${c}\``).join(', then ')
  if (!readiness.apply) return { action: 'note', why: `${n} landed, but the config's §Walk readiness has no \`apply:\` command — apply them to the dev DB by hand` }
  const destructive = files.map((f) => [f.path, destructiveMigration(f)]).filter(([, why]) => why)
  if (destructive.length) return { action: 'note', why: `${n} landed and ${destructive.map(([p, why]) => `${p} (${why})`).join(', ')} may drop or rewrite data going forward, so nothing was applied — check it, then run ${run}` }
  if ((readiness.apply_mode ?? 'ask') !== 'agent') return { action: 'note', why: `${n} landed — the dev DB is behind: run ${run}` }
  return { action: 'apply', commands: cmds }
}

/** How recently a feature's workspace must have been written for a session to count as building it. */
export const ACTIVE_MS = 30 * 60 * 1000

/**
 * True when a session is working on the feature right now: any file in `<root>/.builder/<feature>/`
 * (its ledger, briefs, gate logs — written as a build goes) was touched within ACTIVE_MS. Agents must
 * not start on a feature someone is building in a session.
 */
export function activeInSession(root, feature, now = Date.now()) {
  const dir = join(root, '.builder', feature)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return names.some((n) => {
    try {
      return now - statSync(join(dir, n)).mtimeMs <= ACTIVE_MS
    } catch {
      return false
    }
  })
}

/**
 * The other unfinished features whose manifest names the same feature branch as `feature` — work
 * that shares a branch can't be handed to a fleet as one feature's branch. The base branch, the
 * merge target and `builder/` branches are never shared work. `manifests` is { name: parsed manifest }.
 */
export function sharedBranch(feature, manifests, cfg) {
  const branch = manifests[feature]?.branch
  if (!branch || branch === 'none' || branch === cfg.baseBranch || branch === cfg.mergeInto || branch.startsWith('builder/')) return []
  return Object.entries(manifests)
    .filter(([name, mf]) => name !== feature && mf?.branch === branch && mf.state !== 'shipped')
    .map(([name]) => name)
    .sort()
}

/** A session is building it: planned with a go-ahead, or building, and its workspace is fresh. A
 *  feature only specced in a session (its record written minutes ago) is not being built. */
export const buildingInSession = (root, feature, mf, now = Date.now()) =>
  (mf?.state === 'building' || (mf?.state === 'planned' && isSet(mf['go-ahead']))) && activeInSession(root, feature, now)

/** The executable `cmd` resolves to on `env.PATH` (or `cmd` itself when it is a path), or null. */
export function findOnPath(cmd, env = process.env) {
  const isExe = (f) => { try { return statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0 } catch { return false } }
  if (cmd.includes('/')) return isExe(cmd) ? cmd : null
  for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) if (isExe(join(dir, cmd))) return join(dir, cmd)
  return null
}

/**
 * Wait until `cmd` is on PATH again — a Claude Code auto-update swaps its binary out for a few
 * seconds, and an unattended run that starts in that window would fail the feature for nothing.
 * Resolves true when found, false after `timeoutMs`.
 */
export async function waitForCommand(cmd, { env = process.env, timeoutMs = 180000, everyMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let waited = 0; ; waited += everyMs) {
    if (findOnPath(cmd, env)) return true
    if (waited >= timeoutMs) return false
    await sleep(everyMs)
  }
}

/**
 * A run's stream-json `system/init` event without the builder plugin loaded → why, else null.
 * Claude Code documents that `--bare` "will become the default for -p", and bare mode skips plugin
 * hooks (the PR lock) and OAuth sign-in — a fleet run without builder would build with none of its
 * rules. Anything that isn't an init event, or an init event that names no plugins, is not judged.
 */
export function initWithoutBuilder(ev) {
  if (ev?.type !== 'system' || ev.subtype !== 'init' || !Array.isArray(ev.plugins)) return null
  if (ev.plugins.some((p) => p?.name === 'builder')) return null
  return 'the session started without the builder plugin loaded (bare mode, or the plugin is disabled for this repo) — its skills and the PR lock are missing, so the run was stopped. Check `claude plugin list`, and that agent_walk.claude_args has no --bare'
}

// ---- stage timing ---------------------------------------------------------------------------

/**
 * Each pipeline step ends in a commit with a known subject (advance.mjs PRESETS and the skills'
 * commit lines), so a feature's branch history is its timeline. Order matters: the first match wins.
 */
const STAGE_MARKS = [
  ['parked', /— parked:/],
  ['resumed', /unparked — was:|walk env restarted by the fleet/],
  ['audit', /\b(audited|aligned)$/],
  ['plan', /: plan [\w.-]+$|— go-ahead\b/],
  ['finalReview', /final[- ]review/i],
  ['endGates', /— (phases closed|built, walk readiness pending|built, awaiting the walk)\b|built here — not walked/],
  ['walk', /agent walk round \d+|agent signed off|\bsigned off\b|re-signed|walk found \d+ problems|re-walk after verify/],
  ['verify', /— verify (READY|INCOMPLETE)/],
  ['ship', / shipped (into|in PR)\b|— PR #\d+ open/],
]
const markOf = (subject) => STAGE_MARKS.find(([, re]) => re.test(subject))?.[0] ?? null
/** Where a plain commit (a task, a fix) falls, from the last mark before it. */
const PHASE_AFTER = { audit: 'plan', plan: 'build', finalReview: 'finalReview', endGates: 'walk', walk: 'walk', verify: 'verify', ship: 'ship' }

/**
 * A feature branch's commits, oldest first ({ t: epoch seconds, s: subject }) → wall-clock ms per
 * stage: audit, plan, build (the task commits), finalReview, endGates, walk (readiness, rounds,
 * sign-off — queueing included; walkQueue below splits it), verify, ship — and `parked`, the time
 * from a park to whatever came next, kept apart from the stage it interrupted. Also: walkRounds
 * (failed rounds committed), parks, startedAt, endGatesAt (ms, for the walk queue), lastAt.
 * Commits a stage didn't make leave its key out; nothing here is a guess.
 */
export function stagesFromCommits(commits) {
  const cs = (commits ?? []).filter((c) => c && Number.isFinite(c.t)).sort((a, b) => a.t - b.t)
  const out = { stages: {}, walkRounds: 0, parks: 0, startedAt: null, endGatesAt: null, lastAt: null }
  if (!cs.length) return out
  const add = (k, ms) => { if (ms > 0) out.stages[k] = (out.stages[k] ?? 0) + ms }
  let phase = 'audit'
  let parkedSince = null
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    const mark = markOf(c.s)
    const gap = i ? (c.t - cs[i - 1].t) * 1000 : 0
    if (parkedSince != null) add('parked', gap)
    else if (mark && !['parked', 'resumed'].includes(mark)) add(mark, gap)
    else if (mark !== 'resumed') add(phase, gap)
    if (mark === 'parked') { parkedSince = c.t; out.parks++; continue }
    parkedSince = null
    if (mark === 'resumed') continue
    if (mark === 'walk' && /agent walk round \d+/.test(c.s)) out.walkRounds++
    if (mark === 'endGates' && out.endGatesAt == null) out.endGatesAt = c.t * 1000
    if (mark) phase = PHASE_AFTER[mark] ?? phase
  }
  out.startedAt = cs[0].t * 1000
  out.lastAt = cs[cs.length - 1].t * 1000
  return out
}

/**
 * A walk workspace's round reports (`agent-walk/round-<n>/report.md`, agent-walk SKILL §report) and
 * walk.md → { checks, rounds: [{ n, pass, fail, unverifiable, verdict }] }. Read before /builder:ship
 * deletes the workspace, so the archive row keeps the size of the walk.
 */
export function walkFacts({ walkMd = null, reports = [] } = {}) {
  // walk.md's items are numbered lines, per app (`1. [risk] …`) and cross-app (`E1. …`), as walk-script.mjs writes them.
  const checks = walkMd == null ? null : (walkMd.match(/^E?\d+\.\s+\S/gm) ?? []).length
  const rounds = reports
    .filter((r) => r && typeof r.text === 'string')
    .map(({ n, text }) => {
      const rows = text.split('\n').filter((l) => /^\|\s*E?\d+\s*\|/.test(l))
      const count = (re) => rows.filter((l) => re.test(l)).length
      return { n, pass: count(/\|\s*PASS\s*\|/), fail: count(/\|\s*FAIL\s*\|/), unverifiable: count(/\|\s*UNVERIFIABLE\s*\|/), verdict: /^verdict:\s*(PASS|PROBLEMS)/m.exec(text)?.[1] ?? null }
    })
    .sort((a, b) => a.n - b.n)
  return { checks, rounds }
}

const STAGE_ORDER = ['audit', 'plan', 'build', 'finalReview', 'endGates', 'walk', 'verify', 'ship', 'merge', 'parked']
const STAGE_LABEL = { finalReview: 'final review', endGates: 'end gates' }
/**
 * Archive rows with `wallMs` → `3h32m start → merge (audit 7m · plan 31m · … · parked 10m)`: the
 * mean per feature, each stage's mean over the rows, so the parts add up to about the whole.
 */
export function wallSummary(rows) {
  const n = rows.length
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / n
  const total = mean(rows.map((r) => r.wallMs))
  const parts = STAGE_ORDER.map((k) => [k, mean(rows.map((r) => r.stages?.[k] ?? 0))]).filter(([, ms]) => ms >= 30000)
  return `${duration(total)} start → merge${parts.length ? ` (${parts.map(([k, ms]) => `${STAGE_LABEL[k] ?? k} ${duration(ms)}`).join(' · ')})` : ''}`
}
