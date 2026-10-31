#!/usr/bin/env node
// A stand-in for bench-case.mjs (and, given `run <feature> --only builder`, for bench.mjs on a fixture).
// Case mode: `<id> --builder <b> --out <dir> [--dry-run]` reads $BENCH_LOCAL/cases/<id>.json. A dry run
// refuses (exit 2) on the safety check of its profile's `builderMd`, if it has one, else prints the ports its front matter names and its body: warnings. A run sleeps
// STUB_CASE_MS × the case's estimated minutes (10× for an id in STUB_CASE_LONG), then writes
// <out>/result.json; STUB_CASE_DIE (ids) exits 1 instead, writing nothing.
// Fixture mode writes <cwd>/bench/results/<stamp>-<feature>/runs.json with one done builder run.
// Both append `start <id> <project> <t>`, `builder <id> <path>` and `end <id> <t>` to $STUB_STATE/case.log (fixture mode also
// `history <feature> <BENCH_HISTORY> <BENCH_CONTROL>`, '-' for unset);
// a dry run appends `replan <id> <bool>` to dry.log instead, and under --replan prints `replan: from-audited` for an id in
// STUB_REPLAN_AUDITED, else `replan: prefix (1 commit)` (a run's result.json carries the same mode); case mode also `replan <id> <bool>`, `timeout <id> <BENCH_CASE_FLEET_TIMEOUT_MS>` and `clone-root <id> <--clone-root>`, and on
// SIGTERM writes result.json `failed: stopped`, logs `stopped <id> <t>` and exits 0.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { safetyRefusals, portsNamed, bodyWarnings, frontMatterText } from '../../../bench-suite-core.mjs'

const argv = process.argv.slice(2)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
const log = (line) => appendFileSync(join(process.env.STUB_STATE, 'case.log'), line + '\n')
const ids = (v) => (v ?? '').split(',').filter(Boolean)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const unit = Number(process.env.STUB_CASE_MS) || 0

if (argv[0] === 'run') {
  const feature = argv[1]
  log(`start ${feature} fixtures ${Date.now()}`)
  log(`builder ${feature} ${process.cwd()}`)
  log(`history ${feature} ${process.env.BENCH_HISTORY || '-'} ${process.env.BENCH_CONTROL || '-'}`)
  await sleep(unit)
  const dir = join(process.cwd(), 'bench', 'results', `9999-12-31-2359-${feature}`)
  mkdirSync(dir, { recursive: true })
  const run = { config: 'builder', status: 'done', ms: 180000, sessions: [{ name: 'fleet', totals: { ms: 180000, turns: 7, costUsd: 0.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 0 } } }] }
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ feature, runs: [run] }))
  log(`end ${feature} ${Date.now()}`)
  process.exit(0)
}

const id = argv[0]
const local = process.env.BENCH_LOCAL
const c = JSON.parse(readFileSync(join(local, 'cases', `${id}.json`), 'utf8'))
if (argv.includes('--dry-run')) {
  appendFileSync(join(process.env.STUB_STATE, 'dry.log'), `replan ${id} ${argv.includes('--replan')}\n`)
  const pf = join(local, 'projects', `${c.project}.json`)
  const profile = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : {}
  const refusals = profile.builderMd ? safetyRefusals(profile.builderMd, profile) : []
  if (refusals.length) {
    for (const r of refusals) console.error(`refused: ${r}`)
    process.exit(2)
  }
  const ports = portsNamed(frontMatterText(profile.builderMd ?? ''))
  const warnings = profile.builderMd ? bodyWarnings(profile.builderMd, profile) : []
  const replan = argv.includes('--replan') ? [`  replan: ${ids(process.env.STUB_REPLAN_AUDITED).includes(id) ? 'from-audited' : 'prefix (1 commit)'}`] : []
  console.log([`${id} — dry run`, ...replan, `  ports:  ${ports.length ? ports.join(' ') : '(none)'}`, ...warnings.map((w) => `  ${w}`)].join('\n'))
  process.exit(0)
}
const out = opt('--out')
// like bench-case: SIGTERM writes result.json `failed: stopped` and exits 0
process.on('SIGTERM', () => {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'result.json'), JSON.stringify({ id, size: c.size, kind: 'archived', project: c.project, control: false, status: 'failed: stopped', measure: null, baseline: null, specLines: null, planLines: null, estimate: c.estimate ?? null }))
  log(`stopped ${id} ${Date.now()}`)
  process.exit(0)
})
log(`start ${id} ${c.project} ${Date.now()}`)
log(`builder ${id} ${opt('--builder')}`)
log(`replan ${id} ${argv.includes('--replan')}`)
log(`timeout ${id} ${process.env.BENCH_CASE_FLEET_TIMEOUT_MS ?? '-'}`)
log(`clone-root ${id} ${opt('--clone-root') ?? '-'}`)
const minutes = c.estimate?.minutes ?? 1
await sleep(unit * minutes * (ids(process.env.STUB_CASE_LONG).includes(id) ? 10 : 1))
if (ids(process.env.STUB_CASE_DIE).includes(id)) process.exit(1)
mkdirSync(out, { recursive: true })
const measure = { wallMs: minutes * 60000, costUsd: c.estimate?.usd ?? null, turns: 3, tokens: 1000, stages: { build: minutes * 60000 }, byKind: null, quality: null }
writeFileSync(join(out, 'result.json'), JSON.stringify({ id, size: c.size, kind: 'archived', project: c.project, control: false, status: 'done', ...(argv.includes('--replan') ? { replan: ids(process.env.STUB_REPLAN_AUDITED).includes(id) ? 'from-audited' : 'prefix' } : {}), measure, baseline: null, specLines: 10, planLines: 20, estimate: c.estimate ?? null }))
log(`end ${id} ${Date.now()}`)
