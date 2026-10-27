#!/usr/bin/env node
/**
 * gate — run an app's fast gates, or the deep set, from `.claude/builder.md`, and quote the last
 * green run when nothing that feeds the gate has changed.
 *
 *   node <plugin>/scripts/gate.mjs <app> [<app>…]     # each app's fast set
 *   node <plugin>/scripts/gate.mjs --deep [<app>…]    # the deep set (plus any named apps' fast sets)
 *   node <plugin>/scripts/gate.mjs --all              # every app's fast set
 *   node <plugin>/scripts/gate.mjs … --force          # run even when the memo says unchanged
 *   node <plugin>/scripts/gate.mjs … --whole          # run every @scoped line over its whole suite
 *   node <plugin>/scripts/gate.mjs <app>… --typecheck # only each app's @typecheck lines (none → passes)
 *   node <plugin>/scripts/gate.mjs --baseline         # measure every @delta gate here and record it
 *
 * Exit 0 = every set green (run or quoted). 1 = a gate is red. 2 = usage / unknown app.
 *
 * What one line in a gate block means (PROJECT.template.md §Quality gates):
 *   <command>                       # what it proves            — exit 0 or the set is red
 *   <command>                       # a count … @delta          — prints a number; must not exceed
 *                                                                 the baseline measured in the main
 *                                                                 checkout (`--baseline`, run by the
 *                                                                 fleet at start; else measured on
 *                                                                 first sight)
 *   <command>                       # inherited debt @known-red — run and reported, never counted
 *   <command>                       # the app type-checks @typecheck — the line `--typecheck` runs:
 *                                                 the floor the test plan keeps when nothing else
 *                                                 runs. Combines with the other markers.
 *   <runner> {tests}   # … @scoped <glob>        — only the tests in <glob> this branch can reach
 *                                                 (impact.mjs: what it changed, the code reading a
 *                                                 schema field it changed, everything importing or
 *                                                 loading either); none → reported, not run; a
 *                                                 change the graph can't see past → the whole suite.
 *                                                 Written to .builder/gates/impact.md, with why.
 *   <runner> <app path>/<path>/<file>.test.ts   — a `<…>` placeholder means "the test files this
 *                                                 branch changed under the app" (vs base_branch);
 *                                                 none changed → reported, not run, not red
 *
 * The config's `flaky:` list re-runs a failing gate whose output matches an entry — the narrow
 * `rerun:` command when one is given, else the same command once — and passes it on a green re-run.
 *
 * The memo lives in <repo>/.builder/gates/ (git-ignored, per worktree). A set is QUOTED when the
 * tree is clean and the hash of its inputs — the app's path, everything not owned by another app,
 * and the gate commands themselves — equals the hash of its last GREEN run. A red run is never
 * quoted. The output says which happened, and at which sha. After a green run of an app's WHOLE
 * fast set (not quoted, no @scoped subset, not --typecheck), each command's time goes to
 * .builder/gates/durations.json (readDurations).
 */
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { requireConfig } from './config.mjs'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { parseGates, inputLines, inputsHash, dirtyPaths, fmtPaths, mainRoot, runGateSet, runCommand, lastInt, readMemo, writeMemo, readBaseline, writeBaseline, writeDurations, readLineMemo, writeLineMemo, lineQuote, startCommand, killStarted, gateEnv, unwalkedE2E } from './gates-core.mjs'
import { impactOf, scopeTests, renderImpact } from './impact.mjs'

const USAGE = 'usage: gate.mjs <app>… | --all | --deep [<app>…] | --walk-only | --baseline   [--force] [--whole] [--typecheck]   (exit 0 green · 1 red · 3 the walk env broke)'
const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const names = argv.filter((a) => !a.startsWith('--'))
if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}
for (const a of argv) if (a.startsWith('--') && !['--all', '--deep', '--force', '--baseline', '--whole', '--typecheck', '--walk-only'].includes(a)) die(`unknown flag ${a}. ${USAGE}`)
const TYPECHECK = flag('--typecheck')
if (TYPECHECK && (flag('--deep') || flag('--baseline'))) die(`--typecheck runs app fast sets only. ${USAGE}`)

function die(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

const CFG = requireConfig()
const ROOT = CFG.root
// Under the fleet the gate lines come from the MAIN checkout's config (BUILDER_CONFIG_ROOT), the
// one the fleet itself reads: the config is the human's, and a branch must not loosen its own gates.
// The worktree's copy still gives the root and the apps.
const GATE_CFG = process.env.BUILDER_CONFIG_ROOT && process.env.BUILDER_CONFIG_ROOT !== ROOT ? requireConfig(process.env.BUILDER_CONFIG_ROOT) : CFG
const GATES = parseGates(GATE_CFG.body)
if (GATE_CFG !== CFG && JSON.stringify(parseGates(CFG.body)) !== JSON.stringify(GATES))
  console.log(`⚠ this branch's .claude/builder.md has gate lines that differ from the main checkout's — running the main checkout's. A config change is the human's: park as a human step with the diff (resume's AGENT-MODE.md).`)
const head = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const appPath = (name) => CFG.apps.find((a) => a.name === name)?.path
const MAIN = mainRoot(ROOT)

if (flag('--baseline')) {
  const deltas = [...Object.values(GATES.fast).flat(), ...GATES.deep].filter((g) => g.delta)
  if (!deltas.length) {
    console.log('no @delta gates in .claude/builder.md — nothing to baseline')
    process.exit(0)
  }
  const values = {}
  deltas.forEach((g, i) => {
    // A @scoped line's baseline is its whole suite.
    const r = runCommand(g.cmd.replace(/\s*\{tests\}/g, ''), { cwd: ROOT, logFile: join(ROOT, '.builder', 'gates', 'baseline-logs', `${String(i + 1).padStart(2, '0')}.log`) })
    values[g.cmd] = lastInt(r.stdout)
    console.log(`${values[g.cmd] == null ? '✗' : '✓'} ${g.cmd} → ${values[g.cmd] ?? 'no number'}`)
  })
  writeBaseline(ROOT, values, head())
  console.log(`baseline recorded at ${head()} in ${join(ROOT, '.builder', 'gates', 'baseline.json')}`)
  process.exit(Object.values(values).some((v) => v == null) ? 1 : 0)
}

// --walk-only: the deep set's @walk lines alone — what the fleet runs once per walk batch, in the walk
// worktree with the walk env up, so every feature in the batch is verified against the env once.
const WALK_ONLY = flag('--walk-only')
if (WALK_ONLY && !GATES.deep.some((g) => g.walk)) {
  console.log('no @walk line in the deep set — nothing needs the walk env')
  process.exit(0)
}
const wanted = WALK_ONLY ? [] : flag('--all') ? Object.keys(GATES.fast) : names
if (!wanted.length && !flag('--deep') && !WALK_ONLY) die(USAGE)
for (const n of wanted) {
  if (!appPath(n)) die(`no app named ${n} in .claude/builder.md (apps: ${CFG.appNames.join(', ')})`)
  if (!GATES.fast[n]) die(`no "### ${n} — fast" block under ## Quality gates in .claude/builder.md`)
}
if (flag('--deep') && !GATES.deep.length) die('no "### Deep set" block under ## Quality gates in .claude/builder.md')

/**
 * The branch's impact, measured once and only when a @scoped line runs — and written, with every
 * scoped glob's selection and why, to .builder/gates/impact.md: the evidence verify cites.
 */
let impact = null
const scopedGlobs = [...new Set([...Object.values(GATES.fast).flat(), ...GATES.deep].map((g) => g.scope).filter(Boolean))]
const scope = flag('--whole')
  ? null
  : (glob) => {
      if (!impact) {
        impact = impactOf(ROOT, { baseBranch: CFG.baseBranch })
        mkdirSync(join(ROOT, '.builder', 'gates'), { recursive: true })
        writeFileSync(join(ROOT, '.builder', 'gates', 'impact.md'), renderImpact(impact, scopedGlobs))
      }
      return scopeTests(impact, glob)
    }

const dirtyList = dirtyPaths(ROOT)
const dirty = dirtyList.length > 0
const sha = head()
const fullSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * Per line: quote a line whose last green run still stands (gates-core lineQuote) — never under
 * --force or --whole, never on a dirty tree. What changed since is git's answer; whether it reaches
 * a @scoped line's tests is the import graph's, measured from that line's green head.
 */
const LINES = readLineMemo(ROOT)
const changedSince = (from) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', from, 'HEAD'], { cwd: ROOT, stdio: 'ignore' })
    return execFileSync('git', ['diff', '--name-only', from, 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return null
  }
}
const impactSince = new Map()
const reaches = (glob, from) => {
  if (!impactSince.has(from)) impactSince.set(from, impactOf(ROOT, { baseBranch: CFG.baseBranch, since: from }))
  return scopeTests(impactSince.get(from), glob).mode
}
/**
 * A quoted line never comes before a line that runs: an earlier line may be setup the later one needs
 * (a reset, a migrate, a generate) — quoting it would run the later line on a state nothing prepared.
 * So only the lines after the set's last running line can be quoted. Decided once per set.
 */
const quoteFor = (set) => {
  if (flag('--force') || flag('--whole') || dirty) return null
  if (!set.quotes) {
    const raw = set.gates.map((g) => lineQuote(g, LINES[g.cmd], { changedSince, exclude: set.exclude, reaches }))
    const lastRun = raw.reduce((last, q, i) => (q ? last : i), -1)
    set.quotes = new Map(set.gates.map((g, i) => [g.cmd, i > lastRun ? raw[i] : null]))
  }
  return (g) => set.quotes.get(g.cmd) ?? null
}
const registry = CFG.registry
let baseline = readBaseline(MAIN)
let anyRed = false

// --typecheck: only each app's @typecheck lines, as a set of its own (its own memo — it never stands
// in for the full set). An app with none marked has nothing to run and passes, saying so.
const fastSets = TYPECHECK
  ? wanted.filter((n) => {
      if (GATES.fast[n].some((g) => g.typecheck)) return true
      console.log(`no @typecheck line for ${n}`)
      return false
    })
  : wanted
const sets = [
  ...fastSets.map((n) => ({ app: n, key: `fast-${n}${TYPECHECK ? '-typecheck' : ''}`, label: `${n} — ${TYPECHECK ? 'typecheck' : 'fast'}`, gates: TYPECHECK ? GATES.fast[n].filter((g) => g.typecheck) : GATES.fast[n], exclude: [registry, ...CFG.apps.filter((a) => a.name !== n).map((a) => a.path)], expand: { root: ROOT, appPath: appPath(n), baseBranch: CFG.baseBranch } })),
  ...(flag('--deep') && !WALK_ONLY ? [{ key: 'deep', label: 'deep set', gates: GATES.deep, exclude: [registry], expand: null }] : []),
  ...(WALK_ONLY ? [{ key: 'deep-walk', label: '@walk gates', gates: GATES.deep.filter((g) => g.walk), exclude: [registry], expand: null }] : []),
]
// A --whole run and a scoped one prove different things on the same tree: each quotes only its own.
if (flag('--whole')) for (const set of sets) if (set.gates.some((g) => g.scope)) set.key += '-whole'
// A set with @walk lines proves different things per lane — the build lane skips them — so each lane
// quotes only its own run: a build-lane green must never stand in for verify's.
const LANE = process.env.BUILDER_LANE
if (LANE) for (const set of sets) if (set.gates.some((g) => g.walk)) set.key += `-${LANE}`

// While a set runs, .builder/gates/running.json says so — the status line's "gate … ⏱" reads it.
const RUNNING = join(ROOT, '.builder', 'gates', 'running.json')
const markRunning = (label) => {
  mkdirSync(dirname(RUNNING), { recursive: true })
  writeFileSync(RUNNING, JSON.stringify({ sets: label, pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
}
process.on('exit', () => {
  rmSync(RUNNING, { force: true })
  killStarted() // a @parallel line must not outlive the run that started it
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130))

// Each set's memo verdict, once: a quoted set runs nothing, so its @parallel lines don't start.
for (const set of sets) {
  set.hash = inputsHash(inputLines(ROOT, { exclude: set.exclude }), set.gates)
  const memo = readMemo(ROOT, set.key)
  set.memo = !flag('--force') && !dirty && memo && memo.hash === set.hash && memo.exit === 0 ? memo : null
}

/**
 * `@parallel` lines — ones that share no database, port or output folder with the rest — all start
 * now, across every set this run will run, and each is collected in its turn. The run then takes as
 * long as its slowest line, not the sum. Only plain lines: never a @delta count, a @scoped or `<…>`
 * line (their command depends on what runs before), or one this run quotes or skips.
 */
for (const set of sets) {
  if (set.memo) continue
  const quote = quoteFor(set)
  set.started = new Map()
  set.gates.forEach((g, i) => {
    if (!g.parallel || g.delta || g.scope || /<[^>]+>/.test(g.cmd) || unwalkedE2E(g, process.env) || quote?.(g)) return
    const env = gateEnv(g, process.env)
    if (env === null) return
    set.started.set(g.cmd, startCommand(g.cmd, { cwd: ROOT, env, logFile: join(ROOT, '.builder', 'gates', `${set.key}-logs`, `${String(i + 1).padStart(2, '0')}.log`) }))
  })
}

for (const set of sets) {
  const hash = set.hash
  const memo = set.memo
  if (memo) {
    console.log(`⏩ ${set.label}: inputs unchanged since the green run at ${memo.head} (${memo.when}) — quoted, not re-run:`)
    for (const l of memo.lines) console.log(`   ${l}`)
    console.log(`gate ${set.key}: PASS (quoted) · ${sha}`)
    continue
  }
  console.log(`▶ ${set.label} at ${sha}${dirty ? ` (uncommitted: ${fmtPaths(dirtyList)} — not quoted, result not memoised)` : ''}`)
  markRunning(set.label)
  const logDir = join(ROOT, '.builder', 'gates', `${set.key}-logs`)
  const t0 = Date.now()
  const r = runGateSet(set.gates, { cwd: ROOT, env: process.env, logDir, flaky: GATE_CFG.flaky, baseline, expand: set.expand, scope, quote: quoteFor(set), started: set.started, log: (l) => console.log(`   ${l}`) })
  if (!dirty) writeLineMemo(ROOT, { greens: r.greens, reds: set.gates.map((g) => g.cmd).filter((c) => !r.greens.includes(c) && !r.quoted.includes(c)) }, fullSha)
  if (Object.keys(r.newBaselines).length) {
    baseline = { ...baseline, ...r.newBaselines }
    writeBaseline(MAIN, baseline, sha)
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  const unv = r.unverified?.length ? ` · ${r.unverified.length} unverified (e2e without @walk)` : ''
  console.log(`gate ${set.key}: ${r.exit === 0 ? 'PASS' : `FAIL (${r.red} red)`}${unv} · ${sha} · ${secs}s`)
  if (!dirty) writeMemo(ROOT, set.key, { hash, head: sha, when: new Date().toISOString(), exit: r.exit, lines: r.lines })
  // What the whole app set costs, for the test plan: only a green run of every line, whole.
  if (set.app && !TYPECHECK && r.exit === 0 && !r.partial && !r.quoted.length) writeDurations(ROOT, set.app, { total: Date.now() - t0, commands: r.durations })
  if (r.exit !== 0) anyRed = true
  if (walkEnvBroken(set.label)) process.exit(3)
}

process.exit(anyRed ? 1 : 0)

/**
 * In the fleet's walk lane the walk env serves from this very worktree, and a gate can break it —
 * a build rewriting the folder the dev server serves from (Next.js `.next`, Nuxt `.nuxt`, …). After
 * each set that ran, poll agent_walk.smoke (BUILDER_WALK_SMOKE) a few times; when it no longer
 * passes, say what to do and stop with exit 3 — every later check would be against a dead env.
 */
function walkEnvBroken(label) {
  const smoke = process.env.BUILDER_LANE === 'walk' ? process.env.BUILDER_WALK_SMOKE : ''
  if (!smoke) return false
  for (let i = 0; i < 5; i++) {
    if (runCommand(smoke, { cwd: ROOT, env: process.env, timeoutMs: 20000 }).exit === 0) return false
    execFileSync('sleep', ['3'])
  }
  console.log(`⚠ the walk env stopped answering after ${label} (smoke: ${smoke}) — a gate likely rewrote what the dev server serves (a build writing its output folder). Write blocked: "walk env needs a restart — broken by the ${label} gates" to the manifest, commit, and end the run: the fleet restarts the env without a reset and the run goes on. Give the walk env its own output folder through agent_walk.env to stop it happening (/builder:init --update).`)
  return true
}
