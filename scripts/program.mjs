/**
 * Program dependencies — which of a child's PROGRAM §Children "Depends on" entries have not shipped.
 * Shared by list-features.mjs and the fleet, so /builder:agent never offers, and the fleet never
 * builds, a child against a contract that isn't merged yet. A chain runs one wave per fleet run.
 *
 * A dependency is MET when the program manifest's `child: <dep> — shipped` line says so, or the
 * dependency's own folder does (a `✅ SHIPPED` SPEC or PROGRAM header, or `state: shipped`) — ship
 * condenses the folder, and the child line can lag it. A token that is not a child may name another
 * feature or program in the registry (`glyph-library (shipped)`): met the same way. A parenthetical
 * is a note, not a dependency. A token naming nothing is unmet: a typo holds the child back rather
 * than letting it run.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from './manifest.mjs'

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** A table cell's name: link text over its target, code spans and bold unwrapped. */
const bare = (cell) =>
  cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()

const split = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** PROGRAM §Children as [{ num, name, deps: [token] }]. Columns are found by header, not position. */
export function parseChildren(text) {
  const lines = (text ?? '').split('\n')
  const start = lines.findIndex((l) => /^##\s+Children\b/.test(l))
  if (start < 0) return []
  const table = []
  for (const l of lines.slice(start + 1)) {
    if (/^#/.test(l)) break
    if (/^\s*\|/.test(l)) table.push(split(l))
    else if (table.length && l.trim()) break
  }
  if (table.length < 2) return []
  const head = table[0].map((h) => h.toLowerCase())
  const iNum = head.findIndex((h) => h === '#')
  const iName = head.findIndex((h) => h.startsWith('feature'))
  const iDeps = head.findIndex((h) => h.startsWith('depends on'))
  if (iName < 0) return []
  return table
    .slice(1)
    .filter((r) => !r.every((c) => /^:?-+:?$/.test(c)))
    .map((r) => {
      const deps = iDeps < 0 ? '' : bare(r[iDeps] ?? '').replace(/\([^)]*\)/g, ' ').trim()
      return {
        num: iNum < 0 ? null : bare(r[iNum] ?? ''),
        name: bare(r[iName] ?? '').split(/\s+/)[0],
        deps: /^(—|-|none)?$/i.test(deps) ? [] : deps.split(/[\s,;]+/).filter(Boolean),
      }
    })
}

const shippedFolder = (dir) => {
  for (const doc of ['SPEC.md', 'PROGRAM.md']) if (/✅\s*\*{0,2}SHIPPED/.test((read(join(dir, doc)) ?? '').slice(0, 800))) return true
  const mf = read(join(dir, 'MANIFEST.md'))
  return mf != null && parseManifest(mf).state === 'shipped'
}

/** The state a registry folder's manifest reports, for the "waits on" text. */
const folderState = (dir) => {
  const mf = read(join(dir, 'MANIFEST.md'))
  return (mf && parseManifest(mf).state) || 'not shipped'
}

/** The unmet dependencies of `feature`, as [{ name, state }] — [] for a feature in no program. */
export function waitsOn(root, registry, feature) {
  const reg = join(root, registry)
  if (!existsSync(reg)) return []
  for (const prog of readdirSync(reg)) {
    const mfText = read(join(reg, prog, 'MANIFEST.md'))
    if (!mfText) continue
    const mf = parseManifest(mfText)
    if (mf.tier !== 'program') continue
    const states = new Map(
      (mf.children ?? []).map((c) => {
        const [name, state] = c.split(/\s+—\s+/)
        return [name.trim(), (state ?? '').trim()]
      })
    )
    if (!states.has(feature)) continue
    const rows = parseChildren(read(join(reg, prog, 'PROGRAM.md')))
    const me = rows.find((r) => r.name === feature)
    if (!me) return []
    const out = []
    for (const tok of me.deps) {
      const n = tok.replace(/^#/, '')
      const dep = /^\d+$/.test(n) ? rows.find((r) => r.num?.replace(/^#/, '') === n)?.name : rows.find((r) => r.name === tok)?.name
      if (!dep) {
        // Not a child — another feature or program in the registry, or nothing at all.
        const dir = join(reg, tok)
        if (/^[\w.-]+$/.test(tok) && existsSync(dir)) {
          if (!shippedFolder(dir)) out.push({ name: tok, state: folderState(dir) })
        } else out.push({ name: tok, state: 'no such child or feature' })
        continue
      }
      if (states.get(dep) === 'shipped' || shippedFolder(join(reg, dep))) continue
      out.push({ name: dep, state: states.get(dep) || 'not started' })
    }
    return out
  }
  return []
}

/** `waits on a (building), b (spec)` — the one phrasing the fleet and the dashboard share. */
export const waitsOnText = (deps) => `waits on ${deps.map((d) => `${d.name} (${d.state})`).join(', ')}`
