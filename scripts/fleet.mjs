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
 *   node <plugin>/scripts/fleet.mjs --status --archived [N]   # the latest N landings (20)
 *
 * State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes. A feature that
 * lands leaves fleet.json for archive.jsonl, and its logs move to logs/_archive/<feature>/ (pruned
 * after agent_walk.keep_logs days); fleet.json holds only work in flight.
 */
import { spawn, execFile, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync, openSync, closeSync, cpSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve, relative } from 'node:path'
import { requireConfig } from './config.mjs'
import { parseManifest, isSet } from './manifest.mjs'
import { laneOf, decide, loadFleet, saveFleet, fleetDir, shippedPr, renderStatus, readProgress, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, renderArchived, parkParts, duration, laneTotals, fleetAlive, stoppedNote } from './fleet-core.mjs'
import { features, specDir, ARCHIVE } from './registry.mjs'
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
const USAGE = 'Usage: fleet.mjs <feature|path>… | --all [--parallel N] [--into <branch>] [--detach] [--dry-run] [--status [--archived [N]]]   (named while a fleet runs: added to its queue)'
const KNOWN_FLAGS = new Set(['--all', '--parallel', '--into', '--detach', '--dry-run', '--status', '--archived'])
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
// `--archived [N]` — N is optional; a value that is there must be a positive integer.
const archivedVal = flag('--archived') && argv[argv.indexOf('--archived') + 1] !== undefined && !argv[argv.indexOf('--archived') + 1].startsWith('--') ? opt('--archived') : undefined
if (archivedVal !== undefined && !/^[1-9]\d*$/.test(archivedVal)) {
  console.error(`--archived must be a positive integer, got '${archivedVal}'. ${USAGE}`)
  process.exit(2)
}
if (flag('--into') && !/^[^-\s][^\s]*$/.test(opt('--into') ?? '')) {
  console.error(`--into needs a branch name. ${USAGE}`)
  process.exit(2)
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--parallel', '--archived', '--into'].includes(argv[i - 1]))

const CFG = requireConfig()
const ROOT = CFG.root
const DIR = fleetDir(ROOT)

// Progress is read live from each feature's worktree (or the root before it has one): the manifest's
// state, the plan's tasks and the ledger's completed ones. A few small files per feature.
const progressOf = (feature, f) => readProgress(f.worktree && existsSync(f.worktree) ? f.worktree : ROOT, CFG.registry, feature, f.status)

if (flag('--status') || flag('--archived')) {
  const fleet = existsSync(join(DIR, 'fleet.json')) ? loadFleet(ROOT) : null
  if (flag('--archived')) console.log(renderArchived(tailArchive(ROOT, Number(archivedVal) || 20), fleet?.archived ?? 0))
  else {
    console.log(fleet ? renderStatus(fleet, progressOf, tailArchive(ROOT, 1)[0] ?? null, Date.now(), tailArchive(ROOT, 5)) : 'No fleet has run in this repo yet.')
    // A fleet killed from outside (a session's background-task limit, a closed terminal) leaves its
    // rows mid-run and no live lock: say so, with the command that picks them up again.
    const note = fleet && !fleetAlive(ROOT) ? stoppedNote(fleet, fileURLToPath(import.meta.url)) : ''
    if (note) console.log(note)
  }
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
/** A feature's doc from its live folder, or its archived one once the ship commit moved it there. */
const readDoc = (base, feature, doc) => {
  const p = join(specDir(base, CFG.registry, feature), doc)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const readManifest = (base, feature) => readDoc(base, feature, 'MANIFEST.md')
const readSpec = (base, feature) => readDoc(base, feature, 'SPEC.md')
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')
/** Who unparked a feature, as its park record's History says it. */
const BY_PERSON = 'a person — named to /builder:agent or /builder:fleet'
const nameOf = (a) => basename(a.replace(/\/(MANIFEST|SPEC)\.md$/, '').replace(/\/+$/, ''))

function requested() {
  if (!flag('--all')) return positional.map(nameOf)
  return features(ROOT, CFG.registry).filter((n) => {
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
  // A blocked spec is admitted: naming it is the human asking for a retry (see unpark).
  const lane = laneOf({ ...mf, blocked: 'none' })
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

// ---- the lock, read-only ---------------------------------------------------------------------
const LOCK = join(DIR, 'lock')
const INBOX = join(DIR, 'inbox')
const INBOX_POLL_MS = Number(process.env.FLEET_INBOX_POLL_MS) || 15000
/** The pid of a live fleet holding the lock, or null. */
function lockHolder() {
  let pid = NaN
  try {
    pid = Number(readFileSync(LOCK, 'utf8'))
  } catch {
    return null
  }
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (e) {
    return e.code === 'EPERM' ? pid : null
  }
}
const runningPid = lockHolder()

// --detach: the same fleet, in its own session, output to fleet.out — so it outlives whatever
// launched it (an agent session's background-task limit, a closed terminal). Adding to a running
// fleet and a dry run return at once anyway, so they stay in the foreground.
if (flag('--detach') && !flag('--dry-run') && !runningPid) {
  mkdirSync(DIR, { recursive: true })
  const outFd = openSync(join(DIR, 'fleet.out'), 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], {
    cwd: process.cwd(),
    env: process.env,
    detached: true, // setsid: a new session and process group
    stdio: ['ignore', outFd, outFd],
  })
  child.unref()
  console.log(`fleet started detached (pid ${child.pid}) — output in .builder/fleet/fleet.out · /builder:fleet --status`)
  process.exit(0)
}

// ---- dry run -------------------------------------------------------------------------------
const fleet = loadFleet(ROOT)
/**
 * The branch every finished feature is merged into: --into for this run, else the config's
 * merge_into (default base_branch) — never whatever happens to be checked out, which is how work
 * ended up stranded on a feature branch. Kept in fleet.json; a fleet with unfinished rows keeps its
 * target until they finish.
 */
const TARGET_FROM = flag('--into') ? '--into' : 'merge_into'
const TARGET = opt('--into') ?? CFG.mergeInto
if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${TARGET}`]) === null) {
  console.error(`The branch to merge into, ${TARGET}, does not exist — create it (git branch ${TARGET}) or set merge_into in .claude/builder.md.`)
  process.exit(2)
}
if (fleet.target && fleet.target !== TARGET && Object.values(fleet.features).some((f) => f.status !== 'done')) {
  console.error(`This fleet merges into ${fleet.target}, not ${TARGET} — finish or clear it first, or continue it with --into ${fleet.target}.`)
  process.exit(2)
}

/**
 * Whether a dependency has merged into the target. A row still in fleet.json answers for itself.
 * An archived row is gone from it: landed by this process (the set), or by an earlier run — then
 * the target's own tree says so. Asked of the ref, not the working tree, so it holds when the merge
 * was written onto the target while another branch was checked out.
 */
const landed = new Set()
function landedOn(dep) {
  const row = fleet.features[dep]
  if (row) return row.status === 'done'
  return landed.has(dep) || tryGit(['cat-file', '-e', `${TARGET}:${CFG.registry}/${ARCHIVE}/${dep}`]) !== null
}
const asked = requested()
if (!asked.length && runningPid) {
  console.error(`Another fleet is running in this repo (pid ${runningPid}). Name specs to add them to its queue; /builder:fleet --status shows where it stands.`)
  process.exit(3)
}
if (!asked.length && !Object.keys(fleet.features).length) {
  console.error('Name the specs to run (feature names or folders), or pass --all.')
  process.exit(2)
}
const fresh = []
const requeue = [] // parked or failed rows named again while a fleet runs — it retries them
const refused = {}
const after = {} // feature → the dependencies in this run it waits for
const branchOwner = new Map(Object.entries(fleet.features).map(([f, row]) => [row.branch, f]))
const inRun = new Set([...asked, ...Object.keys(fleet.features)])
for (const feature of asked) {
  if (fleet.features[feature]) {
    if (runningPid && ['parked', 'failed'].includes(fleet.features[feature].status)) requeue.push(feature)
    continue // already in the fleet — resumed below
  }
  let why = preflight(feature)
  const branch = why ? null : branchOf(feature, parseManifest(readManifest(ROOT, feature)))
  if (!why && branchOwner.has(branch)) why = `${branchOwner.get(branch)} and ${feature} both resolve to branch ${branch}`
  // A program child builds against its dependencies' merged code. One this run will ship is
  // waited for; one nothing here will ship is a refusal, not a wait that never ends.
  const waits = why ? [] : waitsOn(ROOT, CFG.registry, feature).filter((d) => !landedOn(d.name))
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
  console.log(`  merges into: ${TARGET} (${TARGET_FROM}) — one merge commit per finished feature; nothing is pushed`)
  console.log(`  worktrees:   ${WORKTREES}`)
  console.log(`  permissions: claude ${AW.claudeArgs}`)
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: one at a time`)
  if (runningPid) console.log(`  adds to the running fleet (pid ${runningPid}) — each is picked up when a lane frees; its --parallel stands`)
  for (const f of fresh) {
    const mf = parseManifest(readManifest(ROOT, f))
    const unparks = isSet(mf.blocked) ? ` — unparks it — it was parked: ${parkParts(mf.blocked).why}` : ''
    console.log(`  ${after[f] ? '⏳' : '✓'} ${f} → ${branchOf(f, mf)}${after[f] ? `, once ${after[f].join(', ')} merge${after[f].length > 1 ? '' : 's'}` : ''}${unparks}`)
  }
  for (const [f, why] of Object.entries(refused)) console.log(`  ✗ ${f} — ${why}`)
  const retried = (f, row) => asked.includes(f) && ['parked', 'failed'].includes(row.status)
  const was = (row) => `it was ${row.status}: ${parkParts(row.reason).why || 'no reason recorded'}`
  for (const [f, row] of Object.entries(fleet.features))
    console.log(
      `  ↻ ${f} — ${
        runningPid
          ? requeue.includes(f) ? `re-queued, unparked — ${was(row)}` : `already in the running fleet (${row.status})`
          : retried(f, row) ? `unparks and retries — ${was(row)}` : `resuming (${row.status})`
      }`
    )
  process.exit(0)
}

// ---- lock ----------------------------------------------------------------------------------
mkdirSync(DIR, { recursive: true })

/**
 * Specs named while a fleet runs join ITS queue: one file per spec in .builder/fleet/inbox/,
 * created with 'wx' so a second drop of the same name is a no-op and nothing needs a lock. The
 * running fleet drains the inbox whenever a lane looks for work. Admission was checked above,
 * exactly as at a launch; the fleet checks once more when it drains.
 */
function addToRunning(pid) {
  mkdirSync(INBOX, { recursive: true })
  const drop = (f, verb) => {
    try {
      writeFileSync(join(INBOX, f), JSON.stringify({ waitsOn: after[f] ?? [] }) + '\n', { flag: 'wx' })
      console.log(`  ↳ ${f} — ${verb} for the running fleet (pid ${pid})`)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      console.log(`  ↳ ${f} — already queued for the running fleet (pid ${pid})`)
    }
  }
  for (const f of fresh) drop(f, 'queued')
  for (const f of requeue) drop(f, 're-queued')
  for (const [f, why] of Object.entries(refused)) console.log(`  ✗ ${f} — ${why}`)
  for (const f of asked) if (fleet.features[f] && !requeue.includes(f)) console.log(`  ↻ ${f} — already in the running fleet (${fleet.features[f].status})`)
  if (fresh.length || requeue.length) console.log('picked up when a lane frees — /builder:fleet --status shows the queue')
  process.exit(0)
}
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
  const pid = lockHolder()
  if (pid) {
    if (asked.length) addToRunning(pid) // exits
    console.error(`Another fleet is running in this repo (pid ${pid}). Name specs to add them to its queue; /builder:fleet --status shows where it stands.`)
    process.exit(3)
  }
  let stale = '?'
  try {
    stale = readFileSync(LOCK, 'utf8').trim()
  } catch {}
  console.error(`note: taking over a stale fleet lock (pid ${stale} is gone)`)
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

// A row a fleet before 3.8 left at `done`, or one killed between its landing and the save that
// would have archived it, is archived now — appendArchive skips a line already written. It runs
// before `fleet.target` moves to this checkout, so the row records the target it landed on.
for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'done') archiveRow(feature)
pruneArchivedLogs(ROOT, AW.keepLogs)

fleet.target = TARGET
for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null, unpark: true, ...(after[f] && { waitsOn: after[f] }) }
// Naming a parked or failed feature is asking for a retry, whatever stopped it: enqueue unparks it.
for (const f of asked) if (['parked', 'failed'].includes(fleet.features[f]?.status)) markUnpark(fleet.features[f])

// ---- one claude run ------------------------------------------------------------------------
/**
 * What a run is told when its feature was unparked: the old line, as a lead to check, not a verdict
 * (resume §Agent mode — a run started after an unpark).
 */
const priorPark = (f) =>
  f.lastPark
    ? `\n\nThis feature was parked before and has been unparked for a fresh attempt. The park said: "${f.lastPark}". ` +
      'Read its PARKED.md (beside MANIFEST.md) first when there is one: it is the investigation so far. ' +
      'Builder, the code or the spec may have changed since it was written. Check whether its cause still holds; start from its Where to dig, ' +
      'find the root cause before trying the same fix again, record what you try, and carry on. ' +
      'Park again only if it still stands, with the line and the record rewritten per REFERENCE §How a park reads and §The park record.'
    : ''

function runClaude(wt, feature, lane, n, prompt = `/builder:resume --path ${specOf(feature)} --agent-walk --into ${TARGET}${lane === 'walk' ? '' : ' --no-dev-env'}${priorPark(fleet.features[feature])}`) {
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  const env = envFor(feature, lane)
  return new Promise((done) => {
    const out = createWriteStream(log)
    const raw = createWriteStream(log.replace(/\.log$/, '.jsonl'))
    const t0 = Date.now()
    let result = null // the last `result` event: { duration_ms, num_turns }
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
      // Time and turns per run: Claude's own result event, or wall-clock when the run never sent one.
      const timing = fleet.features[feature].timing ?? (fleet.features[feature].timing = [])
      timing.push({ n, lane: lane === 'walk' ? 'walk' : 'build', ms: result?.duration_ms ?? Date.now() - t0, turns: result?.num_turns ?? null })
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
      for (const line of lines) {
        if (line.includes('"type":"result"')) {
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'result') result = ev
          } catch {}
        }
        out.write(readable(line, seen))
      }
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

/** A landed feature leaves fleet.json: one line in archive.jsonl, its logs under logs/_archive/. */
function archiveRow(feature) {
  const f = fleet.features[feature]
  appendArchive(ROOT, {
    feature,
    branch: f.branch,
    target: fleet.target ?? TARGET,
    merged: f.merged ?? null,
    pr: f.pr ?? null,
    runs: f.runs ?? 0,
    runsThisTime: f.runsThisTime ?? 0,
    timing: f.timing ?? [],
    lanes: laneTotals(f.timing),
    landedAt: new Date().toISOString(),
  })
  delete fleet.features[feature]
  fleet.archived = (fleet.archived ?? 0) + 1
  landed.add(feature)
  const why = archiveLogs(ROOT, feature)
  if (why) addNote(why)
}

/**
 * Merge a shipped feature into the target and clear its worktree and branch. The branch is brought
 * up to the target first (an agent resolves any conflict), so the merge into the target is only
 * this feature's changes and cannot conflict. `--no-ff` keeps one merge commit per feature — easy to
 * find, and `git revert -m 1` takes a feature back out. One merge at a time: the walk lane and the
 * pool both land, and a second merge must see the first one's commit.
 */
let landing = Promise.resolve()
function land(feature) {
  const run = landing.then(() => landNow(feature))
  landing = run.catch(() => {})
  return run
}

async function landNow(feature) {
  const f = fleet.features[feature]
  f.pr = shippedPr(readSpec(f.worktree, feature))
  if (f.pr && !/^#/.test(f.pr)) f.pr = null
  if (tryGit(['merge-base', '--is-ancestor', f.branch, TARGET]) === null) {
    if (f.worktree && existsSync(f.worktree)) {
      const why = await syncTarget(f.worktree, 'features that merged while this one shipped', feature)
      if (why) return park(f, why)
    }
    const why = mergeIntoTarget(feature, f.branch)
    if (why) return park(f, why)
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
  archiveRow(feature)
  save()
  return 'done'
}

/**
 * The `--no-ff` merge of a branch that already carries the target. Checked out here → `git merge`,
 * so the working tree moves with it. Checked out nowhere (the human switched away mid-run) → the
 * merge commit is written straight onto the target ref: its tree is the branch's own tree, because
 * the branch already holds everything the target does. Null when it went in; else the reason, which
 * is only ever the human's own uncommitted work in the way.
 */
function mergeIntoTarget(feature, branch) {
  const message = `merge(${feature}): agent-verified, not human-tested`
  const here = tryGit(['branch', '--show-current'])
  if (here === TARGET) {
    try {
      execFileSync('git', ['merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return null
    } catch (e) {
      tryGit(['merge', '--abort'])
      const why = String(e.stderr || e.stdout || e.message).split('\n').find((l) => l.trim()) ?? 'git merge failed'
      return `shipped, but merging into ${TARGET} failed: ${why.trim()} — your uncommitted changes are in the way — next: commit or stash them, then /builder:fleet to merge it`
    }
  }
  const elsewhere = (tryGit(['worktree', 'list', '--porcelain']) ?? '').split('\n\n').find((b) => b.includes(`\nbranch refs/heads/${TARGET}`))
  if (elsewhere) return `shipped, but ${TARGET} is checked out in ${elsewhere.split('\n')[0].replace(/^worktree /, '')}, so it can't be merged from here — next: /builder:fleet from that checkout to merge it`
  const old = tryGit(['rev-parse', `refs/heads/${TARGET}`])
  if (!old || tryGit(['merge-base', '--is-ancestor', old, branch]) === null) return `shipped, but ${branch} does not carry ${TARGET} — next: /builder:fleet to bring it up to date and merge it`
  const commit = tryGit(['commit-tree', `${branch}^{tree}`, '-p', old, '-p', branch, '-m', message])
  if (!commit || tryGit(['update-ref', `refs/heads/${TARGET}`, commit, old]) === null) return `shipped, but writing the merge onto ${TARGET} failed — next: /builder:fleet to merge it`
  addNote(`${feature} merged into ${TARGET} while ${here ?? 'a detached HEAD'} was checked out here — switch to ${TARGET} to test it`)
  return null
}

function park(f, reason) {
  Object.assign(f, { status: 'parked', reason })
  delete f.lastPark // superseded — the new reason is the one to act on
  save()
  return 'parked'
}
const RUNNING = { build: 'building', walk: 'walking', ship: 'shipping', land: 'shipping' }

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
      folder: specOf(feature),
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
    if (d.action === 'done') return await land(feature)
    Object.assign(f, d.action === 'fail' ? { status: 'failed', reason: `${d.reason} — see ${log} — next: /builder:agent to retry` } : { status: 'parked', reason: d.reason })
    delete f.lastPark
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

const RESTART = /^walk env needs a restart/

/** Drop a `blocked:` line the fleet itself can clear, committed so the next run reads it gone. */
function clearBlocked(wt, feature) {
  const p = join(wt, specOf(feature), 'MANIFEST.md')
  if (!existsSync(p)) return
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^blocked:.*$/m, 'blocked: none'))
  tryGit(['commit', '-qm', `chore(${feature}): walk env restarted by the fleet`, '--', join(specOf(feature), 'MANIFEST.md')], wt)
}

/** Reset, then start and smoke the walk env. Null when it is up; else what failed. */
async function bringUpWalkEnv(feature) {
  const f = fleet.features[feature]
  if (!hook(AW.reset, f.worktree, feature)) return `agent_walk.reset failed: ${AW.reset}`
  // `smoke` without `start` has nothing to probe — ignored, as the spec says.
  if (AW.start && !(await startWalkEnv(feature))) return `walk env didn't come up — see ${f.startLog}`
  return null
}

/** One headless run told what failed and asked to fix its cause in the branch. */
async function fixWalkEnv(feature, why) {
  const f = fleet.features[feature]
  f.runs = (f.runs ?? 0) + 1
  save()
  const prompt =
    `The builder fleet could not bring up the walk env for this worktree — the feature at --path ${specOf(feature)} on branch ${f.branch} — because ${why}. ` +
    `Find the cause and fix it in this branch — code, a migration, a dependency, a stale install${AW.sync ? ` (agent_walk.sync is \`${AW.sync.replaceAll('{feature}', feature)}\`)` : ''}. ` +
    `The fleet runs ${AW.reset ? `reset \`${AW.reset}\`, then ` : ''}start \`${AW.start ?? '(none)'}\`${AW.smoke ? ` and polls smoke \`${AW.smoke}\`` : ''} with this run's environment; you may run them yourself to check, ` +
    `but stop every process you started before you finish, and kill nothing you did not start — other worktrees share this machine. ` +
    `Commit the fix. Do not edit .claude/builder.md or the feature's MANIFEST.md. If the cause is outside this repo (a port another program holds, a service that is down), change nothing and say so in your last message. ` +
    `Never ask a question and run nothing in the background — nobody is there to answer, and this run ends when your last turn does.`
  const { log } = await runClaude(f.worktree, feature, 'walk', f.runs, prompt)
  f.log = log
  save()
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
      const why = await syncTarget(f.worktree, 'what other features merged', feature)
      if (why) return park(f, why)
    }
    for (let restarts = 0; ; restarts++) {
      // A walk env that won't come up gets one agent run to find and fix the cause, then one more try.
      for (let attempt = 0; ; attempt++) {
        const why = await bringUpWalkEnv(feature)
        if (!why) break
        await killStart(f)
        if (attempt === 1) return park(f, `the walk env would not start (${why}) and an agent run could not fix it — next: run agent_walk.start in ${f.worktree} and fix what it prints, then /builder:agent`)
        await fixWalkEnv(feature, why)
      }
      const outcome = await drive(feature, 'walk')
      // Walk readiness met a change the running env can't pick up (REFERENCE §Walk readiness): the
      // fleet owns the env, so it clears the line, restarts it, and the walk goes on.
      if (outcome !== 'parked' || !RESTART.test(f.reason ?? '') || restarts === 2) return outcome
      clearBlocked(f.worktree, feature)
      await killStart(f)
      Object.assign(f, { status: 'walking', reason: null })
      save()
    }
  } finally {
    await killStart(f)
    if (!hook(AW.stop, f.worktree, feature)) {
      addNote(`agent_walk.stop failed after ${feature}: ${AW.stop}`)
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const pool = [] // { feature, lane: 'build' | 'ship' | 'land' } — the parallel workers' queue
const walkQueue = []
const pendingDeps = (f) => (f.waitsOn ?? []).filter((d) => !landedOn(d))

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
  // Its dependencies' code, merged now so the worktree starts from it. A conflict is left to the
  // lane, whose own sync hands it to an agent.
  if (released && !fresh) mergeTargetQuietly(f.worktree)
  if (f.unpark) unpark(feature)
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  const lane = text == null ? 'unknown' : laneOf(mf)
  if (lane === 'blocked') Object.assign(f, { status: 'parked', reason: unquote(mf.blocked) })
  else if (text == null && shippedPr(readSpec(f.worktree, feature))) Object.assign(f, { status: 'awaiting-ship', reason: null }) && pool.push({ feature, lane: 'land' }) // shipped, the merge still owed
  else if (lane === 'done') {
    f.pr = mf.pr ?? null
    archiveRow(feature)
  }
  else if (lane === 'build' || lane === 'ship') Object.assign(f, { status: QUEUED[lane], reason: null }) && pool.push({ feature, lane })
  else if (lane === 'walk') Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature)
  else Object.assign(f, { status: 'parked', reason: `MANIFEST.md is missing or its state is not one the fleet knows — next: /builder:resume --path ${specOf(feature)} to set it right` })
}

// ---- the park record (REFERENCE §The park record) -------------------------------------------
const today = () => new Date().toISOString().slice(0, 10)
/** Parks only a person can clear: your own uncommitted work, or the target checked out elsewhere. */
const HUMAN_STEP = /uncommitted changes are in the way|is checked out in /

/** `- <date> <what>` at the end of the record's History, which is always its last section. */
function appendHistory(path, what) {
  const text = readFileSync(path, 'utf8').trimEnd()
  writeFileSync(path, `${/^## History$/m.test(text) ? text : `${text}\n\n## History`}\n- ${today()} ${what}\n`)
}

/** The record's `kind:`, or what the reason implies when there is no record. */
function parkKind(feature) {
  const f = fleet.features[feature]
  const p = f.worktree && join(f.worktree, specOf(feature), 'PARKED.md')
  const kind = p && existsSync(p) ? /^kind:\s*(\S+)/m.exec(readFileSync(p, 'utf8'))?.[1] : null
  return kind ?? (HUMAN_STEP.test(f.reason ?? '') ? 'human-step' : 'stuck')
}

/**
 * Make sure a parked feature has a park record that matches its park. A run that parked it wrote
 * one (the skills do) → kept as written. None, or one left from an earlier park → the fleet writes
 * what it knows: the reason split into why and next, the log of the run that parked it with its
 * last lines quoted (logs live outside the worktree), and the history carried over. Committed, so
 * it travels with the branch.
 */
function ensureParkRecord(feature) {
  const f = fleet.features[feature]
  const folder = f.worktree && join(f.worktree, specOf(feature))
  if (!folder || !existsSync(join(folder, 'MANIFEST.md')) || !f.reason) return
  const p = join(folder, 'PARKED.md')
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  if (old && unquote(/^blocked:\s*(.*)$/m.exec(old)?.[1]) === f.reason) return
  const { why, next } = parkParts(f.reason)
  const history = /^## History\n([\s\S]*)$/m.exec(old)?.[1]?.trimEnd()
  const tail = f.log && existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').slice(-25).join('\n') : ''
  const kind = HUMAN_STEP.test(f.reason) ? 'human-step' : 'stuck'
  const text = [
    `# ${feature} — parked`,
    `parked: ${today()} ${tryGit(['rev-parse', '--short', 'HEAD'], f.worktree) ?? ''} · by the fleet (the run that parked it wrote no record)`,
    `kind: ${kind}`,
    `blocked: "${f.reason}"`,
    '',
    '## What is stuck',
    why,
    '',
    '## What was tried',
    `- ${f.runs ?? 0} fleet run(s) in all — \`git log --oneline -- ${specOf(feature)}\` lists what each changed`,
    '',
    '## Evidence',
    ...(f.log ? [`- the run that parked it: ${f.log} — its last lines:`, '', '```', tail, '```'] : ['- no run log']),
    ...(f.startLog ? [`- the walk env's start log: ${f.startLog}`] : []),
    '',
    '## Where to dig',
    "- start from the run's last lines above and the evidence it names; nothing has been ruled out yet",
    '',
    '## Recommended next step',
    next ?? '/builder:agent — naming it again unparks it and retries',
    '',
    '## History',
    ...(history ? [history] : []),
    `- ${today()} parked — ${why}`,
    '',
  ].join('\n')
  writeFileSync(p, text)
  const rel = join(specOf(feature), 'PARKED.md')
  tryGit(['add', '--', rel], f.worktree)
  tryGit(['commit', '-qm', `docs(${feature}): park record — ${why}`, '--', rel], f.worktree)
}

/**
 * agent_walk.auto_unpark: a park gets an agent run to dig into its record, up to that many times per
 * fleet run — every park but a human-step one, which only a person can clear. The walk env's own
 * restart line is not a park the fleet retries this way (walkOne restarts it). True when requeued.
 */
function autoRetry(feature) {
  const f = fleet.features[feature]
  if (f?.status !== 'parked' || RESTART.test(f.reason ?? '')) return false
  if ((f.autoUnparks ?? 0) >= AW.autoUnpark || parkKind(feature) === 'human-step') return false
  f.autoUnparks = (f.autoUnparks ?? 0) + 1
  markUnpark(f, `the fleet — automatic retry ${f.autoUnparks} of ${AW.autoUnpark}`)
  enqueue(feature)
  save()
  return true
}

/** A parked or failed row to retry: remember what stopped it, and unpark it at its next enqueue. */
function markUnpark(f, by = BY_PERSON) {
  if (f.reason) f.lastPark = f.reason
  f.unpark = by
}

/**
 * Unpark a feature someone named again — ALWAYS, whatever parked it and whichever builder version
 * wrote the line: builder, the code or the spec may have changed since, and the run is told what the
 * park said so it can check (priorPark). `blocked:` goes to `none` in a commit that quotes the old
 * line, so the history keeps it. The agent walk's round cap starts over: `unparked-after` holds the
 * highest round walked so far, and agent-walk counts only the rounds after it.
 */
function unpark(feature) {
  const f = fleet.features[feature]
  const by = f.unpark === true ? BY_PERSON : f.unpark
  delete f.unpark
  const rel = join(specOf(feature), 'MANIFEST.md')
  const p = join(f.worktree, rel)
  const text = existsSync(p) ? readFileSync(p, 'utf8') : null
  const blocked = text == null ? null : parseManifest(text).blocked
  if (isSet(blocked)) f.lastPark = unquote(blocked)
  if (!f.lastPark) return
  const paths = []
  if (isSet(blocked)) {
    writeFileSync(p, text.replace(/^blocked:.*$/m, 'blocked: none'))
    paths.push(rel)
  }
  const record = join(specOf(feature), 'PARKED.md')
  if (existsSync(join(f.worktree, record))) {
    appendHistory(join(f.worktree, record), `unparked by ${by}`)
    paths.push(record)
  }
  if (paths.length) tryGit(['commit', '-qm', `chore(${feature}): unparked for a fleet retry — was: ${f.lastPark}`, '--', ...paths], f.worktree)
  const walks = join(f.worktree, '.builder', feature, 'agent-walk')
  const rounds = existsSync(walks) ? readdirSync(walks).map((n) => Number(/^round-(\d+)$/.exec(n)?.[1])).filter(Boolean) : []
  if (rounds.length) writeFileSync(join(walks, 'unparked-after'), `${Math.max(...rounds)}\n`)
}

/**
 * Bring the target into a worktree — the code every other finished feature has merged into — so
 * the feature builds, walks and verifies on it, and the ship step's own merge finds nothing new.
 * Measured before this existed: a walk env started at the pre-merge code parked a signed-off
 * feature for a whole fleet cycle, and every ship re-ran every app's gates on a tree that had
 * just moved. Only a clean tree is merged (a manual-commit app may have work staged). A conflict is
 * never a reason to stop: an agent run resolves it (resolveMerge), and only a conflict two runs
 * could not resolve parks. Returns null when the worktree is at the target, or the merge went in.
 */
async function syncTarget(wt, why = "its dependencies' code", feature = null) {
  if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null) return null
  if (tryGit(['status', '--porcelain', '--untracked-files=no'], wt) !== '') return null // not ours to merge over
  if (tryGit(['merge', '--no-edit', '--quiet', `refs/heads/${TARGET}`], wt) === null) {
    const conflicted = tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) !== null
    const log = conflicted && feature ? await resolveMerge(feature, wt, why) : null
    if (log !== true) {
      tryGit(['merge', '--abort'], wt)
      if (!conflicted) return `merging ${TARGET} (${why}) failed before any conflict — next: run git merge ${TARGET} in ${wt} and clear what stops it, then /builder:agent`
      return `merging ${TARGET} (${why}) conflicted and two agent runs could not resolve it${log ? ` (see ${log})` : ''} — next: finish the merge in ${wt} and commit it, then /builder:agent`
    }
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
      return `agent_walk.sync failed after merging ${TARGET} (see ${log}) — next: make agent_walk.sync pass in ${wt}, then /builder:agent`
    } finally {
      closeSync(fd)
    }
  }
  return null
}

/** The target merged in with no agent: on a conflict, back out and leave it to the lane's sync. */
function mergeTargetQuietly(wt) {
  if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null) return
  if (tryGit(['status', '--porcelain', '--untracked-files=no'], wt) !== '') return
  if (tryGit(['merge', '--no-edit', '--quiet', `refs/heads/${TARGET}`], wt) === null) tryGit(['merge', '--abort'], wt)
}

const RESOLVE_ATTEMPTS = 2
const mergeDone = (wt) =>
  tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) === null &&
  tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null &&
  tryGit(['diff', '--name-only', '--diff-filter=U'], wt) === ''

/**
 * Hand a conflicted merge of the target to a headless run: it resolves every file keeping both
 * sides, runs the gates of the apps it touched, and commits the merge. The other side is code that
 * already merged, and this side a spec the human approved — both are settled, so resolving them
 * together is work, not a question for the human. True when the merge is committed; else the last
 * run's log. A run that backed the merge out gets it started again for the next.
 */
async function resolveMerge(feature, wt, why) {
  const f = fleet.features[feature]
  const scripts = dirname(fileURLToPath(import.meta.url))
  let log = null
  for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
    if (tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) === null && tryGit(['merge', '--no-edit', '--quiet', `refs/heads/${TARGET}`], wt) !== null) return true
    const files = (tryGit(['diff', '--name-only', '--diff-filter=U'], wt) ?? '').split('\n').filter(Boolean)
    f.runs = (f.runs ?? 0) + 1
    f.reason = `resolving a conflict with ${TARGET} in ${files.length} file(s)`
    save()
    const prompt =
      `A merge of ${TARGET} into this branch (${f.branch}) stopped on conflicts in: ${files.join(', ')}. ` +
      `${TARGET} is the branch the builder fleet lands on; it carries ${why}, already merged and verified. This branch carries the feature at --path ${specOf(feature)} — being built unattended to a spec the human approved. ` +
      `Resolve every conflict so BOTH sides keep working: read this feature's SPEC.md (and PLAN.md if it is there) and \`git log -p MERGE_HEAD --not HEAD -- <file>\` for what the other side changed and why; keep both behaviours, and never drop one side to make a conflict go away. ` +
      `Where the two sides really do disagree, choose what keeps the other feature's shipped behaviour and still meets this spec, and write that ruling into the merge commit message. ` +
      `Then run the fast gates of every app whose files you changed — \`node ${scripts}/job.mjs start merge-gates -- node ${scripts}/gate.mjs <app>…\`, then \`node ${scripts}/job.mjs wait merge-gates\` in the foreground, again while it prints "still running", until it prints an exit code — and fix whatever is red. ` +
      `Finish with \`git add\` and \`git commit\` so the merge commit keeps both parents. Never \`git merge --abort\` or reset, never ask a question, and run nothing in the background — nobody is there to answer, and this run ends when your last turn does.`
    const res = await runClaude(wt, feature, 'build', f.runs, prompt)
    log = res.log
    f.log = log
    f.reason = null
    save()
    if (mergeDone(wt)) return true
  }
  return log
}

/** A dependency shipped: queue every child that was waiting only on what has now merged. */
function release() {
  for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'waiting' && !pendingDeps(f).length) enqueue(feature)
  save()
}

for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  f.runsThisTime = 0 // a parked or failed feature re-queued here gets a fresh cap
  f.autoUnparks = 0 // and a fresh automatic-retry budget
  enqueue(feature)
}

/**
 * Specs a second invocation dropped in the inbox while this fleet ran (or left for it, when the
 * fleet that was running died). Rows are made first and queued after, so a batch added together —
 * a program child with its dependency — finds its dependencies as rows. A spec that no longer
 * passes admission gets a note, not a row: the caller was told at drop time, and a half-made row
 * would break the next re-run. Returns whether anything joined.
 */
function drainInbox() {
  if (!existsSync(INBOX)) return false
  const names = readdirSync(INBOX)
    .filter((n) => !n.startsWith('.'))
    .sort()
  const joining = []
  for (const name of names) {
    let meta = {}
    try {
      meta = JSON.parse(readFileSync(join(INBOX, name), 'utf8'))
    } catch {}
    const row = fleet.features[name]
    if (row && !['parked', 'failed'].includes(row.status)) continue // queued or running already
    if (row) {
      markUnpark(row)
      Object.assign(row, { status: 'queued', reason: null, runsThisTime: 0, autoUnparks: 0 })
      joining.push(name)
      continue
    }
    let why = preflight(name)
    const branch = why ? null : branchOf(name, parseManifest(readManifest(ROOT, name)))
    const owner = branch && Object.entries(fleet.features).find(([, r]) => r.branch === branch)?.[0]
    if (!why && owner) why = `${owner} and ${name} both resolve to branch ${branch}`
    if (why) {
      addNote(`${name} was added while the fleet ran but can't join: ${why}`)
      continue
    }
    const waits = (Array.isArray(meta.waitsOn) ? meta.waitsOn : []).filter((d) => !landedOn(d))
    fleet.features[name] = { status: 'queued', runs: 0, branch, worktree: null, pr: null, reason: null, unpark: true, ...(waits.length && { waitsOn: waits }) }
    joining.push(name)
  }
  // Rows saved before their worktrees are made, and the drops removed only once the rows are
  // saved: a second drop of the same name at any moment either finds its file still there
  // ("already queued") or reads fleet.json and sees the row — never neither, which queued it twice.
  if (joining.length || names.length) save()
  for (const name of names) {
    try {
      unlinkSync(join(INBOX, name))
    } catch {}
  }
  for (const name of joining) enqueue(name)
  if (joining.length) save()
  return joining.length > 0
}
drainInbox()
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
let closing = false // one lane found everything idle — every lane stops, together
const idle = () => !pool.length && !walkQueue.length && inFlight === 0

function route(feature, outcome) {
  if (outcome === 'parked') {
    ensureParkRecord(feature)
    if (autoRetry(feature)) return
  }
  if (outcome === 'walk') walkQueue.push(feature)
  else if (outcome === 'build' || outcome === 'ship') pool.push({ feature, lane: outcome })
  else if (outcome === 'done') release()
}

async function poolWorker() {
  for (;;) {
    if (closing) return
    if (pool.length) {
      const { feature, lane } = pool.shift()
      fleet.features[feature].status = RUNNING[lane]
      save()
      inFlight++
      // Every pool run starts on the latest target, so a build integrates other features' merges
      // as they land instead of meeting them all at ship.
      let outcome
      if (lane === 'land') outcome = await land(feature)
      else {
        const why = await syncTarget(fleet.features[feature].worktree, 'what other features merged', feature)
        outcome = why ? park(fleet.features[feature], why) : await drive(feature, lane)
      }
      inFlight--
      route(feature, outcome)
      wakeAll()
      continue
    }
    if (drainInbox()) {
      wakeAll()
      continue
    }
    if (idle()) return close()
    await nextWake()
  }
}

async function walkLane() {
  for (;;) {
    if (closing) return
    if (walkQueue.length) {
      const feature = walkQueue.shift()
      inFlight++
      const outcome = await walkOne(feature)
      inFlight--
      route(feature, outcome)
      wakeAll()
      continue
    }
    if (drainInbox()) {
      wakeAll()
      continue
    }
    if (idle()) return close()
    await nextWake()
  }
}
const close = () => {
  closing = true
  wakeAll()
}

// A spec added while every lane is busy is picked up on the poll, not only when a run ends. One
// dropped between the last drain and the exit stays in the inbox for the next start.
const poll = setInterval(() => {
  if (!closing && drainInbox()) wakeAll()
}, INBOX_POLL_MS)
do {
  closing = false
  await Promise.all([...Array.from({ length: PARALLEL }, poolWorker), walkLane()])
} while (drainInbox())
clearInterval(poll)

// Whatever still waits, waits on something that parked or failed: say which, so the table explains it.
for (const f of Object.values(fleet.features))
  if (f.status === 'waiting')
    Object.assign(f, { status: 'parked', reason: `waits on ${pendingDeps(f).map((d) => `${d} (${fleet.features[d]?.status ?? 'not in the fleet'})`).join(', ')}, which never merged — next: settle ${pendingDeps(f).join(', ')}, then pick both in /builder:agent` })
save()
unlock()
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
