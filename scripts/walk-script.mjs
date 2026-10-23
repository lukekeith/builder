#!/usr/bin/env node
/**
 * walk-script — `<WS>/walk.md` assembled from SPEC §Testing, in the shape build SKILL §When the last
 * phase signs step 4 defines, so the orchestrator only adds what the spec doesn't say.
 *
 *   node <builder>/scripts/walk-script.mjs <folder> [--cross-app | --no-cross-app] [--print]
 *
 * What it writes:
 *   - one section per in-scope app (the manifest's `apps:`, else SPEC §Apps' ✅ rows): where to go
 *     (the app's path and role from the config), a marked orchestrator block, the items §Testing lists
 *     for that app newest-first (§Testing is written in build order, so reversed), each tagged
 *     `[risk]` when it touches a §Contract row (an endpoint path, a command, an env var the contract
 *     names) or an auth / permission / load / save / delete / notification / deep-link path — the
 *     items the agent walk under `end=risk` walks; then the config's §Environment landmines that
 *     concern that app (a landmine naming no app goes under every app);
 *   - under --agent-walk (the manifest's `agent-walk: on`, or --cross-app): `## Cross-app (verify E2E)`,
 *     SPEC §Testing's human-verification / E2E script as numbered steps E1…En, in its order.
 *
 * What stays with the orchestrator: the `<!-- orchestrator: … -->` block of each app — how to reach
 * it (a URL, the command prefix, scratch files), surfaces that cannot work locally, and a readiness
 * step that could not run here (it goes at the top). Also rewording a test-case item into something a
 * person can do, and correcting a [risk] tag the heuristic got wrong. A re-run keeps every
 * orchestrator block as written and rewrites the rest identically.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { openFeature, read, writeAtomic, mdSection, headings, configSection, tableRows, parseArgs, cli, shortHead } from './feature-core.mjs'
import { isSet } from './manifest.mjs'

/** Split a one-paragraph script into steps: on ` · ` when it uses it, else on `;` — outside backticks. */
export function splitSteps(text) {
  const t = text.replace(/\s*\n\s*/g, ' ').trim()
  const outside = (sep) => {
    const parts = []
    let cur = ''
    let tick = false
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '`') tick = !tick
      if (!tick && t.startsWith(sep, i)) {
        parts.push(cur)
        cur = ''
        i += sep.length - 1
        continue
      }
      cur += t[i]
    }
    parts.push(cur)
    return parts.map((p) => p.trim()).filter(Boolean)
  }
  const dots = outside(' · ')
  return dots.length > 1 ? dots : outside(';')
}

const CROSS = /verification|cross-app|\be2e\b|walk script|\bwalk\b/i
const LIST = /^(\s*)(?:\d+[.)]|[-*+])\s+(.*)$/

/**
 * SPEC §Testing → { apps: { <app>: [item] }, cross: { intro, steps } }. A heading or a bold-led line
 * opens a block: one naming an app is that app's, one reading like the verification / E2E script is
 * the cross-app block. Items are the block's list items (sub-bullets joined in); a block with no list
 * is one paragraph split into steps.
 */
export function parseTesting(specText, apps) {
  const body = mdSection(specText, 'Testing', { level: 2 })?.body ?? ''
  const blocks = []
  let cur = { kind: apps.length === 1 ? 'app' : 'none', app: apps.length === 1 ? apps[0] : null, intro: '', lines: [] }
  blocks.push(cur)
  for (const line of body.split('\n')) {
    const h = /^#{3,6}\s+(.*)$/.exec(line)
    const bold = /^\*\*(.+?)\*\*(.*)$/.exec(line.trim())
    const opener = h ? h[1] : bold && !LIST.test(line) ? bold[1] : null
    if (opener != null) {
      const plain = opener.replace(/[`*]/g, '').trim()
      const app = apps.find((a) => new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(plain))
      if (CROSS.test(plain) && !app) {
        const { paren, after } = leadingParen(bold ? bold[2] : '')
        cur = { kind: 'cross', intro: `${plain}${paren ? ` ${paren}` : ''}`, lines: after ? [after] : [] }
        blocks.push(cur)
        continue
      }
      if (app) {
        cur = { kind: 'app', app, intro: plain, lines: [] }
        blocks.push(cur)
        continue
      }
    }
    cur.lines.push(line)
  }
  const out = { apps: Object.fromEntries(apps.map((a) => [a, []])), cross: { intro: '', steps: [] } }
  for (const b of blocks) {
    const items = listItems(b.lines)
    if (b.kind === 'app') out.apps[b.app].push(...items)
    if (b.kind === 'cross') {
      out.cross.intro ||= b.intro
      if (items.length) out.cross.steps.push(...items)
      else out.cross.steps.push(...splitSteps(paragraph(b.lines)))
    }
  }
  return out
}

/** ` (a (nested) note): rest` → { paren: '(a (nested) note)', after: 'rest' } — parentheses balanced. */
function leadingParen(text) {
  const t = text.trim()
  let paren = ''
  let i = 0
  if (t[0] === '(') {
    let depth = 0
    for (; i < t.length; i++) {
      if (t[i] === '(') depth++
      if (t[i] === ')' && --depth === 0) break
    }
    paren = t.slice(0, i + 1)
    i++
  }
  return { paren, after: t.slice(i).replace(/^\s*:?\s*/, '').trim() }
}

function listItems(lines) {
  const items = []
  let cur = null
  let base = null
  for (const line of lines) {
    if (!line.trim()) {
      cur = null
      continue
    }
    const m = LIST.exec(line)
    if (m && (base == null || m[1].length <= base)) {
      base ??= m[1].length
      cur = { text: m[2].trim() }
      items.push(cur)
      continue
    }
    if (cur) cur.text += (m ? '; ' : ' ') + (m ? m[2] : line).trim()
  }
  return items.map((i) => i.text)
}

const paragraph = (lines) => {
  const out = []
  for (const l of lines) {
    if (!l.trim()) {
      if (out.length) break
      continue
    }
    out.push(l.trim())
  }
  return out.join(' ')
}

/** The words §Contract names that an item touching a row would mention: paths, commands, env vars. */
export function contractTokens(specText) {
  const c = mdSection(specText, 'Contract', { level: 2 })
  const firsts = tableRows(c?.body ?? '')
    .map((r) => /^`([^`]+)`/.exec(r[0] ?? '')?.[1])
    .filter(Boolean)
  const words = firsts.map((s) => s.split(/[<[]/)[0].trim().split(/\s+/))
  const lead = words.length > 1 && words.every((w) => w.length > 1 && w[0] === words[0][0]) ? words[0][0] : null
  const tokens = []
  for (const w of words) {
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(w[0]) && w[1]) tokens.push(w[1].split('/:')[0].replace(/\/\{.*$/, ''))
    else if (lead && w[0] === lead && w[1]) tokens.push(w[1])
    else tokens.push(w[0])
  }
  return [...new Set(tokens.filter(Boolean))]
}

const RISKY = /\b(auth\w*|permission\w*|owner token|token|401|403|login|password|delete\w*|remov\w*|rm|unshare|save\w*|load\w*|persist\w*|stor(?:e|ed|es|age)|STORE_FILE|old file|notification\w*|deep[- ]?link\w*)\b/i

/** An item touching a §Contract row, or an auth / permission / load / save / delete / notification / deep-link path. */
export function isRisk(item, tokens) {
  if (RISKY.test(item)) return true
  const spans = [...item.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  for (const t of tokens) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (t.startsWith('/')) {
      if (new RegExp(`${esc}(?![\\w-])`).test(item)) return true
      continue
    }
    if (spans.some((s) => new RegExp(`(^|[\\s(])${esc}(?![\\w-])`).test(s))) return true
  }
  return false
}

/** The in-scope apps: the manifest's `apps:`, else SPEC §Apps' ✅ rows, else every config app. */
function inScope(f, specText) {
  if (isSet(f.manifest.apps)) return f.manifest.apps.split('+').map((s) => s.trim()).filter(Boolean)
  const rows = tableRows(mdSection(specText, 'Apps', { level: 2 })?.body ?? '').filter((r) => /✅/.test(r[1] ?? ''))
  if (rows.length) return rows.map((r) => r[0].replace(/[`*]/g, '').trim())
  return f.cfg?.appNames ?? []
}

const OPEN = (app) => `<!-- orchestrator: ${app} — how to reach it (URL, command, scratch files), surfaces that cannot work locally; a readiness step that could not run goes first. Kept on a re-run. -->`
const CLOSE = '<!-- /orchestrator -->'

/** What the orchestrator wrote inside each app's block in an existing walk.md. */
function keptBlocks(text) {
  const kept = {}
  for (const m of String(text ?? '').matchAll(/<!-- orchestrator: (\S+) [^\n]*-->\n([\s\S]*?)<!-- \/orchestrator -->/g)) kept[m[1]] = m[2]
  return kept
}

export function render(f, { cross, previous }) {
  const specText = read(f.specPath) ?? ''
  const apps = inScope(f, specText)
  const t = parseTesting(specText, apps)
  const tokens = contractTokens(specText)
  const kept = keptBlocks(previous)
  const landmines = configSection(f.cfg, 'Environment landmines')
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.trim())
  const lines = [
    `# ${f.feature} — walk script`,
    '',
    `<!-- Generated by scripts/walk-script.mjs from SPEC §Testing. Items are the spec's, newest-first; [risk] marks an item touching a §Contract row, an auth or permission path, a load/save/delete path, a notification payload or a deep-link target — what the agent walk under end=risk walks. Only the orchestrator blocks are hand-written; a re-run keeps them. -->`,
  ]
  let total = 0
  let risky = 0
  for (const app of apps) {
    const cfgApp = f.cfg?.apps.find((a) => a.name === app)
    const items = [...(t.apps[app] ?? [])].reverse()
    lines.push('', `## ${app}`, '', `Where: \`${cfgApp?.path ?? app}\` — this checkout${cfgApp?.role ? ` (${cfgApp.role})` : ''}.`, '', OPEN(app))
    const body = kept[app] ?? (items.length ? '' : `SPEC §Testing names nothing to walk in ${app} — say what a person checks here, or that there is nothing.\n`)
    lines.push(body.replace(/\n$/, '') || null, CLOSE)
    if (items.length) {
      lines.push('', 'Newest first:', '')
      items.forEach((item, i) => {
        const r = isRisk(item, tokens)
        risky += r ? 1 : 0
        lines.push(`${i + 1}. ${r ? '[risk] ' : ''}${item}`)
      })
      total += items.length
    }
    const mine = landmines.filter((l) => {
      const named = apps.filter((a) => new RegExp(`\\b${a}\\b`, 'i').test(l) || (f.cfg?.apps.find((x) => x.name === a)?.path && l.includes(f.cfg.apps.find((x) => x.name === a).path)))
      return named.length === 0 || named.includes(app)
    })
    if (mine.length) lines.push('', "Local facts (the config's §Environment landmines):", ...mine)
  }
  if (cross && t.cross.steps.length) {
    lines.push('', '## Cross-app (verify E2E)', '', `From SPEC §Testing — ${t.cross.intro || 'the human-verification script'}:`, '')
    t.cross.steps.forEach((s, i) => lines.push(`E${i + 1}. ${s}`))
  }
  const text = lines.filter((l) => l !== null).join('\n') + '\n'
  return { text, apps, total, risky, steps: cross ? t.cross.steps.length : 0 }
}

async function main(argv) {
  const a = parseArgs(argv, { bool: ['cross-app', 'no-cross-app', 'print'] })
  if (!a._[0]) {
    console.error('usage: walk-script.mjs <folder> [--cross-app | --no-cross-app] [--print]')
    return 2
  }
  const f = openFeature(a._[0])
  if (!f.cfg) throw new Error(f.cfgError)
  if (read(f.specPath) == null) throw new Error(`no SPEC.md in ${f.dir}`)
  const cross = a['no-cross-app'] ? false : a['cross-app'] ? true : /^on\b/.test(f.manifest['agent-walk'] ?? '')
  const path = join(f.ws(), 'walk.md')
  const r = render(f, { cross, previous: read(path) })
  if (read(path) !== r.text) writeAtomic(path, r.text)
  const crossNote = r.steps ? ` + cross-app E1–E${r.steps}` : cross ? ' (SPEC §Testing has no verification script: no cross-app section)' : ''
  console.log(`wrote ${path} — ${r.total} items in ${r.apps.length} app${r.apps.length === 1 ? '' : 's'} (${r.risky} [risk])${crossNote} at ${shortHead(f.root)}`)
  if (a.print) process.stdout.write('\n' + r.text)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(main)
