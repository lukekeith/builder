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
 * quoted. The output says which happened, and at which sha.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { requireConfig } from './config.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { parseGates, inputLines, inputsHash, isDirty, mainRoot, runGateSet, runCommand, lastInt, readMemo, writeMemo, readBaseline, writeBaseline } from './gates-core.mjs'
import { impactOf, scopeTests, renderImpact } from './impact.mjs'

const USAGE = 'usage: gate.mjs <app>… | --all | --deep [<app>…] | --baseline   [--force] [--whole]'
const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const names = argv.filter((a) => !a.startsWith('--'))
if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}
for (const a of argv) if (a.startsWith('--') && !['--all', '--deep', '--force', '--baseline', '--whole'].includes(a)) die(`unknown flag ${a}. ${USAGE}`)

function die(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

const CFG = requireConfig()
const ROOT = CFG.root
const GATES = parseGates(CFG.body)
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

const wanted = flag('--all') ? Object.keys(GATES.fast) : names
if (!wanted.length && !flag('--deep')) die(USAGE)
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

const dirty = isDirty(ROOT)
const sha = head()
const registry = CFG.registry
let baseline = readBaseline(MAIN)
let anyRed = false

const sets = [
  ...wanted.map((n) => ({ key: `fast-${n}`, label: `${n} — fast`, gates: GATES.fast[n], exclude: [registry, ...CFG.apps.filter((a) => a.name !== n).map((a) => a.path)], expand: { root: ROOT, appPath: appPath(n), baseBranch: CFG.baseBranch } })),
  ...(flag('--deep') ? [{ key: 'deep', label: 'deep set', gates: GATES.deep, exclude: [registry], expand: null }] : []),
]
// A --whole run and a scoped one prove different things on the same tree: each quotes only its own.
if (flag('--whole')) for (const set of sets) if (set.gates.some((g) => g.scope)) set.key += '-whole'

for (const set of sets) {
  const hash = inputsHash(inputLines(ROOT, { exclude: set.exclude }), set.gates)
  const memo = readMemo(ROOT, set.key)
  if (!flag('--force') && !dirty && memo && memo.hash === hash && memo.exit === 0) {
    console.log(`⏩ ${set.label}: inputs unchanged since the green run at ${memo.head} (${memo.when}) — quoted, not re-run:`)
    for (const l of memo.lines) console.log(`   ${l}`)
    console.log(`gate ${set.key}: PASS (quoted) · ${sha}`)
    continue
  }
  console.log(`▶ ${set.label} at ${sha}${dirty ? ' (tree has uncommitted changes — result not memoised)' : ''}`)
  const logDir = join(ROOT, '.builder', 'gates', `${set.key}-logs`)
  const t0 = Date.now()
  const r = runGateSet(set.gates, { cwd: ROOT, env: process.env, logDir, flaky: CFG.flaky, baseline, expand: set.expand, scope, log: (l) => console.log(`   ${l}`) })
  if (Object.keys(r.newBaselines).length) {
    baseline = { ...baseline, ...r.newBaselines }
    writeBaseline(MAIN, baseline, sha)
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`gate ${set.key}: ${r.exit === 0 ? 'PASS' : `FAIL (${r.red} red)`} · ${sha} · ${secs}s`)
  if (!dirty) writeMemo(ROOT, set.key, { hash, head: sha, when: new Date().toISOString(), exit: r.exit, lines: r.lines })
  if (r.exit !== 0) anyRed = true
}

process.exit(anyRed ? 1 : 0)
