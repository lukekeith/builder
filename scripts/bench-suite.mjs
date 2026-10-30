#!/usr/bin/env node
/**
 * bench-suite — a catalogue of sized benchmark cases, scheduled into lanes that fit a night, run
 * detached, reported per case and per stage. Design: docs/specs/2026-10-29-benchmark-suite-design.md.
 *
 *   node scripts/bench-suite.mjs list [--json]
 *   node scripts/bench-suite.mjs plan <id,…|--all|--budget 12h> [--lanes N] [--control <id,…>] [--builder <checkout>] [--allow-dirty]
 *   node scripts/bench-suite.mjs run  <id,…|--all|--budget 12h> [--lanes N] [--control <id,…>] [--builder <checkout>] [--allow-dirty] --detach
 *   node scripts/bench-suite.mjs run --resume <suite-id> --detach
 *   node scripts/bench-suite.mjs status
 *   node scripts/bench-suite.mjs stop
 *   node scripts/bench-suite.mjs report <suite-id>
 *
 * Fixture cases are bench/features/<f>/feature.json (`size`, `covers`; project `fixtures`); archived
 * cases are $BENCH_LOCAL/cases/<id>.json. A suite lives in $BENCH_LOCAL/results/<suite-id>/ (suite.json,
 * one folder per item attempt, the named REPORT.md); the committed report, with no project names, is
 * $BENCH_SUITE_OUT/<date>-suite/REPORT.md. Two items of one project never run at once. `stop` (or a SIGTERM
 * to the suite) stops each running case cleanly, starts nothing more, writes the reports and releases the lock.
 * The builder under test is pinned: the suite runs on a detached worktree at --builder's HEAD
 * ($TMPDIR/bench-builder-<sha12>, removed when it ends); a --builder with uncommitted changes to tracked
 * files is refused unless --allow-dirty, which runs the tree as it is. suite.json and both reports carry
 * the treatment's SHA and main's.
 *
 * Env: BENCH_LOCAL (<builder>/bench/local), BENCH_SUITE_OUT (<builder>/bench/results), BENCH_CASE (the
 * case runner; scripts/bench-case.mjs), BENCH_FIXTURE_RUNNER (the bench.mjs a fixture item runs;
 * <checkout>/scripts/bench.mjs), BENCH_TMP (where clones go; $TMPDIR/bench-suite), TMPDIR (where the main checkout for controls goes).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, openSync, closeSync, realpathSync, statSync, cpSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SIZES, estimateFromRow, estimateFromRuns, pickLabel, packLanes, fillBudget, recommendControls, measureFromRuns, renderSuiteReport, caseFleetTimeoutMs, portCollisions, strippedEnv } from './bench-suite-core.mjs'
import { landedRow, duration } from './fleet-core.mjs'
import { BUILDER, runId, builderLabel } from './bench.mjs'

const SELF = fileURLToPath(import.meta.url)
const LOCAL = process.env.BENCH_LOCAL || join(BUILDER, 'bench', 'local')
const SUITE_OUT = process.env.BENCH_SUITE_OUT || join(BUILDER, 'bench', 'results')
const CASE_RUNNER = process.env.BENCH_CASE || join(BUILDER, 'scripts', 'bench-case.mjs')
/** Where each archived case's clone goes — <root>/<suite-id>/<item>/clone — outside every repo, so no repo's CLAUDE.md loads into its sessions. */
const CLONE_ROOT = process.env.BENCH_TMP || join(tmpdir(), 'bench-suite')
const RESULTS = join(LOCAL, 'results')
const LOCK = join(RESULTS, 'lock')
const FEATURES = join(BUILDER, 'bench', 'features')
const FIXTURE_RESULTS = join(BUILDER, 'bench', 'results')
const DEFAULT_LANES = 3
const USAGE = 'usage: bench-suite.mjs list [--json] | plan <id,…|--all|--budget 12h> [--lanes N] [--control <id,…>] [--builder <checkout>] [--allow-dirty] | run <same> --detach | run --resume <suite-id> --detach | status | stop | report <suite-id>'
const STOP_WAIT_MS = Number(process.env.BENCH_STOP_WAIT_MS) || 120 * 1000
const KILL_GRACE_MS = Number(process.env.BENCH_CASE_KILL_GRACE_MS) || 10 * 1000

const die = (msg) => {
  console.error(msg)
  process.exit(2)
}
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const cents = (n) => Math.round(n * 100) / 100
const firstLine = (s) => String(s ?? '').trim().split('\n')[0] ?? ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A process's command line, or '' when it is gone. */
const commandOf = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? ''
/** True when the case process an item's attempt recorded is still alive — and is that case (its command line names the attempt), not a process that reused the pid. */
export function caseAlive(it) {
  if (!Number.isInteger(it.pid) || it.pid <= 1 || !alive(it.pid)) return false
  const cmd = commandOf(it.pid)
  return it.kind === 'fixture' ? cmd.includes(` run ${it.case} --only builder`) : !!it.out && cmd.includes(it.out)
}
/** A process and every descendant, SIGTERM then SIGKILL after the grace period — for a fixture runner, which handles no signal itself. */
async function killTree(pid) {
  const tree = () => {
    const rows = (spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    const out = [pid]
    for (let i = 0; i < out.length; i++) for (const [p, pp] of rows) if (pp === out[i] && p !== process.pid && !out.includes(p)) out.push(p)
    return out.filter(alive)
  }
  const signal = (sig) => tree().forEach((p) => { try { process.kill(p, sig) } catch {} })
  signal('SIGTERM')
  for (const t0 = Date.now(); tree().length && Date.now() - t0 < KILL_GRACE_MS; ) await sleep(100)
  signal('SIGKILL')
}

// ---- the catalogue ---------------------------------------------------------------------------------

/** A fixture's run folders under a results dir (YYYY-MM-DD-HHMM-<feature>, with a runs.json), oldest first. */
export function fixtureRunDirs(results, feature) {
  if (!isDir(results)) return []
  const re = new RegExp(`^\\d{4}-\\d\\d-\\d\\d-\\d{4}-${feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return readdirSync(results).filter((n) => re.test(n) && existsSync(join(results, n, 'runs.json'))).sort().map((n) => join(results, n))
}

/** A fixture's estimate: the newest of its runs that has done builder runs, else null. */
function fixtureEstimate(feature) {
  for (const d of fixtureRunDirs(FIXTURE_RESULTS, feature).reverse()) {
    const e = estimateFromRuns(readJson(join(d, 'runs.json')), 'builder')
    if (e) return e
  }
  return null
}

/** An archived case's estimate: the case file's, else its original archive row's, else null. */
function archivedEstimate(c) {
  if (c.estimate) return c.estimate
  try {
    const pf = join(LOCAL, 'projects', `${c.project}.json`)
    const profile = readJson(pf)
    if (!profile?.repo || !c.feature) return null
    const row = landedRow(resolve(dirname(pf), profile.repo), c.feature)
    return row ? estimateFromRow(row) : null
  } catch {
    return null
  }
}

/** Every case — fixtures, then archived — each with `problem` set when it cannot be scheduled (an unknown size, a bad file). */
export function loadCatalogue() {
  const cases = []
  if (isDir(FEATURES)) {
    for (const f of readdirSync(FEATURES).sort()) {
      if (!existsSync(join(FEATURES, f, 'request.md'))) continue
      const def = readJson(join(FEATURES, f, 'feature.json')) ?? {}
      cases.push({ id: f, size: def.size, covers: def.covers ?? f, kind: 'fixture', project: 'fixtures', feature: f, estimate: fixtureEstimate(f) })
    }
  }
  const dir = join(LOCAL, 'cases')
  if (isDir(dir)) {
    for (const n of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const id = n.slice(0, -5)
      const c = readJson(join(dir, n))
      if (!c || typeof c !== 'object') {
        cases.push({ id, size: undefined, covers: '?', kind: 'archived', project: null, problem: 'case file is not JSON' })
        continue
      }
      const kase = { ...c, id, kind: 'archived', covers: c.covers ?? c.feature ?? id }
      if (cases.some((x) => x.id === id)) kase.problem = 'a fixture has the same id'
      else if (!c.project) kase.problem = 'case names no project'
      kase.estimate = kase.problem ? (c.estimate ?? null) : archivedEstimate(kase)
      cases.push(kase)
    }
  }
  for (const c of cases) if (!c.problem && !SIZES.includes(c.size)) c.problem = 'unknown size'
  return cases.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
}
const rank = (c) => (SIZES.includes(c.size) ? SIZES.indexOf(c.size) : SIZES.length)
const label = (c) => (c.problem ? `${c.size ?? '?'} · ${c.id} — ${c.covers} · ${c.problem}` : pickLabel(c))

// ---- selection and the schedule --------------------------------------------------------------------

const VALUE_OPTS = new Set(['--lanes', '--control', '--budget', '--builder', '--resume'])
const FLAG_OPTS = new Set(['--all', '--detach', '--json', '--allow-dirty'])

/** The CLI's options; an unknown flag or a flag missing its value is a usage error. */
function parseArgs(argv) {
  const opts = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_OPTS.has(a)) {
      const v = argv[i + 1]
      if (v == null || v.startsWith('--')) die(`${a} needs a value — ${USAGE}`)
      opts[a] = v
      i++
    } else if (FLAG_OPTS.has(a)) opts[a] = true
    else if (a.startsWith('--')) die(`unknown option ${a} — ${USAGE}`)
    else pos.push(a)
  }
  return { opts, pos }
}

/** --lanes as a whole number ≥ 1 (default 3). */
function lanesOf(opts) {
  const raw = opts['--lanes']
  if (raw == null) return DEFAULT_LANES
  if (!/^\d+$/.test(raw) || Number(raw) < 1) die(`--lanes must be a whole number of 1 or more: got '${raw}'`)
  return Number(raw)
}

/** --budget as minutes: 12h, 90m, 1.5h. */
function budgetOf(raw) {
  const m = /^(\d+(?:\.\d+)?)(h|m)$/.exec(raw)
  if (!m || !(Number(m[1]) > 0)) die(`--budget takes hours or minutes, like 12h or 90m: got '${raw}'`)
  return Math.floor(Number(m[1]) * (m[2] === 'h' ? 60 : 1))
}

/** The picked cases (and their controls), the skipped ones with reasons, from ids, --all or --budget. */
function select({ opts, pos }, catalogue, lanes) {
  const modes = [pos.length > 0, !!opts['--all'], opts['--budget'] != null].filter(Boolean).length
  if (modes !== 1) die(`pick cases by id, --all or --budget — one of them — ${USAGE}`)
  const byId = new Map(catalogue.map((c) => [c.id, c]))
  let pool
  if (pos.length) {
    const ids = pos.join(',').split(',').map((s) => s.trim()).filter(Boolean)
    for (const id of ids) if (!byId.has(id)) die(`no case '${id}' — the catalogue has: ${catalogue.map((c) => c.id).join(', ') || 'nothing'}`)
    pool = [...new Set(ids)].map((id) => byId.get(id))
  } else pool = catalogue
  const skipped = []
  const usable = []
  for (const c of pool) {
    if (c.problem) skipped.push({ id: c.id, reason: c.problem })
    else usable.push(c)
  }
  let picked
  if (opts['--budget'] != null) {
    const fit = fillBudget(usable, { minutes: budgetOf(opts['--budget']), lanes })
    picked = fit.picked
    skipped.push(...fit.skipped)
  } else {
    picked = []
    for (const c of usable) {
      if (c.estimate) picked.push(c)
      else skipped.push({ id: c.id, reason: 'no estimate' })
    }
  }
  const controlIds = (opts['--control'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const controls = []
  for (const id of [...new Set(controlIds)]) {
    const c = picked.find((p) => p.id === id)
    if (!c) die(`control ${id} is not in the selection — a control runs a picked case again on builder's main`)
    controls.push({ ...c, id: `${c.id}@main`, case: c.id, control: true })
  }
  return { picked, controls, skipped, controlsGiven: controlIds.length > 0 }
}

const clock = (t) => new Date(t).toTimeString().slice(0, 5)
const money = (xs) => (xs.some((x) => x != null) ? `~$${cents(xs.reduce((a, x) => a + (x ?? 0), 0))}` : '~$?')

/** The schedule review: each lane's items with start–end clock times from now, its end and cost, the total, the skipped, the recommended controls. */
export function renderSchedule({ packed, items, skipped, recommended = [], lanes, now = Date.now() }) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const at = (m) => clock(now + m * 60000)
  const nCases = items.filter((i) => !i.control).length
  const nCtl = items.length - nCases
  const out = [`suite: ${nCases} case${nCases === 1 ? '' : 's'}${nCtl ? ` + ${nCtl} control${nCtl === 1 ? '' : 's'}` : ''} in ${lanes} lane${lanes === 1 ? '' : 's'}, from now (${clock(now)})`]
  packed.lanes.forEach((lane, i) => {
    if (!lane.length) return out.push(`lane ${i + 1}: (empty)`)
    out.push(`lane ${i + 1}: ${lane.map((x) => `${x.id} (${byId.get(x.id).size}) ${at(x.start)}–${at(x.end)}`).join(' · ')}`)
    out.push(`        ends ~${at(lane.at(-1).end)} · ${money(lane.map((x) => byId.get(x.id).estimate?.usd ?? null))}`)
  })
  out.push(`all lanes end ~${at(packed.wallMinutes)} (${duration(packed.wallMinutes * 60000)}) · ${money(items.map((i) => i.estimate?.usd ?? null))} total`)
  if (skipped.length) out.push(`skipped: ${skipped.map((s) => `${s.id} — ${s.reason}`).join(' · ')}`)
  if (recommended.length) out.push(`controls recommended (one per size, the same case on builder's main): ${recommended.join(', ')} — add --control ${recommended.join(',')}`)
  return out.join('\n')
}

/** Items in packed order (lane, then start), as suite.json holds them. */
function scheduleItems(items, packed) {
  const byId = new Map(items.map((i) => [i.id, i]))
  return packed.lanes.flatMap((lane, li) => lane.map((x) => {
    const c = byId.get(x.id)
    return { id: c.id, case: c.case ?? c.id, kind: c.kind, project: c.project, size: c.size, control: !!c.control, estimate: c.estimate, lane: li + 1, status: 'waiting', startedAt: null, endedAt: null, out: null }
  }))
}

// ---- dry runs: the refusals before launch ----------------------------------------------------------

/**
 * Each archived case's `--dry-run` (once per case, controls included) → { refusals: [{ id, reasons }], summaries: [{ id, text }] };
 * two picked projects whose dry runs name one port are a refusal too — they may run at once.
 */
function dryRuns(items, builder) {
  const refusals = []
  const summaries = []
  const ports = new Map()
  const cases = [...new Map(items.filter((i) => i.kind === 'archived').map((i) => [i.case ?? i.id, i.project])).entries()]
  for (const [id, project] of cases) {
    const r = spawnSync(process.execPath, [CASE_RUNNER, id, '--builder', builder, '--out', join(tmpdir(), 'bench-suite-dry', id), '--dry-run'], { encoding: 'utf8' })
    if (r.status === 0) {
      const text = String(r.stdout ?? '').replace(/\n+$/, '')
      summaries.push({ id, text })
      const named = /^\s*ports:\s+(.*)$/m.exec(text)?.[1].split(/\s+/).map(Number).filter((n) => n > 0) ?? []
      ports.set(project, [...new Set([...(ports.get(project) ?? []), ...named])])
      continue
    }
    const lines = String(r.stderr ?? '').trim().split('\n').filter(Boolean)
    const reasons = r.status === 2 ? lines.map((l) => l.replace(/^refused:\s*/, '')) : [`dry run failed (${r.error ? r.error.message : `exit ${r.status}`})${lines.length ? `: ${lines[0]}` : ''}`]
    refusals.push({ id, reasons: reasons.length ? reasons : ['refused (no reason given)'] })
  }
  const clash = portCollisions(ports)
  if (clash.length) refusals.push({ id: 'the selection', reasons: clash })
  return { refusals, summaries }
}
/** A dry run's warnings by case id — body: (config prose naming something of the human's) and files: (a placed file worktrees won't get); a case with none is left out. */
const warningsOf = (summaries) => new Map(summaries.map((x) => [x.id, x.text.split('\n').filter((l) => /^\s+(?:body: |files: \S+ is placed but not in agent_walk\.copy)/.test(l)).map((l) => l.trim())]).filter(([, w]) => w.length))
const WARNING_FIX = 'a replace (body:) or an agent_walk.copy entry (files:) in its profile fixes each'
const printWarnings = (warnings) => {
  for (const [id, ws] of warnings) {
    console.log(`${id}: ${ws.length} warning${ws.length > 1 ? 's' : ''} — ${WARNING_FIX}`)
    for (const w of ws) console.log(`  ${w}`)
  }
}
/** Each item its case's body warnings (none: no field). */
const withWarnings = (items, warnings) => items.map((it) => (warnings.has(it.case ?? it.id) ? { ...it, warnings: warnings.get(it.case ?? it.id) } : it))
const printRefusals = (refusals) => {
  for (const { id, reasons } of refusals) {
    console.error(`${id} refused:`)
    for (const r of reasons) console.error(`  - ${r}`)
  }
}

// ---- suite.json, the lock --------------------------------------------------------------------------

const suiteDir = (id) => join(RESULTS, id)
const readSuite = (id) => readJson(join(suiteDir(id), 'suite.json'))
/** suite.json, written whole and renamed into place so a reader never sees half of it. */
function saveSuite(s) {
  const f = join(suiteDir(s.id), 'suite.json')
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2) + '\n')
  renameSync(`${f}.tmp`, f)
}
const latestSuite = () => (isDir(RESULTS) ? readdirSync(RESULTS).filter((n) => existsSync(join(RESULTS, n, 'suite.json'))).sort().at(-1) ?? null : null)
/** An item a run (or a resume) still has to run: never started, cut off mid-run, stopped, or refused at its start. */
const unfinished = (it) => it.status === 'waiting' || it.status === 'running' || it.status === 'stopped' || it.status.startsWith('refused')

/** { pid, suiteId, live } of the suite lock, or null. */
function lockState() {
  const l = readJson(LOCK)
  if (!l) return null
  return { ...l, live: Number.isInteger(l.pid) && alive(l.pid) }
}
/** Take the lock atomically (wx); a dead holder's lock is cleared. → false when a live other suite holds it. */
function acquireLock(pid, suiteId) {
  const held = lockState()
  if (held && !held.live) rmSync(LOCK, { force: true })
  mkdirSync(RESULTS, { recursive: true })
  try {
    writeFileSync(LOCK, JSON.stringify({ pid, suiteId }), { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const l = lockState()
    return l?.pid === pid || l?.pid === process.pid // already ours: the detach parent wrote it for this child
  }
}
const busy = (l) => `a suite is running (pid ${l?.pid}, ${l?.suiteId}) — /builder:benchmark --status`
const releaseLock = () => {
  if (lockState()?.pid === process.pid) rmSync(LOCK, { force: true })
}

// ---- running a suite -------------------------------------------------------------------------------

/** A child awaited in this process group (a SIGKILL of the suite's group takes it too), its output in files; `onSpawn` gets the child. → { code, error } */
function spawnWait(cmd, args, { cwd, env, outFile, errFile, onSpawn = () => {} }) {
  return new Promise((done) => {
    const out = openSync(outFile, 'a')
    const err = openSync(errFile, 'a')
    let settled = false
    const finish = (code, error) => {
      if (settled) return
      settled = true
      closeSync(out)
      closeSync(err)
      done({ code, error })
    }
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', out, err] })
    child.on('error', (e) => finish(null, e))
    child.on('exit', (code) => finish(code))
    if (child.pid) onSpawn(child)
  })
}

// ---- stopping: `stop` sends the suite SIGTERM; each running case is stopped, nothing more starts ----
let stopping = false
const liveCases = new Map()
/** Stop every running case: an archived one by SIGTERM (bench-case stops its fleet, tears down and writes `failed: stopped`), a fixture runner with its whole tree. */
function stopCases() {
  stopping = true
  for (const { child, kind } of liveCases.values()) {
    if (kind === 'fixture') killTree(child.pid)
    else child.kill('SIGTERM')
  }
}
/** Record a running item's case process: in suite.json (so --resume and stop can find it) and here (so a stop reaches it). */
const tracker = (s, it) => (child) => {
  it.pid = child.pid
  liveCases.set(it.id, { child, kind: it.kind })
  child.on('exit', () => liveCases.delete(it.id))
  saveSuite(s)
  if (stopping) stopCases()
}

/** <suite>/<item id>, or -2, -3… when an earlier attempt left that folder. */
function freshOut(dir, id) {
  let p = join(dir, id)
  for (let n = 2; existsSync(p); n++) p = join(dir, `${id}-${n}`)
  return p
}

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGitIn = (dir, ...a) => {
  try {
    return gitIn(dir, ...a)
  } catch {
    return null
  }
}

/**
 * A detached worktree of `builder` at `ref` in `dir`: reused when present (moved to `ref` when it is a git
 * checkout; a failed checkout throws, so nothing runs on a stale commit), else made with `git worktree add`
 * after a prune — macOS purges $TMPDIR and leaves the worktree registered.
 */
function worktreeAt(builder, dir, ref) {
  if (existsSync(dir)) {
    if (existsSync(join(dir, '.git'))) gitIn(dir, 'checkout', '-q', '--detach', ref)
    return dir
  }
  gitIn(builder, 'worktree', 'prune')
  gitIn(builder, 'worktree', 'add', '-q', '--detach', dir, ref)
  return dir
}
/** The checkout of builder's main a control runs on: $TMPDIR/bench-builder-main. */
const mainCheckout = (builder) => worktreeAt(builder, join(tmpdir(), 'bench-builder-main'), 'main')
/** The builder under test pinned: $TMPDIR/bench-builder-<sha12>, a detached worktree at `sha` — anything else there throws. */
function pinnedCheckout(builder, sha) {
  const dir = worktreeAt(builder, join(tmpdir(), `bench-builder-${sha.slice(0, 12)}`), sha)
  if (tryGitIn(dir, 'rev-parse', 'HEAD') !== sha) throw new Error(`${dir} is not a checkout of ${sha.slice(0, 12)}`)
  return dir
}
/** A worktree this suite made, removed and unregistered. */
function removeWorktree(builder, dir) {
  tryGitIn(builder, 'worktree', 'remove', '--force', dir)
  rmSync(dir, { recursive: true, force: true })
  tryGitIn(builder, 'worktree', 'prune')
}

/**
 * The builder under test as `run` pins it: its HEAD, and whether its tracked files differ from it. A tree
 * with changes, or one that is not a git checkout, is refused unless allowDirty, which runs it as it is.
 */
function treatmentOf(builder, allowDirty) {
  const sha = tryGitIn(builder, 'rev-parse', '--verify', 'HEAD')
  const changes = sha == null ? null : tryGitIn(builder, 'status', '--porcelain', '--untracked-files=no')
  if (changes == null) {
    if (!allowDirty) die(`--builder ${builder} is not a git checkout — the suite pins the builder under test to a commit; --allow-dirty runs it as it is`)
    return { sha: null, dirty: true, label: builderLabel(builder) }
  }
  if (changes && !allowDirty) die(`the builder checkout ${builder} has uncommitted changes — commit or stash them, or pass --allow-dirty to run the tree as it is (unpinned)`)
  return { sha, dirty: !!changes, label: builderLabel(builder) }
}

const refusedOrDied = (r, errFile) => (r.code === 2 ? `refused: ${firstLine(readFileSync(errFile, 'utf8')).replace(/^refused:\s*/, '') || 'no reason given'}` : 'failed: case process died')

/** An archived item: bench-case in a fresh --out, its clone under CLONE_ROOT, its fleet timeout from its estimate; a control's result is rewritten as <id>@main. → its status */
async function runArchived(it, builder, out, suiteId, onSpawn) {
  const errFile = join(out, 'case.err')
  const env = { ...process.env, BENCH_CASE_FLEET_TIMEOUT_MS: String(caseFleetTimeoutMs(it.estimate)) }
  const cloneRoot = join(CLONE_ROOT, suiteId, basename(out))
  const r = await spawnWait(process.execPath, [CASE_RUNNER, it.case, '--builder', builder, '--out', out, '--clone-root', cloneRoot], { cwd: out, env, outFile: join(out, 'case.out'), errFile, onSpawn })
  const resFile = join(out, 'result.json')
  const res = readJson(resFile)
  if (!res) return refusedOrDied(r, errFile)
  // a control is rewritten as <id>@main; the dry run's body warnings are kept beside the result
  const warnings = res.warnings ?? it.warnings
  if (it.control || (warnings && !res.warnings)) writeFileSync(resFile, JSON.stringify({ ...res, ...(it.control ? { id: it.id, control: true } : {}), ...(warnings ? { warnings } : {}) }, null, 2) + '\n')
  return res.status ?? 'failed: the case wrote no status'
}

/** A fixture item: bench.mjs run <feature> --only builder in the checkout; measured from the run it made, against the one before; the run is copied to `home`'s bench/results. → its status */
async function runFixture(it, checkout, out, onSpawn, home) {
  const results = join(checkout, 'bench', 'results')
  const before = fixtureRunDirs(results, it.case)
  const script = process.env.BENCH_FIXTURE_RUNNER || join(checkout, 'scripts', 'bench.mjs')
  const env = { ...process.env, CLAUDE_PROJECT_DIR: checkout }
  delete env.BENCH_RUN_ID
  const errFile = join(out, 'case.err')
  const r = await spawnWait(process.execPath, [script, 'run', it.case, '--only', 'builder'], { cwd: checkout, env, outFile: join(out, 'case.out'), errFile, onSpawn })
  const fresh = fixtureRunDirs(results, it.case).filter((d) => !before.includes(d)).at(-1)
  if (!fresh) return refusedOrDied(r, errFile)
  // the pinned worktree goes when the suite ends; the run is kept beside the builder's own, where the next estimate reads it
  const keep = home && !it.control && resolve(home) !== resolve(checkout) ? join(home, 'bench', 'results', basename(fresh)) : null
  if (keep && !existsSync(keep)) cpSync(fresh, keep, { recursive: true })
  const runs = readJson(join(fresh, 'runs.json'))
  const mine = (runs?.runs ?? []).filter((x) => x.config === 'builder')
  const first = mine[0]?.status ?? 'no builder run'
  const status = mine.some((x) => x.status === 'done') ? 'done' : first.startsWith('failed') ? first : `failed: ${first}`
  const prev = before.at(-1)
  const result = { id: it.id, size: it.size, kind: 'fixture', project: 'fixtures', control: it.control, status, measure: measureFromRuns(runs, 'builder'), baseline: prev ? measureFromRuns(readJson(join(prev, 'runs.json')), 'builder') : null, specLines: null, planLines: null, estimate: it.estimate }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  return status
}

/** Run a suite's unfinished items: one async loop per lane, a project mutex around every item, suite.json after each change, the reports at the end. */
async function runSuite(id) {
  const s = readSuite(id)
  s.pid = process.pid
  for (const it of s.items) if (unfinished(it)) Object.assign(it, { status: 'waiting', startedAt: null, endedAt: null })
  saveSuite(s)
  let main = null
  if (s.items.some((it) => it.control && unfinished(it))) {
    try {
      main = mainCheckout(s.builder)
      s.mainSha = tryGitIn(main, 'rev-parse', 'HEAD')
      s.mainLabel = builderLabel(main)
    } catch (e) {
      for (const it of s.items) if (it.control && unfinished(it)) Object.assign(it, { status: `failed: no main checkout for controls: ${firstLine(e.stderr || e.message)}`, endedAt: Date.now() })
    }
    saveSuite(s)
  }
  // the builder under test, pinned to the commit `run` recorded: a commit made tonight changes nothing that runs
  let treatment = s.builder
  const pin = s.treatment?.sha && !s.treatment.dirty ? s.treatment.sha : null
  if (pin && s.items.some((it) => !it.control && unfinished(it))) {
    try {
      treatment = pinnedCheckout(s.builder, pin)
    } catch (e) {
      treatment = null
      for (const it of s.items) if (!it.control && unfinished(it)) Object.assign(it, { status: `failed: no pinned checkout of the builder under test: ${firstLine(e.stderr || e.message)}`, endedAt: Date.now() })
      saveSuite(s)
    }
  }
  const held = new Map()
  /** Run fn once every earlier holder of `project` has finished: the packed order is the plan, this is the guarantee. */
  const exclusive = async (project, fn) => {
    const prev = held.get(project) ?? Promise.resolve()
    let release
    const gate = new Promise((r) => (release = r))
    held.set(project, prev.then(() => gate))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
  // anything an item throws fails that item alone: its lane goes on and the reports are still written
  const runItem = (it) => exclusive(it.project, async () => {
    if (stopping) return
    let status
    try {
      const out = freshOut(suiteDir(id), it.id)
      mkdirSync(out, { recursive: true })
      Object.assign(it, { status: 'running', startedAt: Date.now(), endedAt: null, out, pid: null })
      saveSuite(s)
      const checkout = it.control ? main : treatment
      const onSpawn = tracker(s, it)
      status = it.kind === 'fixture' ? await runFixture(it, checkout, out, onSpawn, s.builder) : await runArchived(it, checkout, out, id, onSpawn)
    } catch (e) {
      status = `failed: ${firstLine(e.message)}`
    }
    // a case cut short by a stop is `stopped`, so --resume runs it again
    if (stopping && status !== 'done') status = 'stopped'
    Object.assign(it, { status, endedAt: Date.now() })
    try {
      saveSuite(s)
    } catch (e) {
      console.error(`${new Date().toISOString()} could not save suite.json: ${firstLine(e.message)}`)
    }
    console.log(`${new Date().toISOString()} ${it.id}: ${status}`)
  })
  const lanes = [...new Set(s.items.map((it) => it.lane))]
  await Promise.all(lanes.map(async (lane) => {
    for (const it of s.items.filter((x) => x.lane === lane && unfinished(x))) {
      if (stopping) break
      await runItem(it)
    }
  }))
  if (pin && treatment) removeWorktree(s.builder, treatment)
  const paths = writeReports(id)
  console.log(`${new Date().toISOString()} suite ${id} ${stopping ? 'stopped' : 'finished'} — ${paths.named}`)
}

// ---- the report ------------------------------------------------------------------------------------

/** Every item's Result, in size order with each control after its case; an item with no result.json is reported from suite.json. */
function resultsOf(s) {
  const out = s.items.map((it) => {
    const r = it.out ? readJson(join(it.out, 'result.json')) : null
    if (r) return it.control ? { ...r, id: it.id, control: true } : r
    return { id: it.id, size: it.size, kind: it.kind, project: it.project, control: it.control, status: it.status, measure: null, baseline: null, specLines: null, planLines: null, estimate: it.estimate ?? null }
  })
  const base = (r) => r.id.replace(/@main$/, '')
  const sz = (r) => (SIZES.includes(r.size) ? SIZES.indexOf(r.size) : SIZES.length)
  return out.sort((a, b) => sz(a) - sz(b) || base(a).localeCompare(base(b)) || Number(!!a.control) - Number(!!b.control))
}

/**
 * The committed report (no project names) and the named one beside suite.json. The committed one is
 * <date>-suite/REPORT.md, or <date>-HHMM-suite/ (the suite id) when another suite has that date's; the
 * choice is kept in suite.json, so a rebuilt report stays where it was.
 */
function writeReports(id) {
  const s = readSuite(id)
  const results = resultsOf(s)
  if (!s.report) {
    const day = `${id.slice(0, 10)}-suite`
    s.report = existsSync(join(SUITE_OUT, day, 'REPORT.md')) ? id : day
    saveSuite(s)
  }
  const committed = join(SUITE_OUT, s.report, 'REPORT.md')
  const named = join(suiteDir(id), 'REPORT.md')
  const builder = { treatment: s.treatment ?? null, mainSha: s.mainSha ?? null, mainLabel: s.mainLabel ?? null }
  mkdirSync(dirname(committed), { recursive: true })
  writeFileSync(committed, renderSuiteReport(results, { names: false, builder }))
  writeFileSync(named, renderSuiteReport(results, { names: true, builder }))
  return { committed, named }
}

// ---- status ----------------------------------------------------------------------------------------

/** Per lane: the running item and its elapsed time, then done, failed (and other ends), waiting; a dead suite with work left says how to resume. */
export function renderStatus(s, { live, now = Date.now() }) {
  const out = [`# suite ${s.id} — ${live ? 'running' : s.items.some(unfinished) ? 'stopped' : 'finished'}`, '']
  for (const lane of [...new Set(s.items.map((it) => it.lane))].sort((a, b) => a - b)) {
    const its = s.items.filter((it) => it.lane === lane)
    const ended = (it) => {
      const m = /^([^:]+)(?::\s*(.*))?$/.exec(it.status)
      return m[2] ? `${m[1]} ${it.id} (${m[2]})` : `${m[1]} ${it.id}`
    }
    const parts = [
      ...its.filter((it) => it.status === 'running').map((it) => (live ? `running ${it.id} (${duration(now - it.startedAt)})` : `stopped ${it.id}`)),
      ...its.filter((it) => it.status === 'done').map((it) => `done ${it.id}`),
      ...its.filter((it) => !['running', 'done', 'waiting'].includes(it.status)).map(ended),
      ...its.filter((it) => it.status === 'waiting').map((it) => `waiting ${it.id}`),
    ]
    out.push(`lane ${lane}: ${parts.join(' · ')}`)
  }
  const left = s.items.filter(unfinished).length
  if (!live && left) out.push('', `⚠ suite stopped mid-run — ${left} unfinished; /builder:benchmark --resume ${s.id} runs them`)
  if (!live && !left) out.push('', `report: ${join(suiteDir(s.id), 'REPORT.md')}`)
  return out.join('\n')
}

/** Stop the running suite (SIGTERM; it stops its cases, writes the reports, releases the lock) and wait for it; with no live suite, stop any case the newest suite's attempts left alive. */
async function stop() {
  const lock = lockState()
  if (lock?.live) {
    process.kill(lock.pid, 'SIGTERM')
    for (const t0 = Date.now(); alive(lock.pid) && Date.now() - t0 < STOP_WAIT_MS; ) await sleep(100)
    if (alive(lock.pid)) return console.log(`suite ${lock.suiteId} is still stopping (pid ${lock.pid}) — /builder:benchmark --status`)
    return console.log(`suite ${lock.suiteId} stopped — /builder:benchmark --status; --resume ${lock.suiteId} runs what is left`)
  }
  const id = latestSuite()
  const left = id ? readSuite(id).items.filter(caseAlive) : []
  if (!left.length) return console.log('no suite is running')
  for (const it of left) {
    if (it.kind === 'fixture') await killTree(it.pid)
    else process.kill(it.pid, 'SIGTERM')
  }
  for (const t0 = Date.now(); left.some(caseAlive) && Date.now() - t0 < STOP_WAIT_MS; ) await sleep(100)
  const still = left.filter(caseAlive)
  console.log(still.length ? `still stopping: ${still.map((it) => `${it.id} (pid ${it.pid})`).join(', ')}` : `stopped the cases suite ${id} left running: ${left.map((it) => it.id).join(', ')}`)
}

function status() {
  const lock = lockState()
  const id = lock?.suiteId && readSuite(lock.suiteId) ? lock.suiteId : latestSuite()
  if (!id) return console.log('no suite has run here yet — /builder:benchmark starts one')
  console.log(renderStatus(readSuite(id), { live: !!(lock?.live && lock.suiteId === id) }))
}

// ---- the CLI ---------------------------------------------------------------------------------------

/** Start `_run <id>` detached (its own process group, which its case children share) and hand it the lock. */
function launch(id) {
  const outFd = openSync(join(suiteDir(id), 'suite.out'), 'a')
  const child = spawn(process.execPath, [SELF, '_run', id], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', outFd, outFd] })
  child.unref()
  if (!acquireLock(child.pid, id)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    die(busy(lockState()))
  }
  console.log(`suite started detached (pid ${child.pid}) — ${id} · /builder:benchmark --status`)
}

/** A suite id not yet used: <YYYY-MM-DD-HHMM>-suite, with -2, -3… after it when that minute is taken. */
function newSuiteId() {
  const base = runId('suite')
  let id = base
  for (let n = 2; existsSync(suiteDir(id)); n++) id = `${base}-${n}`
  return id
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const args = parseArgs(argv.slice(1))
  const plainId = (id) => {
    if (!id || id !== basename(id) || id.startsWith('.')) die(`suite id must be a plain directory name: '${id ?? ''}'`)
    if (!readSuite(id)) die(`no suite '${id}' under ${RESULTS}`)
    return id
  }

  if (cmd === 'list') {
    const cases = loadCatalogue()
    if (args.opts['--json']) console.log(JSON.stringify(cases, null, 2))
    else console.log(cases.length ? cases.map(label).join('\n') : 'no cases — bench/features/ and $BENCH_LOCAL/cases/ are empty')
    process.exit(0)
  }

  if (cmd === 'status') {
    status()
    process.exit(0)
  }

  if (cmd === 'stop') {
    await stop()
    process.exit(0)
  }

  if (cmd === 'report') {
    const id = plainId(args.pos[0])
    const { committed, named } = writeReports(id)
    console.log(`report: ${committed}\nnamed:  ${named}`)
    process.exit(0)
  }

  if (cmd === '_run') {
    const id = plainId(args.pos[0])
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stopCases)
    if (!acquireLock(process.pid, id)) die(busy(lockState()))
    try {
      await runSuite(id)
    } finally {
      releaseLock()
    }
    process.exit(0)
  }

  if (cmd === 'plan' || cmd === 'run') {
    // a suite runs only detached; the detached process itself is the internal `_run <id>`
    if (cmd === 'run' && !args.opts['--detach']) die('run needs --detach — a suite outlives this session')
    const resume = cmd === 'run' ? args.opts['--resume'] : undefined
    if (resume != null) {
      const id = plainId(resume)
      if (args.pos.length || args.opts['--all'] || args.opts['--budget'] || args.opts['--control'] || args.opts['--lanes'] || args.opts['--builder'] || args.opts['--allow-dirty']) die('--resume takes only the suite id (and --detach)')
      const held = lockState()
      if (held?.live) die(busy(held))
      const s = readSuite(id)
      const running = s.items.filter(caseAlive)
      if (running.length) die(running.map((it) => `${it.id} is still running (pid ${it.pid}) — /builder:benchmark --stop stops it`).join('\n'))
      const left = s.items.filter(unfinished)
      if (!left.length) {
        const { named } = writeReports(id)
        console.log(`suite ${id} has nothing left to run — report: ${named}`)
        process.exit(0)
      }
      const { refusals, summaries } = dryRuns(left, s.builder)
      if (refusals.length) {
        printRefusals(refusals)
        process.exit(2)
      }
      const warnings = warningsOf(summaries)
      printWarnings(warnings)
      saveSuite({ ...s, items: s.items.map((it) => (left.includes(it) ? withWarnings([it], warnings)[0] : it)) })
      launch(id)
      process.exit(0)
    }

    const lanes = lanesOf(args.opts)
    const builder = resolve(args.opts['--builder'] ?? BUILDER)
    const treatment = treatmentOf(builder, !!args.opts['--allow-dirty'])
    const catalogue = loadCatalogue()
    const { picked, controls, skipped, controlsGiven } = select(args, catalogue, lanes)
    const items = [...picked, ...controls]
    if (!items.length) die(`nothing to run${skipped.length ? ` — skipped: ${skipped.map((s) => `${s.id} — ${s.reason}`).join(' · ')}` : ''}`)
    const packed = packLanes(items, lanes)

    if (cmd === 'plan') {
      const recommended = controlsGiven ? [] : recommendControls(picked)
      console.log(renderSchedule({ packed, items, skipped, recommended, lanes }))
      // a database named in this shell is the human's: bench-case strips these from every case's setup, teardown and fleet
      const stripped = Object.keys(process.env).filter(strippedEnv).sort()
      if (stripped.length) console.log(`this shell sets ${stripped.join(', ')} — no case inherits them: setup, teardown and the fleet start without them, and a profile's env sets its own`)
      const { refusals, summaries } = dryRuns(items, builder)
      if (refusals.length) {
        printRefusals(refusals)
        process.exit(2)
      }
      if (summaries.length) {
        console.log(`\nwhat each clone will touch — clones: ${CLONE_ROOT}/<suite-id>/<item>/clone, removed after each case unless BENCH_KEEP_CLONES=1:\n`)
        console.log(summaries.map((x) => x.text).join('\n\n'))
        // a body: or files: line is a warning, never a refusal: prose naming something of the human's, a placed file worktrees won't get
        const warned = (x) => warningsOf([x]).get(x.id)?.length ?? 0
        console.log(`\ndry runs: ${summaries.map((x) => `${x.id} ok${warned(x) ? ` — ${warned(x)} warning${warned(x) > 1 ? 's' : ''}, ${WARNING_FIX}` : ''}`).join(' · ')}`)
      }
      process.exit(0)
    }

    const held = lockState()
    if (held?.live) die(busy(held))
    const { refusals, summaries } = dryRuns(items, builder)
    if (refusals.length) {
      printRefusals(refusals)
      process.exit(2)
    }
    const warnings = warningsOf(summaries)
    printWarnings(warnings)
    const id = newSuiteId()
    mkdirSync(suiteDir(id), { recursive: true })
    saveSuite({ id, builder, treatment, mainSha: null, lanes, createdAt: Date.now(), pid: null, items: withWarnings(scheduleItems(items, packed), warnings), skipped })
    launch(id)
    process.exit(0)
  }

  die(USAGE)
}
