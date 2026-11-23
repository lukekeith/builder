/**
 * test-cost — where a repo's test time goes, from what builder already records (spec
 * docs/specs/2026-11-23-test-efficiency-bench-design.md §E0). Pure: the CLI (test-cost.mjs) reads the
 * files and hands the parsed rows in.
 *
 * Two sources:
 *  - verifier requests (.builder/verify/requests/*.json) — each run's tier, sha, verdict and time;
 *  - fleet streams (.builder/fleet/logs/**\/*.jsonl) — each tool call, timed tool_use → tool_result,
 *    attributed to the orchestrator or to the agent it dispatched.
 *
 * The four KPIs: verification share (time a run spent blocked on the verifier or a gate job, of its
 * wall time), no-verdict minutes (verifier runs that ended env-broken or cancelled), duplicate
 * minutes (a run of a sha the verifier was already running, or had already judged green) and retry
 * minutes (a run of a sha whose last run was env-broken, under unchanged code).
 */

const ms = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : 0)

/** A run's identity: the code it judged. A merge tier judges the branch merged onto the target, so the target's sha is part of it. */
const keyOf = (r) => (r.tier === 'merge' ? `merge:${r.sha}:${r.verdict?.targetSha ?? r.verdict?.base ?? '?'}` : `branch:${r.sha}`)

/**
 * Each verifier run that started, classified once:
 *  'concurrent'  — another run of the same code was running when it started;
 *  'repeat-green'— the same code had already been judged green;
 *  'retry'       — the same code's last run ended env-broken or cancelled;
 *  'repeat-red'  — the same code had already been judged red;
 *  'first'       — none of these.
 */
export function classifyRuns(requests) {
  const ran = requests.filter((r) => r.startedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const out = []
  for (const r of ran) {
    const k = keyOf(r)
    const before = out.filter((q) => q.key === k)
    const live = before.find((q) => !q.doneAt || q.doneAt > r.startedAt)
    const ended = before.filter((q) => q.doneAt && q.doneAt <= r.startedAt).at(-1)
    const kind = live ? 'concurrent' : !ended ? 'first' : ended.status === 'green' ? 'repeat-green' : ended.status === 'red' ? 'repeat-red' : 'retry'
    out.push({
      id: r.id, key: k, tier: r.tier, branch: r.branch, sha: r.sha, startedAt: r.startedAt, doneAt: r.doneAt ?? null,
      status: r.verdict?.status ?? (r.state === 'running' ? 'running' : r.state), kind,
      queuedMs: ms(r.createdAt, r.startedAt), runMs: r.verdict?.ms ?? ms(r.startedAt, r.doneAt),
      suites: r.verdict?.selection ?? {}, broken: (r.verdict?.broken ?? []).map((b) => `${b.suite}: ${b.reason}`),
    })
  }
  return out
}

const add = (o, k, v) => {
  o[k] ??= { n: 0, ms: 0 }
  o[k].n++
  o[k].ms += v
}

/** The verifier's side: time by tier, verdict and kind, and per suite where the verdict records it. */
export function verifierCost(requests) {
  const runs = classifyRuns(requests)
  const byTier = {}, byStatus = {}, byKind = {}, suites = {}
  let runMs = 0, queuedMs = 0
  for (const r of runs) {
    runMs += r.runMs
    queuedMs += r.queuedMs
    add(byTier, r.tier, r.runMs)
    add(byStatus, r.status, r.runMs)
    add(byKind, r.kind, r.runMs)
    for (const [name, s] of Object.entries(r.suites)) {
      if (typeof s.ms !== 'number') continue // a verdict from before suites were timed
      suites[name] ??= { n: 0, ms: 0, judgeMs: 0, timedOut: 0, files: 0 }
      const x = suites[name]
      x.n++
      x.ms += s.ms
      x.judgeMs += s.judgeMs ?? 0
      if (s.outcome === 'timed-out') x.timedOut++
      if (typeof s.files === 'number') x.files += s.files
    }
  }
  const sum = (o, ks) => ks.reduce((a, k) => a + (o[k]?.ms ?? 0), 0)
  return {
    runs, runMs, queuedMs, byTier, byStatus, byKind, suites,
    noVerdictMs: sum(byStatus, ['env-broken', 'cancelled']),
    duplicateMs: sum(byKind, ['concurrent', 'repeat-green']),
    retryMs: sum(byKind, ['retry']),
  }
}

/** What a shell command is, for the time it took. Order matters: a test run piped through cap.mjs is a test run. */
export function classifyCommand(cmd) {
  const c = String(cmd)
  if (/verify\.mjs["']?\s+(wait|run)\b|verify-quick\.mjs/.test(c)) return 'verifier-wait'
  if (/job\.mjs["']?\s+wait\b/.test(c)) return 'gate-wait'
  if (/\bplaywright\b/.test(c)) return 'test:e2e'
  if (/node\b[^|;&]*\s--test\b|\bnpm (run )?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo test\b|\bcargo test\b/.test(c)) {
    // broad: a glob, a directory or a whole-suite script — more than the files the task touched
    return /\*|\bnpm (run )?test\b|--test\s*(["']?\s*$|[|;&])/.test(c) ? 'test:broad' : 'test:targeted'
  }
  if (/\btsc\b|typecheck|\beslint\b|\blint\b/.test(c)) return 'typecheck'
  return 'other'
}

const roleOf = (description) => {
  const d = String(description ?? '')
  if (/re-?review|review/i.test(d)) return 'reviewer'
  if (/walk/i.test(d)) return 'walker'
  if (/fix/i.test(d)) return 'fixer'
  if (/audit/i.test(d)) return 'auditor'
  return 'implementer'
}

/**
 * One fleet stream (the lines of a <feature>-NN.jsonl, parsed) → its wall time, and Bash and Agent
 * time by role and class. A call with no result (the run was killed) is not counted.
 */
export function streamCost(events) {
  const uses = new Map(), agents = new Map()
  let first = null, last = null
  const byRole = {}, agentMs = {}
  let waitMs = 0
  for (const x of events) {
    const ts = x?.timestamp
    if (ts) {
      first ??= ts
      last = ts
    }
    const content = x?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        uses.set(b.id, { name: b.name, input: b.input ?? {}, ts, parent: x.parent_tool_use_id ?? null })
        if (b.name === 'Agent' || b.name === 'Task') agents.set(b.id, b.input?.description ?? '')
      } else if (b.type === 'tool_result' && uses.has(b.tool_use_id) && ts) {
        const u = uses.get(b.tool_use_id)
        const d = ms(u.ts, ts)
        if (u.name === 'Agent' || u.name === 'Task') {
          if (!u.parent) add(agentMs, roleOf(u.input.description), d)
          continue
        }
        if (u.name !== 'Bash') continue
        const role = u.parent ? roleOf(agents.get(u.parent)) : 'orchestrator'
        const cls = classifyCommand(u.input.command)
        add((byRole[role] ??= {}), cls, d)
        if (role === 'orchestrator' && (cls === 'verifier-wait' || cls === 'gate-wait')) waitMs += d
      }
    }
  }
  return { start: first, end: last, wallMs: ms(first, last), waitMs, agentMs, byRole }
}

/** Streams grouped by feature → per-feature totals and the fleet-wide verification share. */
export function fleetCost(streams) {
  const features = {}
  for (const { feature, run, events } of streams) {
    const c = streamCost(events)
    const f = (features[feature] ??= { runs: 0, wallMs: 0, waitMs: 0, agentMs: {}, byRole: {} })
    f.runs++
    f.wallMs += c.wallMs
    f.waitMs += c.waitMs
    for (const [k, v] of Object.entries(c.agentMs)) (f.agentMs[k] ??= { n: 0, ms: 0 }), (f.agentMs[k].n += v.n), (f.agentMs[k].ms += v.ms)
    for (const [role, classes] of Object.entries(c.byRole))
      for (const [k, v] of Object.entries(classes)) {
        const o = ((f.byRole[role] ??= {})[k] ??= { n: 0, ms: 0 })
        o.n += v.n
        o.ms += v.ms
      }
    f.lastRun = run
  }
  let wall = 0, wait = 0
  for (const f of Object.values(features)) (wall += f.wallMs), (wait += f.waitMs)
  return { features, wallMs: wall, waitMs: wait, share: wall ? wait / wall : null }
}

const min = (v) => (v / 60000).toFixed(1)
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')

/** The report, as Markdown. */
export function renderCost({ verifier, fleet, since }) {
  const L = [`# Test cost${since ? ` since ${since}` : ''}`, '']
  L.push('## KPIs', '', '| KPI | Value |', '|---|---|')
  L.push(`| Verification share (orchestrator blocked on the verifier or a gate, of run wall time) | ${fleet.share == null ? '—' : pct(fleet.waitMs, fleet.wallMs)} (${min(fleet.waitMs)} of ${min(fleet.wallMs)} min) |`)
  L.push(`| No-verdict minutes (env-broken or cancelled runs) | ${min(verifier.noVerdictMs)} min · ${pct(verifier.noVerdictMs, verifier.runMs)} of verifier time |`)
  L.push(`| Duplicate minutes (same code already running or green) | ${min(verifier.duplicateMs)} min · ${pct(verifier.duplicateMs, verifier.runMs)} |`)
  L.push(`| Retry minutes (same code, last run env-broken) | ${min(verifier.retryMs)} min · ${pct(verifier.retryMs, verifier.runMs)} |`)
  L.push(`| Verifier run time · queued time | ${min(verifier.runMs)} min · ${min(verifier.queuedMs)} min over ${verifier.runs.length} runs |`, '')

  const table = (title, o) => {
    const rows = Object.entries(o).sort((a, b) => b[1].ms - a[1].ms)
    if (!rows.length) return
    L.push(`### ${title}`, '', '| | Runs | Minutes |', '|---|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v.n} | ${min(v.ms)} |`), '')
  }
  L.push('## Verifier', '')
  table('By tier', verifier.byTier)
  table('By verdict', verifier.byStatus)
  table('By kind', verifier.byKind)
  const suites = Object.entries(verifier.suites).sort((a, b) => b[1].ms - a[1].ms)
  if (suites.length) {
    L.push('### By suite (runs whose verdict times each suite)', '', '| Suite | Runs | Run min | Judging min | Timed out | Files run |', '|---|---|---|---|---|---|')
    for (const [k, v] of suites) L.push(`| ${k} | ${v.n} | ${min(v.ms)} | ${min(v.judgeMs)} | ${v.timedOut} | ${v.files} |`)
    L.push('')
  }
  L.push('### Runs', '', '| Started | Branch | Tier | Verdict | Kind | Queued | Run | Broken |', '|---|---|---|---|---|---|---|---|')
  for (const r of verifier.runs) L.push(`| ${r.startedAt.slice(0, 16)} | ${r.branch ?? ''} | ${r.tier} | ${r.status} | ${r.kind} | ${min(r.queuedMs)}m | ${min(r.runMs)}m | ${r.broken.join('; ').slice(0, 90)} |`)
  L.push('')

  L.push('## Fleet runs', '', '| Feature | Runs | Wall | Blocked on verifier/gates | Agents | Agent test runs (broad · targeted) |', '|---|---|---|---|---|---|')
  for (const [name, f] of Object.entries(fleet.features).sort((a, b) => b[1].wallMs - a[1].wallMs)) {
    const agents = Object.entries(f.agentMs).map(([k, v]) => `${k} ${min(v.ms)}m`).join(' · ')
    const tests = (cls) => Object.entries(f.byRole).filter(([r]) => r !== 'orchestrator').reduce((a, [, c]) => a + (c[cls]?.ms ?? 0), 0)
    L.push(`| ${name} | ${f.runs} | ${min(f.wallMs)}m | ${min(f.waitMs)}m (${pct(f.waitMs, f.wallMs)}) | ${agents || '—'} | ${min(tests('test:broad'))}m · ${min(tests('test:targeted'))}m |`)
  }
  L.push('')
  return L.join('\n')
}
