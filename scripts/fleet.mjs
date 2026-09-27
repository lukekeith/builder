#!/usr/bin/env node
/**
 * fleet — take a batch of specs through the /builder:* pipeline unattended.
 *
 * Everything lands on ONE branch: the one checked out here when the fleet first ran (its TARGET).
 * Each spec gets its own worktree and branch (builder/<feature>) cut from the target. A pool of
 * `parallel` workers runs the BUILD and SHIP lanes with --no-dev-env, so nothing touches the shared
 * dev environment; the WALK lane takes features one at a time through that environment — walk
 * readiness, the agent walk and its sign-off, verify. The SHIP lane brings the target in and writes
 * the ship commit; then the fleet merges the feature into the target here (--no-ff, one merge
 * commit per feature) and removes its worktree and branch. Nothing is pushed. Progress is read from
 * each worktree's MANIFEST.md (and, once shipped, its SPEC header), never from a run's output.
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
import { laneOf, decide, loadFleet, saveFleet, fleetDir, shippedPr, renderStatus, readProgress } from './fleet-core.mjs'
import { waitsOn, waitsOnText } from './program.mjs'
import { parseGates } from './gates-core.mjs'
import { fileURLToPath } from 'node:url'

const RUN_CAP = 12
// A run is killed when it goes quiet, not when it runs long: a 20-task build can take hours and
// still be healthy. Its stream-json output is the heartbeat. The hard cap is only a backstop.
const IDLE_TIMEOUT_MS = Number(process.env.FLEET_IDLE_TIMEOUT_MS) || 30 * 60 * 1000
const RUN_TIMEOUT_MS = Number(process.env.FLEET_RUN_TIMEOUT_MS) || 6 * 60 * 60 * 1000
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

// Progress is read live from each feature's worktree (or the root before it has one): the manifest's
// state, the plan's tasks and the ledger's completed ones. A few small files per feature.
const progressOf = (feature, f) => readProgress(f.worktree && existsSync(f.worktree) ? f.worktree : ROOT, CFG.registry, feature, f.status)

if (flag('--status')) {
  const fleet = existsSync(join(DIR, 'fleet.json')) ? loadFleet(ROOT) : null
  console.log(fleet ? renderStatus(fleet, progressOf) : 'No fleet has run in this repo yet.')
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
const readSpec = (base, feature) => {
  const p = join(base, specOf(feature), 'SPEC.md')
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
 * Until the build starts, a manifest's `branch:` is the branch the spec and plan were written on,
 * not a build branch — several specs may share it (and one of them may be building there) — so it
 * is honoured only from `building` on.
 */
const UNDERWAY = new Set(['building', 'built', 'signed-off', 'verified'])
function branchOf(feature, mf) {
  const own = UNDERWAY.has(mf.state) && mf.branch && mf.branch !== 'none' ? mf.branch : null
  return own && own !== CFG.baseBranch && own !== TARGET ? own : `builder/${feature}`
}

/** The one reason this spec cannot join the fleet, or null. Accepts any step before the PR. */
function preflight(feature) {
  const spec = specOf(feature)
  const text = readManifest(ROOT, feature)
  if (text == null && shippedPr(readSpec(ROOT, feature))) return `${spec} already shipped — nothing left for the fleet`
  if (text == null) return `no ${spec}/MANIFEST.md`
  if (tryGit(['ls-files', '--error-unmatch', `${spec}/MANIFEST.md`]) === null) return `${spec} is not committed — commit it so the worktree gets it`
  if (tryGit(['diff', '--quiet', 'HEAD', '--', spec]) === null) return `${spec} has uncommitted changes — commit them first`
  const mf = parseManifest(text)
  const lane = laneOf(mf)
  if (lane === 'blocked') return `${spec} is blocked: ${unquote(mf.blocked)}`
  if (lane === 'done') return `${spec} already shipped — nothing left for the fleet`
  if (lane === 'unknown') return `${spec} is at a state the fleet doesn't know (${mf.state ?? 'none'})`
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
 * ITS worktree's config and manifests, never the main checkout's. Every child — any lane, and
 * `setup` — gets agent_walk.worktree_env with {feature} filled in. Only the WALK lane — its
 * `claude -p` runs and the reset/start/smoke/stop hooks — also gets agent_walk.env, with {feature}
 * filled in, which is how two worktrees' walk envs get their own ports and databases. The build
 * lane and `setup` never see `env`: build lanes run while a walk is up, and a build's gates pointed
 * at the walk env's ports and database would collide with it or write into it.
 */
function envFor(feature, lane) {
  const env = { ...process.env }
  // worktree_env first, every lane: it is how each worktree's tests get their own database, which
  // is what lets `parallel` builds share a machine without sharing a test DB.
  for (const [k, v] of Object.entries(AW.worktreeEnv)) env[k] = v.replaceAll('{feature}', feature)
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

/** agent_walk.setup in a new worktree ({feature} filled in), output to logs/<feature>-setup.log. Throws, naming the log, on failure. */
function runSetup(feature, wt) {
  const log = join(DIR, 'logs', `${feature}-setup.log`)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  try {
    execSync(AW.setup.replaceAll('{feature}', feature), { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
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
    git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, `refs/heads/${TARGET}`])
    // Owed BEFORE the copy, and SAVED at once: a copy that throws leaves a worktree that exists,
    // and a fleet killed before its next save would otherwise take it as fully prepared on the
    // re-run and never run setup (seen: a setup that failed, then a kill during the baseline).
    if (AW.setup) {
      f.setupOwed = true
      save()
    }
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
/**
 * The branch every finished feature is merged into: the one checked out here when this fleet first
 * ran, kept in fleet.json so a re-run lands on the same one.
 */
const HERE = tryGit(['branch', '--show-current'])
if (!HERE) {
  console.error('This checkout is on a detached HEAD — check out the branch the features should be merged into.')
  process.exit(2)
}
if (fleet.target && fleet.target !== HERE && Object.values(fleet.features).some((f) => f.status !== 'done')) {
  console.error(`This fleet merges into ${fleet.target}, but ${HERE} is checked out. Switch back to ${fleet.target}, or finish or clear that fleet (.builder/fleet/) first.`)
  process.exit(2)
}
const TARGET = HERE
const asked = requested()
if (!asked.length && !Object.keys(fleet.features).length) {
  console.error('Name the specs to run (feature names or folders), or pass --all.')
  process.exit(2)
}
const fresh = []
const refused = {}
const after = {} // feature → the dependencies in this run it waits for
const branchOwner = new Map(Object.entries(fleet.features).map(([f, row]) => [row.branch, f]))
const inRun = new Set([...asked, ...Object.keys(fleet.features)])
for (const feature of asked) {
  if (fleet.features[feature]) continue // already in the fleet — resumed below
  let why = preflight(feature)
  const branch = why ? null : branchOf(feature, parseManifest(readManifest(ROOT, feature)))
  if (!why && branchOwner.has(branch)) why = `${branchOwner.get(branch)} and ${feature} both resolve to branch ${branch}`
  // A program child builds against its dependencies' merged code. One this run will ship is
  // waited for; one nothing here will ship is a refusal, not a wait that never ends.
  const waits = why ? [] : waitsOn(ROOT, CFG.registry, feature).filter((d) => fleet.features[d.name]?.status !== 'done')
  const outside = waits.filter((d) => !inRun.has(d.name))
  if (!why && outside.length) why = `${waitsOnText(outside)} — not in this run, so nothing here will ship it`
  if (why) refused[feature] = why
  else {
    fresh.push(feature)
    branchOwner.set(branch, feature)
    if (waits.length) after[feature] = waits.map((d) => d.name)
  }
}
// A dependency refused above can't ship either — its waiters go with it.
for (let changed = true; changed; ) {
  changed = false
  for (const f of fresh.filter((x) => after[x]?.some((d) => refused[d]))) {
    refused[f] = `waits on ${after[f].filter((d) => refused[d]).join(', ')}, which can't run`
    fresh.splice(fresh.indexOf(f), 1)
    changed = true
  }
}

if (flag('--dry-run')) {
  console.log('builder fleet — plan (nothing created)')
  console.log(`  merges into: ${TARGET} (this checkout) — one merge commit per finished feature; nothing is pushed`)
  console.log(`  worktrees:   ${WORKTREES}`)
  console.log(`  permissions: claude ${AW.claudeArgs}`)
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: one at a time`)
  for (const f of fresh)
    console.log(`  ${after[f] ? '⏳' : '✓'} ${f} → ${branchOf(f, parseManifest(readManifest(ROOT, f)))}${after[f] ? `, once ${after[f].join(', ')} merge${after[f].length > 1 ? '' : 's'}` : ''}`)
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
const save = () => saveFleet(ROOT, fleet, progressOf)
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

fleet.target = TARGET
for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null, ...(after[f] && { waitsOn: after[f] }) }

// ---- one claude run ------------------------------------------------------------------------
function runClaude(wt, feature, lane, n) {
  const prompt = `/builder:resume --path ${specOf(feature)} --agent-walk --into ${TARGET}${lane === 'walk' ? '' : ' --no-dev-env'}`
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  const env = envFor(feature, lane)
  return new Promise((done) => {
    const out = createWriteStream(log)
    const raw = createWriteStream(log.replace(/\.log$/, '.jsonl'))
    let settled = false
    let timedOut = false
    const kill = () => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    let idle = setTimeout(kill, IDLE_TIMEOUT_MS)
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(idle)
      raw.end()
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
    const child = spawn(CLAUDE, ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...AW.claudeArgs.split(/\s+/).filter(Boolean)], {
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
    // The raw stream goes to <log>.jsonl; the .log gets what a human reads — the run's own words
    // as it goes, and its final result. Any output at all resets the idle timer.
    let buf = ''
    const seen = { lastText: '' }
    child.stdout.on('data', (chunk) => {
      clearTimeout(idle)
      idle = setTimeout(kill, IDLE_TIMEOUT_MS)
      raw.write(chunk)
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) out.write(readable(line, seen))
    })
    child.stderr.on('data', (chunk) => {
      clearTimeout(idle)
      idle = setTimeout(kill, IDLE_TIMEOUT_MS)
      out.write(chunk)
    })
    const timer = setTimeout(kill, RUN_TIMEOUT_MS)
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

/** One stream-json line as log text: assistant prose and the final result; anything else verbatim
 *  unless it is JSON, which only the .jsonl keeps. The result is the last assistant message's text
 *  again, so it is dropped when it repeats what was just written — the log said it once. */
function readable(line, seen = { lastText: '' }) {
  if (!line.trim()) return ''
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return `${line}\n`
  }
  if (ev.type === 'result') {
    const text = (ev.result ?? '').trim()
    return text && text === seen.lastText ? '' : `\n${ev.result ?? ''}\n`
  }
  if (ev.type === 'assistant') {
    const texts = (ev.message?.content ?? []).filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text.trim())
    if (texts.length) seen.lastText = texts[texts.length - 1]
    return texts.map((t) => `· ${t}\n`).join('')
  }
  return ''
}

const snapshot = (wt, feature) => `${readManifest(wt, feature)}\n@${tryGit(['rev-parse', 'HEAD'], wt)}`


const QUEUED = { build: 'queued', walk: 'awaiting-walk', ship: 'awaiting-ship' }

/**
 * Merge a shipped feature into the target, here, and clear its worktree and branch. Synchronous, so
 * two features never merge at once. `--no-ff` keeps one merge commit per feature — easy to find, and
 * `git revert -m 1` takes a feature back out. A refusal (your uncommitted changes overlap, or the
 * target moved into a conflict) parks the feature; the next fleet run retries the merge.
 */
function land(feature) {
  const f = fleet.features[feature]
  f.pr = shippedPr(readSpec(f.worktree, feature))
  if (f.pr && !/^#/.test(f.pr)) f.pr = null
  const merged = () => tryGit(['merge-base', '--is-ancestor', f.branch, TARGET]) !== null
  if (!merged()) {
    const here = tryGit(['branch', '--show-current'])
    if (here !== TARGET) return park(f, `shipped, but this checkout is on ${here ?? 'a detached HEAD'}, not ${TARGET} — switch back and re-run the fleet to merge it`)
    try {
      execFileSync('git', ['merge', '--no-ff', '--no-edit', '-m', `merge(${feature}): agent-verified, not human-tested`, f.branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      tryGit(['merge', '--abort'])
      const why = String(e.stderr || e.stdout || e.message).split('\n').find((l) => l.trim()) ?? 'git merge failed'
      return park(f, `shipped, but merging into ${TARGET} failed: ${why.trim()} — clears when that is fixed; re-run the fleet to merge it`)
    }
  }
  Object.assign(f, { status: 'done', reason: null, merged: tryGit(['rev-parse', '--short', TARGET]) })
  // The worktree held nothing but this branch; a tracked change there would be lost, so only a
  // clean one goes (untracked files — a copied .env, walk evidence — go with it).
  if (f.worktree && existsSync(f.worktree) && tryGit(['status', '--porcelain', '--untracked-files=no'], f.worktree) === '') {
    if (tryGit(['worktree', 'remove', '--force', f.worktree]) !== null) {
      f.worktree = null
      if (f.branch.startsWith('builder/')) tryGit(['branch', '-d', f.branch])
    }
  }
  if (f.worktree) addNote(`${feature} merged; its worktree ${f.worktree} was kept (it has changes) — remove it with git worktree remove`)
  save()
  return 'done'
}

function park(f, reason) {
  Object.assign(f, { status: 'parked', reason })
  save()
  return 'parked'
}
const RUNNING = { build: 'building', walk: 'walking', ship: 'shipping' }

/** Run a feature's lane until it hands off, finishes, parks or fails. Returns the outcome — for a
 *  handoff, the lane it goes to next. */
async function drive(feature, lane) {
  const f = fleet.features[feature]
  let failures = 0
  let stalls = 0
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
      specText: readSpec(f.worktree, feature),
      exit,
      failures,
      stalls,
      runs: f.runsThisTime,
      cap: RUN_CAP,
      progressed: snapshot(f.worktree, feature) !== before,
    })
    if (d.action === 'retry') {
      failures++
      continue
    }
    failures = 0
    if (d.action === 'stalled') {
      stalls++
      continue
    }
    stalls = 0
    if (d.action === 'again') continue
    if (d.action === 'handoff') {
      Object.assign(f, { status: QUEUED[d.to] ?? 'queued', reason: null })
      save()
      return d.to
    }
    if (d.action === 'done') return land(feature)
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

/** The manifest states at which the walk lane merges the target in before starting the env: before
 *  walk readiness (it re-smokes the merged code) and before verify (it re-gates it). Never at
 *  `built` with the walk still owed — a merge there would void the readiness the walk needs, and
 *  the run would bounce between readiness and the walk. */
const SYNC_BEFORE_WALK = new Set(['building', 'signed-off'])

async function walkOne(feature) {
  const f = fleet.features[feature]
  f.status = 'walking'
  save()
  try {
    const text = readManifest(f.worktree, feature)
    if (text && SYNC_BEFORE_WALK.has(parseManifest(text).state)) {
      const why = syncTarget(f.worktree, 'what other features merged', feature)
      if (why) return park(f, why)
    }
    if (!hook(AW.reset, f.worktree, feature)) {
      Object.assign(f, { status: 'parked', reason: `agent_walk.reset failed: ${AW.reset}` })
      save()
      return 'parked'
    }
    // `smoke` without `start` has nothing to probe — ignored, as the spec says.
    if (AW.start && !(await startWalkEnv(feature))) {
      Object.assign(f, { status: 'parked', reason: `walk env didn't come up — see ${f.startLog}` })
      save()
      return 'parked'
    }
    return await drive(feature, 'walk')
  } finally {
    await killStart(f)
    if (!hook(AW.stop, f.worktree, feature)) {
      addNote(`agent_walk.stop failed after ${feature}: ${AW.stop}`)
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const pool = [] // { feature, lane: 'build' | 'ship' } — the parallel workers' queue
const walkQueue = []
const pendingDeps = (f) => (f.waitsOn ?? []).filter((d) => fleet.features[d]?.status !== 'done')

/**
 * Put a feature in the queue its manifest says. A program child still waiting on a dependency
 * gets no worktree yet: it is branched once they have merged, so it starts from their code.
 */
function enqueue(feature) {
  const f = fleet.features[feature]
  const pending = pendingDeps(f)
  if (pending.length) {
    Object.assign(f, { status: 'waiting', waitsOn: pending, reason: `after ${pending.join(', ')}` })
    return
  }
  const released = 'waitsOn' in f
  delete f.waitsOn
  const fresh = !f.worktree || !existsSync(f.worktree)
  try {
    f.worktree = ensureWorktree(feature, f.branch)
  } catch (e) {
    Object.assign(f, { status: 'failed', reason: e.setup ? e.message : `worktree: ${e.message.split('\n')[0]}` })
    save()
    return
  }
  if (released && !fresh) {
    const why = syncBase(f.worktree)
    if (why) {
      Object.assign(f, { status: 'parked', reason: why })
      return
    }
  }
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  const lane = text == null ? 'unknown' : laneOf(mf)
  if (lane === 'blocked') Object.assign(f, { status: 'parked', reason: unquote(mf.blocked) })
  else if (text == null && shippedPr(readSpec(f.worktree, feature))) land(feature) // shipped, the merge still owed
  else if (lane === 'done') Object.assign(f, { status: 'done', pr: mf.pr ?? null, reason: null })
  else if (lane === 'build' || lane === 'ship') Object.assign(f, { status: QUEUED[lane], reason: null }) && pool.push({ feature, lane })
  else if (lane === 'walk') Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature)
  else Object.assign(f, { status: 'parked', reason: 'MANIFEST.md missing or its state not understood' })
}

/**
 * Bring the target into a worktree — the code every other finished feature has merged into — so
 * the feature builds, walks and verifies on it, and the ship step's own merge finds nothing new.
 * Measured before this existed: a walk env started at the pre-merge code parked a signed-off
 * feature for a whole fleet cycle, and every ship re-ran every app's gates on a tree that had
 * just moved. Only a clean tree is merged (a manual-commit app may have work staged); a conflict
 * is a reason to park. Returns null when the worktree is at the target, or the merge went in.
 */
function syncTarget(wt, why = "its dependencies' code", feature = null) {
  if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null) return null
  if (tryGit(['status', '--porcelain', '--untracked-files=no'], wt) !== '') return null // not ours to merge over
  if (tryGit(['merge', '--no-edit', '--quiet', `refs/heads/${TARGET}`], wt) === null) {
    tryGit(['merge', '--abort'], wt)
    return `merging ${TARGET} (${why}) conflicted — clears when a human merges it into the branch`
  }
  // New commits came in: a package or a migration may have come with them, and the worktree's
  // install and test database were made before it. agent_walk.sync brings them up to date.
  if (AW.sync && feature) {
    const log = join(DIR, 'logs', `${feature}-sync.log`)
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'a')
    try {
      execSync(AW.sync.replaceAll('{feature}', feature), { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
    } catch {
      return `agent_walk.sync failed after merging ${TARGET} — see ${log}; clears when it passes`
    } finally {
      closeSync(fd)
    }
  }
  return null
}
const syncBase = (wt) => syncTarget(wt)

/** A dependency shipped: queue every child that was waiting only on what has now merged. */
function release() {
  for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'waiting' && !pendingDeps(f).length) enqueue(feature)
  save()
}

for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  f.runsThisTime = 0 // a parked or failed feature re-queued here gets a fresh cap
  enqueue(feature)
}
// A note about a worktree that is gone (merged, then removed by hand) has nothing left to say.
fleet.notes = (fleet.notes ?? []).filter((n) => {
  const m = /its worktree (\S+) was kept/.exec(n)
  return !m || existsSync(m[1])
})
// Saved HERE, before the baseline: --status during those minutes shows the queue as it is, not
// as the last run left it.
save()
// @delta gates compare against the target's counts: measure them here, once, before any run — and
// only when the target has moved since the last measurement (an e2e-sized baseline is minutes).
const baselineFor = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, '.builder', 'gates', 'baseline.json'), 'utf8')).head
  } catch {
    return null
  }
})()
const BASELINE_NOTE = 'measuring @delta gate baselines on '
if (baselineFor !== tryGit(['rev-parse', '--short', 'HEAD']) && [...Object.values(parseGates(CFG.body).fast).flat(), ...parseGates(CFG.body).deep].some((g) => g.delta)) {
  const log = join(DIR, 'logs', 'baseline.log')
  mkdirSync(dirname(log), { recursive: true })
  addNote(`${BASELINE_NOTE}${TARGET} before the first run — see ${log}`)
  save()
  const fd = openSync(log, 'w')
  try {
    execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'gate.mjs'), '--baseline'], { cwd: ROOT, env: process.env, stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    addNote(`gate baseline: measuring the @delta gates on ${TARGET} failed — see ${log}; a worktree's first measurement becomes its baseline`)
  } finally {
    closeSync(fd)
  }
}
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('No agent_walk.reset') && !n.startsWith(BASELINE_NOTE))
if (!AW.reset) fleet.notes.push('No agent_walk.reset — dev-DB state accumulates from one walk to the next.')
if ('CLAUDE_PROJECT_DIR' in AW.env) addNote('agent_walk.env may not set CLAUDE_PROJECT_DIR — it was ignored; each child reads its own worktree.')
save()

// ---- the lanes -----------------------------------------------------------------------------
// The pool runs build and ship work, `parallel` at a time; the walk lane runs one feature at a
// time. A handoff moves a feature to the other queue. Everyone stops once both queues are empty
// and nothing is in flight — no running feature can hand anything on.
let waiters = []
const nextWake = () => new Promise((r) => waiters.push(r))
const wakeAll = () => {
  const w = waiters
  waiters = []
  for (const r of w) r()
}
let inFlight = 0
const idle = () => !pool.length && !walkQueue.length && inFlight === 0

function route(feature, outcome) {
  if (outcome === 'walk') walkQueue.push(feature)
  else if (outcome === 'build' || outcome === 'ship') pool.push({ feature, lane: outcome })
  else if (outcome === 'done') release()
}

async function poolWorker() {
  for (;;) {
    if (pool.length) {
      const { feature, lane } = pool.shift()
      fleet.features[feature].status = RUNNING[lane]
      save()
      inFlight++
      // Every pool run starts on the latest target, so a build integrates other features' merges
      // as they land instead of meeting them all at ship.
      const why = syncTarget(fleet.features[feature].worktree, 'what other features merged', feature)
      const outcome = why ? park(fleet.features[feature], why) : await drive(feature, lane)
      inFlight--
      route(feature, outcome)
      wakeAll()
      continue
    }
    if (idle()) return wakeAll()
    await nextWake()
  }
}

async function walkLane() {
  for (;;) {
    if (walkQueue.length) {
      const feature = walkQueue.shift()
      inFlight++
      const outcome = await walkOne(feature)
      inFlight--
      route(feature, outcome)
      wakeAll()
      continue
    }
    if (idle()) return wakeAll()
    await nextWake()
  }
}

await Promise.all([...Array.from({ length: PARALLEL }, poolWorker), walkLane()])

// Whatever still waits, waits on something that parked or failed: say which, so the table explains it.
for (const f of Object.values(fleet.features))
  if (f.status === 'waiting')
    Object.assign(f, { status: 'parked', reason: `waits on ${pendingDeps(f).map((d) => `${d} (${fleet.features[d]?.status ?? 'not in the fleet'})`).join(', ')}` })
save()
unlock()
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
