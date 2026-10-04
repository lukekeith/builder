/**
 * Build profiles — the single owner of presets → levers, the floors, the recommendation made from a
 * feature's SPEC.md / PLAN.md, and estimates drawn only from recorded build history.
 *
 *   node scripts/profile.mjs --levers <folder>
 *   node scripts/profile.mjs --recommend <folder>
 *   node scripts/profile.mjs --estimate <folder> --profile <p>
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseManifest } from './manifest.mjs'
import { loadConfig } from './config.mjs'

export const PRESETS = {
  rush:           { testing: 'none',       review: 'final',           models: 'economy', verify: 'floors',     persist: 'low',     unruled: 'recommend', landing: 'local' },
  standard:       { testing: 'risky',      review: 'per-task',        models: 'default', verify: 'full',       persist: 'default', unruled: 'recommend', landing: 'local' },
  thorough:       { testing: 'full',       review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
  'thorough-you': { testing: 'full+human', review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
}
export const LEVERS = { testing: ['none','risky','full','full+human'], review: ['final','per-task','per-task+second'], models: ['economy','default','strong'], verify: ['floors','full','everything'], persist: ['low','default'], unruled: ['recommend','park'], landing: ['local'] }
// Thorough is today's pipeline; `strong` and `per-task+second` are Customize-only. PR + CI landing is
// deferred (the fleet never pushes), so `landing` keeps its key with one value and old manifests stay valid.
/** How a resolved preset name reads in a table; one map for every status view. */
export const PROFILE_LABELS = { rush: 'rush', standard: 'standard', thorough: 'thorough', 'thorough-you': 'thorough + you', custom: 'custom' }
/** preset → its label; none → `—`, an unknown name → `thorough`. */
export const profileLabel = (preset) => (preset ? (PROFILE_LABELS[preset] ?? 'thorough') : '—')
export const FLOORS = { fastGates: true, finalReview: true, releasedParity: true, projectRequirements: true }

const result = (preset, levers, warning) => ({ preset, levers: { ...levers }, floors: { ...FLOORS }, warning })

/** 'standard' | 'custom testing=risky review=final' | undefined → { preset, levers, floors, warning|null } */
export function parseProfile(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v === '' || v === 'none') return result('thorough', PRESETS.thorough, null)
  if (Object.hasOwn(PRESETS, v)) return result(v, PRESETS[v], null)
  const [head, ...pairs] = v.split(/\s+/)
  if (head === 'custom') {
    const levers = { ...PRESETS.standard }
    const warnings = []
    for (const pair of pairs) {
      const i = pair.indexOf('=')
      const k = i < 0 ? pair : pair.slice(0, i)
      const val = i < 0 ? '' : pair.slice(i + 1)
      if (Object.hasOwn(LEVERS, k) && LEVERS[k].includes(val)) levers[k] = val
      else warnings.push(pair)
    }
    return result('custom', levers, warnings.length ? `ignored custom ${warnings.length > 1 ? 'values' : 'value'} ${warnings.join(', ')}` : null)
  }
  return result('thorough', PRESETS.thorough, `unknown profile "${v}" — using thorough`)
}

/** Slice from `## <name>` to the next `## ` (exclusive). '' when absent. */
export function section(text, name) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => l.trimEnd() === `## ${name}`)
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
  return lines.slice(start + 1, end).join('\n')
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/** A table's data rows (as cell arrays): the `|` lines after the `|---` separator. */
function tableRows(sectionText) {
  const rows = []
  let seenSep = false
  for (const line of sectionText.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (/^\|\s*:?-{2,}/.test(line.trim())) { seenSep = true; continue }
    if (seenSep) rows.push(cells(line))
  }
  return rows
}

/** → { tasks, phases, apps } */
export function planSize(planText) {
  const text = String(planText ?? '')
  const tasks = (text.match(/^### Task \d+/gm) ?? []).length
  const rows = tableRows(section(text, 'Phases'))
  return { tasks, phases: rows.length, apps: new Set(rows.map((r) => r[1]).filter(Boolean)).size }
}

const AUTH_SIGNAL = /\b(roles?|admins?|permissions?|owners?|scopes?)\b/i
const DELETE_VERB = /\b(delete|remove)\b/i

function mentionsMigration(planText) {
  const blocks = String(planText ?? '').split(/^(?=### Task \d+)/m).filter((b) => /^### Task \d+/.test(b))
  return blocks.some((b) => {
    const lines = b.split('\n')
    const files = lines.find((l) => /^\*{0,2}Files:?\*{0,2}/.test(l)) ?? ''
    return /migration/i.test(lines[0]) || /migration/i.test(files)
  })
}

/** → { preset: 'rush'|'standard'|'thorough', signals: string[] } */
export function recommend({ specText, planText, cfg }) {
  const apps = tableRows(section(specText, 'Apps')).filter((r) => r[1]?.includes('✅')).length
  const contract = tableRows(section(specText, 'Contract'))
  const schema = tableRows(section(specText, 'Schema & API changes'))
  const released = new Set(cfg?.released ?? [])
  const signals = []
  if (schema.length) signals.push('schema change')
  if (mentionsMigration(planText)) signals.push('migration')
  if (contract.some((r) => (r[2] ?? '').split(/[,\s/]+/).some((c) => released.has(c.replace(/[`*]/g, ''))))) signals.push('released consumer')
  if (apps >= 3) signals.push(`${apps} apps`)
  // A permission or role in the Auth cell, or a delete verb anywhere in the row. A plain session or
  // signed-in user is every endpoint's auth, not a signal.
  if (contract.some((r) => AUTH_SIGNAL.test(r[3] ?? '') || DELETE_VERB.test(r.join(' ')))) signals.push('auth or delete')
  if (signals.length) return { preset: 'thorough', signals }
  const { tasks } = planSize(planText)
  if (apps === 1 && !contract.length && tasks <= 5) return { preset: 'rush', signals: ['1 app', `${tasks} tasks`, 'no contract'] }
  return { preset: cfg?.buildProfileDefault ?? 'standard', signals: [] }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Comparable rows need positive task counts, observed elapsed time and token usage.
 * Cost is returned only if every comparable row has a recorded numeric cost in the same currency.
 */
export function estimate(rows, preset, tasks) {
  if (!Number.isSafeInteger(tasks) || tasks <= 0 || !Array.isArray(rows)) return null
  const usable = rows.flatMap((row) => {
    if (!row || row.profile !== preset || !Number.isSafeInteger(row.size?.tasks) || row.size.tasks <= 0) return []
    if (!row.lanes || typeof row.lanes !== 'object' || Array.isArray(row.lanes) || !row.tokens || typeof row.tokens !== 'object') return []
    const durations = Object.values(row.lanes)
    const tokens = [row.tokens.input ?? 0, row.tokens.output ?? 0]
    if (![...durations, ...tokens].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return []
    const elapsed = durations.reduce((a, b) => a + b, 0)
    const spent = tokens.reduce((a, b) => a + b, 0)
    if (!Number.isFinite(elapsed) || elapsed <= 0 || !Number.isFinite(spent) || spent <= 0) return []
    return [{ minutes: elapsed / 60000 / row.size.tasks, tokens: spent / row.size.tasks, cost: row.cost, tasks: row.size.tasks }]
  })
  if (usable.length < 3) return null
  const out = {
    minutes: Math.round(median(usable.map((r) => r.minutes)) * tasks),
    tokens: Math.round(median(usable.map((r) => r.tokens)) * tasks),
    n: usable.length,
  }
  if (!Number.isFinite(out.minutes) || !Number.isFinite(out.tokens)) return null
  if (usable.every((r) => typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0)) {
    const cost = median(usable.map((r) => r.cost / r.tasks)) * tasks
    if (Number.isFinite(cost)) out.cost = Number(cost.toFixed(4))
  }
  return out
}

const USAGE = 'usage: profile.mjs --levers|--recommend|--estimate <folder> [--profile <p>] [--history <jsonl>] [--root <project>]'
const MODES = ['--levers', '--recommend', '--estimate']

/** Strict option parsing is shared with tests; no missing value becomes a folder by accident. */
export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const out = {}
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const [flag, ...inline] = argv[i].split('=')
    if (![...MODES, '--profile', '--history', '--root'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`)
    seen.add(flag)
    const value = inline.length ? inline.join('=') : argv[++i]
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (MODES.includes(flag)) {
      if (out.mode) throw new Error('Choose exactly one of --levers, --recommend, --estimate')
      out.mode = flag
      out.folder = value
    } else out[flag.slice(2)] = value
  }
  if (!out.mode) throw new Error(USAGE)
  if (out.history && out.mode !== '--estimate') throw new Error('--history is only valid with --estimate')
  if (out.profile && out.mode === '--recommend') throw new Error('--profile is only valid with --levers or --estimate')
  return out
}

const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : ''

function projectRoot(folder) {
  try { return execFileSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return process.cwd() }
}

/** Prefer native Codex records; legacy fleet archives are read-only compatibility input. */
export function historyPath(root) {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const canonical = join(resolve(root, common), 'builder-codex', 'archive.jsonl')
    if (existsSync(canonical)) return canonical
  } catch { /* A project without Git can still provide --history or a legacy archive. */ }
  return join(root, '.builder', 'fleet', 'archive.jsonl')
}

export function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) { console.log(USAGE); return }
  const dir = resolve(opts.folder)
  if (!statSync(dir).isDirectory()) throw new Error(`Feature folder is not a directory: ${dir}`)
  const root = opts.root ? resolve(opts.root) : projectRoot(dir)
  const manifest = parseManifest(read(join(dir, 'MANIFEST.md')))
  let out
  if (opts.mode === '--levers') {
    out = parseProfile(opts.profile ?? manifest.profile)
    if (out.warning) console.error(`builder: ${out.warning}`)
  } else if (opts.mode === '--recommend') {
    const cfg = loadConfig(root)
    if (!cfg.ok) throw new Error(cfg.reason)
    if (cfg.buildProfileDefaultInvalid !== null) console.error(`builder: build_profile_default: "${cfg.buildProfileDefaultInvalid}" is not one of rush, standard, thorough; ignoring`)
    out = recommend({ specText: read(join(dir, 'SPEC.md')), planText: read(join(dir, 'PLAN.md')), cfg })
  } else {
    const parsed = parseProfile(opts.profile ?? manifest.profile)
    if (parsed.warning) console.error(`builder: ${parsed.warning}`)
    const path = opts.history ? resolve(root, opts.history) : historyPath(root)
    // An explicitly requested missing archive is an input error; absent default history is normal.
    const text = opts.history ? readFileSync(path, 'utf8') : read(path)
    const rows = text.split('\n').filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    out = estimate(rows, parsed.preset, planSize(read(join(dir, 'PLAN.md'))).tasks)
  }
  console.log(JSON.stringify(out))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(`builder: ${error.message}`); process.exitCode = 2 }
}
