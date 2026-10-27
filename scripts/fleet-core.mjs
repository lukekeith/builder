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

/**
 * Why two timed-out runs were killed, in the order they died: `killed` holds the fleet's kill line for
 * each (runClaude's `kill(why)`, carried on the row as `killedBy`) — the idle timeout, the run cap, or
 * a session that started without builder. Two kills with one cause say it once.
 */
function killCause(killed) {
  const why = (killed ?? []).filter(Boolean)
  if (!why.length) return ''
  if (why.length === 1) return ` — ${why[0]}`
  return new Set(why).size === 1 ? ` — both ${why[0]}` : ` — ${why.join(', then ')}`
}

/** What one finished `claude -p` run means for its feature. See the plan's Task 3 interface. */
export function decide({ lane, manifestText, specText = null, exit, failures, stalls = 0, runs, cap, progressed, folder = '<folder>', batched = false, killed = [] }) {
  // Shipped is done however the run ended — one that timed out after the ship commit must not be
  // retried into a second one.
  const shipped = manifestText == null ? shippedPr(specText) : null
  if (shipped) return { action: 'done', pr: shipped }
  const mf = manifestText == null ? null : parseManifest(manifestText)
  if (mf && laneOf(mf, { batched, specText }) === 'done') return { action: 'done', pr: mf.pr ?? null }
  if (exit !== 0) {
    const what = exit === null ? 'timed out' : `failed (exit ${exit})`
    return failures >= 1 ? { action: 'fail', reason: `run ${what} twice${exit === null ? killCause(killed) : ''}` } : { action: 'retry' }
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
 *  `a` must not take `a-b-01.log`. Its `.jsonl` stream transcripts are deleted instead of moved once
 *  its archive row is written — the row carries what was read from them, and they are most of the
 *  bytes (hundreds of MB across a few dozen landings). No row yet → they move with the rest.
 *  Null when done (or nothing to move); else a note. */
// ---- landings nobody has looked at yet --------------------------------------------------------
//
// The fleet runs detached: when a feature merges, no session hears it — the status line went back to
// nothing and the user came back to "idle" with no word of what landed. A landing stays "new" until
// /builder:fleet:status is opened (fleet.mjs --status writes SEEN); the status line and the session
// brief name every new one meanwhile.

const SEEN = 'seen'
const DAY_MS = 86400000

/** When /builder:fleet:status was last opened, as epoch ms — null when it never was. */
export function seenAt(root) {
  try {
    return statSync(join(fleetDir(root), SEEN)).mtimeMs
  } catch {
    return null
  }
}

/** /builder:fleet:status was opened: every landing so far has been seen. */
export function markSeen(root, now = new Date()) {
  try {
    mkdirSync(fleetDir(root), { recursive: true })
    writeFileSync(join(fleetDir(root), SEEN), `${now.toISOString()}\n`)
  } catch {}
}

/**
 * The landings since /builder:fleet:status was last opened, oldest first: { feature, merged, target,
 * landedAt, walked }. Never opened → the last day's, so a repo upgrading into this does not wake up
 * to its whole history. Reads the archive's tail only — the status line calls it on every render.
 */
export function newLandings(root, now = Date.now(), n = 20) {
  const since = seenAt(root) ?? now - DAY_MS
  return tailArchive(root, n)
    .filter((r) => r?.feature && Date.parse(r.landedAt ?? '') > since)
    .map((r) => ({ feature: r.feature, merged: r.merged ?? null, target: r.target ?? null, landedAt: r.landedAt, walked: Boolean(r.walk?.rounds?.length) }))
}

/** One brief line: `- ✔ x merged into main at 4eea9a2 (06:29) — agent-verified, not human-tested: test it yourself`. */
export function landingLine(l) {
  const at = new Date(l.landedAt)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const where = `${l.target ? ` into ${l.target}` : ''}${l.merged ? ` at ${String(l.merged).slice(0, 8)}` : ''}`
  return `- ✔ ${l.feature} merged${where} (${hhmm}) — ${l.walked ? 'agent-walked and verified' : 'agent-verified, no walk'}, not human-tested: test it yourself`
}

/** An archive row whose runs carry the meter (5.4+): its raw .jsonl streams have been read into it. */
const metered = (row) => Boolean(row?.timing?.some?.((t) => t?.meter))

export function archiveLogs(root, feature, keepDays = 30) {
  const logs = join(fleetDir(root), 'logs')
  if (!existsSync(logs)) return null
  const mine = new RegExp(`^${escapeRe(feature)}-(\\d+|setup|start|sync)\\.(log|jsonl)$`)
  const dest = join(logs, ARCHIVE, feature)
  try {
    const names = readdirSync(logs).filter((n) => mine.test(n))
    if (!names.length) return null
    // The raw stream goes only once the archive row holds what was read from it, and never when the
    // project keeps its logs forever (keep_logs: 0).
    const dropJsonl = keepDays > 0 && metered(tailArchive(root, 50).findLast((r) => r.feature === feature))
    mkdirSync(dest, { recursive: true })
    for (const n of names) {
      if (dropJsonl && n.endsWith('.jsonl')) rmSync(join(logs, n), { force: true })
      else renameSync(join(logs, n), join(dest, n))
    }
    return null
  } catch (e) {
    return `${feature} merged, but its logs could not be moved into ${dest}: ${e.message}`
  }
}

/** Archived log files older than `days` go, each by its own mtime (a folder's mtime moves whenever
 *  a later landing of the same name adds to it); `days` <= 0 keeps every one. A `.jsonl` transcript
 *  of a feature whose archive row carries the meter goes whatever its age — the row holds what was
 *  read from it; a row from before the meter keeps its transcripts to `days`, as the only
 *  per-dispatch record. An emptied folder goes too. Run at fleet start, /builder:archive and /builder:tidy apply.
 *  Best effort — the next run retries. → the number of files removed. */
export function pruneArchivedLogs(root, days, now = Date.now()) {
  const base = join(fleetDir(root), 'logs', ARCHIVE)
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return 0
  }
  const landed = landedRows(root)
  const stale = (p) => days > 0 && now - statSync(p).mtimeMs > days * 86400000
  let removed = 0
  const drop = (p) => {
    rmSync(p, { recursive: true, force: true })
    removed++
  }
  for (const n of names) {
    const dir = join(base, n)
    try {
      if (!statSync(dir).isDirectory()) {
        if (stale(dir)) drop(dir)
        continue
      }
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if ((days > 0 && f.endsWith('.jsonl') && metered(landed.get(n))) || stale(p)) drop(p)
      }
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true })
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

/**
 * A `result` event's usage as { input, output, cacheRead, cacheCreation, costUsd, byModel } — zeros
 * without one. 🔴 `usage` is the ORCHESTRATOR's thread only (the main session's own turns); sub-agents
 * are in `total_cost_usd` and in `modelUsage`, never in these token counts — so `costUsd` and
 * `byModel` cover the whole run while input/output/cacheRead/cacheCreation do not. Per-dispatch
 * tokens come from the run's stream (streamMeter).
 */
export function tokensOf(ev) {
  const u = ev?.usage ?? {}
  const byModel = {}
  for (const [model, m] of Object.entries(ev?.modelUsage ?? {})) {
    byModel[model] = { input: m.inputTokens ?? 0, output: m.outputTokens ?? 0, cacheRead: m.cacheReadInputTokens ?? 0, cacheCreation: m.cacheCreationInputTokens ?? 0, costUsd: m.costUSD ?? 0 }
  }
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0, costUsd: ev?.total_cost_usd ?? 0, byModel }
}

// ---- per-dispatch measurement --------------------------------------------------------------------
//
// Where a run's tokens went, per Agent dispatch, read from its stream as it streams — so it is
// recorded on the run's timing entry and survives into the archive row after the logs are pruned.
// "Context" is a turn's input + cache_read + cache_creation: what the model re-read that turn. A
// message streamed in chunks repeats one message.id; each field takes its max across the chunks.

/** A dispatch's kind from its Agent description — dispatch.mjs's templates first, then the words the skills use. */
export function dispatchKind(description) {
  const d = String(description ?? '').trim()
  // dispatch.mjs's own descriptions first, by their fixed openings — the task or feature name after
  // them ("Final review: checkout-fix", "Fix Task 2 round 1: re-review banner") never decides the kind.
  const fixed = [
    [/^implement task \d+\b/i, 'implement'],
    [/^fix task \d+ round \d+\b/i, 'fix'],
    [/^re-review\b/i, 're-review'],
    [/^review (?:task|phase) \d+\b/i, 'task-review'],
    [/^final review:/i, 'final-review'],
    [/^fix the final review'?s findings\b/i, 'final-fix'],
    [/^agent walk\b/i, 'walk'],
  ]
  for (const [re, kind] of fixed) if (re.test(d)) return kind
  // Then the words the skills use for the dispatches they word themselves.
  if (/\bre-?review\b/i.test(d)) return 're-review'
  if (/\bfinal\b.*\breview\b|\bwhole-branch\b/i.test(d)) return 'final-review'
  if (/\bfix\b/i.test(d)) return 'fix'
  if (/\breview\b/i.test(d)) return 'task-review'
  if (/\bimplement\b/i.test(d)) return 'implement'
  if (/\baudit\b/i.test(d)) return 'audit'
  if (/\balign\b/i.test(d)) return 'align'
  if (/\bplan\b|\bwriter\b|\btask blocks?\b/i.test(d)) return 'plan'
  if (/\bwalk\b/i.test(d)) return 'walk'
  if (/\bverif/i.test(d)) return 'verify'
  return 'other'
}

const TEST_RUN = /\b(pytest|jest|vitest|playwright|mocha|rspec|phpunit|go test|cargo test|node --test|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|e2e)\b)/

/**
 * An accumulator for one run's stream-json events: `add(ev)` per event, `summary()` at the end →
 * { orchestrator: { turns, startCtx, peakCtx, sumCtx }, dispatches: [{ kind, task, description,
 * model, agentType, turns, startCtx, peakCtx, sumCtx, testRuns, toolUses, ms }] } in dispatch order.
 * A sub-agent whose turns never streamed (some harness versions report a foreground child only in its
 * tool result) keeps its tool result's facts with turns/context null rather than zeros.
 */
export function streamMeter() {
  const msgs = new Map() // message.id → { parent, input, cacheRead, cacheCreation }
  const dispatches = new Map() // Agent tool_use id → its facts
  const tests = new Map() // parent → test-run count
  const add = (ev) => {
    if (!ev || typeof ev !== 'object') return
    const parent = ev.parent_tool_use_id ?? null
    if (ev.type === 'assistant' && ev.message) {
      const m = ev.message
      const u = m.usage ?? {}
      const id = m.id ?? `${parent}:${msgs.size}`
      const cur = msgs.get(id) ?? { parent, input: 0, cacheRead: 0, cacheCreation: 0 }
      cur.input = Math.max(cur.input, u.input_tokens ?? 0)
      cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens ?? 0)
      cur.cacheCreation = Math.max(cur.cacheCreation, u.cache_creation_input_tokens ?? 0)
      msgs.set(id, cur)
      for (const b of m.content ?? []) {
        if (b?.type !== 'tool_use') continue
        if (parent == null && (b.name === 'Agent' || b.name === 'Task') && !dispatches.has(b.id)) {
          const i = b.input ?? {}
          const task = /\bTask\s+(\d+)\b/i.exec(i.description ?? '')?.[1]
          dispatches.set(b.id, { kind: dispatchKind(i.description), task: task ? +task : null, description: String(i.description ?? '').slice(0, 120), model: i.model ?? null, agentType: i.subagent_type ?? null })
        }
        if (parent != null && b.name === 'Bash' && TEST_RUN.test(String(b.input?.command ?? ''))) tests.set(parent, (tests.get(parent) ?? 0) + 1)
      }
    }
    if (ev.type === 'user' && parent == null && ev.tool_use_result && typeof ev.tool_use_result === 'object') {
      const id = (ev.message?.content ?? []).find((c) => c?.type === 'tool_result')?.tool_use_id
      const d = id && dispatches.get(id)
      if (d) {
        const r = ev.tool_use_result
        d.model = r.resolvedModel ?? d.model
        d.agentType = r.agentType ?? d.agentType
        d.toolUses = r.totalToolUseCount ?? null
        d.ms = r.totalDurationMs ?? null
        d.lastCtx = r.totalTokens ?? null
      }
    }
  }
  const summary = () => {
    const groups = new Map()
    for (const m of msgs.values()) {
      const ctx = m.input + m.cacheRead + m.cacheCreation
      const g = groups.get(m.parent) ?? { turns: 0, startCtx: ctx, peakCtx: 0, sumCtx: 0 }
      g.turns += 1
      g.peakCtx = Math.max(g.peakCtx, ctx)
      g.sumCtx += ctx
      groups.set(m.parent, g)
    }
    const none = { turns: null, startCtx: null, peakCtx: null, sumCtx: null }
    return {
      orchestrator: groups.get(null) ?? { turns: 0, startCtx: 0, peakCtx: 0, sumCtx: 0 },
      dispatches: [...dispatches.entries()].map(([id, d]) => ({ ...d, ...(groups.get(id) ?? none), testRuns: tests.get(id) ?? 0 })),
    }
  }
  return { add, summary }
}

/**
 * A feature's timing entries → what its archive row says about where the tokens went: per dispatch
 * kind { n, turns, sumCtx, peakCtx, testRuns }, the orchestrators' { runs, turns, sumCtx, peakCtx }
 * and cost per model, summed across every run. Runs recorded before the meter existed add nothing.
 */
export function meterTotals(timing) {
  const byKind = {}
  const orchestrator = { runs: 0, turns: 0, sumCtx: 0, peakCtx: 0 }
  const costByModel = {}
  for (const t of timing ?? []) {
    for (const [model, m] of Object.entries(t.tokens?.byModel ?? {})) costByModel[model] = (costByModel[model] ?? 0) + (m.costUsd ?? 0)
    const s = t.meter
    if (!s) continue
    const w = 1 / (t.shared || 1) // a batch walk's session, charged to each feature it walked (chargeBatch)
    orchestrator.runs += w
    orchestrator.turns += (s.orchestrator?.turns ?? 0) * w
    orchestrator.sumCtx += (s.orchestrator?.sumCtx ?? 0) * w
    orchestrator.peakCtx = Math.max(orchestrator.peakCtx, s.orchestrator?.peakCtx ?? 0)
    for (const d of s.dispatches ?? []) {
      const k = (byKind[d.kind] ??= { n: 0, turns: 0, sumCtx: 0, peakCtx: 0, testRuns: 0 })
      k.n += w
      k.turns += (d.turns ?? 0) * w
      k.sumCtx += (d.sumCtx ?? 0) * w
      k.peakCtx = Math.max(k.peakCtx, d.peakCtx ?? 0)
      k.testRuns += (d.testRuns ?? 0) * w
    }
  }
  const round = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100 }
  round(orchestrator)
  for (const k of Object.values(byKind)) round(k)
  for (const m of Object.keys(costByModel)) costByModel[m] = Math.round(costByModel[m] * 100) / 100
  return { byKind, orchestrator, costByModel }
}

/**
 * The build's review facts from its workspace, for the archive row's quality line: the final
 * review's findings by severity (its `#### Critical` / `Important` / `Minor` lists, as
 * prompts/final-reviewer.md writes them), and the ledger's task-level fix rounds. Null without either file.
 */
export function reviewFacts({ finalReview = null, ledger = null } = {}) {
  if (finalReview == null && ledger == null) return null
  let findings = null
  if (finalReview != null) {
    findings = { critical: 0, important: 0, minor: 0 }
    let at = null
    for (const line of finalReview.split('\n')) {
      const h = /^#{2,4}\s+(Critical|Important|Minor)\b/i.exec(line)
      if (h) { at = h[1].toLowerCase(); continue }
      if (/^#{1,4}\s/.test(line)) { at = null; continue }
      if (at && /^(?:[-*]|\d+[.)])\s+\S/.test(line) && !/^(?:[-*]|\d+[.)])\s+\**none\b/i.test(line)) findings[at] += 1
    }
  }
  const fixRounds = ledger == null ? null : (ledger.match(/^.*\bfix round \d+\/5\b.*$/gim) ?? []).length
  return { finalFindings: findings, fixRounds }
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
  // Cost is the whole run's (every agent); per task divides it by the plan's task count. Token counts
  // are left out: a row's `tokens` is the orchestrators' own threads only (tokensOf).
  const usd = (v) => (v ? `$${v.toFixed(2)}` : null)
  const perTask = (r) => (r.costUsd && r.size?.tasks > 0 ? usd(r.costUsd / r.size.tasks) : null)
  const time = (r) => {
    const ms = Object.values(r.lanes ?? {}).reduce((a, b) => a + b, 0)
    return ms ? duration(ms) : null
  }
  const lines = [`# builder fleet — archive: latest ${rows.length} of ${Math.max(total, rows.length)}`, '', '| Feature | Tests | Time | Cost | Per task | Merged | PR | Landed |', '|---|---|---|---|---|---|---|---|']
  for (const r of [...rows].reverse()) lines.push(`| ${cell(r.feature)} | ${cell(rowLabel(r))} | ${cell(time(r))} | ${cell(usd(r.costUsd))} | ${cell(perTask(r))} | ${cell(r.merged)} | ${cell(r.pr)} | ${cell(r.landedAt ? ago(r.landedAt, now) : null)} |`)
  return lines.join('\n') + '\n'
}

// ---- progress ----------------------------------------------------------------------------------
//
// How far along the pipeline a feature is, as a percentage of STEPS — not of time. Each manifest
// state has a floor, and the three long stretches move inside their band by what the workspace
// (`.builder/<feature>/`, git-ignored) shows has been written so far:
//   plan   10 → 15  drafted `### Task` blocks (PLAN.md, or the per-app writers' plan-<app>.md) against
//                   the Phases table's task count;
//   build  15 → 70  each task an equal share: 0.2 once its brief is written, 0.7 once its report is,
//                   all of it once the ledger says `Task N: complete` — ticks land only after the
//                   reviews (a whole phase at once under review=app), so ticks alone stalled, then jumped;
//   walk   75 → 85  PASS/FAIL rows in the current agent-walk round's report against walk.md's items.
// The weights are a judgment of where the effort usually falls (a sixth before the build, more than
// half in it, the rest walk → verify → merge). Bands never overlap, so the number only goes back when
// the pipeline does (a new walk round after fixes starts its rows again).
const STAGE_FLOOR = { spec: 0, aligned: 5, audited: 10, planned: 15, building: 15, built: 75, 'signed-off': 87, verified: 92, shipped: 100 }
const PLAN_TOP = 15
const BUILD_TOP = 70
const WALK_TOP = 85
const PR_OPEN = 96
const BRIEF_SHARE = 0.2
const REPORT_SHARE = 0.7

const taskIds = (text, re) => new Set([...(text ?? '').matchAll(re)].map((m) => Number(m[1])))
const PLAN_TASK = /^#{2,4}\s+Task\s+(\d+)\b/gm

/** The number of tasks the `## Phases` table's Tasks column names (`1–3`, `4`, `5, 7`), or 0. */
export function phaseTaskCount(planText) {
  const at = (planText ?? '').search(/^## Phases\s*$/m)
  if (at < 0) return 0
  const rows = planText.slice(at).split('\n').slice(1)
  const table = []
  for (const l of rows) {
    if (/^## /.test(l)) break
    if (/^\s*\|/.test(l)) table.push(l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  }
  const col = (table[0] ?? []).findIndex((c) => /^tasks?$/i.test(c))
  if (col < 0) return 0
  const ids = new Set()
  for (const row of table.slice(1)) {
    for (const part of String(row[col] ?? '').split(/[,;]/)) {
      const m = /^\s*(\d+)\s*(?:[–—-]\s*(\d+))?\s*$/.exec(part)
      if (!m) continue
      const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])]
      for (let n = a; n <= b && n - a < 500; n++) ids.add(n)
    }
  }
  return ids.size
}

/**
 * `{ pct, label }` for one feature from what the fleet knows (its status) and what the worktree
 * says (manifest, plan, ledger — any may be null). `ws` is the feature's workspace as
 * `{ files, list(rel), read(rel) }` (readProgress builds it from disk; null when there is none).
 * Pure: every read goes through `ws`.
 */
export function featureProgress({ status, manifestText = null, planText = null, ledgerText = null, ws = null }) {
  if (status === 'done') return { pct: 100, label: 'merged' }
  if (manifestText == null) return { pct: 0, label: '—' }
  const mf = parseManifest(manifestText)
  const state = mf.state ?? ''
  const files = new Set(ws?.files ?? [])
  if (state === 'audited') {
    // Planning: the Phases table fixes the task count first, then the task blocks are drafted —
    // into PLAN.md by one writer, or into plan-<app>.md by one writer per app.
    const drafts = [...files].filter((n) => /^plan-.+\.md$/.test(n)).map((n) => ws.read(n) ?? '')
    const total = phaseTaskCount(planText) || Math.max(0, ...drafts.map(phaseTaskCount))
    if (total) {
      const drafted = Math.min(total, new Set([...taskIds(planText, PLAN_TASK), ...drafts.flatMap((t) => [...taskIds(t, PLAN_TASK)])]).size)
      return { pct: Math.round(STAGE_FLOOR.audited + ((PLAN_TOP - STAGE_FLOOR.audited) * drafted) / total), label: `plan ${drafted}/${total}` }
    }
  }
  // The build writes `state: building` at a phase close or a stop, not at its first task — so a
  // `planned` manifest whose ledger or workspace already shows tasks under way is a build in its first phase.
  if (state === 'building' || state === 'planned') {
    if (/^pending/.test(mf.ready ?? '')) return { pct: BUILD_TOP + 2, label: 'walk readiness' }
    const tasks = taskIds(planText, PLAN_TASK)
    const total = tasks.size
    const ticked = taskIds(ledgerText, /^\W*Task\s+(\d+):\s*complete\b/gm)
    let share = 0
    let done = 0
    for (const n of tasks) {
      if (ticked.has(n)) {
        share += 1
        done++
      } else if (files.has(`task-${n}-report.md`)) share += REPORT_SHARE
      else if (files.has(`task-${n}-brief.md`)) share += BRIEF_SHARE
    }
    if (state === 'planned' && !share) return { pct: STAGE_FLOOR.planned, label: 'planned' }
    if (!total) return { pct: STAGE_FLOOR.building, label: 'build' }
    return { pct: Math.round(STAGE_FLOOR.building + ((BUILD_TOP - STAGE_FLOOR.building) * share) / total), label: `build ${done}/${total}` }
  }
  if (state === 'built' && /^agent-pass|^pass/.test(mf.walk ?? '')) return { pct: WALK_TOP, label: 'walked' }
  if (state === 'built' && files.has('walk.md')) {
    // The agent walk: rows its current round has written so far, against walk.md's numbered items.
    const total = ((ws.read('walk.md') ?? '').match(/^E?\d+\.\s/gm) ?? []).length
    const rounds = (ws.list?.('agent-walk') ?? []).map((n) => Number(/^round-(\d+)$/.exec(n)?.[1])).filter(Boolean)
    const report = rounds.length ? ws.read(join('agent-walk', `round-${Math.max(...rounds)}`, 'report.md')) : null
    const rows = ((report ?? '').match(/^\s*\|.*\|\s*\**(PASS|FAIL)\**\s*\|/gim) ?? []).length
    if (total && report != null) return { pct: Math.round(STAGE_FLOOR.built + ((WALK_TOP - STAGE_FLOOR.built) * Math.min(rows, total)) / total), label: `walk ${Math.min(rows, total)}/${total}` }
  }
  if (state === 'verified' && isSet(mf.pr)) return { pct: PR_OPEN, label: 'PR open' }
  return { pct: STAGE_FLOOR[state] ?? 0, label: state || '—' }
}

const listDir = (d) => {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
const readIf = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** featureProgress fed from disk: `<base>/<registry>/<feature>/{MANIFEST,PLAN}.md`, the git-ignored
 *  ledger `<base>/.builder/<feature>/progress.md` and the workspace beside it (one readdir; a file
 *  is read only when its stage needs it). `base` is the worktree, or the repo root before one exists. */
export function readProgress(base, registry, feature, status) {
  const ws = join(base, '.builder', feature)
  return featureProgress({
    status,
    manifestText: readIf(join(base, registry, feature, 'MANIFEST.md')),
    planText: readIf(join(base, registry, feature, 'PLAN.md')),
    ledgerText: readIf(join(ws, 'progress.md')),
    ws: { files: listDir(ws), list: (rel) => listDir(join(ws, rel)), read: (rel) => readIf(join(ws, rel)) },
  })
}

/**
 * A fleet row's progress: read from its worktree, and remembered on the row (`lastProgress`, saved
 * with fleet.json) — so once the worktree is gone (a parked feature's is removed when the fleet
 * exits) the row keeps its last reading instead of falling back to the root checkout, which holds
 * only the spec and reads 0%. A reading of nothing (the ship run removed the manifest) keeps the
 * last one too. `root` is where a row with no worktree yet is read.
 */
export function rowProgress(root, registry, feature, f) {
  const live = Boolean(f.worktree) && existsSync(f.worktree)
  const last = f.lastProgress && typeof f.lastProgress.pct === 'number' ? f.lastProgress : null
  if (!live && last && f.status !== 'done') return last
  const p = readProgress(live ? f.worktree : root, registry, feature, f.status)
  if (p.label === '—' && last) return last
  if (live) f.lastProgress = p
  return p
}

// ---- what stopped, and what has gone quiet ---------------------------------------------------
//
// The fleet runs detached: nothing in a session is told when a feature parks. These are what the
// status line, the session brief, `--status` and fleet.out say about it.

const STOPPED = new Set(['parked', 'failed'])
const RUNNING = new Set(['building', 'walking', 'shipping'])

/**
 * The fleet's parked and failed rows as `[{ name, status, why, next }]`, by name. `why` drops a failed
 * row's ` — see <log>` (the log path is fleet.out's and PARKED.md's to give; a line has no room).
 */
export function fleetStops(fleet, { main = null, registry = null } = {}) {
  return Object.entries(fleet?.features ?? {})
    .filter(([, f]) => STOPPED.has(f?.status))
    .filter(([name, f]) => !main || !stopSettled(main, registry, name, f))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, f]) => {
      const { why, next } = parkParts(f.reason ?? '')
      return { name, status: f.status, why: why.replace(/\s—\ssee\s\S+$/, '').trim(), next: next ?? RETRY_NEXT }
    })
}

/**
 * A parked or failed row someone has since settled outside the fleet — its feature folder moved to
 * `<registry>/_archive/`, or its branch gone (merged and deleted by /builder:tidy, or by hand). Only a landing removes
 * a fleet.json row, so without this a settled park would sit on the status line and in every session
 * brief for good. File reads only: the status line runs this on every render.
 */
export function stopSettled(main, registry, name, f) {
  if (registry && existsSync(join(main, registry, '_archive', name)) && !existsSync(join(main, registry, name))) return true
  return Boolean(f?.branch) && !branchExists(main, f.branch)
}

/** Whether a local branch exists, from .git's refs and packed-refs — no git process. Unknown (no .git dir) → true. */
export function branchExists(main, branch) {
  const dir = join(main, '.git')
  try {
    if (!statSync(dir).isDirectory()) return true
  } catch {
    return true
  }
  if (existsSync(join(dir, 'refs', 'heads', ...String(branch).split('/')))) return true
  try {
    return readFileSync(join(dir, 'packed-refs'), 'utf8').split('\n').some((l) => l.endsWith(` refs/heads/${branch}`))
  } catch {
    return false
  }
}

/**
 * The block route() appends to fleet.out when a feature parks or fails — what stopped, why, the next
 * step, and where the park record is (PARKED.md, committed on the feature's branch, so it outlives
 * the worktree). `retry` names the automatic retry the fleet starts at once, when it does.
 */
export function parkBlock({ feature, status, reason, record = null, branch = null, log = null, retry = null, at = new Date() }) {
  const { why, next } = parkParts(reason ?? '')
  const stamp = `${at.toISOString().slice(0, 16).replace('T', ' ')}Z`
  return [
    '',
    `[${stamp}] ⛔ ${feature} ${status}`,
    `  why:    ${why || 'no reason recorded'}`,
    `  next:   ${next ?? RETRY_NEXT}`,
    ...(record ? [`  record: ${record}${branch ? ` (committed on ${branch})` : ''}`] : []),
    ...(log && !String(reason).includes(log) ? [`  log:    ${log}`] : []),
    ...(retry ? [`  the fleet retries it now — ${retry}`] : []),
    '',
  ].join('\n')
}

/** How long a running feature may go with no commit and no ledger tick before it is flagged. */
export const STALL_MS = 45 * 60 * 1000

/**
 * The mtime (ms) of a worktree's last HEAD move — its reflog, `<gitdir>/logs/HEAD`, which every
 * commit, reset and merge appends to — read through the `.git` file, so no git process is spawned
 * (the status line renders every couple of seconds). null when there is none to read.
 */
export function headMovedMs(worktree) {
  if (!worktree) return null
  try {
    const dotGit = join(worktree, '.git')
    const st = statSync(dotGit)
    const gitdir = st.isDirectory() ? dotGit : /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (!gitdir) return null
    const dir = gitdir.startsWith('/') ? gitdir : join(worktree, gitdir)
    for (const p of [join(dir, 'logs', 'HEAD'), join(dir, 'HEAD')]) {
      try {
        return statSync(p).mtimeMs
      } catch {}
    }
  } catch {}
  return null
}

const mtimeOf = (p) => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return null
  }
}

/**
 * A running row that has gone quiet: `{ runningMs, sinceMs }` when nothing has moved for STALL_MS —
 * not HEAD, not the ledger (`<wt>/.builder/<feature>/progress.md`), not the workspace (a brief or a
 * report added), not the newest agent-walk round (a screenshot or a report row), and the current run (`f.runStartedAt`) is older than that too. A run that keeps
 * printing but goes round in circles outlives the idle timeout; this is what catches it. Only stats.
 */
export function stallOf(feature, f, now = Date.now()) {
  if (!RUNNING.has(f?.status) || !f.worktree || !f.runStartedAt) return null
  const started = Date.parse(f.runStartedAt)
  if (!Number.isFinite(started)) return null
  const ws = join(f.worktree, '.builder', feature)
  // A walk commits nothing and ticks no ledger: its evidence lands in agent-walk/round-N/, whose
  // writes never touch the workspace folder's own mtime — so the newest round counts as movement.
  let round = null
  try {
    const last = readdirSync(join(ws, 'agent-walk')).filter((d) => /^round-\d+$/.test(d)).sort((a, b) => +a.slice(6) - +b.slice(6)).at(-1)
    if (last) round = Math.max(mtimeOf(join(ws, 'agent-walk', last)) ?? 0, mtimeOf(join(ws, 'agent-walk', last, 'report.md')) ?? 0)
  } catch {}
  const moved = [started, headMovedMs(f.worktree), mtimeOf(join(ws, 'progress.md')), mtimeOf(ws), round].filter((t) => Number.isFinite(t) && t > 0)
  const since = Math.max(...moved)
  return now - since >= STALL_MS ? { runningMs: now - started, sinceMs: since } : null
}

/** `⚠ <feature> running 1h10m with no commit or ledger tick since 14:05` — the clock is local. */
export function stallLine(feature, stall) {
  const at = new Date(stall.sinceMs)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `⚠ ${feature} running ${duration(stall.runningMs)} with no commit or ledger tick since ${hhmm}`
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
  /\bUPDATE\s+["'`\w.]+(\s+(AS\s+)?\w+)?\s+SET\b/i,
  /\b(drop_table|drop_column|drop_constraint|drop_index|rename_table|rename_column|alter_column|remove_column|remove_columns|remove_reference|remove_index|remove_timestamps|change_column|change_table|batch_alter_table|delete_all|update_all|destroy_all)\b/,
  /\b(dropTable|dropTableIfExists|dropColumn|dropColumns|renameColumn|renameTable|dropIndex|dropForeign|removeColumn|changeColumn|bulkDelete|bulkUpdate|removeConstraint|removeIndex|deleteMany|deleteOne|updateMany|dropCollection)\b/,
  /\.(alter|del|drop)\(\s*\)|\.(delete|update)\(/,
  /\bdelete\(\s*\w/,
  /\b(RemoveField|DeleteModel|RenameField|RenameModel|AlterField|RunPython|RunSQL)\b/,
]
/** Files that only ever run backwards: a down-only migration cannot drop anything going forward. */
const DOWN_ONLY = /\.down\.sql$|(^|\/)U\d+__[^/]*\.sql$|(^|\/)revert\//i
const KNOWN_KINDS = /\.(sql|py|rb|js|cjs|mjs|ts|cts|mts)$/i

/**
 * Whole-line comments and docstrings out, so a word in prose never reads as an operation. Strings
 * passed to a call stay: raw SQL lives in them (`op.execute("""DELETE …""")`).
 */
const stripComments = (path, text) => {
  let t = String(text ?? '')
  if (/\.(py|rb)$/i.test(path)) t = t.replace(/^\s*#.*$/gm, '')
  // A docstring — a triple-quoted string standing as a statement — is prose; one passed to a call
  // (`op.execute("""DELETE …""")`, even on its own line inside the parentheses) is SQL and stays.
  if (/\.py$/i.test(path)) t = t.replace(/("""|''')[\s\S]*?\1/g, (m, _q, at, all) => (/[(,=+]\s*$/.test(all.slice(0, at)) ? m : ''))
  if (/\.rb$/i.test(path)) t = t.replace(/^=begin[\s\S]*?^=end/gm, '')
  if (/\.(js|cjs|mjs|ts|cts|mts)$/i.test(path)) t = t.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '')
  if (/\.sql$/i.test(path)) t = t.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*--.*$/gm, '')
  return t
}

/** `text` with the span from `start` up to `end` (or the end of the file) taken out. */
const cutOut = (text, start, end) => {
  const i = text.search(start)
  if (i < 0) return text
  const rest = text.slice(i + 1)
  const j = rest.search(end)
  return text.slice(0, i) + (j < 0 ? '' : rest.slice(j))
}

/**
 * What `apply` runs: the file with only its backward half taken out — Alembic's `def downgrade(`
 * body, Rails' `def down`, Knex/TypeORM's `down`, the SQL after an exact down marker
 * (`-- migrate:down`, `-- +goose Down`, `-- +migrate Down`, a bare `-- down` line) — or null when the
 * file only runs backwards. Everything else stays, helpers `upgrade()` calls included: when unsure,
 * read more, not less.
 */
export function forwardHalf(path, text) {
  if (DOWN_ONLY.test(path)) return null
  const t = String(text ?? '')
  if (/\.py$/i.test(path)) return cutOut(t, /^def downgrade\s*\(/m, /^(def |class |@)/m)
  if (/\.rb$/i.test(path)) {
    const m = /^([ \t]*)def down\b/m.exec(t)
    if (!m) return t
    const ind = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return cutOut(t, /^[ \t]*def down\b/m, new RegExp(`^${ind}(def |end\\b)`, 'm'))
  }
  if (/\.(js|cjs|mjs|ts|cts|mts)$/i.test(path)) {
    const up = /exports\.up\b|export\s+(async\s+)?function\s+up\b|export\s+const\s+up\b|(public\s+)?async\s+up\s*\(|\bup\s*[:=]\s*(async\s*)?(function|\()/m
    const down = /exports\.down\b|export\s+(async\s+)?function\s+down\b|export\s+const\s+down\b|(public\s+)?async\s+down\s*\(|\bdown\s*[:=]\s*(async\s*)?(function|\()/m
    // From `down` to the next line at its own indentation — the end of its function (a `}` or the
    // next statement); a helper after it stays in.
    const m = down.exec(t)
    if (!m) return t
    const lineStart = t.lastIndexOf('\n', m.index) + 1
    // `down` partway along a line (`{ up: …, down: async () => {} }`): only the rest of that line goes.
    if (t.slice(lineStart, m.index).trim()) {
      const eol = t.indexOf('\n', m.index)
      return t.slice(0, m.index) + (eol < 0 ? '' : t.slice(eol))
    }
    const ind = /^[ \t]*/.exec(t.slice(lineStart))[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const after = t.slice(m.index)
    const nl = after.indexOf('\n')
    if (nl < 0) return t.slice(0, lineStart)
    const rest = after.slice(nl + 1)
    const end = new RegExp(`^${ind}\\S`, 'm').exec(rest)
    if (!end) return t.slice(0, lineStart)
    // A closing `}` / `})` / `};` at that indentation ends the function itself: drop it with the body.
    const close = /^[ \t]*[}\])][)};,]*\s*$/.exec(rest.slice(end.index).split('\n')[0])
    const resume = end.index + (close ? rest.slice(end.index).split('\n')[0].length : 0)
    return t.slice(0, lineStart) + rest.slice(resume)
  }
  if (/\.sql$/i.test(path)) return cutOut(t, /^--\s*(migrate:down|\+goose\s+down|\+migrate\s+down|down)\s*$/im, /^--\s*(migrate:up|\+goose\s+up|\+migrate\s+up|up)\s*$/im)
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
 * only) → the commands to run in order; otherwise a `note` naming what to run by hand. `pending` is
 * the database's own answer when §Walk readiness has a `pending:` command (exit 0 = nothing pending —
 * not `status:`, which many tools exit 0 from either way): false → no note, the dev DB already has
 * them; true → behind, or the command couldn't tell; null (no command, or not asked) → git only knows
 * the files landed, so the note says the DB *may* be behind (`kind: 'maybe'` — the caller asks then).
 */
export function landedMigrations({ files, readiness, pending = null }) {
  if (!files?.length) return { action: 'none' }
  const n = `${files.length} new migration${files.length === 1 ? '' : 's'}`
  const cmds = [readiness.apply, readiness.regenerate].filter(Boolean)
  const run = cmds.map((c) => `\`${c}\``).join(', then ')
  if (!readiness.apply) return { action: 'note', why: `${n} landed, but the config's §Walk readiness has no \`apply:\` command — apply them to the dev DB by hand` }
  const destructive = files.map((f) => [f.path, destructiveMigration(f)]).filter(([, why]) => why)
  if (destructive.length) return { action: 'note', why: `${n} landed and ${destructive.map(([p, why]) => `${p} (${why})`).join(', ')} may drop or rewrite data going forward, so nothing was applied — check it, then run ${run}` }
  if ((readiness.apply_mode ?? 'ask') !== 'agent') {
    if (pending === false) return { action: 'none', why: `${n} landed; \`${readiness.pending}\` says the dev DB already has them` }
    if (pending === true) return { action: 'note', why: `${n} landed — the dev DB is behind, or \`${readiness.pending}\` couldn't reach it: run ${run}` }
    return { action: 'note', kind: 'maybe', why: `${n} landed — the dev DB may be behind: if it lacks them, run ${run}` }
  }
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
/**
 * A subject is a stage mark only when it is builder's own for this feature — the feature named right
 * after the colon (`docs(KEY): <feature> audited`, `docs(KEY): plan <feature>`), the fleet's own
 * `chore(<feature>): unparked …` lines — or the final review's fix commit, which names none. A task
 * commit (`feat(KEY): keep labels right-aligned`) is a task, whatever words it ends in.
 */
const markOf = (subject, feature = null) => {
  const f = feature?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const own = !feature || new RegExp(`\\): (plan )?${f}( |$)|^chore\\(${f}\\): (unparked|walk env restarted|built here|build here)`).test(subject) || /^fix\([^)]*\): final review findings$/.test(subject)
  return own ? (STAGE_MARKS.find(([, re]) => re.test(subject))?.[0] ?? null) : null
}
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
export function stagesFromCommits(commits, feature = null) {
  const cs = (commits ?? []).filter((c) => c && Number.isFinite(c.t)).sort((a, b) => a.t - b.t)
  const out = { stages: {}, walkRounds: 0, parks: 0, startedAt: null, endGatesAt: null, lastAt: null }
  if (!cs.length) return out
  const add = (k, ms) => { if (ms > 0) out.stages[k] = (out.stages[k] ?? 0) + ms }
  let phase = 'audit'
  let parkedSince = null
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    const mark = markOf(c.s, feature)
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
