import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

/** A scratch NOTES_FILE (seeded when given a store) and a runner for the CLI against it. */
export function notes(seed = null) {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  if (seed) writeFileSync(file, JSON.stringify(seed))
  const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NOTES_FILE: file } }).trim()
  run.file = file
  return run
}
