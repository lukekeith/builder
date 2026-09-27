/**
 * The gate runner's decisions, kept free of the CLI so they can be tested directly: how the
 * config's §Quality gates blocks are read, what an app's gate INPUTS hash to, and what one run of a
 * gate set means. gate.mjs is the command; this module is what it does.
 *
 * WHY A MEMO. Measured on one fleet day: the same server suite ran ~14 times per feature — per task
 * by the implementer, at each phase close, again when the last phase signed, again in verify's deep
 * set, again after the target branch was merged in. Each run was 2–10 minutes; test execution was
 * ~60% of the wall-clock, and most of it re-proved a tree nothing had touched. The iron law (no
 * completion claim without fresh evidence) is about the MODEL remembering a result; a run recorded
 * against a content hash of the gate's inputs is evidence, not memory. So a gate set whose inputs
 * are byte-identical to the last GREEN run is quoted — with the sha and time it ran on — and a red
 * result is never quoted: red always runs again.
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'

const COMMENT = /\s{2,}#(.*)$|\s+#\s(.*)$/

/** One gate line: `<command>   # <what it proves> [@delta] [@known-red]`. */
const parseLine = (raw) => {
  const line = raw.trimEnd()
  if (!line.trim() || /^\s*#/.test(line)) return null
  const m = COMMENT.exec(line)
  const cmd = (m ? line.slice(0, m.index) : line).trim()
  const note = (m ? (m[1] ?? m[2] ?? '') : '').trim()
  if (!cmd) return null
  return {
    cmd,
    note: note.replace(/@delta|@known-red/g, '').replace(/\s{2,}/g, ' ').trim(),
    delta: /@delta\b/.test(note),
    knownRed: /@known-red\b/.test(note),
  }
}

/**
 * The config body's `## Quality gates` section → `{ fast: { <app>: [gate] }, deep: [gate] }`. A
 * `### <app> — fast` heading (any dash) opens that app's fast set; a heading starting `Deep set`
 * opens the deep set. Each takes the FIRST fenced code block under it; prose is ignored. Anything
 * the section does not have is `{}` / `[]`, never undefined.
 */
export function parseGates(body) {
  const out = { fast: {}, deep: [] }
  const lines = (body ?? '').split('\n')
  const start = lines.findIndex((l) => /^##\s+Quality gates\b/i.test(l))
  if (start < 0) return out
  let target = null
  let fence = false
  let taken = false // this heading's first block already read
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l) && !fence) break
    const h = /^###\s+(.*)$/.exec(l)
    if (h && !fence) {
      const title = h[1].replace(/[`*]/g, '').trim()
      const fast = /^(.*?)\s+[—–-]+\s+fast\b/i.exec(title)
      if (fast) {
        target = out.fast[fast[1].trim()] ??= []
      } else if (/^deep set\b/i.test(title)) target = out.deep
      else target = null
      taken = false
      continue
    }
    if (/^\s*```/.test(l)) {
      if (fence) taken = true
      fence = !fence
      continue
    }
    if (fence && target && !taken) {
      const g = parseLine(l)
      if (g) target.push(g)
    }
  }
  return out
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const strip = (p) => p.replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * The lines that describe an app's gate INPUTS at HEAD: every tracked path's blob/tree hash, except
 * the paths that belong to OTHER apps and the feature registry (docs never turn a gate red). Shared
 * code — a `packages/db` no app owns, the lockfile, the root config — stays in, so a change there
 * invalidates every app's memo, which is right. Descends only as far as it must to carve out an
 * excluded path, so a monorepo's `apps/` tree is one line unless it holds another app.
 */
export function inputLines(root, { include = null, exclude = [] } = {}) {
  const ex = exclude.map(strip).filter(Boolean)
  const lines = []
  const walk = (prefix) => {
    const out = git(['ls-tree', 'HEAD', prefix ? `${prefix}/` : '.'], root)
    for (const row of out.split('\n')) {
      if (!row) continue
      const m = /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/.exec(row)
      if (!m) continue
      const [, type, hash, path] = m
      if (ex.includes(path)) continue
      if (type === 'tree' && ex.some((e) => e.startsWith(`${path}/`))) walk(path)
      else lines.push(`${path} ${hash}`)
    }
  }
  if (include) {
    // A single path's tree: the app itself, when the caller only wants that.
    try {
      lines.push(`${strip(include)} ${git(['rev-parse', `HEAD:${strip(include)}`], root)}`)
    } catch {
      lines.push(`${strip(include)} -`)
    }
  } else walk('')
  return lines.sort()
}

/** sha1 over the input lines plus the gate commands, so a changed gate command re-runs too. */
export const inputsHash = (lines, gates) =>
  createHash('sha1')
    .update(lines.join('\n'))
    .update('\n--\n')
    .update(gates.map((g) => g.cmd).join('\n'))
    .digest('hex')

/** True when tracked files have local modifications — a memo cannot describe a dirty tree. */
export const isDirty = (root) => git(['status', '--porcelain', '--untracked-files=no'], root) !== ''

/** The main checkout's root — this root, unless it is a worktree of another one. */
export function mainRoot(root) {
  const common = git(['rev-parse', '--git-common-dir'], root)
  return dirname(isAbsolute(common) ? common : join(root, common))
}

export const lastInt = (s) => {
  const m = String(s ?? '').match(/-?\d+/g)
  return m ? Number(m[m.length - 1]) : null
}

const fmt = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`)

/** Run one shell command; its output is returned whole and written to `logFile` when given. */
export function runCommand(cmd, { cwd, env = process.env, logFile = null, timeoutMs = 0 } = {}) {
  const t0 = Date.now()
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs || undefined })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true })
    writeFileSync(logFile, `$ ${cmd}\n${output}\n[exit ${r.status ?? 'signal ' + r.signal}]\n`)
  }
  return { exit: r.status === null ? 1 : r.status, stdout: r.stdout ?? '', output, ms: Date.now() - t0 }
}

const matcher = (pattern) => {
  try {
    return new RegExp(pattern)
  } catch {
    return { test: (s) => s.includes(pattern) }
  }
}

/**
 * A gate line written with `<…>` placeholders — `npx tsx --test packages/api/src/<path>/<file>.test.ts`
 * — means "the test files this work touched". The runner resolves it: every test file under the
 * app's path that this branch changed since it left the base branch. Returns the expanded command,
 * or null when nothing qualifies (the line is then reported as skipped, not failed). The placeholder
 * TOKEN (the whitespace-delimited word carrying `<`) is what gets replaced, so the rest of the line
 * — its runner, its flags — stays as written.
 */
export function expandPlaceholders(cmd, { root, appPath, baseBranch }) {
  if (!/<[^>]+>/.test(cmd)) return cmd
  let base
  try {
    base = git(['merge-base', `refs/heads/${baseBranch}`, 'HEAD'], root)
  } catch {
    return null
  }
  const changed = git(['diff', '--name-only', base, 'HEAD', '--', strip(appPath)], root)
    .split('\n')
    .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|test_[^/]*\.py$/.test(f))
  if (!changed.length) return null
  return cmd.replace(/\S*<[^>]+>\S*/g, changed.join(' ')).replace(/\s{2,}/g, ' ')
}

/**
 * Run a gate set. `flaky` is the config's list — `{ match, rerun? }` — and `baseline` maps a @delta
 * command to the count it must not exceed (null when unknown: the first measurement then becomes the
 * baseline, and the line says so). Returns `{ exit, lines }`; `log` gets each line as it happens.
 */
export function runGateSet(gates, { cwd, env, logDir, flaky = [], baseline = {}, expand = null, log = () => {} }) {
  const lines = []
  const say = (s) => {
    lines.push(s)
    log(s)
  }
  let red = 0
  const newBaselines = {}
  gates.forEach((g0, i) => {
    const logFile = logDir ? join(logDir, `${String(i + 1).padStart(2, '0')}.log`) : null
    let g = g0
    if (expand && /<[^>]+>/.test(g0.cmd)) {
      const cmd = expandPlaceholders(g0.cmd, expand)
      if (cmd === null) {
        say(`~ ${g0.cmd} — no changed test files under this app since ${expand.baseBranch}; nothing to run`)
        return
      }
      say(`  ${g0.cmd} → ${cmd}`)
      g = { ...g0, cmd }
    }
    const r = runCommand(g.cmd, { cwd, env, logFile })
    const tail = (n) => r.output.trim().split('\n').slice(-n).join('\n    ')
    if (g.delta) {
      const value = lastInt(r.stdout)
      if (value === null) {
        red++
        say(`✗ ${g.cmd} — @delta but printed no number (${fmt(r.ms)})\n    ${tail(5)}`)
        return
      }
      const base = baseline[g.cmd]
      if (base == null) {
        newBaselines[g.cmd] = value
        say(`✓ ${g.cmd} → ${value} (no baseline yet — this measurement is now the baseline, ${fmt(r.ms)})`)
      } else if (value <= base) say(`✓ ${g.cmd} → ${value} (baseline ${base}, ${fmt(r.ms)})`)
      else {
        red++
        say(`✗ ${g.cmd} → ${value} exceeds baseline ${base} (${fmt(r.ms)})`)
      }
      return
    }
    if (r.exit === 0) {
      say(`✓ ${g.cmd} (${fmt(r.ms)})`)
      return
    }
    if (g.knownRed) {
      say(`~ ${g.cmd} exit ${r.exit} — KNOWN-RED per the config, not counted (${fmt(r.ms)})\n    ${tail(3)}`)
      return
    }
    const hit = flaky.find((f) => matcher(f.match).test(r.output))
    if (hit) {
      const again = runCommand(hit.rerun || g.cmd, { cwd, env, logFile: logFile ? logFile.replace(/\.log$/, '-rerun.log') : null })
      if (again.exit === 0) {
        say(`~ ${g.cmd} exit ${r.exit}, matched flaky "${hit.match}"; ${hit.rerun ? `re-ran \`${hit.rerun}\`` : 're-ran'}: passed (${fmt(r.ms + again.ms)})`)
        return
      }
      red++
      say(`✗ ${g.cmd} exit ${r.exit}; matched flaky "${hit.match}" but the re-run failed too (exit ${again.exit}, ${fmt(r.ms + again.ms)})\n    ${again.output.trim().split('\n').slice(-8).join('\n    ')}`)
      return
    }
    red++
    say(`✗ ${g.cmd} exit ${r.exit} (${fmt(r.ms)})${logFile ? ` — ${logFile}` : ''}\n    ${tail(8)}`)
  })
  return { exit: red ? 1 : 0, lines, red, newBaselines }
}

// ---- the memo ------------------------------------------------------------------------------

export const memoPath = (root, key) => join(root, '.builder', 'gates', `${key}.json`)

export function readMemo(root, key) {
  const p = memoPath(root, key)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeMemo(root, key, memo) {
  const dir = join(root, '.builder')
  mkdirSync(join(dir, 'gates'), { recursive: true })
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
  writeFileSync(memoPath(root, key), JSON.stringify(memo, null, 2) + '\n')
}

export const baselinePath = (root) => join(root, '.builder', 'gates', 'baseline.json')

export function readBaseline(root) {
  const p = baselinePath(root)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')).values ?? {}
  } catch {
    return {}
  }
}

export function writeBaseline(root, values, head) {
  const dir = join(root, '.builder')
  mkdirSync(join(dir, 'gates'), { recursive: true })
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
  writeFileSync(baselinePath(root), JSON.stringify({ head, when: new Date().toISOString(), values }, null, 2) + '\n')
}
