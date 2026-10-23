/**
 * The slice table the go-ahead prints verbatim (spec §1): the feature, its slices grouped by app with
 * the tests each adds, where it lands, then the test plan in plain words and what it costs.
 *
 *   node scripts/plan-slices.mjs <folder> [--tests "<value>"] [--json]
 *   node scripts/plan-slices.mjs <folder> --index [--write]
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
  if (!folder) { console.error('usage: plan-slices.mjs <folder> [--tests "<value>"] [--json] | <folder> --index [--write]'); process.exit(2) }
  const dir = resolve(folder)
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
  const planText = read('PLAN.md')
  if (!planText) { console.error(`builder: no PLAN.md in ${dir}`); process.exit(1) }
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
