#!/usr/bin/env node
// A stand-in for bench-case.mjs (and, given `run <feature> --only builder`, for bench.mjs on a fixture).
// Case mode: `<id> --builder <b> --out <dir> [--dry-run]` reads $BENCH_LOCAL/cases/<id>.json. A dry run
// refuses (exit 2) on the safety check of its profile's `builderMd`, if it has one. A run sleeps
// STUB_CASE_MS × the case's estimated minutes (10× for an id in STUB_CASE_LONG), then writes
// <out>/result.json; STUB_CASE_DIE (ids) exits 1 instead, writing nothing.
// Fixture mode writes <cwd>/bench/results/<stamp>-<feature>/runs.json with one done builder run.
// Both append `start <id> <project> <t>`, `builder <id> <path>` and `end <id> <t>` to $STUB_STATE/case.log.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { safetyRefusals } from '../../../bench-suite-core.mjs'

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
  const pf = join(local, 'projects', `${c.project}.json`)
  const profile = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : {}
  const refusals = profile.builderMd ? safetyRefusals(profile.builderMd, profile) : []
  if (refusals.length) {
    for (const r of refusals) console.error(`refused: ${r}`)
    process.exit(2)
  }
  console.log(`${id} — dry run`)
  process.exit(0)
}
const out = opt('--out')
log(`start ${id} ${c.project} ${Date.now()}`)
log(`builder ${id} ${opt('--builder')}`)
const minutes = c.estimate?.minutes ?? 1
await sleep(unit * minutes * (ids(process.env.STUB_CASE_LONG).includes(id) ? 10 : 1))
if (ids(process.env.STUB_CASE_DIE).includes(id)) process.exit(1)
mkdirSync(out, { recursive: true })
const measure = { wallMs: minutes * 60000, costUsd: c.estimate?.usd ?? null, turns: 3, tokens: 1000, stages: { build: minutes * 60000 }, byKind: null, quality: null }
writeFileSync(join(out, 'result.json'), JSON.stringify({ id, size: c.size, kind: 'archived', project: c.project, control: false, status: 'done', measure, baseline: null, specLines: 10, planLines: 20, estimate: c.estimate ?? null }))
log(`end ${id} ${Date.now()}`)
