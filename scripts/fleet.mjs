#!/usr/bin/env node
/**
 * fleet — take a batch of specs through the /builder:* pipeline unattended.
 *
 * Each spec gets its own worktree and branch (builder/<feature>). The BUILD lane runs up to
 * `parallel` of them at once with --no-dev-env, so nothing touches the shared dev environment; the
 * WALK lane takes them one at a time through that environment — walk readiness, the agent walk,
 * verify, the draft PR. Progress is read from each worktree's MANIFEST.md, never from a run's output.
 *
 *   node <plugin>/scripts/fleet.mjs <feature|path>… [--parallel N]
 *   node <plugin>/scripts/fleet.mjs --all [--parallel N]
 *   node <plugin>/scripts/fleet.mjs … --dry-run     # pre-flight and the plan; nothing created
 *   node <plugin>/scripts/fleet.mjs --status        # the last run's table
 *
 * State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes.
 */
import { spawn, execFile, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync, openSync, closeSync, cpSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve, relative } from 'node:path'
import { requireConfig } from './config.mjs'
import { parseManifest } from './manifest.mjs'
import { laneOf, decide, loadFleet, saveFleet, fleetDir } from './fleet-core.mjs'
import { waitsOn, waitsOnText } from './program.mjs'

const RUN_CAP = 12
const RUN_TIMEOUT_MS = Number(process.env.FLEET_RUN_TIMEOUT_MS) || 45 * 60 * 1000
const CLAUDE = process.env.FLEET_CLAUDE || 'claude'
const SMOKE_TIMEOUT_MS = Number(process.env.FLEET_SMOKE_TIMEOUT_MS) || 5 * 60 * 1000
const SMOKE_INTERVAL_MS = Number(process.env.FLEET_SMOKE_INTERVAL_MS) || 2000
const SMOKE_ATTEMPT_MS = 10 * 1000 // one probe that hangs (a half-up server) must not stall the poll
const START_GRACE_MS = 10 * 1000 // `start` with no `smoke`: give it this long, then walk
const KILL_GRACE_MS = 5 * 1000 // SIGTERM, then SIGKILL if the group is still there

const argv = process.argv.slice(2)
const USAGE = 'Usage: fleet.mjs <feature|path>… | --all [--parallel N] [--dry-run] [--status]'
const KNOWN_FLAGS = new Set(['--all', '--parallel', '--dry-run', '--status'])
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
    console.error(`Unknown flag ${a}. ${USAGE}`)
    process.exit(2)
  }
}
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
if (flag('--parallel')) {
  const v = opt('--parallel')
  if (!/^[1-9]\d*$/.test(v ?? '')) {
    console.error(`--parallel must be a positive integer, got '${v ?? ''}'. ${USAGE}`)
    process.exit(2)
  }
}
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--parallel')

const CFG = requireConfig()
const ROOT = CFG.root
const DIR = fleetDir(ROOT)

if (flag('--status')) {
  const p = join(DIR, 'STATUS.md')
  console.log(existsSync(p) ? readFileSync(p, 'utf8') : 'No fleet has run in this repo yet.')
  process.exit(0)
}

const AW = CFG.agentWalk
if (!AW) {
  console.error('No usable agent_walk: block in .claude/builder.md — run /builder:init --update to add one.')
  process.exit(2)
}
if (!AW.claudeArgs) {
  console.error('agent_walk.claude_args is not set — headless runs need explicit permissions. Run /builder:init --update.')
  process.exit(2)
}
const PARALLEL = Number(opt('--parallel')) || AW.parallel
const WORKTREES = AW.worktrees ? resolve(ROOT, AW.worktrees) : join(dirname(ROOT), `${basename(ROOT)}.fleet`)

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}
const specOf = (feature) => `${CFG.registry}/${feature}`
const readManifest = (base, feature) => {
  const p = join(base, specOf(feature), 'MANIFEST.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')
const nameOf = (a) => basename(a.replace(/\/(MANIFEST|SPEC)\.md$/, '').replace(/\/+$/, ''))

function requested() {
  if (!flag('--all')) return positional.map(nameOf)
  const reg = join(ROOT, CFG.registry)
  if (!existsSync(reg)) return []
  return readdirSync(reg).filter((n) => {
    const t = readManifest(ROOT, n)
    if (!t) return false
    const mf = parseManifest(t)
    return laneOf(mf) === 'build' && ['spec', 'aligned', 'audited'].includes(mf.state)
  })
}

/**
 * The branch a feature runs on: the one it is already underway on, else a fresh builder/<feature>.
 * Before `planned`, a manifest's `branch:` is the branch the spec was written on, not a build
 * branch — several specs may share it — so it is honoured only from `planned` on.
 */
const UNDERWAY = new Set(['planned', 'building', 'built', 'signed-off', 'verified'])
function branchOf(feature, mf) {
  const own = UNDERWAY.has(mf.state) && mf.branch && mf.branch !== 'none' ? mf.branch : null
  return own && own !== CFG.baseBranch ? own : `builder/${feature}`
}

/** The one reason this spec cannot join the fleet, or null. Accepts any step before the PR. */
function preflight(feature) {
  const spec = specOf(feature)
  const text = readManifest(ROOT, feature)
  if (text == null) return `no ${spec}/MANIFEST.md`
  if (tryGit(['ls-files', '--error-unmatch', `${spec}/MANIFEST.md`]) === null) return `${spec} is not committed — commit it so the worktree gets it`
  if (tryGit(['diff', '--quiet', 'HEAD', '--', spec]) === null) return `${spec} has uncommitted changes — commit them first`
  const mf = parseManifest(text)
  const lane = laneOf(mf)
  if (lane === 'blocked') return `${spec} is blocked: ${unquote(mf.blocked)}`
  if (lane === 'done') return `${spec} already has a PR (${mf.pr ?? 'shipped'}) — nothing left for the fleet`
  if (lane === 'unknown') return `${spec} is at a state the fleet doesn't know (${mf.state ?? 'none'})`
  // A program child builds off HEAD, so the contract it consumes must already be merged there.
  const waits = waitsOn(ROOT, CFG.registry, feature)
  if (waits.length) return `${waitsOnText(waits)} — a chain runs one wave per fleet run, after each merge`
  const branch = branchOf(feature, mf)
  if (tryGit(['branch', '--show-current']) === branch)
    return `${branch} is checked out in this folder — switch away, or run /builder:resume --path ${spec} here`
  if (!branch.startsWith('builder/') && tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) === null)
    return `its manifest names branch ${branch}, which doesn't exist locally — fetch it first`
  return worktreeProblem(feature, branch)
}

function worktreeProblem(feature, branch) {
  const wt = join(WORKTREES, feature)
  if (!existsSync(wt)) return null
  const cur = tryGit(['branch', '--show-current'], wt)
  return cur === branch ? null : `${wt} exists on branch '${cur}', not ${branch}`
}

/**
 * The env a child the fleet spawns gets. CLAUDE_PROJECT_DIR is always dropped so the child reads
 * ITS worktree's config and manifests, never the main checkout's. Only the WALK lane — its
 * `claude -p` runs and the reset/start/smoke/stop hooks — also gets agent_walk.env, with {feature}
 * filled in, which is how two worktrees' walk envs get their own ports and databases. The build
 * lane and `setup` never see it: build lanes run while a walk is up, and a build's gates pointed
 * at the walk env's ports and database would collide with it or write into it.
 */
function envFor(feature, lane) {
  const env = { ...process.env }
  if (lane === 'walk') for (const [k, v] of Object.entries(AW.env)) env[k] = v.replaceAll('{feature}', feature)
  // Deleted AFTER the merge: agent_walk.env accepts any key, and letting it put this one back
  // would point every child at one fixed checkout — the bug the delete exists to prevent.
  delete env.CLAUDE_PROJECT_DIR
  return env
}

const addNote = (note) => {
  fleet.notes = [...new Set([...(fleet.notes ?? []), note])]
}

/**
 * Bring agent_walk.copy's untracked files (a .env, local certs) from the main checkout into a new
 * worktree. A tracked file is never overwritten — the branch's committed version is the one the
 * build must see, and a local edit in the main checkout would silently leak into it otherwise.
 */
function copyInto(wt) {
  const tracked = new Set(git(['ls-files', '-z'], wt).split('\0').filter(Boolean))
  for (const rel of AW.copy) {
    const src = join(ROOT, rel)
    if (!existsSync(src)) {
      addNote(`agent_walk.copy: ${rel} doesn't exist in ${ROOT} — skipped`)
      continue
    }
    const skipped = []
    cpSync(src, join(wt, rel), {
      recursive: true,
      filter: (from) => {
        const r = relative(ROOT, from)
        if (!tracked.has(r) || statSync(from).isDirectory()) return true
        skipped.push(r)
        return false
      },
    })
    for (const r of skipped) addNote(`agent_walk.copy: ${r} is tracked — the worktree keeps the committed version`)
  }
}

/** agent_walk.setup in a new worktree, output to logs/<feature>-setup.log. Throws, naming the log, on failure. */
function runSetup(feature, wt) {
  const log = join(DIR, 'logs', `${feature}-setup.log`)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  try {
    execSync(AW.setup, { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    throw Object.assign(new Error(`setup failed — see ${log}`), { setup: true })
  } finally {
    closeSync(fd)
  }
}

/**
 * The feature's worktree, created if it isn't there yet. Only a NEW worktree gets `copy` and
 * `setup` — a reused one already has them, and re-running an install on every fleet run is minutes
 * of nothing. The one exception is a setup that failed: `setupOwed` stays on the row until setup
 * succeeds, so fixing the command and re-running the fleet retries it instead of building on a
 * worktree that never got its dependencies.
 */
function ensureWorktree(feature, branch) {
  const problem = worktreeProblem(feature, branch)
  if (problem) throw new Error(problem)
  const f = fleet.features[feature]
  const wt = join(WORKTREES, feature)
  if (!existsSync(wt)) {
    mkdirSync(WORKTREES, { recursive: true })
    const exists = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null
    git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, 'HEAD'])
    // Owed BEFORE the copy: a copy that throws leaves a worktree that exists, and the next run
    // would otherwise take it as fully prepared and never run setup.
    if (AW.setup) f.setupOwed = true
    copyInto(wt)
  }
  if (f.setupOwed) {
    runSetup(feature, wt)
    delete f.setupOwed
  }
  return wt
}

// ---- dry run -------------------------------------------------------------------------------
const fleet = loadFleet(ROOT)
const asked = requested()
if (!asked.length && !Object.keys(fleet.features).length) {
  console.error('Name the specs to run (feature names or folders), or pass --all.')
  process.exit(2)
}
const fresh = []
const refused = {}
const branchOwner = new Map(Object.entries(fleet.features).map(([f, row]) => [row.branch, f]))
for (const feature of asked) {
  if (fleet.features[feature]) continue // already in the fleet — resumed below
  let why = preflight(feature)
  const branch = why ? null : branchOf(feature, parseManifest(readManifest(ROOT, feature)))
  if (!why && branchOwner.has(branch)) why = `${branchOwner.get(branch)} and ${feature} both resolve to branch ${branch}`
  if (why) refused[feature] = why
  else {
    fresh.push(feature)
    branchOwner.set(branch, feature)
  }
}

if (flag('--dry-run')) {
  console.log('builder fleet — plan (nothing created)')
  console.log(`  worktrees:   ${WORKTREES}`)
  console.log(`  permissions: claude ${AW.claudeArgs}`)
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: one at a time`)
  console.log('  pushes a branch and opens DRAFT PRs for each feature that passes')
  for (const f of fresh) console.log(`  ✓ ${f} → ${branchOf(f, parseManifest(readManifest(ROOT, f)))}`)
  for (const [f, why] of Object.entries(refused)) console.log(`  ✗ ${f} — ${why}`)
  for (const [f, row] of Object.entries(fleet.features)) console.log(`  ↻ ${f} — resuming (${row.status})`)
  process.exit(0)
}

// ---- lock ----------------------------------------------------------------------------------
const LOCK = join(DIR, 'lock')
mkdirSync(DIR, { recursive: true })
/** Create the lock only if there is none — 'wx' makes check-and-take one step. */
const takeLock = () => {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}
let tookOverStaleLock = false
if (!takeLock()) {
  let pid = NaN
  try {
    pid = Number(readFileSync(LOCK, 'utf8'))
  } catch {}
  let alive = false
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      alive = true
    } catch (e) {
      alive = e.code === 'EPERM'
    }
  }
  if (alive) {
    console.error(`Another fleet is running in this repo (pid ${pid}). Stop it, or wait for it.`)
    process.exit(3)
  }
  console.error(`note: taking over a stale fleet lock (pid ${pid} is gone)`)
  try {
    unlinkSync(LOCK)
  } catch {}
  if (!takeLock()) {
    console.error('Another fleet took the lock just now. Stop it, or wait for it.')
    process.exit(3)
  }
  tookOverStaleLock = true
}
const unlock = () => {
  try {
    unlinkSync(LOCK)
  } catch {}
}
process.on('exit', unlock)
const save = () => saveFleet(ROOT, fleet)
const active = new Set()
let stopping = false
const stopAll = (code) => {
  if (stopping) return
  stopping = true
  for (const c of active) {
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {}
  }
  // A walk cut short still gets its dev env stopped: its `start` group first, then `stop`.
  for (const f of Object.values(fleet.features)) killStartSync(f)
  for (const [name, f] of Object.entries(fleet.features)) if (f.status === 'walking' && f.worktree) hook(AW.stop, f.worktree, name)
  save()
  unlock()
  process.exit(code)
}
process.on('SIGINT', () => stopAll(130))
process.on('SIGTERM', () => stopAll(143))
process.on('SIGHUP', () => stopAll(129))
process.on('unhandledRejection', (e) => {
  console.error('fleet: unhandled rejection:', e)
  stopAll(1)
})
process.on('uncaughtException', (e) => {
  console.error('fleet: uncaught exception:', e)
  stopAll(1)
})

// The fleet that left the stale lock may have left its headless runs behind — end them before
// their features are queued again, or two runs would work one worktree.
if (tookOverStaleLock) {
  for (const f of Object.values(fleet.features)) {
    for (const pgid of [f.pgid, f.startPgid]) {
      if (!pgid) continue
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {}
    }
    delete f.pgid
    delete f.startPgid
  }
}

for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null }

// ---- one claude run ------------------------------------------------------------------------
function runClaude(wt, feature, lane, n) {
  const prompt = `/builder:resume --path ${specOf(feature)} --agent-walk${lane === 'build' ? ' --no-dev-env' : ''}`
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  const env = envFor(feature, lane)
  return new Promise((done) => {
    const out = createWriteStream(log)
    let settled = false
    let timedOut = false
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(child)
      delete fleet.features[feature].pgid
      save()
      try {
        child.stdout.destroy()
      } catch {}
      try {
        child.stderr.destroy()
      } catch {}
      out.end(() => done({ exit, log }))
    }
    // detached: true makes the child its own process-group leader, so a grandchild it leaves
    // behind (a dev server, an MCP server, a test watcher) can be killed along with it — a plain
    // `child.kill()` only reaches the direct child, and 'close' never fires while a grandchild
    // still holds the inherited stdout/stderr pipes open.
    const child = spawn(CLAUDE, ['-p', prompt, ...AW.claudeArgs.split(/\s+/).filter(Boolean)], {
      cwd: wt,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    active.add(child)
    // Recorded so a fleet that takes over this one's stale lock can end the group.
    if (child.pid) {
      fleet.features[feature].pgid = child.pid
      save()
    }
    child.stdout.pipe(out, { end: false })
    child.stderr.pipe(out, { end: false })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, RUN_TIMEOUT_MS)
    child.on('error', (e) => {
      out.write(`\n[fleet] could not start ${CLAUDE}: ${e.message}\n`)
      finish(127)
    })
    // 'close' covers the normal case (fires as soon as the child exits and its pipes are drained).
    // 'exit' is the fallback for a child that leaves a grandchild holding those pipes open: give
    // the pipes a short grace period to drain on their own, then settle regardless.
    child.on('exit', (code) => {
      const exit = timedOut ? null : (code ?? 1)
      setTimeout(() => finish(exit), 500)
    })
    child.on('close', (code) => finish(timedOut ? null : (code ?? 1)))
  })
}

const snapshot = (wt, feature) => `${readManifest(wt, feature)}\n@${tryGit(['rev-parse', 'HEAD'], wt)}`

/** Run a feature's lane until it hands off, finishes, parks or fails. Returns the outcome. */
async function drive(feature, lane) {
  const f = fleet.features[feature]
  let failures = 0
  for (;;) {
    const before = snapshot(f.worktree, feature)
    f.runs = (f.runs ?? 0) + 1 // lifetime, for the table and the log names
    f.runsThisTime = (f.runsThisTime ?? 0) + 1 // this fleet run, for the cap
    save()
    const { exit, log } = await runClaude(f.worktree, feature, lane, f.runs)
    f.log = log
    const d = decide({
      lane,
      manifestText: readManifest(f.worktree, feature),
      exit,
      failures,
      runs: f.runsThisTime,
      cap: RUN_CAP,
      progressed: snapshot(f.worktree, feature) !== before,
    })
    if (d.action === 'retry') {
      failures++
      continue
    }
    failures = 0
    if (d.action === 'again') continue
    if (d.action === 'handoff') {
      Object.assign(f, { status: 'awaiting-walk', reason: null })
      save()
      return 'handoff'
    }
    if (d.action === 'done') {
      Object.assign(f, { status: 'done', pr: d.pr, reason: null, evidence: join(f.worktree, '.builder', feature, 'agent-walk') })
      save()
      return 'done'
    }
    Object.assign(f, d.action === 'fail' ? { status: 'failed', reason: `${d.reason} — see ${log}` } : { status: 'parked', reason: d.reason })
    save()
    return f.status
  }
}

/** A config hook (reset/stop) in the worktree, with the feature's walk env. False when it failed. */
function hook(cmd, cwd, feature) {
  if (!cmd) return true
  try {
    execSync(cmd, { cwd, env: envFor(feature, 'walk'), stdio: 'ignore', timeout: 10 * 60 * 1000 })
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * Bring up the feature's own dev env: `start` detached (its own process group, so everything it
 * forks — a watcher, a DB, a server — goes down with one kill), then poll `smoke` until it passes.
 * True when the env is up. False when smoke never passed in time or `start` exited first — a dev
 * server that dies at once won't come back by waiting, so the exit ends the poll early.
 */
async function startWalkEnv(feature) {
  const f = fleet.features[feature]
  const log = join(DIR, 'logs', `${feature}-start.log`)
  mkdirSync(dirname(log), { recursive: true })
  f.startLog = log
  const fd = openSync(log, 'w')
  const child = spawn('sh', ['-c', AW.start], { cwd: f.worktree, env: envFor(feature, 'walk'), stdio: ['ignore', fd, fd], detached: true })
  closeSync(fd) // the child holds its own copy
  let exited = false
  const gone = new Promise((r) => {
    child.on('exit', () => r((exited = true)))
    child.on('error', () => r((exited = true)))
  })
  // Recorded so stopAll, and a fleet that takes over this one's stale lock, can end the group.
  if (child.pid) {
    f.startPgid = child.pid
    save()
  }
  if (!AW.smoke) {
    await Promise.race([gone, sleep(START_GRACE_MS)])
    return !exited
  }
  const deadline = Date.now() + SMOKE_TIMEOUT_MS
  const probe = () =>
    new Promise((r) =>
      execFile('sh', ['-c', AW.smoke], { cwd: f.worktree, env: envFor(feature, 'walk'), timeout: SMOKE_ATTEMPT_MS }, (err) => r(!err))
    )
  for (;;) {
    if (exited) return false
    if (await probe()) return !exited
    if (Date.now() >= deadline) return false
    await Promise.race([gone, sleep(Math.min(SMOKE_INTERVAL_MS, Math.max(0, deadline - Date.now())))])
  }
}

/** End a feature's `start` group: SIGTERM, then SIGKILL if it outlives the grace period. */
async function killStart(f) {
  const pgid = f.startPgid
  if (!pgid) return
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {}
  for (const until = Date.now() + KILL_GRACE_MS; groupAlive(pgid) && Date.now() < until; ) await sleep(100)
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {}
  delete f.startPgid
  save()
}

/** killStart for stopAll, which is synchronous — it exits right after, so no event loop to wait on. */
function killStartSync(f) {
  const pgid = f.startPgid
  if (!pgid) return
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {}
  const tick = new Int32Array(new SharedArrayBuffer(4))
  for (const until = Date.now() + KILL_GRACE_MS; groupAlive(pgid) && Date.now() < until; ) Atomics.wait(tick, 0, 0, 100)
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {}
  delete f.startPgid
}

async function walkOne(feature) {
  const f = fleet.features[feature]
  f.status = 'walking'
  save()
  try {
    if (!hook(AW.reset, f.worktree, feature)) {
      Object.assign(f, { status: 'parked', reason: `agent_walk.reset failed: ${AW.reset}` })
      save()
      return
    }
    // `smoke` without `start` has nothing to probe — ignored, as the spec says.
    if (AW.start && !(await startWalkEnv(feature))) {
      Object.assign(f, { status: 'parked', reason: `walk env didn't come up — see ${f.startLog}` })
      save()
      return
    }
    await drive(feature, 'walk')
  } finally {
    await killStart(f)
    if (!hook(AW.stop, f.worktree, feature)) {
      addNote(`agent_walk.stop failed after ${feature}: ${AW.stop}`)
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const buildQueue = []
const walkQueue = []
for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  f.runsThisTime = 0 // a parked or failed feature re-queued here gets a fresh cap
  try {
    f.worktree = ensureWorktree(feature, f.branch)
  } catch (e) {
    Object.assign(f, { status: 'failed', reason: e.setup ? e.message : `worktree: ${e.message.split('\n')[0]}` })
    continue
  }
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  const lane = text == null ? 'unknown' : laneOf(mf)
  if (lane === 'blocked') Object.assign(f, { status: 'parked', reason: unquote(mf.blocked) })
  else if (lane === 'done') Object.assign(f, { status: 'done', pr: mf.pr ?? null, reason: null })
  else if (lane === 'build') Object.assign(f, { status: 'queued', reason: null }) && buildQueue.push(feature)
  else if (lane === 'walk') Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature)
  else Object.assign(f, { status: 'parked', reason: 'MANIFEST.md missing or its state not understood' })
}
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('No agent_walk.reset'))
if (!AW.reset) fleet.notes.push('No agent_walk.reset — dev-DB state accumulates from one walk to the next.')
if ('CLAUDE_PROJECT_DIR' in AW.env) addNote('agent_walk.env may not set CLAUDE_PROJECT_DIR — it was ignored; each child reads its own worktree.')
save()

// ---- the two lanes -------------------------------------------------------------------------
let wake = () => {}
const signal = () => wake()
const nextWake = () => new Promise((r) => (wake = r))
let buildsDone = false

async function buildWorker() {
  while (buildQueue.length) {
    const feature = buildQueue.shift()
    fleet.features[feature].status = 'building'
    save()
    if ((await drive(feature, 'build')) === 'handoff') {
      walkQueue.push(feature)
      signal()
    }
  }
}

async function walkLane() {
  for (;;) {
    if (walkQueue.length) {
      await walkOne(walkQueue.shift())
      continue
    }
    if (buildsDone) return
    await nextWake()
  }
}

await Promise.all([
  Promise.all(Array.from({ length: PARALLEL }, buildWorker)).then(() => {
    buildsDone = true
    signal()
  }),
  walkLane(),
])

save()
unlock()
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
