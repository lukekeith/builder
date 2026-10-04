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
const BUILD_PROFILE_DEFAULTS = ['rush', 'standard', 'thorough']

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

  // agentWalkOf can throw (a malformed `env:` pair) — that's a config-authoring mistake, not a
  // crash, so it surfaces through the same {ok: false, reason} path as every other bad config.
  let agentWalk
  try {
    agentWalk = agentWalkOf(fm.agent_walk)
  } catch (err) {
    return { ok: false, path, reason: err.message }
  }

  return {
    ok: true,
    path,
    root,
    project: fm.project ?? 'this project',
    registry: fm.registry ?? 'docs/features',
    baseBranch: fm.base_branch ?? 'main',
    // Where finished features merge: merge_into, else base_branch. Never the checked-out branch.
    mergeInto: fm.merge_into ?? fm.base_branch ?? 'main',
    buildProfileDefault: BUILD_PROFILE_DEFAULTS.includes(fm.build_profile_default) ? fm.build_profile_default : null,
    // An unusable value, for whoever reports it (profile.mjs --recommend, /builder:init) — never
    // warned from here: the statusline loads the config on every render, each in a new process.
    buildProfileDefaultInvalid: fm.build_profile_default == null || BUILD_PROFILE_DEFAULTS.includes(fm.build_profile_default) ? null : String(fm.build_profile_default),
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
    agentWalk,
    flaky: flakyOf(fm.flaky),
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

/**
 * The optional `flaky:` list — gates whose failure output matching `match` (a regex, or the literal
 * text when it is not one) earns ONE re-run: `rerun` when given (the narrow command that proves the
 * flaky file alone), else the same command. `scripts/gate.mjs` applies it, so the decision "is this
 * the known flake?" is made by the config, not by a model reading a 100-line tail each time. An
 * entry with no `match`, or still a template `<placeholder>`, is dropped.
 */
const flakyOf = (list) => {
  if (!Array.isArray(list)) return []
  return list
    .filter((e) => e && typeof e === 'object' && typeof e.match === 'string' && e.match.trim() && !unfilled(e))
    .map((e) => ({ match: e.match.trim(), rerun: typeof e.rerun === 'string' && e.rerun.trim() ? e.rerun.trim() : null }))
}

/**
 * The optional `agent_walk:` block — what an unattended /builder:fleet run needs. Absent, not a
 * map, or still carrying a template `<placeholder>` → null, and `--agent-walk` refuses. `parallel`
 * defaults to 3; `keep_logs` — days a landed feature's archived logs are kept — defaults to 30, and 0 keeps them; `auto_unpark` — how many times one fleet run retries a park on its own — defaults to 2, and 0 turns it off; `worktrees` is resolved by the fleet (default: a sibling of the repo).
 *
 * `copy`, `setup`, `env`, `start` and `smoke` prepare an isolated dev env per worktree: `copy`
 * brings along untracked files a fresh checkout wouldn't have, `setup` runs once, `env` is passed
 * to the walk lane's children only (its claude runs and reset/start/smoke/stop — never a build-lane
 * run or setup), and `start`/`smoke` bring up and probe a walk-lane's own dev server.
 * `worktree_env` reaches EVERY child in a worktree — build-lane and ship-lane runs, `setup`, and
 * the walk lane underneath `env` — with `{feature}` filled in: it is how each worktree's tests get
 * their own database, which is what makes `parallel` > 1 safe when the suites share one. `sync` runs
 * in a worktree after the fleet merges the target in WITH new commits — the install and the
 * test-DB migration that a merge bringing a new package or a new migration needs (seen: a walk env
 * that could not find a package the merge had just added). All seven are optional and default to
 * the shape a caller can iterate/spread with no special-casing: `[]`, `null` or `{}`, never
 * `undefined`.
 */
const agentWalkOf = (block) => {
  if (!block || typeof block !== 'object' || Array.isArray(block) || unfilled(block)) return null
  return {
    driver: block.driver ?? null,
    claudeArgs: block.claude_args ?? null,
    worktrees: block.worktrees ?? null,
    parallel: Number.isInteger(block.parallel) && block.parallel > 0 ? block.parallel : 3,
    reset: block.reset ?? null,
    stop: block.stop ?? null,
    copy:
      typeof block.copy === 'string'
        ? block.copy
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    setup: block.setup ?? null,
    sync: block.sync ?? null,
    env: typeof block.env === 'string' ? parseEnvPairs(block.env) : {},
    worktreeEnv: typeof block.worktree_env === 'string' ? parseEnvPairs(block.worktree_env, 'agent_walk.worktree_env') : {},
    start: block.start ?? null,
    smoke: block.smoke ?? null,
    keepLogs: Number.isInteger(block.keep_logs) && block.keep_logs >= 0 ? block.keep_logs : 30,
    autoUnpark: Number.isInteger(block.auto_unpark) && block.auto_unpark >= 0 ? block.auto_unpark : 2,
  }
}

/**
 * Parse an `env:` value — whitespace-separated `KEY=VALUE` pairs, a value allowed to contain
 * whitespace by wrapping it in double quotes (`A="x y"`). Each token splits at its FIRST `=`, so a
 * value that itself contains `=` (a query string, say) survives intact. `{feature}` is left alone
 * here — the fleet substitutes it per feature, once, right before it hands the env to a child.
 */
export function parseEnvPairs(s, where = 'agent_walk.env') {
  const tokens = s.match(/(?:[^\s"]|"[^"]*")+/g) ?? []
  const out = {}
  for (const token of tokens) {
    const i = token.indexOf('=')
    const key = i === -1 ? '' : token.slice(0, i)
    if (!key) throw new Error(`${where}: "${token}" is not KEY=VALUE`)
    const raw = token.slice(i + 1)
    out[key] = /^".*"$/.test(raw) ? raw.slice(1, -1) : raw
  }
  return out
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
