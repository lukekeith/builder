/**
 * The test plan — the single owner of its levers (walk · review, plus models/persist/unruled/human),
 * the floors, the mapping of an old `profile:` or a 5.x `slice=… end=…` manifest onto it, the
 * recommendation made from a feature's SPEC.md / PLAN.md, what a plan costs in reviews and walking,
 * and estimates drawn only from recorded build history. Tests are not a lever: the verifier runs
 * every commit's affected tests, waits at each phase close and runs everything on the merged result.
 *
 *   node scripts/profile.mjs --levers <folder> [--tests "<value>" | --profile <p>]
 *   node scripts/profile.mjs --recommend <folder>
 *   node scripts/profile.mjs --estimate <folder> [--tests "<value>" | --profile <p>]
 *   node scripts/profile.mjs --cost <folder> [--tests "<value>" | --profile <p>]
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseManifest, isSet } from './manifest.mjs'
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
/** How a resolved preset name reads in a table; one map for every status view. `here` is not a profile: it labels a feature built in its own session (`build: here`). */
export const PROFILE_LABELS = { rush: 'rush', standard: 'standard', thorough: 'thorough', 'thorough-you': 'thorough + you', custom: 'custom', here: 'here' }
/** preset → its label; none → `—`, an unknown name → `thorough`. */
export const profileLabel = (preset) => (preset ? (PROFILE_LABELS[preset] ?? 'thorough') : '—')
/**
 * What holds under every test plan. Claude's floor is the final whole-branch review (tests are the
 * verifier's under every plan); this port keeps its stricter ones too — the merged result is tested
 * fresh before it lands, released consumers stay compatible, and project-mandated checks always run.
 */
export const FLOORS = { finalReview: true, freshMerge: true, releasedParity: true, projectRequirements: true }

/** The test-plan levers, recommended value first. `review=slice+second` and `human=yes` are Other-only. */
export const TEST_LEVERS = {
  walk: ['none', 'risk', 'full'],
  review: ['end', 'app', 'slice', 'slice+second'],
  models: ['default', 'economy', 'strong'],
  persist: ['default', 'low'],
  unruled: ['recommend', 'park'],
  human: ['yes'],
}
/** The fast plan; `human` is absent (the agents land it alone). */
export const RECOMMENDED = Object.fromEntries(Object.entries(TEST_LEVERS).filter(([k]) => k !== 'human').map(([k, v]) => [k, v[0]]))
const CORE = ['walk', 'review']
const EXTRA = ['models', 'persist', 'unruled']
const WALK_RANK = ['none', 'risk', 'full']
const atLeast = (walk, floor) => (WALK_RANK.indexOf(walk) >= WALK_RANK.indexOf(floor) ? walk : floor)

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

/** levers → the manifest value: the two levers always, the rest only when not the default. */
export function formatTests(levers) {
  const l = levers ?? {}
  const pairs = CORE.map((k) => `${k}=${l[k] ?? RECOMMENDED[k]}`)
  for (const k of EXTRA) if (l[k] && l[k] !== RECOMMENDED[k]) pairs.push(`${k}=${l[k]}`)
  if (l.human === 'yes') pairs.push('human=yes')
  return pairs.join(' ')
}

/** levers → `none · end`, with ` · you` when human=yes. */
export const planLabel = (levers) => [...CORE.map((k) => levers?.[k] ?? RECOMMENDED[k]), ...(levers?.human === 'yes' ? ['you'] : [])].join(' · ')

/** What a manifest written before 6.0 says, in 6.0's levers: `end` chose the walk; `slice` is the verifier's now. */
const OLD_END_WALK = { none: 'none', touched: 'none', risk: 'risk', everything: 'full' }
const OLD_SLICE = ['own', 'own+app', 'full', 'none']

/** 'walk=risk review=end …' → { levers, warning|null }. Missing keys are recommended; a `(note)` is skipped. */
export function parseTests(value) {
  const levers = { ...RECOMMENDED }
  const bad = []
  const v = String(value ?? '').replace(/\([^)]*\)/g, ' ').trim()
  for (const pair of v ? v.split(/\s+/) : []) {
    const i = pair.indexOf('=')
    const k = i < 0 ? pair : pair.slice(0, i)
    const val = i < 0 ? '' : pair.slice(i + 1)
    if (k === 'slice' && OLD_SLICE.includes(val)) continue
    if (k === 'end' && Object.hasOwn(OLD_END_WALK, val)) levers.walk = OLD_END_WALK[val]
    else if (k === 'walk' && val === 'you') levers.human = 'yes'
    else if (Object.hasOwn(TEST_LEVERS, k) && TEST_LEVERS[k].includes(val)) levers[k] = val
    else bad.push(pair)
  }
  return { levers, warning: bad.length ? `ignored tests ${bad.length > 1 ? 'values' : 'value'} ${bad.join(', ')}` : null }
}

const OLD_WALK = { none: 'none', risky: 'risk', full: 'full', 'full+human': 'full' }
const OLD_VERIFY = { floors: 'none', full: 'risk', everything: 'full' }
const OLD_REVIEW = { final: 'end', 'per-task': 'slice', 'per-task+second': 'slice+second' }

/** Resolved old levers (parseProfile) → test-plan levers. */
function fromOld(old) {
  const levers = { ...RECOMMENDED, walk: atLeast(OLD_WALK[old.testing], OLD_VERIFY[old.verify]), review: OLD_REVIEW[old.review] }
  for (const k of EXTRA) levers[k] = old[k]
  if (old.testing === 'full+human') levers.human = 'yes'
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
 * → { tests: { walk, review [, models, persist] }, signals, reason }. The base is the recommended
 * plan, or build_profile_default's mapping; a signal raises only `walk`, to at least `risk`.
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
    tests.walk = atLeast(tests.walk, 'risk')
    reason = `walk raised to ${tests.walk}: ${signals.join(', ')}`
  }
  return { tests, signals, reason }
}

/** → { slices, apps, phases, reviews, walk }: what the plan costs in reviews, and how much an agent walks. Tests are the verifier's. */
export function cost({ planText, levers }) {
  const l = { ...RECOMMENDED, ...(levers ?? {}) }
  const { tasks, phases, apps } = planSize(planText)
  const reviews = (l.review.startsWith('slice') ? tasks : l.review === 'app' ? phases : 0) + 1
  return { slices: tasks, apps, phases, reviews, walk: l.walk }
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
      out = cost({ planText, levers })
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

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(`builder: ${error.message}`); process.exitCode = 2 }
}
