/**
 * The benchmark's meaning, free of processes and files: a stream → its steps and totals; a set
 * of runs → the report. bench.mjs does the side effects.
 */
import { duration, formatTokens, tokensOf } from './fleet-core.mjs'

export const STEP_TOOL = 'Skill'
export const AGENT_TOOLS = new Set(['Agent', 'Task'])
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'])
const TEST_RE = /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bpytest\b|\bplaywright\s+test\b/

const ms = (iso) => (iso ? Date.parse(iso) : NaN)

/** One stream-json file → { sessionId, model, result, events }. Non-JSON lines are skipped. */
export function parseStream(text) {
  const out = { sessionId: null, model: null, result: null, plugins: [], events: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object' || !ev.type) continue
    out.sessionId ??= ev.session_id ?? null
    out.model ??= ev.model ?? ev.message?.model ?? null
    if (ev.type === 'result') out.result = ev
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.plugins) && !out.plugins.length) out.plugins = ev.plugins
    const parent = ev.parent_tool_use_id ?? null
    const blocks = []
    for (const b of ev.message?.content ?? []) {
      if (b?.type === 'tool_use') blocks.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
      else if (b?.type === 'text') blocks.push({ kind: 'text', text: b.text ?? '' })
      else if (b?.type === 'tool_result') blocks.push({ kind: 'tool_result', id: b.tool_use_id })
    }
    out.events.push({ t: ms(ev.timestamp), type: ev.type, top: parent == null, parent, blocks })
  }
  return out
}

const firstLine = (s) => String(s ?? '').split('\n')[0].trim().slice(0, 80)

/** What a tool call did, in a few words — the label a gap or a file list uses. */
export function describeCall(b) {
  const i = b.input ?? {}
  if (b.name === STEP_TOOL) return `Skill ${i.skill ?? ''}`.trim()
  if (b.name === 'Bash') return `Bash ${firstLine(i.command)}`
  if (FILE_TOOLS.has(b.name)) return `${b.name} ${i.file_path ?? i.notebook_path ?? ''}`.trim()
  if (AGENT_TOOLS.has(b.name)) return `${b.name} ${i.subagent_type ?? ''} ${firstLine(i.description ?? i.prompt)}`.trim()
  return b.name
}

function emptyStep(name, start) {
  return { name, start, end: start, ms: 0, turns: 0, toolCalls: {}, files: [], commands: [], tests: [], subagents: [], gaps: [] }
}

/** The last timestamp in the stream — the result's when there is one. */
export function endOf(parsed) {
  const ts = parsed.events.map((e) => e.t).filter(Number.isFinite)
  return ts.length ? Math.max(...ts) : NaN
}

/**
 * Steps: one opens on each top-level Skill call and closes on the next, or at the end. Time before
 * the first is `(prompt)`; a session with no Skill call is one step named after its slash command, else its first line.
 */
export function deriveSteps(parsed, { prompt, root = null }) {
  const rel = (p) => {
    if (!root) return p
    for (const r of [root, `/private${root}`]) if (p.startsWith(`${r}/`)) return p.slice(r.length + 1)
    return p
  }
  // a slash command invokes its skill with no Skill tool call: the step is named after the command
  const command = String(prompt ?? '').startsWith('/') ? String(prompt).split(/\s/)[0] : null
  const events = parsed.events.filter((e) => Number.isFinite(e.t))
  if (!events.length) return []
  const t0 = events[0].t
  const end = endOf(parsed)
  const steps = []
  let cur = null
  let lastEvent = null
  const open = (name, at) => {
    if (cur) cur.end = at
    cur = emptyStep(name, at)
    steps.push(cur)
  }
  for (const e of events) {
    // The wait that ends at this event belongs to the step that was running during it — so it is
    // recorded before a Skill call in this event opens the next step.
    if (cur && lastEvent && e.t - lastEvent.t > 0) cur.gaps.push({ ms: e.t - lastEvent.t, after: lastEvent.label })
    const skill = e.top ? e.blocks.find((b) => b.kind === 'tool_use' && b.name === STEP_TOOL) : null
    if (skill) open(skill.input.skill ?? 'Skill', e.t)
    else if (!cur) open('(prompt)', t0)
    if (e.type === 'assistant' && e.top) cur.turns++
    let label = lastEvent?.label ?? '(start)'
    for (const b of e.blocks) {
      if (b.kind !== 'tool_use') continue
      cur.toolCalls[b.name] = (cur.toolCalls[b.name] ?? 0) + 1
      const i = b.input
      if (FILE_TOOLS.has(b.name) && i.file_path && !cur.files.includes(rel(i.file_path))) cur.files.push(rel(i.file_path))
      if (b.name === 'Bash' && i.command) {
        const c = firstLine(i.command)
        cur.commands.push(c)
        if (TEST_RE.test(String(i.command).split('\n')[0])) cur.tests.push(c)
      }
      if (AGENT_TOOLS.has(b.name)) cur.subagents.push({ type: i.subagent_type ?? 'agent', first: firstLine(i.description ?? i.prompt) })
      label = describeCall(b)
    }
    lastEvent = { t: e.t, label }
  }
  cur.end = end
  if (steps.length > 1 && steps[0].name === '(prompt)' && steps[0].end === steps[0].start) steps.shift()
  if (steps[0]?.name === '(prompt)') {
    if (command) steps[0].name = command
    else if (steps.length === 1) steps[0].name = firstLine(prompt)
  }
  for (const s of steps) {
    s.ms = s.end - s.start
    s.gaps = s.gaps.sort((a, b) => b.ms - a.ms).slice(0, 5)
  }
  return steps
}

/** Duration, turns, tokens and cost — the result event's when the session ended with one. */
export function sessionTotals(parsed) {
  const r = parsed.result
  const events = parsed.events.filter((e) => Number.isFinite(e.t))
  const wall = events.length ? endOf(parsed) - events[0].t : 0
  if (r) {
    const tk = tokensOf(r)
    return { ms: Math.max(r.duration_ms ?? 0, wall), turns: r.num_turns ?? 0, tokens: { input: tk.input, output: tk.output, cacheRead: tk.cacheRead }, costUsd: tk.costUsd, ended: 'result' }
  }
  return { ms: wall, turns: events.filter((e) => e.type === 'assistant' && e.top).length, tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0, ended: 'cut' }
}

// ---- the time split: orchestrator / agents / tools ------------------------------------------------

/**
 * Every tool call in the stream as an interval: from its tool_use event to its tool_result's (a call
 * with no result ran to the end of the stream). `Agent`/`Task` calls are `agents`, every other tool `tools`.
 */
export function callIntervals(parsed) {
  const end = endOf(parsed)
  const calls = []
  const byId = new Map()
  for (const e of parsed.events) {
    if (!Number.isFinite(e.t)) continue
    for (const b of e.blocks) {
      if (b.kind === 'tool_use' && b.id && !byId.has(b.id)) {
        const c = { kind: AGENT_TOOLS.has(b.name) ? 'agents' : 'tools', start: e.t, end: NaN }
        byId.set(b.id, c)
        calls.push(c)
      } else if (b.kind === 'tool_result' && byId.has(b.id) && !Number.isFinite(byId.get(b.id).end)) byId.get(b.id).end = Math.max(e.t, byId.get(b.id).start)
    }
  }
  for (const c of calls) if (!Number.isFinite(c.end)) c.end = Math.max(end, c.start)
  return calls
}

/** The length of the union of intervals, clipped to [from, to]. */
function unionMs(intervals, from, to) {
  const a = intervals.map((i) => [Math.max(i.start, from), Math.min(i.end, to)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0])
  let total = 0
  let cs = -Infinity
  let ce = -Infinity
  for (const [s, e] of a) {
    if (s > ce) {
      if (ce > cs) total += ce - cs
      cs = s
      ce = e
    } else ce = Math.max(ce, e)
  }
  if (ce > cs) total += ce - cs
  return total
}

/**
 * The window [from, to] split three ways: agents (inside an Agent/Task call), tools (inside any other
 * call, and not inside an agent's), orchestrator (the rest). Parallel calls count once.
 */
export function splitOf(intervals, from, to) {
  const ms = Math.max(0, to - from)
  if (!ms) return { ms: 0, orchestrator: 0, agents: 0, tools: 0 }
  const agents = unionMs(intervals.filter((i) => i.kind === 'agents'), from, to)
  const busy = unionMs(intervals, from, to)
  return { ms, orchestrator: Math.max(0, ms - busy), agents, tools: busy - agents }
}

/** Puts `split` on a session record and on each of its steps (by their start/end), from its parsed stream. */
export function attachSplits(session, parsed) {
  const iv = callIntervals(parsed)
  const ts = parsed.events.map((e) => e.t).filter(Number.isFinite)
  if (!ts.length) return session
  session.split = splitOf(iv, Math.min(...ts), endOf(parsed))
  for (const st of session.steps ?? []) if (Number.isFinite(st.start) && Number.isFinite(st.end)) st.split = splitOf(iv, st.start, st.end)
  return session
}

/** Splits added up. */
export function addSplits(splits) {
  const t = { ms: 0, orchestrator: 0, agents: 0, tools: 0 }
  for (const s of splits) for (const k of Object.keys(t)) t[k] += s?.[k] ?? 0
  return t
}

export { duration, formatTokens }

/** `# pass N` / `# fail N` from node --test's TAP reporter. */
export function parseTap(text) {
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(text ?? '')?.[1] ?? 0)
  const passed = n('pass')
  const failed = n('fail')
  return { passed, failed, total: passed + failed }
}

export function runTotals(sessions) {
  const t = { ms: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0 }
  for (const s of sessions) {
    const x = s.totals ?? {}
    t.ms += x.ms ?? 0
    t.turns += x.turns ?? 0
    t.tokens.input += x.tokens?.input ?? 0
    t.tokens.output += x.tokens?.output ?? 0
    t.tokens.cacheRead += x.tokens?.cacheRead ?? 0
    t.costUsd += x.costUsd ?? 0
  }
  const splits = sessions.map((s) => s.split).filter(Boolean)
  if (splits.length) t.split = addSplits(splits)
  return t
}

export function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return NaN
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

export const OVERLAP_FLAG = 'sessions overlapped (a session waited on a fleet it launched): per-step times are not additive'
export const IN_CHAT_FLAG = 'built in chat (sized xs/sm) — not the pipeline; resize the feature'

/** Every step of a run, by name, with its time — the same name twice (two fleet runs both auditing) adds up. */
export function stepTimes(run) {
  const out = {}
  for (const s of run.sessions ?? []) for (const st of s.steps ?? []) out[st.name] = (out[st.name] ?? 0) + st.ms
  return out
}

/** Every step of a run, by name, with its turns — summed like stepTimes. */
export function stepTurns(run) {
  const out = {}
  for (const s of run.sessions ?? []) for (const st of s.steps ?? []) out[st.name] = (out[st.name] ?? 0) + (st.turns ?? 0)
  return out
}

/** [min, max] of the finite values, or null when there are fewer than two. */
export function range(nums) {
  const a = nums.filter(Number.isFinite)
  return a.length > 1 ? [Math.min(...a), Math.max(...a)] : null
}

/** One row per config: medians over its reps. Status is a not-done rep's status (`done` when every rep is done). */
export function summarize(runs) {
  const byConfig = new Map()
  for (const r of runs) (byConfig.get(r.config) ?? byConfig.set(r.config, []).get(r.config)).push(r)
  const rows = []
  for (const [config, reps] of byConfig) {
    const med = (f) => median(reps.map(f))
    // Scores and steps are medians over the reps that have them — a rep without one is left out, never counted as zero.
    const timesOf = new Map(reps.map((r) => [r, stepTimes(r)]))
    const stepNames = [...new Set([...timesOf.values()].flatMap((t) => Object.keys(t)))]
    const steps = Object.fromEntries(
      stepNames.map((n) => [n, median(reps.filter((r) => n in timesOf.get(r)).map((r) => timesOf.get(r)[n]))]),
    )
    const stepRange = Object.fromEntries(stepNames.map((n) => [n, range(reps.filter((r) => n in timesOf.get(r)).map((r) => timesOf.get(r)[n]))]))
    const turnsOf = new Map(reps.map((r) => [r, stepTurns(r)]))
    const stepTurnsMed = Object.fromEntries(stepNames.map((n) => [n, median(reps.filter((r) => n in turnsOf.get(r)).map((r) => turnsOf.get(r)[n]))]))
    const longest = Object.entries(steps).sort((a, b) => b[1] - a[1])[0]
    const splits = reps.map((r) => r.totals?.split).filter(Boolean)
    const scored = (k) => {
      const have = reps.filter((r) => r.score?.[k])
      return have.length ? { passed: median(have.map((r) => r.score[k].passed)), total: median(have.map((r) => r.score[k].total)) } : null
    }
    rows.push({
      config,
      n: reps.length,
      status: reps.find((r) => r.status !== 'done')?.status ?? 'done',
      ms: med((r) => r.ms),
      turns: med((r) => r.totals?.turns),
      tokens: med((r) => (r.totals?.tokens?.input ?? 0) + (r.totals?.tokens?.output ?? 0)),
      costUsd: med((r) => r.totals?.costUsd),
      accept: scored('accept'),
      fixture: scored('fixture'),
      longest: longest ? { name: longest[0], ms: longest[1] } : null,
      steps,
      stepRange,
      stepTurns: stepTurnsMed,
      range: {
        ms: range(reps.map((r) => r.ms)),
        turns: range(reps.map((r) => r.totals?.turns)),
        tokens: range(reps.map((r) => (r.totals ? (r.totals.tokens?.input ?? 0) + (r.totals.tokens?.output ?? 0) : NaN))),
        costUsd: range(reps.map((r) => r.totals?.costUsd)),
      },
      split: splits.length ? Object.fromEntries(['ms', 'orchestrator', 'agents', 'tools'].map((k) => [k, median(splits.map((x) => x[k]))])) : null,
      flagged: [reps.some((r) => r.path === 'in-chat') ? IN_CHAT_FLAG : null, reps.some(overlapped) ? OVERLAP_FLAG : null].filter(Boolean).join(' · ') || null,
    })
  }
  return rows
}

/** True when a run's sessions, summed, outlast its wall time by >10% — one waited on a fleet it launched. */
export const overlapped = (run) => (run.sessions ?? []).reduce((a, x) => a + (x.totals?.ms ?? 0), 0) > (run.ms ?? 0) * 1.1 && (run.ms ?? 0) > 0
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : '—')
const dur = (n) => (Number.isFinite(n) ? duration(n) : '—')
const score = (s) => (s ? `${Math.round(s.passed)}/${Math.round(s.total)}` : '—')
const cell = (s) => String(s ?? '—').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')
/** `median (min–max)`, or just the median when the reps agree (as formatted) or there is one. */
const spread = (med, rg, f) => {
  const m = f(med)
  if (!rg) return m
  const [lo, hi] = [f(rg[0]), f(rg[1])]
  return lo === hi ? m : `${m} (${lo}–${hi})`
}
const minutes = (n) => `${(n / 60000).toFixed(1)}m`
const pct = (n, of) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—')
/** `6.0m 60% · 3.0m 30% · 1.0m 10%` — orchestrator · agents · tools, each with its share of the span. */
export const splitCell = (sp) => {
  if (!sp) return '—'
  const of = sp.orchestrator + sp.agents + sp.tools
  return ['orchestrator', 'agents', 'tools'].map((k) => `${minutes(sp[k])} ${pct(sp[k], of)}`).join(' · ')
}
const splitLine = (sp) => `split: ${['orchestrator', 'agents', 'tools'].map((k) => `${k} ${minutes(sp[k])} (${pct(sp[k], sp.orchestrator + sp.agents + sp.tools)})`).join(' · ')}`
const int = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—')
const tok = (n) => (Number.isFinite(n) ? formatTokens(n) : '—')
const calls = (tc) => Object.entries(tc ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')

export function renderSummary(data) {
  const rows = summarize(data.runs ?? [])
  const reps = Math.max(1, ...rows.map((r) => r.n))
  const lines = ['| Config | Status | Wall | Turns | Tokens (in+out) | Cost | Accept | Fixture tests | Longest step | Orchestrator · Agents · Tools |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) {
    const g = r.range ?? {}
    lines.push(`| ${r.config}${r.flagged ? ' ⚠' : ''} | ${cell(r.status)} | ${spread(r.ms, g.ms, dur)} | ${spread(r.turns, g.turns, int)} | ${spread(r.tokens, g.tokens, tok)} | ${spread(r.costUsd, g.costUsd, usd)} | ${score(r.accept)} | ${score(r.fixture)} | ${r.longest ? `${r.longest.name} ${dur(r.longest.ms)}` : '—'} | ${splitCell(r.split)} |`)
  }
  if (reps > 1) {
    const ns = [...new Set(rows.map((r) => r.n))]
    lines.push('', ns.length === 1 ? `median (min–max) of ${reps} reps` : `median (min–max) over reps: ${rows.map((r) => `${r.config} ${r.n}`).join(' · ')}`)
  }
  for (const r of rows) if (r.flagged) lines.push('', `⚠ ${r.config}: ${r.flagged}`)
  return { rows, text: lines.join('\n') }
}

/**
 * The turns-per-step table, each cell against its budget (bench/budgets.json, by feature then
 * config): `12`, or `15 ⚠ 12` when the median went over. A config without budgets shows bare turns.
 */
export function turnsPerStep(rows, stepNames, budgets = {}) {
  const lines = ['', '## Turns per step', '', `| Config | ${stepNames.map(cell).join(' | ')} |`, `|---|${stepNames.map(() => '---').join('|')}|`]
  const over = []
  for (const r of rows) {
    const b = budgets?.[r.config] ?? {}
    lines.push(`| ${r.config} | ${stepNames.map((n) => {
      const v = r.stepTurns?.[n]
      if (!Number.isFinite(v)) return '—'
      if (Number.isFinite(b[n]) && v > b[n]) { over.push(`${r.config} ${n} ${int(v)} (budget ${b[n]})`); return `${int(v)} ⚠ ${b[n]}` }
      return int(v)
    }).join(' | ')} |`)
  }
  if (over.length) lines.push('', `⚠ over the turn budget: ${over.join(' · ')}`)
  else if (rows.some((r) => budgets?.[r.config])) lines.push('', 'Every step is within its turn budget.')
  return lines
}

export function renderReport(data) {
  const { rows, text: summary } = renderSummary(data)
  const v = data.versions ?? {}
  const out = [`# benchmark ${data.runId} — ${data.feature}`, '', `builder ${v.builder ?? '—'} · superpowers ${v.superpowers ?? '—'} · gsd ${v.gsd ?? '—'} · ${data.model ?? 'default model'} · ${new Date(data.startedAt).toISOString()}`, '', '## Summary', '', summary]
  const stepNames = [...new Set(rows.flatMap((r) => Object.keys(r.steps)))]
  out.push('', '## Time per step', '', `| Config | ${stepNames.map(cell).join(' | ')} |`, `|---|${stepNames.map(() => '---').join('|')}|`)
  for (const r of rows) out.push(`| ${r.config} | ${stepNames.map((n) => (n in r.steps ? spread(r.steps[n], r.stepRange?.[n], dur) : '—')).join(' | ')} |`)
  out.push(...turnsPerStep(rows, stepNames, data.budgets))
  for (const run of data.runs ?? []) {
    const reps = (data.runs ?? []).filter((x) => x.config === run.config).length
    out.push('', `## ${run.config}${reps > 1 ? ` — rep ${run.rep}` : ''}${run.status === 'done' ? '' : ` — ${run.status}`}`, '')
    if (run.path === 'in-chat') out.push(`⚠ ${IN_CHAT_FLAG}`, '')
    if (run.sessionTimedOut) out.push(`⚠ session ${run.sessionTimedOut} was cut by the timeout while waiting on the fleet`, '')
    if (overlapped(run)) out.push(`⚠ ${OVERLAP_FLAG}`, '')
    out.push(`wall ${dur(run.ms)}${run.installMs > 0 ? ` (install ${dur(run.installMs)}, not counted)` : ''} · ${run.totals?.turns ?? 0} turns · ${formatTokens((run.totals?.tokens?.input ?? 0) + (run.totals?.tokens?.output ?? 0))} tokens (in+out) · ${usd(run.totals?.costUsd)} · accept ${score(run.score?.accept)} · fixture ${score(run.score?.fixture)}`, ...(run.stoppedEarly ? [`stopped early: ${run.stoppedEarly} — the remaining sessions were not run`] : []), `copy: \`${run.copy ?? '—'}\``, '')
    for (const s of run.sessions ?? []) {
      out.push(`### ${s.name}${s.lane ? ` (${s.lane})` : ''} — ${dur(s.totals?.ms)}, ${s.totals?.turns ?? 0} turns${s.totals?.ended === 'cut' ? ', cut off' : ''}`, '')
      if (s.split) out.push(splitLine(s.split), '')
      out.push(`prompt: \`${firstLine(s.prompt)}\``)
      if (s.plugins?.length) out.push(`plugins: ${s.plugins.join(', ')}`)
      out.push('')
      for (const st of s.steps ?? []) {
        out.push(`- **${st.name}** — ${dur(st.ms)}, ${st.turns} turns${calls(st.toolCalls) ? `, ${calls(st.toolCalls)}` : ''}`)
        if (st.files?.length) out.push(`  - files: ${st.files.join(', ')}`)
        if (st.tests?.length) out.push(`  - tests: ${[...new Set(st.tests)].join(' · ')}`)
        if (st.subagents?.length) out.push(`  - subagents: ${st.subagents.map((a) => `${a.type} — ${a.first}`).join(' · ')}`)
        if (st.gaps?.length) out.push(`  - longest waits: ${st.gaps.map((g) => `${dur(g.ms)} after ${g.after}`).join(' · ')}`)
      }
      if (run.status !== 'done' && s.tail?.length) out.push('', '```', ...s.tail.slice(-10), '```')
      out.push('')
    }
    if (run.gitLog?.length) out.push('git log main:', '', '```', ...run.gitLog.slice(0, 20), '```')
  }
  return out.join('\n') + '\n'
}

export function renderStatusTable(data, progress) {
  const { text } = renderSummary(data)
  const line = progress ? `running: ${progress.config} (session ${progress.session}, ${duration(Date.now() - progress.startedAt)})` : 'not running'
  return `${text}\n\n${line}\n`
}
