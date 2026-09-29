/**
 * The design conversation's workspace record, `.builder/<feature>/brainstorm.md`, written by
 * /builder:brainstorm and /builder:intake and read by /builder:spec. Scripts read only its HEADER —
 * the lines before the first blank line — so listing a hundred conversations reads a few KB.
 * The format is skills/brainstorm/CONVERSATION.md §The record.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const BRAINSTORM_FILE = 'brainstorm.md'
const HEADER_BYTES = 4096

/** The header's fields, or null when the file is missing, empty, or has no `status:` line. */
export function readBrainstormHeader(path) {
  if (!existsSync(path)) return null
  const buf = Buffer.alloc(HEADER_BYTES)
  const fd = openSync(path, 'r')
  let len = 0
  try {
    len = readSync(fd, buf, 0, HEADER_BYTES, 0)
  } finally {
    closeSync(fd)
  }
  const head = buf.subarray(0, len).toString('utf8').split(/\r?\n\s*\r?\n/)[0]
  const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head)?.[1].trim() ?? null
  const status = field('status')
  if (!status) return null
  const [word, size = null] = status.split(/\s+/)
  const settled = /^(\d+)\s+of\s+(\d+)$/.exec(field('settled') ?? '')
  const contradicted = field('contradicted')
  return {
    status: word,
    size,
    source: field('source'),
    input: field('input'),
    updated: field('updated'),
    settled: settled ? { n: Number(settled[1]), m: Number(settled[2]) } : null,
    contradicted: contradicted != null && /^\d+$/.test(contradicted) ? Number(contradicted) : null,
  }
}

/** A conversation still open on a feature: the header of `.builder/<feature>/brainstorm.md` when its
 *  status is anything but `handed-off`, else null. On a live registry folder that is a revision
 *  conversation in progress — it comes before the manifest's next step. */
export function openRevision(root, feature) {
  const h = readBrainstormHeader(join(root, '.builder', feature, BRAINSTORM_FILE))
  return h && h.status !== 'handed-off' ? h : null
}

const frac = (h) => (h.settled ? `${h.settled.n}/${h.settled.m} settled` : 'nothing settled yet')

/** How one header reads in the status table, and the command that picks it up. The status table
 *  shows lastDone, not state, so lastDone carries the state label. */
function describe(name, registry, h) {
  const path = `${registry}/${name}`
  const row = (state, nextStep, command) => ({ state, lastDone: state, nextStep, command })
  if (!h) return row('unreadable brainstorm.md', 'Restart the brainstorm', `/builder:brainstorm --path ${path}`)
  const skill = h.source === 'intake' ? 'intake' : 'brainstorm'
  const again = `/builder:${skill} --path ${path}`
  if (h.status === 'parked') return row(`parked idea (${frac(h)})`, 'Pick it back up when ready', again)
  if (h.status === 'sized' && ['md', 'lg', 'xl'].includes(h.size)) return row(`sized ${h.size} — spec not written`, 'Write the spec', `/builder:spec --path ${path}`)
  if (h.status === 'sized') return row(`sized ${h.size ?? '?'} — build in chat`, 'Design in chat and build', again)
  if (skill === 'intake') return row(`intake (${h.contradicted ?? 0} contradicted, ${frac(h)})`, 'Continue the intake', again)
  return row(`brainstorming (${frac(h)})`, 'Continue the brainstorm', again)
}

/** Rows for conversations that have no registry folder yet. A live folder owns its own row. */
export function draftRows(root, registry) {
  const base = join(root, '.builder')
  let names = []
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[_.]/.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const rows = []
  for (const name of names.sort()) {
    const file = join(base, name, BRAINSTORM_FILE)
    if (!existsSync(file) || existsSync(join(root, registry, name))) continue
    const h = readBrainstormHeader(file)
    if (h?.status === 'handed-off') continue
    const d = describe(name, registry, h)
    rows.push({
      feature: name,
      layout: 'brainstorm',
      path: `${registry}/${name}`,
      done: false,
      source: h?.source ?? null,
      state: d.state,
      lastDone: d.lastDone,
      nextStep: d.nextStep,
      command: d.command,
      next: d.command,
      updatedAt: h?.updated ?? null,
      updated: null,
      description: null,
      branch: null,
      waitsOn: [],
      warnings: [],
      problems: [],
    })
  }
  return rows
}
