// scripts/verify/run.mjs
/**
 * One request, in one checkout → its verdict (spec §The flow, §Judging a failure). Checks first,
 * then each suite's selected files (all of them at the merge tier); every failing test is judged by
 * classify(); a run with no report is retried once in a fresh lease and is env-broken after that.
 */
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, posix } from 'node:path'
import { spawn } from 'node:child_process'
import { ADAPTERS } from './adapters.mjs'
import { classify } from './classify.mjs'
import { fromCwd } from './select.mjs'
import { inputsHash } from './envpool.mjs'
import { globToRegExp } from '../impact.mjs'
import { tryGit } from './git.mjs'

export function runShell(cmd, { cwd, env = process.env, timeoutMs = 0, signal = null } = {}) {
  return new Promise((resolve) => {
    // An already-aborted signal never fires 'abort': a cancelled run starts nothing more.
    if (signal?.aborted) return resolve({ code: 1, timedOut: false, out: 'cancelled' })
    // A `node --test` child that inherits NODE_TEST_CONTEXT from a parent running under `node --test`
    // reports to that parent instead of writing its own report — so the child never sees it.
    const childEnv = { ...env }
    delete childEnv.NODE_TEST_CONTEXT
    const p = spawn('/bin/bash', ['-c', cmd], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (b) => {
      out = (out + b).slice(-20000)
    }
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    let timedOut = false
    const kill = () => {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    }
    const t = timeoutMs ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : null
    signal?.addEventListener('abort', kill, { once: true })
    p.on('close', (code) => {
      if (t) clearTimeout(t)
      // A long-lived signal outlives many runs: a listener left behind would pile up and SIGKILL a
      // process group id the OS has since handed to someone else.
      signal?.removeEventListener('abort', kill)
      resolve({ code: code ?? 1, timedOut, out })
    })
  })
}

/**
 * A report's file as a repo path. Playwright's JUnit names files relative to its testDir, so the
 * suite's cwd + that name may not be the test: it is taken only when it exists and the suite's glob
 * covers it. Else the one tracked file of the glob ending in the name is the real one. Ambiguous or
 * unfound: the name as reported (joined with cwd), as before.
 */
function repoFile(suite, where, file, tracked) {
  const joined = suite.cwd === '.' ? file : posix.join(suite.cwd, file)
  if (existsSync(join(where, joined)) && tracked.covers(joined)) return joined
  const hits = tracked.list().filter((t) => t.endsWith(`/${file}`) && (suite.cwd === '.' || t.startsWith(`${suite.cwd}/`)))
  return hits.length === 1 ? hits[0] : joined
}

/** The suite's glob, and the checkout's tracked files it matches (all of them with no glob), listed once, on first use. */
function lazyTracked(suite, where) {
  const re = suite.files ? globToRegExp(suite.cwd && suite.cwd !== '.' ? posix.join(suite.cwd, suite.files) : suite.files) : null
  let list = null
  return {
    covers: (p) => !re || re.test(p),
    list: () => (list ??= (tryGit(where, 'ls-files', '-z') ?? '').split('\0').filter((t) => t && (!re || re.test(t)))),
  }
}

export const testId = (suite, r) => `${suite}::${r.file}::${r.name}`

/** Walks the range oldest first; ends with the checkout back at the range's last commit. */
export async function bisect(regs, commits, { atCommit, statusAt, signal = null }) {
  for (const g of regs) g.introducedBy = null
  for (const sha of commits) {
    if (signal?.aborted) break
    const open = regs.filter((g) => !g.introducedBy)
    if (!open.length) break
    await atCommit(sha)
    for (const g of open) {
      if (signal?.aborted) break
      if ((await statusAt(g)) === 'fail') g.introducedBy = sha
    }
  }
  for (const g of regs) g.introducedBy ??= commits.at(-1)
  if (commits.length) await atCommit(commits.at(-1))
}

const linesOf = (out, match) => {
  const re = match ? new RegExp(match) : null
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && (!re || re.test(l))),
  )
}

export async function runRequest(req, ctx) {
  // Report files for this request; removed however the run ends, a throw included.
  const tmp = join(ctx.ledger.dir, 'reports', req.id)
  mkdirSync(tmp, { recursive: true })
  try {
    return await judgeRequest(req, ctx, tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function judgeRequest(req, ctx, tmp) {
  const { verify, pool, ledger, checkout, signal } = ctx
  const t0 = Date.now()
  const verdict = { request: req.id, branch: req.branch, sha: req.sha, tier: req.tier, status: 'green', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0 }
  const rows = []
  let n = 0
  const known = ledger.known(req.target).ids
  const owns = req.changed ?? []
  const branchOwns = (file) => Boolean(file) && owns.some((c) => c === file || c.endsWith(`/${file}`) || file.endsWith(`/${c}`))
  const env = (lease) => ({ ...process.env, ...(ctx.baseEnv ?? {}), ...lease.env })
  const templateFor = (needs, where) => (needs.some((x) => x.kind === 'db') ? pool.ensureTemplate(where, inputsHash(where, verify.db.inputs)) : null)

  const runSuite = async (suite, files, { where = checkout, grep = null } = {}) => {
    // Once cancelled, nothing more is leased or run.
    if (signal?.aborted) return { results: null, reason: 'cancelled' }
    const adapter = ADAPTERS[suite.runner]
    const cwd = join(where, suite.cwd)
    const report = adapter.reportPath ? adapter.reportPath(suite, cwd) : join(tmp, `${++n}-${suite.name}.out`)
    rmSync(report, { force: true })
    const lease = await ctx.lease(suite.needs, { template: templateFor(suite.needs, where), cwd })
    try {
      const cmd = adapter.command({ suite, files: files === 'all' ? null : fromCwd(suite.cwd, files), grep, report })
      const r = await runShell(cmd, { cwd, env: env(lease), timeoutMs: verify.timeoutMs, signal })
      if (!existsSync(report)) return { results: null, reason: r.timedOut ? `timed out after ${Math.round(verify.timeoutMs / 60000)}m with no report` : `no report (exit ${r.code}): ${r.out.slice(-400)}` }
      const results = adapter.parse(readFileSync(report, 'utf8'), { root: cwd })
      if (!results.length && r.code !== 0) return { results: null, reason: `exit ${r.code} with an empty report: ${r.out.slice(-400)}` }
      const tracked = lazyTracked(suite, where)
      return { results: results.map((x) => ({ ...x, file: repoFile(suite, where, x.file, tracked) })) }
    } finally {
      lease.release()
    }
  }
  const statusIn = (res, f) => (res.results ? res.results.find((x) => x.file === f.file && x.name === f.name)?.status ?? 'missing' : 'broken')
  const rerun = async (suite, f, where) => statusIn(await runSuite(suite, [f.file], { where, grep: f.name }), f)

  const runCheck = async (c, where) => {
    if (signal?.aborted) return { code: 1, timedOut: false, aborted: true, out: 'cancelled' }
    const cwd = join(where, c.cwd)
    const lease = await ctx.lease(c.needs, { template: templateFor(c.needs, where), cwd })
    try {
      return await runShell(c.run, { cwd, env: env(lease), timeoutMs: verify.timeoutMs, signal })
    } finally {
      lease.release()
    }
  }
  const targetLines = async (c) => {
    const cached = ledger.readLines(ctx.targetSha, c.name)
    if (cached) return cached
    const r = await runCheck(c, await ctx.targetCheckout())
    // A target run cut short is not the target's output: caching it would make every later run
    // against this sha a false red. Not cached, and the check is broken this time.
    if (r.timedOut || r.aborted || signal?.aborted) return null
    const s = linesOf(r.out, c.match)
    ledger.writeLines(ctx.targetSha, c.name, s)
    return s
  }
  const checkFails = async (c, where) => {
    const r = await runCheck(c, where)
    if (r.timedOut) return { fail: true, msg: `timed out after ${Math.round(verify.timeoutMs / 60000)}m` }
    if (c.compare === 'exit') return { fail: r.code !== 0, msg: r.out.slice(-1500) }
    const theirs = await targetLines(c)
    if (!theirs) return { fail: false, broken: `the run on the target ${signal?.aborted ? 'was cancelled' : `timed out after ${Math.round(verify.timeoutMs / 60000)}m`}`, msg: '' }
    const fresh = [...linesOf(r.out, c.match)].filter((l) => !theirs.has(l))
    return { fail: fresh.length > 0, msg: fresh.slice(0, 30).join('\n') }
  }

  const record = (f, k, suiteName) => {
    if (k.kind === 'known') verdict.known.push(f.id)
    else if (k.kind === 'flake') {
      verdict.flakes.push(f.id)
      if (!k.listed) ledger.recordFlip(f.id)
    } else if (k.kind === 'debt') {
      verdict.debt.push(f.id)
      ledger.addKnown(req.target, [f.id])
    } else if (k.kind === 'broken') verdict.broken.push({ suite: suiteName, reason: `the re-run on the target could not run: ${f.id}` })
    else verdict.regressions.push({ suite: suiteName, id: f.id, file: f.file, name: f.name, msg: f.msg, ...(k.note && { note: k.note }), introducedBy: null })
  }
  const judge = (f, rerunHere, rerunOnTarget) => classify(f, { known, isFlaky: ledger.isFlaky, branchOwns, rerunHere, rerunOnTarget })

  // 1. Checks.
  const checksRun = new Map()
  for (const c of verify.checks.filter((x) => x.tiers.includes(req.tier))) {
    if (signal?.aborted) break
    const r = await checkFails(c, checkout)
    if (signal?.aborted) break
    const id = `check::${c.name}`
    if (r.broken) {
      verdict.broken.push({ suite: 'check', reason: `${id}: ${r.broken}` })
      continue
    }
    rows.push({ id, status: r.fail ? 'fail' : 'pass' })
    if (!r.fail) continue
    checksRun.set(id, c)
    const f = { id, file: null, name: c.name, msg: r.msg }
    const k = await judge(
      f,
      async () => ((await checkFails(c, checkout)).fail ? 'fail' : 'pass'),
      async () => (c.compare === 'lines' ? 'pass' : (await checkFails(c, await ctx.targetCheckout())).fail ? 'fail' : 'pass'),
    )
    // A judgement cut short by a cancel is not a judgement.
    if (signal?.aborted) break
    record(f, k, 'check')
  }

  // 2. Suites.
  const suites = verify.suites.filter((s) => s.tiers.includes(req.tier))
  const sel = req.tier === 'merge' ? Object.fromEntries(suites.map((s) => [s.name, { files: 'all', why: 'merge tier: the whole suite' }])) : ctx.select(checkout, req.base, suites)
  const prior = req.tier === 'phase' ? ledger.resultsAt(req.sha) : new Map()
  const suiteOf = new Map(suites.map((s) => [s.name, s]))
  for (const s of suites) {
    if (signal?.aborted) break
    let { files, why } = sel[s.name]
    if (Array.isArray(files) && prior.size) {
      const greenFile = (file) => {
        const mine = [...prior].filter(([id]) => id.startsWith(`${s.name}::${file}::`))
        return mine.length > 0 && mine.every(([, st]) => st === 'pass' || st === 'skip')
      }
      const keep = files.filter((f) => !greenFile(f))
      verdict.reused += files.length - keep.length
      files = keep
    }
    verdict.selection[s.name] = { files: files === 'all' ? 'all' : files.length, why: typeof why === 'string' ? why : null }
    if (files !== 'all' && !files.length) continue
    let res = await runSuite(s, files)
    if (!res.results && !signal?.aborted) res = await runSuite(s, files)
    if (signal?.aborted) break
    if (!res.results) {
      verdict.broken.push({ suite: s.name, reason: res.reason })
      continue
    }
    for (const r of res.results) {
      if (signal?.aborted) break
      const id = testId(s.name, r)
      rows.push({ id, status: r.status, ms: r.ms })
      if (r.status !== 'fail') continue
      const f = { id, file: r.file, name: r.name, msg: r.msg }
      const k = await judge(
        f,
        (x) => rerun(s, x, checkout),
        async (x) => {
          // A test file the branch adds has no counterpart on the target: missing there, not broken.
          const target = await ctx.targetCheckout()
          return existsSync(join(target, x.file)) ? rerun(s, x, target) : 'missing'
        },
      )
      if (signal?.aborted) break
      record(f, k, s.name)
    }
  }

  // 3. The ledger, then which commit broke what.
  ledger.appendResults(rows.map((r) => ({ run: req.id, sha: req.sha, tier: req.tier, ...r })))
  const passed = rows.filter((r) => r.status === 'pass').map((r) => r.id)
  ledger.recordClean(passed)
  if (req.tier === 'merge' && !signal?.aborted) ledger.removeKnown(req.target, passed)
  if (verdict.regressions.length && (req.commits?.length ?? 0) > 1 && !signal?.aborted) {
    await bisect(verdict.regressions, req.commits, {
      signal,
      atCommit: ctx.atCommit,
      statusAt: async (g) => (g.suite === 'check' ? ((await checkFails(checksRun.get(g.id), checkout)).fail ? 'fail' : 'pass') : rerun(suiteOf.get(g.suite), g, checkout)),
    })
  } else for (const g of verdict.regressions) g.introducedBy = req.commits?.at(-1) ?? req.sha
  verdict.status = signal?.aborted ? 'cancelled' : verdict.regressions.length ? 'red' : verdict.broken.length ? 'env-broken' : 'green'
  verdict.ms = Date.now() - t0
  return verdict
}
