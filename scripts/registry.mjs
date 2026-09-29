/**
 * The registry's layout, in one place. In-flight features are folders directly under the config's
 * `registry:`; /builder:ship moves a shipped one into `<registry>/_archive/<feature>/` in the ship
 * commit, where nothing routine reads it. Listing in-flight work never touches the archive, and
 * "has X shipped?" is one existsSync — the same cost at ten shipped features as at ten thousand.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from './manifest.mjs'

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

/** A folder that says it shipped: a `✅ SHIPPED` SPEC or PROGRAM header, or `state: shipped`. */
export function isShippedFolder(dir) {
  for (const doc of ['SPEC.md', 'PROGRAM.md']) if (/✅\s*\*{0,2}SHIPPED/.test((read(join(dir, doc)) ?? '').slice(0, 800))) return true
  const mf = read(join(dir, 'MANIFEST.md'))
  return mf != null && parseManifest(mf).state === 'shipped'
}
