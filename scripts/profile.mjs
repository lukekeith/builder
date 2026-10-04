/**
 * Build profiles — the single owner of presets → levers, the floors, the recommendation made from a
 * feature's SPEC.md / PLAN.md, and the time/token estimate drawn from fleet history.
 *
 *   node scripts/profile.mjs --levers <folder>
 *   node scripts/profile.mjs --recommend <folder>
 *   node scripts/profile.mjs --estimate <folder> --profile <p>
 */
import { readFileSync, existsSync } from 'node:fs'
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
export const FLOORS = { fastGates: true, finalReview: true, releasedParity: true }

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

const NONE = new Set(['', '—', '–', '-', 'none'])

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
  if (contract.some((r) => !NONE.has((r[3] ?? '').toLowerCase()) || /delete/i.test(r.join(' ')))) signals.push('auth or delete')
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

/** rows: archive.jsonl rows → { minutes, tokens, n } | null when fewer than 3 usable rows */
export function estimate(rows, preset, tasks) {
  const usable = (rows ?? []).filter((r) => r && r.profile === preset && r.size?.tasks > 0 && r.lanes && r.tokens)
  if (usable.length < 3) return null
  const perMin = usable.map((r) => (Object.values(r.lanes).reduce((a, b) => a + (Number(b) || 0), 0) / 60000) / r.size.tasks)
  const perTok = usable.map((r) => ((Number(r.tokens.input) || 0) + (Number(r.tokens.output) || 0)) / r.size.tasks)
  return { minutes: Math.round(median(perMin) * tasks), tokens: Math.round(median(perTok) * tasks), n: usable.length }
}

function main(argv) {
  const flag = (f) => argv.includes(f)
  const arg = (f) => argv[argv.indexOf(f) + 1]
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const mode = ['--levers', '--recommend', '--estimate'].find(flag)
  if (!mode) { console.error('usage: profile.mjs --levers|--recommend|--estimate <folder> [--profile <p>]'); process.exit(2) }
  const dir = resolve(arg(mode) ?? '')
  const manifest = parseManifest(read(join(dir, 'MANIFEST.md')))
  let out
  if (mode === '--levers') {
    out = parseProfile(manifest.profile)
    if (out.warning) console.error(`builder: ${out.warning}`)
  } else {
    const planText = read(join(dir, 'PLAN.md'))
    if (mode === '--recommend') {
      out = recommend({ specText: read(join(dir, 'SPEC.md')), planText, cfg: loadCfg() })
    } else {
      const preset = flag('--profile') ? arg('--profile') : 'standard'
      let rows = []
      try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
        rows = read(join(root, '.builder', 'fleet', 'archive.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
      } catch {}
      out = estimate(rows, preset, planSize(planText).tasks)
    }
  }
  console.log(JSON.stringify(out))
}

function loadCfg() {
  // The recommendation needs only released[] and buildProfileDefault; a missing config is an empty one.
  const c = loadConfig()
  return c.ok ? c : {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
