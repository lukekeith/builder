/**
 * The builder project config loader — `.claude/builder.md`.
 *
 * `/builder:*` ships knowing nothing about any particular repo: the apps, the registry root, the
 * base branch, the ticket system and the design source all come from ONE host file. That file's
 * frontmatter is machine-readable (this module) and its body is agent-readable (the skills).
 *
 * The parser deliberately understands a small, explicit subset of YAML — scalars, flat lists,
 * lists of one-level maps, and one level of nested map — because the alternative is a dependency,
 * and a plugin that needs `npm install` is not a plugin you can drop into a repo.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_PATH = '.claude/builder.md'

const unquote = (v) => v.replace(/^["'](.*)["']$/, '$1')

const coerce = (v) => {
  const s = unquote(v.trim())
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === '' || s === '~' || s === 'null') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  // an inline flow list: [a, b, c]
  if (/^\[.*\]$/.test(s))
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => coerce(x))
      .filter((x) => x !== null)
  return s
}

/**
 * Parse the frontmatter block. Indentation is the structure, as in YAML; the shapes supported are
 * exactly the ones PROJECT.template.md uses, and anything else is ignored rather than guessed at.
 */
const parseFrontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) return null
  const out = {}
  let listKey = null // the key whose list we are filling
  let item = null // the map currently being filled inside that list
  let mapKey = null // the key whose nested map we are filling

  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd()
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    // "- name: x" opens a new map in the current list; "- x" is a scalar entry
    if (body.startsWith('- ')) {
      if (!listKey) continue
      // The first "- " is what proves the key opened a LIST rather than a nested map.
      if (!Array.isArray(out[listKey])) out[listKey] = []
      mapKey = null
      const rest = body.slice(2).trim()
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rest)
      if (kv) {
        item = { [kv[1]]: coerce(kv[2]) }
        out[listKey].push(item)
      } else {
        out[listKey].push(coerce(rest))
        item = null
      }
      continue
    }

    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body)
    if (!kv) continue
    const [, key, valRaw] = kv
    const val = valRaw.trim()

    if (indent === 0) {
      listKey = null
      item = null
      mapKey = null
      if (val === '') {
        // Either a list or a nested map — decided by the first child line.
        out[key] = undefined
        listKey = key
        mapKey = key
        continue
      }
      out[key] = coerce(val)
      continue
    }

    // An indented key belongs to the open list item, or to the open nested map.
    if (item) {
      item[key] = coerce(val)
    } else if (mapKey) {
      if (out[mapKey] === undefined) out[mapKey] = {}
      if (typeof out[mapKey] === 'object' && !Array.isArray(out[mapKey])) out[mapKey][key] = coerce(val)
    }
  }

  // A key that opened a list but never got a "- " child stays an empty object, not undefined.
  for (const [k, v] of Object.entries(out)) if (v === undefined) out[k] = {}
  return out
}

// A list key is only known to be a list once a "- " line arrives; seed the ones we know.
const LIST_KEYS = ['apps']

/**
 * Load the config. Returns `{ ok: false, reason }` rather than throwing, so a caller can print
 * the one line that fixes it — a missing config is the normal state of a fresh install, not a crash.
 */
export function loadConfig(root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const path = join(root, CONFIG_PATH)
  if (!existsSync(path))
    return {
      ok: false,
      path,
      reason:
        `No ${CONFIG_PATH}. /builder:* reads every project fact from that one file.\n` +
        `Run /builder:init to write it from this repo, or copy PROJECT.template.md from the plugin by hand.`,
    }

  const text = readFileSync(path, 'utf8')
  const fm = parseFrontmatter(text)
  if (!fm) return { ok: false, path, reason: `${CONFIG_PATH} has no --- frontmatter block.` }

  for (const k of LIST_KEYS) if (fm[k] && !Array.isArray(fm[k])) fm[k] = []

  const apps = Array.isArray(fm.apps) ? fm.apps.filter((a) => a && a.name) : []
  if (!apps.length) return { ok: false, path, reason: `${CONFIG_PATH} frontmatter lists no apps.` }

  return {
    ok: true,
    path,
    root,
    project: fm.project ?? 'this project',
    registry: fm.registry ?? 'docs/features',
    baseBranch: fm.base_branch ?? 'main',
    apps,
    appNames: apps.map((a) => a.name),
    producers: apps.filter((a) => a.role === 'producer' || a.role === 'app').map((a) => a.name),
    consumers: apps.filter((a) => a.role === 'consumer' || a.role === 'app').map((a) => a.name),
    tools: apps.filter((a) => a.role === 'tool').map((a) => a.name),
    released: apps.filter((a) => a.released_artifact).map((a) => a.name),
    manualCommit: apps.filter((a) => a.commit === 'manual').map((a) => a.name),
    // A block left as template placeholders (`<command that resolves a ref>`) is NOT configured.
    // Treating it as configured would make prototype mode look real and hand a literal `<…>` to a
    // shell — so an unfilled block reads as absent, which is what an unfilled block means.
    ticket: unfilled(fm.ticket) ? null : (fm.ticket ?? null),
    design: unfilled(fm.design) ? null : (fm.design ?? null),
    body: text.slice(text.indexOf('\n---', 3) + 4),
  }
}

/**
 * True when ANY value in a block is still a `<placeholder>` from the template. Any is the right
 * test, not every: a half-filled `design:` block whose `resolver` is still `<command…>` is not
 * usable, however real its other keys look.
 */
const unfilled = (block) => {
  if (!block || typeof block !== 'object') return false
  return Object.values(block).some((v) => typeof v === 'string' && /^<.*>$/.test(v.trim()))
}

/** Print the reason and exit — the shared failure path for every builder script. */
export function requireConfig(root) {
  const cfg = loadConfig(root)
  if (!cfg.ok) {
    console.error(cfg.reason)
    process.exit(2)
  }
  return cfg
}
