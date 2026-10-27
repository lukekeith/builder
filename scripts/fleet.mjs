#!/usr/bin/env node
/**
 * fleet — take a batch of specs through the /builder:* pipeline unattended.
 *
 * Everything lands on ONE branch, its TARGET: --into, else the config's merge_into (default base_branch).
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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync, openSync, closeSync, cpSync, statSync, rmSync } from 'node:fs'
import { join, dirname, basename, resolve, relative } from 'node:path'
import { requireConfig, hasAgentWalk, CONFIG_PATH } from './config.mjs'
import { planSize, parseTestPlan, formatTests } from './profile.mjs'
import { parseManifest, isSet } from './manifest.mjs'
import { buildingInSession, sharedBranch, parseWalkReadiness, landedMigrations, specBringIn, landedRow, laneOf, decide, loadFleet, saveFleet, fleetDir, shippedPr, renderStatus, readProgress, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, renderArchived, parkParts, duration, laneTotals, tokensOf, fleetAlive, stoppedNote, waitForCommand, initWithoutBuilder, stagesFromCommits, walkFacts } from './fleet-core.mjs'
import { rowProgress, parkBlock, stallOf, stallLine } from './fleet-core.mjs'
import { features, specDir, ARCHIVE } from './registry.mjs'
import { waitsOn, waitsOnText } from './program.mjs'
import { parseGates } from './gates-core.mjs'
import { clearWorktree, restoreKept, inventory, summaryLine } from './tidy-core.mjs'
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
const USAGE = 'Usage: fleet.mjs <feature|path>… | --all [--parallel N] [--into <branch>] [--detach] [--dry-run] [--status [--archived [N]]] | --pause <feature>   (named while a fleet runs: added to its queue)'
const KNOWN_FLAGS = new Set(['--all', '--parallel', '--into', '--detach', '--dry-run', '--status', '--archived', '--pause', '--no-env-check'])
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
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--parallel', '--archived', '--into', '--pause'].includes(argv[i - 1]))

const CFG = requireConfig()
const ROOT = CFG.root
const DIR = fleetDir(ROOT)

// A pause request is a file the fleet checks before each run of that feature (drive): it parks the
// feature for /builder:revise, which changes its spec in the worktree and names it again.
const pauseFile = (feature) => join(DIR, 'requests', `${feature}.pause`)
const clearPause = (feature) => rmSync(pauseFile(feature), { force: true })

// Progress is read live from each feature's worktree (or the root before it has one): the manifest's
// state, the plan's tasks, the ledger's completed ones and the workspace's briefs and reports. A few
// small files per feature. The reading is kept on the row (lastProgress), so a feature whose worktree
// is gone keeps its last value instead of the root checkout's 0%.
const progressOf = (feature, f) => rowProgress(ROOT, CFG.registry, feature, f)
// The table's Tests before the fleet has noted a row's facts: what its manifest's test plan reads as.
const testsOf = (feature, f) => {
  const p = join(specDir(f.worktree && existsSync(f.worktree) ? f.worktree : ROOT, CFG.registry, feature), 'MANIFEST.md')
  return existsSync(p) ? parseTestPlan(parseManifest(readFileSync(p, 'utf8'))).label : null
}

if (flag('--status') || flag('--archived')) {
  const fleet = existsSync(join(DIR, 'fleet.json')) ? loadFleet(ROOT) : null
  if (flag('--archived')) console.log(renderArchived(tailArchive(ROOT, Number(archivedVal) || 20), fleet?.archived ?? 0))
  else {
    console.log(fleet ? renderStatus(fleet, progressOf, tailArchive(ROOT, 1)[0] ?? null, Date.now(), tailArchive(ROOT, 5), testsOf) : 'No fleet has run in this repo yet.')
    // A fleet killed from outside (a session's background-task limit, a closed terminal) leaves its
    // rows mid-run and no live lock: say so, with the command that picks them up again.
    const note = fleet && !fleetAlive(ROOT) ? stoppedNote(fleet, fileURLToPath(import.meta.url)) : ''
    if (note) console.log(note)
    // A run that keeps printing but goes in circles outlives the idle timeout: name the ones whose
    // HEAD, ledger and workspace have not moved for STALL_MS.
    if (fleet && fleetAlive(ROOT)) {
      const quiet = Object.entries(fleet.features).flatMap(([name, f]) => {
        const st = stallOf(name, f)
        return st ? [stallLine(name, st)] : []
      })
      if (quiet.length) console.log(`\n${quiet.join('\n')}`)
    }
  }
  process.exit(0)
}

if (flag('--pause')) {
  const name = opt('--pause')
  if (!name || name.startsWith('--') || name.includes('/') || name.includes('..') || name.includes('\\')) {
    console.error(`--pause needs a feature name (no slashes). ${USAGE}`)
    process.exit(2)
  }
  const features = existsSync(join(DIR, 'fleet.json')) ? (loadFleet(ROOT).features ?? {}) : {}
  const row = Object.hasOwn(features, name) ? features[name] : null
  if (row && row.status !== 'done') {
    mkdirSync(join(DIR, 'requests'), { recursive: true })
    writeFileSync(pauseFile(name), `requested ${new Date().toISOString()}\n`)
    console.log(`pause requested: ${name}${fleetAlive(ROOT) ? '' : ' — no fleet is running; it parks when the fleet next runs it'}`)
  } else console.log(`${name} isn't in this fleet — nothing to pause`)
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
// Batched walks: with a walk env of its own (agent_walk.start), the walk lane takes every feature
// waiting to walk — up to agent_walk.batch — into one combined walk branch, one env, one walker.
const BATCH = Number(process.env.FLEET_WALK_BATCH) || AW.batch
const BATCHED = Boolean(AW.start) && BATCH > 1
// With a walk env of the fleet's own (agent_walk.start), the walk lane holds only what needs it —
// readiness, the walk, the @walk gates. Verify and a walk's fixes run in the parallel pool, away
// from the folder the env serves from, whatever the batch size: a build there rewrote a running
// dev server's output. Without `start` the env is the human's own checkout, and nothing moves.
const SPLIT = Boolean(AW.start)
/** The batch's own worktree and branch: the target with every batched feature merged in. Never merged. */
const WALK_WT = join(WORKTREES, '_walk')
const WALK_BRANCH = 'builder/_walk'

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
  if (buildingInSession(ROOT, feature, mf))
    return `${spec} is being built in a session right now (its workspace changed in the last 30 min) — finish it there, or name it again once that session is done`
  if (UNDERWAY.has(mf.state)) {
    const manifests = Object.fromEntries(features(ROOT, CFG.registry).map((f) => [f, parseManifest(readManifest(ROOT, f) ?? '')]))
    const others = sharedBranch(feature, manifests, CFG).filter((f) => UNDERWAY.has(manifests[f].state) || manifests[f].state === 'built')
    if (others.length) return `${spec} is on ${mf.branch} with ${others.join(', ')} — one branch can't be handed to agents as one feature's: merge ${mf.branch} into ${TARGET} first, or finish them in a session`
  }
  // A blocked spec is admitted: naming it is the human asking for a retry (see unpark).
  const lane = laneOf({ ...mf, blocked: 'none' })
  if (lane === 'done') return `${spec} already shipped — nothing left for the fleet`
  // Landed already, and this checkout still holds the live copy: a relaunch would build it twice.
  const prior = landedRow(ROOT, feature)
  if (prior || tryGit(['cat-file', '-e', `${TARGET}:${CFG.registry}/${ARCHIVE}/${feature}`]) !== null) {
    const on = prior?.target ?? TARGET
    return `${feature} already landed on ${on} — merge ${on} into this branch to pick up the shipped spec`
  }
  // The go-ahead recorded where it lands (plan §The go-ahead); a run into another branch isn't it.
  if (isSet(mf.target) && unquote(mf.target) !== TARGET) return `${feature}'s go-ahead lands it on ${unquote(mf.target)} — run with --into ${unquote(mf.target)}`
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
  // For gate.mjs (gates-core gateEnv): which lane this is, and — in the walk lane — what each
  // agent_walk.env key holds in the build lane, so a gate line that isn't @walk gets the test env
  // back instead of the walk env's database. BUILDER_WALK_SMOKE lets it notice a gate that broke
  // the running env; BUILDER_CONFIG_ROOT makes it read the gate lines from this checkout's config.
  env.BUILDER_LANE = lane === 'walk' ? 'walk' : 'build'
  env.BUILDER_CONFIG_ROOT = ROOT
  if (lane === 'walk') {
    const back = Object.fromEntries(Object.keys(AW.env).map((k) => [k, env[k] ?? null]))
    for (const [k, v] of Object.entries(AW.env)) env[k] = v.replaceAll('{feature}', feature)
    env.BUILDER_GATE_ENV = JSON.stringify(back)
    if (AW.start && AW.smoke) env.BUILDER_WALK_SMOKE = String(AW.smoke).replaceAll('{feature}', feature)
  }
  // Deleted AFTER the merge: agent_walk.env accepts any key, and letting it put this one back
  // would point every child at one fixed checkout — the bug the delete exists to prevent.
  delete env.CLAUDE_PROJECT_DIR
  // Set after it for the same reason: a run's cwd is its worktree, beside the repo, so the skills'
  // pause check (`$BUILDER_FLEET_DIR/requests/<feature>.pause`) needs the main checkout's fleet dir.
  env.BUILDER_FLEET_DIR = DIR
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

/** The tree hash of a feature's folder at a ref in ROOT, or null. */
const treeOf = (ref, feature) => tryGit(['rev-parse', '--verify', '--quiet', `${ref}:${specOf(feature)}`])

/**
 * Make the worktree's feature folder exactly ROOT's HEAD copy, and commit it. HEAD is
 * authoritative: it is where the go-ahead was just committed, and the target (merge_into) may
 * hold nothing, or an older copy. Throws a setup-style error.
 */
function bringSpecIn(feature, wt) {
  const spec = specOf(feature)
  try {
    const head = git(['rev-parse', 'HEAD'])
    const from = tryGit(['branch', '--show-current']) || head.slice(0, 7)
    git(['checkout', head, '--', spec], wt)
    // Files only the older copy had go, so the folder matches HEAD's.
    const inHead = new Set(git(['ls-tree', '-r', '--name-only', head, '--', spec]).split('\n'))
    for (const file of git(['ls-files', '--', spec], wt).split('\n').filter(Boolean))
      if (!inHead.has(file)) git(['rm', '-q', '-f', '--', file], wt)
    if (tryGit(['diff', '--cached', '--quiet'], wt) === null) git(['commit', '-qm', `docs(${feature}): spec and plan from ${from}`], wt)
  } catch (e) {
    throw Object.assign(new Error(`could not bring ${spec} into the worktree from ${TARGET}: ${String(e.stderr || e.message).split('\n')[0]}`), { setup: true })
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
    // A spec written on another branch is not on the target (or is an older copy there), so a
    // worktree cut from the target needs ROOT's HEAD folder, which preflight proved is committed.
    if (specBringIn({ targetTree: treeOf(`refs/heads/${TARGET}`, feature), headTree: treeOf('HEAD', feature), worktreeHasFolder: true, isNewBranch: !exists })) bringSpecIn(feature, wt)
    copyInto(wt)
    // A worktree removed when this feature stopped left its build workspace (ledger, rulings) here.
    restoreKept(ROOT, wt, feature)
  }
  else if (!existsSync(join(wt, specOf(feature), 'MANIFEST.md')) && !existsSync(join(wt, specOf(feature), 'SPEC.md')) && !shippedPr(readSpec(wt, feature))) {
    // A bring-in that failed after `worktree add` left a worktree with no folder at all: heal it.
    // A folder holding only SPEC.md is a condensed one (ship ran, the merge is pending): never touched.
    if (specBringIn({ targetTree: null, headTree: null, worktreeHasFolder: false, isNewBranch: false })) bringSpecIn(feature, wt)
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
  console.log(`fleet started detached (pid ${child.pid}) — output in .builder/fleet/fleet.out · /builder:fleet:status`)
  process.exit(0)
}

// ---- dry run -------------------------------------------------------------------------------
const fleet = loadFleet(ROOT)
/**
 * The branch every finished feature is merged into: --into for this run, else the config's
 * merge_into (default base_branch) — never whatever happens to be checked out, which is how work
 * ended up stranded on a feature branch. The one exception is a repo that opts in with
 * `merge_into: current`: then it is the branch checked out in the main worktree, resolved here, at
 * launch. Kept in fleet.json; a fleet with unfinished rows keeps its target until they finish.
 */
const TARGET_FROM = flag('--into') ? '--into' : CFG.mergeIntoCurrent ? 'merge_into: current' : 'merge_into'
const TARGET = opt('--into') ?? CFG.mergeInto
if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${TARGET}`]) === null) {
  console.error(`The branch to merge into, ${TARGET}, does not exist — create it (git branch ${TARGET}) or set merge_into in .claude/builder.md.`)
  process.exit(2)
}
// Each worktree is cut from the target, so its agents read the target's config — a target that
// predates the agent_walk: block parks every feature on its first run. Refuse before anything starts.
if (!hasAgentWalk(tryGit(['show', `refs/heads/${TARGET}:${CONFIG_PATH}`]))) {
  const here = tryGit(['branch', '--show-current'])
  const instead = here && here !== TARGET ? `, or land on this branch instead: --into ${here}` : ''
  console.error(`${TARGET} has no agent_walk: block in ${CONFIG_PATH} — each worktree is cut from ${TARGET}, so its agents would park at once. Commit the config to ${TARGET}${instead}.`)
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
  console.error(`Another fleet is running in this repo (pid ${runningPid}). Name specs to add them to its queue; /builder:fleet:status shows where it stands.`)
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
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: ${BATCHED ? `up to ${BATCH} features per walk — one env, one walker` : 'one at a time'}${SPLIT ? ' · verify and walk fixes in the build lane, away from the walk env' : ''}`)
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
  if (fresh.length || requeue.length) console.log('picked up when a lane frees — /builder:fleet:status shows the queue')
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
    console.error(`Another fleet is running in this repo (pid ${pid}). Name specs to add them to its queue; /builder:fleet:status shows where it stands.`)
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
const save = () => saveFleet(ROOT, fleet, progressOf, testsOf)
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
  if (fleet.walkBatch?.startPgid) {
    killStartSync(fleet.walkBatch)
    if (existsSync(WALK_WT)) hook(AW.stop, WALK_WT, '_walk')
  }
  // The launch's env check, cut short: its dev server must not hold the walk ports for the next run.
  if (fleet.envCheck?.startPgid) {
    killStartSync(fleet.envCheck)
    if (existsSync(fleet.envCheck.worktree)) hook(AW.stop, fleet.envCheck.worktree, '_envcheck')
  }
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
  for (const f of [...Object.values(fleet.features), ...(fleet.walkBatch ? [fleet.walkBatch] : [])]) {
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
// The run's progress counts what it merges (renderStatus, the status line): a new run starts the
// count empty; one that took over a dead fleet's lock carries on that fleet's count, leftovers too.
if (!tookOverStaleLock) fleet.landedThisRun = []
for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'done') archiveRow(feature, null, tookOverStaleLock)
pruneArchivedLogs(ROOT, AW.keepLogs)

fleet.target = TARGET
for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null, unpark: true, ...(after[f] && { waitsOn: after[f] }) }
// Naming a parked or failed feature is asking for a retry, whatever stopped it: enqueue unparks it.
for (const f of asked)
  if (['parked', 'failed'].includes(fleet.features[f]?.status)) {
    markUnpark(fleet.features[f])
    clearPause(f)
  }

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

async function runClaude(wt, feature, lane, n, prompt = `/builder:resume --path ${specOf(feature)} --agent-walk --into ${TARGET}${lane === 'walk' ? (SPLIT ? ' --walk-lane' : '') : ' --no-dev-env'}${priorPark(fleet.features[feature])}`, rec = fleet.features[feature]) {
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  const env = envFor(feature, lane)
  if (rec === fleet.features[feature]) noteFacts(rec, feature) // the ship run removes the manifest and plan: read them first
  // A Claude Code auto-update swaps the binary out for a few seconds; wait it out rather than fail
  // the feature (the run would otherwise end `spawn claude ENOENT`, exit 127).
  if (!(await waitForCommand(CLAUDE))) console.error(`[fleet] ${CLAUDE} not found on PATH after 3 min — starting anyway`)
  return new Promise((done) => {
    const out = createWriteStream(log)
    const raw = createWriteStream(log.replace(/\.log$/, '.jsonl'))
    const t0 = Date.now()
    let result = null // the last `result` event: { duration_ms, num_turns }
    let settled = false
    let timedOut = false
    // A killed run has no result event; say why in its log, or an empty log reads as a lost one.
    const mins = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`)
    const kill = (why) => {
      if (!timedOut) {
        try {
          out.write(`\n[fleet] killed: ${why}\n`)
        } catch {}
        rec.killedBy = why // decide() names the cause: the idle timeout is not the run cap
      }
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    let idle = setTimeout(kill, IDLE_TIMEOUT_MS, `no output for ${mins(IDLE_TIMEOUT_MS)} (the idle timeout)`)
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(idle)
      raw.end()
      active.delete(child)
      delete rec.pgid
      // Time and turns per run: Claude's own result event, or wall-clock when the run never sent one.
      const timing = rec.timing ?? (rec.timing = [])
      // start/end are wall-clock, for the stage timeline (queueing, parks); ms is the run's own time.
      timing.push({ n, lane: lane === 'walk' ? 'walk' : 'build', ms: result?.duration_ms ?? Date.now() - t0, start: new Date(t0).toISOString(), end: new Date().toISOString(), turns: result?.num_turns ?? null, tokens: tokensOf(result) })
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
      rec.pgid = child.pid
      save()
    }
    // The raw stream goes to <log>.jsonl; the .log gets what a human reads — the run's own words
    // as it goes, and its final result. Any output at all resets the idle timer.
    let buf = ''
    const seen = { lastText: '' }
    child.stdout.on('data', (chunk) => {
      clearTimeout(idle)
      idle = setTimeout(kill, IDLE_TIMEOUT_MS, `no output for ${mins(IDLE_TIMEOUT_MS)} (the idle timeout)`)
      raw.write(chunk)
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (line.includes('"subtype":"init"')) {
          try {
            const why = initWithoutBuilder(JSON.parse(line))
            if (why) kill(why)
          } catch {}
        }
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
      idle = setTimeout(kill, IDLE_TIMEOUT_MS, `no output for ${mins(IDLE_TIMEOUT_MS)} (the idle timeout)`)
      out.write(chunk)
    })
    const timer = setTimeout(kill, RUN_TIMEOUT_MS, `still running after ${mins(RUN_TIMEOUT_MS)} (the run timeout)`)
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
 * What the estimates need from a landing: the plan's size and the manifest's test plan (`tests`, the
 * formatTests value; `profile` keeps the old preset key for rows read by an older builder). /builder:ship
 * removes both files before the landing, so the fleet notes them on the row (f.facts, kept in
 * fleet.json) each time it reads a live manifest — the last reading before the ship run wins.
 * Without a manifest to read, the earlier reading stands; with none at all: size null, the plan a
 * go-ahead'd feature with neither line maps to (thorough's).
 */
function noteFacts(f, feature) {
  if (!f.worktree || !existsSync(f.worktree)) return
  const mf = readManifest(f.worktree, feature)
  if (mf == null) return
  const plan = readDoc(f.worktree, feature, 'PLAN.md')
  f.facts = { size: plan == null ? (f.facts?.size ?? null) : planSize(plan), ...planFacts(parseManifest(mf)), walk: readWalkFacts(f.worktree, feature) ?? f.facts?.walk ?? null }
}

/** The walk's size and rounds from the workspace (walkFacts) — null when nothing was walked yet. */
function readWalkFacts(worktree, feature) {
  const ws = join(worktree, '.builder', feature)
  const dir = join(ws, 'agent-walk')
  const reports = existsSync(dir)
    ? readdirSync(dir).map((d) => /^round-(\d+)$/.exec(d)).filter(Boolean).flatMap((m) => {
        const p = join(dir, m[0], 'report.md')
        return existsSync(p) ? [{ n: Number(m[1]), text: readFileSync(p, 'utf8') }] : []
      })
    : []
  const walkMd = existsSync(join(ws, 'walk.md')) ? readFileSync(join(ws, 'walk.md'), 'utf8') : null
  if (!reports.length && walkMd == null) return null
  return walkFacts({ walkMd, reports })
}

/** A manifest → { tests, profile }: the resolved plan as a manifest value, and the old `profile:` as written (null without one). */
function planFacts(mf) {
  // The fleet only lands go-ahead'd features, so a manifest with neither line is the thorough mapping.
  const m = { 'go-ahead': 'yes', ...mf }
  return { tests: formatTests(parseTestPlan(m).levers), profile: isSet(mf.profile) ? mf.profile : null }
}

function landingFacts(f, feature) {
  if (f.facts) return f.facts
  const base = f.worktree && existsSync(f.worktree) ? f.worktree : ROOT
  const plan = readDoc(base, feature, 'PLAN.md')
  const mf = readManifest(base, feature)
  return { size: plan == null ? null : planSize(plan), ...planFacts(mf == null ? {} : parseManifest(mf)) }
}

/**
 * The feature's stage timeline, from its branch's own commits (stagesFromCommits) — read before the
 * merge and the branch deletion take them out of reach. Only commits this branch added count.
 */
function noteStages(f, feature) {
  if (!f.branch || tryGit(['rev-parse', '--verify', '-q', `refs/heads/${f.branch}`]) === null) return
  const base = tryGit(['merge-base', `refs/heads/${TARGET}`, `refs/heads/${f.branch}`])
  if (!base) return
  const log = tryGit(['log', '--reverse', '--first-parent', '--format=%ct%x09%s', `${base}..refs/heads/${f.branch}`]) ?? ''
  const commits = log.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { t: Number(l.slice(0, i)), s: l.slice(i + 1) } })
  if (commits.length) f.stages = stagesFromCommits(commits, feature)
}

/**
 * Wall-clock facts for the archive row: start → merge (`wallMs`), the stage timeline, how long the
 * built feature waited for the walk lane (first walk run after the end gates), and the merge itself.
 */
function wallFacts(f, now = Date.now()) {
  const st = f.stages
  if (!st?.startedAt) return { wallMs: null, stages: null, walkQueueMs: null }
  // A branch a person started long before the fleet took it: the wall-clock starts with the fleet's
  // first run, not with a commit weeks earlier.
  const firstRun = (f.timing ?? []).map((t) => Date.parse(t.start)).filter(Number.isFinite).sort((a, b) => a - b)[0]
  const startedAt = firstRun != null && st.startedAt < firstRun - 24 * 3600 * 1000 ? firstRun : st.startedAt
  const firstWalk = (f.timing ?? []).filter((t) => t.lane === 'walk' && t.start).map((t) => Date.parse(t.start)).sort((a, b) => a - b).find((at) => st.endGatesAt != null && at >= st.endGatesAt)
  const stages = { ...st.stages, ...(st.lastAt ? { merge: Math.max(0, now - st.lastAt) } : {}) }
  return { wallMs: now - startedAt, stages, walkQueueMs: firstWalk != null ? firstWalk - st.endGatesAt : null, walkRounds: st.walkRounds, parks: st.parks }
}

/** A landed feature leaves fleet.json: one line in archive.jsonl, its logs under logs/_archive/. */
function archiveRow(feature, facts, thisRun = true) {
  clearPause(feature)
  const f = fleet.features[feature]
  const { size, tests, profile, walk } = facts ?? landingFacts(f, feature)
  const sum = (k) => (f.timing ?? []).reduce((a, t) => a + (t.tokens?.[k] ?? 0), 0)
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
    size,
    tests: tests ?? null,
    profile: profile ?? null,
    tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead') },
    costUsd: sum('costUsd'),
    ...wallFacts(f),
    walk: walk ?? f.facts?.walk ?? null,
    landedAt: new Date().toISOString(),
  })
  delete fleet.features[feature]
  fleet.archived = (fleet.archived ?? 0) + 1
  if (thisRun) fleet.landedThisRun = [...new Set([...(fleet.landedThisRun ?? []), feature])]
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
  // A revision asked for before the merge parks it here: once merged, revise has nothing to change.
  if (parkIfPaused(f, feature)) return 'parked'
  noteFacts(f, feature)
  const facts = landingFacts(f, feature)
  noteStages(f, feature)
  f.pr = shippedPr(readSpec(f.worktree, feature))
  if (f.pr && !/^#/.test(f.pr)) f.pr = null
  if (tryGit(['merge-base', '--is-ancestor', f.branch, TARGET]) === null) {
    // The config is the human's: a branch that changes it never lands it unseen.
    const cfgDiff = tryGit(['diff', '--stat', `refs/heads/${TARGET}...${f.branch}`, '--', CONFIG_PATH])
    if (cfgDiff) return park(f, configParkReason(f.branch))
    if (f.worktree && existsSync(f.worktree)) {
      const why = await syncTarget(f.worktree, 'features that merged while this one shipped', feature)
      if (why) return park(f, why)
    }
    const why = mergeIntoTarget(feature, f.branch)
    if (why) return park(f, why)
  }
  Object.assign(f, { status: 'done', reason: null, merged: tryGit(['rev-parse', '--short', TARGET]) })
  // Nothing is left behind: test output in the worktree is restored, any other uncommitted change
  // is stashed by name, the worktree goes, and so does the branch — whoever made it — once it is in
  // the target (`-d` refuses one that isn't).
  if (f.worktree) {
    const r = clearWorktree(ROOT, f.worktree, feature, { keep: false })
    if (r.stash) addNote(`${feature} merged; uncommitted changes from its worktree are in stash "${r.stash}" — git stash list`)
    if (r.removed || !existsSync(f.worktree)) f.worktree = null
    else addNote(`${feature} merged; its worktree ${f.worktree} stays: ${r.why} — /builder:tidy removes it once that's settled`)
  }
  // `branch -d` judges "merged" against what is checked out here, which need not be the target:
  // ask the target itself, then delete.
  if (f.branch && f.branch !== TARGET && f.branch !== CFG.baseBranch && !f.worktree && tryGit(['merge-base', '--is-ancestor', `refs/heads/${f.branch}`, `refs/heads/${TARGET}`]) !== null)
    tryGit(['branch', '-D', f.branch])
  archiveRow(feature, facts)
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
    const before = tryGit(['rev-parse', 'HEAD'])
    try {
      execFileSync('git', ['merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      migrateAfterLanding(feature, before, 'HEAD')
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
  const landed = newMigrations(old, commit)
  if (landed.length) addNote(`${feature} brought ${landed.length} new migration${landed.length === 1 ? '' : 's'} to ${TARGET} — when you switch to it, apply them to the dev DB first (§Walk readiness \`apply:\`)`)
  return null
}

/** The migration files `from..to` added under the config's §Walk readiness `migrations:` dir, with their text. */
function newMigrations(from, to) {
  const dir = parseWalkReadiness(CFG.body).migrations
  if (!dir || !from) return []
  const names = (tryGit(['diff', '--name-only', '--diff-filter=A', `${from}..${to}`, '--', dir]) ?? '').split('\n').filter(Boolean)
  return names.map((path) => ({ path, text: tryGit(['show', `${to}:${path}`]) ?? '' }))
}

/**
 * After a merge into the target checked out here: the dev DB this checkout serves must have the
 * migrations the feature brought (a hot-reloading dev server is already running the merged code).
 * apply_mode agent and additive → run the config's apply, then regenerate, here; anything else → a
 * note naming what to run. The walk only proved them on a throwaway walk DB.
 */
function migrateAfterLanding(feature, before, after) {
  const files = newMigrations(before, after)
  const readiness = parseWalkReadiness(CFG.body)
  let plan = landedMigrations({ files, readiness })
  // Only when a "may be behind" note is due is the database asked (and never its side effects otherwise).
  if (plan.kind === 'maybe' && readiness.pending) plan = landedMigrations({ files, readiness, pending: devDbPending(readiness) })
  if (plan.action === 'none') return
  if (plan.action === 'note') return addNote(`⚠ ${feature}: ${plan.why}`)
  const log = join(DIR, 'logs', `${feature}-land.log`)
  mkdirSync(dirname(log), { recursive: true })
  for (const cmd of plan.commands) {
    const fd = openSync(log, 'a')
    try {
      execSync(cmd, { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 10 * 60 * 1000 })
    } catch {
      return addNote(`⚠ ${feature}: ${files.length} new migration${files.length === 1 ? '' : 's'} landed, but \`${cmd}\` failed in this checkout — see ${log}, then run ${plan.commands.map((c) => `\`${c}\``).join(', then ')} by hand`)
    } finally {
      closeSync(fd)
    }
  }
  addNote(`${feature}: applied ${files.length} new migration${files.length === 1 ? '' : 's'} to the dev DB here (${plan.commands.map((c) => `\`${c}\``).join(', then ')})`)
}

/**
 * Ask the database, not git: §Walk readiness `pending:` run here, in the checkout whose dev DB it is —
 * exit 0 means nothing pending, anything else pending (or unknown). Null when there is no command.
 */
function devDbPending(readiness) {
  if (!readiness.pending) return null
  try {
    execSync(readiness.pending, { cwd: ROOT, stdio: 'ignore', timeout: 2 * 60 * 1000 })
    return false
  } catch {
    return true
  }
}

/** A pause request parks the feature at once — before a sync, a walk env or a run. No run counted. */
function parkIfPaused(f, feature) {
  if (!existsSync(pauseFile(feature))) return false
  park(f, `revising — next: /builder:revise --path ${specOf(feature)}`)
  return true
}

/** A run starts: its start is what stallOf measures quiet from, and its kill reason is its own. */
function startRun(f) {
  f.runStartedAt = new Date().toISOString()
  delete f.killedBy
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
  let envRestarted = false
  const kills = [] // why each failed run of this streak was killed (null: it exited on its own)
  for (;;) {
    // The one place both lanes pass before a run starts: a pause request parks it, uncounted.
    if (parkIfPaused(f, feature)) return 'parked'
    const before = snapshot(f.worktree, feature)
    const headBefore = tryGit(['rev-parse', 'HEAD'], f.worktree)
    f.runs = (f.runs ?? 0) + 1 // lifetime, for the table and the log names
    f.runsThisTime = (f.runsThisTime ?? 0) + 1 // this fleet run, for the cap
    startRun(f)
    save()
    const { exit, log } = await runClaude(f.worktree, feature, lane, f.runs)
    f.log = log
    if (exit !== 0) kills.push(exit === null ? f.killedBy ?? null : null)
    // A walk judged against a dead env says nothing about the feature: restart it and walk again.
    if (lane === 'walk' && !envRestarted) {
      const died = await envDied(feature, f, headBefore)
      if (died) envRestarted = true
      if (died === 'back') continue
      // It would not come back: the walk-env path (restart from scratch, then an agent fix run) owns it.
      if (died === 'down') {
        Object.assign(f, { status: 'parked', reason: 'walk env needs a restart — it stopped answering during the walk and would not come back up' })
        save()
        return 'parked'
      }
    }
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
      batched: SPLIT,
      killed: kills,
    })
    if (d.action === 'retry') {
      failures++
      continue
    }
    failures = 0
    kills.length = 0
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

/**
 * After a walk-lane run, the fleet's own smoke (agent_walk.smoke, three tries) tells "the env broke"
 * from "the feature is broken". Smoke red → the env died under the run: whatever the run concluded
 * about the app was judged against nothing, so its doc-only commits (a walk round's verdict, ## Fixes
 * rows, a park) are dropped — never a commit that touched code — and the env restarts without a
 * reset. True when that happened; the caller walks again, once. No start or smoke: nothing to tell.
 */
async function envDied(feature, f, headBefore) {
  if (!AW.start || !AW.smoke || !f.startPgid) return null
  if (await smokeOk(feature, f)) return null
  const after = tryGit(['rev-parse', 'HEAD'], f.worktree)
  const touched = headBefore && after && headBefore !== after ? (tryGit(['diff', '--name-only', headBefore, after], f.worktree) ?? '').split('\n').filter(Boolean) : []
  const docsOnly = touched.every((p) => p.startsWith(`${specOf(feature)}/`))
  // Drop the run's verdict only when it is nothing but docs and nothing uncommitted would go with it;
  // a park the run wrote is cleared with it, never on its own.
  const clean = !(tryGit(['status', '--porcelain'], f.worktree) ?? '').trim()
  const dropped = touched.length > 0 && docsOnly && clean && tryGit(['reset', '--hard', '--quiet', headBefore], f.worktree) !== null
  const kept = !touched.length ? '' : dropped ? 'its verdict was dropped, ' : !docsOnly ? 'its commits touched code, so they stay; ' : 'its verdict stays (uncommitted changes in the worktree), '
  addNote(`${feature}: the walk env stopped answering during a walk run — ${kept}the env is restarted and the walk runs again`)
  await killStart(f)
  const back = await startWalkEnv(feature, f)
  save()
  return back ? 'back' : 'down'
}

/** agent_walk.smoke against the running env, up to three tries a few seconds apart. */
async function smokeOk(feature, f) {
  for (let i = 0; i < 3; i++) {
    const ok = await new Promise((r) => execFile('sh', ['-c', AW.smoke], { cwd: f.worktree, env: envFor(feature, 'walk'), timeout: SMOKE_ATTEMPT_MS }, (err) => r(!err)))
    if (ok) return true
    await sleep(Math.min(3000, SMOKE_INTERVAL_MS * 3))
  }
  return false
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
async function startWalkEnv(feature, f = fleet.features[feature]) {
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
  const text = readFileSync(p, 'utf8')
  const line = /^blocked:\s*"?(.*?)"?\s*$/m.exec(text)?.[1] ?? ''
  // Only the restart line the fleet answers by restarting; any other block (a decision) stands.
  if (!RESTART.test(line)) return
  writeFileSync(p, text.replace(/^blocked:.*$/m, 'blocked: none'))
  tryGit(['commit', '-qm', `chore(${feature}): walk env restarted by the fleet`, '--', join(specOf(feature), 'MANIFEST.md')], wt)
}

/** Reset, then start and smoke the walk env. Null when it is up; else what failed. A RESTART
 *  mid-walk skips the reset: the walk's database already carries its migrations and its data, and a
 *  reset can take minutes (a copy of the dev database). */
async function bringUpWalkEnv(feature, { reset = true } = {}, f = fleet.features[feature]) {
  if (reset && !hook(AW.reset, f.worktree, feature)) return `agent_walk.reset failed: ${AW.reset}`
  // `smoke` without `start` has nothing to probe — ignored, as the spec says.
  if (AW.start && !(await startWalkEnv(feature, f))) return `walk env didn't come up — see ${f.startLog}`
  return null
}

/** One headless run told what failed and asked to fix its cause in the branch. */
async function fixWalkEnv(feature, why) {
  const f = fleet.features[feature]
  f.runs = (f.runs ?? 0) + 1
  startRun(f)
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
  if (parkIfPaused(f, feature)) return 'parked'
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
        const why = await bringUpWalkEnv(feature, { reset: restarts === 0 })
        if (!why) break
        await killStart(f)
        if (attempt === 1) return park(f, `the walk env would not start (${why}) and an agent run could not fix it — next: run agent_walk.start in ${f.worktree} and fix what it prints, then /builder:agent`)
        await fixWalkEnv(feature, why)
      }
      const outcome = await drive(feature, 'walk')
      // Signed off with the env still up: its @walk gates now, for verify in the pool to read. Exit 3 —
      // a gate broke the env — restarts it (no reset) and runs them once more.
      if (SPLIT && parseManifest(readManifest(f.worktree, feature) ?? '').state === 'signed-off' && (await runWalkGates([feature], f.worktree, feature)) === 3) {
        await killStart(f)
        if (await startWalkEnv(feature, f)) await runWalkGates([feature], f.worktree, feature)
      }
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
  const lane = text == null ? 'unknown' : laneOf(mf, { batched: SPLIT, specText: readSpec(f.worktree, feature) })
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
const HUMAN_STEP = /uncommitted changes are in the way|is checked out in |waiting for your walk|^revising|^config change needed/

/** Why a branch that changes the config parks, and the human's next step. */
const configParkReason = (branch) =>
  `config change needed — ${branch} changes ${CONFIG_PATH}, which is yours to change — next: read git diff ${TARGET}...${branch} -- ${CONFIG_PATH}, apply what you want on ${TARGET}, drop it from the branch (git checkout ${TARGET} -- ${CONFIG_PATH} in its worktree, commit), then /builder:agent`
const YOUR_WALK = /^waiting for your walk/

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

/** agent_walk.auto_unpark, except 0 for a feature whose test plan has low persistence (persist=low; an old rush). */
function retryBudget(f, feature) {
  const live = [f.worktree, ROOT].filter(Boolean).map((b) => readManifest(b, feature)).find(Boolean)
  const mf = live ? parseManifest(live) : { tests: f.facts?.tests, profile: f.facts?.profile }
  return parseTestPlan(mf).levers.persist === 'low' ? 0 : AW.autoUnpark
}

/**
 * agent_walk.auto_unpark: a park gets an agent run to dig into its record, up to that many times per
 * fleet run — every park but a human-step one, which only a person can clear. The walk env's own
 * restart line is not a park the fleet retries this way (walkOne restarts it). True when requeued.
 */
function autoRetry(feature) {
  const f = fleet.features[feature]
  if (f?.status !== 'parked' || RESTART.test(f.reason ?? '')) return false
  if ((f.autoUnparks ?? 0) >= retryBudget(f, feature) || parkKind(feature) === 'human-step') return false
  f.autoUnparks = (f.autoUnparks ?? 0) + 1
  markUnpark(f, `the fleet — automatic retry ${f.autoUnparks} of ${retryBudget(f, feature)}`)
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
      clearPause(name)
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
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('No agent_walk.reset') && !n.startsWith(BASELINE_NOTE) && !/ was kept \(it has changes\)/.test(n))
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
    const told = { ...fleet.features[feature] }
    const retried = autoRetry(feature)
    tellStop(feature, told, retried ? `automatic retry ${fleet.features[feature].autoUnparks} of ${retryBudget(fleet.features[feature], feature)}` : null)
    if (retried) return
  }
  if (outcome === 'failed') tellStop(feature, fleet.features[feature])
  if (outcome === 'walk') walkQueue.push(feature)
  else if (outcome === 'build' || outcome === 'ship') pool.push({ feature, lane: outcome })
  else if (outcome === 'done') release()
}

/**
 * The fleet runs detached, so nothing in a session hears a park: say it in fleet.out (the detached
 * fleet's own output, appended to) as a block a person reads — what, why, next, and the park record.
 * `f` is the row as it parked (autoRetry has already unparked the live one when it retries).
 */
function tellStop(feature, f, retry = null) {
  const rel = join(specOf(feature), 'PARKED.md')
  const record = f.status === 'parked' && f.worktree && existsSync(join(f.worktree, rel)) ? join(f.worktree, rel) : null
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(join(DIR, 'fleet.out'), parkBlock({ feature, status: f.status, reason: f.reason, record, branch: f.branch, log: f.log, retry }))
  } catch {}
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
      else if (parkIfPaused(fleet.features[feature], feature)) outcome = 'parked'
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

// ---- batched walks (agent-walk §Batched walks) -------------------------------------------------
/** The batch's own record — its worktree, start process, runs and timing — kept in fleet.json, so a
 *  fleet taking over a stale lock can end its env. */
const walkRec = () => (fleet.walkBatch ??= { worktree: WALK_WT, runs: 0, timing: [] })

/**
 * A batch session's time belongs to the features it walked: each gets its share as a walk-lane run
 * (`shared: <n>`), so a batched feature's walk lane is not empty in the archive and --status.
 */
function chargeBatch(rec, features) {
  const t = rec.timing?.[rec.timing.length - 1]
  if (!t || !features.length) return
  const share = (v) => (typeof v === 'number' ? v / features.length : v)
  for (const x of features) {
    const fx = fleet.features[x]
    if (!fx) continue
    ;(fx.timing ??= []).push({ ...t, ms: share(t.ms), shared: features.length, tokens: Object.fromEntries(Object.entries(t.tokens ?? {}).map(([k, v]) => [k, share(v)])) })
  }
  save()
}

/**
 * The walk worktree: the target with each batched feature's branch merged in, in order. A feature
 * that conflicts with the ones merged before it waits for the next batch (first in line). Untracked
 * files — agent_walk.copy's `.env` — survive the reset. Throws when setup or sync fails.
 */
function prepareWalkTree(features) {
  if (!existsSync(WALK_WT)) {
    mkdirSync(WORKTREES, { recursive: true })
    tryGit(['worktree', 'prune'])
    git(['worktree', 'add', '-f', '-B', WALK_BRANCH, WALK_WT, `refs/heads/${TARGET}`])
    copyInto(WALK_WT)
    if (AW.setup) runSetup('_walk', WALK_WT)
  } else git(['reset', '--hard', '--quiet', `refs/heads/${TARGET}`], WALK_WT)
  const merged = []
  const deferred = []
  for (const feature of features) {
    if (tryGit(['merge', '--no-ff', '--no-edit', '-m', `walk batch: ${feature}`, `refs/heads/${fleet.features[feature].branch}`], WALK_WT) === null) {
      tryGit(['merge', '--abort'], WALK_WT)
      deferred.push(feature)
    } else merged.push(feature)
  }
  if (AW.sync && merged.length) {
    const log = join(DIR, 'logs', '_walk-sync.log')
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'w')
    try {
      execSync(AW.sync.replaceAll('{feature}', '_walk'), { cwd: WALK_WT, env: envFor('_walk', 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
    } catch {
      throw new Error(`agent_walk.sync failed in the walk worktree — see ${log}`)
    } finally {
      closeSync(fd)
    }
  }
  return { merged, deferred }
}

/**
 * The deep set's @walk lines, once for the batch, against the env serving every feature in it —
 * written to each feature's workspace as walk-gates.md, which its verify reads (verify §@walk lines).
 */
async function runWalkGates(features, wt = WALK_WT, envOf = '_walk') {
  if (!parseGates(CFG.body).deep.some((g) => g.walk)) return null
  const r = await execAsync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'gate.mjs'), '--walk-only', '--force'], { cwd: wt, env: envFor(envOf, 'walk') })
  const head = tryGit(['rev-parse', '--short', 'HEAD'], wt)
  const text = `# @walk gates — ${wt === WALK_WT ? 'walk batch' : 'the walk'} at ${head}\n\nfeatures in the batch: ${features.join(', ')}\nexit: ${r.status}${r.status === 3 ? ' (the walk env stopped answering)' : ''}\n\n\`\`\`\n${r.output.trim().split('\n').slice(-120).join('\n')}\n\`\`\`\n`
  for (const x of features) {
    const ws = join(fleet.features[x].worktree, '.builder', x)
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'walk-gates.md'), text)
  }
  return r.status
}
/** A command without holding the fleet's event loop (an e2e suite takes minutes; the lanes keep moving). */
const execAsync = (cmd, args, opts) =>
  new Promise((done) => {
    // Its own group, tracked in `active` like a claude run, so stopAll ends it with everything else.
    const child = execFile(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60 * 60 * 1000, detached: true }, (err, stdout, stderr) => {
      active.delete(child)
      done({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
    })
    if (child.pid) active.add(child)
  })

/**
 * One walk for several features: merge them into the walk worktree, bring the env up once (reset
 * once), and run one session — readiness for the batch, one walker by screen across every feature,
 * each verdict written in its own worktree. A restart line restarts the env without a reset and
 * runs the session again for what is left. Each feature leaves the batch by its own manifest: signed
 * off → the pool (verify, ship), fixes → the pool (build lane), a park → parked. Anything the batch
 * can't do — a walk tree that won't prepare, an env that won't come up — falls back to one walk
 * per feature (walkOne), which has the env-repair run.
 */
async function walkBatch(batch) {
  const live = []
  for (const feature of batch) {
    const f = fleet.features[feature]
    if (parkIfPaused(f, feature)) {
      route(feature, 'parked')
      continue
    }
    f.status = 'walking'
    save()
    const text = readManifest(f.worktree, feature)
    if (text && SYNC_BEFORE_WALK.has(parseManifest(text).state)) {
      const why = await syncTarget(f.worktree, 'what other features merged', feature)
      if (why) {
        route(feature, park(f, why))
        continue
      }
    }
    live.push(feature)
  }
  if (!live.length) return
  const one = async (features, why) => {
    if (why) addNote(`walk batch: ${why} — walked ${features.join(', ')} one at a time`)
    for (const feature of features) route(feature, await walkOne(feature))
  }
  if (live.length === 1) return one(live)
  let tree
  try {
    tree = prepareWalkTree(live)
  } catch (e) {
    return one(live, `the walk worktree could not be prepared (${e.message})`)
  }
  for (const feature of tree.deferred.reverse()) {
    Object.assign(fleet.features[feature], { status: 'awaiting-walk', reason: null })
    walkQueue.unshift(feature)
  }
  if (tree.merged.length < 2) return one(tree.merged)
  const rec = walkRec()
  let active = [...tree.merged]
  const failures = {}
  const stalls = {}
  const kills = {} // per feature: why each failed session of its streak was killed
  try {
    // Up once for the batch — `reset` once — and kept up across its sessions; a restart line
    // restarts it without a reset.
    const down = await bringUpWalkEnv('_walk', { reset: true }, rec)
    if (down) {
      await killStart(rec)
      return one(active, `the env would not come up for the batch (${down})`)
    }
    for (let session = 0; active.length && session < 4; session++) {
      const before = Object.fromEntries(active.map((x) => [x, snapshot(fleet.features[x].worktree, x)]))
      for (const x of active) {
        const fx = fleet.features[x]
        fx.runs = (fx.runs ?? 0) + 1
        fx.runsThisTime = (fx.runsThisTime ?? 0) + 1
        startRun(fx)
      }
      rec.runs = (rec.runs ?? 0) + 1
      delete rec.killedBy
      save()
      const folders = active.map((x) => join(fleet.features[x].worktree, specOf(x)))
      const { exit, log } = await runClaude(WALK_WT, '_walk', 'walk', rec.runs, `/builder:agent-walk --batch --into ${TARGET} ${folders.join(' ')}`, rec)
      chargeBatch(rec, active)
      const next = []
      const leaving = []
      let restart = false
      for (const x of active) {
        const fx = fleet.features[x]
        fx.log = log
        if (exit !== 0) (kills[x] ??= []).push(exit === null ? rec.killedBy ?? null : null)
        const d = decide({ lane: 'walk', manifestText: readManifest(fx.worktree, x), specText: readSpec(fx.worktree, x), exit, failures: failures[x] ?? 0, stalls: stalls[x] ?? 0, runs: fx.runsThisTime, cap: RUN_CAP, progressed: snapshot(fx.worktree, x) !== before[x], folder: specOf(x), batched: SPLIT, killed: kills[x] ?? [] })
        if (d.action === 'park' && RESTART.test(d.reason)) {
          clearBlocked(fx.worktree, x)
          restart = true
          next.push(x)
          continue
        }
        if (d.action === 'retry') failures[x] = (failures[x] ?? 0) + 1
        if (d.action === 'stalled') stalls[x] = (stalls[x] ?? 0) + 1
        if (['retry', 'stalled', 'again'].includes(d.action)) {
          next.push(x)
          continue
        }
        leaving.push([x, d])
      }
      // The @walk gates, while the env is still up, for every feature signed off this session —
      // before verify, in the pool, can look for them.
      const signed = leaving.filter(([, d]) => d.action === 'handoff' && d.to === 'ship').map(([x]) => x)
      // A gate that rewrote what the env serves (exit 3), or an env that died during the session: restart it.
      if (signed.length && (await runWalkGates(signed)) === 3) restart = true
      if (AW.smoke && rec.startPgid && !(await smokeOk('_walk', rec))) {
        addNote('the walk env stopped answering during a batch session — restarted without a reset')
        restart = true
      }
      for (const [x, d] of leaving) {
        const fx = fleet.features[x]
        failures[x] = 0
        stalls[x] = 0
        delete kills[x]
        if (d.action === 'handoff') {
          Object.assign(fx, { status: QUEUED[d.to] ?? 'queued', reason: null })
          save()
          route(x, d.to)
        } else if (d.action === 'done') route(x, await land(x))
        else {
          Object.assign(fx, d.action === 'fail' ? { status: 'failed', reason: `${d.reason} — see ${log} — next: /builder:agent to retry` } : { status: 'parked', reason: d.reason })
          delete fx.lastPark
          save()
          route(x, fx.status)
        }
      }
      active = next
      if (restart && active.length) {
        await killStart(rec)
        const again = await bringUpWalkEnv('_walk', { reset: false }, rec)
        if (again) {
          await killStart(rec)
          return one(active, `the env would not come back up after a restart (${again})`)
        }
      }
    }
    for (const x of active) route(x, park(fleet.features[x], `the walk batch made no headway in four sessions — next: /builder:agent to retry; the last log says where it stopped`))
  } finally {
    await killStart(rec)
    if (!hook(AW.stop, WALK_WT, '_walk')) addNote(`agent_walk.stop failed after a walk batch: ${AW.stop}`)
    save()
  }
}

/**
 * The walk env, proved once at launch: start and smoke in a throwaway worktree of the target (with
 * copy and setup, as a feature's), then stop — so a config that can't bring it up says so now, not
 * hours in at the first walk. It runs beside the build lanes; the walk lane waits for it, so the two
 * never hold the env's ports at once. A failure is a note, never a stop: the first walk tries again
 * with its own fix run. --no-env-check skips it.
 */
const ENVCHECK_WT = join(WORKTREES, '_envcheck')
async function envPreflight() {
  if (!AW.start || flag('--no-env-check') || process.env.FLEET_ENV_CHECK === '0') return
  // Recorded on the fleet so stopAll ends its env if the fleet is stopped mid-check.
  const rec = (fleet.envCheck = { worktree: ENVCHECK_WT })
  let why = null
  try {
    await sleep(0) // the lanes start first; nothing below holds them up
    mkdirSync(WORKTREES, { recursive: true })
    tryGit(['worktree', 'prune'])
    if (existsSync(ENVCHECK_WT)) tryGit(['worktree', 'remove', '--force', ENVCHECK_WT])
    git(['worktree', 'add', '-f', '--detach', ENVCHECK_WT, `refs/heads/${TARGET}`])
    copyInto(ENVCHECK_WT)
    if (AW.setup) {
      // Setup can take many minutes (an install): run it off the event loop, logged like a feature's.
      const log = join(DIR, 'logs', '_envcheck-setup.log')
      mkdirSync(dirname(log), { recursive: true })
      const r = await execAsync('sh', ['-c', AW.setup.replaceAll('{feature}', '_envcheck')], { cwd: ENVCHECK_WT, env: envFor('_envcheck', 'build') })
      writeFileSync(log, r.output)
      if (r.status !== 0) throw new Error(`setup failed — see ${log}`)
    }
    const empty = Object.entries(AW.env ?? {}).filter(([, v]) => !String(v).replaceAll('{feature}', '_envcheck').trim()).map(([k]) => k)
    if (empty.length) why = `agent_walk.env leaves ${empty.join(', ')} empty`
    else if (!(await startWalkEnv('_envcheck', rec))) why = `start/smoke failed — see ${rec.startLog}`
  } catch (e) {
    why = e.message.split('\n')[0]
  } finally {
    await killStart(rec)
    if (AW.stop) hook(AW.stop, ENVCHECK_WT, '_envcheck')
    tryGit(['worktree', 'remove', '--force', ENVCHECK_WT])
    delete fleet.envCheck
  }
  if (why) {
    addNote(`walk env launch check failed on ${TARGET}: ${why}. The first walk tries again and an agent looks at it; if the cause is the config (start, smoke, env), fix .claude/builder.md yourself — agents won't`)
    console.error(`[fleet] walk env launch check failed: ${why}`)
  } else console.log(`[fleet] walk env launch check: start and smoke pass on ${TARGET}`)
  save()
}
let envCheck = Promise.resolve()
delete fleet.envCheck // a record a killed run left: never signal a pgid that may have been reused

async function walkLane() {
  await envCheck
  for (;;) {
    if (closing) return
    if (walkQueue.length && BATCHED) {
      // Everything waiting to walk, up to agent_walk.batch: one walk branch, one env, one walker.
      const batch = walkQueue.splice(0, BATCH)
      inFlight++
      await walkBatch(batch)
      inFlight--
      wakeAll()
      continue
    }
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
envCheck = envPreflight().catch((e) => addNote(`walk env launch check: ${e.message}`))
do {
  closing = false
  await Promise.all([...Array.from({ length: PARALLEL }, poolWorker), walkLane()])
} while (drainInbox())
clearInterval(poll)

// Whatever still waits, waits on something that parked or failed: say which, so the table explains it.
for (const [feature, f] of Object.entries(fleet.features))
  if (f.status === 'waiting') {
    Object.assign(f, { status: 'parked', reason: `waits on ${pendingDeps(f).map((d) => `${d} (${fleet.features[d]?.status ?? 'not in the fleet'})`).join(', ')}, which never merged — next: settle ${pendingDeps(f).join(', ')}, then pick both in /builder:agent` })
    tellStop(feature, f)
  }
// An unfinished feature keeps its branch — every finished task is committed there — and loses its
// worktree; picking it again recreates the worktree from the branch. FLEET_KEEP_STOPPED_WORKTREES=1
// keeps them, for looking inside one while debugging the fleet itself.
for (const [feature, f] of Object.entries(fleet.features)) {
  if (process.env.FLEET_KEEP_STOPPED_WORKTREES === '1') break
  if (!['parked', 'failed'].includes(f.status) || !f.worktree) continue
  // A park that sends the human into this worktree ("finish the merge in <wt>") keeps it — and so
  // does one waiting for your walk, which /builder:resume starts in this worktree.
  if ((f.reason ?? '').includes(f.worktree) || YOUR_WALK.test(f.reason ?? '')) continue
  const r = clearWorktree(ROOT, f.worktree, feature)
  if (r.stash) addNote(`${feature} ${f.status}; uncommitted changes from its worktree are in stash "${r.stash}" — git stash list`)
  if (r.removed || !existsSync(f.worktree)) f.worktree = null
  else addNote(`${feature} ${f.status}; its worktree ${f.worktree} stays: ${r.why}`)
}
// The walk worktree and its branch are the batches' scratch, never merged: gone when the fleet is.
if (existsSync(WALK_WT)) {
  tryGit(['worktree', 'remove', '--force', WALK_WT])
  tryGit(['branch', '-D', WALK_BRANCH])
}
delete fleet.walkBatch
// The whole repo, not just this fleet's rows: anything else left lying around is named here too.
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('repo: '))
addNote(summaryLine(inventory(ROOT, CFG, TARGET, { fleet, lockAlive: false })))
save()
unlock()
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
