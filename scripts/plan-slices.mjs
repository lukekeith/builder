/**
 * The slice table the go-ahead prints verbatim (spec §1): the feature, its slices grouped by app with
 * the tests each adds, where it lands, then the test plan in plain words and what it costs.
 *
 *   node scripts/plan-slices.mjs <folder> [--tests "<value>"] [--json]
 *   node scripts/plan-slices.mjs <folder> --index [--write]
 *   node scripts/plan-slices.mjs <folder> --brief | --scan
 *
 * --index prints SPEC §Plan's index (REFERENCE §Plan): the pointer to PLAN.md, then one
 * `- Phase N · Task M · <name>` line per `### Task N` — the phase from the `## Phases` table (the
 * membership source), else the block's `Phase:` line. --write puts it into SPEC.md: an existing
 * `## Plan` section is replaced by its heading, else it goes after §Findings & risks (before any
 * later section — §Prototype, §Replaced surfaces, `## Fixes`), else at the end. Re-running it writes
 * the same file.
 *
 * Levers: --tests, else the manifest's tests:/profile: line, else the recommendation for the folder.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, basename, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseManifest, isSet } from './manifest.mjs'
import { loadConfig } from './config.mjs'
import { RECOMMENDED, parseTests, parseTestPlan, recommend, cost, formatTests, section } from './profile.mjs'
import { readDurations } from './gates-core.mjs'
import { headings, writeAtomic } from './feature-core.mjs'

const FENCE = /^\s*(`{3,}|~{3,})/
const TEST_CASE = /(?<![\w.$])(?:it|test)\s*\(|\bdef test_\w*|\bfunc Test\w*|#\[test\]/g
const HEADING = /^### Task (\d+)\b[\s:—–-]*(.*)$/
const APP = /^\s*[-*]*\s*\**App:?\**:?\s*`?([\w.-]+)`?/
const PHASE = /^\s*[-*]*\s*\**Phase:?\**:?\s*(\d+)/
const MAX_NAME = 56
const LONG = 30

/** Lines tagged with whether they sit inside a code fence (the fence markers themselves count as inside). */
function fenced(text) {
  let open = null
  return String(text ?? '').split('\n').map((line) => {
    const m = FENCE.exec(line)
    if (!open && m) { open = m[1]; return { line, inside: true } }
    if (open && m && m[1][0] === open[0] && m[1].length >= open.length && line.trim() === m[1]) { open = null; return { line, inside: true } }
    return { line, inside: !!open }
  })
}

/** The test cases a block's code fences carry: `it(`, `test(`, `def test_`, `func Test`, `#[test]`. */
export const countTests = (text) => fenced(text).reduce((n, { line, inside }) => n + (inside ? (line.match(TEST_CASE) ?? []).length : 0), 0)

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/** Phases table → { byPhase: phase → app, byTask: task → app, phaseOf: task → phase } */
function phaseApps(planText) {
  const byPhase = new Map(), byTask = new Map(), phaseOf = new Map()
  let seenSep = false
  for (const line of section(planText, 'Phases').split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (/^\|\s*:?-{2,}/.test(line.trim())) { seenSep = true; continue }
    if (!seenSep) continue
    const [phase, app, tasks] = cells(line)
    if (!app) continue
    if (/^\d+$/.test(phase)) byPhase.set(+phase, app)
    for (const part of (tasks ?? '').split(/[,\s]+/)) {
      const m = /^(\d+)(?:[-–](\d+))?$/.exec(part)
      if (m) for (let n = +m[1]; n <= +(m[2] ?? m[1]); n++) {
        byTask.set(n, app)
        if (/^\d+$/.test(phase)) phaseOf.set(n, +phase)
      }
    }
  }
  return { byPhase, byTask, phaseOf }
}

/** PLAN.md → [{ n, app, phase, name, tests }], one per `### Task N` outside a fence. */
export function slices(planText) {
  const blocks = []
  let cur = null
  for (const { line, inside } of fenced(planText)) {
    const h = inside ? null : HEADING.exec(line)
    if (h) { cur = { n: +h[1], name: h[2].trim(), lines: [] }; blocks.push(cur); continue }
    if (!inside && /^## /.test(line)) { cur = null; continue }
    if (cur) cur.lines.push({ line, inside })
  }
  const { byPhase, byTask } = phaseApps(planText)
  return blocks.map(({ n, name, lines }) => {
    const plain = lines.filter((l) => !l.inside).map((l) => l.line)
    const app = plain.map((l) => APP.exec(l)?.[1]).find(Boolean)
    const p = plain.map((l) => PHASE.exec(l)?.[1]).find(Boolean)
    const phase = p ? +p : null
    return { n, app: app ?? byPhase.get(phase) ?? byTask.get(n) ?? '—', phase, name, tests: countTests(lines.map((l) => l.line).join('\n')) }
  })
}

// ---- the build orchestrator's view of the plan ---------------------------------------------------
//
// The orchestrator coordinates; it never implements. Holding the whole PLAN.md — every task's code —
// costs it that text on every turn of the build (one measured plan was 386KB). What it needs is the
// header (Global Constraints, the Phases table) and each task's head: App, Phase, Recipe, Files,
// Interfaces. --brief prints exactly that; --scan prints the pre-flight conflict scan's mechanical
// rows from it. A task's steps and code stay in the plan, for its implementer's brief and for the
// orchestrator to read with task-brief when a ruling needs them.

const STEP = /^\s*[-*]\s+\[[ xX]\]\s/
const STEP_LOOSE = /^\s*(?:[-*]\s+|\d+\.\s+)?\*\*Step\s+\d+/i
/** An interface's name: `parse(argv: string[])` and `parse(argv) → {…}` are both `parse`; a path or a literal is not a name. */
const ident = (code) => {
  const m = /^\s*(?:export\s+)?(?:const|function|class|type|interface|def)?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(code)
  return m && !/[/\\]/.test(code.split(/[\s(]/)[0]) ? m[1] : null
}
const FILE_LINE = /^\s*[-*]\s+(Create|Modify|Test|Delete|Remove|Read)\s*:\s*`([^`]+)`/i

/** Each task's head (its heading up to its first `- [ ]` step), its step count, and its parsed Files and Interfaces. */
export function taskHeads(planText) {
  const out = []
  let cur = null
  let part = null
  for (const { line, inside } of fenced(planText)) {
    const h = inside ? null : HEADING.exec(line)
    if (h) { cur = { n: +h[1], name: h[2].trim(), head: [line], steps: 0, files: [], consumes: [], produces: [], stepText: [], open: true }; out.push(cur); part = null; continue }
    if (!cur) continue
    if (!inside && /^## /.test(line)) { cur = null; continue }
    // A step: a `- [ ]` box (PLAN-FORMAT), a `**Step N` line written without one, or — in a plan
    // written neither way — the first code fence. The head ends at whichever comes first.
    if (!inside && (STEP.test(line) || STEP_LOOSE.test(line))) { cur.open = false; cur.steps += 1 }
    else if (cur.open && inside) cur.open = false
    if (cur.open) {
      cur.head.push(line)
      if (/^\s*\**Files:?\**:?\s*$/i.test(line)) part = 'files'
      else if (/^\s*\**Interfaces:?\**:?\s*$/i.test(line)) part = 'interfaces'
      const f = FILE_LINE.exec(line)
      if (f && part === 'files') cur.files.push({ kind: f[1], path: f[2].replace(/:\d+(?:-\d+)?$/, '') })
      // A Consumes/Produces bullet owns its own line and the sub-bullets indented under it.
      const io = /^(\s*)[-*]\s+(Consumes|Produces)\b[^:]*:\s*(.*)$/i.exec(line)
      if (part === 'interfaces' && io) cur.io = { key: io[2].toLowerCase(), indent: io[1].length }
      else if (part === 'interfaces' && cur.io && !(/^\s*[-*]\s/.test(line) && /^\s*/.exec(line)[0].length > cur.io.indent)) cur.io = null
      if (part === 'interfaces' && cur.io) cur[cur.io.key].push(...[...(io ? io[3] : line).matchAll(/`([^`]+)`/g)].map((m) => ident(m[1])).filter(Boolean))
    } else cur.stepText.push(line)
  }
  return out.map(({ open, io, head, stepText, consumes, produces, ...t }) => ({ ...t, consumes: [...new Set(consumes)], produces: [...new Set(produces)], head: head.join('\n').replace(/\s+$/, ''), stepText: stepText.join('\n') }))
}

/** --brief: the header verbatim, then per task its head and one line of what its steps hold. */
export function planBrief(planText) {
  const firstTask = fenced(planText).findIndex(({ line, inside }) => !inside && HEADING.test(line))
  const lines = String(planText).split('\n')
  const header = (firstTask < 0 ? lines : lines.slice(0, firstTask)).join('\n').replace(/\s+$/, '')
  const counts = new Map(slices(planText).map((x) => [x.n, x.tests]))
  const heads = taskHeads(planText)
  const out = [header, '', `<!-- plan-slices --brief: each task's head; its steps and code are in PLAN.md (task-brief <plan> <N> <file> cuts one) -->`]
  for (const t of heads) out.push('', t.head, `(${plural(t.steps, 'step')} · ${plural(counts.get(t.n) ?? 0, 'test case')} in the block)`)
  return out.join('\n') + '\n'
}

/**
 * --scan: the pre-flight conflict scan's mechanical rows (EXECUTION.md §Setup 6) — pairs sharing a
 * file, an interface consumed before (or with no) task producing it, a task's Files outside its
 * App's path, and a task whose steps name a path its Files doesn't list. Every row is a question
 * for the orchestrator to rule on, not a verdict; a task with no row was checked and is clean.
 */
export function planScan(planText, apps = []) {
  const heads = taskHeads(planText)
  const appOf = new Map(slices(planText).map((x) => [x.n, x.app]))
  const rows = []
  const byFile = new Map()
  for (const t of heads) for (const f of t.files) (byFile.get(f.path) ?? byFile.set(f.path, new Set()).get(f.path)).add(t.n)
  for (const [path, set] of byFile) if (set.size > 1) rows.push(['shared file', [...set].map((n) => `${n}`).join(', '), `\`${path}\` is in each one's Files — order and overlap`])
  const producer = new Map()
  for (const t of heads) for (const p of t.produces) if (!producer.has(p)) producer.set(p, t.n)
  // What one task hands another, one row per pair: the names must be spelled the same on both sides.
  // A name no task produces is existing code (or the audit's to have caught), not a row.
  const pairs = new Map()
  for (const t of heads)
    for (const c of t.consumes) {
      const p = producer.get(c)
      if (p == null || p === t.n) continue
      const k = `${p} → ${t.n}`
      ;(pairs.get(k) ?? pairs.set(k, { p, c: t.n, names: [] }).get(k)).names.push(c)
    }
  for (const [k, { p, c, names }] of pairs)
    rows.push(['interface', k, p > c ? `task ${c} consumes ${names.map((x) => `\`${x}\``).join(', ')} before task ${p} produces it` : `${names.map((x) => `\`${x}\``).join(', ')} — the same spelling in both blocks`])
  for (const t of heads) {
    const app = apps.find((a) => a.name === appOf.get(t.n))
    const base = app?.path ? String(app.path).replace(/^\.\/?/, '').replace(/\/?$/, '/') : null
    if (base && base !== '/') {
      const out = t.files.filter((f) => !f.path.replace(/^\.\//, '').startsWith(base))
      if (out.length) rows.push(['app boundary', `${t.n}`, `App: ${app.name} (${base}) but Files lists ${out.map((f) => `\`${f.path}\``).join(', ')}`])
    }
    const named = new Set([...t.stepText.matchAll(/`([\w./-]+\/[\w.-]+\.[a-z0-9]+)(?::\d+(?:-\d+)?)?`/gi)].map((m) => m[1].replace(/^\.\//, '')))
    const listed = new Set(t.files.map((f) => f.path.replace(/^\.\//, '')))
    const missing = [...named].filter((p) => !listed.has(p))
    if (missing.length) rows.push(['files ↔ steps', `${t.n}`, `steps name ${missing.map((p) => `\`${p}\``).join(', ')}, not in Files`])
    if (!t.files.length) rows.push(['files ↔ steps', `${t.n}`, 'no **Files:** list'])
  }
  const lines = ['| # | Check | Tasks | Finding | Ruling |', '|---|---|---|---|---|']
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r[0]} | ${r[1]} | ${r[2].replace(/\|/g, '\\|')} | |`))
  const clean = heads.filter((t) => !rows.some((r) => r[1].split(/[,→\s]+/).includes(String(t.n)))).map((t) => t.n)
  lines.push('', `${plural(rows.length, 'row')} to rule on · checked clean: ${clean.length ? `tasks ${clean.join(', ')}` : 'none'}`)
  return lines.join('\n') + '\n'
}

/** SPEC §Plan's index for a plan in `rel` (the feature folder, relative to the repo). */
export function planIndex(planText, rel) {
  const { phaseOf } = phaseApps(planText)
  const rows = slices(planText).map((s) => `- Phase ${phaseOf.get(s.n) ?? s.phase ?? '?'} · Task ${s.n} · ${s.name}`)
  return ['## Plan', '', `The plan, with its code: \`${rel}/PLAN.md\` (§PLAN.md).`, '', ...rows].join('\n')
}

/** SPEC text with `index` as its §Plan — replacing one by its heading, else after §Findings & risks. */
export function spliceIndex(specText, index) {
  const lines = String(specText).replace(/\n*$/, '').split('\n')
  const heads = headings(specText).filter((h) => h.level === 2)
  const after = (h) => heads.find((x) => x.i > h.i)?.i ?? lines.length
  const trim = (arr) => { while (arr.length && arr.at(-1).trim() === '') arr.pop(); return arr }
  const put = (start, end) => {
    const head = trim(lines.slice(0, start))
    const tail = lines.slice(end)
    return [...head, '', index, ...(tail.length ? ['', ...tail] : [])].join('\n') + '\n'
  }
  const plan = heads.find((h) => h.title.trim() === 'Plan')
  if (plan) return put(plan.i, after(plan))
  const findings = heads.find((h) => /^Findings/.test(h.title))
  if (findings) return put(after(findings), after(findings))
  const fixes = heads.find((h) => h.title.trim() === 'Fixes')
  if (fixes) return put(fixes.i, fixes.i)
  return put(lines.length, lines.length)
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** levers → the test plan in plain words, one phrase per lever, `·`-joined. */
export function leverWords(levers, apps) {
  const l = { ...RECOMMENDED, ...(levers ?? {}) }
  const suites = `the ${andList(apps)} ${apps.length === 1 ? 'suite' : 'suites'} once`
  const slice = {
    own: 'each slice runs its own tests',
    'own+app': "each slice runs its own tests, and each app's suite once its slices are done",
    full: "the app's suite after every slice",
    none: 'no tests while building — a type-check only',
  }[l.slice]
  const end = {
    touched: `at the end, ${suites}`,
    risk: `at the end, ${suites}, and an agent tries the risky parts`,
    everything: 'at the end, everything — the deep set, the cross-app E2E and the full walk',
    none: 'nothing tested at the end — a type-check only',
  }[l.end]
  const review = { end: 'one review at the end', app: 'a review after each app', slice: 'a review after every slice', 'slice+second': 'two reviews after every slice' }[l.review]
  const extra = [
    l.models !== 'default' && `${l.models} models`,
    l.persist === 'low' && 'low persistence',
    l.unruled === 'park' && 'parks on an unruled decision',
    l.walk === 'you' && 'you walk it before it lands',
  ].filter(Boolean)
  return [slice, end, review, ...extra].join(' · ')
}

/** cost() → `12 quick test runs + 3 suite runs (≈ 6 min of tests)`, ` · N reviews` past the one final review. */
export function costWords(c) {
  const runs = [c.ownRuns && plural(c.ownRuns, 'quick test run'), c.suiteRuns && plural(c.suiteRuns, 'suite run')].filter(Boolean)
  let out = runs.length ? runs.join(' + ') : 'no test runs'
  if (runs.length && c.minutes != null) out += ` (≈ ${c.minutes || '<1'} min of tests)`
  if (c.reviews > 1) out += ` · ${c.reviews} reviews`
  return out
}

/** Over LONG slices, each app keeps its first 3 and last 1, with `… n more` between. */
function shown(group, long) {
  if (!long || group.length <= 4) return group
  return [...group.slice(0, 3), { more: group.length - 4 }, group.at(-1)]
}

/** → the text block of spec §1. */
export function render({ feature, target, slices: s, cost: c, levers, recommended }) {
  const apps = [...new Set(s.map((x) => x.app))]
  const long = s.length > LONG
  const rows = apps.flatMap((app) => shown(s.filter((x) => x.app === app), long).map((x, i) => ({ ...x, label: i === 0 ? app : '' })))
  const clip = (t) => (t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1).trimEnd()}…` : t)
  const tag = (n) => (n ? `+${plural(n, 'test')}` : '—')
  const aw = Math.max(...apps.map((a) => a.length))
  const nw = Math.max(...s.map((x) => String(x.n).length))
  const namew = Math.max(...rows.filter((r) => !r.more).map((r) => clip(r.name).length))
  const tw = Math.max(...rows.filter((r) => !r.more).map((r) => tag(r.tests).length))
  const lines = [`${feature} — ${plural(s.length, 'slice')} in ${plural(apps.length, 'app')} · lands on ${target}`, '']
  for (const r of rows) {
    const head = `${r.label.padEnd(aw)} ${(r.more ? '…' : String(r.n)).padStart(nw)}  `
    lines.push(r.more ? `${head}${r.more} more` : `${head}${clip(r.name).padEnd(namew)}  ${tag(r.tests).padStart(tw)}`)
  }
  const rec = formatTests(levers) === formatTests({ ...RECOMMENDED, ...recommended })
  lines.push('', `Test plan${rec ? ' (recommended)' : ''}: ${leverWords(levers, apps)}`, `  ${costWords(c)}`)
  return lines.join('\n')
}

function repoRoot(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return process.env.CLAUDE_PROJECT_DIR || process.cwd() }
}

function main(argv) {
  const flag = (f) => argv.includes(f)
  const arg = (f) => argv[argv.indexOf(f) + 1]
  const folder = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--tests')
  if (!folder) { console.error('usage: plan-slices.mjs <folder> [--tests "<value>"] [--json] | <folder> --index [--write] | <folder> --brief | <folder> --scan'); process.exit(2) }
  const dir = resolve(folder)
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
  const planText = read('PLAN.md')
  if (!planText) { console.error(`builder: no PLAN.md in ${dir}`); process.exit(1) }
  if (flag('--brief')) { console.log(planBrief(planText)); return }
  if (flag('--scan')) {
    const c = loadConfig(repoRoot(dir))
    console.log(planScan(planText, c.ok ? c.apps : []))
    return
  }
  if (flag('--index')) {
    const root = repoRoot(dir)
    const index = planIndex(planText, relative(root, dir).split(sep).join('/'))
    if (!flag('--write')) { console.log(index); return }
    const spec = read('SPEC.md')
    if (!spec) { console.error(`builder: no SPEC.md in ${dir}`); process.exit(1) }
    const next = spliceIndex(spec, index)
    if (next === spec) console.log(`SPEC §Plan: already current (${slices(planText).length} tasks)`)
    else { writeAtomic(join(dir, 'SPEC.md'), next); console.log(`SPEC §Plan: written (${slices(planText).length} tasks) → ${join(dir, 'SPEC.md')}`) }
    return
  }
  const manifest = parseManifest(read('MANIFEST.md'))
  const root = repoRoot(existsSync(dir) ? dir : process.cwd())
  const c = loadConfig(root)
  const cfg = c.ok ? c : {}
  const warn = (w) => w && console.error(`builder: ${w}`)
  const recommended = { ...RECOMMENDED, ...recommend({ specText: read('SPEC.md'), planText, cfg }).tests }
  let levers
  if (flag('--tests')) { const t = parseTests(arg('--tests')); warn(t.warning); levers = t.levers }
  else if (isSet(manifest.tests) || isSet(manifest.profile)) { const p = parseTestPlan(manifest); warn(p.warning); levers = p.levers }
  else levers = recommended
  const out = {
    feature: isSet(manifest.feature) ? manifest.feature : basename(dir),
    target: [manifest.target, cfg.mergeInto, cfg.baseBranch].find(isSet) ?? 'main',
    slices: slices(planText),
    levers,
    recommended,
    cost: cost({ planText, levers, durations: readDurations(root) }),
  }
  console.log(flag('--json') ? JSON.stringify(out) : render(out))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
