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

/** One gate line: `<command>   # <what it proves> [@delta] [@known-red] [@scoped <glob>] [@typecheck] [@walk]`. */
const parseLine = (raw) => {
  const line = raw.trimEnd()
  if (!line.trim() || /^\s*#/.test(line)) return null
  const m = COMMENT.exec(line)
  const cmd = (m ? line.slice(0, m.index) : line).trim()
  const note = (m ? (m[1] ?? m[2] ?? '') : '').trim()
  if (!cmd) return null
  const scope = /@scoped\s+(\S+)/.exec(note)?.[1]
  // @typecheck: the line type-checks the app — the floor the test plan keeps when nothing else runs.
  const typecheck = /@typecheck\b/.test(note)
  // @walk: the line needs the running walk env (an e2e suite) — it gets agent_walk.env and runs only
  // while the fleet's walk env is up (gateEnv below). Every other line runs with the test env.
  const walk = /@walk\b/.test(note)
  // @local: an e2e-looking line that is safe to run as written under the fleet (its own stack).
  const local = /@local\b/.test(note)
  return {
    cmd,
    note: note.replace(/@scoped\s+\S+|@delta|@known-red|@typecheck|@walk|@local/g, '').replace(/\s{2,}/g, ' ').trim(),
    delta: /@delta\b/.test(note),
    knownRed: /@known-red\b/.test(note),
    ...(scope && { scope }),
    ...(typecheck && { typecheck }),
    ...(walk && { walk }),
    ...(local && { local }),
  }
}

/** A command that drives a running app: a browser e2e runner, or a script named e2e. */
const E2E = /\b(playwright|cypress|testcafe|webdriverio|wdio|selenium|puppeteer|nightwatch)\b|(^|[\s:/_-])e2e\b/i
export const looksE2E = (cmd) => E2E.test(cmd ?? '')

/**
 * Under the fleet, an e2e suite not tagged `@walk` has no env of its own: the walk env's values are
 * taken from it (gateEnv), so it falls back to its own defaults — usually the human's dev stack on
 * localhost. It is not run there: reported unverified, with the fix. `@local` says the line brings
 * its own stack and runs as written. Outside the fleet nothing changes.
 */
export const unwalkedE2E = (g, env = process.env) => Boolean(env.BUILDER_LANE) && !g.walk && !g.local && looksE2E(g.cmd)

/**
 * The environment one gate line runs with, from the lane the fleet says it is in (BUILDER_LANE):
 * - the WALK lane hands its run agent_walk.env — the walk env's ports and database. Only a `@walk`
 *   line keeps it; every other line gets back what the build lane would have (BUILDER_GATE_ENV: a
 *   JSON map of each walk-env key to its build-lane value, null = unset), so a unit or integration
 *   suite never runs against the walk env's database.
 * - the BUILD lane has no walk env: a `@walk` line is skipped there (→ null), verify runs it.
 * - outside the fleet nothing changes: every line, `@walk` or not, gets the env as it is.
 */
export function gateEnv(g, env = process.env) {
  if (env.BUILDER_LANE === 'build') return g.walk ? null : env
  if (env.BUILDER_LANE !== 'walk' || g.walk) return env
  let back = {}
  try {
    back = JSON.parse(env.BUILDER_GATE_ENV || '{}')
  } catch {}
  const out = { ...env }
  for (const [k, v] of Object.entries(back)) {
    if (v == null) delete out[k]
    else out[k] = v
  }
  return out
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

/** Tracked files whose working copy differs from HEAD — the files a gate would run on that HEAD's
 *  memo doesn't describe. (A change staged and then reverted in the worktree is not listed: what runs
 *  is HEAD's content.) `--` keeps an untracked file named HEAD from making the revision ambiguous. */
export const dirtyPaths = (root) => git(['diff', '--name-only', 'HEAD', '--'], root).split('\n').filter(Boolean)

/** Paths for one line of output: the first `max`, then how many more. */
export const fmtPaths = (paths, max = 5) => paths.slice(0, max).join(', ') + (paths.length > max ? ` +${paths.length - max} more` : '')

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
  // Before the command: a gate line may `tee` into .builder/gates/ itself, and the directory has
  // to be there on the first run, not after it.
  if (logFile) mkdirSync(dirname(logFile), { recursive: true })
  if (cwd) mkdirSync(join(cwd, '.builder', 'gates'), { recursive: true })
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs || undefined })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (logFile) writeFileSync(logFile, `$ ${cmd}\n${output}\n[exit ${r.status ?? 'signal ' + r.signal}]\n`)
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
  // `cd <dir> && …` runs the tests from <dir> (a package whose dotenv path is relative), so the
  // files are named relative to it, and only files under it qualify.
  const cd = /^cd\s+(\S+)\s*&&\s*/.exec(cmd)
  const dir = cd ? strip(cd[1]) : ''
  const changed = git(['diff', '--name-only', base, 'HEAD', '--', strip(appPath)], root)
    .split('\n')
    .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|test_[^/]*\.py$/.test(f))
    .filter((f) => !dir || f.startsWith(`${dir}/`))
    .map((f) => (dir ? f.slice(dir.length + 1) : f))
  if (!changed.length) return null
  return cmd.replace(/\S*<[^>]+>\S*/g, changed.join(' ')).replace(/\s{2,}/g, ' ')
}

const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`

/**
 * A `@scoped <glob>` line for this branch's impact (impact.mjs): `{tests}` becomes the test files the
 * impact reaches — or nothing, for the whole suite — and a line with no `{tests}` runs whole when
 * the impact reaches its glob at all. `{ cmd, whole, say }`, or `{ skip }` when nothing reaches it.
 * With no `scope` (a baseline run) every scoped line is the whole suite.
 */
function scopeLine(g, scope) {
  const whole = g.cmd.replace(/\s*\{tests\}/g, '')
  if (!scope) return { cmd: whole, whole }
  const s = scope(g.scope)
  if (s.mode === 'none') return { skip: `~ ${g.cmd} — ${s.reason}; not run` }
  if (s.mode === 'whole' || !g.cmd.includes('{tests}')) return { cmd: whole, whole, say: `  ${g.cmd} → the whole suite — ${s.reason ?? `this branch reaches ${s.tests.length} file(s) under ${g.scope}`}` }
  // `cd <dir> && …` runs from <dir>: the files are named relative to it, and only files under it count.
  const cd = /^cd\s+(\S+)\s*&&\s*/.exec(g.cmd)
  const dir = cd ? cd[1].replace(/^\.\//, '').replace(/\/+$/, '') : ''
  const tests = s.tests.filter((t) => !dir || t.startsWith(`${dir}/`)).map((t) => (dir ? t.slice(dir.length + 1) : t))
  if (!tests.length) return { skip: `~ ${g.cmd} — nothing this branch touches reaches the tests under ${dir}; not run` }
  return { cmd: g.cmd.replace('{tests}', tests.map(shq).join(' ')), whole, subset: true, say: `  ${g.cmd} → ${tests.length} test file(s) this branch reaches (the impact report says why each)` }
}

/**
 * Run a gate set. `flaky` is the config's list — `{ match, rerun? }` — and `baseline` maps a @delta
 * command to the count it must not exceed (null when unknown: the first measurement then becomes the
 * baseline, and the line says so). Returns `{ exit, lines, red, newBaselines, durations, partial }`:
 * `durations` maps each line that ran (as written) to its ms, re-runs included; `partial` is true
 * when a @scoped line ran a subset or was skipped — the set then says nothing about the whole
 * suite's time. `log` gets each line as it happens.
 */
export function runGateSet(gates, { cwd, env, logDir, flaky = [], baseline = {}, expand = null, scope = null, quote = null, log = () => {} }) {
  const lines = []
  const say = (s) => {
    lines.push(s)
    log(s)
  }
  let red = 0
  let partial = false
  const newBaselines = {}
  const durations = {}
  const unverified = []
  const greens = [] // lines that ran and passed — gate.mjs remembers each one's head (lines.json)
  const quoted = []
  gates.forEach((g0, i) => {
    // A line whose last green run still stands — nothing it covers changed since (gate.mjs decides,
    // with the evidence it says) — is quoted, not run.
    const q = quote?.(g0)
    if (q) {
      quoted.push(g0.cmd)
      say(`⏩ ${g0.cmd} — ${q}`)
      return
    }
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
    let scoped = null
    if (g0.scope) {
      scoped = scopeLine(g0, scope)
      if (scoped.skip) {
        partial = true
        say(scoped.skip)
        return
      }
      if (scoped.subset) partial = true
      if (scoped.say) say(scoped.say)
      g = { ...g0, cmd: scoped.cmd }
    }
    if (unwalkedE2E(g0, env)) {
      partial = true
      unverified.push(g0.cmd)
      say(`? ${g0.cmd} — an e2e suite without @walk: not run, so it can't hit your dev stack — unverified. Tag it @walk to run it against the walk env (or @local if it starts its own)`)
      return
    }
    const lineEnv = gateEnv(g0, env)
    if (lineEnv === null) {
      partial = true
      say(`~ ${g0.cmd} — @walk: needs the running walk env; verify runs it in the walk lane`)
      return
    }
    let r = runCommand(g.cmd, { cwd, env: lineEnv, logFile })
    durations[g0.cmd] = r.ms
    const tail = (n) => r.output.trim().split('\n').slice(-n).join('\n    ')
    if (g.delta) {
      let value = lastInt(r.stdout)
      // A subset's count can't be held against a whole-suite baseline: a known-red test in the subset
      // looks like a regression, and a new failure could hide under the baseline. A clean subset is
      // clean; any failure in it is judged on the whole suite.
      if (scoped?.subset && value !== null && value > 0) {
        say(`  ${value} in the subset — re-running the whole suite to judge it against the baseline`)
        r = runCommand(scoped.whole, { cwd, env: lineEnv, logFile: logFile ? logFile.replace(/\.log$/, '-whole.log') : null })
        durations[g0.cmd] += r.ms
        g = { ...g0, cmd: scoped.whole }
        scoped = { ...scoped, subset: false } // a whole-suite count now: it can stand as a baseline
        value = lastInt(r.stdout)
      }
      if (value === null) {
        red++
        say(`✗ ${g.cmd} — @delta but printed no number (${fmt(r.ms)})\n    ${tail(5)}`)
        return
      }
      const key = g0.scope ? g0.cmd : g.cmd // a scoped line's baseline is the whole suite, under the line as written
      const base = baseline[key]
      if (base == null && scoped?.subset) say(`✓ ${g.cmd} → ${value} (no baseline yet — a subset is not recorded as one; gate.mjs --baseline measures the whole suite, ${fmt(r.ms)})`)
      else if (base == null) {
        newBaselines[key] = value
        say(`✓ ${g.cmd} → ${value} (no baseline yet — this measurement is now the baseline, ${fmt(r.ms)})`)
      } else if (value <= base) say(`✓ ${g.cmd} → ${value} (baseline ${base}, ${fmt(r.ms)})`)
      else {
        red++
        say(`✗ ${g.cmd} → ${value} exceeds baseline ${base} (${fmt(r.ms)})`)
      }
      return
    }
    if (r.exit === 0) {
      greens.push(g0.cmd)
      say(`✓ ${g.cmd} (${fmt(r.ms)})`)
      return
    }
    if (g.knownRed) {
      say(`~ ${g.cmd} exit ${r.exit} — KNOWN-RED per the config, not counted (${fmt(r.ms)})\n    ${tail(3)}`)
      return
    }
    const hit = flaky.find((f) => matcher(f.match).test(r.output))
    if (hit) {
      const again = runCommand(hit.rerun || g.cmd, { cwd, env: lineEnv, logFile: logFile ? logFile.replace(/\.log$/, '-rerun.log') : null })
      durations[g0.cmd] += again.ms
      if (again.exit === 0) {
        greens.push(g0.cmd)
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
  return { exit: red ? 1 : 0, lines, red, newBaselines, durations, partial, unverified, greens, quoted }
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

// ---- durations -----------------------------------------------------------------------------

/**
 * How long each app's whole fast set took on its last green run — `{ <app>: { total, commands:
 * { <cmd>: ms }, at } }` — so the test plan can say what a slice costs. Written only for a green,
 * run (not quoted), whole set: a subset or a --typecheck run would understate it.
 */
export const durationsPath = (root) => join(root, '.builder', 'gates', 'durations.json')

export function readDurations(root) {
  const p = durationsPath(root)
  if (!existsSync(p)) return {}
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {}
  } catch {
    return {}
  }
}

export function writeDurations(root, app, { total, commands }) {
  const dir = join(root, '.builder')
  mkdirSync(join(dir, 'gates'), { recursive: true })
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
  const all = { ...readDurations(root), [app]: { total, commands, at: new Date().toISOString() } }
  writeFileSync(durationsPath(root), JSON.stringify(all, null, 2) + '\n')
}

// ---- per-line memo -------------------------------------------------------------------------

/**
 * Each gate line's last green run: `{ <cmd as written>: { head, when } }` in .builder/gates/lines.json
 * (per worktree). A set's memo is all-or-nothing over its whole input tree, so one fix anywhere re-runs
 * every line; this lets a line stand on its own evidence — gate.mjs quotes it when nothing it covers
 * changed after `head`.
 */
export const lineMemoPath = (root) => join(root, '.builder', 'gates', 'lines.json')
export function readLineMemo(root) {
  try {
    const d = JSON.parse(readFileSync(lineMemoPath(root), 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {}
  } catch {
    return {}
  }
}
export function writeLineMemo(root, { greens = [], reds = [] }, head) {
  const all = readLineMemo(root)
  const when = new Date().toISOString()
  for (const cmd of greens) all[cmd] = { head, when }
  for (const cmd of reds) delete all[cmd]
  mkdirSync(join(root, '.builder', 'gates'), { recursive: true })
  if (!existsSync(join(root, '.builder', '.gitignore'))) writeFileSync(join(root, '.builder', '.gitignore'), '*\n')
  writeFileSync(lineMemoPath(root), JSON.stringify(all, null, 2) + '\n')
}

/**
 * Whether a line's green run at `memo.head` still stands at HEAD — the evidence as one line, or null
 * (run it). Never for a line that judges a count (@delta), runs known debt, needs the running app
 * (@walk) or names changed files (`<…>`); never across a rewrite (head not an ancestor) or a dirty
 * tree. It stands when every file changed since is outside the set's inputs (`exclude`: the registry,
 * other apps), or — for a @scoped line — when the import graph says none of them reaches its tests
 * (`reaches(glob, since)` → scopeTests' mode). A line with neither proof runs.
 */
export function lineQuote(g, memo, { changedSince, exclude = [], reaches = null }) {
  if (!memo?.head || g.delta || g.knownRed || g.walk || /<[^>]+>/.test(g.cmd)) return null
  const changed = changedSince(memo.head)
  if (changed == null) return null
  const at = `green at ${memo.head.slice(0, 7)} (${memo.when})`
  if (!changed.length) return `${at}; nothing changed since — quoted, not re-run`
  const inside = (f) => !exclude.some((p) => { const d = p.replace(/\/+$/, ''); return f === d || f.startsWith(`${d}/`) })
  const relevant = changed.filter(inside)
  if (!relevant.length) return `${at}; changed since: ${fmtPaths(changed)} — none is this set's input — quoted, not re-run`
  if (g.scope && reaches && reaches(g.scope, memo.head) === 'none') return `${at}; changed since: ${fmtPaths(relevant)} — none reaches ${g.scope} (.builder/gates/impact.md) — quoted, not re-run`
  return null
}
