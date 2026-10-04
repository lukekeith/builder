/**
 * The registry's layout, in one place. In-flight features are folders directly under the config's
 * `registry:`; /builder:ship moves a shipped one into `<registry>/_archive/<feature>/` in the ship
 * commit, where nothing routine reads it. Listing in-flight work never touches the archive, and
 * "has X shipped?" is one existsSync — the same cost at ten shipped features as at ten thousand.
 *
 *   node <plugin>/scripts/registry.mjs --sweep   # one-time: git mv every shipped folder into _archive/
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseManifest } from './manifest.mjs'
import { requireConfig } from './config.mjs'

export const ARCHIVE = '_archive'

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** In-flight feature and program folders: every directory but `_archive` (and any `_`/`.` name). */
export function features(root, registry) {
  try {
    return readdirSync(join(root, registry), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

export const isArchived = (root, registry, name) => existsSync(join(root, registry, ARCHIVE, name))

/** Where a feature's docs are: its live folder, else its archived one, else the live path (so a
 *  caller's "missing" handling is unchanged). */
export function specDir(root, registry, name) {
  const live = join(root, registry, name)
  if (existsSync(live)) return live
  const archived = join(root, registry, ARCHIVE, name)
  return existsSync(archived) ? archived : live
}

/** A folder that says it shipped: a `✅ SHIPPED` SPEC or PROGRAM header, `state: shipped`, or — in a
 *  legacy layout — a README `✅ **SHIPPED**` header or `**Status:**` line that opens with SHIPPED
 *  (never "shipped-ready"). The same rules list-features.mjs counts as DONE. */
export function isShippedFolder(dir) {
  for (const doc of ['SPEC.md', 'PROGRAM.md']) if (/✅\s*\*{0,2}SHIPPED/.test((read(join(dir, doc)) ?? '').slice(0, 800))) return true
  const mf = read(join(dir, 'MANIFEST.md'))
  if (mf != null && parseManifest(mf).state === 'shipped') return true
  const readme = read(join(dir, 'README.md'))
  if (readme == null) return false
  if (/✅\s*\*\*SHIPPED/.test(readme.slice(0, 800))) return true
  const m = readme.match(/\*\*Status:\*\*\s*([^\n]*)/) ?? readme.match(/\*\*Status:\s*([^*\n]*)\*\*/)
  const status = m ? m[1].replace(/[`*]/g, '').replace(/\s+/g, ' ').trim() : ''
  return /^SHIPPED\b/i.test(status) && !/^shipped-ready/i.test(status)
}

/**
 * Move every in-flight folder that says it shipped into the archive with `git mv`, leaving the
 * result staged for the human to commit. Refuses while anything under the registry is uncommitted,
 * so the move never mixes with work in progress. A name already in the archive is left in place.
 */
export function sweep(root, registry) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', registry], { cwd: root, encoding: 'utf8' }).trimEnd()
  if (dirty) return { ok: false, reason: `uncommitted changes under ${registry} — commit or stash them first:\n${dirty}` }
  const moved = []
  const collisions = []
  for (const name of features(root, registry).sort()) {
    if (!isShippedFolder(join(root, registry, name))) continue
    if (isArchived(root, registry, name)) {
      collisions.push(name)
      continue
    }
    mkdirSync(join(root, registry, ARCHIVE), { recursive: true })
    execFileSync('git', ['mv', join(registry, name), join(registry, ARCHIVE, name)], { cwd: root })
    moved.push(name)
  }
  return { ok: true, moved, collisions }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invoked) {
  if (!process.argv.slice(2).includes('--sweep')) {
    console.error('Usage: registry.mjs --sweep   (moves every shipped folder into <registry>/_archive/, staged)')
    process.exit(2)
  }
  const CFG = requireConfig()
  const r = sweep(CFG.root, CFG.registry)
  if (!r.ok) {
    console.error(r.reason)
    process.exit(1)
  }
  for (const n of r.collisions) console.log(`⚠ ${n} — ${CFG.registry}/${ARCHIVE}/${n} already exists; left in place`)
  if (!r.moved.length) console.log(`Nothing to archive — no shipped folder outside ${CFG.registry}/${ARCHIVE}/.`)
  else {
    console.log(`Moved ${r.moved.length} shipped folder(s) into ${CFG.registry}/${ARCHIVE}/ (staged, not committed):`)
    for (const n of r.moved) console.log(`  ${n}`)
    console.log('Commit them: git commit -m "docs: archive shipped features"')
  }
}
