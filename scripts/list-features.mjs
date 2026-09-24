#!/usr/bin/env node
/**
 * Enumerate the feature registry with where each feature stands, so /builder:resume can offer them
 * for selection without loading a single doc. The registry root comes from `.claude/builder.md`.
 *
 * Four layouts:
 *   - MANIFEST.md (the builder pipeline): key/value MANIFEST.md carries state/size/next; a
 *     `tier: program` manifest tracks `child:` lines instead of its own state.
 *   - CONDENSED: a SPEC.md whose header carries `✅ SIGNED OFF` or `✅ SHIPPED` — the manifest is
 *     deleted at ship, so the header is the record.
 *   - LEGACY: a folder carrying BUILD STATE from a pipeline that ran before this one — phase docs
 *     (`NN-phase-*.md`) or a `STATUS.md`. Read-only here: /builder:resume offers ONE action on such
 *     a folder, the conversion in REFERENCE §Condense.
 *   - ANALYSIS: docs that feed a design conversation but were never driven by a pipeline. Nothing
 *     to convert — its next step is /builder:brainstorm.
 *
 * DONE = a SPEC.md header carrying `✅ SHIPPED`, or a README.md header or `**Status:**` line that
 * opens SHIPPED. A DONE feature is never offered as a pipeline target.
 *
 *   node <plugin>/scripts/list-features.mjs               # table
 *   node <plugin>/scripts/list-features.mjs --json        # machine-readable
 *   node <plugin>/scripts/list-features.mjs --check       # resume-safety + size warnings
 *   node <plugin>/scripts/list-features.mjs --all         # include DONE features
 *   node <plugin>/scripts/list-features.mjs --status      # /builder:status — markdown table, most recent first
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireConfig } from './config.mjs'

const CFG = requireConfig()
const ROOT = CFG.root
const REGISTRY = [{ root: CFG.registry, requireManifest: false }]
const ENTRY_CMD = '/builder:resume'
const PLAN_CMD = '/builder:brainstorm'

const SPEC_LINE_BUDGET = 500
const PLAN_LINE_BUDGET = 400
const VALID_SIZES = new Set(['xs', 'sm', 'md', 'lg', 'xl'])
const SIZE_MAP = { xs: 'xs', s: 'sm', m: 'md', l: 'lg', xl: 'xl' }
// Legacy-suite budgets — a doc this size taxes every step that reads it.
const SUITE_DOC_KB_BUDGET = 40
const LEDGER_KB_BUDGET = 60
const PHASE_DOC_LINE_BUDGET = 200

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const doCheck = args.includes('--check')
const asStatus = args.includes('--status')
const includeDone = args.includes('--all') || asJson || doCheck

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const grab = (text, re) => {
  const m = text?.match(re)
  return m ? m[1].trim() : null
}

/** A `**Label:** value` header field, joined across wrapped lines. A condensed header is a
 *  blockquote, so a following `> …` line ends the field too. */
const grabField = (text, label) => {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|\\n#|\\n\\s*\\n|\\n>|$)`)
  const m = text?.match(re)
  return m ? m[1].replace(/\s+/g, ' ').trim() : null
}

/** A suite README status line. Two forms are in the wild — `**Status:** value` and
 *  `**Status: value**` (label and value inside one bold span) — and both are read here. */
const grabStatus = (text) => {
  if (!text) return null
  const m =
    text.match(/\*\*Status:\*\*\s*([^\n]*)/) ?? text.match(/\*\*Status:\s*([^*\n]*)\*\*/)
  if (!m) return null
  return m[1].replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
}

/** Keep a state cell readable — the status line is often a paragraph. */
const clip = (s, n = 58) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/**
 * `key: value` lines; a trailing `# comment` is dropped; `child:` repeats into `children[]`.
 *
 * A `#` starts a comment only when it is set off from the value — two or more spaces before it,
 * or a space after it. A single space plus `#<something>` is a PR reference, not a comment:
 * `pr: #1234` and `hold: "PR #1179 must land first"` both keep their `#`.
 */
const parseManifest = (text) => {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s{2,}#.*$|\s+#\s.*$/, '').trim()
    const m = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, v] = m
    if (k === 'child') (out.children ??= []).push(v)
    else out[k] = v
  }
  return out
}

const inspect = (root, name) => {
  const dir = join(ROOT, root, name)
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile())

  const out = {
    feature: name,
    layout: null, // 'manifest' | 'program' | 'condensed' | 'suite' | 'legacy' | 'note'
    path: `${root}/${name}`,
    done: false,
    next: null,
    blocked: null,
    state: null,
    source: null,
    warnings: [],
    problems: [],
  }

  // ---- MANIFEST.md (the builder pipeline) ----
  const manifestText = read(join(dir, 'MANIFEST.md'))
  const specText = read(join(dir, 'SPEC.md'))
  if (manifestText) {
    const mf = parseManifest(manifestText)
    out.manifest = mf
    out.layout = mf.tier === 'program' ? 'program' : 'manifest'
    out.source = 'MANIFEST.md'
    out.next = mf.next ?? null
    out.pr = mf.pr && mf.pr !== 'none' ? mf.pr : null
    out.blocked = mf.hold && mf.hold !== 'none' ? `🛑 PR HELD — ${mf.hold}` : null
    if (out.layout === 'program') {
      out.children = (mf.children ?? []).map((c) => {
        const [child, state] = c.split(/\s+—\s+/)
        return { name: child.trim(), state: (state ?? '').trim() }
      })
      const shipped = out.children.filter((k) => k.state === 'shipped').length
      out.state = `program — ${shipped}/${out.children.length} children shipped`
    } else {
      const bits = [mf.state ?? 'state?', `size ${mf.size ?? '?'}`]
      const designKey = CFG.design?.flag
      if (designKey && mf[designKey] && mf[designKey] !== 'none') bits.push('prototype')
      if (mf.apps) bits.push(mf.apps)
      if (mf.contract && mf.contract !== 'none') bits.push(`contract ${mf.contract}`)
      if (mf.verify && mf.verify !== 'none') bits.push(`verify ${mf.verify}`)
      if (mf.auto && /^on/i.test(mf.auto)) bits.push('auto')
      if (out.blocked) bits.push('🛑 PR HELD')
      out.state = bits.join(' · ')
      if (!mf.state) out.problems.push('MANIFEST.md has no "state:" line')
      if (mf.size && !VALID_SIZES.has(mf.size)) {
        const twoLetter = SIZE_MAP[mf.size.toLowerCase()]
        out.problems.push(
          twoLetter
            ? `size: ${mf.size} — use the two-letter form (${twoLetter})`
            : `size: ${mf.size} — use one of xs sm md lg xl`
        )
      }
    }
    if (!mf.next) out.problems.push('MANIFEST.md has no "next:" line — a cold session cannot resume it')
    if (specText && specText.split('\n').length > SPEC_LINE_BUDGET)
      out.warnings.push(
        `SPEC.md is ${specText.split('\n').length} lines (budget ${SPEC_LINE_BUDGET}) — it may be two features`
      )
    const planText = read(join(dir, 'PLAN.md'))
    if (planText && planText.split('\n').length > PLAN_LINE_BUDGET && out.layout !== 'program')
      out.warnings.push(`PLAN.md is ${planText.split('\n').length} lines — long, but it carries code; not a blocker`)
    return out
  }

  // ---- No manifest: a condensed SPEC header is the record ----
  if (specText && /✅\s*\*{0,2}SHIPPED/.test(specText.slice(0, 800))) {
    out.done = true
    out.layout = 'condensed'
    out.state = 'DONE'
    out.source = 'SPEC.md header'
    out.pr = grab(specText.slice(0, 800), /PR\s*(#\d+)/)
    out.shipped = grab(specText.slice(0, 800), /SHIPPED\s+([\d-]+)/)
    out.next = 'nothing — shipped'
    return out
  }
  if (specText && /✅\s*\*{0,2}SIGNED OFF/.test(specText.slice(0, 800))) {
    out.layout = 'condensed'
    out.source = 'SPEC.md header (condensed at sign-off)'
    const header = specText.slice(0, 1200)
    out.pr = grab(header, /PR\s*(#\d+)/)
    const held = /PR HELD/.test(header)
    out.state = `signed off — condensed${held ? ', 🛑 PR HELD' : ''}${out.pr ? `, ${out.pr}` : ''}`
    out.next = `/builder:verify --path ${out.path}`
    return out
  }

  // ---- A SPEC.md with no manifest and no condensed header is INCOMPLETE, not analysis ----
  // Every builder feature carries both files; the sign-off and ship condense remove the manifest
  // only AFTER writing the header that replaces it. So this shape means a half-written feature or
  // a half-finished conversion, and saying "analysis" about it would hide that.
  if (specText) {
    out.layout = 'manifest'
    out.source = 'SPEC.md (no MANIFEST.md)'
    out.state = 'spec without a manifest — incomplete'
    out.next = `${ENTRY_CMD} --path ${out.path}   (writes the missing MANIFEST.md)`
    out.problems.push('SPEC.md has no MANIFEST.md beside it — a cold session cannot resume it')
    return out
  }

  const readmeText = files.some((f) => /^README\.md$/i.test(f)) ? read(join(dir, 'README.md')) : null
  if (readmeText && /✅\s*\*\*SHIPPED/.test(readmeText.slice(0, 800))) {
    out.done = true
    out.layout = 'legacy'
    out.state = 'DONE'
    out.source = 'README.md header'
    out.pr = grab(readmeText.slice(0, 800), /PR\s*(#\d+)/)
    out.next = 'nothing — shipped'
    return out
  }

  // ---- A legacy folder from a pipeline that ran before this one ----
  //
  // 🔴 Numbered docs alone do NOT make a folder a suite awaiting conversion. The discriminator is
  // BUILD STATE: phase docs, or a STATUS.md ledger. A folder of numbered ANALYSIS docs with
  // neither — the studies that feed a future design conversation — was never driven by a pipeline
  // and has nothing to convert: its next step is the design conversation itself.
  const suiteDocs = files.filter((f) => /^\d\d-/.test(f)).sort()
  const phaseDocs = files.filter((f) => /^\d\d-phase-/.test(f)).sort()
  const drivenByPipeline = phaseDocs.length > 0 || existsSync(join(dir, 'STATUS.md'))
  if (suiteDocs.length >= 2 && drivenByPipeline) {
    out.layout = 'suite'
    out.source = 'legacy layout (pre-builder)'
    for (const f of [...suiteDocs, ...phaseDocs]) {
      const body = read(join(dir, f))
      if (body == null) continue
      const kb = Math.round(Buffer.byteLength(body) / 1024)
      if (/^\d\d-gaps|^\d\d-decisions/.test(f) && kb > LEDGER_KB_BUDGET) out.warnings.push(`${f} is ${kb}KB (budget ${LEDGER_KB_BUDGET}KB)`)
      else if (/^\d\d-/.test(f) && !/^\d\d-phase-/.test(f) && kb > SUITE_DOC_KB_BUDGET)
        out.warnings.push(`${f} is ${kb}KB (budget ${SUITE_DOC_KB_BUDGET}KB)`)
      else if (/^\d\d-phase-/.test(f) && body.split('\n').length > PHASE_DOC_LINE_BUDGET)
        out.warnings.push(`${f} is over the ${PHASE_DOC_LINE_BUDGET}-line phase budget`)
    }
    const status = grabStatus(readmeText)
    // A suite whose status line OPENS with SHIPPED is done. "Shipped-ready" is not shipped.
    if (status && /^SHIPPED\b/i.test(status) && !/^shipped-ready/i.test(status)) {
      out.done = true
      out.state = 'DONE'
      out.source = 'README **Status:** line'
      out.pr = grab(readmeText.slice(0, 1200), /PR\s*(#\d+)/)
      out.next = 'nothing — shipped'
      return out
    }
    if (phaseDocs.length) {
      const unsigned = phaseDocs.filter((f) => !/##\s*VERIFIED[\s\S]*?✅/.test(read(join(dir, f)) ?? ''))
      out.state = `suite — ${phaseDocs.length - unsigned.length}/${phaseDocs.length} phases VERIFIED${
        status ? ` · ${clip(status, 34)}` : ''
      }`
    } else {
      out.state = `suite — ${suiteDocs.length} docs, unplanned${status ? ` · ${clip(status, 34)}` : ''}`
    }
    // The ONE action on a numbered suite is the conversion; everything else refuses to run on it.
    out.next = `${ENTRY_CMD} --path ${out.path}   (converts it to SPEC.md + MANIFEST.md)`
    out.convert = true
    return out
  }

  // ---- Unnumbered legacy driven by a prior pipeline (a STATUS.md ledger) ----
  const statusText = read(join(dir, 'STATUS.md'))
  if (statusText) {
    out.layout = 'suite'
    out.source = 'STATUS.md'
    out.next = `${ENTRY_CMD} --path ${out.path}   (converts it to SPEC.md + MANIFEST.md)`
    out.state = `legacy (STATUS.md)${grabStatus(readmeText) ? ` · ${clip(grabStatus(readmeText), 34)}` : ''}`
    out.convert = true
    return out
  }

  // ---- Analysis input: docs that feed a design conversation, never pipeline-driven ----
  if (files.some((f) => /\.md$/.test(f) && !/^README\.md$/i.test(f))) {
    out.layout = 'analysis'
    out.source = 'inferred from artifacts'
    const n = files.filter((f) => /\.md$/.test(f)).length
    out.state = `analysis (${n} doc${n === 1 ? '' : 's'}) — no design conversation yet${
      grabStatus(readmeText) ? ` · ${clip(grabStatus(readmeText), 30)}` : ''
    }`
    out.next = `${PLAN_CMD} --path ${out.path} <what you want built>`
    out.convert = false
    return out
  }

  // ---- Just notes ----
  out.layout = 'note'
  out.state = readmeText ? 'no spec (README only)' : 'empty folder'
  out.next = `${PLAN_CMD} --path ${out.path}`
  out.source = 'inferred'
  return out
}

let rows = []
for (const { root, requireManifest } of REGISTRY) {
  let names = []
  try {
    names = readdirSync(join(ROOT, root))
      .filter((f) => statSync(join(ROOT, root, f)).isDirectory())
      .sort()
  } catch {
    continue
  }
  for (const name of names) {
    if (requireManifest && !existsSync(join(ROOT, root, name, 'MANIFEST.md'))) continue
    rows.push(inspect(root, name))
  }
}
/** A git query that answers null instead of throwing — outside a repo, or on a path git never saw. */
const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** What the feature IS, in one line: the Overview's first sentence, else the SPEC/PROGRAM title. */
const describe = (r) => {
  const dir = join(ROOT, r.path)
  const text = read(join(dir, 'SPEC.md')) ?? read(join(dir, 'PROGRAM.md')) ?? read(join(dir, 'README.md'))
  if (!text) return null
  const overview = /^##\s+Overview\s*\n+([\s\S]*?)(?=\n##\s|$)/m.exec(text)
  const para = overview?.[1]
    .split('\n')
    .filter((l) => l.trim() && !/^\s*(<!--|>|\||```)/.test(l))
    .join(' ')
  const sentence = para?.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? para
  if (sentence) return sentence.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim()
  const title = grab(text, /^#\s+(.+)$/m)
  return title ? title.replace(/\s+—\s+(spec|program)\s*$/i, '').trim() : null
}

/**
 * The status view of one row: the step last completed, the step to do next, and the command that
 * picks it up. Read from the manifest's `state:` — the pipeline writes it at every transition — so
 * this never has to open the SPEC to say where a feature stands.
 */
const statusOf = (r) => {
  const resume = `/builder:resume --path ${r.path}`
  const mf = r.manifest ?? {}
  if (r.layout === 'program') {
    const kids = r.children ?? []
    const shipped = kids.filter((k) => k.state === 'shipped').length
    const open = kids.find((k) => k.state !== 'shipped')
    return {
      lastDone: `${shipped}/${kids.length} children shipped`,
      nextStep: open ? `Continue child ${open.name} (${open.state || 'not started'})` : 'Ship the program',
      command: resume,
    }
  }
  if (r.convert) return { lastDone: 'Folder from an earlier pipeline', nextStep: 'Convert to SPEC.md + MANIFEST.md', command: resume }
  if (r.layout === 'analysis' || r.layout === 'note')
    return { lastDone: 'Notes only — no design yet', nextStep: 'Brainstorm the design', command: `/builder:brainstorm --path ${r.path} <what you want built>` }
  if (r.source === 'SPEC.md (no MANIFEST.md)')
    return { lastDone: 'Spec written, manifest missing', nextStep: 'Write the missing MANIFEST.md', command: resume }
  if (r.done) return { lastDone: 'Shipped', nextStep: '—', command: '—' }

  const state = r.layout === 'condensed' ? 'signed-off' : mf.state
  const verify = mf.verify ?? 'none'
  const noGoAhead = !mf['go-ahead'] || mf['go-ahead'] === 'none'
  const table = {
    spec: ['Spec written', CFG.design?.flag && mf[CFG.design.flag] && mf[CFG.design.flag] !== 'none' ? 'Align the design' : 'Audit the spec against the code'],
    aligned: ['Design aligned', 'Audit the spec against the code'],
    audited: ['Audit done', 'Settle open decisions, then plan'],
    planned: ['Plan written', noGoAhead ? 'Approve the plan, then build' : 'Build'],
    building: ['Build in progress', 'Continue the build'],
    built: ['Build finished', '🔒 Walk it yourself, then /builder:signoff'],
    'signed-off': ['Signed off', 'Deep verify'],
    verified: [`Verified — ${verify.split(' ')[0]}`, /^INCOMPLETE/.test(verify) ? 'Work the ## Fixes list' : 'Open the PR, then ship'],
    shipped: ['Shipped', '—'],
  }
  const [lastDone, nextStep] = table[state] ?? [state ?? 'unknown', 'Resume to see']
  const held = mf.hold && mf.hold !== 'none' ? mf.hold.replace(/^"|"$/g, '') : null
  return {
    lastDone: lastDone + (r.pr ? ` (PR ${r.pr})` : ''),
    nextStep: held ? `🛑 PR held — ${held}` : nextStep,
    command: resume,
  }
}

for (const r of rows) {
  r.description = describe(r)
  // The last commit touching the folder is when the pipeline last moved it; mtime is the fallback
  // for a folder that has never been committed.
  const iso = git('log', '-1', '--format=%cI', '--', r.path)
  r.updatedAt = iso ?? statSync(join(ROOT, r.path)).mtime.toISOString()
  r.updated = iso ? git('log', '-1', '--format=%cr', '--', r.path) : 'uncommitted'
  r.branch = r.manifest?.branch ?? null
  Object.assign(r, statusOf(r))
}

if (!rows.length) {
  console.error(`Nothing under ${CFG.registry} — start one with ${PLAN_CMD} --size md <what you want>.`)
  process.exit(asJson || asStatus ? 0 : 1)
}

if (asStatus) {
  const open = rows.filter((r) => !r.done).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const doneCount = rows.length - open.length
  if (!open.length) {
    console.log(`Nothing in progress in ${CFG.project}${doneCount ? ` — ${doneCount} shipped` : ''}. Start one with ${PLAN_CMD} <what you want>.`)
    process.exit(0)
  }
  // A pipe inside a cell would split it into two columns.
  const cell = (s, n) => clip(String(s ?? '—'), n).replace(/\|/g, '\\|')
  console.log(`**${CFG.project}** — ${open.length} in progress, most recent first\n`)
  console.log('| # | Feature | What it is | Last done | Next step | Updated | Pick it up |')
  console.log('|---|---|---|---|---|---|---|')
  open.forEach((r, i) =>
    console.log(
      `| ${i + 1} | **${cell(r.feature, 40)}** | ${cell(r.description, 60)} | ${cell(r.lastDone, 40)} | ${cell(r.nextStep, 50)} | ${cell(r.updated, 20)} | \`${r.command}\` |`
    )
  )
  // The pipeline commits on the feature's branch, so resuming from another one is the usual trap.
  const here = git('branch', '--show-current')
  const elsewhere = open.filter((r) => r.branch && here && r.branch !== here)
  if (elsewhere.length) {
    console.log(`\nOn \`${here}\` now. Check out the feature's branch before resuming:`)
    for (const r of elsewhere) console.log(`- **${r.feature}** → \`git switch ${r.branch}\``)
  }
  const flagged = open.filter((r) => r.problems.length)
  if (flagged.length) {
    console.log('\nNeeds attention:')
    for (const r of flagged) console.log(`- **${r.feature}**: ${r.problems.join('; ')}`)
  }
  if (doneCount) console.log(`\n🔒 ${doneCount} shipped, not shown.`)
  process.exit(0)
}

if (asJson) {
  console.log(JSON.stringify({ features: rows }, null, 2))
  process.exit(0)
}

if (doCheck) {
  const problems = rows.flatMap((r) => r.problems.map((p) => `${r.feature}: ${p}`))
  const warnings = rows.flatMap((r) => r.warnings.map((w) => `${r.feature}: ${w}`))
  for (const w of warnings) console.error(`  ⚠ ${w}`)
  if (problems.length) {
    console.error(`✗ builder check\n`)
    for (const p of problems) console.error(`  • ${p}`)
    process.exit(1)
  }
  console.log(`✓ builder check — ${rows.length} feature(s), all resumable`)
  process.exit(0)
}

const shown = rows.filter((r) => includeDone || !r.done)
const doneRows = rows.filter((r) => r.done)

if (!shown.length && !doneRows.length) {
  console.log(`No features yet. Start one with ${PLAN_CMD} --size md <what you want>.`)
  process.exit(0)
}

const pad = (s, n) => String(s ?? '').padEnd(n)
const w = {
  f: Math.max(8, ...shown.map((r) => r.feature.length)),
  s: Math.max(6, ...shown.map((r) => (r.state ?? '').length)),
}

if (shown.length) {
  console.log(`${pad('FEATURE', w.f)}  ${pad('STATE', w.s)}  NEXT`)
  console.log(`${'-'.repeat(w.f)}  ${'-'.repeat(w.s)}  ----`)
  for (const r of shown) console.log(`${pad(r.feature, w.f)}  ${pad(r.state, w.s)}  ${r.next ?? '—'}`)
}

for (const r of shown) {
  const notes = [...r.problems.map((p) => `• ${p}`), ...r.warnings.map((x) => `⚠ ${x}`)]
  if (r.blocked && !/^nothing$/i.test(r.blocked)) notes.push(`🔴 blocked on: ${r.blocked}`)
  if (notes.length) console.log(`\n${r.feature}:\n  ${notes.join('\n  ')}`)
}

if (doneRows.length && !includeDone) {
  console.log(`\n🔒 ${doneRows.length} shipped: ` + doneRows.map((r) => `${r.feature}${r.pr ? ` (PR ${r.pr})` : ''}`).join(', '))
}
