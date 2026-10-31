#!/usr/bin/env node
/**
 * A 5.x config's `## Quality gates` blocks → a 6.0 `verify:` block (spec §Config), for
 * /builder:init --update to show the human. It infers each line's runner from its command; what it
 * can't infer it says in `notes`. It prints; it never writes the config.
 *
 *   node scripts/verify/migrate.mjs [<repo root>]
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  const root = process.argv[2] ?? process.cwd()
  const text = readFileSync(join(root, '.claude', 'builder.md'), 'utf8')
  const apps = [...text.matchAll(/^\s*-\s*name:\s*(\S+)/gm)].map((m) => m[1])
  const { yaml, notes } = migrateGates(text.slice(text.indexOf('\n---', 3) + 4), apps)
  console.log(yaml)
  if (notes.length) console.log(`\n# notes\n${notes.map((n) => `# - ${n}`).join('\n')}`)
}
