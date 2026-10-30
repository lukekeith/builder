#!/usr/bin/env node
/**
 * bench-case — one archived case end to end: an already-merged feature's spec run again through the
 * fleet, in a scratch clone of its project at the feature's base commit, on the builder under test.
 * Design: docs/specs/2026-10-29-benchmark-suite-design.md.
 *
 *   node scripts/bench-case.mjs <case-id> --builder <checkout> --out <dir> [--clone-root <dir>] [--dry-run]
 *
 * Reads $BENCH_LOCAL/cases/<id>.json and $BENCH_LOCAL/projects/<project>.json. Writes <out>/result.json
 * and exits 0 whether the case landed or not; exits 2 on a refusal, the reasons on stderr. Every
 * refusal comes before the clone is made, and nothing ever writes into the project repo. The clone is
 * <clone-root>/clone, outside every repo (a repo's CLAUDE.md would load into every session); the
 * clone root defaults to $BENCH_TMP/<out's parent's name>/<out's name>.
 *
 * Setup, fleet and teardown run in the profile's `env`, never the shell's DATABASE_URL, DIRECT_URL,
 * TEST_DATABASE_URL, SUPABASE_DB_URL, REDIS_URL / _HOST / _PORT, MONGODB_URI, MONGO_URL, PG*, POSTGRES_*, MYSQL_* or DB_*. After the fleet — on every path — the profile's `teardown` runs in the clone
 * and whatever its `setup` started is stopped; once result.json is written the clone is removed (BENCH_KEEP_CLONES=1 keeps it).
 * SIGTERM stops the case: the fleet and every group it records, the setup's group, then the teardown,
 * and result.json says `failed: stopped`.
 *
 * Env: BENCH_LOCAL (<builder>/bench/local), BENCH_TMP ($TMPDIR/bench-suite), BENCH_FLEET (the fleet script — tests point it at a stub),
 * BENCH_CASE_FLEET_TIMEOUT_MS (24h, the fleet's whole run; the suite passes 3× the estimate), BENCH_SETUP_TIMEOUT_MS (20 min, the
 * profile's setup and teardown), BENCH_CASE_KILL_GRACE_MS (10s, SIGTERM to SIGKILL on a timeout or a stop),
 * BENCH_KEEP_CLONES, BENCH_INSTALLED_PLUGINS (as bench.mjs).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, openSync, closeSync, realpathSync, rmSync, rmdirSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { applyProfile, safetyRefusals, textRefusals, portsNamed, measureFromRow, estimateFromRow, profileEnv, caseEnv, envLines, walkClaudeArgs, applyReplacements, ownClaudeArgs, bodyWarnings, frontMatterText, mcpConfigs, mcpScanText, agentWalkValue } from './bench-suite-core.mjs'
import { featureRange } from './bench-replay-core.mjs'
import { landedRow } from './fleet-core.mjs'
import { BUILDER, disabledPlugins, fleetRecord } from './bench.mjs'

const FLEET_TIMEOUT_MS = Number(process.env.BENCH_CASE_FLEET_TIMEOUT_MS) || 24 * 60 * 60 * 1000
const SETUP_TIMEOUT_MS = Number(process.env.BENCH_SETUP_TIMEOUT_MS) || 20 * 60 * 1000
const KILL_GRACE_MS = Number(process.env.BENCH_CASE_KILL_GRACE_MS) || 10 * 1000
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (cwd, ...a) => sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...a], cwd)
const tryGit = (cwd, ...a) => {
  try {
    return git(cwd, ...a)
  } catch {
    return null
  }
}
/** A git failure's own words: its stderr's first line, else the message's. */
const why = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0].replace(/^fatal:\s*/, '')
const lineCount = (s) => (s ? s.replace(/\n$/, '').split('\n').length : 0)
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

/** A path with symlinks resolved, though it may not exist yet (its nearest existing ancestor is resolved). */
function real(p) {
  const abs = resolve(p)
  let head = abs
  const tail = []
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length).replace(/^[/\\]/, ''))
    head = dirname(head)
  }
  return join(realpathSync.native(head), ...tail)
}
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
/** The root clones go under: $BENCH_TMP, else $TMPDIR/bench-suite — outside every repo. */
export const benchTmp = () => process.env.BENCH_TMP || join(tmpdir(), 'bench-suite')
/** The git work tree a path (which may not exist yet) would be inside, or null. */
function gitTop(p) {
  let head = p
  while (!existsSync(head) && dirname(head) !== head) head = dirname(head)
  return tryGit(head, 'rev-parse', '--show-toplevel')
}

/** The TCP ports listening now; no lsof or no output is []. */
export function listeningPorts() {
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (r.error || !r.stdout) return []
  return [...new Set([...r.stdout.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1])))]
}

/** A process's group id, or null when ps can't say. */
const pgidOf = (pid) => {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  const n = Number(r.stdout?.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
let protectedGroups = null
/**
 * True when a process group may be signalled: an integer above 1 (kill(-1) signals every process the
 * user owns), and neither this process's own group nor its parent's. When ps can't tell those groups,
 * nothing may be.
 */
export function killableGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  protectedGroups ??= [pgidOf(process.pid), pgidOf(process.ppid)]
  if (protectedGroups.some((g) => g == null)) return false
  return !protectedGroups.includes(pgid)
}
const killGroup = (pgid, sig) => {
  if (!killableGroup(pgid)) return
  try {
    process.kill(-pgid, sig)
  } catch {}
}
/** True while a process group still has a member. */
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/**
 * True when a recorded group still belongs to this case: a member's command line or cwd is inside the
 * clone or the fleet's worktrees (<clone>.fleet). A group that has died may have had its id reused hours
 * later — by another lane's fleet, by the human's dev server — and must never be signalled on a record alone.
 */
export function groupOwnedBy(pgid, clone) {
  if (!clone) return false
  const roots = [clone, `${clone}.fleet`]
  const inside = (s) => roots.some((r) => s === r || s.includes(`${r}/`) || s.endsWith(r) || s.includes(`${r} `))
  const rows = (spawnSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' }).stdout ?? '').split('\n')
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row)
    if (!m || Number(m[2]) !== pgid) continue
    if (inside(m[3])) return true
    const cwd = (spawnSync('lsof', ['-a', '-d', 'cwd', '-p', m[1], '-Fn'], { encoding: 'utf8' }).stdout ?? '').split('\n').find((l) => l.startsWith('n'))?.slice(1)
    if (cwd && roots.some((r) => within(cwd, r))) return true
  }
  return false
}
/** A recorded group signalled only when killableGroup allows it and it still belongs to the clone; otherwise why not is logged. */
function killOwnedGroup(pgid, sig, clone) {
  if (!killableGroup(pgid) || !groupAlive(pgid)) return false
  if (!groupOwnedBy(pgid, clone)) {
    console.error(`not signalling process group ${pgid}: no member runs in the clone ${clone} — its id may have been reused`)
    return false
  }
  killGroup(pgid, sig)
  return true
}
/** A recorded group (never one this case spawned and still holds) stopped: SIGTERM, then SIGKILL once the grace period passes with any member left — each only while it still belongs to the clone. */
async function stopGroup(pgid, clone) {
  if (!killOwnedGroup(pgid, 'SIGTERM', clone)) return
  for (const t0 = Date.now(); groupAlive(pgid) && Date.now() - t0 < KILL_GRACE_MS; ) await new Promise((r) => setTimeout(r, 100))
  killOwnedGroup(pgid, 'SIGKILL', clone)
}

// ---- stopping: SIGTERM (bench-suite.mjs stop) stops every group running now ----
let stopping = false
const running = new Set()
/** True once this process got SIGTERM: nothing new starts but the teardown. */
export const stopRequested = () => stopping
/** SIGTERM / SIGINT / SIGHUP: stop each running group (as a timeout would) — the CLI then tears down and writes `failed: stopped`. */
export function onStopSignal() {
  stopping = true
  for (const stop of [...running]) stop()
}

/**
 * A command in its own process group, awaited, its output in `log`. Past timeoutMs, or on a stop, the
 * group gets SIGTERM, then SIGKILL after the grace period; `onTimeout` runs at the SIGKILL. With `reap`,
 * whatever the group still holds when the command exits is killed too. → { status, timedOut, stopped, error, pgid }
 */
export function runGroup(cmd, args, { cwd, env, log, timeoutMs, reap = false, onTimeout = () => {} }) {
  return new Promise((done) => {
    const fd = openSync(log, 'w')
    let timedOut = false
    let stopped = false
    let settled = false
    let grace = null
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true })
    const hardKill = () => {
      killGroup(child.pid, 'SIGKILL')
      onTimeout()
    }
    const cut = () => {
      if (settled || grace) return
      killGroup(child.pid, 'SIGTERM')
      grace = setTimeout(hardKill, KILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      cut()
    }, timeoutMs)
    const stop = () => {
      stopped = true
      cut()
    }
    running.add(stop)
    const finish = (status, error) => {
      if (settled) return
      settled = true
      running.delete(stop)
      clearTimeout(timer)
      clearTimeout(grace)
      if (timedOut || stopped) hardKill()
      else if (reap) killGroup(child.pid, 'SIGKILL')
      closeSync(fd)
      done({ status, timedOut, stopped, error, pgid: child.pid })
    }
    child.on('error', (e) => finish(null, e))
    child.on('exit', (code) => finish(timedOut || stopped ? null : (code ?? 1)))
  })
}

/** The leading commits of `commits` whose changed files are all under <registry>/<feature>/, stopping at the first that touches anything else. */
export function specCommits(repo, registry, feature, commits) {
  const dir = `${registry.replace(/\/+$/, '')}/${feature}/`
  const out = []
  for (const c of commits) {
    const files = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', c).split('\n').filter(Boolean)
    if (!files.length || files.some((f) => !f.startsWith(dir))) break
    out.push(c)
  }
  return out
}

/** A placed file's text, or null for a binary (a NUL in its first 8 KB) or an unreadable one — a binary is not scanned. */
const textOf = (f) => {
  try {
    const b = readFileSync(f)
    return b.subarray(0, 8192).includes(0) ? null : b.toString('utf8')
  } catch {
    return null
  }
}

/** The agent_walk block of a config's front matter, as its lines. */
const agentWalkLines = (md) => {
  const fm = (/^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? '').split('\n')
  const at = fm.findIndex((l) => /^agent_walk:/.test(l))
  if (at < 0) return []
  const out = []
  for (const l of fm.slice(at + 1)) {
    if (l.trim() && !/^\s/.test(l)) break
    if (l.trim()) out.push(l.trim())
  }
  return out
}

/**
 * Everything a case needs, worked out from the repo without writing anything: refusals (the run must
 * not start), else a prep failure (the merge can't be resolved), else the plan for the clone.
 */
export function planCase({ profile, profileDir = '.', caseDef, builder, dest, out, listening = [] }) {
  const refusals = []
  const feature = caseDef?.feature
  if (!feature) refusals.push('case has no feature')
  if (caseDef?.kind && caseDef.kind !== 'archived') refusals.push(`case kind ${caseDef.kind} is not archived`)
  if (!profile?.repo) return { refusals: [...refusals, 'profile has no repo'] }
  const repo = resolve(profileDir, profile.repo)
  if (!tryGit(repo, 'rev-parse', '--git-dir')) return { refusals: [...refusals, `profile repo ${repo} is not a git repo`] }
  const root = real(repo)
  const clone = real(dest)
  if (/\s/.test(clone)) refusals.push(`the clone's path must contain no whitespace (the fleet splits claude_args on whitespace): ${clone}`)
  if (/\s/.test(builder)) refusals.push(`the builder's path must contain no whitespace (the fleet splits claude_args on whitespace): ${builder}`)
  if (within(clone, root)) refusals.push(`the clone ${clone} is inside the project repo — pick a --clone-root outside it`)
  else {
    const top = gitTop(clone)
    if (top) refusals.push(`the clone ${clone} would be inside the git repo ${top} — its CLAUDE.md would load into every session; pick a --clone-root outside any repo`)
  }
  if (out && within(real(out), root)) refusals.push(`the --out ${real(out)} is inside the project repo — pick an --out outside it`)
  if (within(root, clone)) refusals.push(`the project repo is inside the clone's path ${clone}`)
  if (existsSync(clone)) refusals.push(`${clone} already exists — pick a fresh --out`)
  const fleet = process.env.BENCH_FLEET || join(builder, 'scripts', 'fleet.mjs')
  if (!existsSync(fleet)) refusals.push(`no fleet at ${fleet}`)
  if (!feature) return { refusals }
  const row = landedRow(repo, feature)
  if (!row) return { refusals: [...refusals, `no archive row for ${feature} in ${repo}`] }
  if (!row.merged) return { refusals: [...refusals, `the archive row for ${feature} has no merged commit`] }

  let range
  try {
    range = featureRange(repo, row.merged)
  } catch (e) {
    return { refusals, row, failure: why(e) }
  }
  const base = range.base
  let baseMd
  try {
    baseMd = git(repo, 'show', `${base}:.claude/builder.md`) + '\n'
  } catch {
    return { refusals: [...refusals, `no .claude/builder.md at the base ${base.slice(0, 12)}`], row }
  }
  const registry = /^registry:\s*(\S+)/m.exec(baseMd)?.[1] ?? 'docs/features'
  const specs = specCommits(repo, registry, feature, range.commits)
  let verifyBlock
  if (profile.verify) {
    const f = resolve(profileDir, profile.verify)
    if (existsSync(f)) verifyBlock = readFileSync(f, 'utf8')
    else refusals.push(`profile verify file ${f} is missing`)
  }
  // sessions run in fleet worktrees checked out from commits: a tracked path there is the committed file, whatever is placed in the clone
  const head = specs.at(-1) ?? base
  const posix = (p) => p.split(sep).join('/')
  const tracked = new Set((tryGit(repo, 'ls-tree', '-r', '--name-only', head) ?? '').split('\n').filter(Boolean))
  const files = []
  for (const [to, from] of Object.entries(profile.files ?? {})) {
    const src = resolve(profileDir, from)
    const target = resolve(clone, to)
    const rel = relative(clone, target)
    if (isAbsolute(to) || rel.startsWith('..') || !rel || rel === '.git' || rel.startsWith(`.git${sep}`) || rel === join('.claude', 'builder.md')) refusals.push(`profile file ${to} must be a path inside the clone, outside .git and builder.md`)
    else if (!existsSync(src)) refusals.push(`profile file source ${src} is missing`)
    else if (tracked.has(posix(rel))) refusals.push(`files: ${posix(rel)} is tracked by the project — worktrees would load the committed one; place it at an untracked path, point agent_walk.claude_args at it, and list it in agent_walk.copy`)
    else files.push({ to: rel, from: src })
  }
  const { env, refusals: envRefusals } = profileEnv(profile.env)
  refusals.push(...envRefusals)
  const settings = join(clone, '.claude', 'bench-settings.json')
  // the runner's flags first; the profile's claude_args, else the project's own (an --mcp-config, a --model), after them
  const claudeArgs = walkClaudeArgs(`--permission-mode bypassPermissions --settings ${settings} --plugin-dir ${builder}`, baseMd, profile.agent_walk?.claude_args)
  // the profile's replacements run over the whole config — front matter and the body's prose — but never rewrite the runner's flags
  const { md: builderMd, refusals: replaceRefusals } = applyReplacements(applyProfile(baseMd, { agentWalk: profile.agent_walk ?? {}, verifyBlock, claudeArgs }), profile.replace)
  refusals.push(...replaceRefusals)
  if (!replaceRefusals.length && ownClaudeArgs(builderMd) !== claudeArgs) refusals.push("replace: changes agent_walk.claude_args, which the runner sets — use the profile's agent_walk.claude_args")
  refusals.push(...safetyRefusals(builderMd, profile, { listening }))
  // the body is prose: what it names is a warning to replace, never a refusal — nor a port the plan counts
  const warnings = bodyWarnings(builderMd, profile, { listening })
  // a placed (untracked) file reaches a worktree only through agent_walk.copy — a path or a folder above it
  const copy = agentWalkValue(builderMd, 'copy').split(',').map((c) => c.trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean)
  const copied = (p) => copy.some((c) => p === c || p.startsWith(`${c}/`))
  // every MCP config a session loads: the committed file when the project tracks the path, else the profile's placed one
  const mcp = []
  const mcpPaths = new Set()
  for (const v of mcpConfigs(ownClaudeArgs(builderMd))) {
    const rel = relative(clone, resolve(clone, v))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      refusals.push(`mcp: --mcp-config ${v} is outside the clone`)
      continue
    }
    const p = posix(rel)
    mcpPaths.add(p)
    const placed = files.find((f) => posix(f.to) === p)
    if (tracked.has(p)) mcp.push(['mcp', mcpScanText(tryGit(repo, 'show', `${head}:${p}`) ?? '')])
    else if (!placed) refusals.push(`mcp: --mcp-config ${v} is not in the clone — place it at an untracked path with the profile's files and list it in agent_walk.copy`)
    else {
      if (!copied(p)) refusals.push(`mcp: ${p} is placed but not in agent_walk.copy — worktrees won't have it`)
      const text = textOf(placed.from)
      if (text != null) mcp.push(['mcp', mcpScanText(text)])
    }
  }
  // any other placed file the profile's env or agent_walk names by its path: a worktree without it is a warning, not a refusal
  const named = [...Object.values(env), ...Object.entries(profile.agent_walk ?? {}).filter(([k]) => k !== 'copy').map(([, v]) => String(v))].join('\n')
  for (const f of files) {
    const p = posix(f.to)
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!mcpPaths.has(p) && !copied(p) && new RegExp(`(?:^|[\\s=:'"])(?:\\./)?${esc}(?=$|[\\s'";,])`, 'm').test(named)) warnings.push(`files: ${p} is placed but not in agent_walk.copy — worktrees won't have it`)
  }
  // the env, the setup, the teardown, every placed text file and MCP config run or are read in the clone too: the same rules, each reason saying where
  const texts = [['env', Object.keys(env).length ? envLines(env) : null], ['setup', profile.setup], ['teardown', profile.teardown], ...files.map((f) => [`files/${f.to.split(sep).join('/')}`, textOf(f.from)]), ...mcp].filter(([, t]) => t != null)
  for (const [where, text] of texts) refusals.push(...textRefusals(where, text, profile, { listening }))
  const ports = [...new Set([frontMatterText(builderMd), ...texts.map(([, t]) => t)].flatMap(portsNamed))].sort((a, b) => a - b)
  const failure = specs.length ? null : `no spec-only commits lead ${feature}'s branch`
  const specLines = specs.length ? lineCount(tryGit(repo, 'show', `${specs.at(-1)}:${registry}/${feature}/SPEC.md`) ?? '') || null : null
  return { refusals, row, failure, repo, clone, base, specs, registry, feature, builderMd, warnings, files, env, setup: profile.setup ?? null, teardown: profile.teardown ?? null, ports, fleet, specLines }
}

/**
 * The scratch clone: base checked out as main, the spec commits cherry-picked, origin removed, the
 * profile applied and committed, its files placed and its setup run. Refuses before it clones.
 * → { clone, base, specs, refusals, failure, plan }; clone is null when nothing was made.
 */
export async function prepareClone({ profile, profileDir, caseDef, builder, dest, out, listening = [] }) {
  const plan = planCase({ profile, profileDir, caseDef, builder, dest, out, listening })
  const logDir = out ?? dirname(dest)
  const none = { clone: null, base: plan.base ?? null, specs: plan.specs ?? [], refusals: plan.refusals, failure: plan.failure ?? null, plan }
  if (plan.refusals.length || plan.failure) return none
  const { repo, clone, base, specs } = plan
  mkdirSync(dirname(clone), { recursive: true })
  try {
    git(dirname(clone), 'clone', '--no-local', '--no-tags', '-q', repo, clone)
    git(clone, 'remote', 'remove', 'origin')
    git(clone, 'checkout', '-q', '-B', 'main', base)
    // only main stays: no other branch or tag may carry the original run's history into what is measured
    for (const ref of git(clone, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)) {
      if (ref !== 'refs/heads/main') git(clone, 'update-ref', '-d', ref)
    }
  } catch (e) {
    return { ...none, clone: existsSync(clone) ? clone : null, failure: `could not clone the repo: ${why(e)}` }
  }
  try {
    git(clone, 'cherry-pick', ...specs)
  } catch (e) {
    return { ...none, clone, failure: `the spec commits do not apply on the base: ${why(e)}` }
  }
  const exclude = join(clone, '.git', 'info', 'exclude')
  mkdirSync(dirname(exclude), { recursive: true })
  mkdirSync(join(clone, '.claude'), { recursive: true })
  writeFileSync(join(clone, '.claude', 'bench-settings.json'), JSON.stringify({ enabledPlugins: disabledPlugins() }, null, 2) + '\n')
  appendFileSync(exclude, '\n.claude/bench-settings.json\n')
  writeFileSync(join(clone, '.claude', 'builder.md'), plan.builderMd)
  for (const f of plan.files) {
    mkdirSync(dirname(join(clone, f.to)), { recursive: true })
    copyFileSync(f.from, join(clone, f.to))
    appendFileSync(exclude, `/${f.to.split(sep).join('/')}\n`)
  }
  try {
    git(clone, 'add', '--', '.claude/builder.md')
    git(clone, 'commit', '-qm', 'bench: profile', '--', '.claude/builder.md')
  } catch (e) {
    return { ...none, clone, failure: `could not commit the profile: ${why(e)}` }
  }
  const prepped = git(clone, 'rev-parse', 'HEAD')
  if (stopping) return { ...none, clone, failure: 'stopped' }
  let setupPgid = null
  if (plan.setup) {
    // not reaped on exit: a setup may start what the run needs (a bench database, a server); its group is stopped after the fleet
    mkdirSync(logDir, { recursive: true })
    const r = await runGroup('sh', ['-c', plan.setup], { cwd: clone, env: caseEnv(process.env, plan.env, clone), log: join(logDir, 'setup.out'), timeoutMs: SETUP_TIMEOUT_MS })
    // an empty group is no group: its id may be reused by the time the case ends
    setupPgid = r.pgid && groupAlive(r.pgid) ? r.pgid : null
    if (r.stopped) return { ...none, clone, setupPgid, failure: 'stopped' }
    if (r.timedOut) return { ...none, clone, setupPgid, failure: 'setup timed out' }
    if (r.status !== 0) return { ...none, clone, setupPgid, failure: `setup failed (${r.error ? r.error.message : `exit ${r.status}`}) — see setup.out` }
  }
  return { clone, base, specs, refusals: [], failure: null, plan, prepped, setupPgid }
}

/** The most lines any version of <registry>/<feature>/PLAN.md committed in the clone after `since` (the prepped commit) had, or null. */
export function maxPlanLines(clone, registry, feature, since) {
  const path = `${registry.replace(/\/+$/, '')}/${feature}/PLAN.md`
  const shas = (tryGit(clone, 'log', '--all', '--format=%H', '--not', since, '--', path) ?? '').split('\n').filter(Boolean)
  let max = null
  for (const c of shas) {
    const text = tryGit(clone, 'show', `${c}:${path}`)
    if (text != null) max = Math.max(max ?? 0, lineCount(text))
  }
  return max
}

/** The process groups a fleet records for its sessions and dev envs (each runs in its own group). */
const fleetPgids = (clone) => {
  const f = readJson(join(clone, '.builder', 'fleet', 'fleet.json'))
  return [...Object.values(f?.features ?? {}), f?.walkBatch, f?.envCheck].flatMap((x) => [x?.pgid, x?.startPgid]).filter(killableGroup)
}

/**
 * The fleet on the case's feature in the clone, awaited in its own process group, in the case's
 * environment (caseEnv — every session it starts inherits it); → the case's status and the landed row.
 * Past the timeout the fleet gets SIGTERM (it stops its own sessions and dev envs), then SIGKILL for its
 * group and every group its fleet.json still names.
 */
export async function runCaseFleet({ clone, feature, fleet, out, env = {} }) {
  const before = JSON.stringify(landedRow(clone, feature))
  const r = await runGroup(process.execPath, [fleet, feature, '--into', 'main', '--parallel', '1'], {
    cwd: clone,
    env: caseEnv(process.env, env, clone),
    log: join(out, 'fleet.out'),
    timeoutMs: FLEET_TIMEOUT_MS,
    reap: true,
    onTimeout: () => fleetPgids(clone).forEach((p) => killOwnedGroup(p, 'SIGKILL', clone)),
  })
  const after = landedRow(clone, feature)
  const landed = after && JSON.stringify(after) !== before ? after : null
  const sessions = join(out, 'sessions')
  mkdirSync(sessions, { recursive: true })
  // fleetRecord copies the fleet's session logs beside the result; with no new landing its exit status is not enough
  const rec = fleetRecord({ copy: clone, feature, outDir: sessions, r: { status: r.status, error: r.error } })
  const status = landed ? 'done' : r.stopped ? 'failed: stopped' : r.timedOut ? `failed: the fleet timed out after ${Math.round(FLEET_TIMEOUT_MS / 1000)}s` : rec.status === 'done' ? 'failed: the fleet landed nothing' : rec.status
  return { status, landed }
}

/**
 * After the fleet, on every path: the profile's teardown in the clone (its own group, reaped, with the
 * setup's timeout), then whatever the setup started is stopped. → the teardown's outcome, or null with none.
 */
export async function finishCase({ clone, teardown, setupPgid, out, env = {} }) {
  let outcome = null
  if (teardown && clone && existsSync(clone)) {
    mkdirSync(out, { recursive: true })
    const r = await runGroup('sh', ['-c', teardown], { cwd: clone, env: caseEnv(process.env, env, clone), log: join(out, 'teardown.out'), timeoutMs: SETUP_TIMEOUT_MS, reap: true })
    outcome = r.status === 0 ? 'done' : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : `failed (${r.error ? r.error.message : `exit ${r.status}`}) — see teardown.out`
  }
  if (setupPgid) await stopGroup(setupPgid, clone)
  return outcome
}

/** The clone and the fleet's worktrees beside it (<clone>.fleet) removed, then the clone root when that leaves it empty. */
export function removeClone(clone) {
  for (const p of [clone, `${clone}.fleet`]) rmSync(p, { recursive: true, force: true })
  try {
    rmdirSync(dirname(clone))
  } catch {}
}

// ---- the CLI --------------------------------------------------------------------------------------

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const USAGE = 'usage: bench-case.mjs <case-id> --builder <checkout> --out <dir> [--clone-root <dir>] [--dry-run]'
  const refuse = (reasons) => {
    for (const r of [].concat(reasons)) console.error(`refused: ${r}`)
    process.exit(2)
  }
  const argv = process.argv.slice(2)
  const opt = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const id = argv[0]
  const dryRun = argv.includes('--dry-run')
  const known = new Set(['--builder', '--out', '--clone-root', '--dry-run'])
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !['--builder', '--out', '--clone-root'].includes(argv[i - 1]))
  if (!id || id.startsWith('--') || unknown.length || !opt('--out') || ['--builder', '--clone-root'].some((f) => argv.includes(f) && !opt(f))) refuse(USAGE)
  const builder = resolve(opt('--builder') ?? BUILDER)
  const out = resolve(opt('--out'))
  const cloneRoot = resolve(opt('--clone-root') ?? join(benchTmp(), basename(dirname(out)), basename(out)))
  const local = process.env.BENCH_LOCAL || join(BUILDER, 'bench', 'local')
  const caseFile = join(local, 'cases', `${id}.json`)
  const caseDef = readJson(caseFile)
  if (!caseDef) refuse(`no case file ${caseFile} (or it is not JSON)`)
  if (!caseDef.project) refuse(`case ${id} names no project`)
  const profileFile = join(local, 'projects', `${caseDef.project}.json`)
  const profile = readJson(profileFile)
  if (!profile) refuse(`no profile ${profileFile} (or it is not JSON)`)
  const args = { profile, profileDir: dirname(profileFile), caseDef, builder, dest: join(cloneRoot, 'clone'), out, listening: listeningPorts() }

  if (dryRun) {
    const p = planCase(args)
    if (p.refusals.length) refuse(p.refusals)
    if (p.failure) {
      console.log(`${id}: would fail prep — ${p.failure}`)
      process.exit(0)
    }
    const subject = (c) => tryGit(p.repo, 'log', '-1', '--format=%h %s', c) ?? c
    console.log([
      `${id} (${caseDef.size}, ${caseDef.project}) — dry run, nothing is cloned or run`,
      `  clone:  ${p.clone}`,
      `  base:   ${subject(p.base)}`,
      `  specs:  ${p.specs.map(subject).join('\n          ')}`,
      '  agent_walk:',
      ...agentWalkLines(p.builderMd).map((l) => `    ${l}`),
      `  env:    ${Object.keys(p.env).length ? envLines(p.env).split('\n').join(' ') : '(none)'}`,
      `  files:  ${p.files.length ? p.files.map((f) => `${f.to} ← ${f.from}`).join('\n          ') : '(none)'}`,
      `  setup:  ${p.setup ?? '(none)'}`,
      `  teardown: ${p.teardown ?? '(none)'}`,
      `  ports:  ${p.ports.length ? p.ports.join(' ') : '(none)'}`,
      `  fleet:  node ${p.fleet} ${p.feature} --into main --parallel 1`,
      ...p.warnings.map((w) => `  ${w}`),
    ].join('\n'))
    process.exit(0)
  }

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, onStopSignal)
  const prep = await prepareClone(args)
  if (prep.refusals.length) refuse(prep.refusals)
  const { plan } = prep
  const result = { id: caseDef.id ?? id, size: caseDef.size, kind: 'archived', project: caseDef.project, control: false, status: null, measure: null, baseline: plan.row ? measureFromRow(plan.row) : null, specLines: plan.specLines ?? null, planLines: null, estimate: caseDef.estimate ?? (plan.row ? estimateFromRow(plan.row) : null), warnings: plan.warnings ?? [] }
  mkdirSync(out, { recursive: true })
  if (prep.failure) {
    result.status = `failed: ${prep.failure}`
  } else {
    const { status, landed } = await runCaseFleet({ clone: prep.clone, feature: plan.feature, fleet: plan.fleet, out, env: plan.env })
    result.status = status
    result.measure = landed ? measureFromRow(landed) : null
    result.planLines = maxPlanLines(prep.clone, plan.registry, plan.feature, prep.prepped)
  }
  if (stopRequested() && result.status !== 'done') result.status = 'failed: stopped'
  const teardown = await finishCase({ clone: prep.clone, teardown: plan.teardown, setupPgid: prep.setupPgid, out, env: plan.env })
  if (teardown) result.teardown = teardown
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  if (prep.clone && !process.env.BENCH_KEEP_CLONES) removeClone(prep.clone)
  console.log(`${result.id}: ${result.status} — ${join(out, 'result.json')}`)
  process.exit(0)
}
