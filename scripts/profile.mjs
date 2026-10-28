/**
 * The test plan — the single owner of its levers (walk · review, plus models/persist/unruled/human),
 * the floor, the mapping of an old `profile:` or old `slice/end` manifest onto it, the recommendation
 * made from a feature's SPEC.md / PLAN.md, what a plan costs in reviews, and the time/token estimate
 * drawn from fleet history.
 *
 *   node scripts/profile.mjs --levers <folder>
 *   node scripts/profile.mjs --recommend <folder>
 *   node scripts/profile.mjs --estimate <folder> [--tests "<value>"]
 *   node scripts/profile.mjs --cost <folder> [--tests "<value>"]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseManifest, isSet } from './manifest.mjs'
import { loadConfig } from './config.mjs'

// The old `profile:` presets and levers — read only to map an old manifest onto the test plan (spec §6).
const PRESETS = {
  rush:           { testing: 'none',       review: 'final',           models: 'economy', verify: 'floors',     persist: 'low',     unruled: 'recommend', landing: 'local' },
  standard:       { testing: 'risky',      review: 'per-task',        models: 'default', verify: 'full',       persist: 'default', unruled: 'recommend', landing: 'local' },
  thorough:       { testing: 'full',       review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
  'thorough-you': { testing: 'full+human', review: 'per-task',        models: 'default', verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
}
const LEVERS = { testing: ['none','risky','full','full+human'], review: ['final','per-task','per-task+second'], models: ['economy','default','strong'], verify: ['floors','full','everything'], persist: ['low','default'], unruled: ['recommend','park'], landing: ['local'] }
/** What holds under every test plan: the final whole-branch review. (Tests are the verifier's — every tier runs whatever the plan says.) */
export const FLOORS = { finalReview: true }

/** The test-plan levers, recommended value first. `human=yes` is Other-only. */
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

/** An old `profile:` value — 'standard' | 'custom testing=risky review=final' | undefined → { preset, levers, floors, warning|null } */
function parseProfile(value) {
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

/** 'walk=risk review=end …' → { levers, warning|null }. Missing keys are recommended; a `(note)` is skipped. */
export function parseTests(value) {
  const levers = { ...RECOMMENDED }
  const bad = []
  const v = String(value ?? '').replace(/\([^)]*\)/g, ' ').trim()
  for (const pair of v ? v.split(/\s+/) : []) {
    const i = pair.indexOf('=')
    const k = i < 0 ? pair : pair.slice(0, i)
    const val = i < 0 ? '' : pair.slice(i + 1)
    if (k === 'slice') continue
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

/** preset name → its test-plan levers. */
const presetLevers = (preset) => fromOld(parseProfile(preset).levers)

/**
 * The parsed manifest → { levers, label, source: 'tests'|'profile'|'default', floors, warning|null }.
 * `tests:` wins; else `profile:` mapped; else a go-ahead'd feature is the thorough mapping (the
 * pipeline it was approved under) and an unplanned one the recommended plan, labelled `—`.
 * `build: here` labels `here`.
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

const AUTH_SIGNAL = /\b(role|admin|permission|owner|scope)/i
const DELETE_VERB = /\b(delete|remove)/i

function mentionsMigration(planText) {
  const blocks = String(planText ?? '').split(/^(?=### Task \d+)/m).filter((b) => /^### Task \d+/.test(b))
  return blocks.some((b) => {
    const lines = b.split('\n')
    const files = lines.find((l) => /^\*{0,2}Files:?\*{0,2}/.test(l)) ?? ''
    return /migration/i.test(lines[0]) || /migration/i.test(files)
  })
}

/**
 * → { tests: { walk, review [, models, persist] }, signals, reason }. The base is the
 * recommended plan, or build_profile_default's mapping; a signal raises only walk, to at least `risk`.
 */
export function recommend({ specText, planText, cfg }) {
  const apps = tableRows(section(specText, 'Apps')).filter((r) => r[1]?.includes('✅')).length
  const contract = tableRows(section(specText, 'Contract'))
  const schema = tableRows(section(specText, 'Schema & API changes'))
  const released = new Set(cfg?.released ?? [])
  const signals = []
  // An ADD is new surface nothing reads yet; an EDIT, RENAME or REMOVE changes what existing data or
  // callers rely on. (A stored-schema ADD that needs a migration is caught by the migration signal.)
  if (schema.some((r) => /^(EDIT|RENAME|REMOVE)$/i.test((r[1] ?? '').replace(/[`*]/g, '')))) signals.push('breaking schema change')
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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * An archive row's (or a fleet entry's noted facts') plan label: its `tests` value, else its old
 * `profile` preset mapped; null when neither.
 */
export function rowLabel(r) {
  if (!r) return null
  if (isSet(r.tests)) return planLabel(parseTests(r.tests).levers)
  if (r.profile === 'here') return 'here'
  return isSet(r.profile) ? planLabel(presetLevers(r.profile)) : null
}

/** rows: archive.jsonl rows; label: planLabel → { minutes, tokens, n } | null when fewer than 3 usable rows */
export function estimate(rows, label, tasks) {
  const spent = (r) => (Number(r.tokens.input) || 0) + (Number(r.tokens.output) || 0)
  const usable = (rows ?? []).filter((r) => r && r.size?.tasks > 0 && r.lanes && r.tokens && spent(r) > 0 && rowLabel(r) === label)
  // No plan yet (0 tasks) → no number: the ladder words stand in, never "0 min".
  if (usable.length < 3 || !(tasks > 0)) return null
  const perMin = usable.map((r) => (Object.values(r.lanes).reduce((a, b) => a + (Number(b) || 0), 0) / 60000) / r.size.tasks)
  const perTok = usable.map((r) => spent(r) / r.size.tasks)
  return { minutes: Math.round(median(perMin) * tasks), tokens: Math.round(median(perTok) * tasks), n: usable.length }
}

async function main(argv) {
  const flag = (f) => argv.includes(f)
  const arg = (f) => argv[argv.indexOf(f) + 1]
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const mode = ['--levers', '--recommend', '--estimate', '--cost'].find(flag)
  if (!mode) { console.error('usage: profile.mjs --levers|--recommend|--estimate|--cost <folder> [--tests "<value>"]'); process.exit(2) }
  const dir = resolve(arg(mode) ?? '')
  const manifest = parseManifest(read(join(dir, 'MANIFEST.md')))
  const planText = read(join(dir, 'PLAN.md'))
  const warn = (w) => w && console.error(`builder: ${w}`)
  const advise = () => {
    const cfg = loadCfg()
    if (cfg.buildProfileDefaultInvalid) console.error(`builder: build_profile_default: "${cfg.buildProfileDefaultInvalid}" is not one of rush, standard, thorough; ignoring`)
    return recommend({ specText: read(join(dir, 'SPEC.md')), planText, cfg })
  }
  // --tests "<value>" → its levers; else (--estimate) an old --profile, else the manifest's line, else the recommendation.
  const chosen = () => {
    if (flag('--tests')) { const t = parseTests(arg('--tests')); warn(t.warning); return t.levers }
    if (flag('--profile')) return presetLevers(arg('--profile'))
    if (isSet(manifest.tests) || isSet(manifest.profile)) { const p = parseTestPlan(manifest); warn(p.warning); return p.levers }
    return { ...RECOMMENDED, ...advise().tests }
  }
  let out
  if (mode === '--levers') {
    out = parseTestPlan(manifest)
    warn(out.warning)
  } else if (mode === '--recommend') out = advise()
  else if (mode === '--estimate') {
    const label = planLabel(chosen())
    const root = repoRoot(dir)
    const rows = root ? read(join(root, '.builder', 'fleet', 'archive.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : []
    out = estimate(rows, label, planSize(planText).tasks)
  } else {
    const levers = chosen()
    out = cost({ planText, levers })
  }
  console.log(JSON.stringify(out))
}

function repoRoot(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: existsSync(dir) ? dir : undefined, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return process.env.CLAUDE_PROJECT_DIR || null }
}

function loadCfg() {
  // The recommendation needs only released[] and buildProfileDefault; a missing config is an empty one.
  const c = loadConfig()
  return c.ok ? c : {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
