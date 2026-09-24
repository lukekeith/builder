#!/usr/bin/env node
/**
 * Cross-section obligation checker for a feature's `SPEC.md`.
 *
 * WHY THIS EXISTS. One doc raises an obligation against another and nothing ever checks it. The
 * original case: a surfaces doc correctly identified `N1` — parked drafts — as "the only item that
 * requires NEW persistence", correctly rated it the biggest backend item in the flow, and even
 * wrote down that the backend doc had no `T#` row for it. That finding then sat unacted-on across
 * two full passes, and was caught only because a human asked a direct question. Nothing failed to
 * *notice*. What failed was that no mechanism checked the obligation.
 *
 * Prose rules don't fix that class. A grep does. The obligations asserted here:
 *
 *   1. Every `N#` row in SPEC §Replaced surfaces (capabilities the DESIGN ADDS — the only
 *      design→app direction in the pipeline, and therefore where all new backend work is born)
 *      must reach a disposition: cited by a `T#`/`SC#`/`D#` elsewhere in the spec, or explicitly
 *      marked as needing no persistence.
 *   2. Every `T#` row in §Findings & risks whose text implies DDL or a wire-shape change must have
 *      a matching `SC#` row in §Schema & API changes — the rule /builder:align states, enforced
 *      instead of trusted.
 *   3. Every `SC#` REMOVE row carries a named decider — on the row, or as a decided §Decisions row.
 *   4. The multi-app obligations: every app `.claude/builder.md` declares has a §Apps row, an
 *      in-scope app has its own SPEC section, and every §Contract row names at least one consumer.
 *      An endpoint with no consumer is either dead or a consumer nobody audited.
 *
 *   node <plugin>/scripts/check-obligations.mjs <feature>
 *   node <plugin>/scripts/check-obligations.mjs <registry>/<feature>
 *   node <plugin>/scripts/check-obligations.mjs <feature> --json
 *   node <plugin>/scripts/check-obligations.mjs --all
 *
 * Exit 0 = every obligation discharged (or the spec is too early to have them).
 * Exit 1 = at least one dangling obligation. Exit 2 = bad usage / no such feature.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { requireConfig } from './config.mjs'

const CFG = requireConfig()
const ROOT = CFG.root
const REGISTRY_ROOT = CFG.registry
const hasSpec = (dir) => existsSync(join(dir, 'SPEC.md'))

/** `<feature>` → <registry>/<feature>; anything with a `/` is a folder or SPEC.md path. */
const resolveSuite = (arg) => {
  if (!arg.includes('/')) return join(ROOT, REGISTRY_ROOT, arg)
  const abs = isAbsolute(arg) ? arg : join(ROOT, arg)
  return arg.endsWith('.md') ? dirname(abs) : abs
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const suites = args.includes('--all')
  ? (() => {
      try {
        return readdirSync(join(ROOT, REGISTRY_ROOT))
          .map((d) => join(ROOT, REGISTRY_ROOT, d))
          .filter((d) => statSync(d).isDirectory() && hasSpec(d))
      } catch {
        return []
      }
    })()
  : args.filter((a) => !a.startsWith('--')).map(resolveSuite)

if (!suites.length) {
  console.error('usage: check-flow-obligations.mjs <feature | path/to/folder | path/to/SPEC.md> [--json] | --all')
  process.exit(2)
}

/** Phrases that discharge an N# row without a downstream id — a deliberate "this needs no backend". */
const NO_BACKEND = /no backend implication|client-only by decision|no schema change|no persistence needed/i
/** Words in a T# row that mean the schema or the wire shape moves, so an SC# row is owed. */
const DDL = /\bmodel\b|\bcolumn\b|\bfield\b|\bmigration\b|\bschema\b|\bendpoint\b|\benum\b|\btable\b/i
/** A T# explicitly scoped away from DDL — service-only work owes no SC#. */
const NO_DDL = /prototype-side only|no backend work|read-side projection|no DDL|no wire change|service-only|^\s*service\s*\|/i

/**
 * A table row whose first cell is an `N#` / `T#` id, **bold or not**. No template writes the bold
 * form, so requiring `**T1**` let every row through unchecked and the gate passed on a spec it had
 * never looked at.
 */
const ROW_ID = (letter) => new RegExp(`^\\|\\s*\\*{0,2}\`?(${letter}\\d+)\`?\\*{0,2}\\s*\\|(.*)$`, 'gm')

/**
 * Section slicing. The tail is end-of-INPUT, not `$`: under `m` a `$` matches at the end of every
 * line, so a section whose heading is followed by a blank line captured nothing at all.
 */
const section = (text, re) => re.exec(text)?.[1] ?? ''
const DECISIONS_SECTION = /^##\s+Decisions\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im
const SCHEMA_SECTION = /^##\s+Schema(?:\s*&\s*API)?\s+changes\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im
const SURFACES_SECTION = /^##\s+Replaced surfaces\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im
const FINDINGS_SECTION = /^##\s+Findings(?:\s*&\s*risks)?\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im
const APPS_SECTION = /^##\s+Apps\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im
const CONTRACT_SECTION = /^##\s+Contract\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im

/**
 * The apps the config declares, and the SPEC section each one owes when it is in scope. The
 * heading is matched case-insensitively on the app's own name, so a §Web section satisfies `web`.
 */
const APP_SECTIONS = Object.fromEntries(
  CFG.appNames.map((name) => [name, new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im')])
)

const results = []

for (const dir of suites) {
  const feature = dir.startsWith(ROOT + '/') ? dir.slice(ROOT.length + 1) : dir
  if (!existsSync(dir)) {
    console.error(`✖ no feature folder at ${feature}`)
    process.exit(2)
  }
  const specPath = join(dir, 'SPEC.md')
  if (!existsSync(specPath)) {
    console.error(`✖ no SPEC.md at ${feature} — nothing to check (a legacy folder has not been converted yet)`)
    process.exit(2)
  }
  const spec = readFileSync(specPath, 'utf8')
  const findings = []

  // ── Obligation 1: every N# reaches a disposition ──────────────────────────
  const surfaces = section(spec, SURFACES_SECTION)
  if (surfaces) {
    const nRows = [...surfaces.matchAll(ROW_ID('N'))]
    for (const [, id, rest] of nRows) {
      const referencedBy = [
        ...spec.matchAll(
          new RegExp(`\\b(T\\d+|SC\\d+|D\\d+)\\b[^\\n]{0,400}\\b${id}\\b|\\b${id}\\b[^\\n]{0,400}\\b(T\\d+|SC\\d+|D\\d+)\\b`, 'g')
        ),
      ]
      if (!referencedBy.length && !NO_BACKEND.test(rest)) {
        findings.push({
          severity: 'FAIL',
          rule: 'N-row has no disposition',
          id,
          detail:
            `§Replaced surfaces ${id} is a capability the prototype ADDS, but no T#/SC#/D# anywhere in ` +
            `the spec references it and it is not marked as needing no persistence. This is the exact ` +
            `shape of the N1 miss: a correctly-identified new capability with nothing downstream. Ask ` +
            `where it lives when the app is closed.`,
        })
      }
    }
    if (!nRows.length) {
      findings.push({
        severity: 'WARN',
        rule: 'no N# rows',
        id: '—',
        detail:
          `§Replaced surfaces has no **N#** rows at all. Either the flow genuinely adds nothing the app ` +
          `lacks (record that explicitly), or the prototype→app direction — the only one in the pipeline — ` +
          `was never filled in. Those look identical from here, which is why it warns.`,
      })
    }
  }

  // ── Obligation 2: every DDL-implying T# has an SC# ────────────────────────
  const backend = section(spec, FINDINGS_SECTION)
  const ledger = section(spec, SCHEMA_SECTION)
  if (backend) {
    const tRows = [...backend.matchAll(ROW_ID('T'))]
    if (tRows.length && !ledger) {
      findings.push({
        severity: 'FAIL',
        rule: 'no §Schema & API changes section',
        id: '—',
        detail: `§Findings carries T# rows but the spec has no §Schema & API changes section for their SC# rows.`,
      })
    } else {
      for (const [, id, rest] of tRows) {
        if (!DDL.test(rest) || NO_DDL.test(rest)) continue
        if (!new RegExp(`\\b${id}\\b`).test(ledger)) {
          findings.push({
            severity: 'FAIL',
            rule: 'DDL-implying T# has no SC# row',
            id,
            detail:
              `${id} names model/field/migration/schema/endpoint work but §Schema & API changes ` +
              `never mentions it, so the migration checklist is missing it.`,
          })
        }
      }
    }
  }

  // ── Obligation 3: SC# rows are complete enough to execute ─────────────────
  if (ledger) {
    const scRows = [...ledger.matchAll(/^\|\s*`?(SC\d+)`?\s*\|(.*)$/gm)]
    const decisions = section(spec, DECISIONS_SECTION)
    const DECIDER = /decider|decided|ruled|ruling|\bD\d+\b/i
    const decidedRow = /^\|\s*`?D\d+`?\s*\|(?![^\n]*\bOPEN\b)[^\n]*\|\s*[^|\s][^|\n]*\|\s*$/m
    for (const [, id, rest] of scRows) {
      // REMOVE counts only as the row's change-type cell (a reason saying "REMOVE deferred by D14"
      // is not a removal), and a cited decision id (`D14`) is a named decider.
      const changeType = rest.split('|')[0] ?? ''
      if (/\bREMOVE\b/.test(changeType) && !DECIDER.test(rest) && !decidedRow.test(decisions)) {
        findings.push({
          severity: 'FAIL',
          rule: 'REMOVE with no named decider',
          id,
          detail: `${id} drops a field and no decider is recorded. Same valve §Replaced surfaces applies to DROPPED.`,
        })
      }
    }
    if (!scRows.length && !/no schema change|none required|empty/i.test(ledger)) {
      findings.push({
        severity: 'WARN',
        rule: 'ledger has no rows and no empty-case statement',
        id: '—',
        detail: `"This feature needs no schema change" and "nobody filled it in" must not look alike.`,
      })
    }
  }

  // ── Obligation 4: the multi-app obligations ───────────────────────────────
  const apps = section(spec, APPS_SECTION)
  if (apps) {
    // Parse the §Apps table into rows ONCE. Matching an app name with a loose row regex reads the
    // table HEADER as a row whenever an app is named "app" — the single-app case — and then
    // reports every app as out of scope. A row is a row only when its in-scope cell is ✅ or ⬜.
    const appRows = apps
      .split('\n')
      .filter((l) => /^\s*\|/.test(l))
      .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
      .filter((cells) => cells.length >= 2 && /[✅⬜]/.test(cells[1]))

    for (const [app, re] of Object.entries(APP_SECTIONS)) {
      const cells = appRows.find((c) => c[0].replace(/[`*]/g, '').toLowerCase() === app.toLowerCase())
      if (!cells) {
        findings.push({
          severity: 'FAIL',
          rule: 'app missing from §Apps',
          id: app,
          detail:
            `§Apps has no row for \`${app}\`, which ${CFG.path} declares. Every app gets a row, including ` +
            `the ones it doesn't touch — an omission you can read is a decision; a missing row is an oversight.`,
        })
        continue
      }
      const inScope = /✅/.test(cells[1])
      if (inScope && !re.test(spec)) {
        findings.push({
          severity: 'FAIL',
          rule: 'in-scope app has no SPEC section',
          id: app,
          detail: `§Apps marks \`${app}\` in scope (✅) but the spec has no §${app} section saying what changes there.`,
        })
      }
      // A ⬜ row must EXPLAIN itself. Don't test for particular words — "untouched", "not affected"
      // and "no web-app change" are all fine — test that the cell actually says something.
      const why = (cells[2] ?? '').replace(/[*`_]/g, '').trim()
      if (!inScope && why.length < 15) {
        findings.push({
          severity: 'WARN',
          rule: 'out-of-scope app states no reason',
          id: app,
          detail: `\`${app}\` is out of scope but the row gives no reason. A ⬜ row states why not, in one line.`,
        })
      }
    }
  }
  const contract = section(spec, CONTRACT_SECTION)
  if (contract) {
    // `| GET /api/… | <producer> | <consumer>, <consumer> | … |`
    const rows = [...contract.matchAll(/^\|\s*`?((?:GET|POST|PATCH|PUT|DELETE)\s+[^|`]+)`?\s*\|([^|]*)\|([^|]*)\|/gim)]
    for (const [, endpoint, producer, consumers] of rows) {
      if (!consumers.trim() || /^[\s—–-]*$/.test(consumers)) {
        findings.push({
          severity: 'FAIL',
          rule: 'contract row names no consumer',
          id: endpoint.trim(),
          detail:
            `${endpoint.trim()} is produced by ${producer.trim() || '(unnamed)'} and consumed by nobody the spec names. ` +
            `An endpoint with no consumer is either dead or a consumer nobody audited — the X# class.`,
        })
      }
    }
  }

  results.push({ feature, findings })
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const { feature, findings } of results) {
    const fails = findings.filter((f) => f.severity === 'FAIL')
    const warns = findings.filter((f) => f.severity === 'WARN')
    console.log(`\n── ${feature} ──`)
    if (!findings.length) {
      console.log('  ✓ every cross-section obligation discharged')
      continue
    }
    for (const f of findings) {
      console.log(`  ${f.severity === 'FAIL' ? '✖' : '⚠'} [${f.id}] ${f.rule}`)
      console.log(`      ${f.detail.replace(/\s+/g, ' ')}`)
    }
    console.log(`  ${fails.length} fail · ${warns.length} warn`)
  }
}

process.exit(results.some((r) => r.findings.some((f) => f.severity === 'FAIL')) ? 1 : 0)
