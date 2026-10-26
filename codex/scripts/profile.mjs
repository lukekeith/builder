/**
 * The test plan — the single owner of its levers (slice · end · review, plus models/persist/unruled/
 * walk), the floors, the mapping of an old `profile:` onto it, the recommendation made from a
 * feature's SPEC.md / PLAN.md, what a plan costs in runs and minutes, and estimates drawn only from
 * recorded build history.
 *
 *   node scripts/profile.mjs --levers <folder> [--tests "<value>" | --profile <p>]
 *   node scripts/profile.mjs --recommend <folder>
 *   node scripts/profile.mjs --estimate <folder> [--tests "<value>" | --profile <p>]
 *   node scripts/profile.mjs --cost <folder> [--tests "<value>" | --profile <p>]
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseManifest, isSet } from './manifest.mjs'
import { loadConfig } from './config.mjs'
import { readDurations } from './gates-core.mjs'

export const PRESETS = {
  rush:           { testing: 'none',       review: 'final',           models: 'economy', verify: 'floors',     persist: 'low',     unruled: 'recommend', landing: 'local' },
  standard:       { testing: 'risky',      review: 'per-task',        models: 'default', verify: 'full',       persist: 'default', unruled: 'recommend', landing: 'local' },
  thorough:       { testing: 'full',       review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
  'thorough-you': { testing: 'full+human', review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
}
export const LEVERS = { testing: ['none','risky','full','full+human'], review: ['final','per-task','per-task+second'], models: ['economy','default','strong'], verify: ['floors','full','everything'], persist: ['low','default'], unruled: ['recommend','park'], landing: ['local'] }
// Thorough is today's pipeline; `strong` and `per-task+second` are Customize-only. PR + CI landing is
// deferred (the fleet never pushes), so `landing` keeps its key with one value and old manifests stay valid.
/** How a resolved preset name reads in a table; one map for every status view. `here` is not a profile: it labels a feature built in its own session (`build: here`). */
export const PROFILE_LABELS = { rush: 'rush', standard: 'standard', thorough: 'thorough', 'thorough-you': 'thorough + you', custom: 'custom', here: 'here' }
/** preset → its label; none → `—`, an unknown name → `thorough`. */
export const profileLabel = (preset) => (preset ? (PROFILE_LABELS[preset] ?? 'thorough') : '—')
/**
 * What holds under every test plan. Claude's floors are the touched apps' type-check and the final
 * whole-branch review; this port keeps its stricter ones too — the touched apps' fast gates run at
 * least once, fresh, on the merge candidate (never per phase unless the plan says so), released
 * consumers stay compatible, and project-mandated checks always run.
 */
export const FLOORS = { typecheck: true, fastGates: true, finalReview: true, releasedParity: true, projectRequirements: true }

/** The test-plan levers, recommended value first. `review=slice+second` and `walk=you` are Other-only. */
export const TEST_LEVERS = {
  slice: ['own', 'own+app', 'full', 'none'],
  end: ['touched', 'risk', 'everything', 'none'],
  review: ['end', 'app', 'slice', 'slice+second'],
  models: ['default', 'economy', 'strong'],
  persist: ['default', 'low'],
  unruled: ['recommend', 'park'],
  walk: ['you'],
}
/** The fast plan; `walk` is absent (the agent walks alone). */
export const RECOMMENDED = Object.fromEntries(Object.entries(TEST_LEVERS).filter(([k]) => k !== 'walk').map(([k, v]) => [k, v[0]]))
const CORE = ['slice', 'end', 'review']
const EXTRA = ['models', 'persist', 'unruled']
const END_RANK = ['none', 'touched', 'risk', 'everything']
const atLeast = (end, floor) => (END_RANK.indexOf(end) >= END_RANK.indexOf(floor) ? end : floor)

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

/** levers → the manifest value: the three levers always, the rest only when not the default. */
export function formatTests(levers) {
  const l = levers ?? {}
  const pairs = CORE.map((k) => `${k}=${l[k] ?? RECOMMENDED[k]}`)
  for (const k of EXTRA) if (l[k] && l[k] !== RECOMMENDED[k]) pairs.push(`${k}=${l[k]}`)
  if (l.walk === 'you') pairs.push('walk=you')
  return pairs.join(' ')
}

/** levers → `own · touched · end`, with ` · you` when walk=you. */
export const planLabel = (levers) => [...CORE.map((k) => levers?.[k] ?? RECOMMENDED[k]), ...(levers?.walk === 'you' ? ['you'] : [])].join(' · ')

/** 'slice=own end=risk …' → { levers, warning|null }. Missing keys are recommended; a `(note)` is skipped. */
export function parseTests(value) {
  const levers = { ...RECOMMENDED }
  const bad = []
  const v = String(value ?? '').replace(/\([^)]*\)/g, ' ').trim()
  for (const pair of v ? v.split(/\s+/) : []) {
    const i = pair.indexOf('=')
    const k = i < 0 ? pair : pair.slice(0, i)
    const val = i < 0 ? '' : pair.slice(i + 1)
    if (Object.hasOwn(TEST_LEVERS, k) && TEST_LEVERS[k].includes(val)) levers[k] = val
    else bad.push(pair)
  }
  return { levers, warning: bad.length ? `ignored tests ${bad.length > 1 ? 'values' : 'value'} ${bad.join(', ')}` : null }
}

const OLD_END = { none: 'touched', risky: 'risk', full: 'everything', 'full+human': 'everything' }
const OLD_VERIFY = { floors: 'touched', full: 'risk', everything: 'everything' }
const OLD_REVIEW = { final: 'end', 'per-task': 'slice', 'per-task+second': 'slice+second' }

/** Resolved old levers (parseProfile) → test-plan levers. Every old build ran the app's suite at the phase close. */
function fromOld(old) {
  const levers = { ...RECOMMENDED, slice: 'own+app', end: atLeast(OLD_END[old.testing], OLD_VERIFY[old.verify]), review: OLD_REVIEW[old.review] }
  for (const k of EXTRA) levers[k] = old[k]
  if (old.testing === 'full+human') levers.walk = 'you'
  return levers
}

/** An old `profile:` value (preset or `custom …`) → its test-plan levers. */
export const presetLevers = (value) => fromOld(parseProfile(value).levers)

/**
 * A parsed MANIFEST (or the runtime record mapped to its keys) → { levers, label, source:
 * 'tests'|'profile'|'default', floors, warning|null }. `tests:` wins; else `profile:` mapped; else a
 * go-ahead'd feature is the thorough mapping (the pipeline it was approved under) and an unplanned
 * one the recommended plan, labelled `—`. `build: here` labels `here`.
 */
export function parseTestPlan(manifest) {
  const mf = manifest ?? {}
  let levers, source, warning = null
  if (isSet(mf.tests)) {
    source = 'tests'
    ;({ levers, warning } = parseTests(mf.tests))
  } else if (isSet(mf.profile)) {
    const p = parseProfile(mf.profile)
    source = 'profile'
    levers = fromOld(p.levers)
    warning = p.warning
  } else {
    source = 'default'
    levers = isSet(mf['go-ahead']) ? presetLevers('thorough') : { ...RECOMMENDED }
  }
  const label = mf.build === 'here' ? 'here' : source === 'default' && !isSet(mf['go-ahead']) ? '—' : planLabel(levers)
  return { levers, label, source, floors: { ...FLOORS }, warning }
}

/**
 * The runtime record (lifecycle.mjs) → its test plan. `tests` is set by an approval under the test
 * plan; an older approval holds `profile`, which is mapped. `start` writes `profile: thorough` as a
 * placeholder, so an unapproved profile is no choice at all: before the build that reads `—` (the
 * plan is chosen at the go-ahead), and a legacy build already under way is Thorough.
 */
const UNDER_WAY = ['building', 'built', 'signed-off', 'verified', 'merged', 'blocked']
export const runtimeTestPlan = (m) => parseTestPlan({
  tests: m?.tests,
  profile: !isSet(m?.tests) && m?.profileApproved ? m?.profile || 'thorough' : undefined,
  'go-ahead': m?.profileApproved || UNDER_WAY.includes(m?.phase) ? 'yes' : undefined,
  build: m?.build,
})

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

/**
 * The Phases table's rows as { app, tasks } — by header name, since Codex's PLAN.md puts a Slice
 * column before App (| Phase | Slice | App | Tasks | …) and Claude's does not (| Phase | App | Tasks | …).
 */
function phaseRows(planText) {
  const lines = section(String(planText ?? ''), 'Phases').split('\n').filter((l) => l.trim().startsWith('|'))
  const header = lines.length ? cells(lines[0]).map((c) => c.toLowerCase()) : []
  const appAt = header.indexOf('app') >= 0 ? header.indexOf('app') : 1
  const tasksAt = header.indexOf('tasks') >= 0 ? header.indexOf('tasks') : appAt + 1
  return tableRows(section(String(planText ?? ''), 'Phases')).map((r) => ({ app: r[appAt], tasks: r[tasksAt] }))
}

/** → { tasks, phases, apps } */
export function planSize(planText) {
  const text = String(planText ?? '')
  const tasks = (text.match(/^### Task \d+/gm) ?? []).length
  const rows = phaseRows(text)
  return { tasks, phases: rows.length, apps: new Set(rows.map((r) => r.app).filter(Boolean)).size }
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

/**
 * → { tests: { slice, end, review [, models, persist] }, signals, reason }. The base is the
 * recommended plan, or build_profile_default's mapping; a signal raises only `end`, to at least
 * `risk`. Never `slice=full`.
 */
export function recommend({ specText, planText, cfg }) {
  const apps = tableRows(section(specText, 'Apps')).filter((r) => r[1]?.includes('✅')).length
  const contract = tableRows(section(specText, 'Contract'))
  const schema = tableRows(section(specText, 'Schema & API changes'))
  const released = new Set(cfg?.released ?? [])
  const signals = []
  // An ADD is new surface nothing reads yet; an EDIT, RENAME or REMOVE changes what existing data or
  // callers rely on. (A stored-schema ADD that needs a migration is caught by the migration signal.)
  if (schema.some((r) => /^(EDIT|RENAME|REMOVE)$/i.test((r[0] ?? '').replace(/[`*]/g, '')) || /^(EDIT|RENAME|REMOVE)$/i.test((r[1] ?? '').replace(/[`*]/g, '')))) signals.push('breaking schema change')
  if (mentionsMigration(planText)) signals.push('migration')
  if (contract.some((r) => (r[2] ?? '').split(/[,\s/]+/).some((c) => released.has(c.replace(/[`*]/g, ''))))) signals.push('released consumer')
  if (apps >= 3) signals.push(`${apps} apps`)
  // A permission or role in the Auth cell, or a delete verb anywhere in the row. A plain session or
  // signed-in user is every endpoint's auth, not a signal.
  if (contract.some((r) => AUTH_SIGNAL.test(r[3] ?? '') || DELETE_VERB.test(r.join(' ')))) signals.push('auth or delete')
  const preset = cfg?.buildProfileDefault
  const base = preset ? presetLevers(preset) : RECOMMENDED
  const tests = Object.fromEntries(CORE.map((k) => [k, base[k]]))
  for (const k of EXTRA) if (base[k] !== RECOMMENDED[k]) tests[k] = base[k]
  let reason = preset ? `build_profile_default: ${preset}` : 'the recommended plan'
  if (signals.length) {
    tests.end = atLeast(tests.end, 'risk')
    reason = `end raised to ${tests.end}: ${signals.join(', ')}`
  }
  return { tests, signals, reason }
}

/** Each task's app: its `App:` line, else the Phases row whose Tasks cell holds its number. */
function taskApps(planText) {
  const text = String(planText ?? '')
  const byPhase = new Map()
  for (const { app, tasks: tasksCell } of phaseRows(text)) {
    for (const part of (tasksCell ?? '').split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:[-–](\d+))?$/.exec(part)
      if (m) for (let n = +m[1]; n <= +(m[2] ?? m[1]); n++) byPhase.set(n, app)
    }
  }
  const blocks = text.split(/^(?=### Task \d+)/m).filter((b) => /^### Task \d+/.test(b))
  return blocks.map((b) => {
    const n = +/^### Task (\d+)/.exec(b)[1]
    const own = /^\s*[-*]*\s*\**App:?\**:?\s*`?([\w.-]+)`?/im.exec(b)
    return own?.[1] ?? byPhase.get(n) ?? null
  })
}

const phaseAppsOf = (planText) => phaseRows(planText).map((r) => r.app).filter(Boolean)

/**
 * → { slices, apps, phases, ownRuns, suiteRuns, reviews, walk: 'none'|'risk'|'full', minutes|null }.
 * minutes = Σ suite runs × that app's recorded fast-set duration (gates-core readDurations), when
 * every app that runs a suite has one. The merge candidate's fresh gates (a Codex floor) are extra.
 */
export function cost({ planText, levers, durations }) {
  const l = { ...RECOMMENDED, ...(levers ?? {}) }
  const { tasks, phases, apps } = planSize(planText)
  const phaseApps = phaseAppsOf(planText)
  const appsOf = taskApps(planText)
  const runs = new Map()
  const add = (app, n = 1) => app && runs.set(app, (runs.get(app) ?? 0) + n)
  if (l.slice === 'own+app') phaseApps.forEach((a) => add(a))
  if (l.slice === 'full') appsOf.forEach((a) => add(a))
  if (l.end !== 'none') [...new Set([...phaseApps, ...appsOf.filter(Boolean)])].forEach((a) => add(a))
  const suiteRuns = (l.slice === 'own+app' ? phases : l.slice === 'full' ? tasks : 0) + (l.end !== 'none' ? apps : 0)
  const reviews = (l.review.startsWith('slice') ? tasks : l.review === 'app' ? phases : 0) + 1
  let ms = 0
  for (const [app, n] of runs) {
    const d = durations?.[app]?.total
    if (typeof d !== 'number' || !(d >= 0)) { ms = null; break }
    ms += n * d
  }
  return {
    slices: tasks, apps, phases,
    ownRuns: l.slice === 'none' ? 0 : tasks,
    suiteRuns,
    reviews,
    walk: l.end === 'risk' ? 'risk' : l.end === 'everything' ? 'full' : 'none',
    minutes: ms == null ? null : Math.round(ms / 60000),
  }
}

/** An archive row's plan label: its `tests` value, else its old `profile` mapped; null when neither. */
export function rowLabel(r) {
  if (!r) return null
  if (isSet(r.tests)) return planLabel(parseTests(r.tests).levers)
  if (r.profile === 'here') return 'here'
  return isSet(r.profile) ? planLabel(presetLevers(r.profile)) : null
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Comparable rows need positive task counts, observed elapsed time and token usage.
 * Cost is returned only if every comparable row has a recorded numeric cost in the same currency.
 */
export function estimate(rows, label, tasks) {
  if (!Number.isSafeInteger(tasks) || tasks <= 0 || !Array.isArray(rows)) return null
  const usable = rows.flatMap((row) => {
    if (!row || rowLabel(row) !== label || !Number.isSafeInteger(row.size?.tasks) || row.size.tasks <= 0) return []
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

const USAGE = 'usage: profile.mjs --levers|--recommend|--estimate|--cost <folder> [--tests "<value>" | --profile <p>] [--history <jsonl>] [--root <project>]'
const MODES = ['--levers', '--recommend', '--estimate', '--cost']

/** Strict option parsing is shared with tests; no missing value becomes a folder by accident. */
export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const out = {}
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const [flag, ...inline] = argv[i].split('=')
    if (![...MODES, '--tests', '--profile', '--history', '--root'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`)
    seen.add(flag)
    const value = inline.length ? inline.join('=') : argv[++i]
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (MODES.includes(flag)) {
      if (out.mode) throw new Error('Choose exactly one of --levers, --recommend, --estimate, --cost')
      out.mode = flag
      out.folder = value
    } else out[flag.slice(2)] = value
  }
  if (!out.mode) throw new Error(USAGE)
  if (out.history && out.mode !== '--estimate') throw new Error('--history is only valid with --estimate')
  if ((out.profile || out.tests) && out.mode === '--recommend') throw new Error('--tests and --profile are not valid with --recommend')
  if (out.profile && out.tests) throw new Error('Choose one of --tests or --profile')
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
  const planText = read(join(dir, 'PLAN.md'))
  const warn = (w) => w && console.error(`builder: ${w}`)
  const advise = () => {
    const cfg = loadConfig(root)
    if (!cfg.ok) throw new Error(cfg.reason)
    if (cfg.buildProfileDefaultInvalid !== null) console.error(`builder: build_profile_default: "${cfg.buildProfileDefaultInvalid}" is not one of rush, standard, thorough; ignoring`)
    return recommend({ specText: read(join(dir, 'SPEC.md')), planText, cfg })
  }
  // --tests "<value>" → its levers; else an old --profile mapped; else the manifest's plan.
  const explicit = () => {
    if (opts.tests) { const t = parseTests(opts.tests); warn(t.warning); return { ...parseTestPlan({ tests: formatTests(t.levers) }), warning: t.warning } }
    if (opts.profile) { const p = parseTestPlan({ profile: opts.profile }); warn(p.warning); return p }
    return null
  }
  let out
  if (opts.mode === '--levers') {
    out = explicit()
    if (!out) { out = parseTestPlan(manifest); warn(out.warning) }
  } else if (opts.mode === '--recommend') {
    out = advise()
  } else {
    // --estimate and --cost: the chosen plan, else the manifest's, else the recommendation.
    const levers = explicit()?.levers
      ?? (isSet(manifest.tests) || isSet(manifest.profile) ? (() => { const p = parseTestPlan(manifest); warn(p.warning); return p.levers })() : { ...RECOMMENDED, ...advise().tests })
    if (opts.mode === '--cost') {
      out = cost({ planText, levers, durations: readDurations(root) })
    } else {
      const path = opts.history ? resolve(root, opts.history) : historyPath(root)
      // An explicitly requested missing archive is an input error; absent default history is normal.
      const text = opts.history ? readFileSync(path, 'utf8') : read(path)
      const rows = text.split('\n').filter((line) => line.trim()).flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      out = estimate(rows, planLabel(levers), planSize(planText).tasks)
    }
  }
  console.log(JSON.stringify(out))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(`builder: ${error.message}`); process.exitCode = 2 }
}
