#!/usr/bin/env node
/**
 * test-bench — measure one verify: suite the way the verifier runs it, with no agents (spec
 * docs/specs/2026-11-23-test-efficiency-bench-design.md, E1–E3).
 *
 *   node <plugin>/scripts/test-bench.mjs floor      --suite <name> [--reps 3]
 *   node <plugin>/scripts/test-bench.mjs contention --suite <name> [--levels 1,2,3,4]
 *   node <plugin>/scripts/test-bench.mjs serial     --suite <name> [--files 40]
 *     common: [--repo <main checkout>] [--sha <rev>] [--timeout 60m] [--force] [--json]
 *
 * Runs in its own checkouts (<repo>-bench/co/<n>), with the same setup, database template, leases
 * and runner command the verifier uses, at one sha (default: the target's tip). Refuses while the
 * repo's verifier or fleet is running, whose load would be measured too — --force runs anyway and
 * marks the row. Each run appends a row to <repo>/.builder/bench/test-bench.jsonl.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadVerify, durationMs } from './verify/config.mjs'
import { loadConfig } from './config.mjs'
import { ADAPTERS } from './verify/adapters.mjs'
import { createPool, inputsHash, psql } from './verify/envpool.mjs'
import { checkoutAt, copyLocal, setupIfNeeded } from './verify/checkouts.mjs'
import { runShell, starved } from './verify/run.mjs'
import { fromCwd } from './verify/select.mjs'
import { globToRegExp } from './impact.mjs'
import { git, tryGit, sh } from './verify/git.mjs'
import { summarizeFloor, summarizeContention, summarizeSerial, spread, renderBench } from './test-bench-core.mjs'
import { mainCheckout } from './test-cost.mjs'

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** What else is running on this repo right now — its load would be in the numbers. */
export function busy(root) {
  const out = []
  const reqDir = join(root, '.builder', 'verify', 'requests')
  if (existsSync(reqDir)) {
    const live = readdirSync(reqDir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        return JSON.parse(readFileSync(join(reqDir, f), 'utf8'))
      } catch {
        return null
      }
    }).filter((r) => r && (r.state === 'running' || r.state === 'queued'))
    if (live.length) out.push(`the verifier has ${live.length} request(s) queued or running`)
  }
  const lock = join(root, '.builder', 'fleet', 'lock')
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    if (pid && pidAlive(pid)) out.push(`a fleet is running (pid ${pid})`)
  }
  return out
}

function checkout(root, i, sha) {
  const path = join(`${root}-bench`, 'co', String(i))
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(join(`${root}-bench`, 'co'), { recursive: true })
    tryGit(root, 'worktree', 'prune')
    git(root, 'worktree', 'add', '--detach', '-f', path, sha)
  }
  checkoutAt(path, sha)
  return path
}

const parseReport = (adapter, report, cwd) => {
  if (!existsSync(report)) return []
  try {
    return adapter.parse(readFileSync(report, 'utf8'), { root: cwd })
  } catch {
    return []
  }
}

async function main(argv) {
  const exp = argv[0]
  if (!['floor', 'contention', 'serial'].includes(exp)) throw new Error('usage: test-bench.mjs floor|contention|serial --suite <name> [--repo <path>] [--sha <rev>] [--reps N] [--levels 1,2,3,4] [--files N] [--timeout 60m] [--force] [--json]')
  const opt = (name, d = null) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : d
  }
  const root = resolve(opt('--repo') ?? mainCheckout(process.cwd()))
  const lv = loadVerify(root)
  if (!lv.ok) throw new Error(lv.reason)
  const verify = { ...lv.verify, timeoutMs: durationMs(opt('--timeout'), Math.max(lv.verify.timeoutMs, 60 * 60000)) }
  const suite = verify.suites.find((s) => s.name === opt('--suite'))
  if (!suite) throw new Error(`--suite: one of ${verify.suites.map((s) => s.name).join(', ')}`)
  const adapter = ADAPTERS[suite.runner]
  const cfg = loadConfig(root)
  const target = cfg.ok ? cfg.mergeInto ?? cfg.baseBranch ?? 'main' : 'main'
  const sha = git(root, 'rev-parse', opt('--sha') ?? `refs/heads/${target}`)
  const others = busy(root)
  if (others.length && !argv.includes('--force')) throw new Error(`refused: ${others.join('; ')} — its load would be measured too. Wait for it, or --force (the row is marked)`)

  const pool = createPool(verify)
  const sample = verify.db ? () => Number(psql(verify.db.url, 'SELECT count(*) FROM pg_stat_activity')) || 0 : () => 0
  const prepared = new Map()
  const prepare = (i) => {
    if (prepared.has(i)) return prepared.get(i)
    const path = checkout(root, i, sha)
    copyLocal(root, path, cfg.ok ? cfg.agentWalk?.copy ?? [] : [])
    setupIfNeeded(path, verify, (cmd) => sh(cmd, { cwd: path, timeout: verify.timeoutMs }))
    const template = suite.needs.some((n) => n.kind === 'db') ? pool.ensureTemplate(path, inputsHash(path, verify.db.inputs)) : null
    prepared.set(i, { path, template })
    return prepared.get(i)
  }
  const tmp = join(root, '.builder', 'bench', 'reports')
  mkdirSync(tmp, { recursive: true })
  let n = 0

  /** One run of the suite (all its files, or `files`) in checkout i, as runSuite in verify/run.mjs runs it. */
  const runOnce = async (i, files = 'all') => {
    const { path, template } = prepare(i)
    const cwd = join(path, suite.cwd)
    const report = adapter.reportPath ? adapter.reportPath(suite, cwd) : join(tmp, `${process.pid}-${++n}-${suite.name}.out`)
    rmSync(report, { force: true })
    const lease = await pool.lease(suite.needs, { template, cwd })
    if (!lease) throw new Error(`no lease for ${suite.name}: raise verify.db.max (or verify.env.max) to at least the runs at once`)
    const baseConn = sample()
    let peakConn = baseConn
    const timer = setInterval(() => {
      try {
        peakConn = Math.max(peakConn, sample())
      } catch {}
    }, 1000)
    const t0 = Date.now()
    try {
      const whole = files === 'all' && suite.runner === 'junit' && suite.files ? fromCwd(suite.cwd, listFiles(path)) : null
      const cmd = adapter.command({ suite, files: files === 'all' ? whole : fromCwd(suite.cwd, files), grep: null, pairs: null, report })
      const r = await runShell(cmd, { cwd, env: { ...process.env, ...lease.env }, timeoutMs: verify.timeoutMs, ...(adapter.errorLines && { lines: adapter.errorLines }) })
      const wallMs = Date.now() - t0
      const rows = parseReport(adapter, report, cwd)
      const byFile = {}
      for (const x of rows) byFile[x.file] = (byFile[x.file] ?? 0) + (x.ms ?? 0)
      const why = r.timedOut ? starved(adapter, report, cwd) : ''
      const starvedN = rows.filter((x) => x.status === 'fail' && /too many (database )?connections|too many clients|remaining connection slots/i.test(x.msg ?? '')).length
      return { run: { wallMs, timedOut: r.timedOut, code: r.code, tests: rows.length, pass: rows.filter((x) => x.status === 'pass').length, fail: rows.filter((x) => x.status === 'fail').length, starved: starvedN, files: byFile, peakConn, baseConn, why }, rows: rows.map((x) => ({ id: `${x.file}::${x.name}`, status: x.status })) }
    } finally {
      clearInterval(timer)
      lease.release()
      rmSync(report, { force: true })
    }
  }
  const listFiles = (path) => {
    const re = suite.files ? globToRegExp(suite.cwd && suite.cwd !== '.' ? posix.join(suite.cwd, suite.files) : suite.files) : null
    return (tryGit(path, 'ls-files', '-z') ?? '').split('\0').filter((t) => t && (!re || re.test(t)))
  }

  const at = new Date().toISOString()
  const meta = { repo: root.split('/').pop(), root, suite: suite.name, sha, at, forced: others.length ? others : undefined, machine: { cores: (await import('node:os')).cpus().length } }
  let sum
  if (exp === 'floor') {
    const reps = Number(opt('--reps', 3))
    const runs = [], results = []
    for (let k = 0; k < reps; k++) {
      const { run, rows } = await runOnce(0)
      runs.push(run)
      results.push(rows)
      console.error(`floor ${k + 1}/${reps}: ${(run.wallMs / 1000).toFixed(1)}s${run.timedOut ? ' (cut)' : ''}`)
    }
    sum = { ...summarizeFloor(runs, results), runs: runs.map(({ files, ...r }) => r) }
  } else if (exp === 'contention') {
    const levels = String(opt('--levels', '1,2,3,4')).split(',').map(Number).filter((x) => x > 0)
    if (verify.db) verify.db.max = Math.max(verify.db.max, ...levels) // the bench's own leases, not the service's
    for (let i = 0; i < Math.max(...levels); i++) prepare(i) // set up every checkout before any timing
    const out = []
    for (const lvl of levels) {
      const runs = (await Promise.all(Array.from({ length: lvl }, (_, i) => runOnce(i)))).map((x) => x.run)
      out.push({ n: lvl, runs })
      console.error(`contention ${lvl}: ${runs.map((r) => `${(r.wallMs / 1000).toFixed(1)}s`).join(' ')}`)
    }
    sum = { ...summarizeContention(out), levels: out.map(({ n, runs }) => ({ n, runs: runs.map(({ files, ...r }) => r) })) }
  } else {
    const all = listFiles(prepare(0).path)
    const picked = spread(all, opt('--files') ? Number(opt('--files')) : null)
    const whole = (await runOnce(0)).run
    console.error(`serial: whole suite ${(whole.wallMs / 1000).toFixed(1)}s`)
    const alone = []
    for (const [k, f] of picked.entries()) {
      const { run } = await runOnce(0, [f])
      alone.push({ file: f, wallMs: run.wallMs, timedOut: run.timedOut })
      if ((k + 1) % 10 === 0) console.error(`serial: ${k + 1}/${picked.length} files alone`)
    }
    sum = { ...summarizeSerial({ wholeMs: whole.wallMs, alone, totalFiles: all.length }), whole: { ...whole, files: undefined } }
  }
  const row = { exp, ...meta, ...sum }
  mkdirSync(join(root, '.builder', 'bench'), { recursive: true })
  appendFileSync(join(root, '.builder', 'bench', 'test-bench.jsonl'), JSON.stringify(row) + '\n')
  return argv.includes('--json') ? JSON.stringify(row, null, 2) : renderBench(exp, meta, sum) + (meta.forced ? `\n⚠ run with --force while ${meta.forced.join('; ')}\n` : '')
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  main(process.argv.slice(2))
    .then((out) => console.log(out))
    .catch((e) => {
      console.error(`test-bench: ${e.message}`)
      process.exit(2)
    })
}
