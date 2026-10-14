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
  const out = { sessionId: null, model: null, result: null, events: [] }
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
 * the first is `(prompt)`; a session with no Skill call is one step named after its prompt.
 */
export function deriveSteps(parsed, { prompt }) {
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
      if (FILE_TOOLS.has(b.name) && i.file_path && !cur.files.includes(i.file_path)) cur.files.push(i.file_path)
      if (b.name === 'Bash' && i.command) {
        const c = firstLine(i.command)
        cur.commands.push(c)
        if (TEST_RE.test(i.command)) cur.tests.push(c)
      }
      if (AGENT_TOOLS.has(b.name)) cur.subagents.push({ type: i.subagent_type ?? 'agent', first: firstLine(i.description ?? i.prompt) })
      label = describeCall(b)
    }
    lastEvent = { t: e.t, label }
  }
  cur.end = end
  if (steps.length > 1 && steps[0].name === '(prompt)' && steps[0].end === steps[0].start) steps.shift()
  if (steps.length === 1 && steps[0].name === '(prompt)') steps[0].name = prompt
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
    return { ms: r.duration_ms ?? wall, turns: r.num_turns ?? 0, tokens: { input: tk.input, output: tk.output, cacheRead: tk.cacheRead }, costUsd: tk.costUsd, ended: 'result' }
  }
  return { ms: wall, turns: events.filter((e) => e.type === 'assistant' && e.top).length, tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0, ended: 'cut' }
}

export { duration, formatTokens }
