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
 * tests point it at a stub), BENCH_GSD_INSTALL (the install command — tests set `true`).
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, createWriteStream, openSync, renameSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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

/** The fixture, copied and made a repo on `main`; the fleet's claude_args filled in. */
export function prepareCopy({ fixture, dest, claudeArgs }) {
  if (/\s/.test(dest)) throw new Error(`the copy's path must contain no spaces (the fleet splits claude_args on whitespace): ${dest} — set BENCH_TMP`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(fixture, dest, { recursive: true })
  const cfg = join(dest, '.claude', 'builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('{claude_args}', claudeArgs))
  writeFileSync(join(dest, '.claude', 'bench-settings.json'), JSON.stringify({ enabledPlugins: { [builderPluginId()]: false, 'superpowers@claude-plugins-official': false } }, null, 2) + '\n')
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
export function sessionRecord({ name, lane, prompt, file }) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = parseStream(text)
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('{'))
  return { name, file, lane, sessionId: parsed.sessionId, model: parsed.model, prompt, totals: sessionTotals(parsed), steps: deriveSteps(parsed, { prompt }), tail: lines.slice(-10) }
}

// ---- the matrix and the drivers ------------------------------------------------------------------

/** Where the superpowers plugin is on this machine, newest version — or null. */
export function superpowersDir() {
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
  builder: ({ request, profile }) => [
    { name: 'brainstorm', prompt: `/builder:brainstorm --auto ${request}`, system: `When asked for a build profile, choose **${profile}**.` },
    { name: 'spec', prompt: '/builder:spec --auto', system: `When asked for a build profile, choose **${profile}**.` },
    { name: 'fleet', fleet: true, system: `When asked for a build profile, choose **${profile}**.` },
  ],
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
  if (!existsSync(join(FEATURES, feature, 'request.md'))) die(`no feature '${feature}' — bench/features/ has: ${readdirSync(FEATURES).join(', ') || 'nothing'}`)
  const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
  for (const c of only ?? []) if (!MATRIX.some((m) => m.config === c)) die(`unknown config '${c}' — one of ${MATRIX.map((m) => m.config).join(', ')}`)
  const repeat = Math.max(1, Number(opt('--repeat')) || 1)
  const model = opt('--model')
  const request = readFileSync(join(FEATURES, feature, 'request.md'), 'utf8').trim()
  const configs = MATRIX.filter((m) => !only || only.includes(m.config))
  return { feature, request, configs, repeat, model, id: runId(feature) }
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
  const list = spawnSync(CLAUDE, ['plugin', 'list', ...flagsFor(m0.pipeline, dest)], { cwd: dest, encoding: 'utf8' })
  console.log(list.status === 0 ? `plugins a ${m0.config} session loads:\n${list.stdout.trim()}` : `could not list plugins (${list.stderr?.trim() || `exit ${list.status}`})`)
  console.log(`gsd install: ${GSD_INSTALL}`)
}

const cmd = argv[0]
if (cmd === 'run' && flag('--dry-run')) {
  dryRun(planRun())
  process.exit(0)
}
