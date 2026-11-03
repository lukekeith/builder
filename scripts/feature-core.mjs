/**
 * What every "the orchestrator used to type this" script shares: finding the feature, its repo, its
 * config, its manifest and its workspace; reading a markdown section by its heading; writing the
 * manifest's `key: value` lines; the ledger; git. One place, so dispatch, advance, condense,
 * handoff, walk-script and docs read a feature exactly the same way.
 *
 * Every write here is whole-file and atomic (a temp file renamed over the target), so a crash leaves
 * the old file or the new one — never half of each. Every script built on this is safe to re-run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, basename, dirname, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseManifest, isSet } from './manifest.mjs'
import { loadConfig } from './config.mjs'

/** The plugin's own directory — what the skills call `<builder>`. */
export const BUILDER = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Write via a temp file and a rename: a crash leaves the old file or the new one, never a torn one. */
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

export function git(cwd, args, { allowFail = false, input } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return null
    const msg = String(err.stderr || err.message).trim().split('\n').slice(-3).join(' ')
    throw new Error(`git ${args.join(' ')} failed: ${msg}`)
  }
}

/** The git toplevel holding `dir` — a fleet worktree's own root, never the main checkout's. */
export function repoRoot(dir) {
  const r = git(existsSync(dir) ? dir : process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true })
  return r || process.env.CLAUDE_PROJECT_DIR || process.cwd()
}

export const posix = (p) => p.split(sep).join('/')

/** Local date, YYYY-MM-DD. `BUILDER_TODAY` pins it (tests, and a re-run that must write the same line). */
export function today() {
  if (process.env.BUILDER_TODAY) return process.env.BUILDER_TODAY
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `.builder/<feature>/` — the same directory `scripts/workspace <feature>` prints, created the same way. */
export function workspaceDir(root, feature, { create = true } = {}) {
  if (!feature || /[/\s]|^\.\.?$/.test(feature)) throw new Error(`feature must be a bare folder name (got: '${feature}')`)
  const base = join(root, '.builder')
  const ws = join(base, feature)
  if (create) {
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(base, '.gitignore'), '*\n')
  }
  return ws
}

/**
 * A feature folder argument → everything a script needs about it. The folder may be given relative
 * to the cwd or absolute; the repo is the folder's own git toplevel.
 */
export function openFeature(folderArg) {
  if (!folderArg) throw new Error('no feature folder given')
  const dir = resolve(folderArg)
  if (!existsSync(dir)) throw new Error(`no such feature folder: ${dir}`)
  const root = repoRoot(dir)
  const cfg = loadConfig(root)
  const feature = basename(dir)
  const manifestPath = join(dir, 'MANIFEST.md')
  const manifestText = read(manifestPath)
  const manifest = parseManifest(manifestText ?? '')
  const key = [manifest.ticket].find(isSet) ?? feature
  return {
    root,
    dir,
    rel: posix(relative(root, dir)),
    feature,
    cfg: cfg.ok ? cfg : null,
    cfgError: cfg.ok ? null : cfg.reason,
    manifestPath,
    manifestText,
    manifest,
    key,
    specPath: join(dir, 'SPEC.md'),
    planPath: join(dir, 'PLAN.md'),
    ws: (opts) => workspaceDir(root, feature, opts),
  }
}

// ---- markdown sections ---------------------------------------------------------------------------

const FENCE = /^\s*(`{3,}|~{3,})/

/** Every heading outside a code fence: { i (line index), level, title }. */
export function headings(text) {
  const out = []
  let open = null
  const lines = String(text ?? '').split('\n')
  lines.forEach((line, i) => {
    const f = FENCE.exec(line)
    if (f) {
      if (!open) open = f[1]
      else if (f[1][0] === open[0] && f[1].length >= open.length && line.trim() === f[1]) open = null
      return
    }
    if (open) return
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) out.push({ i, level: h[1].length, title: h[2] })
  })
  return out
}

/** A heading's title as it is matched: no emoji, no `§`, no backticks or bold, single spaces. */
export const normTitle = (t) =>
  String(t)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[§`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The section under the heading named `name` — fence-aware, from its heading line to the next heading
 * of the same or a higher level. Matched exactly first, then as a prefix ending at a word boundary
 * (`The verifier` finds `The verifier — the mechanism`). `level` narrows to one heading level.
 * → { start, end, level, title, text (heading line included), body } or null.
 */
export function mdSection(text, name, { level = null } = {}) {
  const lines = String(text ?? '').split('\n')
  const hs = headings(text).filter((h) => level == null || h.level === level)
  const want = normTitle(name)
  const hit =
    hs.find((h) => normTitle(h.title) === want) ??
    hs.find((h) => {
      const t = normTitle(h.title)
      return t.startsWith(want) && /^[\s—–:(-]/.test(t.slice(want.length))
    })
  if (!hit) return null
  const all = headings(text)
  const next = all.find((h) => h.i > hit.i && h.level <= hit.level)
  const end = next ? next.i : lines.length
  let stop = end
  while (stop > hit.i + 1 && lines[stop - 1].trim() === '') stop--
  return {
    start: hit.i,
    end,
    level: hit.level,
    title: hit.title,
    text: lines.slice(hit.i, stop).join('\n'),
    body: lines.slice(hit.i + 1, stop).join('\n').replace(/^\n+/, ''),
  }
}

/** A config body's `## <name>` section body, or '' — the config's §Global constraints, §Environment landmines … */
export const configSection = (cfg, name) => mdSection(cfg?.body ?? '', name, { level: 2 })?.body ?? ''

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/** A markdown table's data rows as cell arrays (the `|` lines after its `|---` separator). */
export function tableRows(sectionText) {
  const rows = []
  let seenSep = false
  for (const line of String(sectionText ?? '').split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (/^\|\s*:?-{2,}/.test(line.trim())) {
      seenSep = true
      continue
    }
    if (seenSep) rows.push(cells(line))
  }
  return rows
}

// ---- the manifest --------------------------------------------------------------------------------

/** The order REFERENCE §MANIFEST.md writes the keys in — where a key that is not there yet goes. */
export const MANIFEST_ORDER = [
  'size', 'tier', 'state', 'next', 'head', 'ticket', 'branch', 'pr', 'apps', 'contract', 'hold', 'go-ahead',
  'tests', 'profile', 'target', 'walk', 'verify', 'ready', 'auto', 'blocked', 'agent-walk', 'build',
]

/**
 * Set (and unset) `key: value` lines in a manifest's text. An existing line is replaced in place (a
 * trailing `  # comment` is kept); a new key goes after the last key that precedes it in
 * MANIFEST_ORDER (unknown keys at the end). Values are written as given.
 */
export function setManifestKeys(text, sets = [], unsets = []) {
  let lines = String(text ?? '').replace(/\n+$/, '').split('\n').filter((l, i, a) => !(a.length === 1 && l === ''))
  const keyOf = (l) => /^([a-z-]+):/.exec(l)?.[1]
  lines = lines.filter((l) => !unsets.includes(keyOf(l)))
  for (const [k, v] of sets) {
    const i = lines.findIndex((l) => keyOf(l) === k)
    if (i >= 0) {
      const comment = /(\s{2,}#.*)$/.exec(lines[i])?.[1] ?? ''
      lines[i] = `${k}: ${v}${comment}`
      continue
    }
    const rank = MANIFEST_ORDER.indexOf(k)
    let at = lines.length
    if (rank >= 0) {
      let after = -1
      lines.forEach((l, j) => {
        const r = MANIFEST_ORDER.indexOf(keyOf(l))
        if (r >= 0 && r < rank) after = j
      })
      const firstLater = lines.findIndex((l) => MANIFEST_ORDER.indexOf(keyOf(l)) > rank)
      at = after >= 0 ? after + 1 : firstLater >= 0 ? firstLater : lines.length
    }
    lines.splice(at, 0, `${k}: ${v}`)
  }
  return lines.join('\n') + '\n'
}

// ---- the ledger ------------------------------------------------------------------------------------

export const ledgerIdentity = (rel) => `# builder ledger — plan: ${rel}/PLAN.md`

/**
 * Append lines to `<WS>/progress.md`, creating it with its identity line (EXECUTION §Setup). A line
 * already in the ledger is not appended again — that is what makes a re-run after a crash a no-op.
 * A ledger whose identity names another plan is never written. → { added, path }.
 */
export function appendLedger(ws, rel, text) {
  const path = join(ws, 'progress.md')
  const id = ledgerIdentity(rel)
  let cur = read(path)
  if (cur != null && cur.split('\n')[0].startsWith('# builder ledger') && cur.split('\n')[0] !== id)
    throw new Error(`${path} is another feature's ledger (${cur.split('\n')[0]}) — not written`)
  if (cur == null || cur.trim() === '') cur = `${id}\n`
  const have = new Set(cur.split('\n'))
  const add = String(text).split('\n').filter((l) => l.trim() && !have.has(l))
  if (add.length) writeAtomic(path, cur.replace(/\n*$/, '\n') + add.join('\n') + '\n')
  else if (!existsSync(path)) writeAtomic(path, cur)
  return { added: add, path }
}

/** The short HEAD sha, or null outside a repo / before the first commit. */
export const shortHead = (root) => git(root, ['rev-parse', '--short', 'HEAD'], { allowFail: true })
export const currentBranch = (root) => git(root, ['branch', '--show-current'], { allowFail: true }) || null

/** Code commits since `sha` — every changed path outside the registry (docs and manifests don't count). */
export function codeChangedSince(root, sha, registry) {
  if (!sha) return null
  const out = git(root, ['diff', '--name-only', `${sha}..HEAD`, '--', '.', `:(exclude)${registry}`], { allowFail: true })
  if (out == null) return null
  return out.split('\n').filter(Boolean)
}

/** The SPEC header's sign-off lines (a human's `> ✅ SIGNED OFF`, the agent's `> 🤖 AGENT SIGNED OFF`). */
const SIGNED_LINE = /^> (✅ SIGNED OFF|🤖 AGENT SIGNED OFF)\b/

/** The shas the `>` header under a SPEC's title was signed off at — `… — <sha> · …` on each sign-off line, a re-sign's too. */
export function signoffShas(spec) {
  const all = String(spec ?? '').split('\n')
  const t = all.findIndex((l) => /^# /.test(l))
  const out = []
  for (let j = t + 1; t >= 0 && j < all.length && all[j].startsWith('>'); j++) {
    if (!SIGNED_LINE.test(all[j])) continue
    const m = /— ([0-9a-f]{7,40})(?=\s*(·|$))/.exec(all[j])
    if (m) out.push(m[1])
  }
  return out
}

/**
 * The commits a feature was signed off at, read from its SPEC at `<folderRel>/SPEC.md` — or, once the
 * ship replaced that header with SHIPPED and moved the folder to the archive, from the SPEC as it was
 * before. Only shas that are commits here: a hand-written or fixture sha pins nothing.
 */
export function signedOffShas(root, folderRel) {
  return signedOff(root, folderRel).shas
}

/**
 * signedOffShas, and who signed: `human` when the newest sign-off line is a human's `> ✅ SIGNED OFF`
 * (an agent must not replace that silently), false for the agent's `> 🤖 AGENT SIGNED OFF`.
 */
export function signedOff(root, folderRel) {
  const rel = `${folderRel.replace(/\/+$/, '')}/SPEC.md`
  const real = (shas) => shas.filter((s) => git(root, ['rev-parse', '--verify', '--quiet', `${s}^{commit}`], { allowFail: true }))
  const of = (spec) => {
    const shas = real(signoffShas(spec))
    const lines = String(spec ?? '').split('\n').filter((l) => SIGNED_LINE.test(l))
    return { shas, human: /^> ✅ SIGNED OFF/.test(lines.at(-1) ?? '') }
  }
  const now = of(read(join(root, rel)))
  if (now.shas.length) return now
  const log = git(root, ['log', '--format=%H', '-n', '20', '--', rel], { allowFail: true }) ?? ''
  for (const c of log.split('\n').filter(Boolean)) {
    for (const rev of [c, `${c}^`]) {
      const then = of(git(root, ['show', `${rev}:${rel}`], { allowFail: true }))
      if (then.shas.length) return then
    }
  }
  return { shas: [], human: false }
}

/**
 * What changed outside the registry since the feature was signed off at `sha` — the code a ship or a
 * landing would carry that nobody walked. Registry commits (walk results, the manifest, the ship) don't
 * count, and neither does a merge of `target` into the branch that git resolved on its own (the fleet
 * picks up other features' merges that way); a conflict resolved by hand does. → [] when the sign-off
 * still covers HEAD, else the paths (['<sha>'] when HEAD no longer descends from it).
 */
export function changedSinceSignoff(root, sha, registry, target) {
  if (git(root, ['merge-base', '--is-ancestor', sha, 'HEAD'], { allowFail: true }) === null) return [sha]
  const quick = codeChangedSince(root, sha, registry)
  if (quick && !quick.length) return []
  const code = (from, to) => (git(root, ['diff', '--name-only', '--no-renames', from, to, '--', '.', `:(exclude)${registry}`], { allowFail: true }) ?? '?').split('\n').filter(Boolean)
  const changed = new Set()
  const commits = (git(root, ['rev-list', '--first-parent', '--parents', `${sha}..HEAD`], { allowFail: true }) ?? '').split('\n').filter(Boolean)
  for (const line of commits) {
    const [c, p1, p2] = line.split(' ')
    let base = p1
    if (p2 && target && git(root, ['merge-base', '--is-ancestor', p2, target], { allowFail: true }) !== null) {
      // A merge of the target: only what differs from git's own merge of the two parents is the branch's.
      let auto = null
      try {
        auto = execFileSync('git', ['merge-tree', '--write-tree', p1, p2], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0].trim()
      } catch (err) {
        auto = String(err.stdout ?? '').split('\n')[0].trim() || null // exit 1: conflicts, the tree (with markers) still first
      }
      if (auto) base = auto
    }
    for (const p of code(base, c)) changed.add(p)
  }
  return [...changed]
}

/**
 * Whether a sign-off covers HEAD: any of `shas` (the header's lines, a re-sign's too) with nothing
 * but registry commits and clean merges of `target` since. → { holds, sha, changed }. No sha → holds
 * (nothing to pin to — a header written by hand, or a fixture).
 */
export function signoffHolds(root, shas, registry, target) {
  if (!shas.length) return { holds: true, sha: null, changed: [] }
  let best = null
  for (const sha of shas) {
    const changed = changedSinceSignoff(root, sha, registry, target)
    if (!changed.length) return { holds: true, sha, changed }
    best = { holds: false, sha, changed } // the newest line (a re-sign is appended) names what changed
  }
  return best
}

/** Parse `--flag value` / `--flag=value` / repeatable flags out of argv. */
export function parseArgs(argv, { repeat = [], bool = [] } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    let [k, v] = a.slice(2).split(/=(.*)/s)
    if (bool.includes(k)) {
      out[k] = true
      continue
    }
    if (v === undefined) v = argv[++i]
    if (v === undefined) throw new Error(`--${k} needs a value`)
    if (repeat.includes(k)) (out[k] ??= []).push(v)
    else out[k] = v
  }
  return out
}

/** Run `main(argv)`; print an Error's message (not its stack) and exit 1. */
export async function cli(main) {
  try {
    const code = await main(process.argv.slice(2))
    process.exit(code ?? 0)
  } catch (err) {
    console.error(`builder: ${err.message}`)
    process.exit(1)
  }
}
