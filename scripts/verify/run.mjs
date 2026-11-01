// scripts/verify/run.mjs
/**
 * One request, in one checkout → its verdict (spec §The flow, §Judging a failure). Checks first,
 * then each suite's selected files (all of them at the merge tier); every failing test is judged by
 * classify(); a run with no report is retried once in a fresh lease and is env-broken after that.
 */
import { existsSync, readFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ADAPTERS } from './adapters.mjs'
import { classify } from './classify.mjs'
import { fromCwd } from './select.mjs'
import { inputsHash } from './envpool.mjs'
import { globToRegExp } from '../impact.mjs'
import { tryGit } from './git.mjs'

/**
 * `lines` (a regex source, '' for every line): also collect each complete output line that matches,
 * trimmed, over the WHOLE output — `out` keeps only a tail, and a `compare: lines` check judged on
 * two tails reads a shifted window as new lines (seen: a 128 KB lint report).
 */
export function runShell(cmd, { cwd, env = process.env, timeoutMs = 0, signal = null, lines = null } = {}) {
  return new Promise((resolve) => {
    // An already-aborted signal never fires 'abort': a cancelled run starts nothing more.
    if (signal?.aborted) return resolve({ code: 1, timedOut: false, out: 'cancelled', ...(lines !== null && { lines: new Set() }) })
    // A `node --test` child that inherits NODE_TEST_CONTEXT from a parent running under `node --test`
    // reports to that parent instead of writing its own report — so the child never sees it.
    const childEnv = { ...env }
    delete childEnv.NODE_TEST_CONTEXT
    const p = spawn('/bin/bash', ['-c', cmd], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    const re = lines === null ? null : lines ? new RegExp(lines) : /./
    const found = new Set()
    // Per stream: a line split across two chunks is joined before it is matched.
    const stream = () => {
      let part = ''
      return {
        add(b) {
          out = (out + b).slice(-20000)
          if (!re) return
          const ls = (part + b).split('\n')
          part = ls.pop()
          for (const l of ls) if (l.trim() && re.test(l.trim())) found.add(l.trim())
        },
        end() {
          if (re && part.trim() && re.test(part.trim())) found.add(part.trim())
        },
      }
    }
    // Decoded per stream, so a multi-byte character split across two chunks stays one character.
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    const so = stream()
    const se = stream()
    p.stdout.on('data', (b) => so.add(b))
    p.stderr.on('data', (b) => se.add(b))
    let timedOut = false
    const kill = () => {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {}
    }
    const t = timeoutMs ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : null
    signal?.addEventListener('abort', kill, { once: true })
    const settle = (r) => {
      if (settled) return
      settled = true
      if (t) clearTimeout(t)
      // A long-lived signal outlives many runs: a listener left behind would pile up and SIGKILL a
      // process group id the OS has since handed to someone else.
      signal?.removeEventListener('abort', kill)
      resolve(r)
    }
    p.on('close', (code) => {
      so.end()
      se.end()
      settle({ code: code ?? 1, timedOut, out, ...(re && { lines: found }) })
    })
    // A spawn that fails (a cwd that doesn't exist: `spawn /bin/bash ENOENT`) emits 'error', which
    // unheard would take the whole service down. It is a failed run, nothing more.
    p.on('error', (e) => settle({ code: 127, timedOut: false, out: `could not start: ${e.message}`, spawnError: true, ...(re && { lines: new Set() }) }))
  })
}

const REAP_GRACE_MS = 3000
const realOr = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
/** Alive and not a zombie: a stray this process spawned stays a zombie until the event loop reaps it. */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  return !/^Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? '')
}
/**
 * Every process whose cwd is `dir` or under it, stopped: SIGTERM, then SIGKILL for any still alive
 * after 3 s → the pids signalled. runShell kills its own process group, but a server the run started
 * in a group of its own (a playwright webServer) outlives it — seen running for hours. Matched by real
 * path on a separator boundary (co/1 never takes co/10; /var is /private/var); never this process or
 * its parent, nor the lsof that lists them. No lsof: []. A process with a controlling terminal is a
 * person's — a shell or editor whose cwd is in the checkout (an interactive zsh ignores SIGTERM, and
 * SIGKILL would close its tab) — never a suite's server: skipped, and `log` says so.
 */
const ttyOfPs = (pid) => spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? ''
/** `ps -o tty=` with no terminal: `??` on macOS, `?` on Linux, `-` or empty elsewhere. */
const hasTty = (tty) => !/^(\?+|-|)$/.test(tty)
export function reapStrays(dir, { ttyOf = ttyOfPs, log = (m) => console.error(m) } = {}) {
  const root = realOr(resolve(dir))
  if (root === sep) return []
  const r = spawnSync('lsof', ['-nP', '-w', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || !r.stdout) return []
  const within = (p) => p === root || p.startsWith(root + sep)
  const pids = []
  let pid = null
  for (const l of r.stdout.split('\n')) {
    if (l[0] === 'p') pid = Number(l.slice(1))
    else if (l[0] === 'n' && pid && pid !== process.pid && pid !== process.ppid && pid !== r.pid && !pids.includes(pid)) {
      const cwd = l.slice(1)
      if (!within(cwd) && !within(realOr(cwd))) continue
      const tty = ttyOf(pid)
      if (hasTty(tty)) log(`reap: skipped pid ${pid} in ${cwd} — it has a terminal (${tty}), so it is a person's shell or editor, not a stray`)
      else pids.push(pid)
    }
  }
  const signal = (sig) => pids.forEach((p) => {
    try {
      process.kill(p, sig)
    } catch {}
  })
  signal('SIGTERM')
  // Synchronous on purpose: callers need the checkout empty before its next run; a stray that obeys
  // SIGTERM is gone in milliseconds, so the full grace is only ever spent on one that ignores it.
  const nap = new Int32Array(new SharedArrayBuffer(4))
  for (const t0 = Date.now(); pids.some(isAlive) && Date.now() - t0 < REAP_GRACE_MS; ) Atomics.wait(nap, 0, 0, 50)
  if (pids.some(isAlive)) signal('SIGKILL')
  return pids
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

const REUSE_COMMITS = 3
/** Runners whose whole run is the suite's glob itself; the rest let their own config pick the files, so a whole selection stays whole. */
const LISTED_WHOLE = new Set(['node-test', 'junit'])

/**
 * (suite, file) → whether the phase tier may skip it. Candidates are the request's commit, then each
 * commit of base..sha newest first, then base: only ancestors, so a pass on another branch or the
 * target's merge checkout never counts. The newest candidate with any row for the file is the one
 * judged, and only if every row there is pass/skip: a change since it that reaches the file, or that the graph can't
 * place (a 'whole' selection), means a re-run.
 */
function phaseReuse(req, ctx, suites) {
  const { ledger, checkout } = ctx
  const range = (tryGit(checkout, 'rev-list', `${req.base}..${req.sha}`) ?? '').split('\n').filter(Boolean)
  const chain = [...new Set([req.sha, ...range, req.base].filter(Boolean))]
  const passes = ledger.resultsAtAll(chain)
  const index = new Map() // sha → "suite::file" → every recorded test of it passed or skipped
  for (const [sha, byId] of passes) {
    const m = new Map()
    for (const [id, st] of byId) {
      const k = id.split('::').slice(0, 2).join('::')
      m.set(k, (m.get(k) ?? true) && (st === 'pass' || st === 'skip'))
    }
    index.set(sha, m)
  }
  // Each file is judged at its newest record. The graph is built once per distinct earlier commit,
  // synchronously, and for at most a few: the commits that are the newest passing record of the most
  // files (newest first on a tie), chosen up front so the answer doesn't depend on the order files
  // are asked. A file whose commit isn't among them is re-run.
  const newest = new Map() // "suite::file" → the newest commit with any row for it
  for (const c of chain) for (const k of index.get(c)?.keys() ?? []) if (!newest.has(k)) newest.set(k, c)
  const counts = new Map()
  for (const [k, c] of newest) if (c !== req.sha && index.get(c).get(k)) counts.set(c, (counts.get(c) ?? 0) + 1)
  const order = new Map(chain.map((c, i) => [c, i]))
  const graphs = new Set([...counts].sort((a, b) => b[1] - a[1] || order.get(a[0]) - order.get(b[0])).slice(0, REUSE_COMMITS).map(([c]) => c))
  const reach = new Map() // commit → what changed since it can reach, per suite
  const reachedSince = (c) => {
    if (!reach.has(c)) {
      if (ctx.signal?.aborted) return null
      try {
        reach.set(c, ctx.select(checkout, c, suites))
      } catch {
        reach.set(c, null)
      }
    }
    return reach.get(c)
  }
  const at = new Map() // "suite::file" → the commit judged, memoised
  return (suite, file) => {
    const key = `${suite.name}::${file}`
    // The newest commit with any row for the file decides, even a fail: older passes are not walked to.
    if (!at.has(key)) {
      const c = newest.get(key)
      at.set(key, c && index.get(c).get(key) ? c : null)
    }
    const c = at.get(key)
    if (!c) return false
    if (c === req.sha) return true
    if (!graphs.has(c)) return false
    const files = reachedSince(c)?.[suite.name]?.files
    return Array.isArray(files) && !files.includes(file)
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
  // Every slot a suite or check ran in. Only this request uses a slot while it runs, so whatever is
  // still running in one once every lease is released is a stray: reaped once, at the end, whole.
  const slots = new Set()
  try {
    return await judgeRequest(req, ctx, tmp, slots)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    for (const where of slots) reapStrays(where)
  }
}

async function judgeRequest(req, ctx, tmp, slots) {
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

  // The checkout's tracked glob, listed once per suite and commit: bisect moves this checkout to older
  // commits, whose files differ.
  const trackedMemo = new Map()
  const trackedFor = (suite, where) => {
    if (where !== checkout) return lazyTracked(suite, where)
    const key = `${suite.name}@${tryGit(where, 'rev-parse', 'HEAD')}`
    if (!trackedMemo.has(key)) trackedMemo.set(key, lazyTracked(suite, where))
    return trackedMemo.get(key)
  }
  const runSuite = async (suite, files, { where = checkout, grep = null, pairs = null } = {}) => {
    // Once cancelled, nothing more is leased or run.
    if (signal?.aborted) return { results: null, reason: 'cancelled' }
    const adapter = ADAPTERS[suite.runner]
    const cwd = join(where, suite.cwd)
    const report = adapter.reportPath ? adapter.reportPath(suite, cwd) : join(tmp, `${++n}-${suite.name}.out`)
    rmSync(report, { force: true })
    const lease = await ctx.lease(suite.needs, { template: templateFor(suite.needs, where), cwd })
    slots.add(where)
    let cut = false
    try {
      // A junit command's {files} is the project's own runner: it may take them as regexes (playwright),
      // so the whole suite is its files named, never the glob. No glob, no files: the command runs all.
      const whole = files === 'all' && suite.runner === 'junit' && suite.files ? fromCwd(suite.cwd, trackedFor(suite, where).list()) : null
      const cmd = adapter.command({ suite, files: files === 'all' ? whole : fromCwd(suite.cwd, files), grep, pairs: pairs && pairs.map((p) => ({ ...p, file: fromCwd(suite.cwd, [p.file])[0] })), report })
      const r = await runShell(cmd, { cwd, env: env(lease), timeoutMs: verify.timeoutMs, signal })
      cut = r.timedOut
      // A run cut short streams a partial report: its rows would read as a complete record of the file.
      if (r.timedOut || !existsSync(report)) return { results: null, timedOut: r.timedOut, reason: r.timedOut ? `timed out after ${Math.round(verify.timeoutMs / 60000)}m` : `no report (exit ${r.code}): ${r.out.slice(-400)}` }
      const results = adapter.parse(readFileSync(report, 'utf8'), { root: cwd })
      if (!results.length && r.code !== 0) return { results: null, reason: `exit ${r.code} with an empty report: ${r.out.slice(-400)}` }
      const tracked = trackedFor(suite, where)
      return { results: results.map((x) => ({ ...x, file: repoFile(suite, where, x.file, tracked) })) }
    } finally {
      lease.release()
      // A run killed at its timeout may have left a server holding the port the next run needs.
      if (cut) reapStrays(where)
    }
  }
  const statusIn = (res, f) => (res.results ? res.results.find((x) => x.file === f.file && x.name === f.name)?.status ?? 'missing' : 'broken')
  const rerun = async (suite, f, where) => statusIn(await runSuite(suite, [f.file], { where, grep: f.name }), f)
  // Several failing tests, one run: their files and a name filter matching them all. A name that also
  // matches a test in another file of the batch is harmless — only each failure's own row is read.
  const rerunMany = async (suite, fs, where) => {
    const res = await runSuite(suite, [...new Set(fs.map((f) => f.file))], { where, grep: fs.map((f) => f.name), pairs: fs.map((f) => ({ file: f.file, name: f.name })) })
    return new Map(fs.map((f) => [f.id, statusIn(res, f)]))
  }
  /**
   * The re-run questions for a suite's failures that classify() will actually ask (not known, not
   * listed flaky), answered one run per question for all of them. Lazy, so a suite whose failures are
   * all known runs nothing, and the target is asked only about what still failed here.
   */
  const batchedJudging = (suite, fails) => {
    const cands = fails.filter((f) => !known.has(f.id) && !ledger.isFlaky(f.id))
    let here = null
    let there = null
    const hereAll = () => (here ??= cands.length ? rerunMany(suite, cands, checkout) : new Map())
    const thereAll = () =>
      (there ??= (async () => {
        const h = await hereAll()
        const still = cands.filter((f) => h.get(f.id) !== 'pass')
        const target = await ctx.targetCheckout()
        // A test file the branch adds has no counterpart on the target: missing there, not broken.
        const present = still.filter((f) => existsSync(join(target, f.file)))
        const got = present.length ? await rerunMany(suite, present, target) : new Map()
        return new Map(still.map((f) => [f.id, got.get(f.id) ?? 'missing']))
      })())
    return {
      rerunHere: async (f) => (await hereAll()).get(f.id) ?? rerun(suite, f, checkout),
      rerunOnTarget: async (f) => (await thereAll()).get(f.id) ?? rerun(suite, f, await ctx.targetCheckout()),
    }
  }

  const runCheck = async (c, where) => {
    if (signal?.aborted) return { code: 1, timedOut: false, aborted: true, out: 'cancelled' }
    const cwd = join(where, c.cwd)
    // A check whose directory this checkout lacks (an app the branch adds) has nothing to run in.
    if (!existsSync(cwd)) return { code: 1, timedOut: false, noCwd: true, out: `its cwd ${c.cwd} does not exist`, ...(c.compare === 'lines' && { lines: new Set() }) }
    const lease = await ctx.lease(c.needs, { template: templateFor(c.needs, where), cwd })
    slots.add(where)
    let cut = false
    try {
      const r = await runShell(c.run, { cwd, env: env(lease), timeoutMs: verify.timeoutMs, signal, lines: c.compare === 'lines' ? c.match ?? '' : null })
      cut = r.timedOut
      return r
    } finally {
      lease.release()
      if (cut) reapStrays(where)
    }
  }
  const targetLines = async (c) => {
    const cached = ledger.readLines(ctx.targetSha, c.name)
    if (cached) return cached
    const r = await runCheck(c, await ctx.targetCheckout())
    // No such directory on the target: it has none of these lines (the branch adds the app).
    if (r.noCwd) {
      ledger.writeLines(ctx.targetSha, c.name, new Set())
      return new Set()
    }
    // A target run cut short is not the target's output: caching it would make every later run
    // against this sha a false red. Not cached, and the check is broken this time.
    if (r.timedOut || r.aborted || signal?.aborted) return null
    const s = r.lines ?? linesOf(r.out, c.match)
    ledger.writeLines(ctx.targetSha, c.name, s)
    return s
  }
  const checkFails = async (c, where) => {
    const r = await runCheck(c, where)
    // Here: the check cannot run at this commit — broken, never a pass or a regression. On the target:
    // missing there, like a test file the branch adds.
    if (r.noCwd) return where === checkout ? { fail: false, broken: r.out, msg: '' } : { fail: true, missing: true, msg: r.out }
    if (r.timedOut) return { fail: true, msg: `timed out after ${Math.round(verify.timeoutMs / 60000)}m` }
    if (c.compare === 'exit') return { fail: r.code !== 0, msg: r.out.slice(-1500), raw: true }
    const theirs = await targetLines(c)
    if (!theirs) return { fail: false, broken: `the run on the target ${signal?.aborted ? 'was cancelled' : `timed out after ${Math.round(verify.timeoutMs / 60000)}m`}`, msg: '' }
    const fresh = [...(r.lines ?? linesOf(r.out, c.match))].filter((l) => !theirs.has(l))
    return { fail: fresh.length > 0, msg: fresh.slice(0, 30).join('\n') }
  }

  const record = (f, k, suiteName) => {
    if (k.kind === 'known') verdict.known.push(f.id)
    else if (k.kind === 'flake') {
      verdict.flakes.push(f.id)
      if (!k.listed) ledger.recordFlip(f.id)
    } else if (k.kind === 'debt') {
      // Filed into known failures only once the verdict is known (step 3): never from an env-broken run.
      verdict.debt.push(f.id)
    } else if (k.kind === 'broken') verdict.broken.push({ suite: suiteName, reason: `the re-run on the target could not run: ${f.id}` })
    else verdict.regressions.push({ suite: suiteName, id: f.id, file: f.file, name: f.name, msg: f.msg, ...(f.raw && { raw: true }), ...(k.note && { note: k.note }), introducedBy: null })
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
    const f = { id, file: null, name: c.name, msg: r.msg, ...(r.raw && { raw: true }) }
    const k = await judge(
      f,
      async () => ((await checkFails(c, checkout)).fail ? 'fail' : 'pass'),
      async () => {
        if (c.compare === 'lines') return 'pass'
        const t = await checkFails(c, await ctx.targetCheckout())
        return t.missing ? 'missing' : t.fail ? 'fail' : 'pass'
      },
    )
    // A judgement cut short by a cancel is not a judgement.
    if (signal?.aborted) break
    record(f, k, 'check')
  }

  // 2. Suites.
  const suites = verify.suites.filter((s) => s.tiers.includes(req.tier))
  const sel = req.tier === 'merge' ? Object.fromEntries(suites.map((s) => [s.name, { files: 'all', why: 'merge tier: the whole suite' }])) : ctx.select(checkout, req.base, suites)
  const suiteOf = new Map(suites.map((s) => [s.name, s]))
  // Phase tier: a selected file is not re-run when every test in it passed at this commit, or at an
  // earlier commit of the range it covers that nothing since reaches (spec §Phase tier). The ledger
  // is read once, and the import graph once per distinct commit, never once per file.
  const reuse = req.tier === 'phase' ? phaseReuse(req, ctx, suites) : null
  for (const s of suites) {
    if (signal?.aborted) break
    let { files, why } = sel[s.name]
    // A whole selection (a lockfile changed somewhere on the branch) is judged file by file over the
    // glob's tracked files; it stays whole unless at least one file is reused.
    const wholeList = files === 'all' && reuse && s.files && LISTED_WHOLE.has(s.runner) ? trackedFor(s, checkout).list() : null
    if (Array.isArray(files) && reuse) {
      const keep = files.filter((f) => !reuse(s, f))
      verdict.reused += files.length - keep.length
      files = keep
    } else if (wholeList?.length) {
      const keep = wholeList.filter((f) => !reuse(s, f))
      if (keep.length < wholeList.length) {
        verdict.reused += wholeList.length - keep.length
        why = `${typeof why === 'string' ? `${why}; ` : ''}whole selection, ${wholeList.length - keep.length} reused`
        files = keep
      }
    }
    verdict.selection[s.name] = { files: files === 'all' ? 'all' : files.length, why: typeof why === 'string' ? why : null }
    if (files !== 'all' && !files.length) continue
    let res = await runSuite(s, files)
    // A missing report is retried once in a fresh lease; a timeout is not — it would only double the wait.
    if (!res.results && !res.timedOut && !signal?.aborted) res = await runSuite(s, files)
    if (signal?.aborted) break
    if (!res.results) {
      verdict.broken.push({ suite: s.name, reason: res.reason })
      continue
    }
    const failing = res.results.filter((r) => r.status === 'fail').map((r) => ({ id: testId(s.name, r), file: r.file, name: r.name, msg: r.msg }))
    const batched = batchedJudging(s, failing)
    for (const r of res.results) {
      if (signal?.aborted) break
      const id = testId(s.name, r)
      rows.push({ id, status: r.status, ms: r.ms })
      if (r.status !== 'fail') continue
      const f = { id, file: r.file, name: r.name, msg: r.msg }
      const k = await judge(f, batched.rerunHere, batched.rerunOnTarget)
      if (signal?.aborted) break
      record(f, k, s.name)
    }
  }

  // 3. The ledger, then which commit broke what.
  // A cancelled request judged only some of its tests: a partial record would later read as complete.
  if (!signal?.aborted) ledger.appendResults(rows.map((r) => ({ run: req.id, sha: req.sha, tier: req.tier, ...r })))
  const passed = rows.filter((r) => r.status === 'pass').map((r) => r.id)
  ledger.recordClean(passed)
  // An env-broken run proves nothing about the target's code: a failure on both sides there is the
  // environment's (no deps, no database), and a pass beside a broken suite is not a clean merge. So it
  // never adds to or removes from the target's known failures; its debt stays listed in the verdict only.
  const envBroken = !signal?.aborted && !verdict.regressions.length && verdict.broken.length > 0
  if (!envBroken) {
    if (verdict.debt.length) ledger.addKnown(req.target, verdict.debt)
    if (req.tier === 'merge' && !signal?.aborted) ledger.removeKnown(req.target, passed)
  }
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
