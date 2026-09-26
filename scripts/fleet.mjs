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
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { requireConfig } from './config.mjs'
import { parseManifest } from './manifest.mjs'
import { laneOf, decide, loadFleet, saveFleet, fleetDir } from './fleet-core.mjs'

const RUN_CAP = 12
const RUN_TIMEOUT_MS = Number(process.env.FLEET_RUN_TIMEOUT_MS) || 45 * 60 * 1000
const CLAUDE = process.env.FLEET_CLAUDE || 'claude'

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

/** The branch a feature runs on: the one it is already underway on, else a fresh builder/<feature>. */
function branchOf(feature, mf) {
  const own = mf.branch && mf.branch !== 'none' ? mf.branch : null
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

function ensureWorktree(feature, branch) {
  const problem = worktreeProblem(feature, branch)
  if (problem) throw new Error(problem)
  const wt = join(WORKTREES, feature)
  if (existsSync(wt)) return wt
  mkdirSync(WORKTREES, { recursive: true })
  const exists = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null
  git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, 'HEAD'])
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
for (const feature of asked) {
  if (fleet.features[feature]) continue // already in the fleet — resumed below
  const why = preflight(feature)
  if (why) refused[feature] = why
  else fresh.push(feature)
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
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'))
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch (e) {
    alive = e.code === 'EPERM'
  }
  if (alive) {
    console.error(`Another fleet is running in this repo (pid ${pid}). Stop it, or wait for it.`)
    process.exit(3)
  }
  console.error(`note: taking over a stale fleet lock (pid ${pid} is gone)`)
}
writeFileSync(LOCK, String(process.pid))
const unlock = () => {
  try {
    unlinkSync(LOCK)
  } catch {}
}
const save = () => saveFleet(ROOT, fleet)
const active = new Set()
const stopAll = (code) => {
  for (const c of active) {
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {}
  }
  save()
  unlock()
  process.exit(code)
}
process.on('SIGINT', () => stopAll(130))
process.on('SIGTERM', () => stopAll(143))

for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null }

// ---- one claude run ------------------------------------------------------------------------
function runClaude(wt, feature, lane, n) {
  const prompt = `/builder:resume --path ${specOf(feature)} --agent-walk${lane === 'build' ? ' --no-dev-env' : ''}`
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  // The child must read ITS worktree's config and manifests — never the main checkout's.
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  return new Promise((done) => {
    const out = createWriteStream(log)
    let settled = false
    let timedOut = false
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(child)
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
    f.runs = (f.runs ?? 0) + 1
    save()
    const { exit, log } = await runClaude(f.worktree, feature, lane, f.runs)
    f.log = log
    const d = decide({
      lane,
      manifestText: readManifest(f.worktree, feature),
      exit,
      failures,
      runs: f.runs,
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

/** A config hook (reset/stop) in the worktree. False when it failed. */
function hook(cmd, cwd) {
  if (!cmd) return true
  try {
    execSync(cmd, { cwd, stdio: 'ignore', timeout: 10 * 60 * 1000 })
    return true
  } catch {
    return false
  }
}

async function walkOne(feature) {
  const f = fleet.features[feature]
  f.status = 'walking'
  save()
  try {
    if (!hook(AW.reset, f.worktree)) {
      Object.assign(f, { status: 'parked', reason: `agent_walk.reset failed: ${AW.reset}` })
      save()
      return
    }
    await drive(feature, 'walk')
  } finally {
    if (!hook(AW.stop, f.worktree)) {
      fleet.notes = [...new Set([...(fleet.notes ?? []), `agent_walk.stop failed after ${feature}: ${AW.stop}`])]
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const buildQueue = []
const walkQueue = []
for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  try {
    f.worktree = ensureWorktree(feature, f.branch)
  } catch (e) {
    Object.assign(f, { status: 'failed', reason: `worktree: ${e.message.split('\n')[0]}` })
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
