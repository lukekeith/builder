#!/usr/bin/env node
/**
 * A 5.x config's `## Quality gates` blocks → a 6.0 `verify:` block (spec §Config), for
 * $builder init --update to show the human. It infers each line's runner from its command; what it
 * can't infer it says in `notes`. It reads the config Codex selected — the first of CONFIG_PATHS
 * (`.codex/builder.md` → `.builder/config.md` → `.claude/builder.md`) that exists.
 *
 *   node codex/scripts/verify/migrate.mjs [<root>]            the block and its notes
 *   node codex/scripts/verify/migrate.mjs [<root>] --review   the plain-language review (exit 3: nothing to carry over)
 *   node codex/scripts/verify/migrate.mjs [<root>] --write [--block FILE]
 *
 * Codex: `--write` is run only after the human approved the review, in the feature worktree: it
 * writes the block (or the edited one in FILE, checked first) at the end of the frontmatter and
 * removes `## Quality gates` and `flaky:` — the same result Claude's init --update writes, so one
 * migration serves both editions of a shared `.claude/builder.md`.
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, CONFIG_PATH } from '../config.mjs'
import { parseBlock, normalizeVerify, verifyLines } from './config.mjs'

const COMMENT = /\s{2,}#(.*)$|\s+#\s(.*)$/

/**
 * A value for a flow map. scripts/verify/config.mjs reads a quoted string up to the next matching
 * quote with no escapes, and refuses a bare value holding , : { } [ ] — so a value is bare only when
 * it is plainly safe, else quoted with whichever quote it doesn't contain. null: it holds both.
 */
const yq = (s) => {
  if (/^[\w./*@=-]+$/.test(s)) return s
  if (!s.includes('"')) return `"${s}"`
  if (!s.includes("'")) return `'${s}'`
  return null
}

function blocks(body) {
  const out = []
  let app = null
  let inFence = false
  for (const line of body.split('\n')) {
    const h = /^###\s+(.+?)\s+—\s+fast\s*$/.exec(line)
    if (h) app = h[1]
    else if (/^###\s+Deep set/.test(line)) app = 'deep'
    else if (/^##\s/.test(line) && !/^##\s+Quality gates/.test(line)) app = null
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence && app && line.trim() && !/^\s*#/.test(line)) {
      const m = COMMENT.exec(line)
      out.push({ app, cmd: (m ? line.slice(0, m.index) : line).trim(), note: (m ? (m[1] ?? m[2] ?? '') : '').trim() })
    }
  }
  return out
}

export function migrateGates(body, apps = []) {
  const suites = []
  const checks = []
  const notes = []
  const used = new Set()
  const name = (base) => {
    let n = base
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`
    used.add(n)
    return n
  }
  for (const { app, cmd: raw, note } of blocks(body)) {
    const deep = app === 'deep'
    const cd = /^cd\s+(\S+)\s*&&\s*(.*)$/.exec(raw)
    const cwd = cd ? cd[1].replace(/\/+$/, '') : '.'
    const cmd = cd ? cd[2] : raw
    // `files` is relative to the suite's cwd (adapters run the command there), but a @scoped glob was
    // written from the repo root — so after `cd client`, `client/src/**` becomes `src/**`.
    let scope = /@scoped\s+(\S+)/.exec(note)?.[1] ?? null
    if (scope && cwd !== '.' && scope.startsWith(`${cwd}/`)) scope = scope.slice(cwd.length + 1)
    const tiers = deep ? '[merge]' : /@typecheck/.test(note) ? '[commit, phase, merge]' : null
    const extra = [cwd !== '.' && `cwd: ${yq(cwd) ?? JSON.stringify(cwd)}`, !deep && app && apps.includes(app) && `app: ${app}`, tiers && `tiers: ${tiers}`].filter(Boolean)
    const tail = extra.length ? `, ${extra.join(', ')}` : ''
    const files = scope ? `, files: ${yq(scope)}` : ''
    if (/@known-red/.test(note)) notes.push(`${app}: "${cmd}" was @known-red — known failures are learned now (the target's failing test IDs), not declared; it is migrated as an ordinary line`)
    if (/@walk/.test(note)) notes.push(`${app}: "${cmd}" was @walk — if it needs the running dev env, add needs: [walk-env] to it`)
    let m
    if ((m = /^node\s+--test\s+(.*?)\s*(["']?[^\s"']*\.(?:test|spec)[^\s"']*["']?|["'][^"']+["'])\s*$/.exec(cmd))) {
      const glob = m[2].replace(/^["']|["']$/g, '')
      suites.push(`    ${name(`${app}-test`)}: { runner: node-test, files: ${yq(glob)}${m[1] ? `, args: ${yq(m[1])}` : ''}${tail} }`)
    } else if (/\bvitest\b/.test(cmd)) suites.push(`    ${name(`${app}-vitest`)}: { runner: vitest${files}${tail} }`)
    else if (/\bjest\b/.test(cmd)) suites.push(`    ${name(`${app}-jest`)}: { runner: jest${files}${tail} }`)
    else if (/\bphpunit\b/.test(cmd)) suites.push(`    ${name(`${app}-phpunit`)}: { runner: phpunit${tail} }`)
    else if (/\bplaywright\s+test\b/.test(cmd)) suites.push(`    ${name(`${app}-playwright`)}: { runner: playwright${files}${tail} }`)
    else if (/\bxcodebuild\b.*\btest\b|--\s*--test\b/.test(cmd)) {
      const n = name(`${app}-xctest`)
      suites.push(`    ${n}: { runner: junit, command: ${yq(cmd) ?? '"FILL-ME"'}, report: "FILL-ME.xml"${tail} }`)
      notes.push(`${n}: an iOS suite — change it to { runner: xcodebuild, scheme: <scheme>, target: <test target> } (and needs: [simulator] with verify.simulator) so tests are tracked one by one`)
    } else {
      const n = name(`${app}-${(/(?:npm run|npx|node)\s+([\w:.-]+)/.exec(cmd)?.[1] ?? cmd.split(/\s+/)[0]).replace(/[^\w-]/g, '-')}`)
      const counted = /@delta/.test(note)
      const run = counted ? cmd.replace(/\s*\|\s*(grep -c|awk|wc -l).*$/, '') : cmd
      const q = yq(run)
      if (q === null) notes.push(`${n}: its command holds both quote kinds, which a verify: value can't — move it into a script and set run: to that`)
      checks.push(`    ${n}: { run: ${q ?? '"FILL-ME"'}${counted ? ', compare: lines' : ''}${tail} }`)
      if (counted) notes.push(`${n}: was a @delta count — compare: lines now fails only on a finding the target doesn't print; make the command print findings, one per line (add match: "<regex>" to ignore timing lines)`)
    }
  }
  const yaml = ['verify:', '  workers: 2', ...(suites.length ? ['  suites:', ...suites] : []), ...(checks.length ? ['  checks:', ...checks] : [])].join('\n')
  return { yaml, notes }
}

// ─── Codex: the review $builder init --update shows, and the write it makes on approval ───

const lf = (text) => String(text ?? '').replace(/\r\n?/g, '\n')
const frontmatter = (text) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? null
const bodyOf = (text) => text.slice(text.indexOf('\n---', 3) + 4)
const appsOf = (text) => [...(frontmatter(text) ?? '').matchAll(/^\s*-\s*name:\s*(\S+)/gm)].map((m) => m[1])
/** The top-level `flaky:` block's entries (`  - match: …` lines), or null when it has none. */
const flakyCount = (fm) => {
  const lines = fm.split('\n')
  const at = lines.findIndex((l) => /^flaky:/.test(l))
  if (at < 0) return null
  let n = 0
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !/^\s/.test(l)) break
    if (/^\s*-\s/.test(l)) n++
  }
  return n
}
const MARKERS = {
  '@known-red': 'known failures are learned from the target (its failing tests), not declared',
  '@delta': 'a count that must not grow is now compare: lines — fails only on a finding the target doesn\'t print',
  '@scoped': 'the verifier picks the tests each commit reaches on its own; the glob became files:',
  '@typecheck': 'a type-check runs on every commit (tiers: [commit, phase, merge])',
  '@walk': 'a suite that needs the running app says needs: [walk-env]',
}
const WHEN = (tiers) => {
  const t = [...tiers].sort().join(',')
  if (t === 'commit,merge,phase') return 'every commit, each phase close and the merged result'
  if (t === 'merge') return 'only the merged result, before it lands'
  if (t === 'merge,phase') return 'each phase close and the merged result'
  return tiers.join(', ')
}
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** The review text for one block — plain words over each suite and check, then the block itself. */
function describe(yaml) {
  let v
  try {
    v = normalizeVerify(parseBlock(yaml.split('\n').slice(1)))
  } catch (e) {
    return [`The block does not parse yet (${e.message}) — fix it before approving.`, '']
  }
  const where = (x) => [x.cwd !== '.' && `in ${x.cwd}`, x.app && `(app ${x.app})`].filter(Boolean).join(' ')
  const suites = v.suites.map((s) => `  - ${s.name}: ${s.runner}${s.files ? `, ${s.files}` : ''}${where(s) ? ` ${where(s)}` : ''} — ${WHEN(s.tiers)}`)
  const checks = v.checks.map((c) => `  - ${c.name}: \`${c.run}\`${where(c) ? ` ${where(c)}` : ''}${c.compare === 'lines' ? ' — fails only on a finding the target doesn\'t print' : ''} — ${WHEN(c.tiers)}`)
  return [
    ...(suites.length ? ['Test suites — tracked test by test', ...suites, ''] : []),
    ...(checks.length ? ['Checks — a command that passes or fails', ...checks, ''] : []),
  ]
}

/**
 * The plain-language review of migrating `text` (a whole config file at `path`): what changes, each
 * suite and check and when it runs, what is removed, what the human should check, and the block as
 * it will be written. `{ ok, review, yaml, notes }`; `already` when it has a verify: block; ok false
 * when there is nothing to carry over (init then writes suites from the repo).
 */
export function migrationReview(text, { path = CONFIG_PATH } = {}) {
  const t = lf(text)
  const fm = frontmatter(t) ?? ''
  if (verifyLines(t)) return { ok: true, already: true, review: `${path} already has a verify: block — nothing to migrate.` }
  const body = bodyOf(t)
  const lines = blocks(body)
  if (!lines.length) return { ok: false, review: `${path} has no gate commands to carry over — write the verify: block from the repo's test runners, as $builder init does, and show that instead.` }
  const { yaml, notes } = migrateGates(body, appsOf(t))
  const groups = [...new Set(lines.map((l) => (l.app === 'deep' ? 'the deep set' : l.app)))]
  const gates = /^##\s+Quality gates\b[\s\S]*?(?=^##\s(?!#)|(?![\s\S]))/m.exec(body)?.[0] ?? ''
  const markers = Object.keys(MARKERS).filter((m) => gates.includes(m))
  const flaky = flakyCount(fm)
  const out = [
    `Moving the test setup in ${path} to the verifier`,
    '',
    'What changes',
    `  Before: ## Quality gates — ${lines.length} command line${lines.length === 1 ? '' : 's'} (${andList(groups)}), each run whole at a phase close or at verify`,
    '  After:  a verify: block. Each commit\'s affected tests run in the background while the build goes on, a phase close waits only for its own, and every suite and check runs on the feature merged onto its target before it lands. A test that also fails on the target is known debt and never blocks a feature.',
    '',
    ...describe(yaml),
    'Removed',
    '  - the ## Quality gates section',
    ...(flaky != null ? [`  - flaky: (${flaky} entr${flaky === 1 ? 'y' : 'ies'}) — the verifier spots a flaky test itself: one that fails, then passes on the same commit`] : []),
    ...markers.map((m) => `  - ${m} — ${MARKERS[m]}`),
    '',
    ...(notes.length ? ['Check before approving', ...notes.map((n) => `  - ${n}`), ''] : []),
    ...(path === '.claude/builder.md' ? ['This file is shared with Claude Code\'s builder — both read the same verify: block after this, so the one migration serves both.', ''] : []),
    'The block as it will be written',
    ...yaml.split('\n').map((l) => `  ${l}`),
  ]
  return { ok: true, review: out.join('\n'), yaml, notes }
}

/**
 * `text` with `yaml` (a `verify:` block) written at the end of its frontmatter, and the 5.x test
 * config — the `## Quality gates` section and the frontmatter's `flaky:` list — removed. Everything
 * else is left byte for byte; a CRLF file stays CRLF. Throws when it already has a verify: block.
 */
export function applyMigration(text, yaml) {
  const crlf = /\r\n/.test(text)
  const t = lf(text)
  if (verifyLines(t)) throw new Error('the config already has a verify: block — nothing to migrate')
  const m = /^---\n([\s\S]*?)\n---/.exec(t)
  if (!m) throw new Error('the config has no --- frontmatter block')
  const fmLines = m[1].split('\n')
  const at = fmLines.findIndex((l) => /^flaky:/.test(l))
  if (at >= 0) {
    let end = at + 1
    while (end < fmLines.length && (!fmLines[end].trim() || /^\s/.test(fmLines[end]))) end++
    fmLines.splice(at, end - at)
  }
  const fm = [...fmLines, ...lf(yaml).trimEnd().split('\n')].join('\n')
  const rest = t.slice(m[0].length).replace(/^##\s+Quality gates\b[\s\S]*?(?=^##\s(?!#)|(?![\s\S]))/m, '')
  const out = `---\n${fm}\n---${rest}`
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  const args = process.argv.slice(2)
  const flag = (f) => args.includes(f)
  const blockAt = args.indexOf('--block')
  const blockFile = blockAt >= 0 ? args[blockAt + 1] : null
  const root = args.find((a, i) => !a.startsWith('--') && !(blockAt >= 0 && i === blockAt + 1)) ?? process.cwd()
  const rel = configPath(root)
  if (!rel) {
    console.error(`no ${CONFIG_PATH} — run $builder init`)
    process.exit(2)
  }
  const file = join(root, rel)
  const text = readFileSync(file, 'utf8')
  if (flag('--review')) {
    const r = migrationReview(text, { path: rel })
    console.log(r.review)
    process.exit(r.ok ? 0 : 3)
  } else if (flag('--write')) {
    // Written only after the human approved the review — in the feature worktree, as every config edit.
    const r = migrationReview(text, { path: rel })
    if (r.already) {
      console.log(r.review)
      process.exit(0)
    }
    const yaml = blockFile ? readFileSync(blockFile, 'utf8') : r.yaml
    if (!yaml) {
      console.error(r.review)
      process.exit(3)
    }
    try {
      const lines = verifyLines(`---\n${lf(yaml).trimEnd()}\n---\n`)
      if (!lines) throw new Error('the block does not start with verify:')
      normalizeVerify(parseBlock(lines))
    } catch (e) {
      console.error(`not written — ${e.message}`)
      process.exit(1)
    }
    writeFileSync(file, applyMigration(text, yaml))
    console.log(`wrote verify: to ${rel} — removed ## Quality gates and flaky:`)
  } else {
    const t = lf(text)
    const { yaml, notes } = migrateGates(bodyOf(t), appsOf(t))
    console.log(yaml)
    if (notes.length) console.log(`\n# notes\n${notes.map((n) => `# - ${n}`).join('\n')}`)
  }
}
