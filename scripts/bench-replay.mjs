#!/usr/bin/env node
// scripts/bench-replay.mjs
/**
 * The gate replay (spec §Benchmark 1): each archived feature's real commits, in a scratch clone,
 * through the old gates (control: gate.mjs from a checkout of builder's main) and through the
 * verifier (treatment: this checkout's scripts/verify), on the same machine. No models run.
 *
 *   node scripts/bench-replay.mjs <repo> --verify <verify block file> --control <builder main checkout>
 *        [--features a,b] [--setup "<cmd>"] [--env KEY=VAL]… [--out <dir>]
 *        [--before "<cmd>"] [--timeout-min 60] [--max-wait-min 60] [--keep] [--no-carry]
 *
 * <repo> is read, never written: everything happens in a clone under $TMPDIR. --verify holds the
 * repo's `verify:` block (from scripts/verify/migrate.mjs, reviewed); --env points both sides at a
 * scratch database, never a dev one. --out defaults to a fresh dir under $TMPDIR and may not be inside
 * <repo>. Every child process is bounded (--timeout-min; a request's whole wait --max-wait-min); a
 * feature that errors is recorded in REPORT.md and the run goes on. Scratch clones are removed unless --keep.
 * Each feature's verifier starts with what the earlier ones learned (the target's known failures and the flake
 * list, copied via <out>/carry/) as the repo's persistent .builder/verify/ would hold them; --no-carry starts each empty.
 * --before runs in the scratch clone after each control point's checkout (and the post-merge one), before the gate,
 * with the gates' env: it stands for the migrations an implementer ran during the original build to keep the
 * control's test database on the branch's schema. Its time is not blocking (recorded as beforeMs, and as
 * "control prep (untimed)" in REPORT.md); a non-zero exit records that point as unrun and skips its gate.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from './verify/git.mjs'
import { verifyDir } from './verify/ledger.mjs'
import { featureRange, phaseBoundaries, controlPoints, touchedApps, normPath, summarize, isInside, saveCarry, seedCarry, verdictOf } from './bench-replay-core.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null)
const many = (f) => argv.flatMap((a, i) => (argv[i - 1] === f ? [a] : []))
const repo = resolve(argv[0] ?? '')
const verifyFile = opt('--verify')
const controlRoot = opt('--control')
if (!argv[0] || !verifyFile || !controlRoot) {
  console.error('usage: bench-replay.mjs <repo> --verify <file> --control <builder main checkout> [--features a,b] [--setup "<cmd>"] [--env KEY=VAL]… [--before "<cmd>"] [--out <dir>]')
  process.exit(2)
}
const env = { ...process.env, ...Object.fromEntries(many('--env').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])), BUILDER_VERIFY_IDLE_MS: '5000' }
const realRepo = realpathSync(repo)
const out = resolve(opt('--out') ?? join(tmpdir(), `builder-replay-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}`))
if (isInside(realRepo, out) || isInside(repo, out)) {
  console.error(`--out ${out} is inside ${repo}; the replay never writes to the repo it reads`)
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const only = opt('--features')?.split(',') ?? null
const timeoutMs = Number(opt('--timeout-min') ?? 60) * 60000
const maxWaitMs = Number(opt('--max-wait-min') ?? 60) * 60000
const rows = readFileSync(join(repo, '.builder', 'fleet', 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.merged && (!only || only.includes(r.feature)))

const timed = (cmd, args, cwd) => {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' })
  return { ms: Date.now() - t0, status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) }
}
const verify = (cwd, ...a) => timed(process.execPath, [join(HERE, 'verify', 'verify.mjs'), ...a], cwd)
// Exits that carry a verdict: green, red, env-broken, conflict, cancelled. 75 means still going; anything else is terminal and has none.
const VERDICT_EXIT = new Set([0, 1, 3, 4, 6])
const requestAndWait = (wt, tier, extra = []) => {
  const t0 = Date.now()
  const req = verify(wt, 'request', wt, 'HEAD', '--tier', tier, '--target', 'replay-target', ...extra)
  if (req.status !== 0) return { ms: Date.now() - t0, error: `request exited ${req.status}: ${req.out.trim().split('\n').pop()}` }
  const id = req.out.trim().split('\n').pop()
  for (;;) {
    const w = verify(wt, 'wait', id, '--max', '540', '--json')
    if (w.status === 75) {
      if (Date.now() - t0 < maxWaitMs) continue
      verify(wt, 'cancel', id)
      return { ms: Date.now() - t0, error: `no verdict after ${Math.round(maxWaitMs / 60000)}m` }
    }
    if (!VERDICT_EXIT.has(w.status)) return { ms: Date.now() - t0, error: `wait exited ${w.status}: ${w.out.trim().split('\n').pop()}` }
    const verdict = verdictOf(w.stdout)
    return verdict ? { ms: Date.now() - t0, verdict } : { ms: Date.now() - t0, error: `verdict was not JSON: ${w.out.trim().split('\n').pop()}` }
  }
}

function replay(row, dir) {
  const range = featureRange(repo, row.merged)
  const clone = join(dir, 'repo')
  execFileSync('git', ['clone', '-q', '--no-local', repo, clone])
  git(clone, 'checkout', '-q', '--detach', range.base)
  git(clone, 'branch', 'replay-target', range.base)
  const cfgText = git(clone, 'show', `${range.base}:.claude/builder.md`)
  const apps = [...cfgText.matchAll(/^\s*-\s*name:\s*(\S+)\s*\n\s*path:\s*(\S+)/gm)].map((m) => ({ name: m[1], path: normPath(m[2]) }))
  const registry = /^registry:\s*(\S+)/m.exec(cfgText)?.[1] ?? 'docs/features'
  const commits = range.commits.map((sha) => ({ sha, files: git(clone, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean) }))
  const bounds = phaseBoundaries(commits, apps, registry)

  // Control: the old gates where 5.x ran them, foreground — all of it blocking, setup included.
  // A run that neither passed nor failed (exit 2, a signal, a timeout) is `unrun`: counted apart, its time not blocking.
  const control = { runs: [], blockingMs: 0, reds: 0, unrun: 0 }
  if (opt('--setup')) {
    const s = timed('/bin/bash', ['-c', opt('--setup')], clone)
    if (s.status !== 0) throw new Error(`setup exited ${s.status}: ${s.out.trim().split('\n').pop()}`)
    control.setupMs = s.ms
    control.blockingMs += s.ms
  }
  const gate = (label, sha, args) => {
    let beforeMs
    if (opt('--before')) {
      const b = timed('/bin/bash', ['-c', opt('--before')], clone)
      beforeMs = b.ms
      control.prepMs = (control.prepMs ?? 0) + b.ms
      if (b.status !== 0) {
        control.runs.push({ label, sha: sha.slice(0, 7), ms: 0, beforeMs, status: null, unrun: `--before exited ${b.status}: ${b.out.trim().split('\n').pop()}` })
        control.unrun++
        return
      }
    }
    const r = timed(process.execPath, [join(controlRoot, 'scripts', 'gate.mjs'), ...args, '--force'], clone)
    // Output kept for red and unrun points only: the clone is gone by the time anyone asks why.
    control.runs.push({ label, sha: sha.slice(0, 7), ms: r.ms, ...(beforeMs === undefined ? {} : { beforeMs }), status: r.status, ...(r.status === 0 ? {} : { out: r.out.slice(-1500) }) })
    if (r.status === 0 || r.status === 1) control.blockingMs += r.ms
    else control.unrun++
    if (r.status === 1) control.reds++
  }
  for (const p of controlPoints(bounds, range.commits, apps)) {
    git(clone, 'checkout', '-q', '--detach', '--force', p.sha)
    gate(p.label, p.sha, p.args)
  }
  git(clone, 'checkout', '-q', '--detach', '--force', range.base)
  git(clone, 'merge', '-q', '--no-ff', '-m', 'replay merge', range.tip)
  gate('post-merge', git(clone, 'rev-parse', 'HEAD'), touchedApps(bounds, apps))

  // Treatment: the verifier, fed the same commits.
  git(clone, 'checkout', '-q', '--detach', '--force', range.base)
  const block = readFileSync(verifyFile, 'utf8').trimEnd()
  writeFileSync(join(clone, '.claude', 'builder.md'), cfgText.replace(/\n---\n/, `\n${block}\n---\n`))
  const wt = join(dir, 'wt')
  git(clone, 'worktree', 'add', '-q', '-b', 'replay', wt, range.base)
  const carryDir = join(out, 'carry')
  // Features run in archive order; 'replay-target' is the same branch name in every clone, so its known list applies as is.
  const carriedIn = argv.includes('--no-carry') ? 0 : seedCarry(carryDir, verifyDir(clone))
  const treatment = { carriedIn, requests: [], blockingMs: 0, backgroundMs: 0, regressions: 0, flakes: 0, known: 0, debt: 0, broken: 0, errors: 0 }
  const note = (tier, r) => {
    if (tier === 'commit') treatment.backgroundMs += r.ms
    else treatment.blockingMs += r.ms
    const v = r.verdict
    if (!v) {
      treatment.errors++
      treatment.requests.push({ tier, ms: r.ms, error: r.error })
      return
    }
    treatment.requests.push({ tier, sha: String(v.sha).slice(0, 7), ms: r.ms, status: v.status, broken: v.broken, regressions: v.regressions.map((g) => ({ id: g.id, msg: String(g.msg ?? '').slice(0, 300), introducedBy: g.introducedBy })), flakes: v.flakes, known: v.known, debt: v.debt })
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
  if (!argv.includes('--no-carry')) saveCarry(verifyDir(clone), carryDir)
  return { feature: row.feature, commits: range.commits.length, phases: bounds.length, control, treatment }
}

const results = []
for (const row of rows) {
  const dir = mkdtempSync(join(tmpdir(), `replay-${row.feature}-`))
  let result
  try {
    result = replay(row, dir)
    console.log(`${row.feature}: old ${Math.round(result.control.blockingMs / 60000)}m blocking, ${result.control.reds} red, ${result.control.unrun} unrun · verifier ${Math.round(result.treatment.blockingMs / 60000)}m blocking + ${Math.round(result.treatment.backgroundMs / 60000)}m background${result.treatment.errors ? `, ${result.treatment.errors} request errors` : ''}`)
  } catch (e) {
    result = { feature: row.feature, error: String(e.message ?? e).split('\n')[0] }
    console.error(`${row.feature}: errored — ${result.error}`)
  } finally {
    if (!argv.includes('--keep')) rmSync(dir, { recursive: true, force: true })
  }
  writeFileSync(join(out, `${row.feature}.json`), JSON.stringify(result, null, 2) + '\n')
  results.push(result)
}
const prepMs = results.reduce((n, r) => n + (r.control?.prepMs ?? 0), 0)
const prepFooter = opt('--before') ? `\ncontrol prep (untimed): ${Math.round(prepMs / 60000)}m\n` : ''
writeFileSync(join(out, 'REPORT.md'), `# Gate replay — ${new Date().toISOString().slice(0, 10)}\n\n${summarize(results)}\n${prepFooter}`)
console.log(`report: ${join(out, 'REPORT.md')}`)
