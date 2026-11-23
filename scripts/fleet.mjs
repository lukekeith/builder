#!/usr/bin/env node
/**
 * fleet — take a batch of specs through the /builder:* pipeline unattended.
 *
 * Everything lands on ONE branch, its TARGET: --into, else the config's merge_into (default base_branch).
 * Each spec gets its own worktree and branch (builder/<feature>) cut from the target. A pool of
 * `parallel` workers runs the BUILD and SHIP lanes with --no-dev-env, so nothing touches the shared
 * dev environment; the WALK lane takes features one at a time through that environment — walk
 * readiness, the agent walk and its sign-off. The SHIP lane takes a signed-off feature (verify is
 * optional after sign-off: the fleet runs the one-call quick check, verify-quick.mjs, never the full
 * /builder:verify), brings the target in and writes the ship commit; then the verifier's merge queue tests the feature merged onto the target and
 * fast-forwards the target to exactly that merge commit (one `--no-ff` merge commit per feature),
 * and the fleet removes its worktree and branch. Nothing is pushed. Progress is read from
 * each worktree's MANIFEST.md (and, once shipped, its SPEC header), never from a run's output.
 *
 *   node <plugin>/scripts/fleet.mjs <feature|path>… [--parallel N]
 *   node <plugin>/scripts/fleet.mjs --all [--parallel N]
 *   node <plugin>/scripts/fleet.mjs … --dry-run     # pre-flight and the plan; nothing created
 *   node <plugin>/scripts/fleet.mjs --status        # the last run's table
 *   node <plugin>/scripts/fleet.mjs --wait          # silent until the fleet exits, then --status
 *   node <plugin>/scripts/fleet.mjs --status --archived [N]   # the latest N landings (20)
 *
 * State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes. A feature that
 * lands leaves fleet.json for archive.jsonl, and its logs move to logs/_archive/<feature>/ (pruned
 * after agent_walk.keep_logs days); fleet.json holds only work in flight. A benchmark run keeps every
 * piece of evidence: FLEET_KEEP_STREAMS=1 archives a metered feature's .jsonl transcripts instead of
 * dropping them, FLEET_KEEP_WORKSPACES=1 keeps a landed feature's build workspace in .builder/kept/.
 */
import { spawn, execFile, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync, openSync, closeSync, cpSync, statSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, basename, resolve, relative } from 'node:path'
import { requireConfig, hasAgentWalk, CONFIG_PATH } from './config.mjs'
import { planSize, parseTestPlan, formatTests } from './profile.mjs'
import { parseManifest, isSet, verifyCheck } from './manifest.mjs'
import { buildingInSession, sharedBranch, parseWalkReadiness, landedMigrations, specBringIn, landedRow, laneOf, decide, loadFleet, saveFleet, fleetDir, shippedPr, renderStatus, readProgress, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, renderArchived, parkParts, duration, laneTotals, tokensOf, streamMeter, meterTotals, reviewFacts, fleetAlive, waitForFleet, stoppedNote, waitForCommand, initWithoutBuilder, stagesFromCommits, walkFacts, wallFacts, hasOpenFixes, keepAwakeArgs, AWAKE_NOTE, AWAKE_UNAVAILABLE, withoutAwake, carryNotes } from './fleet-core.mjs'
import { rowProgress, parkBlock, stallOf, stallLine, markSeen, buildLanePrompt, HUMAN_STEP, PARK_REASONS, parkChoices, choicesSection, overlapRecord, stopChoices, stopNotice, landNotice, endNotice, mayNotify, stoppedNames } from './fleet-core.mjs'
import { features, specDir, ARCHIVE } from './registry.mjs'
import { waitsOn, waitsOnText } from './program.mjs'
import { footprintOf, groupsOf, takeWalkBatch, landingGate, bisectPlan, firstFailing, matchesGlob, generatedOnly, laneCollisions, splitAdvice, overlapOf } from './groups-core.mjs'
import { readRulings } from './fleet-ruling.mjs'
import { requestMerge, mergeVerdict, heldMerge, awaitVerdict, release as releaseMerge, carry as carryMerge } from './verify/fleet-hooks.mjs'
import { clearWorktree, restoreKept, inventory, summaryLine } from './tidy-core.mjs'
import { landOverlap } from './verify/checkouts.mjs'
import { loadVerify } from './verify/config.mjs'
import { laneDbName, laneDbUrl, laneDbPlan, baseOf as dbBaseOf, isolated } from './lane-db.mjs'
import { redact } from './verify/envpool.mjs'
import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { signedOff, signoffHolds } from './feature-core.mjs'

// Runs per feature per fleet run. The build lane ends a run at the audit's and the go-ahead's commits
// (a fresh context per stage, AGENT-MODE.md), so two of these are stage boundaries, not retries.
const RUN_CAP = 14
// A run is killed when it goes quiet, not when it runs long: a 20-task build can take hours and
// still be healthy. Its stream-json output is the heartbeat. The hard cap is only a backstop.
const IDLE_TIMEOUT_MS = Number(process.env.FLEET_IDLE_TIMEOUT_MS) || 30 * 60 * 1000
const RUN_TIMEOUT_MS = Number(process.env.FLEET_RUN_TIMEOUT_MS) || 6 * 60 * 60 * 1000
// The run timeout is the run's time budget, met at a task boundary: past it, `dispatch.mjs next`
// renders no further task and the run ends itself (BUILDER_RUN_DEADLINE). The kill waits this much
// longer — enough for a slow implementer already in flight (an iPhone task took 90 minutes) to land.
// A third of the budget, at most 2 hours: 2 hours on the default 6.
const RUN_GRACE_MS = Number(process.env.FLEET_RUN_GRACE_MS) || Math.min(2 * 60 * 60 * 1000, Math.round(RUN_TIMEOUT_MS / 3))
const CLAUDE = process.env.FLEET_CLAUDE || 'claude'
const SMOKE_TIMEOUT_MS = Number(process.env.FLEET_SMOKE_TIMEOUT_MS) || 5 * 60 * 1000
const SMOKE_INTERVAL_MS = Number(process.env.FLEET_SMOKE_INTERVAL_MS) || 2000
const SMOKE_ATTEMPT_MS = 10 * 1000 // one probe that hangs (a half-up server) must not stall the poll
const START_GRACE_MS = 10 * 1000 // `start` with no `smoke`: give it this long, then walk
const KILL_GRACE_MS = 5 * 1000 // SIGTERM, then SIGKILL if the group is still there

const argv = process.argv.slice(2)
const USAGE = 'Usage: fleet.mjs <feature|path>… | --all [--parallel N] [--into <branch>] [--detach] [--dry-run] [--status [--archived [N]]] | --wait | --pause <feature>   (named while a fleet runs: added to its queue) | --land <feature> --commit-mine "<message>" | --set-aside   (a landing parked on your uncommitted changes: commit them first, or set them aside and put them back) | <feature>… --rewalk-by-agents   (a feature you signed off whose code changed since: agents walk it again and sign off in your place)'
const KNOWN_FLAGS = new Set(['--all', '--parallel', '--into', '--detach', '--dry-run', '--status', '--wait', '--archived', '--pause', '--no-env-check', '--land', '--commit-mine', '--set-aside', '--rewalk-by-agents'])
for (const [i, a] of argv.entries()) {
  if (argv[i - 1] === '--commit-mine') continue // the message, whatever it starts with
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
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--parallel', '--archived', '--into', '--pause', '--land', '--commit-mine'].includes(argv[i - 1]))
/**
 * A feature name the fleet can take: letters, digits, ".", "-" and "_" only (never all dots). The name
 * becomes a branch, a worktree folder, a log file and a `{feature}` filled into shell hooks, so anything
 * else is refused before it reaches one of them.
 */
const SAFE_NAME = /^(?!\.+$)[A-Za-z0-9._-]+$/
const nameRefusal = (n) => `"${n}" isn't a feature name the fleet can take — a name uses only letters, digits, ".", "-" and "_" (rename its folder to one that does)`

/**
 * `--land <feature> --commit-mine "<message>" | --set-aside` — the choices a landing parked on the
 * user's uncommitted changes offers (D3), done for them: commit those changes first, or set them aside
 * in a named stash and put them back after; then the feature lands by the fleet's own path (landNow).
 * Exit 0: landed and your changes are where you left them · 1: something is left for you (said how)
 * · 2: refused, nothing touched · 3: a fleet is running.
 */
const LAND = flag('--land') ? { feature: opt('--land'), mode: flag('--commit-mine') ? 'commit-mine' : 'set-aside', message: opt('--commit-mine') } : null
const refuseLand = (why, code = 2, usage = false) => {
  console.error(`${why} — nothing was changed.${usage ? ` ${USAGE}` : ''}`)
  process.exit(code)
}
if (LAND) {
  if (!LAND.feature || LAND.feature.startsWith('--') || /[/\\]|\.\./.test(LAND.feature)) refuseLand(`--land needs a feature name (no slashes)`, 2, true)
  if (!SAFE_NAME.test(LAND.feature)) refuseLand(nameRefusal(LAND.feature))
  if (flag('--commit-mine') === flag('--set-aside')) refuseLand(`--land takes one of --commit-mine "<message>" or --set-aside`, 2, true)
  if (LAND.mode === 'commit-mine' && !(LAND.message ?? '').trim()) refuseLand(`--commit-mine needs the message to commit your changes with`, 2, true)
  const extra = [...['--all', '--dry-run', '--detach', '--status', '--wait', '--archived', '--pause', '--parallel'].filter(flag), ...positional]
  if (extra.length) refuseLand(`--land lands one parked feature on its own; it takes no ${extra.join(', ')}`, 2, true)
} else if (flag('--commit-mine') || flag('--set-aside')) refuseLand(`--commit-mine and --set-aside go with --land <feature>`, 2, true)
/** A landing parked on the user's uncommitted changes — and the words a 5.x fleet row used for it. */
const LAND_PARK = /^needs you: your uncommitted changes overlap|uncommitted changes are in the way/

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
const folderOf = (feature) => `${CFG.registry}/${feature}`
// The table's Tests before the fleet has noted a row's facts: what its manifest's test plan reads as.
const testsOf = (feature, f) => {
  const p = join(specDir(f.worktree && existsSync(f.worktree) ? f.worktree : ROOT, CFG.registry, feature), 'MANIFEST.md')
  return existsSync(p) ? parseTestPlan(parseManifest(readFileSync(p, 'utf8'))).label : null
}

if (flag('--status') || flag('--archived') || flag('--wait')) {
  // --wait: block, silent, until no live fleet holds the lock — or until a feature parks or fails
  // while the rest run on, since it waits on a person from that moment — then the status, as
  // --status prints it. A mid-run stop is named first, on a `⛔ waiting on you:` line: the session
  // raises its choices and starts the watcher again. A fleet just launched may not hold its lock
  // yet: give it a grace to appear.
  if (flag('--wait')) {
    const { parked } = await waitForFleet(ROOT, { pollMs: Number(process.env.FLEET_WAIT_POLL_MS) || 20000, graceMs: process.env.FLEET_WAIT_GRACE_MS !== undefined ? Number(process.env.FLEET_WAIT_GRACE_MS) : 15000, stopped: stoppedNames })
    if (parked.length) console.log(`⛔ waiting on you: ${parked.join(', ')} — the fleet runs on with the rest; raise each one's choices, then start this watcher again\n`)
  }
  const fleet = existsSync(join(DIR, 'fleet.json')) ? loadFleet(ROOT) : null
  // Opening the status is seeing what landed: the status line and the brief stop announcing it.
  // --wait is a watcher, not a person looking: an overnight finish stays on the line until it is opened.
  if (!flag('--wait')) markSeen(ROOT)
  if (flag('--archived')) console.log(renderArchived(tailArchive(ROOT, Number(archivedVal) || 20), fleet?.archived ?? 0))
  else {
    console.log(fleet ? renderStatus(fleet, progressOf, tailArchive(ROOT, 1)[0] ?? null, Date.now(), tailArchive(ROOT, 5), testsOf, folderOf, fleetAlive(ROOT)) : 'No fleet has run in this repo yet.')
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
    console.error(`--pause needs a feature name (no slashes)`, 2, true)
    process.exit(2)
  }
  if (!SAFE_NAME.test(name)) {
    console.error(`${nameRefusal(name)} — nothing was paused.`)
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
// D14: a test database per worktree. agent_walk.test_db_env names the variable that holds the
// database URL; each worktree (and the walk and env-check ones) gets its own database on
// verify.db's server — the configured test server, never whatever the launching shell's variable
// points at — created and migrated when the worktree is made and dropped when it goes; the reaper
// drops any of this checkout's that outlived its worktree (tidy, a killed fleet). With a verify.db
// and no isolation, builds in parallel would share the verifier's test database: one at a time.
const VERIFY = loadVerify(ROOT)
const VERIFY_DB = VERIFY.ok ? VERIFY.verify.db : null
if (AW.testDbEnv && !VERIFY_DB) {
  console.error(`agent_walk.test_db_env: ${AW.testDbEnv} needs a verify.db (kind postgres, with a url) — the fleet makes each worktree's database on that server. ${VERIFY.ok || /has no verify: block/.test(VERIFY.reason) ? 'Add verify.db, or remove test_db_env.' : `The verify: block does not load: ${VERIFY.reason}`}`)
  process.exit(2)
}
// The checkout's identity in its lane database names: the machine and the path — two machines with
// the checkout at one path (devcontainers, CI runners) on one server never share, or reap, a name.
const DB_ROOT = `${hostname()}:${ROOT}`
const DB_URL = AW.testDbEnv ? VERIFY_DB.url : null
/** Text that may hold the server URL, its password replaced (envpool's redact). */
const quiet = (text) => (DB_URL ? redact(DB_URL, String(text)) : String(text))
const ASKED_PARALLEL = Number(opt('--parallel')) || null
const WANT_PARALLEL = ASKED_PARALLEL || AW.parallel
const SHARED_DB = Boolean(VERIFY_DB) && !isolated(AW) && WANT_PARALLEL > 1
const PARALLEL = SHARED_DB ? 1 : WANT_PARALLEL
// D15: files a build regenerates (lockfiles, snapshots) — regenerated at a merge, never hand-merged.
const GEN = CFG.generated ?? { paths: [], command: null }
const SHARED_DB_NOTE = `parallel 1${ASKED_PARALLEL ? ` (asked ${ASKED_PARALLEL})` : ''}: the verifier's test database is shared — set agent_walk.test_db_env (or a {feature} database in worktree_env) to build in parallel`
const WORKTREES = AW.worktrees ? resolve(ROOT, AW.worktrees) : join(dirname(ROOT), `${basename(ROOT)}.fleet`)
// Batched walks: with a walk env of its own (agent_walk.start), the walk lane takes every feature
// waiting to walk — up to agent_walk.batch — into one combined walk branch, one env, one walker.
const BATCH = Number(process.env.FLEET_WALK_BATCH) || AW.batch
const BATCHED = Boolean(AW.start) && BATCH > 1
// With a walk env of the fleet's own (agent_walk.start), the walk lane holds only what needs it —
// readiness and the walk. Verify and a walk's fixes run in the parallel pool, away
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
/** `--rewalk-by-agents`: the named features' human sign-off may be replaced by an agent re-walk (the person's choice). */
const REWALK_BY_AGENTS = new Set(flag('--rewalk-by-agents') ? positional.map(nameOf) : [])

function requested() {
  if (!flag('--all')) {
    const names = positional.map(nameOf)
    const bad = names.find((n) => !SAFE_NAME.test(n))
    if (bad != null) {
      console.error(`${nameRefusal(bad)} — nothing was started.`)
      process.exit(2)
    }
    return names
  }
  const all = features(ROOT, CFG.registry)
  const bad = all.filter((n) => !SAFE_NAME.test(n))
  if (bad.length) console.error(`--all left out ${bad.length} folder${bad.length === 1 ? '' : 's'} whose name${bad.length === 1 ? '' : 's'} the fleet can't take: ${bad.map((n) => `"${n}"`).join(', ')} — a name uses only letters, digits, ".", "-" and "_"; rename ${bad.length === 1 ? 'it' : 'them'} to run ${bad.length === 1 ? 'it' : 'them'}`)
  return all.filter((n) => SAFE_NAME.test(n)).filter((n) => {
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
 * lane and `setup` never see `env`: build lanes run while a walk is up, and pointing them at the
 * walk env's ports and database would collide with it.
 */
function envFor(feature, lane) {
  const env = { ...process.env }
  // worktree_env first, every lane: it is how each worktree's tests get their own database, which
  // is what lets `parallel` builds share a machine without sharing a test DB.
  for (const [k, v] of Object.entries(AW.worktreeEnv)) env[k] = fill(v, feature)
  // test_db_env after it: the lane's own database (D14). The walk lane's agent_walk.env, after this,
  // still wins for a key it sets — that is the walk env's dev server, which it names on purpose.
  if (DB_URL) env[AW.testDbEnv] = laneDbUrl(DB_URL, laneDb(feature))
  if (lane === 'walk') for (const [k, v] of Object.entries(AW.env)) env[k] = fill(v, feature)
  // Deleted AFTER the merge: agent_walk.env accepts any key, and letting it put this one back
  // would point every child at one fixed checkout — the bug the delete exists to prevent.
  delete env.CLAUDE_PROJECT_DIR
  // Set after it for the same reason: a run's cwd is its worktree, beside the repo, so the skills'
  // pause check (`$BUILDER_FLEET_DIR/requests/<feature>.pause`) needs the main checkout's fleet dir.
  env.BUILDER_FLEET_DIR = DIR
  // The builder root, so the skills' `<builder>/scripts/…` needs no resolving (and no `B=…;` prefix).
  env.BUILDER_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
  // Where this run lands (--into): every verifier request an agent files — commit, phase, the quick
  // check's merge — compares against it (verify/target.mjs), not merge_into.
  env.BUILDER_TARGET = TARGET
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

/** A config command with this feature's name filled in for {feature} — the one place every agent_walk hook gets it. */
const fill = (cmd, feature) => cmd.replaceAll('{feature}', feature)

/** agent_walk.setup in a new worktree ({feature} filled in), output to logs/<feature>-setup.log. Throws, naming the log, on failure. */
function runSetup(feature, wt) {
  const log = join(DIR, 'logs', `${feature}-setup.log`)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  try {
    execSync(fill(AW.setup, feature), { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    throw Object.assign(new Error(`setup failed — see ${log}`), { setup: true })
  } finally {
    closeSync(fd)
  }
}

/** The lane database's name for a worktree (D14): `<base>_ln_<root hash6>_<feature>_<hash8>`. */
const laneDb = (feature) => laneDbName({ base: dbBaseOf(DB_URL), root: DB_ROOT, feature })
const lanePlan = (feature) => laneDbPlan({ verifyDb: VERIFY_DB, url: DB_URL, name: feature ? laneDb(feature) : null, testDbEnv: AW.testDbEnv, root: DB_ROOT })
/**
 * What a worktree's lane database was made from: its name, the server (no password), and the tree of
 * verify.db.inputs (the migrations) at the worktree's HEAD. The row keeps it (f.laneDb); a key that
 * differs at a run's start — a merge brought migrations, the server moved — makes the database again.
 */
function laneDbKey(feature, wt) {
  const inputs = VERIFY_DB?.inputs?.length ? tryGit(['ls-tree', '-r', 'HEAD', '--', ...VERIFY_DB.inputs], wt) ?? '' : ''
  return createHash('sha1').update(`${laneDb(feature)}\0${quiet(DB_URL)}\0${inputs}`).digest('hex').slice(0, 12)
}
/** The feature's lane database in `wt`, made again when its key moved (laneDbKey). Throws a setup-style error. */
function ensureLaneDb(feature, f, wt = f.worktree) {
  if (!DB_URL || !wt || !existsSync(wt)) return
  const key = laneDbKey(feature, wt)
  if (f.laneDb === key) return
  prepareLaneDb(feature, wt)
  f.laneDb = key
  save()
}
/**
 * Drop, create and migrate the lane database for a worktree (D14) — dropped first, so one a killed
 * fleet left behind starts clean, and a worktree whose branch moved (the walk tree's next batch) is
 * migrated from nothing. The migrate gets the lane URL through its env (migrateEnv). → the steps, each
 * [command, opts]; prepareLaneDb runs them blocking, prepareLaneDbAsync off the event loop. Both log
 * to logs/<feature>-db.log and throw a setup-style error.
 */
function laneDbSteps(feature, wt) {
  if (!DB_URL) return []
  const plan = lanePlan(feature)
  return [[plan.drop, {}], [plan.create, {}], [plan.migrate, plan.migrateEnv]].filter(([c]) => c).map(([cmd, extra]) => [cmd, { cwd: wt, env: { ...envFor(feature, 'build'), ...extra } }])
}
const laneDbLog = (feature) => {
  const log = join(DIR, 'logs', `${feature}-db.log`)
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, '')
  return log
}
const laneDbFailed = (feature, log) => Object.assign(new Error(`the test database ${laneDb(feature)} could not be made — see ${log}`), { setup: true })
const shRun = (cmd, opts) => {
  try {
    return { status: 0, output: execSync(cmd, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60 * 1000 }) }
  } catch (e) {
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? e.message}` }
  }
}
/** A feature's or the walk tree's. Blocking, as setup and sync are: the other lanes wait on the event loop meanwhile. */
function prepareLaneDb(feature, wt) {
  const steps = laneDbSteps(feature, wt)
  if (!steps.length) return
  const log = laneDbLog(feature)
  for (const [cmd, opts] of steps) {
    const r = shRun(cmd, opts)
    appendFileSync(log, quiet(r.output))
    if (r.status !== 0) throw laneDbFailed(feature, log)
  }
}
/** The env check's: the lanes run while it does. */
async function prepareLaneDbAsync(feature, wt) {
  const steps = laneDbSteps(feature, wt)
  if (!steps.length) return
  const log = laneDbLog(feature)
  for (const [cmd, opts] of steps) {
    const r = await execAsync('sh', ['-c', cmd], opts)
    appendFileSync(log, quiet(r.output))
    if (r.status !== 0) throw laneDbFailed(feature, log)
  }
}
/** Drop a worktree's lane database (D14), once its worktree is gone. Best effort: a note when it fails. */
function dropLaneDb(feature) {
  const { drop } = DB_URL ? lanePlan(feature) : {}
  if (!drop) return
  const r = shRun(drop, { cwd: ROOT })
  if (r.status !== 0) addNote(`the test database ${laneDb(feature)} could not be dropped — drop it by hand: ${quiet(drop)}`)
}
/**
 * Drop every lane database this checkout made whose worktree is gone — one tidy removed, a killed
 * fleet left, a kept worktree someone deleted. Run when the fleet starts and when it ends; a name
 * belongs to a worktree when a folder of WORKTREES has it (feature worktrees, _walk, _envcheck).
 */
function reapLaneDbs() {
  const { list } = DB_URL ? lanePlan(null) : {}
  if (!list) return
  const r = shRun(list, { cwd: ROOT })
  if (r.status !== 0) return addNote(`the fleet could not list its test databases to drop the stale ones: ${quiet(r.output.trim().split('\n').pop())}`)
  const live = new Set((existsSync(WORKTREES) ? readdirSync(WORKTREES) : []).map(laneDb))
  for (const name of r.output.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (live.has(name)) continue
    const { drop } = laneDbPlan({ verifyDb: VERIFY_DB, url: DB_URL, name })
    if (shRun(drop, { cwd: ROOT }).status !== 0) addNote(`the stale test database ${name} could not be dropped — drop it by hand: ${quiet(drop)}`)
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
    // A new worktree's database is made new too, whatever the row recorded (laneDb below).
    delete f.laneDb
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
  // After setup: migrating needs what setup installs. The row keeps what its database was made from,
  // so a reused worktree with none (from before test_db_env, kept from a park) gets one here too.
  ensureLaneDb(feature, f, wt)
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
  const outStart = statSync(join(DIR, 'fleet.out')).size
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], {
    cwd: process.cwd(),
    env: process.env,
    detached: true, // setsid: a new session and process group
    stdio: ['ignore', outFd, outFd],
  })
  child.unref()
  // Print only once the child holds the lock (or has exited): the line is what the watcher and the
  // status line go by, and a fleet with no lock yet reads as "no fleet running".
  let exited = null
  child.on('exit', (code, signal) => (exited = { code, signal }))
  const deadline = Date.now() + (process.env.FLEET_DETACH_WAIT_MS !== undefined ? Number(process.env.FLEET_DETACH_WAIT_MS) : 30000)
  const holds = () => {
    try {
      return readFileSync(LOCK, 'utf8').trim() === String(child.pid)
    } catch {
      return false
    }
  }
  while (!exited && !holds() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (exited && !holds()) {
    const out = readFileSync(join(DIR, 'fleet.out'), 'utf8').slice(outStart).trim().split('\n').slice(-20).join('\n')
    console.log(`fleet exited at once (${exited.signal ?? `code ${exited.code}`}) — output in .builder/fleet/fleet.out:\n${out}`)
    process.exit(exited.code || 1)
  }
  const awake = keepAwakeArgs({ platform: process.platform, env: process.env, pid: child.pid }) ? ' · kept awake by caffeinate until it ends' : ''
  console.log(`fleet started detached (pid ${child.pid}) — output in .builder/fleet/fleet.out · /builder:fleet:status${awake}`)
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
// --land: before the target is resolved — the row lands where its fleet lands.
if (LAND) {
  const row = Object.hasOwn(fleet.features, LAND.feature) ? fleet.features[LAND.feature] : null
  if (runningPid) {
    console.error(`A fleet is running in this repo (pid ${runningPid}), so ${LAND.feature} can't land now — nothing was changed. When the run ends, choose again from /builder:fleet:status.`)
    process.exit(3)
  }
  if (!row) refuseLand(`${LAND.feature} isn't in this fleet`)
  if (row.status !== 'parked' || !LAND_PARK.test(row.reason ?? '')) refuseLand(`${LAND.feature} isn't parked waiting on your uncommitted changes (it is ${row.status}${row.reason ? `: ${parkParts(row.reason).why}` : ''})`)
}
const TARGET = opt('--into') ?? ((LAND && fleet.target) || CFG.mergeInto)
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

// --land: your changes are in the target's checkout, here, and nothing half-done is in the way.
if (LAND) {
  const here = tryGit(['branch', '--show-current'])
  if (here !== TARGET) refuseLand(`This checkout is on ${here || 'a detached HEAD'}, not ${TARGET}, which ${LAND.feature} lands on — switch back to ${TARGET} (where your changes were in the way) and run this again; with nothing in the way, /builder:fleet ${LAND.feature} lands it`)
  const busy = [['MERGE_HEAD', 'a merge'], ['REBASE_HEAD', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']].find(([ref]) => tryGit(['rev-parse', '-q', '--verify', ref]) !== null)
  if (busy) refuseLand(`${busy[1]} is in progress in this checkout — finish or abort it, then run this again`)
  const unmerged = tryGit(['diff', '--name-only', '--diff-filter=U'])
  if (unmerged) refuseLand(`This checkout has unresolved conflicts (${unmerged.split('\n').join(', ')}) — resolve them, then run this again`)
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
  if (landed.has(dep)) return true
  // Archived on the target — unless /builder:archive dropped it: a dropped feature built nothing to wait for.
  const at = `${TARGET}:${CFG.registry}/${ARCHIVE}/${dep}`
  if (tryGit(['cat-file', '-e', at]) === null) return false
  const head = (tryGit(['show', `${at}/SPEC.md`]) ?? tryGit(['show', `${at}/PROGRAM.md`]) ?? '').slice(0, 800)
  return !/^> ✖ DROPPED/m.test(head)
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
const after = {} // feature → the dependencies it waits for to merge
// Group lanes (D4): a program child whose dependency is in this run joins that dependency's group —
// it plans beside it, stacks on its built branch and lands after it — instead of waiting for it to
// merge. Only a dependency nothing here will build is still waited for (and that is refused below).
const joins = {} // feature → the dependencies in this run whose group it joins
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
  const dropped = outside.filter((d) => d.state === 'dropped')
  if (!why && dropped.length) why = `${waitsOnText(dropped)} — it will never ship: take it out of this child's "Depends on" in its program's PROGRAM.md §Children (or drop this child too)`
  else if (!why && outside.length) why = `${waitsOnText(outside)} — not in this run, so nothing here will ship it`
  if (why) refused[feature] = why
  else {
    fresh.push(feature)
    branchOwner.set(branch, feature)
    const inside = waits.filter((d) => inRun.has(d.name)).map((d) => d.name)
    const rest = waits.filter((d) => !inRun.has(d.name)).map((d) => d.name)
    if (inside.length) joins[feature] = inside
    if (rest.length) after[feature] = rest
  }
}
// A dependency refused above can't ship either — its waiters, and the dependents joining it, go with it.
const depsOf = (x) => [...(after[x] ?? []), ...(joins[x] ?? [])]
for (let changed = true; changed; ) {
  changed = false
  for (const f of fresh.filter((x) => depsOf(x).some((d) => refused[d]))) {
    refused[f] = `waits on ${depsOf(f).filter((d) => refused[d]).join(', ')}, which can't run`
    fresh.splice(fresh.indexOf(f), 1)
    changed = true
  }
}

if (flag('--dry-run')) {
  console.log('builder fleet — plan (nothing created)')
  console.log(`  merges into: ${TARGET} (${TARGET_FROM}) — one merge commit per finished feature; nothing is pushed`)
  console.log(`  worktrees:   ${WORKTREES}`)
  console.log(`  permissions: claude ${AW.claudeArgs}`)
  if (SHARED_DB && !runningPid) console.log(`  ${SHARED_DB_NOTE}`)
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: ${BATCHED ? `up to ${BATCH} features per walk — one env, one walker` : 'one at a time'}${SPLIT ? ' · the quick check and walk fixes in the build lane, away from the walk env' : ''}`)
  if (runningPid) console.log(`  adds to the running fleet (pid ${runningPid}) — each is picked up when a lane frees; its --parallel stands`)
  for (const f of fresh) {
    const mf = parseManifest(readManifest(ROOT, f))
    const unparks = isSet(mf.blocked) ? ` — unparks it — it was parked: ${parkParts(mf.blocked).why}` : ''
    const joined = joins[f] ? ` — ${joins[f].map((d) => `${f} joins ${d}'s group (declared: Depends on ${d})`).join('; ')}` : ''
    console.log(`  ${after[f] ? '⏳' : '✓'} ${f} → ${branchOf(f, mf)}${after[f] ? `, once ${after[f].join(', ')} merge${after[f].length > 1 ? '' : 's'}` : ''}${joined}${unparks}`)
  }
  for (const [f, why] of Object.entries(refused)) console.log(`  ✗ ${f} — ${why}`)
  // D3/D16: the groups these specs (and the rows already in the fleet) form, each with why its
  // members overlap — read from their plans here, nothing written.
  if (!runningPid) {
    const names = [...new Set([...Object.keys(fleet.features).filter((n) => fleet.features[n].status !== 'done'), ...fresh])]
    const fp = new Map(names.map((n) => {
      // baseOf is defined further down (a const): the row's worktree when it has one, inline.
      const wt = fleet.features[n]?.worktree
      const plan = readDoc(wt && existsSync(wt) ? wt : ROOT, n, 'PLAN.md')
      return [n, plan != null ? footprintOf(plan, { generated: GEN.paths }) : null]
    }))
    const depsOf = (n) => [...(fleet.features[n]?.dependsOn ?? []), ...(joins[n] ?? [])].filter((d) => names.includes(d))
    for (const g of groupsOf(names.map((n) => ({ name: n, footprint: fp.get(n), dependsOn: depsOf(n) })), { max: AW.groupMax, fleetOrder: names }).filter((x) => x.members.length > 1 || x.waitsOn)) {
      const why = g.members.slice(1).map((m, i) => {
        const prev = g.members[i]
        const o = overlapOf(fp.get(prev), fp.get(m), { declared: depsOf(m).includes(prev) || depsOf(prev).includes(m) })
        const parts = o ? [o.declared && 'declared', o.paths.length && `share ${o.paths.slice(0, 2).join(', ')}${o.paths.length > 2 ? '…' : ''}`, o.interfaces.length && `interface ${o.interfaces.slice(0, 2).join(', ')}`].filter(Boolean) : ['overlap through the others']
        return `${prev} → ${m}: ${parts.join(', ')}`
      })
      console.log(`  group ${g.id}: ${g.members.join(' → ')} — one lane, built in this order, landed as one${g.waitsOn ? `, after group ${g.waitsOn} (group_max ${AW.groupMax})` : ''}${why.length ? ` (${why.join('; ')})` : ''}`)
    }
  }
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
      // waitsOn still lists the joined dependencies too: a running fleet from before group lanes reads
      // only it, and waits for them to merge. This release's fleet takes dependsOn out of it.
      writeFileSync(join(INBOX, f), JSON.stringify({ waitsOn: [...(after[f] ?? []), ...(joins[f] ?? [])], dependsOn: joins[f] ?? [] }) + '\n', { flag: 'wx' })
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
const save = () => saveFleet(ROOT, fleet, progressOf, testsOf, folderOf)

// A new run's status is about this run: an earlier run's notes go — a live set-aside conflict stays,
// and what the wrap-up still acts on moves to fleet.wrapNotes (carryNotes). A --land, or a fleet
// that took over a dead one's lock (the same run, carried on), keeps them.
if (!tookOverStaleLock && !LAND) Object.assign(fleet, carryNotes(fleet, ROOT))
// F1: the fleet holds its lock, so it is the one running — keep the Mac awake until it ends. Not for
// --land (one landing, then it exits); --dry-run, --status, --wait, --pause and adding to a running
// fleet have exited by now. caffeinate -w ends with this process, whatever ends it. A note an earlier
// fleet left (stopped, killed) goes first: only this run's says whether the Mac is kept awake. By its
// path, so a PATH without /usr/bin never breaks the launch line's promise.
fleet.notes = withoutAwake(fleet.notes)
const awakeArgs = LAND ? null : keepAwakeArgs({ platform: process.platform, env: process.env, pid: process.pid })
if (awakeArgs) {
  const unavailable = () => {
    fleet.notes = withoutAwake(fleet.notes)
    addNote(AWAKE_UNAVAILABLE)
  }
  try {
    const c = spawn('/usr/bin/caffeinate', awakeArgs, { detached: true, stdio: 'ignore' })
    c.on('error', unavailable)
    c.unref()
    addNote(AWAKE_NOTE)
  } catch {
    unavailable()
  }
}
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
  // caffeinate -w ends with this process: nothing keeps the Mac awake once it has exited.
  fleet.notes = withoutAwake(fleet.notes)
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
if (!tookOverStaleLock && !LAND) fleet.landedThisRun = []
for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'done') archiveRow(feature, null, tookOverStaleLock)
pruneArchivedLogs(ROOT, AW.keepLogs)

fleet.target = TARGET
for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null, unpark: true, ...(after[f] && { waitsOn: after[f] }), ...(joins[f] && { dependsOn: joins[f] }) }
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

/** A feature's manifest `state:` and `go-ahead:` — from its worktree, the main tree before the worktree has it. */
const manifestOf = (wt, feature) => {
  const text = readManifest(wt, feature) ?? readManifest(ROOT, feature)
  return text == null ? {} : parseManifest(text)
}

async function runClaude(wt, feature, lane, n, prompt = buildLanePrompt(manifestOf(wt, feature).state ?? null, { goAhead: manifestOf(wt, feature)['go-ahead'], specText: readSpec(wt, feature) ?? readSpec(ROOT, feature), spec: specOf(feature), target: TARGET, walkLane: lane === 'walk', split: SPLIT, prior: priorPark(fleet.features[feature]) }), rec = fleet.features[feature]) {
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
    env.BUILDER_RUN_DEADLINE = new Date(t0 + RUN_TIMEOUT_MS).toISOString()
    let result = null // the last `result` event: { duration_ms, num_turns }
    const meter = streamMeter() // per-dispatch turns and context, from the stream as it streams
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
      // Time, turns and tokens per run: Claude's own result event — or, for a run killed before it sent
      // one, wall-clock and what the stream carried (turns and tokens counted, the cost left unknown).
      const timing = rec.timing ?? (rec.timing = [])
      // start/end are wall-clock, for the stage timeline (queueing, parks); ms is the run's own time.
      timing.push({ n, lane: lane === 'walk' ? 'walk' : 'build', ms: result?.duration_ms ?? Date.now() - t0, start: new Date(t0).toISOString(), end: new Date().toISOString(), turns: result?.num_turns ?? (result ? null : meter.summary().orchestrator.turns || null), tokens: result ? tokensOf(result) : meter.tokens(), meter: meter.summary() })
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
        try {
          meter.add(JSON.parse(line))
        } catch {}
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
    const timer = setTimeout(kill, RUN_TIMEOUT_MS + RUN_GRACE_MS, `still running after ${mins(RUN_TIMEOUT_MS + RUN_GRACE_MS)} (the run timeout)`)
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
  f.facts = { size: plan == null ? (f.facts?.size ?? null) : planSize(plan), ...planFacts(parseManifest(mf)), verify: verifyCheck(parseManifest(mf).verify), walk: readWalkFacts(f.worktree, feature) ?? f.facts?.walk ?? null, review: readReviewFacts(f.worktree, feature) ?? f.facts?.review ?? null }
}

/** The final review's findings and the fix rounds, from the workspace (reviewFacts) — null before the build reviewed anything. */
function readReviewFacts(worktree, feature) {
  const ws = join(worktree, '.builder', feature)
  const txt = (name) => (existsSync(join(ws, name)) ? readFileSync(join(ws, name), 'utf8') : null)
  return reviewFacts({ finalReview: txt('final-review.md'), ledger: txt('progress.md') })
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
  return { size: plan == null ? null : planSize(plan), ...planFacts(mf == null ? {} : parseManifest(mf)), verify: mf == null ? null : verifyCheck(parseManifest(mf).verify) }
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

/** A landed feature leaves fleet.json: one line in archive.jsonl, its logs under logs/_archive/. */
function archiveRow(feature, facts, thisRun = true) {
  clearPause(feature)
  const f = fleet.features[feature]
  const { size, tests, profile, walk, verify } = facts ?? landingFacts(f, feature)
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
    // tokens: the orchestrators' own threads (tokensOf); costUsd and the meter cover every agent.
    tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheCreation: sum('cacheCreation') },
    costUsd: sum('costUsd'),
    ...meterTotals(f.timing),
    quality: f.facts?.review ?? null,
    ...wallFacts(f.stages, f.timing),
    walk: walk ?? f.facts?.walk ?? null,
    // which check it had after sign-off (verifyCheck): verified · quick-checked · not verified
    verify: verify ?? f.facts?.verify ?? null,
    landedAt: new Date().toISOString(),
  })
  delete fleet.features[feature]
  // A landing park's record (recordOf) has nothing left to say.
  rmSync(join(DIR, 'parked', feature), { recursive: true, force: true })
  fleet.archived = (fleet.archived ?? 0) + 1
  if (thisRun) fleet.landedThisRun = [...new Set([...(fleet.landedThisRun ?? []), feature])]
  if (thisRun) desktopNotify(landNotice({ feature, target: fleet.target ?? TARGET, repo: basename(ROOT) }))
  landed.add(feature)
  const why = archiveLogs(ROOT, feature, AW.keepLogs)
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
  // Landed already, with its group (landGroup), while this landing waited its turn.
  if (!f || f.status === 'done') return 'done'
  // No member lands alone (D9): a group lands as one, through its tip. A group of one lands as before.
  const g = groupOf(feature)
  const live = g ? liveMembers(g) : []
  if (live.length > 1) return landGroup(feature, g, live)
  // A revision asked for before the merge parks it here: once merged, revise has nothing to change.
  if (parkIfPaused(f, feature)) return 'parked'
  const facts = landingPrep(feature, f)
  if (tryGit(['merge-base', '--is-ancestor', f.branch, TARGET]) === null) {
    // The config is the human's: a branch that changes it never lands it unseen.
    const why = configChanged(f) ?? (await mergeThroughVerifier(feature, f))
    if (why?.files) return walkAgain(feature, f, why)
    if (why?.red) return park(f, why.reason)
    if (why) return park(f, why)
  }
  return finishLanding(feature, facts)
}

/**
 * D15: agent_walk.after_land in the main checkout, once per merge into the target (a group's one merge
 * runs it once) — to regenerate or reinstall there. Its output to logs/after-land.log; a failure is a note.
 */
function afterLand(feature) {
  if (!AW.afterLand) return
  const log = join(DIR, 'logs', 'after-land.log')
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  try {
    // The user's checkout and its own env — never a worktree's (worktree_env, its lane database).
    const env = { ...process.env }
    delete env.CLAUDE_PROJECT_DIR
    execSync(fill(AW.afterLand, feature), { cwd: ROOT, env, stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    addNote(`agent_walk.after_land failed after ${feature} landed — see ${log}`)
  } finally {
    closeSync(fd)
  }
}

/** The config is the human's: a branch that changes it never lands it unseen. → the park reason, or null. */
function configChanged(f) {
  const cfgDiff = tryGit(['diff', '--stat', `refs/heads/${TARGET}...${f.branch}`, '--', CONFIG_PATH])
  return cfgDiff ? PARK_REASONS.config(TARGET, f.branch, CONFIG_PATH) : null
}

/**
 * What the landing records, read before the merge: once the branch is in the target and deleted, its
 * own commits (the stage timeline) and its manifest are out of reach. → the facts for its archive row.
 */
function landingPrep(feature, f) {
  noteFacts(f, feature)
  const facts = landingFacts(f, feature)
  // No manifest reading carried the check (an older fleet.json): the SHIPPED header names it.
  if (facts.verify == null) facts.verify = /^> ✅ SHIPPED .* · (verified|quick-checked|not verified)\s*$/m.exec(readSpec(f.worktree, feature) ?? '')?.[1] ?? null
  noteStages(f, feature)
  f.pr = shippedPr(readSpec(f.worktree, feature))
  if (f.pr && !/^#/.test(f.pr)) f.pr = null
  return facts
}

/** The feature is in the target: its row is done, its worktree and branch go, and it gets its archive row. */
function finishLanding(feature, facts) {
  const f = fleet.features[feature]
  Object.assign(f, { status: 'done', reason: null, merged: tryGit(['rev-parse', '--short', TARGET]) })
  // Nothing is left behind: test output in the worktree is restored, any other uncommitted change
  // is stashed by name, the worktree goes, and so does the branch — whoever made it — once it is in
  // the target (`-d` refuses one that isn't).
  if (f.worktree) {
    // FLEET_KEEP_WORKSPACES=1 (a benchmark run) keeps the build workspace — ledger, reviews, walk
    // reports — in .builder/kept/<feature>, as a parked feature's is: the run's evidence
    const r = clearWorktree(ROOT, f.worktree, feature, { keep: process.env.FLEET_KEEP_WORKSPACES === '1' })
    if (r.stash) addNote(`${feature} merged; uncommitted changes from its worktree are in stash "${r.stash}" — git stash list`)
    if (r.removed || !existsSync(f.worktree)) {
      f.worktree = null
      dropLaneDb(feature)
      delete f.laneDb
    } else addNote(`${feature} merged; its worktree ${f.worktree} stays: ${r.why} — /builder:tidy removes it once that's settled`)
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
 * Land through the verifier's merge queue: the held merge-tier run requested when the walk began.
 * Sign-off, verify and the ship commit only touch the registry after it, so that result carries
 * (verify.mjs carry) — no second run. A held run of exactly this HEAD is released; else, or when
 * code changed since the held run, a new one. Green → release (the target fast-forwards to the tested
 * merge commit). Conflict → an agent resolves it in the worktree, then a new request. A target that
 * moved since the run → run again. Red → park, naming the tests: verify read a green merge tier
 * before the ship, so red here means the code went red on a target that moved after it — the
 * folder is already archived, and the human decides. Null when landed; signoffMoved's record when
 * code changed since the sign-off (walkAgain); `{ red, reason }` when the merge tier went red (a
 * group bisects it); `{ gate }` when `gate` — asked right before anything lands, as a group's
 * landingGate is (D9) — names a reason not to; else a park reason.
 */
async function mergeThroughVerifier(feature, f, { message = mergeMessage([feature]), gate = null } = {}) {
  const here = tryGit(['branch', '--show-current'])
  if (here !== TARGET) {
    const elsewhere = (tryGit(['worktree', 'list', '--porcelain']) ?? '').split('\n\n').find((b) => b.includes(`\nbranch refs/heads/${TARGET}`))
    if (elsewhere) return PARK_REASONS.checkedOut(TARGET, elsewhere.split('\n')[0].replace(/^worktree /, ''), feature)
  }
  // The merge tier tests the branch as its worktree holds it; without one there is nothing to request on.
  if (!f.worktree || !existsSync(f.worktree)) return `shipped, but its worktree is gone, so the merge tier can't run on ${f.branch} — next: /builder:agent to recreate it and land it`
  // After the target moved: the migrations note, or the working tree's migrations applied. The
  // branch is read again now — the merge-tier wait takes minutes, and the human may have switched.
  const landed = (before, sha) => {
    const now = tryGit(['branch', '--show-current'])
    if (now === TARGET) {
      afterLand(feature)
      return migrateAfterLanding(feature, before, 'HEAD')
    }
    if (AW.afterLand) addNote(`agent_walk.after_land did not run after ${feature} landed: ${now || 'a detached HEAD'} is checked out here, not ${TARGET} — switch to ${TARGET} and run it yourself`)
    addNote(`${feature} merged into ${TARGET} while ${now || 'a detached HEAD'} was checked out here — switch to ${TARGET} to test it`)
    const added = newMigrations(before, sha)
    if (added.length) addNote(`${feature} brought ${added.length} new migration${added.length === 1 ? '' : 's'} to ${TARGET} — when you switch to it, apply them to the dev DB first (§Walk readiness \`apply:\`)`)
  }
  // D2: the user's uncommitted changes overlap the feature — the files go on the row for its record.
  const needsYou = (files) => {
    f.overlap = files
    return PARK_REASONS.overlap(files)
  }
  let gone = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    // What lands is what was signed off: a fix after a red merge tier, or a conflict an agent resolved, is walked again first.
    const moved = signoffMoved(feature, f)
    if (moved) return moved
    const head = tryGit(['rev-parse', 'HEAD'], f.worktree)
    // D15: the verifier tests the branch merged onto the target tip its run started on. When that tip
    // is not in the branch, the verifier merged changes in itself — two to one generated file would
    // land as a text merge nobody regenerated. Such a verdict neither carries nor releases: the branch
    // takes the target (mergeIn regenerates) and a new run tests what it holds.
    // Only when it matters: both the target since the branch forked and the branch changed a generated
    // path (mergeIn's rule) — any other movement merges there as cleanly as it would here.
    const genTouched = (a, b) => (tryGit(['diff', '--name-only', a, b], f.worktree) ?? '').split('\n').some((p) => p && isGenerated(p))
    const merged = (v) => {
      if (!GEN.command || !v?.targetSha || tryGit(['merge-base', '--is-ancestor', v.targetSha, 'HEAD'], f.worktree) !== null) return false
      const base = tryGit(['merge-base', 'HEAD', v.targetSha], f.worktree)
      return !base || (genTouched(base, v.targetSha) && genTouched(base, 'HEAD'))
    }
    let done = mergeVerdict(ROOT, f.branch, head, TARGET)
    if (merged(done)) done = null
    let held = done?.status === 'green' && done.held ? null : heldMerge(ROOT, f.branch, TARGET)
    if (merged(held)) held = null
    if (held) {
      const shut = gate?.()
      if (shut) return { gate: shut }
      const before = tryGit(['rev-parse', `refs/heads/${TARGET}`])
      const c = carryMerge(ROOT, held.request)
      if (c.ok) {
        landed(before, c.sha)
        return null
      }
      if (c.overlap) return needsYou(c.overlap)
      // Code changed since the held run, or the target moved (carry un-held it): a new run below.
      if (!c.moved && !c.codeChanged) return `the merge tier passed but landing failed: ${c.reason} — next: /builder:fleet to retry`
    }
    // D15: the verifier merges the target in its own checkout, where a clean merge of two changes to one
    // generated file lands a file generated.command never made. The branch takes the target first —
    // mergeIn regenerates there — so what the verifier merges and tests is the branch's own tree.
    if (GEN.command && !(done?.status === 'green' && done.held) && tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], f.worktree) === null) {
      const why = await syncTarget(f.worktree, 'features that merged while this one shipped', feature)
      if (why) return why
      // syncTarget leaves a dirty worktree alone: landing it would land a generated file nobody made.
      if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], f.worktree) === null)
        return `shipped, but ${TARGET} could not be merged into its branch before landing — ${f.worktree} has uncommitted changes, and its generated files must be made on the merged code — next: commit or set aside the changes there, then /builder:agent ${feature}`
      // The branch moved (a merge, maybe one an agent resolved): the loop's top checks the sign-off again.
      if (tryGit(['rev-parse', 'HEAD'], f.worktree) !== head) continue
    }
    let id
    try {
      id = done?.status === 'green' && done.held ? done.request : requestMerge(ROOT, f.worktree, { target: TARGET, message })
    } catch (e) {
      return `shipped, but the merge tier could not be requested: ${String(e.message).split('\n')[0]} — next: /builder:fleet to retry`
    }
    f.reason = 'merge tier: every suite on the merged result'
    save()
    const v = await awaitVerdict(ROOT, id)
    f.reason = null
    if (!v || v.status === 'cancelled') return 'the merge-tier run was cancelled — next: /builder:agent to retry'
    if (v.status === 'gone') {
      if (++gone === 2) return `the branch's commit disappeared under the verifier (gone) — next: /builder:agent to retry`
      continue
    }
    if (v.status === 'conflict') {
      const ok = await resolveMerge(feature, f.worktree, 'features that merged while this one shipped')
      if (ok !== true) return `a conflict with ${TARGET} in ${v.files.join(', ')} that an agent could not resolve — see ${ok} — next: resolve it in ${f.worktree}, then /builder:agent`
      continue
    }
    if (v.status === 'env-broken') return `the verifier could not run the merge tier: ${v.broken.map((b) => `${b.suite}: ${b.reason}`).join('; ')} — next: fix the environment, then /builder:agent`
    if (v.status === 'red') return { red: v, reason: `the merge tier went red on ${TARGET} as it is now: ${v.regressions.map((g) => g.id).join(', ')} — next: /builder:agent to work the fixes and land it` }
    // The target moved between the request and the run's start: take it into the branch and run again.
    if (merged(v)) continue
    const shut = gate?.()
    if (shut) return { gate: shut }
    const before = tryGit(['rev-parse', `refs/heads/${TARGET}`])
    const r = releaseMerge(ROOT, id)
    if (r.ok) {
      landed(before, r.sha)
      return null
    }
    if (r.overlap) return needsYou(r.overlap)
    if (!r.moved) return `the merge tier passed but landing failed: ${r.reason} — next: /builder:fleet to retry`
  }
  return `${TARGET} kept moving while ${feature} was being landed — next: /builder:fleet to retry`
}

/**
 * Verify is optional after sign-off, so the sign-off is what pins what lands: a park reason when the
 * branch carries code nobody walked since (the SPEC header's sign-off sha, read from before the ship
 * once it shipped), else null. Registry commits and clean merges of the target carry; a header with
 * no sha that is a commit here pins nothing.
 */
function signoffMoved(feature, f) {
  if (!f.worktree || !existsSync(f.worktree)) return null
  const by = signedOff(f.worktree, specOf(feature))
  const s = signoffHolds(f.worktree, by.shas, CFG.registry, `refs/heads/${TARGET}`)
  // A change of generated files only (a regenerated lockfile) is not new code: the sign-off stands (D15).
  if (s.holds || generatedOnly(s.changed, GEN.paths)) return null
  const files = [...s.changed.slice(0, 3), ...(s.changed.length > 3 ? ['…'] : [])].join(', ')
  // A human's sign-off is never replaced by agents unasked; the person can hand it to them (--rewalk-by-agents).
  return { sha: s.sha.slice(0, 7), files, agents: !by.human || REWALK_BY_AGENTS.has(feature) }
}

/** Times an agent sign-off may be walked again in one run before the fleet stops and says why. */
const REWALK_LIMIT = 2

/**
 * Code changed since the sign-off (signoffMoved). Agent-signed: agents walk it again — the folder back
 * to `state: built` (the ship commit reverted first when it already shipped), so the walk lane runs
 * the agent walk, its sign-off, then the quick check, the ship and the landing. Bounded: past
 * REWALK_LIMIT re-walks in a run it parks. Human-signed: a human-step park with the choice of walking
 * it again yourself or handing the re-walk to agents. → the outcome to route.
 */
function walkAgain(feature, f, m) {
  const folder = specOf(feature)
  if (!m.agents) return park(f, `needs your walk again: ${feature} changed since you signed it off at ${m.sha} (${m.files}) — next: /builder:resume --path ${folder}`)
  f.rewalks = (f.rewalks ?? 0) + 1
  if (f.rewalks > REWALK_LIMIT)
    return park(f, `${feature} changed again after ${REWALK_LIMIT} agent re-walks since its sign-off (now ${m.files}) — the fixes keep moving it — next: read the walk rounds and the commits since ${m.sha}, then /builder:agent ${feature}`)
  const wt = f.worktree
  if (!existsSync(join(wt, folder, 'MANIFEST.md'))) {
    // Already shipped on the branch: the ship commit (registry only) is reverted, the folder live again.
    const ship = tryGit(['log', '-n', '1', '--format=%H', '--diff-filter=D', '--', `${folder}/MANIFEST.md`], wt)
    if (!ship || tryGit(['revert', '--no-edit', ship], wt) === null) {
      tryGit(['revert', '--abort'], wt)
      return park(f, `${feature} changed since its agent sign-off at ${m.sha} (${m.files}), and its ship could not be undone to walk it again — next: /builder:agent ${feature}`)
    }
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), 'advance.mjs')
  try {
    execFileSync(process.execPath, [script, folder, '--set', 'state=built', '--set', 'walk=none', '--set', 'verify=none', '--commit', `chore({key}): {feature} — changed since its agent sign-off (${m.files}), walked again`], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop()
    return park(f, `${feature} changed since its agent sign-off at ${m.sha} (${m.files}), and it could not be set to walk again: ${why} — next: /builder:agent ${feature}`)
  }
  addNote(`${feature} changed since its agent sign-off at ${m.sha} (${m.files}) — agents walk it again (${f.rewalks} of ${REWALK_LIMIT})`)
  save()
  return 'walk'
}

/**
 * F4: a sign-off written while walk readiness was still pending is not a walked feature — laneOf sends
 * it to the walk lane, never on to ship. The walk lane acts on `building` + `ready: pending` (resume
 * runs §Walk readiness, then the agent walk), so an agent's sign-off goes: the folder back to
 * building, readiness kept pending. A human's is never replaced unasked: it parks as your walk again,
 * with the choice of handing it to agents (--rewalk-by-agents). → null when it does not apply, else
 * the outcome to route ('walk' or 'parked').
 */
function unwalkedSignoff(feature, f) {
  if (!f.worktree || !existsSync(f.worktree)) return null
  const text = readManifest(f.worktree, feature)
  const mf = text != null ? parseManifest(text) : null
  if (mf?.state !== 'signed-off' || !/^pending/.test(mf.ready ?? '')) return null
  const folder = specOf(feature)
  if (signedOff(f.worktree, folder).human && !REWALK_BY_AGENTS.has(feature)) return park(f, `needs your walk again: ${feature} was signed off with its walk readiness still pending (${mf.ready}) — next: /builder:resume --path ${folder} (it runs walk readiness, then your walk)`)
  const script = join(dirname(fileURLToPath(import.meta.url)), 'advance.mjs')
  try {
    execFileSync(process.execPath, [script, folder, '--set', 'state=building', '--set', 'walk=none', '--set', 'verify=none', '--commit', 'chore({key}): {feature} — signed off before its walk readiness settled, back to the walk lane'], { cwd: f.worktree, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop()
    return park(f, `${feature} was signed off with its walk readiness still pending, and it could not be set back to building: ${why} — next: /builder:agent ${feature}`)
  }
  addNote(`${feature} was signed off before its walk readiness settled — back to the walk lane: readiness, then the agent walk again`)
  save()
  return 'walk'
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
  park(f, PARK_REASONS.revising(specOf(feature)))
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
  if (!/^needs you: your uncommitted changes overlap/.test(reason)) delete f.overlap
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
    // F4: a sign-off nobody walked is set back to building before the walk lane's run, or parks.
    if (lane === 'walk' && unwalkedSignoff(feature, f) === 'parked') return 'parked'
    // D14: a merge since the last run may have brought migrations — the lane database follows.
    try {
      ensureLaneDb(feature, f)
    } catch (e) {
      return park(f, `${e.message} — next: /builder:agent ${feature}`)
    }
    if (lane === 'build') {
      // D10–D12: a run boundary — a spec edit on the target, a collision with another group, rulings.
      const at = atBoundary(feature, f)
      if (at) return at
      // A group member builds only on the member before it, built and merged in (D6).
      const held = await stackGate(feature, f)
      if (held) return held
    }
    const before = snapshot(f.worktree, feature)
    const headBefore = tryGit(['rev-parse', 'HEAD'], f.worktree)
    f.runs = (f.runs ?? 0) + 1 // lifetime, for the table and the log names
    f.runsThisTime = (f.runsThisTime ?? 0) + 1 // this fleet run, for the cap
    startRun(f)
    save()
    const { exit, log } = await runClaude(f.worktree, feature, lane, f.runs)
    f.log = log
    // A plan that just appeared may put this feature in a group; a member just built frees the one after it.
    if (!footprinted.has(feature) && readDoc(f.worktree, feature, 'PLAN.md') != null) regroup()
    releaseGroups()
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
    // A ship-lane run that committed code after the sign-off (a gap fixed, a red test mended): walked again first.
    if (lane === 'ship' && (d.action === 'again' || d.action === 'done')) {
      const moved = signoffMoved(feature, f)
      if (moved) return walkAgain(feature, f, moved)
    }
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
    const ok = await new Promise((r) => execFile('sh', ['-c', fill(AW.smoke, feature)], { cwd: f.worktree, env: envFor(feature, 'walk'), timeout: SMOKE_ATTEMPT_MS }, (err) => r(!err)))
    if (ok) return true
    await sleep(Math.min(3000, SMOKE_INTERVAL_MS * 3))
  }
  return false
}

/** A config hook (reset/stop) in the worktree, with the feature's walk env. False when it failed. */
function hook(cmd, cwd, feature) {
  if (!cmd) return true
  try {
    execSync(fill(cmd, feature), { cwd, env: envFor(feature, 'walk'), stdio: 'ignore', timeout: 10 * 60 * 1000 })
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
  const child = spawn('sh', ['-c', fill(AW.start, feature)], { cwd: f.worktree, env: envFor(feature, 'walk'), stdio: ['ignore', fd, fd], detached: true })
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
      execFile('sh', ['-c', fill(AW.smoke, feature)], { cwd: f.worktree, env: envFor(feature, 'walk'), timeout: SMOKE_ATTEMPT_MS }, (err) => r(!err))
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
  if (reset && !hook(AW.reset, f.worktree, feature)) return `agent_walk.reset failed: ${fill(AW.reset, feature)}`
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
    `Find the cause and fix it in this branch — code, a migration, a dependency, a stale install${AW.sync ? ` (agent_walk.sync is \`${fill(AW.sync, feature)}\`)` : ''}. ` +
    `The fleet runs ${AW.reset ? `reset \`${fill(AW.reset, feature)}\`, then ` : ''}start \`${AW.start ? fill(AW.start, feature) : '(none)'}\`${AW.smoke ? ` and polls smoke \`${fill(AW.smoke, feature)}\`` : ''} with this run's environment; you may run them yourself to check, ` +
    `but stop every process you started before you finish, and kill nothing you did not start — other worktrees share this machine. ` +
    `Commit the fix. Do not edit .claude/builder.md or the feature's MANIFEST.md. If the cause is outside this repo (a port another program holds, a service that is down), change nothing and say so in your last message. ` +
    `Never ask a question and run nothing in the background — nobody is there to answer, and this run ends when your last turn does.`
  const { log } = await runClaude(f.worktree, feature, 'walk', f.runs, prompt)
  f.log = log
  save()
}

/** The manifest states at which the walk lane merges the target in before starting the env: before
 *  walk readiness (it re-smokes the merged code) and before verify (the verifier tests it again). Never at
 *  `built` with the walk still owed — a merge there would void the readiness the walk needs, and
 *  the run would bounce between readiness and the walk. */
const SYNC_BEFORE_WALK = new Set(['building', 'signed-off'])

/**
 * The merge tier runs beside the walk (spec D8): held, so it lands only once the walk passes and
 * the ship releases it. Requested after the walk's own sync with the target, so it tests the HEAD
 * the walk walks; a failure here only costs time — landing requests it again.
 */
/** The landing merge's subject: the feature, or every member a group's merge lands, in order. */
function mergeMessage(names) {
  return `merge(${names.join(', ')}): agent-verified, not human-tested`
}

function requestMergeAtWalk(feature, f, message = mergeMessage([feature])) {
  try {
    f.mergeReq = requestMerge(ROOT, f.worktree, { target: TARGET, message })
  } catch (e) {
    addNote(`${feature}: could not request the merge tier at walk start (${String(e.message).split('\n')[0]}) — it is requested at landing instead`)
  }
}

async function walkOne(feature) {
  const f = fleet.features[feature]
  if (parkIfPaused(f, feature)) return 'parked'
  f.status = 'walking'
  save()
  // A group member walks on the member before it as that one is now — its walk may have fixed code.
  const routed = await chainForWalk(feature)
  if (routed) return routed
  try {
    const text = readManifest(f.worktree, feature)
    if (text && SYNC_BEFORE_WALK.has(parseManifest(text).state)) {
      const why = await syncTarget(f.worktree, 'what other features merged', feature)
      if (why) return park(f, why)
    }
    // One at a time, a group's held merge tier is requested when its tip walks: by then the tip
    // holds every walk before it. A group of one requests its own.
    const g = groupOf(feature)
    if (!g || g.members.length < 2 || tipOf(g) === feature) requestWalkMerge(feature)
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
      addNote(`agent_walk.stop failed after ${feature}: ${fill(AW.stop, feature)}`)
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const pool = [] // { feature, lane: 'build' | 'ship' | 'land' } — the parallel workers' queue
const walkQueue = []
const pendingDeps = (f) => (f.waitsOn ?? []).filter((d) => !landedOn(d))

// ---- group lanes (docs/specs/2026-11-14-group-lanes-design.md, D3–D7) ------------------------
// Features whose plans overlap — a shared path, an interface one makes and the other uses, or a
// declared "Depends on" — form a group. A group owns one lane: its members plan in parallel as any
// feature does, but build one after another, each on top of the member before it, so the second
// builds on the first's code instead of meeting it as a conflict at landing. A feature that overlaps
// nothing is a group of one, which is the lane every feature had before: no record, no wait.
const PAST_BUILDING = new Set(['built', 'signed-off', 'verified', 'shipped'])
const STARTED = new Set(['building', ...PAST_BUILDING])
/** A footprint that overlaps nothing: a declared dependency still joins it, before either plans. */
const NO_FOOTPRINT = { paths: [], produces: [], consumes: [] }
const baseOf = (f) => (f?.worktree && existsSync(f.worktree) ? f.worktree : ROOT)
/** The features whose PLAN.md the last regroup read — a plan appearing after that regroups again. */
const footprinted = new Set()
/** Each live feature's footprint as the last regroup read it — its plan, its rulings, its lane's changes. */
let footprints = new Map()
/** Split advice already given this run, per pair (D13): said once. */
const advised = new Set()
let lastAdviceKey = null
const RULINGS = () => join(DIR, 'rulings.md')
let rulingsCache = { mtime: -1, data: {} }
/** rulings.md parsed, read again only when it changed. */
function rulings() {
  let mtime = 0
  try {
    const st = statSync(RULINGS())
    mtime = `${st.mtimeMs}:${st.size}` // size too: an append within one mtime tick still shows
  } catch {
    return {}
  }
  if (mtime !== rulingsCache.mtime) rulingsCache = { mtime, data: readRulings(RULINGS()) }
  return rulingsCache.data
}
/**
 * Paths a feature reaches beyond its plan (D10, D11): what its rulings in rulings.md name, and what its
 * lane was seen changing where another group's footprint is (`observed`). Generated paths never count.
 */
function extraPaths(feature) {
  const ruled = rulings()[feature] ?? []
  return [...new Set([...ruled, ...(fleet.features[feature]?.observed ?? [])])].filter((p) => !GEN.paths.some((g) => matchesGlob(p, g))).sort()
}

/** A row's manifest state, from its worktree (the main tree before it has one); `shipped` once the ship removed the manifest. */
function stateOf(feature) {
  const base = baseOf(fleet.features[feature])
  const text = readManifest(base, feature)
  if (text != null) return parseManifest(text).state ?? null
  return shippedPr(readSpec(base, feature)) ? 'shipped' : null
}
/**
 * Its build lane done — the point a member after it may stack on its branch, and the point it
 * waits at for its group's walk (D8) — or landed. That is `built` or further, and also `building`
 * with walk readiness pending: readiness needs the walk env, so it is the walk lane's, and a group
 * earns it once, on its tip. Counting only `built` would deadlock a group: the member before would
 * wait at the walk for the one after to build, and that one would wait for it to reach `built`.
 * A built member with open ## Fixes in a batched fleet is back in the build lane, so not built.
 */
function isBuilt(feature) {
  if (landedOn(feature)) return true
  const base = baseOf(fleet.features[feature])
  const text = readManifest(base, feature)
  if (text == null) return Boolean(shippedPr(readSpec(base, feature)))
  // A park is not a lane: what the member had built still stands, whatever stopped it after.
  const lane = laneOf({ ...parseManifest(text), blocked: null }, { batched: SPLIT, specText: readSpec(base, feature) })
  return lane === 'walk' || lane === 'ship' || lane === 'done'
}
const startedBuilding = (feature) => STARTED.has(stateOf(feature))
/** The group a feature is in, as `{ id, members, waitsOn }`, or null for a group of one. */
function groupOf(feature) {
  for (const [id, g] of Object.entries(fleet.groups ?? {})) if (g.members.includes(feature)) return { id, ...g }
  return null
}

/**
 * Form the groups again from what is on disk: each row's PLAN.md footprint and its declared
 * dependencies (D1–D5). Run at the fleet's start, when specs join, and when a feature's PLAN.md
 * first appears. A feature that has started building is never moved out of its group: it keeps the
 * member before it (as a declared dependency, so the two stay connected and in order whatever the
 * plans now say), and it goes before any member that has not started — a member already building
 * cannot wait to stack on one that hasn't. A feature with no PLAN.md and no declared dependency has
 * no footprint and is a group of one until it plans.
 */
function regroup() {
  const names = Object.keys(fleet.features).filter((n) => fleet.features[n].status !== 'done')
  const live = new Set(names)
  const deps = new Map(names.map((n) => [n, (fleet.features[n].dependsOn ?? []).filter((d) => live.has(d))]))
  const started = new Set(names.filter(startedBuilding))
  for (const n of started) {
    const g = groupOf(n)
    const i = g ? g.members.indexOf(n) : -1
    if (i > 0 && live.has(g.members[i - 1]) && !deps.get(n).includes(g.members[i - 1])) deps.get(n).push(g.members[i - 1])
  }
  const declared = new Set([...deps].flatMap(([n, ds]) => (ds.length ? [n, ...ds] : [])))
  footprinted.clear()
  footprints = new Map(
    names.map((n) => {
      const plan = readDoc(baseOf(fleet.features[n]), n, 'PLAN.md')
      if (plan != null) footprinted.add(n)
      // A feature that has started building is never regrouped by a ruling: atBoundary weighs it (D10).
      const extra = startedBuilding(n) ? [] : extraPaths(n)
      const fp = plan != null ? footprintOf(plan, { generated: CFG.generated?.paths ?? [] }) : declared.has(n) || extra.length ? NO_FOOTPRINT : null
      // Rulings and observed changes widen the plan's footprint (D10, D11): the overlap is real either way.
      return [n, fp && extra.length ? { ...fp, paths: [...new Set([...fp.paths, ...extra])].sort() } : fp]
    })
  )
  // What each row's footprint was widened by, so a boundary sees a ruling recorded since (D11).
  for (const n of names) {
    const k = startedBuilding(n) ? '' : extraPaths(n).join('\n')
    if (k) fleet.features[n].widened = k
    else delete fleet.features[n].widened
  }
  const form = () => groupsOf(names.map((n) => ({ name: n, footprint: footprints.get(n), dependsOn: deps.get(n) })), { max: AW.groupMax, fleetOrder: names })
  let groups = form()
  // A started member goes before an unstarted one in its group: the unstarted one depends on it.
  let reordered = false
  for (const g of groups) {
    const first = g.members.filter((m) => started.has(m))
    for (const m of g.members.filter((x) => !started.has(x)))
      for (const s of first) if (!deps.get(m).includes(s) && !deps.get(s).includes(m)) (deps.get(m).push(s), (reordered = true))
  }
  if (reordered) groups = form()
  // A group of one is no record — unless the cap cut it from a component: then it waits, or is waited on.
  const kept = groups.filter((g) => g.members.length > 1 || g.waitsOn || groups.some((x) => x.waitsOn === g.id))
  if (kept.length) fleet.groups = Object.fromEntries(kept.map((g) => [g.id, { members: g.members, waitsOn: g.waitsOn }]))
  else delete fleet.groups
  // D13: a group joined over a few shared paths could build in parallel with a prerequisite feature
  // that takes the shared change — said once per pair per run, never acted on.
  // Every overlapping pair, a group_max cut included — there a split saves the most. Only when the
  // footprints changed since the last regroup: each pair is weighed once per change, not per regroup.
  const fpKey = JSON.stringify([...footprints].filter(([, v]) => v))
  const weigh = fpKey !== lastAdviceKey
  lastAdviceKey = fpKey
  for (let i = 0; weigh && i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]]
      if (!footprints.get(a) || !footprints.get(b)) continue
      const declaredDep = deps.get(a)?.includes(b) || deps.get(b)?.includes(a)
      const advice = splitAdvice(a, b, overlapOf(footprints.get(a), footprints.get(b), { declared: declaredDep }), { maxPaths: AW.splitMaxPaths ?? 10 })
      if (advice && !advised.has(`${a}\0${b}`)) (advised.add(`${a}\0${b}`), addNote(advice))
    }
  for (const n of names) {
    const f = fleet.features[n]
    const g = kept.find((x) => x.members.includes(n) && x.members.length > 1)
    if (g) f.group = g.id
    else delete f.group
    // The member before it, kept once it lands (and its group is gone): stackGate merges the target for it.
    const i = g ? g.members.indexOf(n) : -1
    if (i > 0) f.groupPrev = g.members[i - 1]
    else if (f.groupPrev && !landedOn(f.groupPrev)) delete f.groupPrev
  }
  save()
}

/**
 * A landed member leaves its group's record, as its row leaves fleet.json; a group left with one
 * member is no group, and a group nothing is left of no longer holds back the one cut after it.
 */
function pruneGroups() {
  if (!fleet.groups) return
  for (const g of Object.values(fleet.groups)) g.members = g.members.filter((m) => fleet.features[m] && fleet.features[m].status !== 'done')
  for (const [id, g] of Object.entries(fleet.groups)) if (!g.members.length) delete fleet.groups[id]
  for (const g of Object.values(fleet.groups)) if (g.waitsOn && !fleet.groups[g.waitsOn]) g.waitsOn = null
  for (const [id, g] of Object.entries(fleet.groups))
    if (g.members.length < 2 && !g.waitsOn && !Object.values(fleet.groups).some((x) => x.waitsOn === id)) {
      for (const m of g.members) delete fleet.features[m].group
      delete fleet.groups[id]
    }
  if (!Object.keys(fleet.groups).length) delete fleet.groups
}

const PLANNING_OR_BUILDING = new Set(['spec', 'aligned', 'audited', 'planned', 'building'])
/** D12: the feature's folder on the target as its lane was admitted — what a later spec edit is told from. */
function recordTargetSpec(feature, f) {
  if (f.targetSpec === undefined) f.targetSpec = treeOf(`refs/heads/${TARGET}`, feature)
}
/**
 * D12: park as revising — a human step, never retried — and say so in the manifest (`blocked:`,
 * committed on the branch), so /builder:resume and a later run read it too. The baseline stays until
 * a person unparks it (unpark clears it), so a re-run never builds on past the edit.
 */
function specChanged(feature, f) {
  const folder = specOf(feature)
  const reason = `revising: its spec changed on ${TARGET} — next: /builder:revise --path ${folder}`
  const script = join(dirname(fileURLToPath(import.meta.url)), 'advance.mjs')
  try {
    execFileSync(process.execPath, [script, folder, '--set', `blocked=${JSON.stringify(reason)}`, '--commit', 'chore({key}): {feature} — its spec changed on the target, parked for a revision'], { cwd: f.worktree, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    addNote(`${feature} parked for a revision, but blocked: could not be written to its manifest (${String(e.stderr || e.message).trim().split('\n').pop()}) — the fleet's row still holds it`)
  }
  return park(f, reason)
}
/**
 * A build-lane run boundary (D10–D12), before each run while the feature still plans or builds — a
 * feature past building never waits on another group (the one behind waits for it):
 *   - D12: a spec edit landed on the target since the lane was admitted — park for /builder:revise;
 *   - D10/D11: the branch's own changes (since the member before it, in a group) and its rulings now
 *     reach paths in another group's unlanded footprint that grouping did not already account for —
 *     join that group when the feature has not started building, there is room (group_max) and the
 *     group is still building, else wait for it to land. One collision per boundary; a note each time.
 * → null to run on, or the outcome ('parked', 'waiting').
 */
function atBoundary(feature, f) {
  const state = stateOf(feature)
  if (!PLANNING_OR_BUILDING.has(state)) return null
  const tree = treeOf(`refs/heads/${TARGET}`, feature)
  if (f.targetSpec == null) (f.targetSpec = tree), save() // admitted before its folder was on the target: from here
  else if (tree !== f.targetSpec) return specChanged(feature, f)
  if (!f.worktree || !existsSync(f.worktree)) return null
  // A ruling recorded since: an unstarted feature's footprint is widened by regroup; a started one's is weighed below.
  if (!startedBuilding(feature) && extraPaths(feature).join('\n') !== (f.widened ?? '')) regroup()
  // Its own commits only — not the target's, not the member before it's — merges left out: a merge
  // brings others' paths, and a conflict an agent resolved is the others' paths too.
  const prev = f.groupPrev && !landedOn(f.groupPrev) ? fleet.features[f.groupPrev]?.branch : null
  const own = (tryGit(['log', '--no-merges', '--format=', '--name-only', 'HEAD', '--not', `refs/heads/${TARGET}`, ...(prev ? [`refs/heads/${prev}`] : [])], f.worktree) ?? '').split('\n')
  const changed = [...new Set([...own, ...(startedBuilding(feature) ? extraPaths(feature) : [])])].filter((p) => p && !p.startsWith(`${CFG.registry}/`) && !GEN.paths.some((g) => matchesGlob(p, g)))
  if (!changed.length) return null
  const mine = groupOf(feature)
  const live = (m) => fleet.features[m] && fleet.features[m].status !== 'done' && !landedOn(m)
  // Already accounted for: its own group, what it waits on or groups by, what waits on it, a group
  // linked to its own by a group_max cut (either way), and a member grouping already found it overlaps.
  const linked = new Set([mine?.id, mine?.waitsOn, ...Object.entries(fleet.groups ?? {}).filter(([, g]) => mine && g.waitsOn === mine.id).map(([id]) => id)].filter(Boolean))
  // Waits followed through — whatever it waits on waits on, and whatever waits on it, and on that —
  // so a chain of D10 waits never closes into a cycle.
  const waitsOf = (m) => fleet.features[m]?.waitsOn ?? []
  const reach = (from, next) => {
    const seen = new Set()
    const todo = [...from]
    while (todo.length) {
      const m = todo.pop()
      if (seen.has(m)) continue
      seen.add(m)
      todo.push(...next(m))
    }
    return seen
  }
  const ahead = reach(waitsOf(feature), waitsOf)
  const behind = reach(Object.keys(fleet.features).filter((m) => waitsOf(m).includes(feature)), (x) => Object.keys(fleet.features).filter((m) => waitsOf(m).includes(x)))
  const known = new Set([feature, ...(mine?.members ?? []), ...ahead, ...behind, ...(f.dependsOn ?? [])])
  const grouped = new Set(Object.values(fleet.groups ?? {}).flatMap((g) => g.members))
  const others = [
    ...Object.entries(fleet.groups ?? {}).filter(([id]) => !linked.has(id)).map(([id, g]) => ({ id, members: g.members.filter(live) })),
    ...Object.keys(fleet.features).filter((m) => !grouped.has(m) && live(m)).map((m) => ({ id: m, members: [m] })),
  ].filter((g) => g.members.length && !g.members.some((m) => known.has(m) || overlapOf(footprints.get(feature), footprints.get(m))))
  const hit = laneCollisions({ changed: { [feature]: changed }, groups: others, footprints: Object.fromEntries(footprints) }).find((h) => !(f.collided ?? []).includes(h.group))
  if (!hit) return null
  f.collided = [...(f.collided ?? []), hit.group]
  const g = others.find((x) => x.id === hit.group)
  const shared = `${hit.paths.slice(0, 3).join(', ')}${hit.paths.length > 3 ? '…' : ''}`
  const room = (mine?.members.length ?? 1) + g.members.length <= AW.groupMax
  const building = g.members.every((m) => !PAST_BUILDING.has(stateOf(m)))
  if (!startedBuilding(feature) && room && building) {
    f.observed = [...new Set([...(f.observed ?? []), ...hit.paths])].sort()
    addNote(`${feature} now touches ${shared}, which ${g.members.join(', ')} change${g.members.length > 1 ? '' : 's'} too — it joins their group`)
    regroup()
    return null
  }
  const why = startedBuilding(feature) ? 'it has started building' : !room ? `their group is full (group_max ${AW.groupMax})` : 'their group is past building'
  const waits = [...new Set([...(f.waitsOn ?? []), ...g.members])]
  f.impliedWaits = [...new Set([...(f.impliedWaits ?? []), ...g.members])]
  addNote(`${feature} now touches ${shared}, which ${g.members.join(', ')} change${g.members.length > 1 ? '' : 's'} too — ${why}, so it waits for ${g.members.length > 1 ? 'them' : 'it'} to land`)
  Object.assign(f, { status: 'waiting', waitsOn: waits, reason: `after ${waits.join(', ')}` })
  save()
  return 'waiting'
}

/** Wait, as a group member: off every queue until releaseGroups finds what it waits for. → 'waiting'. */
function groupHold(f, wait) {
  Object.assign(f, { status: 'waiting', groupWait: wait, reason: waitText(wait) })
  save()
  return 'waiting'
}
const VERB = { built: ['build', 'builds'], 'signed-off': ['sign off', 'signs off'], ready: ['are ready to land', 'is ready to land'], landed: ['land', 'lands'] }
const waitText = (w) => (w.until === 'walk' ? `waiting for ${w.group} to be built` : `after ${w.on.join(', ')} ${VERB[w.until][w.on.length > 1 ? 0 : 1]} (group ${w.group})`)
/** Whether member `n` is where a `until` wait needs it. */
const reached = (until, n) => (until === 'built' ? isBuilt(n) : until === 'signed-off' ? pastWalk(n) : until === 'ready' ? wouldLand(n) : landedOn(n))
const waitOver = (w) => w.on.every((n) => reached(w.until, n))

/**
 * Before a member builds (D6): the member before it must be built, and its branch merged into this
 * worktree. The first member of a group cut off by the cap (D3) waits for the group before it to
 * land instead. → null to go on, 'waiting', or 'parked'. A group of one returns null at once.
 */
async function stackGate(feature, f) {
  const mf = manifestOf(f.worktree, feature)
  // A walk's fixes worked in the pool (batched walks) are a build too: the group goes back to
  // building from its earliest member with fixes (D8), so a later one works its own on top of that.
  const builds =
    (mf.state === 'building' && !/^pending/.test(mf.ready ?? '')) ||
    (mf.state === 'planned' && isSet(mf['go-ahead'])) ||
    (SPLIT && mf.state === 'built' && hasOpenFixes(readSpec(f.worktree, feature)))
  // A dependency or predecessor that landed while this one planned is the target's code now, and
  // its group may be gone with it: the pool's sync ran before this lane's first run, not since, so
  // the target is merged in here — once per landed one — before this feature builds on it.
  if (builds) {
    const done = [...new Set([...(f.dependsOn ?? []), ...(f.groupPrev ? [f.groupPrev] : [])])].filter((d) => landedOn(d) && !(f.depsSynced ?? []).includes(d))
    if (done.length) {
      const why = await syncTarget(f.worktree, `${done.join(', ')}'s code`, feature)
      if (why) return park(f, why)
      f.depsSynced = [...(f.depsSynced ?? []), ...done]
      save()
    }
  }
  const g = groupOf(feature)
  if (!g) return null
  const i = g.members.indexOf(feature)
  if (i === 0) {
    const earlier = g.waitsOn ? (fleet.groups?.[g.waitsOn]?.members ?? []).filter((m) => !landedOn(m)) : []
    return earlier.length ? groupHold(f, { until: 'landed', on: earlier, group: g.id, lane: 'build' }) : null
  }
  if (!builds) return null
  const prev = g.members[i - 1]
  if (!isBuilt(prev)) return groupHold(f, { until: 'built', on: [prev], group: g.id, lane: 'build' })
  const why = await stackOn(feature, prev, g.id)
  return why ? park(f, why) : null
}

/**
 * Merge the member before this one into its worktree, and prove it went in (D6): its branch must be
 * an ancestor of HEAD, or this member would build on code it does not have. A conflict goes to the
 * agent merge-resolution run, as a conflict with the target does. → null, or the park reason. A
 * predecessor that has landed is the target's now; the lane's own sync brought it in.
 */
async function stackOn(feature, prev, id) {
  const f = fleet.features[feature]
  const p = fleet.features[prev]
  if (!p || landedOn(prev)) return null // the target's code now: stackGate merged the target in
  const wt = f.worktree
  const ref = `refs/heads/${p.branch}`
  if (tryGit(['merge-base', '--is-ancestor', ref, 'HEAD'], wt) !== null) return null
  let why = null
  if (mergeIn(wt, ref, feature) !== 'merged') {
    if (tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) !== null) {
      const log = await resolveMerge(feature, wt, `${prev}'s code (group ${id})`, { feature: prev, branch: p.branch })
      if (log !== true) {
        tryGit(['merge', '--abort'], wt)
        return `${prev}'s branch is not in ${feature}'s worktree (merging it conflicted and two agent runs could not resolve it${log ? ` — see ${log}` : ''}) — next: merge ${p.branch} in ${wt} and commit it, then /builder:agent ${feature}`
      }
    } else why = tryGit(['status', '--porcelain', '--untracked-files=no'], wt) ? 'uncommitted changes there' : mergeError ?? 'the merge failed before any conflict'
  }
  if (tryGit(['merge-base', '--is-ancestor', ref, 'HEAD'], wt) === null) {
    const next = why === 'uncommitted changes there' ? `commit or set aside the changes in ${wt}` : `run git merge ${p.branch} in ${wt} and clear what stops it`
    return `${prev}'s branch is not in ${feature}'s worktree (${why ?? 'the merge did not take'}) — next: ${next}, then /builder:agent ${feature}`
  }
  return runSync(wt, feature, p.branch)
}

/**
 * Re-chain a group after a member changed (D7): each member after index `from` merges its
 * predecessor's current branch, in order. A member that has not started building is skipped — it
 * stacks when it builds. The first that cannot take its predecessor parks, and the chain stops
 * there: the members after it would chain onto a branch that is missing code. → [{ feature, why }].
 */
async function chainGroup(id, from = 0) {
  const g = fleet.groups?.[id]
  const out = []
  if (!g) return out
  for (let i = from + 1; i < g.members.length; i++) {
    const m = g.members[i]
    const f = fleet.features[m]
    if (!f?.worktree || !existsSync(f.worktree) || !startedBuilding(m)) continue
    // A run in progress owns its worktree: that member chains at its next boundary instead.
    if (['building', 'walking', 'shipping'].includes(f.status)) continue
    const why = await stackOn(m, g.members[i - 1], id)
    out.push({ feature: m, why })
    if (why) {
      park(f, why)
      break
    }
  }
  return out
}

// ---- the barrier (D8, D8a) ---------------------------------------------------------------------
// A group is tested once, on its tip: every member waits at the walk lane until all are built, then
// the group walks as a unit — one held merge tier, on the tip, which holds every member's code.
const IN_A_RUN = new Set(Object.values(RUNNING))
const SIGNED = new Set(['signed-off', 'verified', 'shipped'])
const STOPPED = new Set(['parked', 'failed'])
/** The member whose branch holds the whole group: the last one still to land. */
const tipOf = (g) => [...g.members].reverse().find((m) => fleet.features[m] && !landedOn(m)) ?? null

/**
 * Ready for its group's walk: built, with a worktree, and not in a run of its own (a run still
 * owns its manifest and its worktree — `self`, the member asking, is the one whose run just ended).
 * A parked or failed member is not: the group waits for it, and says so when the fleet ends.
 */
function walkReady(m, self) {
  if (landedOn(m)) return true
  const f = fleet.features[m]
  if (!f?.worktree || !existsSync(f.worktree) || STOPPED.has(f.status)) return false
  if (m !== self && IN_A_RUN.has(f.status)) return false
  return isBuilt(m)
}
/** Signed off or further, and not on its way back to the walk; or landed. */
function pastWalk(m) {
  if (landedOn(m)) return true
  const f = fleet.features[m]
  if (!f || STOPPED.has(f.status) || f.status === 'awaiting-walk' || f.status === 'walking') return false
  return SIGNED.has(stateOf(m))
}

/** Whether `branch` lacks code `prev` has — a commit outside the registry. Registry commits (a walk's verdict) don't count. */
const codeBehind = (branch, prev) => Boolean(tryGit(['rev-list', '-n', '1', `refs/heads/${prev}`, `^refs/heads/${branch}`, '--', '.', `:(exclude)${CFG.registry}`]))
/** Code (outside the registry) that came into a worktree since `before`. */
const codeSince = (wt, before) => Boolean(before && tryGit(['diff', '--name-only', before, 'HEAD', '--', '.', `:(exclude)${CFG.registry}`], wt))

/**
 * The first member whose branch lacks code the member before it has (D7): the stack no longer
 * chains there — a walk fix, a fix round or a sync moved the member before it. -1 when it chains.
 */
function chainBreak(g) {
  for (let i = 1; i < g.members.length; i++) {
    const [p, m] = [g.members[i - 1], g.members[i]]
    const [fp, f] = [fleet.features[p], fleet.features[m]]
    if (!fp || !f || landedOn(p) || landedOn(m) || !startedBuilding(m)) continue
    if (codeBehind(f.branch, fp.branch)) return i
  }
  return -1
}

/**
 * A member at the walk lane (D8): a group of one walks as it always has (→ false). A member of a
 * bigger group waits here, `awaiting-walk`, until every member is built; the last to get there
 * opens the barrier. → true when it was held or queued.
 */
function walkGate(feature) {
  const g = groupOf(feature)
  if (!g || g.members.length < 2) return false
  const f = fleet.features[feature]
  delete f.groupWait
  if (walkQueue.includes(feature)) {
    Object.assign(f, { status: 'awaiting-walk', reason: null })
    save()
    return true
  }
  const on = g.members.filter((m) => m !== feature && !walkReady(m, feature))
  if (on.length) {
    Object.assign(f, { status: 'awaiting-walk', groupWait: { until: 'walk', on, group: g.id, lane: 'walk' }, reason: waitText({ until: 'walk', group: g.id }) })
    save()
    return true
  }
  openBarrier(g, feature)
  return true
}
const barrierOpen = (g, feature) => g.members.every((m) => m === feature || walkReady(m, feature))

/**
 * The group enters the walk queue as a unit, members in order: every member held at the barrier
 * (and `feature`, the one that opened it), and — where the stack no longer chains — every member
 * from there on, signed off or not: it is re-chained before the walk, and an agent sign-off that
 * moved with it is walked again (prepareUnit). A signed-off member is taken off its ship wait.
 */
function openBarrier(g, feature) {
  const k = chainBreak(g)
  for (const [i, m] of g.members.entries()) {
    const f = fleet.features[m]
    if (!f || landedOn(m) || walkQueue.includes(m)) continue
    const held = f.groupWait?.until === 'walk'
    const rechain = k >= 0 && i >= k && f.worktree && startedBuilding(m) && !IN_A_RUN.has(f.status) && !STOPPED.has(f.status)
    if (m !== feature && !held && !rechain) continue
    delete f.groupWait
    for (let j = pool.length - 1; j >= 0; j--) if (pool[j].feature === m) pool.splice(j, 1)
    Object.assign(f, { status: 'awaiting-walk', reason: null })
    walkQueue.push(m)
  }
  save()
}

/**
 * A member on its way to the ship or the landing (`lane`). No member ships or lands alone (D9):
 * it waits until every member of its group is signed off. A stack that no longer chains goes back
 * through the walk first (openBarrier). Past that the members ship side by side, and the group
 * lands as one (landGroup). A group of one → false at once.
 */
function shipHold(feature, lane) {
  const g = groupOf(feature)
  if (!g || g.members.length < 2) return false
  if (g.members.every((m) => m === feature || pastWalk(m)) && chainBreak(g) >= 0) {
    openBarrier(g, null)
    if (walkQueue.includes(feature)) return true
  }
  const on = g.members.filter((m) => m !== feature && !pastWalk(m))
  if (on.length) {
    groupHold(fleet.features[feature], { until: 'signed-off', on, group: g.id, lane })
    return true
  }
  return false
}

/**
 * Before a member walks, in a batch or alone: merge the member before it, if it has moved (D7).
 * → null to walk it, or the outcome that routes it instead: 'walk' (back to the barrier: a member
 * before it is building again), 'ship' (it is signed off and the sign-off still holds, or is a
 * human's, never replaced) or 'parked' (the merge did not take, or walkAgain's bound was reached).
 */
async function chainForWalk(feature) {
  const g = groupOf(feature)
  const i = g ? g.members.indexOf(feature) : -1
  if (i < 1) return null
  const f = fleet.features[feature]
  // A member before it went back to building (walk fixes, one walk at a time): walking this one now
  // would sign off code about to change. It waits at the barrier for the group again.
  if (g.members.slice(0, i).some((m) => !isBuilt(m))) {
    delete f.groupWait
    Object.assign(f, { status: 'awaiting-walk', reason: null })
    return 'walk'
  }
  const before = tryGit(['rev-parse', 'HEAD'], f.worktree)
  const why = await stackOn(feature, g.members[i - 1], g.id)
  if (why) return park(f, why)
  return afterChain(feature, before, g.members[i - 1])
}

/**
 * A member that may have received the code of the member before it (`before`: its HEAD then).
 * Signed off: an agent's sign-off on code that moved goes — back to `built` (walkAgain), walked
 * again with the group; a human's is never replaced: it is recorded (`humanSignoffMoved`) for the
 * group's landing to stop on as a human step, and the member goes back to waiting to ship. Built
 * with code new to it: its walk readiness is void, so it is earned again (rearmReadiness).
 * → null to walk it, 'ship', or 'parked'.
 */
function afterChain(feature, before, prev) {
  const f = fleet.features[feature]
  // F4 first: a sign-off with readiness pending was never walked — it does not wait to ship.
  const u = unwalkedSignoff(feature, f)
  if (u) return u === 'walk' ? null : 'parked'
  if (SIGNED.has(stateOf(feature))) {
    const m = signoffMoved(feature, f)
    if (m?.agents) {
      if (walkAgain(feature, f, m) !== 'walk') return 'parked'
    } else {
      // A human sign-off that holds again (they walked it again and signed off) clears the record.
      if (m) f.humanSignoffMoved = { sha: m.sha, files: m.files }
      else delete f.humanSignoffMoved
      Object.assign(f, { status: 'awaiting-ship', reason: null })
      save()
      return 'ship'
    }
  }
  if (stateOf(feature) === 'built' && codeSince(f.worktree, before)) {
    const why = rearmReadiness(feature, f, `${prev}'s branch`)
    if (why) return park(f, why)
  }
  return null
}

/**
 * The held merge tier of a walk (D8): a group's one run is on its tip, which holds every member's
 * code, and every member's row records it. A group of one requests its own, as before.
 */
function requestWalkMerge(feature, walking = [feature]) {
  const g = groupOf(feature)
  if (!g || g.members.length < 2) return requestMergeAtWalk(feature, fleet.features[feature])
  const tip = tipOf(g)
  const ft = fleet.features[tip]
  // Only a tip that walks now: a parked one, or one not in this walk, tests code this walk is not of.
  if (!ft?.worktree || !existsSync(ft.worktree) || STOPPED.has(ft.status) || !walking.includes(tip)) return
  // The merge the group lands as (D9) is the tip's: it names every member it lands.
  requestMergeAtWalk(tip, ft, mergeMessage(liveMembers(g)))
  for (const m of g.members) if (fleet.features[m] && ft.mergeReq) fleet.features[m].mergeReq = ft.mergeReq
  save()
}

// ---- group landing (D9) ---------------------------------------------------------------------------
// A group lands as one batch, through its tip: the tip's branch holds every member's code, so its
// held merge tier tested the group as it will land. No member lands alone — a member that would land
// waits for the rest, and the last to get there lands them all.

/** The members still to land, in order; the last is the tip. */
function liveMembers(g) {
  return g.members.filter((m) => fleet.features[m] && !landedOn(m))
}
/**
 * Shipped and at rest, so its group may land it: not stopped, and not in a run of its own (a member
 * still in its ship run lands the group itself when that run ends). Or landed.
 */
function wouldLand(m) {
  if (landedOn(m)) return true
  const f = fleet.features[m]
  return Boolean(f) && !STOPPED.has(f.status) && !IN_A_RUN.has(f.status) && stateOf(m) === 'shipped'
}

/**
 * A member as landingGate reads it. A shipped one has no manifest left — the ship refused it unless
 * it was signed off, so it reads as signed off. A pause request, or a row the fleet parked or
 * failed, blocks it as a `blocked:` line would.
 */
function gateView(m) {
  const f = fleet.features[m]
  const text = readManifest(baseOf(f), m)
  const man = text != null ? parseManifest(text) : stateOf(m) === 'shipped' ? { state: 'signed-off' } : null
  if (!man) return null
  const blocked = existsSync(pauseFile(m)) ? 'paused for a revision' : STOPPED.has(f.status) ? (f.reason ?? f.status) : man.blocked
  return { ...man, blocked: blocked ?? null }
}
const gateOf = (members) => () => {
  const r = landingGate(members, new Map(members.map((m) => [m, gateView(m)])))
  return r.ok ? null : r.why
}
/** A reason for a member whose group did not land because of `culprit` — `why` without its own next step. */
const didNotLand = (g, live, culprit, why) => `group ${g.id} did not land: ${String(why).replace(/ — next: .*$/, '')} — next: settle ${culprit}, then pick ${live.join(', ')} in /builder:agent`

/**
 * Another member's outcome from a landing this feature ran: told and routed as route does for its own
 * — except for autoRetry, which only the member that ran the landing gets (route). A member parked by
 * another's landing stopped for its group: retrying it alone reruns the same landing on the same
 * culprit, so it spends a retry on nothing; it starts again when the group lands, or a person picks it.
 */
function routeOther(m, outcome) {
  if (outcome === 'parked') {
    ensureParkRecord(m)
    tellStop(m, { ...fleet.features[m] })
  } else if (outcome === 'walk') walkGate(m) || walkQueue.push(m)
  else if (outcome === 'done') release()
  wakeAll()
}

/**
 * Land `feature`'s group (D9). Every other member must be shipped and at rest first — else this one
 * waits for them (`until: 'ready'`), and the last to get there lands the group. Then, in order:
 *   - a member whose sign-off chained code moved is walked again — by agents for an agent's
 *     sign-off; a human's parks as a human step (walkAgain) — and the group waits for it;
 *   - landingGate on every member (D9): a failure lands nothing, and each member says why;
 *   - every member's branch is merged into the tip (their ship commits — registry only, so the
 *     tip's held run still carries), and the group lands through the tip (mergeThroughVerifier),
 *     the gate asked once more right before the release;
 *   - a red tip is bisected by prefix (bisectGroup).
 * Each landed member gets its own archive row. → this feature's outcome; every other member's is told here.
 */
async function landGroup(feature, g, live) {
  const f = fleet.features[feature]
  const not = live.filter((m) => m !== feature && !wouldLand(m))
  if (not.length) return groupHold(f, { until: 'ready', on: not, group: g.id, lane: 'land' })
  // From here this landing speaks for every member: none is queued to land on its own.
  for (const m of live) {
    delete fleet.features[m].groupWait
    for (let j = pool.length - 1; j >= 0; j--) if (pool[j].feature === m) pool.splice(j, 1)
  }
  const told = new Map()
  const outcome = () => {
    for (const [m, o] of told) if (m !== feature) routeOther(m, o)
    save()
    return told.get(feature) ?? (fleet.features[feature] ? fleet.features[feature].status : 'done')
  }
  // `culprit` stops the group: every other member waits for it to be ready to land again.
  const waitFor = (culprit, members = live) => {
    for (const m of members) if (m !== culprit) told.set(m, groupHold(fleet.features[m], { until: 'ready', on: [culprit], group: g.id, lane: 'land' }))
  }
  // Code nobody walked since a sign-off never lands (signoffMoved). A human's is never replaced: the
  // member parks as a human step — walk it again, or hand it to agents — and the group waits (D8).
  for (const m of live) {
    const fm = fleet.features[m]
    const moved = signoffMoved(m, fm)
    if (!moved) {
      delete fm.humanSignoffMoved
      continue
    }
    told.set(m, walkAgain(m, fm, moved))
    waitFor(m)
    return outcome()
  }
  // The gate shut: nothing lands, and each member says why — told, routed by outcome() once, by the caller.
  const parkGate = (why, members = live) => {
    const culprit = members.find((m) => gateOf([m])()) ?? members[0]
    const fc = fleet.features[culprit]
    // A pause is the person's own request: it parks as revising, as a feature alone would.
    if (parkIfPaused(fc, culprit)) told.set(culprit, 'parked')
    else if (!STOPPED.has(fc.status)) told.set(culprit, park(fc, didNotLand(g, members, culprit, why)))
    for (const m of members) if (m !== culprit) told.set(m, park(fleet.features[m], didNotLand(g, members, culprit, why)))
  }
  const shut = gateOf(live)()
  if (shut) {
    parkGate(shut)
    return outcome()
  }
  const tip = live.at(-1)
  const ft = fleet.features[tip]
  const stuck = (culprit, why, members = live) => {
    const fc = fleet.features[culprit]
    told.set(culprit, why?.files ? walkAgain(culprit, fc, why) : park(fc, why?.red ? why.reason : why))
    waitFor(culprit, members)
  }
  // The tip takes every member's ship commit, so the one merge lands each folder's archive move too.
  for (const m of live.slice(0, -1)) {
    const why = await stackOn(tip, m, g.id)
    if (why) {
      stuck(tip, why)
      return outcome()
    }
  }
  const cfg = configChanged(ft)
  if (cfg) {
    stuck(tip, cfg)
    return outcome()
  }
  const facts = new Map(live.map((m) => [m, landingPrep(m, fleet.features[m])]))
  const why = await mergeThroughVerifier(tip, ft, { message: mergeMessage(live), gate: gateOf(live) })
  if (!why) for (const m of live) told.set(m, finishLanding(m, facts.get(m)))
  else if (why.gate) parkGate(why.gate)
  else if (why.red) await bisectGroup(g, live, facts, why.red, { told, stuck, parkGate })
  else stuck(tip, why)
  return outcome()
}

/**
 * The tip's merge tier went red (`red`, its verdict): which member broke it? Each prefix of the stack
 * is tested on its last member's branch, which holds exactly that prefix (bisectPlan) — member 1, then
 * 1–2, … — stopping at the first that is red (firstFailing); the whole group is the tip's red run. The
 * members before it land, through the last green prefix's held run; it parks, naming the verdict; the
 * members after it wait for it to be ready to land again. A prefix the verifier gives no verdict on counts as red: what
 * it holds is not known to be green, so it does not land.
 */
async function bisectGroup(g, live, facts, red, { told, stuck, parkGate }) {
  const results = []
  for (const prefix of bisectPlan(live).slice(0, -1)) {
    const m = prefix.at(-1)
    const fm = fleet.features[m]
    let v = null
    let why = null
    // The prefix's last member takes the ship commits before it, as the tip did: what lands is what ran.
    for (const e of prefix.slice(0, -1)) if (!why) why = await stackOn(m, e, g.id)
    if (!why && fm.worktree && existsSync(fm.worktree)) {
      try {
        const id = requestMerge(ROOT, fm.worktree, { target: TARGET, message: mergeMessage(prefix) })
        fm.reason = `merge tier: ${prefix.join(', ')} on ${TARGET}, to find what turned ${g.id} red`
        save()
        v = await awaitVerdict(ROOT, id)
      } catch (e) {
        why = String(e.message).split('\n')[0]
      }
      fm.reason = null
    }
    results.push({ green: v?.status === 'green', verdict: v, why: why ?? (v ? null : 'no verdict') })
    if (v?.status !== 'green') break
  }
  if (results.every((r) => r.green)) results.push({ green: false, verdict: red })
  const k = firstFailing(results)
  const culprit = live[k]
  const { verdict: v, why } = results[k]
  const summary = v?.status === 'red' ? v.regressions.map((x) => x.id).join(', ') : `${g.id}'s tip went red (${red.regressions.map((x) => x.id).join(', ')}), and ${live.slice(0, k + 1).join(', ')} alone could not be tested (${why ?? v?.status})`
  told.set(culprit, park(fleet.features[culprit], `merge tier went red: ${summary} — next: /builder:agent ${culprit}`))
  for (const m of live.slice(k + 1)) told.set(m, groupHold(fleet.features[m], { until: 'ready', on: [culprit], group: g.id, lane: 'land' }))
  if (k === 0) return
  const landing = live.slice(0, k)
  const head = landing.at(-1)
  // The tip's config diff is not the prefix's: a member can change the config and a later one revert it.
  const cfg = configChanged(fleet.features[head])
  if (cfg) return stuck(head, cfg, landing)
  const done = await mergeThroughVerifier(head, fleet.features[head], { message: mergeMessage(landing), gate: gateOf(landing) })
  if (!done) for (const m of landing) told.set(m, finishLanding(m, facts.get(m)))
  else if (done.gate) parkGate(done.gate, landing)
  else stuck(head, done, landing)
}

/** What a member's wait should be on now, from its current group — a regroup may have moved it. */
function expectedWait(feature, w) {
  const g = groupOf(feature)
  const i = g ? g.members.indexOf(feature) : -1
  if (w.lane === 'build' && w.until === 'built') return i > 0 ? [g.members[i - 1]] : []
  if (w.lane === 'build') return i === 0 && g.waitsOn ? (fleet.groups?.[g.waitsOn]?.members ?? []) : []
  if (w.until === 'signed-off') return g ? g.members.filter((m) => m !== feature) : []
  // Ready to land: the members the landing found not ready, or the one that stopped it — a wait on
  // members of its group is current; one on a member a regroup took out of it is not.
  if (w.until === 'ready') return g ? w.on.filter((m) => g.members.includes(m)) : []
  return i > 0 ? g.members.slice(0, i) : []
}
/** A wait no longer on the member's current predecessor (or group): dropped, and checked again where it goes. */
function staleWait(feature, w) {
  const open = (list) => new Set(list.filter((n) => !reached(w.until, n)))
  const now = open(expectedWait(feature, w))
  const was = open(w.on)
  return now.size !== was.size || [...now].some((n) => !was.has(n))
}

/** Members whose wait is over (or stale) go back on their lane's queue. Run after every run and every routing. */
function releaseGroups() {
  let any = false
  for (const [feature, f] of Object.entries(fleet.features)) {
    if (!f.groupWait || !['waiting', 'awaiting-walk'].includes(f.status)) continue
    // The barrier: open once every member is built; a member a regroup moved goes through the gate again.
    if (f.groupWait.until === 'walk') {
      const g = groupOf(feature)
      if (g?.id === f.groupWait.group && !barrierOpen(g, feature)) continue
      delete f.groupWait
      any = true
      walkGate(feature) || (Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature))
      continue
    }
    if (!waitOver(f.groupWait) && !staleWait(feature, f.groupWait)) continue
    const lane = f.groupWait.lane
    delete f.groupWait
    any = true
    if (lane === 'ship' || lane === 'land') {
      if (shipHold(feature, lane)) continue
      Object.assign(f, { status: 'awaiting-ship', reason: null })
      pool.push({ feature, lane })
    } else {
      Object.assign(f, { status: 'queued', reason: null })
      pool.push({ feature, lane: 'build' })
    }
  }
  if (any) {
    save()
    wakeAll()
  }
}

/**
 * Put a feature in the queue its manifest says. A program child still waiting on a dependency
 * gets no worktree yet: it is branched once they have merged, so it starts from their code.
 */
function enqueue(feature) {
  const f = fleet.features[feature]
  delete f.groupWait // a member's wait is checked again where it builds or walks
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
  // A person's unpark clears D12's baseline, so it goes first; then the baseline is the folder on the
  // target as the lane is admitted, before anything merges in.
  if (f.unpark) unpark(feature)
  recordTargetSpec(feature, f)
  save()
  // Its dependencies' code, merged now so the worktree starts from it. A conflict is left to the
  // lane, whose own sync hands it to an agent.
  if (released && !fresh) mergeTargetQuietly(f.worktree)
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  const lane = text == null ? 'unknown' : laneOf(mf, { batched: SPLIT, specText: readSpec(f.worktree, feature) })
  if (lane === 'blocked') Object.assign(f, { status: 'parked', reason: unquote(mf.blocked) })
  else if (text == null && shippedPr(readSpec(f.worktree, feature))) shipHold(feature, 'land') || (Object.assign(f, { status: 'awaiting-ship', reason: null }) && pool.push({ feature, lane: 'land' })) // shipped, the merge still owed
  else if (lane === 'done') {
    f.pr = mf.pr ?? null
    archiveRow(feature)
  }
  else if (lane === 'ship') shipHold(feature, 'ship') || (Object.assign(f, { status: QUEUED[lane], reason: null }) && pool.push({ feature, lane }))
  else if (lane === 'build') Object.assign(f, { status: QUEUED[lane], reason: null }) && pool.push({ feature, lane })
  else if (lane === 'walk') walkGate(feature) || (Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature))
  else Object.assign(f, { status: 'parked', reason: `MANIFEST.md is missing or its state is not one the fleet knows — next: /builder:resume --path ${specOf(feature)} to set it right` })
}

// ---- the park record (REFERENCE §The park record) -------------------------------------------
const today = () => new Date().toISOString().slice(0, 10)
const YOUR_WALK = /^waiting for your walk/
const OVERLAP_PARK = /^needs you: your uncommitted changes overlap/

/**
 * Where a parked feature's record is: beside MANIFEST.md, committed, while its folder is live. Once
 * the ship has moved the folder to the archive (a landing park), in the fleet's own dir and never
 * committed — on the branch it would land on the target with the feature.
 */
const landingRecord = (feature) => join(DIR, 'parked', feature, 'PARKED.md')
function recordOf(feature) {
  const f = fleet.features[feature]
  const folder = f?.worktree && join(f.worktree, specOf(feature))
  if (folder && existsSync(join(folder, 'MANIFEST.md'))) return { path: join(folder, 'PARKED.md'), committed: true }
  return { path: landingRecord(feature), committed: false }
}

/** A park's choices (D6), from its reason. */
const choicesOf = (feature, reason) => parkChoices({ feature, reason, folder: specOf(feature) })

/** `- <date> <what>` at the end of the record's History, which is always its last section. */
function appendHistory(path, what) {
  const text = readFileSync(path, 'utf8').trimEnd()
  writeFileSync(path, `${/^## History$/m.test(text) ? text : `${text}\n\n## History`}\n- ${today()} ${what}\n`)
}

/** The record's `kind:`, or what the reason implies when there is no record. */
function parkKind(feature) {
  const f = fleet.features[feature]
  const { path: p } = recordOf(feature)
  const kind = existsSync(p) ? /^kind:\s*(\S+)/m.exec(readFileSync(p, 'utf8'))?.[1] : null
  return kind ?? (HUMAN_STEP.test(f.reason ?? '') ? 'human-step' : 'stuck')
}

/**
 * Make sure a parked feature has a park record that matches its park. A run that parked it wrote
 * one (the skills do) → kept as written. None, or one left from an earlier park → the fleet writes
 * what it knows: the reason split into why and next, the log of the run that parked it with its
 * last lines quoted (logs live outside the worktree), and the history carried over. Committed, so
 * it travels with the branch. A human-step park's record always offers its choices (D6) — one a run
 * wrote without them gains them. A landing park (the folder already shipped) is recorded only when
 * it is a human step, in the fleet's dir (recordOf); the overlap record names every file.
 */
function ensureParkRecord(feature) {
  const f = fleet.features[feature]
  if (!f.reason) return
  const { path: p, committed } = recordOf(feature)
  const human = HUMAN_STEP.test(f.reason)
  if (!committed && !human) return void rmSync(dirname(p), { recursive: true, force: true })
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const commit = (why) => {
    if (!committed) return
    const rel = join(specOf(feature), 'PARKED.md')
    tryGit(['add', '--', rel], f.worktree)
    tryGit(['commit', '-qm', `docs(${feature}): park record — ${why}`, '--', rel], f.worktree)
  }
  if (old && unquote(/^blocked:\s*(.*)$/m.exec(old)?.[1]) === f.reason) {
    if (!human || /^## Your choices$/m.test(old)) return
    const section = `${choicesSection(choicesOf(feature, f.reason))}\n\n`
    const at = old.search(/^## (Recommended next step|History)$/m)
    writeFileSync(p, at < 0 ? `${old.trimEnd()}\n\n${section}` : old.slice(0, at) + section + old.slice(at))
    return commit('its choices')
  }
  const { why, next } = parkParts(f.reason)
  const history = /^## History\n([\s\S]*)$/m.exec(old)?.[1]?.trimEnd()
  mkdirSync(dirname(p), { recursive: true })
  if (OVERLAP_PARK.test(f.reason) && f.overlap?.length) {
    const sha = tryGit(['rev-parse', '--short', `refs/heads/${f.branch}`]) ?? ''
    writeFileSync(p, overlapRecord({ feature, reason: f.reason, files: f.overlap, branch: f.branch, sha, target: TARGET, date: today(), history }))
    return commit(why)
  }
  const tail = f.log && existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').slice(-25).join('\n') : ''
  const kind = human ? 'human-step' : 'stuck'
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
    ...(human ? [choicesSection(choicesOf(feature, f.reason)), ''] : []),
    '## Recommended next step',
    next ?? '/builder:agent — naming it again unparks it and retries',
    '',
    '## History',
    ...(history ? [history] : []),
    `- ${today()} parked — ${why}`,
    '',
  ].join('\n')
  writeFileSync(p, text)
  commit(why)
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
  // A person picked it again (after the revise D12 asked for, or not): the folder on the target now is
  // the baseline, and a wait D10 implied is dropped — the next boundary weighs the collision afresh.
  if (by === BY_PERSON) {
    delete f.targetSpec
    if (f.impliedWaits?.length) {
      f.waitsOn = (f.waitsOn ?? []).filter((d) => !f.impliedWaits.includes(d))
      if (!f.waitsOn.length) delete f.waitsOn
      delete f.impliedWaits
      delete f.collided
    }
  }
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
 * feature for a whole fleet cycle, and every ship re-ran every app's tests on a tree that had
 * just moved. Only a clean tree is merged (a manual-commit app may have work staged). A conflict is
 * never a reason to stop: an agent run resolves it (resolveMerge), and only a conflict two runs
 * could not resolve parks. Returns null when the worktree is at the target, or the merge went in.
 */
async function syncTarget(wt, why = "its dependencies' code", feature = null) {
  if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null) return null
  if (tryGit(['status', '--porcelain', '--untracked-files=no'], wt) !== '') return null // not ours to merge over
  if (mergeIn(wt, `refs/heads/${TARGET}`, feature ?? basename(wt)) !== 'merged') {
    const conflicted = tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) !== null
    const log = conflicted && feature ? await resolveMerge(feature, wt, why) : null
    if (log !== true) {
      tryGit(['merge', '--abort'], wt)
      if (!conflicted) return `merging ${TARGET} (${why}) failed before any conflict${mergeError ? `: ${mergeError}` : ''} — next: run git merge ${TARGET} in ${wt} and clear what stops it, then /builder:agent`
      return `merging ${TARGET} (${why}) conflicted and two agent runs could not resolve it${log ? ` (see ${log})` : ''} — next: finish the merge in ${wt} and commit it, then /builder:agent`
    }
  }
  return runSync(wt, feature, TARGET)
}

/**
 * New commits came in (the target, or the member before this one in its group): a package or a
 * migration may have come with them, and the worktree's install and test database were made before
 * it. agent_walk.sync brings them up to date. → null, or the park reason.
 */
function runSync(wt, feature, merged) {
  if (!AW.sync || !feature) return null
  const log = join(DIR, 'logs', `${feature}-sync.log`)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  try {
    execSync(fill(AW.sync, feature), { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    return `agent_walk.sync failed after merging ${merged} (see ${log}) — next: make agent_walk.sync pass in ${wt}, then /builder:agent`
  } finally {
    closeSync(fd)
  }
  return null
}

// ---- D15: generated files ----------------------------------------------------------------------
const isGenerated = (path) => GEN.paths.some((g) => matchesGlob(path, g))
/** `git status --porcelain -z` in `wt` as [{ xy, path }] — NUL-separated, so no path is C-quoted; a rename's source skipped. */
function statusOf(wt) {
  // Untrimmed: an entry's XY can start with a space (' M path'), which tryGit's trim would eat.
  let raw = ''
  try {
    raw = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
  } catch {}
  const parts = raw.split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    out.push({ xy: e.slice(0, 2), path: e.slice(3) })
    if (/[RC]/.test(e.slice(0, 2))) i++
  }
  return out
}
/** Every generated path `git status` names in `wt`, tracked or new — never `git add -u`. */
const generatedChanges = (wt) => statusOf(wt).map((e) => e.path).filter(isGenerated)
/** A file of `paths` in `wt` that still holds a conflict marker. */
const markerIn = (wt, paths) => paths.find((p) => existsSync(join(wt, p)) && /^(<{7}|>{7})( |$)/m.test(readFileSync(join(wt, p), 'utf8')))
/**
 * generated.command in `wt`, logged to logs/<feature>-generated.log. What it changed outside
 * generated.paths is put back — a tracked file checked out, a new file removed — and named in a
 * note: only generated paths are ever committed for it, and a dirty worktree stops the next sync.
 * → true, or false when it failed (a note: `failed` says what happens to the merge).
 */
function regenerate(wt, feature, label, failed) {
  const log = join(DIR, 'logs', `${feature}-generated.log`)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  const dirty = new Set(statusOf(wt).map((e) => e.path))
  let ok = true
  try {
    execSync(fill(GEN.command, feature), { cwd: wt, env: envFor(feature, 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
  } catch {
    ok = false
  } finally {
    closeSync(fd)
  }
  // Put back from HEAD, not the index: a command that `git add`s its own edit would otherwise keep it staged.
  const putBack = (e) => (e.xy === '??' ? rmSync(join(wt, e.path), { force: true, recursive: true }) : tryGit(['checkout', 'HEAD', '--', e.path], wt))
  const stray = statusOf(wt).filter((e) => !isGenerated(e.path) && !dirty.has(e.path))
  for (const e of stray) putBack(e)
  // A command that failed halfway leaves generated outputs half written: they go too, so the
  // worktree is as clean as before it ran and the next sync is not stopped by them.
  if (!ok) for (const e of statusOf(wt).filter((x) => isGenerated(x.path) && !dirty.has(x.path))) putBack(e)
  if (stray.length) addNote(`generated.command changed ${stray.map((e) => e.path).slice(0, 3).join(', ')}${stray.length > 3 ? '…' : ''} outside generated.paths in ${label} — put back; only generated paths are committed`)
  if (!ok) addNote(`generated.command failed in ${label} — see ${log}; ${failed}`)
  return ok
}
let mergeError = null
/**
 * `git merge <ref>` in `wt`, generated files regenerated rather than merged (D15). A conflict whose
 * every conflicted file is generated is resolved with no agent (resolveGenerated). A clean merge in
 * which both sides changed a generated path since their merge base runs the command too, and
 * commits only the generated paths it changed — a text merge of two lockfiles is not a lockfile.
 * Without generated.command, a plain merge. → 'merged' (or nothing to merge), 'conflict' (MERGE_HEAD
 * left for an agent), 'failed' (git's words in mergeError).
 */
function mergeIn(wt, ref, feature) {
  mergeError = null
  const before = tryGit(['rev-parse', 'HEAD'], wt)
  const base = GEN.command ? tryGit(['merge-base', 'HEAD', ref], wt) : null
  const genSince = (to) => (base ? (tryGit(['diff', '--name-only', base, to], wt) ?? '').split('\n').filter((p) => p && isGenerated(p)) : [])
  const both = base && genSince(before).length && genSince(ref).length
  try {
    git(['merge', '--no-edit', '--quiet', ref], wt)
  } catch (e) {
    if (tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) === null) {
      mergeError = gitWords(e)
      return 'failed'
    }
    return resolveGenerated(wt, ref, feature) ? 'merged' : 'conflict'
  }
  const label = `${feature}'s worktree`
  if (both && tryGit(['rev-parse', 'HEAD'], wt) !== before && regenerate(wt, feature, label, 'the merge stands, its generated files not made again')) {
    const paths = generatedChanges(wt)
    if (paths.length && tryGit(['add', '--', ...paths], wt) !== null) tryGit(['commit', '--quiet', '-m', `chore(${feature}): regenerate ${paths.join(', ')} after merging ${ref.replace('refs/heads/', '')}`], wt)
  }
  return 'merged'
}

/**
 * A merge stopped on conflicts in `wt`: when every conflicted file is generated, keep this side's —
 * its copy checked out, or the file removed where this side deleted it — run generated.command,
 * stage only generated paths and commit the merge. A file still holding a conflict marker (a command
 * that did not rewrite it) is never committed. → true when committed; false leaves the merge as it
 * was (MERGE_HEAD) for whoever handles a conflict. `label` names the merge in notes.
 */
function resolveGenerated(wt, ref, feature, label = `${feature}'s worktree`) {
  const unmerged = statusOf(wt).filter((e) => /^(DD|AU|UD|UA|DU|AA|UU)$/.test(e.xy))
  const files = unmerged.map((e) => e.path)
  if (!GEN.command || !generatedOnly(files, GEN.paths)) return false
  for (const e of unmerged) {
    // DU / DD / UA: this side has no copy (deleted, or never added) — it stays absent. Every other: this side's copy.
    if (/^(DU|DD|UA)$/.test(e.xy)) tryGit(['rm', '-q', '--cached', '--', e.path], wt) !== null && rmSync(join(wt, e.path), { force: true })
    else tryGit(['checkout', '--ours', '--', e.path], wt)
  }
  if (!regenerate(wt, feature, label, 'the conflict is left to an agent')) return false
  // A path this side deleted is already staged as gone: `git add` of it would fail the whole add.
  const paths = [...new Set([...files, ...generatedChanges(wt)])].filter((p) => existsSync(join(wt, p)) || tryGit(['ls-files', '--error-unmatch', '--', p], wt) !== null)
  const marked = markerIn(wt, paths)
  if (marked) {
    addNote(`${label}: ${marked} still holds a conflict marker after generated.command — the conflict is left to an agent`)
    return false
  }
  // `git add -A --` with no path stages the whole tree: only a non-empty list is added.
  if ((paths.length && tryGit(['add', '-A', '--', ...paths], wt) === null) || tryGit(['commit', '--no-edit', '--quiet'], wt) === null) return false
  addNote(`${label}: merging ${ref.replace('refs/heads/', '')} regenerated ${files.join(', ')} (generated.command) — no agent needed`)
  return true
}

/** The target merged in with no agent: on a conflict, back out and leave it to the lane's sync. */
function mergeTargetQuietly(wt, feature = basename(wt)) {
  if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, 'HEAD'], wt) !== null) return
  if (tryGit(['status', '--porcelain', '--untracked-files=no'], wt) !== '') return
  if (mergeIn(wt, `refs/heads/${TARGET}`, feature) !== 'merged') tryGit(['merge', '--abort'], wt)
}

const RESOLVE_ATTEMPTS = 2
const mergeDone = (wt, ref = `refs/heads/${TARGET}`) =>
  tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) === null &&
  tryGit(['merge-base', '--is-ancestor', ref, 'HEAD'], wt) !== null &&
  tryGit(['diff', '--name-only', '--diff-filter=U'], wt) === ''

/**
 * Hand a conflicted merge of the target to a headless run: it resolves every file keeping both
 * sides, runs the verifier on the apps it touched, and commits the merge. The other side is code that
 * already merged, and this side a spec the human approved — both are settled, so resolving them
 * together is work, not a question for the human. True when the merge is committed; else the last
 * run's log. A run that backed the merge out gets it started again for the next.
 */
async function resolveMerge(feature, wt, why, from = null) {
  const f = fleet.features[feature]
  const scripts = dirname(fileURLToPath(import.meta.url))
  // `from`: a group predecessor's branch (group lanes, D6/D7) instead of the target — the member
  // before this one, whose code this feature builds on.
  const name = from?.branch ?? TARGET
  const ref = `refs/heads/${name}`
  const carries = from
    ? `${name} is ${from.feature}'s branch — the feature before this one in its group lane, which this feature builds on; it carries ${why}, built and reviewed.`
    : `${TARGET} is the branch the builder fleet lands on; it carries ${why}, already merged and verified.`
  let log = null
  for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
    if (tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt) === null && mergeIn(wt, ref, feature) === 'merged') return true
    const files = (tryGit(['diff', '--name-only', '--diff-filter=U'], wt) ?? '').split('\n').filter(Boolean)
    f.runs = (f.runs ?? 0) + 1
    f.reason = `resolving a conflict with ${name} in ${files.length} file(s)`
    save()
    const prompt =
      `A merge of ${name} into this branch (${f.branch}) stopped on conflicts in: ${files.join(', ')}. ` +
      `${carries} This branch carries the feature at --path ${specOf(feature)} — being built unattended to a spec the human approved. ` +
      `Resolve every conflict so BOTH sides keep working: read this feature's SPEC.md (and PLAN.md if it is there) and \`git log -p MERGE_HEAD --not HEAD -- <file>\` for what the other side changed and why; keep both behaviours, and never drop one side to make a conflict go away. ` +
      `Where the two sides really do disagree, choose what keeps the other feature's shipped behaviour and still meets this spec, and write that ruling into the merge commit message. ` +
      `Then commit the merge FIRST — \`git add\` the resolved files and \`git commit\`, so the merge commit keeps both parents: the verifier tests a commit, never the working tree, so before the commit it would test the pre-merge HEAD. ` +
      `Then check it: \`node ${scripts}/verify/verify.mjs request . HEAD --tier phase\` prints a request id; \`node ${scripts}/verify/verify.mjs wait <id>\` in the foreground (Bash timeout 600000), again while it exits 75, until it prints a verdict — and fix every regression it lists as follow-up commits on top of the merge, requesting the phase tier again after them. Never \`git merge --abort\` or reset, never ask a question, and run nothing in the background — nobody is there to answer, and this run ends when your last turn does.`
    const res = await runClaude(wt, feature, 'build', f.runs, prompt)
    log = res.log
    f.log = log
    f.reason = null
    save()
    if (mergeDone(wt, ref)) return true
  }
  return log
}

/** A dependency shipped: queue every child that was waiting only on what has now merged. */
function release() {
  for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'waiting' && !f.groupWait && !pendingDeps(f).length) enqueue(feature)
  pruneGroups()
  releaseGroups()
  save()
}

/**
 * A parked or failed feature, as a fleet leaves it: its worktree goes (the branch keeps every
 * finished task; picking it again recreates it). FLEET_KEEP_STOPPED_WORKTREES=1 keeps them, for
 * looking inside one while debugging the fleet itself.
 */
function settleStopped(feature, f) {
  if (process.env.FLEET_KEEP_STOPPED_WORKTREES === '1') return
  if (!['parked', 'failed'].includes(f.status) || !f.worktree) return
  // A park that sends the human into this worktree ("finish the merge in <wt>") keeps it — and so
  // does one waiting for your walk, which /builder:resume starts in this worktree.
  if ((f.reason ?? '').includes(f.worktree) || YOUR_WALK.test(f.reason ?? '')) return
  const r = clearWorktree(ROOT, f.worktree, feature)
  if (r.stash) addNote(`${feature} ${f.status}; uncommitted changes from its worktree are in stash "${r.stash}" — git stash list`)
  if (r.removed || !existsSync(f.worktree)) {
    f.worktree = null
    dropLaneDb(feature)
    delete f.laneDb
  } else addNote(`${feature} ${f.status}; its worktree ${f.worktree} stays: ${r.why}`)
}

// ---- --land: the needs-you choices (D3) ------------------------------------------------------
const linesOf = (out) => (out ?? '').split('\n').filter(Boolean)
const gitWords = (e) => String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')
const stashName = (feature) => `builder: before landing ${feature}`
/** The stash stack as [{ ref, sha, subject }] — an entry is found by its sha, never by its place. */
const stashes = () => linesOf(tryGit(['stash', 'list', '--format=%gd%x09%H%x09%gs'])).map((l) => {
  const [ref, sha, subject] = l.split('\t')
  return { ref, sha, subject }
})

/**
 * Commit exactly the user's changes: every tracked change, and the untracked files the feature adds
 * too (`overlap`) — never another untracked file, never an ignored one. A refused commit (a hook)
 * puts the index back as it was. → { sha, files } | { sha: null } (nothing to commit) | { error }.
 */
function commitMine(message, overlap) {
  const index = tryGit(['write-tree'])
  if (index === null) return { error: 'git could not read the index' }
  const untracked = new Set(linesOf(tryGit(['ls-files', '--others', '--exclude-standard'])))
  try {
    git(['add', '-u'])
    const extra = overlap.filter((p) => untracked.has(p))
    if (extra.length) git(['add', '--', ...extra])
    if (tryGit(['diff', '--cached', '--quiet']) !== null) return { sha: null }
    git(['commit', '-q', '-m', message])
  } catch (e) {
    tryGit(['read-tree', index])
    tryGit(['update-index', '-q', '--refresh'])
    return { error: `git refused the commit: ${gitWords(e)}` }
  }
  return { sha: tryGit(['rev-parse', '--short', 'HEAD']), files: linesOf(tryGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])) }
}

/** Set every uncommitted change aside (untracked included, ignored never) → { sha } | { sha: null } (nothing to set aside) | { error }. */
function setAside(feature) {
  if (!tryGit(['status', '--porcelain', '--untracked-files=all'])) return { sha: null }
  const before = new Set(stashes().map((s) => s.sha))
  try {
    git(['stash', 'push', '-q', '--include-untracked', '-m', stashName(feature)])
  } catch (e) {
    return { error: `git could not set your changes aside: ${gitWords(e)}` }
  }
  const mine = stashes().find((s) => !before.has(s.sha) && s.subject.endsWith(`: ${stashName(feature)}`))
  return mine ? { sha: mine.sha } : { error: `git set your changes aside but the stash "${stashName(feature)}" can't be found — git stash list` }
}

/**
 * Put a set-aside stash back. Clean → that one entry dropped. Else the stash stays, and the files
 * that need the user: conflicted ones, and untracked ones git could not restore (the feature added
 * the same path, so the user's copy is only in the stash).
 */
function putBack(sha) {
  if (tryGit(['stash', 'apply', '-q', sha]) !== null) {
    const s = stashes().find((x) => x.sha === sha)
    if (s) tryGit(['stash', 'drop', '-q', s.ref])
    return { clean: true }
  }
  const unmerged = linesOf(tryGit(['diff', '--name-only', '--diff-filter=U']))
  const notBack = linesOf(tryGit(['ls-tree', '-r', '--name-only', `${sha}^3`])).filter((p) => {
    const now = existsSync(join(ROOT, p)) ? tryGit(['hash-object', '--', p]) : null
    return now !== tryGit(['rev-parse', `${sha}^3:${p}`])
  })
  return { clean: false, unmerged, notBack, ref: stashes().find((x) => x.sha === sha)?.ref ?? null }
}

/** The words for set-aside changes that came back with conflicts — printed, and kept as a fleet note. */
function conflictReport(feature, sha, back) {
  const short = sha.slice(0, 7)
  const ref = back.ref ?? `the stash "${stashName(feature)}"`
  const files = [...new Set([...back.unmerged, ...back.notBack])]
  return {
    files,
    text: [
      `Your changes came back with conflicts in ${files.length} file${files.length === 1 ? '' : 's'}:`,
      ...back.unmerged.map((p) => `  - ${p} — both sides changed it: resolve the conflict markers`),
      ...back.notBack.filter((p) => !back.unmerged.includes(p)).map((p) => `  - ${p} — not put back (${feature} has its own copy now); yours is in the stash: git show ${short}^3:${p}`),
      ...(files.length ? [] : ['  (git named none — it could not apply the stash at all)']),
      `Nothing of yours was dropped: it is all still in the stash "${stashName(feature)}" (${back.ref ? `${back.ref}, ` : ''}${short}).`,
      'To finish:',
      '  1. resolve those files — keep what you want of both sides',
      ...(back.unmerged.length ? [`  2. git add -- ${back.unmerged.join(' ')}`] : []),
      `  ${back.unmerged.length ? 3 : 2}. git stash drop ${ref}   (stashed since? find it in git stash list by its name first)`,
    ].join('\n'),
  }
}

/**
 * --land <feature> --commit-mine "<message>" | --set-aside, under the fleet's lock: the worktree is
 * made ready first, so nothing of the user's is touched for a landing that can't start; then their
 * changes are committed or set aside, and the feature lands by landNow — the fleet's own path. A
 * landing that fails after a set-aside puts the changes straight back. Exits.
 */
async function landChoice({ feature, mode, message }) {
  const f = fleet.features[feature]
  const was = { reason: f.reason, overlap: f.overlap }
  markUnpark(f)
  f.runsThisTime = 0
  enqueue(feature)
  const at = pool.findIndex((p) => p.feature === feature && p.lane === 'land')
  if (at < 0) {
    pool.length = 0
    walkQueue.length = 0
    const now = fleet.features[feature]
    if (!now) {
      save()
      console.log(`${feature} is already merged into ${TARGET} — nothing to land; your changes are untouched.`)
      process.exit(0)
    }
    // Not ready to land after all: the row goes back as it was, unless enqueue found a reason of its own.
    if (!['parked', 'failed'].includes(now.status) || now.reason === was.reason) Object.assign(now, { status: 'parked', reason: was.reason, ...(was.overlap && { overlap: was.overlap }) })
    delete now.unpark
    settleStopped(feature, now)
    save()
    console.error(`${feature} can't be landed from here: ${parkParts(now.reason ?? '').why || now.status} — your changes are untouched.`)
    process.exit(1)
  }
  pool.splice(at, 1)
  const base = tryGit(['merge-base', `refs/heads/${TARGET}`, `refs/heads/${f.branch}`])
  const overlap = base ? landOverlap(ROOT, base, `refs/heads/${f.branch}`) : []
  const yours = mode === 'commit-mine' ? commitMine(message, overlap) : setAside(feature)
  if (yours.error) {
    Object.assign(f, { status: 'parked', reason: was.reason, ...(was.overlap && { overlap: was.overlap }) })
    settleStopped(feature, f)
    save()
    console.error(`${yours.error}\n${feature} stays parked, and your changes are as you left them.`)
    process.exit(1)
  }
  f.status = RUNNING.land
  save()
  let outcome
  try {
    outcome = await land(feature)
  } catch (e) {
    outcome = park(f, `the landing stopped: ${String(e.message).split('\n')[0]} — next: /builder:fleet ${feature} to retry`)
  }
  const merged = outcome === 'done'
  const lines = []
  let code = merged ? 0 : 1
  if (merged) lines.push(`✓ ${feature} landed on ${TARGET} — merge ${tryGit(['rev-parse', '--short', `refs/heads/${TARGET}`])}.`)
  else lines.push(`✗ ${feature} didn't land: ${parkParts(f.reason ?? '').why || f.status}`)
  if (mode === 'commit-mine')
    lines.push(yours.sha ? `Your changes are committed on ${TARGET} as ${yours.sha} "${message}" (${yours.files.length} file${yours.files.length === 1 ? '' : 's'})${merged ? ', before it' : ' — they stay committed'}.` : 'You had no changes left to commit.')
  else if (yours.sha) {
    const back = putBack(yours.sha)
    if (back.clean) lines.push(`Your changes were set aside ${merged ? 'for it' : 'while it tried'} and are back as you left them; the stash is dropped.`)
    else {
      code = 1
      const r = conflictReport(feature, yours.sha, back)
      lines.push(r.text)
      addNote(`⚠ ${feature}${merged ? ` landed on ${TARGET}, but` : ''} your changes set aside for it came back with conflicts in ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.join(', ') || 'none named'} — resolve them, then git stash drop the stash "${stashName(feature)}" (${yours.sha.slice(0, 7)}); it is kept until you do`)
    }
  } else lines.push('You had no changes to set aside.')
  if (!merged) {
    ensureParkRecord(feature)
    tellStop(feature, f)
    settleStopped(feature, f)
    const { next } = parkParts(f.reason ?? '')
    if (next) lines.push(`next: ${next}`)
  }
  save()
  console.log(lines.join('\n'))
  process.exit(code)
}
if (LAND) await landChoice(LAND)

// Groups are formed from what is on disk now — each row's PLAN.md and declared dependencies — before
// anything is queued, so a member that has planned already waits for the one before it.
regroup()
for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  f.runsThisTime = 0 // a parked or failed feature re-queued here gets a fresh cap
  f.autoUnparks = 0 // and a fresh automatic-retry budget
  enqueue(feature)
}

/**
 * Once, at fleet start: a feature on its way to landing whose branch changes files the human is
 * editing in the target checkout would be refused at the merge. Said now, as a note — not a park:
 * the work goes on, and the edits may be committed or gone by the time it lands. Read-only.
 */
const OVERLAP_NOTE = / will need you to land: /
fleet.notes = (fleet.notes ?? []).filter((n) => !OVERLAP_NOTE.test(n))
if (tryGit(['branch', '--show-current']) === TARGET) {
  for (const [feature, f] of Object.entries(fleet.features)) {
    if (!['queued', 'awaiting-walk', 'awaiting-ship'].includes(f.status) || !f.branch) continue
    const base = tryGit(['merge-base', `refs/heads/${TARGET}`, `refs/heads/${f.branch}`])
    if (!base) continue
    const n = landOverlap(ROOT, base, `refs/heads/${f.branch}`).length
    if (n) addNote(`⚠ ${feature} will need you to land: ${n} file${n === 1 ? '' : 's'} you are editing overlap${n === 1 ? 's' : ''} it — /builder:fleet:status`)
  }
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
    const deps = (Array.isArray(meta.dependsOn) ? meta.dependsOn : []).filter((d) => !landedOn(d))
    const waits = (Array.isArray(meta.waitsOn) ? meta.waitsOn : []).filter((d) => !landedOn(d) && !(meta.dependsOn ?? []).includes(d))
    fleet.features[name] = { status: 'queued', runs: 0, branch, worktree: null, pr: null, reason: null, unpark: true, ...(waits.length && { waitsOn: waits }), ...(deps.length && { dependsOn: deps }) }
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
  if (joining.length) regroup()
  for (const name of joining) enqueue(name)
  if (joining.length) releaseGroups()
  if (joining.length) save()
  return joining.length > 0
}
drainInbox()
// A note about a worktree that is gone (merged, then removed by hand) has nothing left to say.
fleet.notes = (fleet.notes ?? []).filter((n) => {
  const m = /its worktree (\S+) was kept/.exec(n)
  return !m || existsSync(m[1])
})
// Saved HERE, before the first run: --status shows the queue as it is, not as the last run left it.
save()
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('No agent_walk.reset') && !/ was kept \(it has changes\)/.test(n))
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
  if (outcome === 'walk') walkGate(feature) || walkQueue.push(feature)
  else if (outcome === 'ship') shipHold(feature, 'ship') || pool.push({ feature, lane: outcome })
  else if (outcome === 'build') pool.push({ feature, lane: outcome })
  else if (outcome === 'done') release()
  releaseGroups()
}

/**
 * The fleet runs detached, so nothing in a session hears a park: say it in fleet.out (the detached
 * fleet's own output, appended to) as a block a person reads — what, why, next, and the park record.
 * `f` is the row as it parked (autoRetry has already unparked the live one when it retries).
 */
function tellStop(feature, f, retry = null) {
  const { path, committed } = recordOf(feature)
  const record = f.status === 'parked' && existsSync(path) ? (committed ? join(specOf(feature), 'PARKED.md') : path) : null
  // A stop the fleet retries at once waits on no one; any other always says what a person can do.
  const choices = retry ? [] : stopChoices({ feature, status: f.status, reason: f.reason, folder: specOf(feature) })
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(join(DIR, 'fleet.out'), parkBlock({ feature, status: f.status, reason: f.reason, choices, record, branch: committed ? f.branch : null, log: f.log, retry }))
  } catch {}
  if (!retry) desktopNotify(stopNotice({ feature, status: f.status, reason: f.reason, repo: basename(ROOT) }))
}

/**
 * A desktop notification — a stop that waits on a person, a landing, the fleet's end — on macOS
 * (osascript) or Linux (notify-send). The fleet runs detached, and the status line only shows it in a
 * session opened in this repo, so this is how a person working anywhere else hears of it. Best effort
 * and fire-and-forget: a missing tool or a refusal changes nothing; the child outlives the fleet's exit.
 */
function desktopNotify({ title, body }) {
  if (!mayNotify()) return
  const q = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`
  const cmd = process.platform === 'darwin' ? ['osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`]]
    : process.platform === 'linux' ? ['notify-send', [title, body]] : null
  if (!cmd) return
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

async function poolWorker() {
  for (;;) {
    if (closing) return
    if (pool.length) {
      const { feature, lane } = pool.shift()
      // Landed with its group while it waited in the queue.
      if (!fleet.features[feature]) continue
      // A member queued to ship when its group was all signed off: one may have gone back since.
      if (lane !== 'build' && shipHold(feature, lane)) {
        wakeAll()
        continue
      }
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
        const moved = why || lane !== 'ship' ? null : signoffMoved(feature, fleet.features[feature])
        if (!why && lane === 'ship' && !moved) delete fleet.features[feature].humanSignoffMoved
        if (why) outcome = park(fleet.features[feature], why)
        else if (moved) outcome = walkAgain(feature, fleet.features[feature], moved)
        else {
          if (lane === 'ship') await quickCheck(feature)
          outcome = await drive(feature, lane)
        }
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
    const tokens = Object.fromEntries(Object.entries(t.tokens ?? {}).map(([k, v]) => [k, share(v)]))
    if (t.tokens?.byModel) tokens.byModel = Object.fromEntries(Object.entries(t.tokens.byModel).map(([m, u]) => [m, Object.fromEntries(Object.entries(u).map(([k, v]) => [k, share(v)]))]))
    // The meter is kept whole; meterTotals divides it by `shared`, so the batch is counted once across its features.
    ;(fx.timing ??= []).push({ ...t, ms: share(t.ms), shared: features.length, tokens })
  }
  save()
}

/** A walk batch's features as units — each group's members together, in group order; anything else alone. */
function unitsOf(features) {
  const units = []
  for (const x of features) {
    const id = fleet.features[x]?.group
    const u = id && units.find((y) => fleet.features[y[0]]?.group === id)
    if (u) u.push(x)
    else units.push([x])
  }
  for (const u of units) {
    const g = groupOf(u[0])
    if (g) u.sort((x, y) => g.members.indexOf(x) - g.members.indexOf(y))
  }
  return units
}
const branchRef = (feature) => `refs/heads/${fleet.features[feature].branch}`
/** What a unit merges into the walk tree (D8a): each member not already held by a later one — once chained, the tip alone. */
const headsOf = (unit) => unit.filter((x, i) => !unit.slice(i + 1).some((y) => tryGit(['merge-base', '--is-ancestor', branchRef(x), branchRef(y)]) !== null))

/**
 * The walk worktree: the target with each batched unit merged in, in order — a feature alone, or a
 * group by the branches its later members don't already hold (D8a; once chained, just the tip). A
 * unit that won't merge is backed out whole and sorted by what it conflicts with, so a batch is
 * never requeued unchanged:
 *   stale     — a branch it merges conflicts with the target itself; walkBatch syncs that branch
 *               (an agent resolves the conflict) and puts the unit back first in line. Deferring it
 *               would hand the walk lane the same batch again, and the lane spun every few seconds
 *               with no agent running.
 *   deferred  — it conflicts only with a unit merged before it in this batch: it waits for the
 *               next batch (first in line). The others walk, so that is progress.
 *   stuck     — it conflicts with neither, and nothing merged before it: it parks.
 * stale is [{ unit, sync }] (the branches to sync), stuck [{ unit, head }]; merged and deferred are
 * features. Untracked files — agent_walk.copy's `.env` — survive the reset. Throws when setup or sync fails.
 */
function prepareWalkTree(features) {
  if (!existsSync(WALK_WT)) {
    mkdirSync(WORKTREES, { recursive: true })
    tryGit(['worktree', 'prune'])
    git(['worktree', 'add', '-f', '-B', WALK_BRANCH, WALK_WT, `refs/heads/${TARGET}`])
    copyInto(WALK_WT)
    if (AW.setup) runSetup('_walk', WALK_WT)
  } else {
    git(['reset', '--hard', '--quiet', `refs/heads/${TARGET}`], WALK_WT)
    // An earlier batch's untracked generated outputs: never carried into this one's commits (D15).
    if (GEN.command && GEN.paths.length) for (const e of statusOf(WALK_WT)) if (e.xy === '??' && isGenerated(e.path)) rmSync(join(WALK_WT, e.path), { force: true, recursive: true })
  }
  const merged = []
  const deferred = []
  const stale = []
  const stuck = []
  for (const unit of unitsOf(features)) {
    const at = git(['rev-parse', 'HEAD'], WALK_WT)
    const heads = headsOf(unit)
    const failed = heads.find((x) => {
      if (tryGit(['merge', '--no-ff', '--no-edit', '-m', `walk batch: ${x}`, branchRef(x)], WALK_WT) !== null) return false
      // Two batch members that both regenerated a lockfile walk together: it is made again here (D15).
      if (tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], WALK_WT) !== null && resolveGenerated(WALK_WT, branchRef(x), '_walk', 'the walk batch')) return false
      tryGit(['merge', '--abort'], WALK_WT)
      return true
    })
    if (!failed) {
      merged.push(...unit)
      continue
    }
    git(['reset', '--hard', '--quiet', at], WALK_WT)
    const sync = heads.filter((x) => conflictsWithTarget(branchRef(x)))
    if (sync.length) stale.push({ unit, sync })
    else if (merged.length) deferred.push(...unit)
    else stuck.push({ unit, head: failed })
  }
  if (AW.sync && merged.length) {
    const log = join(DIR, 'logs', '_walk-sync.log')
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'w')
    try {
      execSync(fill(AW.sync, '_walk'), { cwd: WALK_WT, env: envFor('_walk', 'build'), stdio: ['ignore', fd, fd], timeout: 30 * 60 * 1000 })
    } catch {
      throw new Error(`agent_walk.sync failed in the walk worktree — see ${log}`)
    } finally {
      closeSync(fd)
    }
  }
  // Each batch's database from nothing, on the batch's merged branches: their migrations are in it.
  // One feature walks in its own worktree (walkBatch's one()), so only a real batch needs _walk's.
  if (merged.length >= 2) prepareLaneDb('_walk', WALK_WT)
  return { merged, deferred, stale, stuck }
}

/**
 * A group's members, before the group walks (D7, D8). A paused member parks, and the rest go back
 * to the barrier to wait for it. The stack is re-chained (chainGroup) from the unit's first member;
 * a merge no agent resolves parks every member, with the same reason. Then each member is settled
 * (afterChain): one whose sign-off still holds, or a human's, goes back to waiting to ship; an agent
 * sign-off that moved is walked again. Last, its tip-most walking member is synced with the target
 * when its state asks for it (SYNC_BEFORE_WALK) — the tip carries the target for the whole group.
 * → the members that walk now.
 */
async function prepareUnit(unit) {
  const g = groupOf(unit[0])
  const paused = unit.filter((x) => existsSync(pauseFile(x)))
  if (paused.length) {
    for (const x of paused) route(x, park(fleet.features[x], PARK_REASONS.revising(specOf(x))))
    for (const x of unit.filter((y) => !paused.includes(y))) route(x, 'walk')
    return []
  }
  const heads = Object.fromEntries(g.members.map((m) => [m, fleet.features[m]?.worktree && existsSync(fleet.features[m].worktree) ? tryGit(['rev-parse', 'HEAD'], fleet.features[m].worktree) : null]))
  const broke = (await chainGroup(g.id, Math.max(0, g.members.indexOf(unit[0]) - 1))).find((c) => c.why)
  if (broke) {
    for (const x of new Set([broke.feature, ...unit])) {
      const fx = fleet.features[x]
      delete fx.groupWait
      for (let j = pool.length - 1; j >= 0; j--) if (pool[j].feature === x) pool.splice(j, 1)
      route(x, x === broke.feature ? 'parked' : park(fx, broke.why))
    }
    return []
  }
  const walk = []
  for (const x of unit) {
    const i = g.members.indexOf(x)
    // The first member takes no chain, but F4's guard still applies to it (afterChain runs it for the rest).
    const out = i > 0 ? afterChain(x, heads[x], g.members[i - 1]) : unwalkedSignoff(x, fleet.features[x]) === 'parked' ? 'parked' : null
    if (out) route(x, out)
    else walk.push(x)
    // A member that parked here holds the members after it (they stack on it): back to the barrier.
    if (out === 'parked') {
      for (const y of unit.slice(unit.indexOf(x) + 1)) route(y, 'walk')
      break
    }
  }
  const last = walk.at(-1)
  const fl = last && fleet.features[last]
  const text = last && readManifest(fl.worktree, last)
  if (text && SYNC_BEFORE_WALK.has(parseManifest(text).state)) {
    const why = await syncTarget(fl.worktree, 'what other features merged', last)
    if (why) {
      for (const x of walk) route(x, park(fleet.features[x], why))
      return []
    }
  }
  return walk
}

/**
 * A `built` feature's `ready: yes <sha>` is void once the target merged into it (a code commit since
 * that sha), and the batch walk would refuse it as not walkable. Back to `building` with ready
 * pending: the batch's own readiness (agent-walk §Batched walks, steps 1–2) re-earns it on the merged
 * code. → null, or why it could not be set.
 */
function rearmReadiness(feature, f, merged = TARGET) {
  const folder = specOf(feature)
  const text = readManifest(f.worktree, feature)
  if (!text || parseManifest(text).state !== 'built') return null
  const script = join(dirname(fileURLToPath(import.meta.url)), 'advance.mjs')
  try {
    execFileSync(process.execPath, [script, folder, '--set', 'state=building', '--set', `ready=pending "${merged} merged in for the walk batch"`, '--commit', `chore({key}): {feature} — ${merged} merged in, walk readiness again`], { cwd: f.worktree, stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (e) {
    return `${merged} was merged into it for the walk batch, but its walk readiness could not be reset: ${String(e.stderr || e.message).trim().split('\n').pop()} — next: /builder:agent ${feature}`
  }
}

/** Whether `branch` conflicts with the target itself — a merge of the two, in memory, that stops. */
const conflictsWithTarget = (branch) => tryGit(['merge-tree', '--write-tree', `refs/heads/${TARGET}`, branch]) === null

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

/** How long the ship lane's quick check waits on the merge tier (seconds) — time, not tokens. */
const QUICK_WAIT_S = Number(process.env.FLEET_QUICK_WAIT_S) || 1800

/**
 * The ship lane's check after sign-off. Verify is optional after sign-off, and the fleet uses the
 * quick check in place of the full /builder:verify: verify-quick.mjs — one script, no model — reads
 * (or waits on) the held merge tier and the spec's mechanical items. PASS records `verify: QUICK …`
 * and commits it on the branch (registry only, so the held run still carries). Gaps are advice: a
 * note, and the ship goes on — the merge queue at landing still tests the merged result. Nothing to do
 * when a verify is already recorded (READY, QUICK, SKIPPED) or the feature is not signed off.
 */
async function quickCheck(feature) {
  const f = fleet.features[feature]
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  if (mf.state !== 'signed-off' || /^(READY|QUICK|SKIPPED)\b/.test(mf.verify ?? '')) return
  // A group's one merge tier is its tip's (D8): a member before the tip would ask for one of its own
  // on code the tip's run already tests, so only the tip is quick-checked, under the group's merge.
  const g = groupOf(feature)
  const live = g ? liveMembers(g) : [feature]
  if (live.length > 1 && live.at(-1) !== feature) return
  f.reason = 'quick check: the merge tier and the spec, by script'
  save()
  const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-quick.mjs')
  const message = mergeMessage(live.length > 1 ? live : [feature])
  const r = await execAsync(process.execPath, [script, join(f.worktree, specOf(feature)), '--max-wait', String(QUICK_WAIT_S), '--message', message], { cwd: f.worktree, env: envFor(feature, 'build') })
  f.reason = null
  const verdict = /^QUICK CHECK: .*$/m.exec(r.output)?.[0]
  if (!verdict) addNote(`${feature}: the quick check could not run (exit ${r.status}: ${r.output.trim().split('\n').pop() ?? ''}) — shipped without it`)
  else if (r.status !== 0) addNote(`${feature}: ${verdict} — shipped anyway (a quick check's gaps are advice): ${r.output.split('\n').filter((l) => l.startsWith('✗ ')).map((l) => l.slice(2)).join(' · ')}`)
  save()
}

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
  for (const unit of unitsOf(batch)) {
    // A group walks as a unit (D8): re-chained, its sign-offs settled, its tip synced first.
    if (groupOf(unit[0])?.members.length > 1) {
      for (const x of await prepareUnit(unit)) {
        fleet.features[x].status = 'walking'
        live.push(x)
      }
      save()
      continue
    }
    const [feature] = unit
    const f = fleet.features[feature]
    if (parkIfPaused(f, feature)) {
      route(feature, 'parked')
      continue
    }
    // F4: a sign-off nobody walked goes back to building + pending — what the batch's readiness step takes.
    if (unwalkedSignoff(feature, f) === 'parked') {
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
  // A unit parks whole: a group's members walk together or not at all.
  for (const { unit, head } of tree.stuck)
    for (const x of unit) route(x, park(fleet.features[x], `it would not merge into the walk worktree, though it conflicts with neither ${TARGET} nor another feature in the batch — next: run git merge ${fleet.features[head].branch} on ${TARGET} in a scratch worktree to see what stops it, then /builder:agent`))
  // A stale unit's conflicting branch — a group's tip, once chained — is synced with the target now
  // (an agent resolves the conflict), and the unit goes back first in line, so the next batch merges
  // it. A sync that does not bring the target in parks the unit, every member with the same reason.
  const synced = []
  for (const { unit, sync } of tree.stale) {
    let why = null
    for (const feature of sync) {
      const f = fleet.features[feature]
      why =
        (await syncTarget(f.worktree, `the walk batch could not merge it: it conflicts with ${TARGET}`, feature)) ??
        (tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, `refs/heads/${f.branch}`]) === null
          ? `it conflicts with ${TARGET}, and merging ${TARGET} into it did not go in (uncommitted changes in ${f.worktree}?) — next: merge ${TARGET} into ${f.branch} and commit it, then /builder:agent`
          : null) ??
        rearmReadiness(feature, f)
      if (why) break
    }
    if (why) for (const x of unit) route(x, park(fleet.features[x], why))
    else synced.push(...unit)
  }
  for (const feature of [...synced, ...tree.deferred].reverse()) {
    Object.assign(fleet.features[feature], { status: 'awaiting-walk', reason: null })
    walkQueue.unshift(feature)
  }
  if (tree.merged.length < 2) return one(tree.merged)
  // Requested only now, for what merged: a stale feature's HEAD is about to be replaced by its sync,
  // and one walked alone (walkOne) requests its own.
  for (const unit of unitsOf(tree.merged)) requestWalkMerge(unit[0], unit)
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
      // An env that died during the session: restart it.
      if (AW.smoke && rec.startPgid && !(await smokeOk('_walk', rec))) {
        addNote('the walk env stopped answering during a batch session — restarted without a reset')
        restart = true
      }
      // Walk fixes on a member send its group back to building from there (D8): the members after it
      // stop walking here — they would sign off code about to change — and wait at the barrier.
      const back = []
      for (const [x, d] of leaving) {
        const g = d.action === 'handoff' && d.to === 'build' ? groupOf(x) : null
        for (const y of g ? g.members.slice(g.members.indexOf(x) + 1) : [])
          if (next.includes(y)) {
            next.splice(next.indexOf(y), 1)
            back.push(y)
          }
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
      for (const y of back) route(y, 'walk')
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
    if (!hook(AW.stop, WALK_WT, '_walk')) addNote(`agent_walk.stop failed after a walk batch: ${fill(AW.stop, '_walk')}`)
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
      const r = await execAsync('sh', ['-c', fill(AW.setup, '_envcheck')], { cwd: ENVCHECK_WT, env: envFor('_envcheck', 'build') })
      writeFileSync(log, r.output)
      if (r.status !== 0) throw new Error(`setup failed — see ${log}`)
    }
    // Off the event loop, as setup is: a migration can take minutes, and the lanes run meanwhile.
    await prepareLaneDbAsync('_envcheck', ENVCHECK_WT)
    const empty = Object.entries(AW.env ?? {}).filter(([, v]) => !fill(String(v), '_envcheck').trim()).map(([k]) => k)
    if (empty.length) why = `agent_walk.env leaves ${empty.join(', ')} empty`
    else if (!(await startWalkEnv('_envcheck', rec))) why = `start/smoke failed — see ${rec.startLog}`
  } catch (e) {
    why = e.message.split('\n')[0]
  } finally {
    await killStart(rec)
    if (AW.stop) hook(AW.stop, ENVCHECK_WT, '_envcheck')
    tryGit(['worktree', 'remove', '--force', ENVCHECK_WT])
    dropLaneDb('_envcheck')
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
      // A batch takes whole groups (D8): a group bigger than agent_walk.batch walks alone.
      const { batch, rest } = takeWalkBatch(walkQueue, Object.fromEntries(Object.entries(fleet.features).filter(([, f]) => f.group).map(([n, f]) => [n, f.group])), BATCH)
      walkQueue.splice(0, walkQueue.length, ...rest)
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
if (SHARED_DB) addNote(SHARED_DB_NOTE)
reapLaneDbs()
envCheck = envPreflight().catch((e) => addNote(`walk env launch check: ${e.message}`))
// A member queued before the rest of its group had worktrees waits at the barrier: the group is
// all queued now, so whatever waits on it is checked once more before the lanes start.
releaseGroups()
do {
  closing = false
  await Promise.all([...Array.from({ length: PARALLEL }, poolWorker), walkLane()])
} while (drainInbox())
clearInterval(poll)

// Whatever still waits, waits on something that parked or failed: say which, so the table explains it.
for (const [feature, f] of Object.entries(fleet.features))
  if (['waiting', 'awaiting-walk'].includes(f.status) && f.groupWait) {
    const { until, on, group } = f.groupWait
    // At the barrier, what it waits on is every member not ready for the group's walk, as of now.
    const not = until === 'walk' ? (fleet.groups?.[group]?.members ?? on).filter((d) => d !== feature && !walkReady(d, feature)) : on.filter((d) => !reached(until, d))
    // At the barrier, members already built are not ready for another reason (parked, in a run).
    const what = until === 'walk' && not.length && not.every(isBuilt) ? "to be ready for the group's walk" : { built: 'to build first', walk: 'to build first', 'signed-off': 'to sign off first', ready: 'to be ready to land', landed: 'to land first' }[until]
    Object.assign(f, { status: 'parked', reason: `waits on ${not.map((d) => `${d} (${fleet.features[d]?.status ?? 'not in the fleet'})`).join(', ')} ${what} (group ${group}), which ${not.length > 1 ? 'they' : 'it'} never did — next: settle ${not.join(', ')}, then pick both in /builder:agent` })
    delete f.groupWait
    tellStop(feature, f)
  } else if (f.status === 'waiting') {
    Object.assign(f, { status: 'parked', reason: `waits on ${pendingDeps(f).map((d) => `${d} (${fleet.features[d]?.status ?? 'not in the fleet'})`).join(', ')}, which never merged — next: settle ${pendingDeps(f).join(', ')}, then pick both in /builder:agent` })
    tellStop(feature, f)
  }
// An unfinished feature keeps its branch — every finished task is committed there — and loses its
// worktree; picking it again recreates the worktree from the branch. FLEET_KEEP_STOPPED_WORKTREES=1
// keeps them, for looking inside one while debugging the fleet itself.
for (const [feature, f] of Object.entries(fleet.features)) settleStopped(feature, f)
pruneGroups()
// The walk worktree and its branch are the batches' scratch, never merged: gone when the fleet is.
if (existsSync(WALK_WT)) {
  tryGit(['worktree', 'remove', '--force', WALK_WT])
  tryGit(['branch', '-D', WALK_BRANCH])
  dropLaneDb('_walk')
}
reapLaneDbs()
delete fleet.walkBatch
// The whole repo, not just this fleet's rows: anything else left lying around is named here too.
// The fleet is ending: it no longer keeps the Mac awake, whichever way that went.
fleet.notes = withoutAwake(fleet.notes).filter((n) => !n.startsWith('repo: '))
addNote(summaryLine(inventory(ROOT, CFG, TARGET, { fleet, lockAlive: false })))
save()
unlock()
// The run is over: say so wherever the person is — the session that launched it may be long gone.
const ended = (s) => Object.entries(fleet.features).filter(([, f]) => f.status === s).map(([n]) => n).sort()
desktopNotify(endNotice({ repo: basename(ROOT), landed: fleet.landedThisRun ?? [], parked: ended('parked'), failed: ended('failed') }))
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
