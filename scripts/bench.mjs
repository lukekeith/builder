#!/usr/bin/env node
/**
 * bench — run one feature through builder (rush / standard / thorough), superpowers and GSD,
 * unattended, and report time per step. Design: docs/specs/2026-10-13-benchmark-design.md.
 *
 *   node scripts/bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach]
 *   node scripts/bench.mjs report <run-id>
 *   node scripts/bench.mjs status
 *   node scripts/bench.mjs clean
 *
 * Env: BENCH_CLAUDE (the claude binary), BENCH_TMP (where copies go; $TMPDIR/bench),
 * BENCH_RUN_TIMEOUT_MS (2h), BENCH_IDLE_TIMEOUT_MS (20 min), BENCH_FLEET (the fleet script —
 * tests point it at a stub), BENCH_GSD_INSTALL (the install command — tests set `true`),
 * BENCH_SUPERPOWERS_DIR (a superpowers plugin dir, or `none` for "not installed"; wins over the
 * plugin-cache lookup), BENCH_INSTALLED_PLUGINS (a path to an installed_plugins.json — the plugins
 * a session must not load from user scope are read from it; default: the host's own file).
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, createWriteStream, openSync, renameSync, appendFileSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readBrainstormHeader } from './brainstorm-file.mjs'
import { parseStream, deriveSteps, sessionTotals, runTotals, parseTap, renderReport, renderStatusTable } from './bench-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUILDER = resolve(HERE, '..')
const CLAUDE = process.env.BENCH_CLAUDE || 'claude'
const RUN_TIMEOUT_MS = Number(process.env.BENCH_RUN_TIMEOUT_MS) || 2 * 60 * 60 * 1000
const IDLE_TIMEOUT_MS = Number(process.env.BENCH_IDLE_TIMEOUT_MS) || 20 * 60 * 1000
const TMP = process.env.BENCH_TMP || join(process.env.TMPDIR || tmpdir(), 'bench')

const die = (msg) => {
  console.error(msg)
  process.exit(2)
}
const sh = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const git = (cwd, ...a) => sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...a], cwd)

/** bench/results inside the builder repo; .builder/bench (git-ignored) anywhere else. */
export function resultsDir(root) {
  const p = join(root, '.claude-plugin', 'plugin.json')
  try {
    if (JSON.parse(readFileSync(p, 'utf8')).name === 'builder') return join(root, 'bench', 'results')
  } catch {}
  return join(root, '.builder', 'bench')
}

export const OWNER_PROMPT = [
  'You are being benchmarked. The owner is not here. Whenever a step would ask the human a question,',
  'answer it yourself: take the option marked recommended, or the simplest one when none is. Never',
  'stop to wait for input and never ask the owner anything. The feature is done only when it is',
  'merged into `main` and the tests pass. Do not explain the benchmark in commits or files.',
].join(' ')

/** builder's id in the host's settings — `builder@<marketplace>`, the marketplace read from this plugin (a vendored copy has none, so bare `builder`). */
function builderPluginId() {
  try {
    const m = JSON.parse(readFileSync(join(BUILDER, '.claude-plugin', 'marketplace.json'), 'utf8')).name
    if (m) return `builder@${m}`
  } catch {}
  return 'builder'
}

/** The host's config dir: CLAUDE_CONFIG_DIR, else ~/.claude-home when it holds installed plugins, else ~/.claude. */
function configDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR
  const home = process.env.HOME || homedir()
  return existsSync(join(home, '.claude-home', 'plugins', 'installed_plugins.json')) ? join(home, '.claude-home') : join(home, '.claude')
}

/** Every plugin a session would load from user scope, set to false — so only the pipeline under test (--plugin-dir) is loaded. */
function disabledPlugins() {
  const file = process.env.BENCH_INSTALLED_PLUGINS || join(configDir(), 'plugins', 'installed_plugins.json')
  try {
    const plugins = JSON.parse(readFileSync(file, 'utf8')).plugins ?? {}
    const ids = Object.keys(plugins).filter((id) => (plugins[id] ?? []).some((e) => e?.scope === 'user'))
    return Object.fromEntries(ids.map((id) => [id, false]))
  } catch {
    return { [builderPluginId()]: false, 'superpowers@claude-plugins-official': false }
  }
}

/** The fixture, copied and made a repo on `main`; the fleet's claude_args filled in. */
export function prepareCopy({ fixture, dest, claudeArgs }) {
  if (/\s/.test(dest)) throw new Error(`the copy's path must contain no spaces (the fleet splits claude_args on whitespace): ${dest} — set BENCH_TMP`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(fixture, dest, { recursive: true })
  const cfg = join(dest, '.claude', 'builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('{claude_args}', claudeArgs))
  writeFileSync(join(dest, '.claude', 'bench-settings.json'), JSON.stringify({ enabledPlugins: disabledPlugins() }, null, 2) + '\n')
  git(dest, 'init', '-q', '-b', 'main')
  mkdirSync(join(dest, '.git', 'info'), { recursive: true })
  writeFileSync(join(dest, '.git', 'info', 'exclude'), 'REQUEST.md\n.claude/bench-settings.json\n')
  git(dest, 'add', '-A')
  git(dest, 'commit', '-qm', 'fixture')
  return { copy: dest }
}

/**
 * One headless session. Its stream goes to outFile as it arrives. Killed (exit null) after
 * idleTimeoutMs with no output, or runTimeoutMs in all — the whole process group, as the fleet does.
 */
export function runSession({ copy, name, prompt, outFile, claudeArgs, systemPrompt, model, runTimeoutMs = RUN_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, claude = CLAUDE, env = {} }) {
  return new Promise((done) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...claudeArgs]
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    if (model) args.push('--model', model)
    const out = createWriteStream(outFile)
    const child = spawn(claude, args, { cwd: copy, env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: copy }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let timedOut = false
    let settled = false
    const kill = () => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    let idle = setTimeout(kill, idleTimeoutMs)
    const hard = setTimeout(kill, runTimeoutMs)
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(kill, idleTimeoutMs)
    }
    child.stdout.on('data', (c) => {
      touch()
      out.write(c)
    })
    child.stderr.on('data', (c) => {
      touch()
      out.write(c)
    })
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(hard)
      // Whatever the session left in its process group (a server, an MCP process) must not outlive it.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      // A grandchild may still hold the pipes: stop reading before the file is closed.
      try {
        child.stdout.destroy()
      } catch {}
      try {
        child.stderr.destroy()
      } catch {}
      out.end(() => done({ exit, file: outFile }))
    }
    child.on('error', (e) => {
      out.write(`\n[bench] could not start ${claude}: ${e.message}\n`)
      finish(127)
    })
    child.on('exit', (code) => setTimeout(() => finish(timedOut ? null : (code ?? 1)), 500))
    child.on('close', (code) => finish(timedOut ? null : (code ?? 1)))
  })
}

/** A session file → the Session row of runs.json. */
export function sessionRecord({ name, lane, prompt, file, copy = null }) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = parseStream(text)
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('{'))
  return { name, file, lane, sessionId: parsed.sessionId, model: parsed.model, prompt, totals: sessionTotals(parsed), plugins: parsed.plugins.filter((x) => x.path !== 'builtin').map((x) => `${x.name} ${x.version ?? ''}`.trim()), steps: deriveSteps(parsed, { prompt, root: copy }), tail: lines.slice(-10) }
}

// ---- the matrix and the drivers ------------------------------------------------------------------

/** Where the superpowers plugin is on this machine, newest version — or null. */
export function superpowersDir() {
  const forced = process.env.BENCH_SUPERPOWERS_DIR
  if (forced) return forced === 'none' ? null : forced
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude'), 'plugins', 'cache', 'claude-plugins-official', 'superpowers')
  const alt = join(process.env.HOME || '', '.claude-home', 'plugins', 'cache', 'claude-plugins-official', 'superpowers')
  for (const d of [base, alt]) {
    if (!existsSync(d)) continue
    const vs = readdirSync(d).filter((n) => /^\d/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (vs.length) return join(d, vs[0])
  }
  return null
}

const GSD_INSTALL = process.env.BENCH_GSD_INSTALL || 'npx -y @opengsd/gsd-core@latest --claude --local'

/**
 * A driver: (ctx) → the sessions to run, in order. ctx = { copy, request, profile, flags }.
 * A session is { name, prompt, system?: extra owner line, lane?: 'brainstorm'|…, fleet?: true }.
 * `fleet: true` is builder's third step: the fleet engine, not a claude -p (see runFleet).
 */
export const DRIVERS = {
  builder: ({ request, profile }) => {
    const system = `When asked for a build profile, choose **${profile}**. After /builder:spec has committed SPEC.md and MANIFEST.md, stop: do not run /builder:agent, /builder:fleet or any agent — the benchmark runs the fleet itself.`
    return [
      { name: 'brainstorm', prompt: `/builder:brainstorm --auto ${request}`, system },
      { name: 'spec', prompt: '/builder:spec --auto', system },
      { name: 'fleet', fleet: true, system },
    ]
  },
  superpowers: ({ request }) => [
    { name: 'superpowers', prompt: `/superpowers:brainstorming — Build this feature end to end: ${request}\n\nBrainstorm it, write the plan, execute the plan with subagent-driven development, then finish the branch by merging it into \`main\`.` },
  ],
  gsd: () => [
    { name: 'new-project', prompt: '/gsd-new-project --auto @REQUEST.md', system: 'Plan the whole request as ONE phase.' },
    { name: 'plan-phase', prompt: '/gsd-plan-phase 1' },
    { name: 'execute-phase', prompt: '/gsd-execute-phase 1' },
    { name: 'verify-work', prompt: '/gsd-verify-work 1 — then merge the work into `main` and leave `main` checked out.' },
  ],
}

export const MATRIX = [
  { config: 'builder-rush', pipeline: 'builder', profile: 'rush' },
  { config: 'builder-standard', pipeline: 'builder', profile: 'standard' },
  { config: 'builder-thorough', pipeline: 'builder', profile: 'thorough' },
  { config: 'superpowers', pipeline: 'superpowers', profile: null },
  { config: 'gsd', pipeline: 'gsd', profile: null },
]

/** The claude flags every session of a pipeline gets: permissions, the plugin under test, the settings. */
export function flagsFor(pipeline, copy) {
  const flags = ['--permission-mode', 'bypassPermissions', '--settings', join(copy, '.claude', 'bench-settings.json')]
  if (pipeline === 'builder') flags.push('--plugin-dir', BUILDER)
  if (pipeline === 'superpowers') {
    const sp = superpowersDir()
    if (sp) flags.push('--plugin-dir', sp)
  }
  return flags
}

export const runId = (feature, now = new Date()) => `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}-${feature}`

// ---- running one config ----------------------------------------------------------------------------

const FLEET = process.env.BENCH_FLEET || join(BUILDER, 'scripts', 'fleet.mjs')

/** The feature folder builder's spec session left, or null (xs/sm: built in chat; or nothing). */
export function featureOf(copy) {
  const reg = join(copy, 'docs', 'features')
  if (!existsSync(reg)) return null
  return readdirSync(reg).find((n) => !n.startsWith('_') && existsSync(join(reg, n, 'MANIFEST.md'))) ?? null
}

/** The first <copy>/.builder/<name>/ holding a brainstorm.md → { feature, header }, or null. */
export function brainstormOf(copy) {
  const base = join(copy, '.builder')
  if (!existsSync(base)) return null
  for (const n of readdirSync(base).sort()) {
    if (n.startsWith('.') || ['fleet', 'jobs', 'bench'].includes(n)) continue
    const f = join(base, n, 'brainstorm.md')
    if (!existsSync(f)) continue
    let header = null
    try {
      header = readBrainstormHeader(f)
    } catch {}
    return { feature: n, header }
  }
  return null
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** True when a fleet running in the copy holds .builder/fleet/lock with a live pid. */
export function fleetLive(copy) {
  try {
    const pid = Number(readFileSync(join(copy, '.builder', 'fleet', 'lock'), 'utf8'))
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid)
  } catch {
    return false
  }
}
/** True when the copy's fleet has a record of the feature (an archive row, or a fleet.json entry). */
export function hasFleetRecord(copy, feature) {
  const dir = join(copy, '.builder', 'fleet')
  try {
    if (readFileSync(join(dir, 'archive.jsonl'), 'utf8').split('\n').some((l) => { try { return JSON.parse(l).feature === feature } catch { return false } })) return true
  } catch {}
  try {
    return !!JSON.parse(readFileSync(join(dir, 'fleet.json'), 'utf8'))?.features?.[feature]
  } catch {
    return false
  }
}

/** The fleet engine on one feature; its stream logs become this config's sessions. */
export function runFleet({ copy, feature, outDir, env }) {
  const log = join(outDir, 'fleet.out')
  const r = spawnSync(process.execPath, [FLEET, feature, '--parallel', '1'], { cwd: copy, encoding: 'utf8', env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: copy }, timeout: RUN_TIMEOUT_MS * 3, maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(log, `${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  return fleetRecord({ copy, feature, outDir, r })
}

/** The sessions and status of a fleet that has finished in the copy; `r` is its exit info ({ status, error? }). */
export function fleetRecord({ copy, feature, outDir, r }) {
  const fleetDir = join(copy, '.builder', 'fleet')
  const readJson = (f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      return null
    }
  }
  const rows = existsSync(join(fleetDir, 'archive.jsonl')) ? readFileSync(join(fleetDir, 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
  const archived = rows.filter((x) => x.feature === feature).at(-1) ?? null
  const entry = readJson(join(fleetDir, 'fleet.json'))?.features?.[feature] ?? null
  const timing = archived?.timing ?? entry?.timing ?? []
  // a landed feature's logs are moved to logs/_archive/<feature>/; a parked or failed one's stay in logs/
  const byName = new Map()
  for (const dir of [join(fleetDir, 'logs'), join(fleetDir, 'logs', '_archive', feature)]) {
    if (!existsSync(dir)) continue
    for (const n of readdirSync(dir)) if (n.startsWith(`${feature}-`) && n.endsWith('.jsonl') && !byName.has(n)) byName.set(n, join(dir, n))
  }
  const sessions = [...byName.keys()].sort().map((n) => {
    const nn = n.slice(feature.length + 1, -6)
    const file = join(outDir, `session-fleet-${n}`)
    cpSync(byName.get(n), file)
    const prompt = `/builder:resume --path docs/features/${feature} --agent-walk`
    const rec = sessionRecord({ name: `fleet ${nn}`, lane: null, prompt, file, copy })
    rec.lane = timing.find((t) => t.n === Number(nn))?.lane ?? (rec.steps.some((x) => /walk|signoff/.test(x.name)) ? 'walk' : rec.steps.some((x) => /verify|ship/.test(x.name)) ? 'ship' : 'build')
    return rec
  })
  let status
  if (r.error?.code === 'ENOBUFS') status = 'failed: fleet output exceeded the buffer'
  else if (r.error?.code === 'ETIMEDOUT') status = 'timed out'
  else if (r.error) status = `failed: fleet could not start: ${r.error.message}`
  else if (r.status === null) status = 'timed out'
  else if (entry?.status === 'parked') status = `parked: ${entry.reason}`
  else if (entry?.status === 'failed') status = `failed: ${entry.reason}`
  else if (r.status === undefined) {
    // no real exit code (a fleet a session launched): only a record of landing counts as done
    if (entry?.status === 'done' || (!entry && archived)) status = 'done'
    else if (entry) status = `failed: fleet stopped (${entry.status})`
    else status = 'failed: fleet left no record'
  } else if (!entry && archived) status = 'done'
  else status = r.status === 0 ? 'done' : `failed: fleet exit ${r.status}`
  return { sessions, status }
}

export function installGsd(copy) {
  const r = spawnSync('sh', ['-c', GSD_INSTALL], { cwd: copy, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  if (r.status !== 0) return { ok: false, version: null, reason: `gsd install failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop()}` }
  return { ok: true, version: /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null, reason: null }
}

/** After the run: main checked out, the fixture's tests and the hidden acceptance tests, both TAP. */
export function score(copy, feature) {
  try {
    git(copy, 'checkout', '-q', 'main')
  } catch {}
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // set when bench itself runs under `node --test`; it makes a nested run report as a child instead of printing TAP
  const tap = (file) => {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: copy, encoding: 'utf8', env, timeout: 5 * 60 * 1000 })
    return parseTap(`${r.stdout}\n${r.stderr}`)
  }
  // the agent may have edited test/cli.test.mjs: score the pristine one
  cpSync(join(FIXTURE, 'test', 'cli.test.mjs'), join(copy, 'test', '.bench-fixture.test.mjs'))
  const fixture = tap(join('test', '.bench-fixture.test.mjs'))
  rmSync(join(copy, 'test', '.bench-fixture.test.mjs'), { force: true })
  cpSync(join(FEATURES, feature, 'accept.test.mjs'), join(copy, 'test', 'accept.test.mjs'))
  const accept = tap(join('test', 'accept.test.mjs'))
  rmSync(join(copy, 'test', 'accept.test.mjs'), { force: true })
  return { accept, fixture }
}

const writeJson = (p, o) => {
  writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 2) + '\n')
  renameSync(`${p}.tmp`, p)
}

/** True when a phase's VERIFICATION.md in the copy holds a `status: passed` line. */
export function gsdVerified(copy) {
  const base = join(copy, '.planning', 'phases')
  try {
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      for (const n of readdirSync(join(base, d.name))) {
        if (n.endsWith('VERIFICATION.md') && /^status:\s*passed\b/m.test(readFileSync(join(base, d.name, n), 'utf8'))) return true
      }
    }
  } catch {}
  return false
}

export async function runConfig(plan, m, rep, data, outRoot) {
  const label = plan.repeat > 1 ? `${m.config}-${rep}` : m.config
  const copy = join(TMP, plan.id, label)
  const outDir = join(outRoot, label)
  mkdirSync(outDir, { recursive: true })
  const flags = flagsFor(m.pipeline, copy)
  prepareCopy({ fixture: FIXTURE, dest: copy, claudeArgs: [...flags, ...(plan.model ? ['--model', plan.model] : [])].join(' ') })
  if (m.pipeline === 'gsd') writeFileSync(join(copy, 'REQUEST.md'), plan.request + '\n')
  const run = { config: m.config, pipeline: m.pipeline, profile: m.profile, rep, status: 'done', path: 'pipeline', startedAt: Date.now(), endedAt: null, ms: 0, installMs: 0, sessions: [], totals: null, score: null, copy, gitLog: [] }
  const progress = (session) => writeJson(join(outRoot, 'progress.json'), { config: m.config, rep, session, startedAt: Date.now() })
  if (m.pipeline === 'gsd') {
    progress('install gsd')
    const t0 = Date.now()
    const g = installGsd(copy)
    run.installMs = Date.now() - t0
    run.startedAt = Date.now()
    data.versions.gsd ??= g.version
    if (!g.ok) run.status = `not run: ${g.reason}`
  }
  if (m.pipeline === 'superpowers' && !superpowersDir()) run.status = 'not run: superpowers is not in the plugin cache'
  const sessions = sessionsFor(m, copy, plan.request)
  const hasManifest = (f) => existsSync(join(copy, 'docs', 'features', f, 'MANIFEST.md'))
  const pollMs = Number(process.env.BENCH_FLEET_POLL_MS) || 5000
  let n = 0
  let skipToFleet = false
  let feature = null
  let lastSession = null
  // wait for a fleet running in the copy (launched by a session), then take its record
  const adoptFleet = async (by) => {
    if (fleetLive(copy)) {
      progress(`fleet (launched by ${by})`)
      const deadline = Date.now() + RUN_TIMEOUT_MS * 3
      while (fleetLive(copy) && Date.now() < deadline) await new Promise((res) => setTimeout(res, pollMs))
      if (fleetLive(copy)) {
        run.status = 'timed out'
        return
      }
    }
    const f = fleetRecord({ copy, feature, outDir, r: {} })
    run.sessions.push(...f.sessions)
    run.status = f.status
    run.fleetLaunchedBy = by
  }
  for (const s of sessions) {
    if (run.status !== 'done') break
    if (skipToFleet && !s.fleet) continue
    n++
    progress(s.name)
    if (s.fleet) {
      feature ??= brainstormOf(copy)?.feature ?? featureOf(copy)
      if (feature && fleetLive(copy)) {
        // the session launched the fleet and left before its lock/record landed: wait, never start a second
        await adoptFleet(lastSession)
        break
      }
      if (!feature || !hasManifest(feature)) {
        run.status = 'failed: spec left no manifest'
        break
      }
      const f = runFleet({ copy, feature, outDir, env: {} })
      run.sessions.push(...f.sessions)
      run.status = f.status
      continue
    }
    const file = join(outDir, `session-${String(n).padStart(2, '0')}-${s.name}.jsonl`)
    const r = await runSession({ copy, name: s.name, prompt: s.prompt, outFile: file, claudeArgs: s.flags, systemPrompt: s.system, model: plan.model })
    run.sessions.push(sessionRecord({ name: s.name, lane: null, prompt: s.prompt, file, copy }))
    lastSession = s.name
    const ok = r.exit === 0
    if (m.pipeline === 'builder') {
      const rec = brainstormOf(copy)
      if (!rec) {
        if (ok) run.status = 'failed: brainstorm left no record'
      } else {
        feature = rec.feature
        const handedOffInChat = rec.header?.status === 'handed-off' && !hasManifest(feature) && !existsSync(join(copy, 'docs', 'features', '_archive', feature)) && !hasFleetRecord(copy, feature)
        if (ok && ((rec.header?.status === 'sized' && (rec.header.size === 'xs' || rec.header.size === 'sm')) || handedOffInChat)) {
          run.path = 'in-chat'
          break
        }
        // a fleet the session launched is taken whatever way the session ended
        if (fleetLive(copy) || hasFleetRecord(copy, feature)) {
          await adoptFleet(s.name)
          if (r.exit === null && run.status !== 'timed out') run.sessionTimedOut = s.name
          break
        }
        if (ok && hasManifest(feature)) skipToFleet = true
        else if (ok && s.name === 'spec') run.status = 'failed: spec left no manifest'
      }
    }
    if (run.status === 'done') {
      if (r.exit === null) run.status = 'timed out'
      else if (!ok) run.status = `failed: session ${s.name} exit ${r.exit}`
    }
    // GSD's --auto may run the whole pipeline in one session: once the phase is verified the rest is noise
    if (m.pipeline === 'gsd' && gsdVerified(copy)) {
      run.stoppedEarly = `phase verified after ${s.name}`
      break
    }
  }
  if (!run.status.startsWith('not run')) {
    run.score = score(copy, plan.feature)
    try {
      run.gitLog = git(copy, 'log', '--oneline', 'main').split('\n')
    } catch {}
  }
  run.endedAt = Date.now()
  run.ms = run.endedAt - run.startedAt
  run.totals = runTotals(run.sessions)
  return run
}

function versions() {
  const builder = JSON.parse(readFileSync(join(BUILDER, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const sp = superpowersDir()
  return { builder, superpowers: sp ? basename(sp) : null, gsd: null }
}

export async function runAll(plan) {
  const outRoot = join(RESULTS, plan.id)
  mkdirSync(outRoot, { recursive: true })
  const data = { runId: plan.id, feature: plan.feature, model: plan.model, startedAt: Date.now(), endedAt: null, versions: versions(), runs: [] }
  const save = () => {
    writeJson(join(outRoot, 'runs.json'), data)
    writeFileSync(join(outRoot, 'REPORT.md'), renderReport(data))
  }
  save()
  for (let rep = 1; rep <= plan.repeat; rep++) {
    for (const m of plan.configs) {
      console.log(`▶ ${m.config}${plan.repeat > 1 ? ` rep ${rep}` : ''}`)
      const t0 = Date.now()
      try {
        data.runs.push(await runConfig(plan, m, rep, data, outRoot))
      } catch (err) {
        data.runs.push({ config: m.config, pipeline: m.pipeline, profile: m.profile, rep, status: `crashed: ${String(err?.message ?? err).split('\n')[0]}`, path: 'pipeline', startedAt: t0, endedAt: Date.now(), ms: Date.now() - t0, sessions: [], totals: runTotals([]), score: null, copy: null, gitLog: [] })
      }
      data.endedAt = Date.now()
      save()
      console.log(`  ${data.runs.at(-1).status} in ${Math.round(data.runs.at(-1).ms / 1000)}s`)
    }
  }
  rmSync(join(outRoot, 'progress.json'), { force: true })
  console.log(`\n${renderStatusTable(data, null)}\nreport: ${join(outRoot, 'REPORT.md')}`)
}

// ---- CLI -----------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null)
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const RESULTS = resultsDir(ROOT)
const FEATURES = join(BUILDER, 'bench', 'features')
const FIXTURE = join(BUILDER, 'bench', 'fixture')

function planRun() {
  const feature = argv[1]
  if (!feature || feature.startsWith('--')) die('usage: bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach]')
  if (feature !== basename(feature) || feature.startsWith('.')) die('feature must be a plain directory name')
  if (!existsSync(join(FEATURES, feature, 'request.md'))) die(`no feature '${feature}' — bench/features/ has: ${readdirSync(FEATURES).join(', ') || 'nothing'}`)
  const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
  for (const c of only ?? []) if (!MATRIX.some((m) => m.config === c)) die(`unknown config '${c}' — one of ${MATRIX.map((m) => m.config).join(', ')}`)
  const repeat = Math.max(1, Number(opt('--repeat')) || 1)
  const model = opt('--model')
  const request = readFileSync(join(FEATURES, feature, 'request.md'), 'utf8').trim()
  const configs = MATRIX.filter((m) => !only || only.includes(m.config))
  return { feature, request, configs, repeat, model, id: process.env.BENCH_RUN_ID ?? runId(feature) }
}

/** The sessions a config would run in a copy, with the flags and the owner prompt each gets. */
export function sessionsFor(m, copy, request) {
  const flags = flagsFor(m.pipeline, copy)
  return DRIVERS[m.pipeline]({ copy, request, profile: m.profile }).map((s) => ({ ...s, flags, system: s.system ? `${OWNER_PROMPT}\n\n${s.system}` : OWNER_PROMPT }))
}

function dryRun(plan) {
  const dest = join(TMP, plan.id, '_dry')
  const m0 = plan.configs[0]
  prepareCopy({ fixture: FIXTURE, dest, claudeArgs: flagsFor('builder', dest).join(' ') })
  console.log(`benchmark ${plan.id} — feature ${plan.feature}, ${plan.configs.length} config(s) × ${plan.repeat} rep(s)${plan.model ? `, model ${plan.model}` : ''}`)
  console.log(`copies under ${join(TMP, plan.id)}; results in ${join(RESULTS, plan.id)}`)
  console.log('')
  for (const m of plan.configs) {
    const sessions = sessionsFor(m, dest, plan.request)
    console.log(`${m.config}: ${sessions.length} session${sessions.length === 1 ? '' : 's'}  (claude ${sessions[0].flags.join(' ')})`)
    for (const s of sessions) console.log(`  ${s.name}: ${s.fleet ? `node ${process.env.BENCH_FLEET || join(BUILDER, 'scripts', 'fleet.mjs')} <feature> --parallel 1` : s.prompt.split('\n')[0].slice(0, 110)}${s.system.includes('choose **') ? `   [${/choose \*\*\w+\*\*/.exec(s.system)[0]}]` : ''}`)
  }
  console.log('')
  for (const pipeline of [...new Set(plan.configs.map((m) => m.pipeline))]) {
    const r = spawnSync(CLAUDE, ['-p', 'reply with the single word ok', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', ...flagsFor(pipeline, dest)], { cwd: dest, encoding: 'utf8', timeout: 120000 })
    try {
      if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`)
      const init = (r.stdout || '').split('\n').find((l) => l.includes('"subtype":"init"'))
      if (!init) throw new Error('no init event')
      const loaded = (JSON.parse(init).plugins ?? []).filter((x) => x.path !== 'builtin')
      console.log(`plugins a ${pipeline} session loads:${loaded.length ? '' : ' (none)'}`)
      for (const x of loaded) console.log(`  ${x.name} ${x.version} (${x.path})`)
    } catch (e) {
      console.log(`could not probe ${pipeline}'s plugins (${e.message})`)
    }
  }
  console.log(`gsd install: ${GSD_INSTALL}`)
}

// ---- the lock, status, report, clean, detach ------------------------------------------------------

const LOCK = join(RESULTS, 'lock')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** { pid, runId } of a live benchmark, 'dead' with the stale lock's runId, or null. */
function lockState() {
  let l
  try {
    l = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch {
    return null
  }
  return Number.isInteger(l.pid) && alive(l.pid) ? { live: true, ...l } : { live: false, ...l }
}
/** Take the lock atomically (wx). A dead holder's lock is cleared; a live other holder is a refusal. */
function acquireLock(pid, runId) {
  const held = lockState()
  if (held && !held.live) rmSync(LOCK, { force: true })
  try {
    writeFileSync(LOCK, JSON.stringify({ pid, runId }), { flag: 'wx' })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const l = lockState()
    if (l?.pid === pid || l?.pid === process.pid) return // the lock is already ours (the detach parent wrote it for this child)
    die(`a benchmark is running (pid ${l?.pid}, ${l?.runId}) — /builder:benchmark --status`)
  }
}
const latestRun = () => (existsSync(RESULTS) ? readdirSync(RESULTS).filter((n) => existsSync(join(RESULTS, n, 'runs.json'))).sort().at(-1) ?? null : null)
const readRun = (id) => JSON.parse(readFileSync(join(RESULTS, id, 'runs.json'), 'utf8'))

function status() {
  const lock = lockState()
  const id = lock?.runId && existsSync(join(RESULTS, lock.runId, 'runs.json')) ? lock.runId : latestRun()
  if (!id) return console.log('no benchmark has run here yet — /builder:benchmark starts one')
  const data = readRun(id)
  const pf = join(RESULTS, id, 'progress.json')
  const progress = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : null
  console.log(`# benchmark ${id} — ${data.feature}\n`)
  if (lock?.live) console.log(renderStatusTable(data, progress))
  else {
    console.log(renderStatusTable(data, null))
    if (lock && !lock.live && progress) console.log(`⚠ benchmark stopped mid-run (config ${progress.config}) — its process is gone; the finished configs are in the table. Re-run with --only for the rest.`)
  }
  console.log(`report: ${join(RESULTS, id, 'REPORT.md')}`)
}

// imported (by the tests) the file only exports; the CLI runs when it is the script
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
const cmd = isMain ? argv[0] : null
if (cmd === 'status') {
  status()
  process.exit(0)
}
if (cmd === 'report') {
  const id = argv[1]
  if (!id || id !== basename(id) || id.startsWith('.')) die(`run id must be a plain directory name: '${id ?? ''}'`)
  if (!existsSync(join(RESULTS, id, 'runs.json'))) die(`no run '${id ?? ''}' under ${RESULTS}`)
  const data = readRun(id)
  writeFileSync(join(RESULTS, id, 'REPORT.md'), renderReport(data))
  console.log(renderStatusTable(data, null))
  console.log(`report: ${join(RESULTS, id, 'REPORT.md')}`)
  process.exit(0)
}
if (cmd === 'clean') {
  const lock = lockState()
  if (lock?.live) die(`a benchmark is running (pid ${lock.pid}, ${lock.runId}) — not cleaning`)
  rmSync(TMP, { recursive: true, force: true })
  console.log(`removed ${TMP}`)
  process.exit(0)
}
if (cmd === 'run') {
  const plan = planRun()
  if (flag('--dry-run')) {
    dryRun(plan)
    process.exit(0)
  }
  const held = lockState()
  if (held?.live && held.pid !== process.pid) die(`a benchmark is running (pid ${held.pid}, ${held.runId}) — /builder:benchmark --status`)
  mkdirSync(RESULTS, { recursive: true })
  if (!resultsDir(ROOT).endsWith(join('bench', 'results'))) {
    const ignore = join(ROOT, '.builder', '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  }
  if (flag('--detach')) {
    const outFd = openSync(join(RESULTS, 'bench.out'), 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], { cwd: process.cwd(), env: { ...process.env, BENCH_RUN_ID: plan.id }, detached: true, stdio: ['ignore', outFd, outFd] })
    child.unref()
    try {
      acquireLock(child.pid, plan.id)
    } catch (e) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      throw e
    }
    console.log(`bench started detached (pid ${child.pid}) — output in ${join(RESULTS, 'bench.out')} · /builder:benchmark --status`)
    process.exit(0)
  }
  acquireLock(process.pid, plan.id)
  try {
    await runAll(plan)
  } finally {
    if (lockState()?.pid === process.pid) rmSync(LOCK, { force: true })
  }
  process.exit(0)
}
if (isMain) die('usage: bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach] | report <run-id> | status | clean')
