#!/usr/bin/env node
/**
 * vendor — install (or update) this plugin INTO a host repo, so the host carries its own copy and
 * names nothing of where it came from: no marketplace, repo, homepage or path of the source.
 *
 *   node <plugin>/scripts/vendor.mjs [<host repo>] [--dry-run] [--check] [--forbid <text>]…
 *
 * What it does, and does again on every update:
 *   1. Finds where builder lives in the host: the host's own `.claude-plugin/marketplace.json`
 *      entry named `builder` (its `source` path), else `plugins/builder` in a marketplace named
 *      after the host directory, created if missing.
 *   2. Builds the copy: `skills/` (not `update`), `scripts/` (not its tests), `PROJECT.template.md`, the licences,
 *      and `.claude-plugin/plugin.json` cut to name, description and version, its author the host
 *      marketplace's owner. Nothing else — no
 *      README, changelog, release notes, docs, marketplace file or git metadata.
 *   3. Scans that copy for the source's identifiers (its marketplace name, homepage and author URLs,
 *      their owner/repo, its git remote, its path on disk, and any --forbid) and ABORTS, writing
 *      nothing, if one appears.
 *   4. Replaces the host's copy wholesale — a file a newer version dropped is deleted.
 *   5. Enables `builder@<host marketplace>` in `.claude/settings.json` and removes any entry there
 *      that names the source. When `.claude/settings.local.json` is git-ignored, it switches the
 *      source's own install off there, so this repo answers /builder:* from its copy alone.
 *   6. Scans everything it wrote again.
 *
 * --dry-run prints the plan and writes nothing. --check scans an existing copy (and the host's
 * settings and marketplace) and exits 1 on a leak. The host's project facts live in its
 * `.claude/builder.md`, which this never touches.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, chmodSync } from 'node:fs'
import { join, dirname, resolve, relative, basename, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const USAGE = 'usage: vendor.mjs [<host repo>] [--dry-run] [--check] [--forbid <text>]…'
const argv = process.argv.slice(2)
const forbidExtra = []
const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--forbid') forbidExtra.push(argv[++i] ?? '')
  else if (argv[i] === '--dry-run' || argv[i] === '--check') continue
  else if (argv[i].startsWith('--')) fail(`unknown flag ${argv[i]}. ${USAGE}`, 2)
  else pos.push(argv[i])
}
const DRY = argv.includes('--dry-run')
const CHECK = argv.includes('--check')

function fail(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// ---- the source ----------------------------------------------------------------------------
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcPlugin = readJson(join(SRC, '.claude-plugin/plugin.json')) ?? fail(`no .claude-plugin/plugin.json in ${SRC}`)
const srcMarket = readJson(join(SRC, '.claude-plugin/marketplace.json'))
const PLUGIN = srcPlugin.name

/** Everything that would say where this copy came from. Short or generic strings never qualify. */
function identifiers() {
  const urls = [srcPlugin.homepage, srcPlugin.author?.url, srcPlugin.repository?.url ?? srcPlugin.repository, git(['remote', 'get-url', 'origin'], SRC)]
  const ids = new Set([srcMarket?.name, SRC, ...forbidExtra])
  for (const u of urls.filter((x) => typeof x === 'string' && x)) {
    ids.add(u.replace(/\.git$/, ''))
    const m = /github\.com[/:]([^/\s]+)(?:\/([^/\s#?]+))?/.exec(u)
    if (m) {
      ids.add(`github.com/${m[1]}`)
      ids.add(m[1])
      if (m[2]) ids.add(`${m[1]}/${m[2].replace(/\.git$/, '')}`)
    }
  }
  return [...ids].filter((x) => typeof x === 'string' && x.trim().length >= 4 && x !== PLUGIN)
}
const IDS = identifiers()

/** [`<file>:<line>: <text>`] for every line of `text` naming an identifier. */
function leaksIn(label, text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const low = line.toLowerCase()
    if (IDS.some((id) => low.includes(id.toLowerCase()))) out.push(`${label}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
  return out
}
const nameLeaks = (s) => IDS.some((id) => String(s).toLowerCase().includes(id.toLowerCase()))

/** The copy, as { relPath: { data: Buffer, mode } }. The host owns it now, so it is the author. */
function buildCopy(author) {
  const files = {}
  const add = (rel) => {
    const p = join(SRC, rel)
    files[rel] = { data: readFileSync(p), mode: statSync(p).mode & 0o777 }
  }
  // Tests don't run in a host, and /builder:update updates a plugin install, which a copy is not.
  const SKIP = new Set([join('scripts', 'test'), join('skills', 'update')])
  const walk = (rel) => {
    for (const n of readdirSync(join(SRC, rel)).sort()) {
      const r = join(rel, n)
      if (n === '.DS_Store' || SKIP.has(r)) continue
      statSync(join(SRC, r)).isDirectory() ? walk(r) : add(r)
    }
  }
  walk('skills')
  walk('scripts')
  for (const f of ['PROJECT.template.md', 'LICENSE', 'LICENSE-THIRD-PARTY.md']) if (existsSync(join(SRC, f))) add(f)
  const pj = { name: srcPlugin.name, description: srcPlugin.description, version: srcPlugin.version, author }
  files[join('.claude-plugin', 'plugin.json')] = { data: Buffer.from(JSON.stringify(pj, null, 2) + '\n'), mode: 0o644 }
  return files
}

// ---- the host ------------------------------------------------------------------------------
const HOST = git(['rev-parse', '--show-toplevel'], resolve(pos[0] ?? '.')) ?? fail(`${resolve(pos[0] ?? '.')} is not in a git repo`)
if (resolve(HOST) === SRC) fail('that is the plugin itself — name the repo to install into')
const MK_PATH = join(HOST, '.claude-plugin', 'marketplace.json')
const SETTINGS = join(HOST, '.claude', 'settings.json')
const LOCAL = join(HOST, '.claude', 'settings.local.json')

const hostMarket = readJson(MK_PATH)
const entry = hostMarket?.plugins?.find((p) => p.name === PLUGIN && typeof p.source === 'string')
const REL = entry ? entry.source.replace(/^\.\//, '').replace(/\/+$/, '') : join('plugins', PLUGIN)
const DEST = resolve(HOST, REL)
if (!DEST.startsWith(HOST + sep) || DEST === HOST) fail(`refusing to install outside the repo or over its root: ${REL}`)
const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
let MKT = hostMarket?.name ?? sanitize(basename(HOST))
if (nameLeaks(MKT)) MKT = 'local'

function listDest() {
  const out = []
  const walk = (rel) => {
    const d = join(DEST, rel)
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const r = rel ? join(rel, n) : n
      statSync(join(DEST, r)).isDirectory() ? walk(r) : out.push(r)
    }
  }
  walk('')
  return out
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0)

if (CHECK) {
  const found = []
  for (const r of listDest()) {
    const b = readFileSync(join(DEST, r))
    if (isText(b)) found.push(...leaksIn(relative(HOST, join(DEST, r)), b.toString('utf8')))
  }
  for (const p of [SETTINGS, MK_PATH]) if (existsSync(p)) found.push(...leaksIn(relative(HOST, p), readFileSync(p, 'utf8')))
  const have = readJson(join(DEST, '.claude-plugin/plugin.json'))?.version
  if (!have) fail(`no vendored ${PLUGIN} at ${REL}`)
  if (found.length) fail(`${PLUGIN} ${have} at ${REL} names its source:\n${found.map((l) => `  ${l}`).join('\n')}`)
  console.log(`${PLUGIN} ${have} at ${REL} — clean${have === srcPlugin.version ? '' : ` (this source is ${srcPlugin.version}: re-run without --check to update)`}`)
  process.exit(0)
}

// ---- plan ----------------------------------------------------------------------------------
const OWNER = hostMarket?.owner?.name && !nameLeaks(hostMarket.owner.name) ? hostMarket.owner.name : basename(HOST)
const copy = buildCopy({ name: OWNER })
const leaks = Object.entries(copy).flatMap(([rel, f]) => (isText(f.data) ? leaksIn(join(REL, rel), f.data.toString('utf8')) : []))
if (leaks.length) fail(`not installing — the copy would name its source:\n${leaks.map((l) => `  ${l}`).join('\n')}\nFix those lines in the plugin, then run this again.`)

const existing = new Set(listDest())
const plan = []
for (const [rel, f] of Object.entries(copy)) {
  if (!existing.has(rel)) plan.push(['+', rel])
  else {
    const cur = join(DEST, rel)
    if (!readFileSync(cur).equals(f.data) || (statSync(cur).mode & 0o777) !== f.mode) plan.push(['~', rel])
  }
}
for (const rel of existing) if (!copy[rel]) plan.push(['-', rel])

// Settings: builder enabled from the host's marketplace; nothing naming the source.
const settings = readJson(SETTINGS) ?? {}
const before = JSON.stringify(settings)
settings.enabledPlugins = Object.fromEntries(Object.entries(settings.enabledPlugins ?? {}).filter(([k]) => !nameLeaks(k)))
settings.enabledPlugins[`${PLUGIN}@${MKT}`] = true
settings.extraKnownMarketplaces = Object.fromEntries(
  Object.entries(settings.extraKnownMarketplaces ?? {}).filter(([k, v]) => !nameLeaks(k) && !nameLeaks(JSON.stringify(v)))
)
settings.extraKnownMarketplaces[MKT] ??= { source: { source: 'directory', path: '.' } }
const settingsChanged = JSON.stringify(settings) !== before

const market = hostMarket ?? { name: MKT, owner: { name: OWNER }, plugins: [] }
const mkBefore = JSON.stringify(hostMarket)
market.plugins = (market.plugins ?? []).filter((p) => !nameLeaks(JSON.stringify(p)))
if (!market.plugins.some((p) => p.name === PLUGIN)) market.plugins.push({ name: PLUGIN, source: `./${REL.split(sep).join('/')}`, description: 'The /builder:* build pipeline' })
const marketChanged = JSON.stringify(market) !== mkBefore

// The source's own install (a user-scope one, say) also answers /builder:* — off for this repo,
// in the file nobody commits. Only when git really ignores it: otherwise it would be a leak.
const localIgnored = git(['check-ignore', '-q', relative(HOST, LOCAL)], HOST) !== null
const srcKey = srcMarket?.name && srcMarket.name !== MKT ? `${PLUGIN}@${srcMarket.name}` : null
const local = readJson(LOCAL) ?? {}
const localChanged = Boolean(srcKey && localIgnored && local.enabledPlugins?.[srcKey] !== false)

const have = readJson(join(DEST, '.claude-plugin/plugin.json'))?.version
console.log(`${PLUGIN} ${have ? `${have} → ${srcPlugin.version}` : srcPlugin.version} into ${REL} (marketplace "${MKT}")`)
for (const [op, rel] of plan) console.log(`  ${op} ${rel.split(sep).join('/')}`)
if (settingsChanged) console.log(`  ~ .claude/settings.json — ${PLUGIN}@${MKT} enabled; entries naming the source removed`)
if (marketChanged) console.log(`  ${hostMarket ? '~' : '+'} .claude-plugin/marketplace.json`)
if (localChanged) console.log(`  ~ .claude/settings.local.json (git-ignored) — the source's own install off in this repo`)
if (srcKey && !localIgnored)
  console.log(`  note: .claude/settings.local.json is not git-ignored, so the source's own install is left on — turn "${srcKey}" off yourself, outside the repo`)
if (!plan.length && !settingsChanged && !marketChanged && !localChanged) {
  console.log('  already up to date — nothing to write')
  process.exit(0)
}
if (DRY) {
  console.log('dry run — nothing written')
  process.exit(0)
}

// ---- write ---------------------------------------------------------------------------------
for (const [op, rel] of plan) {
  const p = join(DEST, rel)
  if (op === '-') rmSync(p, { force: true })
  else {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, copy[rel].data)
    chmodSync(p, copy[rel].mode)
  }
}
// Directories a removal emptied.
const prune = (d) => {
  if (!existsSync(d) || !statSync(d).isDirectory()) return
  for (const n of readdirSync(d)) prune(join(d, n))
  if (d !== DEST && !readdirSync(d).length) rmSync(d, { recursive: true })
}
prune(DEST)
if (settingsChanged) {
  mkdirSync(dirname(SETTINGS), { recursive: true })
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
}
if (marketChanged) {
  mkdirSync(dirname(MK_PATH), { recursive: true })
  writeFileSync(MK_PATH, JSON.stringify(market, null, 2) + '\n')
}
if (localChanged) {
  local.enabledPlugins = { ...(local.enabledPlugins ?? {}), [srcKey]: false }
  writeFileSync(LOCAL, JSON.stringify(local, null, 2) + '\n')
}

// ---- prove it ------------------------------------------------------------------------------
const after = []
for (const r of listDest()) {
  const b = readFileSync(join(DEST, r))
  if (isText(b)) after.push(...leaksIn(relative(HOST, join(DEST, r)), b.toString('utf8')))
}
for (const p of [SETTINGS, MK_PATH]) if (existsSync(p)) after.push(...leaksIn(relative(HOST, p), readFileSync(p, 'utf8')))
if (after.length) fail(`installed, but these still name the source — fix them before committing:\n${after.map((l) => `  ${l}`).join('\n')}`)
console.log(`installed ${PLUGIN} ${srcPlugin.version} — nothing in the repo names its source. Review with git status, then commit.`)
