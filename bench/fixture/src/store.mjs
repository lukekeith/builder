import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export const NOTES_FILE = process.env.NOTES_FILE || './notes.json'

/** { nextId, notes: [{ id, text }] } — an empty store when the file is missing. */
export function load(file = NOTES_FILE) {
  if (!existsSync(file)) return { nextId: 1, notes: [] }
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function save(store, file = NOTES_FILE) {
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n')
}
