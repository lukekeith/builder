#!/usr/bin/env node
/**
 * bench-case — one archived case end to end: an already-merged feature's spec run again through the
 * fleet, in a scratch clone of its project at the feature's base commit, on the builder under test.
 * Design: docs/specs/2026-10-29-benchmark-suite-design.md.
 *
 *   node scripts/bench-case.mjs <case-id> --builder <checkout> --out <dir> [--dry-run]
 *
 * Reads $BENCH_LOCAL/cases/<id>.json and $BENCH_LOCAL/projects/<project>.json. Writes <out>/result.json
 * and exits 0 whether the case landed or not; exits 2 on a refusal, the reasons on stderr. Every
 * refusal comes before the clone is made, and nothing ever writes into the project repo.
 *
 * Env: BENCH_LOCAL (<builder>/bench/local), BENCH_FLEET (the fleet script — tests point it at a stub),
 * BENCH_CASE_FLEET_TIMEOUT_MS (24h, the fleet's whole run), BENCH_SETUP_TIMEOUT_MS (20 min, the
 * profile's setup), BENCH_CASE_KILL_GRACE_MS (10s, SIGTERM to SIGKILL on a timeout), BENCH_INSTALLED_PLUGINS (as bench.mjs).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, openSync, closeSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyProfile, safetyRefusals, measureFromRow, estimateFromRow } from './bench-suite-core.mjs'
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

/** The TCP ports listening now; no lsof or no output is []. */
export function listeningPorts() {
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (r.error || !r.stdout) return []
  return [...new Set([...r.stdout.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1])))]
}

const killGroup = (pgid, sig) => {
  try {
    process.kill(-pgid, sig)
  } catch {}
}

/**
 * A command in its own process group, awaited, its output in `log`. Past timeoutMs the group gets
 * SIGTERM, then SIGKILL after the grace period; `onTimeout` runs at the SIGKILL. With `reap`, whatever
 * the group still holds when the command exits is killed too. → { status, timedOut, error }
 */
export function runGroup(cmd, args, { cwd, env, log, timeoutMs, reap = false, onTimeout = () => {} }) {
  return new Promise((done) => {
    const fd = openSync(log, 'w')
    let timedOut = false
    let settled = false
    let grace = null
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true })
    const hardKill = () => {
      killGroup(child.pid, 'SIGKILL')
      onTimeout()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      grace = setTimeout(hardKill, KILL_GRACE_MS)
    }, timeoutMs)
    const finish = (status, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      if (timedOut) hardKill()
      else if (reap) killGroup(child.pid, 'SIGKILL')
      closeSync(fd)
      done({ status, timedOut, error })
    }
    child.on('error', (e) => finish(null, e))
    child.on('exit', (code) => finish(timedOut ? null : (code ?? 1)))
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
export function planCase({ profile, profileDir = '.', caseDef, builder, dest, listening = [] }) {
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
  if (within(clone, root)) refusals.push(`the clone ${clone} is inside the project repo — pick an --out outside it`)
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
  const files = []
  for (const [to, from] of Object.entries(profile.files ?? {})) {
    const src = resolve(profileDir, from)
    const target = resolve(clone, to)
    const rel = relative(clone, target)
    if (isAbsolute(to) || rel.startsWith('..') || !rel || rel === '.git' || rel.startsWith(`.git${sep}`) || rel === join('.claude', 'builder.md')) refusals.push(`profile file ${to} must be a path inside the clone, outside .git and builder.md`)
    else if (!existsSync(src)) refusals.push(`profile file source ${src} is missing`)
    else files.push({ to: rel, from: src })
  }
  const settings = join(clone, '.claude', 'bench-settings.json')
  const claudeArgs = `--permission-mode bypassPermissions --settings ${settings} --plugin-dir ${builder}`
  const builderMd = applyProfile(baseMd, { agentWalk: profile.agent_walk ?? {}, verifyBlock, claudeArgs })
  refusals.push(...safetyRefusals(builderMd, profile, { listening }))
  const failure = specs.length ? null : `no spec-only commits lead ${feature}'s branch`
  const specLines = specs.length ? lineCount(tryGit(repo, 'show', `${specs.at(-1)}:${registry}/${feature}/SPEC.md`) ?? '') || null : null
  return { refusals, row, failure, repo, clone, base, specs, registry, feature, builderMd, files, setup: profile.setup ?? null, fleet, specLines }
}

/**
 * The scratch clone: base checked out as main, the spec commits cherry-picked, origin removed, the
 * profile applied and committed, its files placed and its setup run. Refuses before it clones.
 * → { clone, base, specs, refusals, failure, plan }; clone is null when nothing was made.
 */
export async function prepareClone({ profile, profileDir, caseDef, builder, dest, listening = [] }) {
  const plan = planCase({ profile, profileDir, caseDef, builder, dest, listening })
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
  if (plan.setup) {
    // not reaped on exit: a setup may start what the run needs (a bench database, a server)
    const r = await runGroup('sh', ['-c', plan.setup], { cwd: clone, env: { ...process.env, CLAUDE_PROJECT_DIR: clone }, log: join(dirname(clone), 'setup.out'), timeoutMs: SETUP_TIMEOUT_MS })
    if (r.timedOut) return { ...none, clone, failure: 'setup timed out' }
    if (r.status !== 0) return { ...none, clone, failure: `setup failed (${r.error ? r.error.message : `exit ${r.status}`}) — see setup.out` }
  }
  return { clone, base, specs, refusals: [], failure: null, plan, prepped }
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
  return [...Object.values(f?.features ?? {}), f?.walkBatch, f?.envCheck].flatMap((x) => [x?.pgid, x?.startPgid]).filter((p) => Number.isInteger(p) && p > 0)
}

/**
 * The fleet on the case's feature in the clone, awaited in its own process group; → the case's
 * status and the landed row. Past the timeout the fleet gets SIGTERM (it stops its own sessions and
 * dev envs), then SIGKILL for its group and every group its fleet.json still names.
 */
export async function runCaseFleet({ clone, feature, fleet, out }) {
  const before = JSON.stringify(landedRow(clone, feature))
  const r = await runGroup(process.execPath, [fleet, feature, '--into', 'main', '--parallel', '1'], {
    cwd: clone,
    env: { ...process.env, CLAUDE_PROJECT_DIR: clone },
    log: join(out, 'fleet.out'),
    timeoutMs: FLEET_TIMEOUT_MS,
    reap: true,
    onTimeout: () => fleetPgids(clone).forEach((p) => killGroup(p, 'SIGKILL')),
  })
  const after = landedRow(clone, feature)
  const landed = after && JSON.stringify(after) !== before ? after : null
  const sessions = join(out, 'sessions')
  mkdirSync(sessions, { recursive: true })
  // fleetRecord copies the fleet's session logs beside the result; with no new landing its exit status is not enough
  const rec = fleetRecord({ copy: clone, feature, outDir: sessions, r: { status: r.status, error: r.error } })
  const status = landed ? 'done' : r.timedOut ? `failed: the fleet timed out after ${Math.round(FLEET_TIMEOUT_MS / 1000)}s` : rec.status === 'done' ? 'failed: the fleet landed nothing' : rec.status
  return { status, landed }
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
  const USAGE = 'usage: bench-case.mjs <case-id> --builder <checkout> --out <dir> [--dry-run]'
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
  const known = new Set(['--builder', '--out', '--dry-run'])
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !['--builder', '--out'].includes(argv[i - 1]))
  if (!id || id.startsWith('--') || unknown.length || !opt('--out') || (argv.includes('--builder') && !opt('--builder'))) refuse(USAGE)
  const builder = resolve(opt('--builder') ?? BUILDER)
  const out = resolve(opt('--out'))
  const local = process.env.BENCH_LOCAL || join(BUILDER, 'bench', 'local')
  const caseFile = join(local, 'cases', `${id}.json`)
  const caseDef = readJson(caseFile)
  if (!caseDef) refuse(`no case file ${caseFile} (or it is not JSON)`)
  if (!caseDef.project) refuse(`case ${id} names no project`)
  const profileFile = join(local, 'projects', `${caseDef.project}.json`)
  const profile = readJson(profileFile)
  if (!profile) refuse(`no profile ${profileFile} (or it is not JSON)`)
  const args = { profile, profileDir: dirname(profileFile), caseDef, builder, dest: join(out, 'clone'), listening: listeningPorts() }

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
      `  files:  ${p.files.length ? p.files.map((f) => `${f.to} ← ${f.from}`).join('\n          ') : '(none)'}`,
      `  setup:  ${p.setup ?? '(none)'}`,
      `  fleet:  node ${p.fleet} ${p.feature} --into main --parallel 1`,
    ].join('\n'))
    process.exit(0)
  }

  const prep = await prepareClone(args)
  if (prep.refusals.length) refuse(prep.refusals)
  const { plan } = prep
  const result = { id: caseDef.id ?? id, size: caseDef.size, kind: 'archived', project: caseDef.project, control: false, status: null, measure: null, baseline: plan.row ? measureFromRow(plan.row) : null, specLines: plan.specLines ?? null, planLines: null, estimate: caseDef.estimate ?? (plan.row ? estimateFromRow(plan.row) : null) }
  mkdirSync(out, { recursive: true })
  if (prep.failure) {
    result.status = `failed: ${prep.failure}`
  } else {
    const { status, landed } = await runCaseFleet({ clone: prep.clone, feature: plan.feature, fleet: plan.fleet, out })
    result.status = status
    result.measure = landed ? measureFromRow(landed) : null
    result.planLines = maxPlanLines(prep.clone, plan.registry, plan.feature, prep.prepped)
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`${result.id}: ${result.status} — ${join(out, 'result.json')}`)
  process.exit(0)
}
