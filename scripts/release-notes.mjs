#!/usr/bin/env node
/**
 * release-notes — one version's section of CHANGELOG.md, for its GitHub release (RELEASING.md step 5).
 *
 *   node scripts/release-notes.mjs <version> [--changelog <file>]
 *
 * Prints the body under `## <version>` up to the next `## <version>` heading, trimmed. Exit 1 when the
 * changelog has no such section or it is empty — a release never goes out without its notes.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export function notesFor(changelog, version) {
  const lines = String(changelog).replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((l) => l.trim() === `## ${version}`)
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && /^## \d/.test(l))
  const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
  return body || null
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const version = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--changelog')
  const i = argv.indexOf('--changelog')
  const file = i >= 0 ? argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')
  if (!version || (i >= 0 && !file)) {
    console.error('usage: release-notes.mjs <version> [--changelog <file>]')
    process.exit(2)
  }
  const notes = notesFor(readFileSync(file, 'utf8'), version)
  if (!notes) {
    console.error(`${file} has no notes under "## ${version}" — write them before releasing`)
    process.exit(1)
  }
  console.log(notes)
}
