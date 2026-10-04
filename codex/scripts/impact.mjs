#!/usr/bin/env node
/**
 * impact — what this branch can break, so the deep set runs the tests that can see it and no others.
 *
 *   node <plugin>/scripts/impact.mjs [<test glob>…] [--json]
 *
 * Measured on a fleet day: the deep set ran the whole UI suite and every phase gate — eleven minutes —
 * at the end of every build and again at every verify after a walk fix, for features that touched
 * one screen. The impact of a branch is:
 *
 *  1. the files it changed (against where it left the base branch);
 *  2. the code that reads a SCHEMA field it changed — every spelling of the field (`issueDate`,
 *     `issue_date`, …), so another feature built on that column is tested with this one;
 *  3. everything that imports 1 or 2, at any depth (relative imports, workspace packages by name,
 *     tsconfig path aliases).
 *
 * A test in a gate's glob is selected when it changed, when it imports into the impact, or when an
 * earlier feature changed it in the same commit as a file in the impact — which is how a UI spec,
 * which imports nothing of the app, is tied to the screen it covers. A change the graph cannot see
 * past (a shared harness beside the tests, a runner config, a dependency) selects the whole suite.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

const CODE = /\.(m|c)?[jt]sx?$|\.(vue|svelte|py|rb|go|sql|graphql)$/
const IMPORTABLE = /\.(m|c)?[jt]sx?$|\.(vue|svelte)$/
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
const SCHEMA = /\.prisma$|(^|\/)migrations?\/.*\.sql$|(^|\/)schema\.(sql|rb|graphql)$|\.graphql$/
/** Changes the import graph cannot see past: they reach every test. */
const WHOLE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$|^package\.json$|(^|\/)(playwright|vitest|jest|vite|cypress)\.config\.[cm]?[jt]s$|^tsconfig[^/]*\.json$/
/** Field names too generic to say which code reads THIS table. */
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/
/** File names that say nothing on their own: matched together with their directory. */
const GENERIC = /^(index|main|app|mod|utils?|types?|helpers?|constants?|config)\.[^/]*$/
const STOP = new Set(['id', 'name', 'type', 'data', 'value', 'key', 'status', 'title', 'text', 'kind', 'createdAt', 'updatedAt', 'deletedAt', 'model', 'enum', 'table', 'index', 'unique', 'default', 'column', 'null', 'not', 'primary', 'foreign', 'references', 'constraint', 'add', 'drop', 'alter', 'create', 'rename', 'to', 'set'])
/** Commits wider than this are sweeps (a rename, a format) — they tie everything to everything. */
const WIDE_COMMIT = 40
const HISTORY = 500

/** `issueDate` → every way code writes it: issueDate, IssueDate, issue_date, ISSUE_DATE, issue-date. */
export function spellings(id) {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  const cap = (w) => w[0].toUpperCase() + w.slice(1)
  return [...new Set([words[0] + words.slice(1).map(cap).join(''), words.map(cap).join(''), words.join('_'), words.join('_').toUpperCase(), words.join('-')])]
}
const norm = (id) => id.replace(/[_-]/g, '').toLowerCase()

/** A glob as a RegExp over repo-relative paths: `**` any depth, `*` and `?` within a segment, `{a,b}`. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`
      i = end
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
/** The directory a glob's matches all live under: `apps/web/test/e2e/**\/*.spec.ts` → `apps/web/test/e2e`. */
const globBase = (glob) => {
  const lit = glob.split(/[*?{]/)[0]
  return lit.includes('/') ? lit.slice(0, lit.lastIndexOf('/')) : ''
}

const BLOCK = /^\s*(?:model|enum|type|view)\s+(\w+)/
const unq = (x) => x?.replace(/^["`]|["`]$/g, '')

/**
 * What the branch changed in the schema that EXISTING code can depend on: a field removed, renamed or
 * retyped, a model or table removed or renamed — `{ model, field }`, field null for a whole model. An
 * addition has no readers outside the branch, so it is not here. A Prisma schema's removed lines are
 * placed in their model from the old text; a migration the branch added is read statement by
 * statement (DROP / RENAME / ALTER COLUMN, DROP TABLE, RENAME TO — never ADD or CREATE).
 */
function schemaChanges(root, base, files) {
  const out = []
  for (const f of files) {
    const diff = git(['diff', '-U0', base, '--', f], root)
    if (/\.prisma$/.test(f)) {
      const old = (tryGit(['show', `${base}:${f}`], root) ?? '').split('\n')
      let at = 0
      for (const raw of diff.split('\n')) {
        const h = /^@@ -(\d+)/.exec(raw)
        if (h) {
          at = Number(h[1])
          continue
        }
        if (!raw.startsWith('-') || raw.startsWith('---')) continue
        const line = raw.slice(1)
        const lineNo = at++
        if (/^\s*(\/\/|@@|}|$)/.test(line)) continue
        const block = BLOCK.exec(line)
        if (block) {
          out.push({ model: block[1], field: null })
          continue
        }
        const field = /^\s*(\w+)\s+[A-Za-z]/.exec(line)?.[1]
        if (!field) continue
        let model = null
        for (let i = lineNo - 2; i >= 0 && !model; i--) model = BLOCK.exec(old[i] ?? '')?.[1] ?? null
        out.push({ model, field })
      }
    } else if (/\.sql$/.test(f)) {
      const added = diff
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1).replace(/--.*$/, ''))
        .join('\n')
      const id = '("?[\\w.]+"?)'
      for (const stmt of added.split(';')) {
        const table = unq(new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?${id}`, 'i').exec(stmt)?.[1])?.split('.').pop()
        for (const m of stmt.matchAll(new RegExp(`(?:DROP|ALTER)\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${id}|RENAME\\s+COLUMN\\s+${id}`, 'gi'))) out.push({ model: table ?? null, field: unq(m[1] ?? m[2]) })
        if (table && new RegExp('RENAME\\s+TO\\s', 'i').test(stmt)) out.push({ model: table, field: null })
        for (const m of stmt.matchAll(new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${id}`, 'gi'))) out.push({ model: unq(m[1]).split('.').pop(), field: null })
      }
    }
  }
  const seen = new Map()
  for (const c of out) {
    if (c.field && (c.field.length < 3 || STOP.has(c.field))) continue
    const key = `${norm(c.model ?? '')}.${norm(c.field ?? '')}`
    if (!seen.has(key)) seen.set(key, c)
  }
  return [...seen.values()]
}

/** How many models in these Prisma schemas declare a field of this name — more than one, and a
 *  reader must name the model too. */
function modelsWithField(root, base, prismaFiles, field) {
  const models = new Set()
  for (const f of prismaFiles) {
    for (const text of [tryGit(['show', `${base}:${f}`], root) ?? '', tryGit(['show', `HEAD:${f}`], root) ?? '']) {
      let model = null
      for (const line of text.split('\n')) {
        model = BLOCK.exec(line)?.[1] ?? model
        if (model && new RegExp(`^\\s*${field}\\s+[A-Za-z]`).test(line)) models.add(model)
      }
    }
  }
  return models.size
}
const withPlurals = (xs) => [...new Set(xs.flatMap((x) => [x, `${x}s`]))]

// `import … from` / `export … from`, a bare `import '…'`, and `import('…')` / `require('…')`.
const STATIC_RE = /\b(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*['"]([^'"]+)['"]/g
const BARE_RE = /\bimport\s+['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const DECLARED_RE = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g
const LOCAL_EXPORT_RE = /\bexport\s*\{([^}]*)\}(?!\s*from)/g

/**
 * A clause — `{ a, b as c, type T }`, `* as ns`, `D`, `D, { a }` — as the names it takes from the
 * module: `null` when it takes the module whole (a namespace, a default), `[]` when it takes only
 * types. Each name is `[the name the module exports, the local name]`.
 */
function clauseNames(clause) {
  const c = clause.trim()
  if (!c || /(^|[\s,])\*/.test(c)) return null
  const brace = /\{([^}]*)\}/.exec(c)
  if (c.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '') || !brace) return null
  return brace[1]
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && !/^type\s/.test(x))
    .map((x) => {
      const [from, as] = x.split(/\s+as\s+/)
      return [from.trim(), (as ?? from).trim()]
    })
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

/** The import graph over tracked code: file → the files (or `dir/` of an unresolved package) it imports. */
function importGraph(root, files) {
  const has = (p) => files.has(p)
  const resolveFile = (p) => {
    p = posix.normalize(p)
    if (has(p)) return p
    const bare = p.replace(/\.(m|c)?js$/, '')
    for (const b of [...new Set([p, bare])]) {
      for (const e of EXTS) if (has(b + e)) return b + e
      for (const e of EXTS) if (has(`${b}/index${e}`)) return `${b}/index${e}`
    }
    return null
  }
  // Workspace packages by name → their directory and entry.
  const pkgs = new Map()
  for (const f of files) {
    if (!f.endsWith('package.json') || f === 'package.json') continue
    const j = readJson(join(root, f))
    if (!j?.name) continue
    const dir = dirname(f)
    const exp = typeof j.exports === 'string' ? j.exports : j.exports?.['.']
    const entry = [typeof exp === 'string' ? exp : exp?.import ?? exp?.default ?? exp?.types, j.module, j.main, 'src/index', 'index'].filter(Boolean)
    pkgs.set(j.name, { dir, exports: j.exports && typeof j.exports === 'object' ? j.exports : {}, entry })
  }
  // tsconfig path aliases at the root: `@/*` → `src/*`.
  const aliases = []
  for (const f of files) {
    if (!/^tsconfig[^/]*\.json$/.test(f)) continue
    const co = readJson(join(root, f))?.compilerOptions
    for (const [from, to] of Object.entries(co?.paths ?? {})) aliases.push({ from, to: [].concat(to).map((t) => posix.join(co.baseUrl ?? '.', t)) })
  }
  const resolve = (from, spec) => {
    if (spec.startsWith('.')) return resolveFile(posix.join(dirname(from), spec))
    for (const a of aliases) {
      const star = a.from.endsWith('*')
      const prefix = star ? a.from.slice(0, -1) : a.from
      if (star ? spec.startsWith(prefix) : spec === prefix) {
        for (const t of a.to) {
          const hit = resolveFile(star ? t.replace('*', spec.slice(prefix.length)) : t)
          if (hit) return hit
        }
      }
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    const pkg = pkgs.get(name)
    if (!pkg) return null // an installed dependency: outside the repo
    const sub = spec.slice(name.length).replace(/^\//, '')
    if (!sub) {
      for (const e of pkg.entry) {
        const hit = resolveFile(posix.join(pkg.dir, e))
        if (hit) return hit
      }
    } else {
      const mapped = pkg.exports[`./${sub}`]
      for (const c of [typeof mapped === 'string' ? mapped : mapped?.import ?? mapped?.default, sub, `src/${sub}`].filter(Boolean)) {
        const hit = resolveFile(posix.join(pkg.dir, c))
        if (hit) return hit
      }
    }
    return `${pkg.dir}/` // the package as a whole
  }
  // Pass 1: what each file takes from which module, what it re-exports, and what it declares.
  const parsed = new Map()
  for (const f of files) {
    if (!IMPORTABLE.test(f)) continue
    let text
    try {
      text = readFileSync(join(root, f), 'utf8')
    } catch {
      continue
    }
    const rec = { takes: [], reExports: [], declared: new Set() }
    for (const m of text.matchAll(STATIC_RE)) {
      if (m[2]) continue // `import type` / `export type … from`: no runtime edge — the typecheck gate owns types
      const target = resolve(f, m[4])
      if (!target || target === f) continue
      const names = clauseNames(m[3])
      if (names && !names.length) continue // only type specifiers
      if (m[1] === 'export') {
        const star = /^\*\s+as\s+([\w$]+)/.exec(m[3].trim())
        rec.reExports.push({ target, map: star ? new Map([[star[1], '*']]) : names ? new Map(names.map(([from, as]) => [as, from])) : '*' })
      } else rec.takes.push({ target, names })
    }
    for (const m of [...text.matchAll(BARE_RE), ...text.matchAll(DYNAMIC_RE)]) {
      const target = resolve(f, m[1] ?? m[2])
      if (target && target !== f) rec.takes.push({ target, names: null })
    }
    for (const m of text.matchAll(DECLARED_RE)) rec.declared.add(m[1])
    for (const m of text.matchAll(LOCAL_EXPORT_RE)) for (const x of m[1].split(',')) rec.declared.add(x.trim().split(/\s+as\s+/).pop())
    if (/\bexport\s+default\b/.test(text)) rec.declared.add('default')
    parsed.set(f, rec)
  }
  // The files that really provide `name` when it is taken from `file` — through any barrel's
  // re-exports. [] when nobody declares it (the caller falls back to the module itself).
  const providers = (file, name, seen = new Set()) => {
    const key = `${file}\0${name}`
    const rec = parsed.get(file)
    if (seen.has(key) || !rec) return rec ? [] : [file]
    seen.add(key)
    if (rec.declared.has(name)) return [file]
    for (const re of rec.reExports) {
      if (re.map === '*') {
        if (name === 'default') continue
        const p = providers(re.target, name, seen)
        if (p.length) return p
      } else if (re.map.has(name)) return re.map.get(name) === '*' ? [re.target] : providers(re.target, re.map.get(name), seen)
    }
    return []
  }
  // Pass 2: the edges — straight to the providers of each name taken, or to the module when it is
  // taken whole. A barrel keeps its own edges to what it re-exports, for whoever takes it whole.
  const deps = new Map()
  for (const [f, rec] of parsed) {
    const out = new Set()
    const edge = (target, names) => {
      if (!names) return out.add(target)
      for (const n of names) {
        const p = providers(target, n)
        for (const x of p.length ? p : [target]) if (x !== f) out.add(x)
      }
    }
    for (const t of rec.takes) edge(t.target, t.names?.map(([from]) => from) ?? null)
    for (const re of rec.reExports) edge(re.target, re.map === '*' ? null : [...re.map.values()].filter((v) => v !== '*'))
    deps.set(f, out)
  }
  return deps
}

/**
 * The impact of HEAD (and the working tree) against where it left `baseBranch`. `seeds` maps each
 * file in the impact's core (changed, or reading a changed schema field) to why; `reach(f)` says
 * how f imports into it, or null.
 */
export function impactOf(root, { baseBranch }) {
  const base = git(['merge-base', `refs/heads/${baseBranch}`, 'HEAD'], root).trim()
  const changed = git(['diff', '--name-only', base], root).split('\n').filter(Boolean)
  const files = new Set(git(['ls-files'], root).split('\n').filter(Boolean))
  const code = [...files].filter((f) => CODE.test(f))
  const seeds = new Map(changed.map((f) => [f, 'changed on this branch']))

  // Schema this branch changed under existing readers, and the code that reads it under any spelling.
  const schemaFiles = changed.filter((f) => SCHEMA.test(f))
  const changes = schemaFiles.length ? schemaChanges(root, base, schemaFiles) : []
  const prisma = [...new Set([...schemaFiles, ...[...files].filter((f) => f.endsWith('.prisma'))])].filter((f) => f.endsWith('.prisma'))
  const skipped = []
  const readersFiles = code.filter((f) => !SCHEMA.test(f))
  const grepWords = (words) => (tryGit(['grep', '-l', '-w', '-E', words.join('|'), '--', ...readersFiles], root) ?? '').split('\n').filter(Boolean)
  const labelOf = (c) => (c.field ? `${c.model ? `${c.model}.` : ''}${c.field}` : c.model)
  for (const c of changes) {
    const label = labelOf(c)
    const modelWords = c.model ? withPlurals(spellings(c.model)) : []
    let hits = grepWords(c.field ? spellings(c.field) : modelWords)
    // A field name several models share (`rowId`) says nothing on its own: the reader must name the model.
    if (c.field && c.model && modelsWithField(root, base, prisma, c.field) !== 1) {
      const naming = new Set(grepWords(modelWords))
      hits = hits.filter((h) => naming.has(h))
    }
    if (hits.length > Math.max(40, code.length / 5)) {
      skipped.push(`${label} (read by ${hits.length} files — too common to narrow on)`)
      continue
    }
    for (const h of hits) if (!seeds.has(h)) seeds.set(h, `reads ${label}, which this branch ${c.field ? 'changed' : 'removed or renamed'}`)
  }

  // Reverse import closure: who reaches a seed, and through what.
  const deps = importGraph(root, files)
  const importers = new Map()
  // A package imported by name but not resolved to a file is an edge to `<dir>/`: every file under
  // that directory reaches its importers.
  const dirsOf = (f) => {
    const out = []
    for (let d = dirname(f); d && d !== '.'; d = dirname(d)) out.push(`${d}/`)
    return out
  }
  for (const [f, ds] of deps) for (const d of ds) (importers.get(d) ?? importers.set(d, []).get(d)).push(f)
  // A file nothing imports may still be LOADED by name — a harness page's `<script src="./harness.tsx">`,
  // a spec's `goto('/test/e2e/harness.html')`. Looked up only for such files, on a path boundary
  // (`harness.html` is not `panel-harness.html`); a generic name (`main.tsx`) is matched with its
  // directory. Docs mention everything and load nothing, so they are not namers.
  const namers = (f) => {
    const parts = f.split('/')
    const needle = GENERIC.test(parts[parts.length - 1]) && parts.length > 1 ? parts.slice(-2).join('/') : parts[parts.length - 1]
    const out = tryGit(['grep', '-l', '-E', `(^|[^[:alnum:]_.-])${needle.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&')}`, '--', '.', ':!*.md', ':!*.mdx'], root)
    return (out ?? '').split('\n').filter((x) => x && x !== f)
  }
  const named = new Set() // files found only by name: nothing imports them and nothing names them
  const importersOf = (f) => {
    // A test or a runner config ends a chain: what imports or names IT is not affected by it (a
    // spec's comment naming another spec, a config naming the server it starts).
    if (TEST.test(f) || (WHOLE.test(f) && !seeds.has(f))) return []
    const imps = [...(importers.get(f) ?? []), ...dirsOf(f).flatMap((d) => importers.get(d) ?? [])]
    if (imps.length || /\.md$/.test(f)) return imps
    const byName = namers(f)
    if (!byName.length) named.add(f)
    return byName
  }
  const via = new Map() // file → the next hop toward a seed
  const queue = [...seeds.keys()]
  for (const s of seeds.keys()) via.set(s, null)
  while (queue.length) {
    const cur = queue.shift()
    for (const imp of importersOf(cur)) {
      if (via.has(imp)) continue
      via.set(imp, cur)
      queue.push(imp)
    }
  }
  const reach = (f) => {
    if (!via.has(f)) return null
    const chain = []
    for (let x = via.get(f); x !== null; x = via.get(x)) chain.push(x)
    return chain
  }
  // Direct importers of the seeds: the ring a co-changed test may belong to.
  const ring = new Set([...seeds.keys()])
  for (const [f, next] of via) if (next !== null && seeds.has(next)) ring.add(f)

  let history = null
  const commits = () => {
    if (history) return history
    history = new Map()
    const log = tryGit(['log', '--no-merges', '--name-only', `--format=%x00%h%x09%p%x09%s`, '-n', String(HISTORY), base], root) ?? ''
    for (const block of log.split('\0').filter(Boolean)) {
      const [head, ...rest] = block.split('\n')
      const [sha, parents, subject] = head.split('\t')
      const fs = rest.filter(Boolean)
      // A root commit adds the whole project at once, like a sweep: it ties nothing to anything.
      if (!parents || fs.length > WIDE_COMMIT) continue
      for (const f of fs) (history.get(f) ?? history.set(f, []).get(f)).push({ sha, subject, files: fs })
    }
    return history
  }
  return { base, changed, files, seeds, ring, reach, commits, loose: named, schema: { files: schemaFiles, changes: changes.map(labelOf), skipped } }
}

/**
 * The tests a gate glob should run for this impact: `{ mode: 'whole' | 'some' | 'none', tests,
 * why: { test: reason }, reason }`. `whole` names the change that forced it.
 */
export function scopeTests(impact, glob) {
  const re = globToRegExp(glob)
  const base = globBase(glob)
  // A change beside the tests that nothing imports or names (a fixture read by a pattern, a setup
  // file the runner loads), a runner config or a dependency: the graph can't see who it reaches.
  const forcing = impact.changed.find((f) => !re.test(f) && ((base && f.startsWith(`${base}/`) && impact.loose.has(f)) || WHOLE.test(f)))
  if (forcing) return { mode: 'whole', tests: [], why: {}, reason: `${forcing} changed — the import graph can't tell which tests it reaches` }
  const why = {}
  for (const t of [...impact.files].filter((f) => re.test(f)).sort()) {
    if (impact.seeds.has(t)) {
      why[t] = impact.seeds.get(t)
      continue
    }
    const chain = impact.reach(t)
    if (chain) {
      const seed = chain[chain.length - 1]
      why[t] = `reaches ${chain.join(' → ')}${impact.seeds.get(seed) !== 'changed on this branch' ? ` (${impact.seeds.get(seed)})` : ''}`
      continue
    }
    for (const c of impact.commits().get(t) ?? []) {
      const hit = c.files.find((f) => f !== t && impact.ring.has(f))
      if (hit) {
        why[t] = `changed with ${hit} in ${c.sha} "${c.subject}"`
        break
      }
    }
  }
  const tests = Object.keys(why)
  return tests.length ? { mode: 'some', tests, why, reason: null } : { mode: 'none', tests: [], why: {}, reason: 'nothing this branch touches reaches these tests' }
}

/** The report a human or verify reads: the impact, then each glob's selection with its reasons. */
export function renderImpact(impact, globs = []) {
  const lines = [`impact against ${impact.base.slice(0, 7)}`, `changed on this branch (${impact.changed.length}):`, ...impact.changed.map((f) => `  ${f}`)]
  if (impact.schema.changes.length) lines.push(`schema changed under existing readers: ${impact.schema.changes.join(', ')}`)
  for (const s of impact.schema.skipped) lines.push(`  not narrowed: ${s}`)
  const readers = [...impact.seeds].filter(([, why]) => why !== 'changed on this branch')
  if (readers.length) lines.push(`code reading those fields (${readers.length}):`, ...readers.map(([f, why]) => `  ${f} — ${why}`))
  for (const g of globs) {
    const s = scopeTests(impact, g)
    lines.push('', `${g}: ${s.mode === 'some' ? `${s.tests.length} test file(s)` : s.mode === 'whole' ? 'the whole suite' : 'none'}${s.reason ? ` — ${s.reason}` : ''}`)
    for (const t of s.tests) lines.push(`  ${t} — ${s.why[t]}`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { requireConfig } = await import('./config.mjs')
  const CFG = requireConfig()
  const argv = process.argv.slice(2)
  const globs = argv.filter((a) => !a.startsWith('--'))
  const impact = impactOf(CFG.root, { baseBranch: CFG.baseBranch })
  if (argv.includes('--json')) {
    const out = { base: impact.base, changed: impact.changed, schema: impact.schema, seeds: Object.fromEntries(impact.seeds), scopes: Object.fromEntries(globs.map((g) => [g, scopeTests(impact, g)])) }
    console.log(JSON.stringify(out, null, 2))
  } else process.stdout.write(renderImpact(impact, globs))
}
