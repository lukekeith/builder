#!/usr/bin/env node
// scripts/bench-replay.mjs
/**
 * The gate replay (spec §Benchmark 1): each archived feature's real commits, in a scratch clone,
 * through the old gates (control: gate.mjs from a checkout of builder's main) and through the
 * verifier (treatment: this checkout's scripts/verify), on the same machine. No models run.
 *
 *   node scripts/bench-replay.mjs <repo> --verify <verify block file> --control <builder main checkout>
 *        [--features a,b] [--setup "<cmd>"] [--env KEY=VAL]… [--out <dir>]
 *
 * <repo> is read, never written: everything happens in a clone under $TMPDIR. --verify holds the
 * repo's `verify:` block (from scripts/verify/migrate.mjs, reviewed); --env points both sides at a
 * scratch database, never a dev one.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from './verify/git.mjs'
import { featureRange, phaseBoundaries, controlPoints, summarize } from './bench-replay-core.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null)
const many = (f) => argv.flatMap((a, i) => (argv[i - 1] === f ? [a] : []))
const repo = resolve(argv[0] ?? '')
const verifyFile = opt('--verify')
const controlRoot = opt('--control')
if (!argv[0] || !verifyFile || !controlRoot) {
  console.error('usage: bench-replay.mjs <repo> --verify <file> --control <builder main checkout> [--features a,b] [--setup "<cmd>"] [--env KEY=VAL]… [--out <dir>]')
  process.exit(2)
}
const env = { ...process.env, ...Object.fromEntries(many('--env').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])), BUILDER_VERIFY_IDLE_MS: '5000' }
const out = resolve(opt('--out') ?? join(repo, '.builder', 'bench', `replay-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`))
mkdirSync(out, { recursive: true })
const only = opt('--features')?.split(',') ?? null
const rows = readFileSync(join(repo, '.builder', 'fleet', 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.merged && (!only || only.includes(r.feature)))

const timed = (cmd, args, cwd) => {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ms: Date.now() - t0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) }
}
const verify = (cwd, ...a) => timed(process.execPath, [join(HERE, 'verify', 'verify.mjs'), ...a], cwd)
const requestAndWait = (wt, tier, extra = []) => {
  const id = verify(wt, 'request', wt, 'HEAD', '--tier', tier, '--target', 'replay-target', ...extra).out.trim().split('\n').pop()
  const t0 = Date.now()
  let w
  do w = verify(wt, 'wait', id, '--max', '540', '--json')
  while (w.status === 75)
  return { ms: Date.now() - t0, verdict: JSON.parse(w.out.slice(w.out.indexOf('{'))) }
}

const results = []
for (const row of rows) {
  let range
  try {
    range = featureRange(repo, row.merged)
  } catch (e) {
    console.error(`${row.feature}: skipped — ${e.message}`)
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), `replay-${row.feature}-`))
  const clone = join(dir, 'repo')
  execFileSync('git', ['clone', '-q', '--no-local', repo, clone])
  git(clone, 'checkout', '-q', '--detach', range.base)
  git(clone, 'branch', 'replay-target', range.base)
  const cfgText = git(clone, 'show', `${range.base}:.claude/builder.md`)
  const apps = [...cfgText.matchAll(/^\s*-\s*name:\s*(\S+)\s*\n\s*path:\s*(\S+)/gm)].map((m) => ({ name: m[1], path: m[2] }))
  const registry = /^registry:\s*(\S+)/m.exec(cfgText)?.[1] ?? 'docs/features'
  const commits = range.commits.map((sha) => ({ sha, files: git(clone, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean) }))
  const bounds = phaseBoundaries(commits, apps, registry)
  if (opt('--setup')) timed('/bin/bash', ['-c', opt('--setup')], clone)

  // Control: the old gates where 5.x ran them, foreground — all of it blocking.
  const control = { runs: [], blockingMs: 0, reds: 0 }
  for (const p of controlPoints(bounds, range.commits, apps)) {
    git(clone, 'checkout', '-q', '--detach', '--force', p.sha)
    const r = timed(process.execPath, [join(controlRoot, 'scripts', 'gate.mjs'), ...p.args, '--force'], clone)
    control.runs.push({ label: p.label, sha: p.sha.slice(0, 7), ms: r.ms, status: r.status })
    control.blockingMs += r.ms
    if (r.status === 1) control.reds++
  }
  const merged = (() => {
    git(clone, 'checkout', '-q', '--detach', '--force', range.base)
    git(clone, 'merge', '-q', '--no-ff', '-m', 'replay merge', range.tip)
    return git(clone, 'rev-parse', 'HEAD')
  })()
  const post = timed(process.execPath, [join(controlRoot, 'scripts', 'gate.mjs'), ...bounds.map((b) => b.app).filter((a, i, xs) => xs.indexOf(a) === i), '--force'], clone)
  control.runs.push({ label: 'post-merge', sha: merged.slice(0, 7), ms: post.ms, status: post.status })
  control.blockingMs += post.ms
  if (post.status === 1) control.reds++

  // Treatment: the verifier, fed the same commits.
  git(clone, 'checkout', '-q', '--detach', '--force', range.base)
  const block = readFileSync(verifyFile, 'utf8').trimEnd()
  writeFileSync(join(clone, '.claude', 'builder.md'), cfgText.replace(/\n---\n/, `\n${block}\n---\n`))
  const wt = join(dir, 'wt')
  git(clone, 'worktree', 'add', '-q', '-b', 'replay', wt, range.base)
  const treatment = { requests: [], blockingMs: 0, backgroundMs: 0, regressions: 0, flakes: 0, known: 0, debt: 0, broken: 0 }
  const note = (tier, r) => {
    const v = r.verdict
    treatment.requests.push({ tier, sha: String(v.sha).slice(0, 7), ms: r.ms, status: v.status, regressions: v.regressions.map((g) => g.id), flakes: v.flakes, known: v.known, debt: v.debt })
    if (tier === 'commit') treatment.backgroundMs += r.ms
    else treatment.blockingMs += r.ms
    treatment.regressions += v.regressions.length
    treatment.flakes += v.flakes.length
    treatment.known += v.known.length
    treatment.debt += v.debt.length
    treatment.broken += v.broken.length
  }
  const ends = new Set(bounds.map((b) => b.index))
  range.commits.forEach((sha, i) => {
    git(wt, 'reset', '-q', '--hard', sha)
    note('commit', requestAndWait(wt, 'commit'))
    if (ends.has(i)) note('phase', requestAndWait(wt, 'phase'))
  })
  note('merge', requestAndWait(wt, 'merge', ['--hold']))

  const result = { feature: row.feature, commits: range.commits.length, phases: bounds.length, control, treatment }
  writeFileSync(join(out, `${row.feature}.json`), JSON.stringify(result, null, 2) + '\n')
  results.push(result)
  console.log(`${row.feature}: old ${Math.round(control.blockingMs / 60000)}m blocking, ${control.reds} red · verifier ${Math.round(treatment.blockingMs / 60000)}m blocking + ${Math.round(treatment.backgroundMs / 60000)}m background`)
}
writeFileSync(join(out, 'REPORT.md'), `# Gate replay — ${new Date().toISOString().slice(0, 10)}\n\n${summarize(results)}\n`)
console.log(`report: ${join(out, 'REPORT.md')}`)
