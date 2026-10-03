# `/builder:statusline` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A toggle skill that puts a live, one-line summary of running builder work (fleet, in-chat builds, gates) under the user's existing Claude Code status line, and restores their setting on `off`.

**Architecture:** Four scripts with one job each: `gate.mjs` drops a running marker; `statusline.mjs` renders one line from files builder already writes; `statusline-launcher.mjs` (copied to a stable path in the Claude config dir) runs the user's previous status line and then the renderer of whichever builder copy applies; `statusline-install.mjs` is the only code that edits `settings.json`. A thin skill drives the installer.

**Tech Stack:** Node ≥18 ESM, `node:test`, no dependencies.

**Spec:** `docs/specs/2026-10-02-statusline-design.md`

## Global Constraints

- No dependencies; Node built-ins only. ESM `.mjs`, two-space indent, no semicolons — match `scripts/*.mjs`.
- Renderer and launcher **never print an error and always exit 0**; the installer fails loud (exit 1 + a message).
- Renderer spawns **no processes** (no `git`, no `claude`).
- Launcher timeouts: wrapped command **1000 ms**, renderer **500 ms**. `refreshInterval`: **2**.
- Fresh-ledger window: **5 min**. Default width: `--width` ?? `$COLUMNS` ?? **120**.
- Config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Launcher at `<config>/builder/statusline.mjs`; previous setting at `<config>/builder/statusline.prev.json`.
- Launcher imports nothing from the plugin (it outlives versions) and names no marketplace or repo (vendored copies are leak-scanned).
- Tests never touch the real config dir: every test sets `CLAUDE_CONFIG_DIR` to a temp dir.
- Release **4.4.0** (minor — a new skill): `plugin.json` and the newest `## x.y.z` in CHANGELOG must agree (a test enforces it).

## Review Focus

1. **A user with no previous status line** turns it on then off — expected: the `statusLine` key is gone again, not `null`. (Task 4 test.)
2. **`on` run twice** (or after an update) — expected: the original GSD command is still the one saved, never builder's own. (Task 4 test.)
3. **A stale fleet** — `fleet.json` with rows but the fleet process is gone — expected: no fleet segment. (Task 2 test.)
4. **The wrapped status line hangs** — expected: builder's line still prints, the launcher returns within ~1.5 s. (Task 3 test.)
5. **The session is inside a fleet worktree** (`.git` is a file) — expected: the main checkout's fleet is shown. (Task 2 test.)

---

### Task 1: `gate.mjs` writes a running marker

**Files:**
- Modify: `scripts/gate.mjs` (imports at top; inside the `for (const set of sets)` loop before `runGateSet`)
- Test: `scripts/test/gates-core.test.mjs` (append)

**Interfaces:**
- Produces: `<ROOT>/.builder/gates/running.json` = `{ "sets": string, "pid": number, "startedAt": ISO string }` while a set is running (not when quoted); removed on process exit.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/gates-core.test.mjs` (uses its existing `configured`, `run`, `tmpdir`, `mkdtempSync`, `existsSync`, `readFileSync`):

```js
test('gate.mjs marks a running set in .builder/gates/running.json and removes it on exit', () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'gates-out-')), 'seen.txt')
  const root = configured(`### server — fast\n\n\`\`\`\ncat .builder/gates/running.json >> ${seen}   # x\n\`\`\`\n\n### web — fast\n\n\`\`\`\necho ok   # x\n\`\`\`\n`)
  const r = run(root, 'server', '--force')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const marker = JSON.parse(readFileSync(seen, 'utf8'))
  assert.equal(marker.sets, 'server — fast')
  assert.ok(marker.pid > 0)
  assert.ok(!Number.isNaN(Date.parse(marker.startedAt)))
  assert.ok(!existsSync(join(root, '.builder/gates/running.json')), 'removed when the gate exits')
})
```

- [ ] **Step 2: Run it — expect FAIL** (`cat` finds no file, `seen.txt` missing → ENOENT)

Run: `node --test --test-name-pattern="running set" scripts/test/gates-core.test.mjs`

- [ ] **Step 3: Implement** — in `scripts/gate.mjs` replace the two existing imports
`import { join } from 'node:path'` and `import { writeFileSync, mkdirSync } from 'node:fs'` with:

```js
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
```

Then add, just above `for (const set of sets) {`:

```js
// While a set runs, .builder/gates/running.json says so — the status line's "gate … ⏱" reads it.
const RUNNING = join(ROOT, '.builder', 'gates', 'running.json')
const markRunning = (label) => {
  mkdirSync(dirname(RUNNING), { recursive: true })
  writeFileSync(RUNNING, JSON.stringify({ sets: label, pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
}
process.on('exit', () => rmSync(RUNNING, { force: true }))
```

Then, inside the loop, right after the `console.log(\`▶ ${set.label} …\`)` line:

```js
  markRunning(set.label)
```

- [ ] **Step 4: Run it — expect PASS**, then the whole file: `node --test scripts/test/gates-core.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.mjs scripts/test/gates-core.test.mjs
git commit -m "feat(gate): mark a running set in .builder/gates/running.json"
```

---

### Task 2: the renderer — `scripts/statusline.mjs`

**Files:**
- Create: `scripts/statusline.mjs`
- Test: `scripts/test/statusline.test.mjs`

**Interfaces:**
- Consumes: `loadConfig(root)` → `{ ok, registry }` (`scripts/config.mjs`); `readProgress(base, registry, feature, status)` → `{ pct, label }`, `featureProgress({ status, manifestText, planText, ledgerText })`, `progressBar(pct)` → `'▓▓▓░░░░░░░ 30%'` (`scripts/fleet-core.mjs`); `parseManifest(text)` → `{ state, … }` (`scripts/manifest.mjs`); Task 1's `running.json`.
- Produces: `render({ cwd, width = 120, now = Date.now() })` → string (`''` when idle or on error); `repoRoots(dir)` → `{ root, main } | null`; `elapsed(ms)` → string; `fit(items, width)` → string. CLI: `node statusline.mjs --cwd <dir> [--width <n>] [--now <ms>]` prints `render(...)` (plus `\n` when non-empty), exit 0.

- [ ] **Step 1: Write the failing tests** — `scripts/test/statusline.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { render, repoRoots, elapsed, fit } from '../statusline.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-10-02T12:00:00Z')
const DEAD = 2 ** 22 + 12345 // above any real pid on macOS/Linux defaults

function write(root, p, text, mtime = NOW) {
  mkdirSync(dirname(join(root, p)), { recursive: true })
  writeFileSync(join(root, p), text)
  utimesSync(join(root, p), mtime / 1000, mtime / 1000)
}
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-')))
  mkdirSync(join(root, '.git'))
  write(root, '.claude/builder.md', '---\nproject: t\nregistry: docs/features\napps:\n  - name: web\n    path: apps/web/\n    role: app\n---\n')
  return root
}
const plan = (n) => Array.from({ length: n }, (_, i) => `### Task ${i + 1}: t\n`).join('\n')
const ledger = (n) => Array.from({ length: n }, (_, i) => `Task ${i + 1}: complete\n`).join('')
function feature(root, name, state, { tasks = 9, done = 0, ledgerAt = NOW } = {}) {
  write(root, `docs/features/${name}/MANIFEST.md`, `size: md\nstate: ${state}\nnext: x\n`)
  write(root, `docs/features/${name}/PLAN.md`, plan(tasks))
  if (done) write(root, `.builder/${name}/progress.md`, ledger(done), ledgerAt)
}

test('an idle repo, a dir outside any repo, and a repo without a config render nothing', () => {
  assert.equal(render({ cwd: repo(), now: NOW }), '')
  assert.equal(render({ cwd: realpathSync(mkdtempSync(join(tmpdir(), 'none-'))), now: NOW }), '')
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'bare-')))
  mkdirSync(join(bare, '.git'))
  assert.equal(render({ cwd: bare, now: NOW }), '')
})

test('a live fleet shows done/total, each in-flight feature with its bar and step, parked ones marked', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: {
    a: { status: 'done' }, b: { status: 'building', worktree: null }, c: { status: 'parked' }, d: { status: 'queued' },
  } }))
  feature(root, 'b', 'building', { tasks: 9, done: 4 })
  const line = render({ cwd: root, now: NOW })
  assert.match(line, /^⚙ fleet 1\/4 · b [▓░]{10} build 4\/9 · ⛔ c$/)
})

test('a fleet whose process is gone shows nothing (stale fleet.json)', () => {
  const root = repo()
  write(root, '.builder/fleet/lock', String(DEAD))
  write(root, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'building' } } }))
  assert.equal(render({ cwd: root, now: NOW }), '')
})

test('an in-chat build shows while its ledger is fresh, and drops off after 5 minutes or once built', () => {
  const root = repo()
  feature(root, 'sheet-order', 'building', { tasks: 6, done: 2 })
  assert.equal(render({ cwd: root, now: NOW }), 'sheet-order build 2/6')
  assert.equal(render({ cwd: root, now: NOW + 5 * 60 * 1000 + 1 }), '')
  feature(root, 'sheet-order', 'built', { tasks: 6, done: 6 })
  assert.equal(render({ cwd: root, now: NOW }), '')
})

test('a running gate and a running job show with elapsed time; dead or finished ones do not', () => {
  const root = repo()
  write(root, '.builder/gates/running.json', JSON.stringify({ sets: 'deep set', pid: process.pid, startedAt: new Date(NOW - 185000).toISOString() }))
  write(root, '.builder/jobs/verify.pid', String(process.pid), NOW - 45000)
  write(root, '.builder/jobs/old.pid', String(process.pid))
  write(root, '.builder/jobs/old.exit', '0\n')
  write(root, '.builder/jobs/gone.pid', String(DEAD))
  assert.equal(render({ cwd: root, now: NOW }), 'gate deep set ⏱ 3m · job verify ⏱ 45s')
})

test('from inside a fleet worktree (.git is a file) it reads the main checkout', () => {
  const main = repo()
  write(main, '.builder/fleet/lock', String(process.pid))
  write(main, '.builder/fleet/fleet.json', JSON.stringify({ features: { b: { status: 'walking' } } }))
  const wt = join(main, '.claude/worktrees/b')
  write(main, '.claude/worktrees/b/.git', `gitdir: ${join(main, '.git/worktrees/b')}\n`)
  assert.deepEqual(repoRoots(join(wt, 'apps')), { root: wt, main })
  assert.match(render({ cwd: wt, now: NOW }), /^⚙ fleet 0\/1 · b /)
})

test('fit drops whole trailing items and says how many; elapsed is compact', () => {
  assert.equal(fit(['⚙ fleet 0/3', 'aaaa', 'bbbb', 'cccc'], 24), '⚙ fleet 0/3 · aaaa +2 more')
  assert.equal(fit(['one'], 2), 'one')
  assert.deepEqual([elapsed(45000), elapsed(185000), elapsed(72 * 60000)], ['45s', '3m', '1h12m'])
})

test('the CLI prints the line, and prints nothing (exit 0) on garbage', () => {
  const root = repo()
  feature(root, 'x', 'building', { tasks: 2, done: 1, ledgerAt: Date.now() })
  const ok = spawnSync('node', [join(SCRIPTS, 'statusline.mjs'), '--cwd', root], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, 'x build 1/2\n')
  write(root, '.builder/fleet/lock', String(process.pid))
  write(root, '.builder/fleet/fleet.json', '{ not json')
  const bad = spawnSync('node', [join(SCRIPTS, 'statusline.mjs'), '--cwd', root], { encoding: 'utf8' })
  assert.equal(bad.status, 0)
  assert.equal(bad.stderr, '')
  assert.equal(bad.stdout, 'x build 1/2\n', 'an unreadable fleet.json is no fleet segment, not "fleet 0/0"')
})
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '../statusline.mjs'`)

Run: `node --test scripts/test/statusline.test.mjs`

- [ ] **Step 3: Implement** — `scripts/statusline.mjs`:

```js
#!/usr/bin/env node
/**
 * statusline — one line of what builder is running right now in the repo holding --cwd, for
 * Claude Code's status line (through the launcher /builder:statusline installs). Fleet features
 * with their progress, a build in the chat whose ledger moved in the last 5 minutes, and running
 * gates and jobs. Prints nothing when nothing runs — and nothing, exit 0, on any error.
 *
 *   node <plugin>/scripts/statusline.mjs --cwd <dir> [--width <n>] [--now <ms>]
 *
 * Runs every couple of seconds, so it reads a handful of known files and spawns nothing.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { readProgress, featureProgress, progressBar } from './fleet-core.mjs'
import { parseManifest } from './manifest.mjs'

export const FRESH_MS = 5 * 60 * 1000

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
const list = (d) => {
  try { return readdirSync(d) } catch { return [] }
}
const alive = (pid) => {
  if (!(Number(pid) > 0)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** `{ root, main }` — the checkout holding `dir`, and the main checkout when that is a worktree. */
export function repoRoots(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const g = join(d, '.git')
    if (existsSync(g)) {
      if (statSync(g).isDirectory()) return { root: d, main: d }
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'))
      // <main>/.git/worktrees/<name>
      return { root: d, main: m ? dirname(dirname(dirname(resolve(d, m[1].trim())))) : d }
    }
    if (dirname(d) === d) return null
  }
}

export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Items joined by ` · `; over `width`, whole trailing items go and ` +N more` says so. */
export function fit(items, width) {
  for (let k = items.length; k > 0; k--) {
    const more = items.length - k
    const line = items.slice(0, k).join(' · ') + (more ? ` +${more} more` : '')
    if ([...line].length <= width || k === 1) return line
  }
  return ''
}

function fleetItems(main, registry) {
  if (!alive(read(join(main, '.builder', 'fleet', 'lock')))) return null
  const fleet = readJson(join(main, '.builder', 'fleet', 'fleet.json'))
  if (!fleet) return null
  const rows = Object.entries(fleet.features ?? {})
  const items = [`⚙ fleet ${rows.filter(([, f]) => f.status === 'done').length}/${rows.length}`]
  for (const [name, f] of rows) {
    if (['done', 'queued', 'waiting'].includes(f.status)) continue
    if (f.status === 'parked' || f.status === 'failed') { items.push(`⛔ ${name}`); continue }
    const p = readProgress(f.worktree ?? main, registry, name, f.status)
    items.push(`${name} ${progressBar(p.pct).split(' ')[0]} ${p.label}`)
  }
  return { items, names: new Set(rows.map(([n]) => n)), worktrees: rows.map(([, f]) => f.worktree).filter(Boolean) }
}

function buildItems(main, registry, now, skip) {
  const out = []
  for (const name of list(join(main, '.builder'))) {
    if (skip.has(name)) continue
    const ledger = join(main, '.builder', name, 'progress.md')
    if (!existsSync(ledger) || now - statSync(ledger).mtimeMs > FRESH_MS) continue
    const manifestText = read(join(main, registry, name, 'MANIFEST.md'))
    const state = manifestText && parseManifest(manifestText).state
    if (state !== 'planned' && state !== 'building') continue
    const p = featureProgress({ status: 'building', manifestText, planText: read(join(main, registry, name, 'PLAN.md')), ledgerText: read(ledger) })
    out.push(`${name} ${p.label}`)
  }
  return out
}

function gateItems(root, now) {
  const out = []
  const g = readJson(join(root, '.builder', 'gates', 'running.json'))
  if (g && alive(g.pid)) out.push(`gate ${g.sets} ⏱ ${elapsed(now - Date.parse(g.startedAt))}`)
  const jobs = join(root, '.builder', 'jobs')
  for (const f of list(jobs).filter((f) => f.endsWith('.pid')).sort()) {
    const name = f.slice(0, -4)
    if (existsSync(join(jobs, `${name}.exit`)) || !alive(read(join(jobs, f)))) continue
    out.push(`job ${name} ⏱ ${elapsed(now - statSync(join(jobs, f)).mtimeMs)}`)
  }
  return out
}

export function render({ cwd, width = 120, now = Date.now() }) {
  try {
    const roots = repoRoots(cwd)
    if (!roots) return ''
    const cfg = loadConfig(roots.main)
    if (!cfg.ok) return ''
    const fleet = fleetItems(roots.main, cfg.registry)
    const gateRoots = [...new Set([roots.root, roots.main, ...(fleet?.worktrees ?? [])])]
    const items = [
      ...(fleet?.items ?? []),
      ...buildItems(roots.main, cfg.registry, now, fleet?.names ?? new Set()),
      ...gateRoots.flatMap((r) => gateItems(r, now)),
    ]
    return items.length ? fit(items, width) : ''
  } catch {
    return ''
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
  const line = render({
    cwd: opt('--cwd') ?? process.cwd(),
    width: Number(opt('--width') ?? process.env.COLUMNS) || 120,
    now: Number(opt('--now')) || Date.now(),
  })
  if (line) process.stdout.write(`${line}\n`)
}
```

- [ ] **Step 4: Run — expect PASS**: `node --test scripts/test/statusline.test.mjs`. If the fleet test's bar regex fails, print `render(...)` and compare against `progressBar` in `scripts/fleet-core.mjs` — the bar is the ten cells before the space.

- [ ] **Step 5: Commit**

```bash
git add scripts/statusline.mjs scripts/test/statusline.test.mjs
git commit -m "feat(statusline): render running fleet, builds and gates as one line"
```

---

### Task 3: the launcher — `scripts/statusline-launcher.mjs`

**Files:**
- Create: `scripts/statusline-launcher.mjs`
- Test: `scripts/test/statusline-launcher.test.mjs`

**Interfaces:**
- Consumes: Task 2's CLI (`node <renderer> --cwd <dir>`); `<config>/builder/statusline.prev.json` = `{ "statusLine": { "command": string, … } | null }` (written by Task 4); `<config>/plugins/installed_plugins.json` = `{ "plugins": { "builder@<mp>": [{ scope, installPath, projectPath? }] } }`; a repo's `.claude-plugin/marketplace.json` = `{ "plugins": [{ "name": "builder", "source": "./plugins/builder" }] }`.
- Produces: stdout = wrapped output, then builder's line on its own line when non-empty. Lives at `<config>/builder/statusline.mjs`; config dir = two levels above its own file.

- [ ] **Step 1: Write the failing tests** — `scripts/test/statusline-launcher.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

function setup({ prev, tag = 'B' } = {}) {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')))
  mkdirSync(join(config, 'builder'))
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), join(config, 'builder', 'statusline.mjs'))
  if (prev !== undefined) put(join(config, 'builder', 'statusline.prev.json'), JSON.stringify({ statusLine: prev }))
  const install = join(config, 'plugins/cache/mp/builder/9.9.9')
  put(join(install, 'scripts/statusline.mjs'), `process.stdout.write(${JSON.stringify(tag)} + ' ' + process.argv[3] + '\\n')`)
  put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'builder@mp': [{ scope: 'user', installPath: install }] } }))
  return config
}
const launch = (config, cwd) => {
  const t0 = Date.now()
  const r = spawnSync('node', [join(config, 'builder', 'statusline.mjs')], { input: JSON.stringify({ workspace: { current_dir: cwd } }), encoding: 'utf8' })
  return { ...r, ms: Date.now() - t0 }
}
const cwd = () => realpathSync(mkdtempSync(join(tmpdir(), 'repo-')))

test('prints the previous status line, then builder\'s line, feeding the previous command the same stdin', () => {
  const config = setup({ prev: { type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(\'GSD \'+JSON.parse(s).workspace.current_dir))"' } })
  const dir = cwd()
  const r = launch(config, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `GSD ${dir}\nB ${dir}\n`)
})

test('no previous status line → builder\'s line alone; a failing one → builder\'s line alone', () => {
  const dir = cwd()
  assert.equal(launch(setup({ prev: null }), dir).stdout, `B ${dir}\n`)
  assert.equal(launch(setup({ prev: { type: 'command', command: 'exit 3' } }), dir).stdout, `B ${dir}\n`)
})

test('a previous command that hangs is cut off at 1s; builder\'s line still prints', () => {
  const dir = cwd()
  const r = launch(setup({ prev: { type: 'command', command: 'sleep 5' } }), dir)
  assert.equal(r.stdout, `B ${dir}\n`)
  assert.ok(r.ms < 3000, `took ${r.ms}ms`)
})

test('no builder install → the previous line alone, no error', () => {
  const config = setup({ prev: { type: 'command', command: 'echo GSD' } })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), '{"plugins":{}}')
  const r = launch(config, cwd())
  assert.equal(r.stdout, 'GSD\n')
  assert.equal(r.stderr, '')
})

test('a repo carrying its own copy of builder uses that renderer over the user install', () => {
  const config = setup({ prev: null })
  const dir = cwd()
  mkdirSync(join(dir, '.git'))
  put(join(dir, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'builder', source: './plugins/builder' }] }))
  put(join(dir, 'plugins/builder/scripts/statusline.mjs'), `process.stdout.write('VENDORED\\n')`)
  assert.equal(launch(config, join(dir)).stdout, 'VENDORED\n')
})
```

- [ ] **Step 2: Run — expect FAIL** (launcher file missing → `copyFileSync` ENOENT)

Run: `node --test scripts/test/statusline-launcher.test.mjs`

- [ ] **Step 3: Implement** — `scripts/statusline-launcher.mjs`:

```js
#!/usr/bin/env node
/**
 * The status line command /builder:statusline installs. Copied to <config>/builder/statusline.mjs,
 * so it outlives plugin versions: it imports nothing from the plugin and finds the current builder
 * on every run. It prints the status line the user had before (run with the same stdin), then
 * builder's line under it when something is running. Never prints an error; always exits 0.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = dirname(HERE)
const json = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
const out = []

/** The renderer to run for `cwd`: the repo's own copy of builder, else a project or user install. */
function renderer(cwd) {
  let root = null
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) { root = d; break }
    if (dirname(d) === d) break
  }
  if (root) {
    const src = json(join(root, '.claude-plugin', 'marketplace.json'))?.plugins?.find((p) => p.name === 'builder')?.source
    const vendored = typeof src === 'string' && join(root, src, 'scripts', 'statusline.mjs')
    if (vendored && existsSync(vendored)) return vendored
  }
  const rows = Object.entries(json(join(CONFIG, 'plugins', 'installed_plugins.json'))?.plugins ?? {})
    .filter(([id]) => id.startsWith('builder@'))
    .flatMap(([, entries]) => entries)
    .filter((e) => e.installPath && existsSync(join(e.installPath, 'scripts', 'statusline.mjs')))
  const pick = rows.find((e) => e.scope === 'project' && root && resolve(e.projectPath ?? '') === root) ?? rows.find((e) => e.scope === 'user')
  return pick ? join(pick.installPath, 'scripts', 'statusline.mjs') : null
}

try {
  let stdin = ''
  try { stdin = readFileSync(0, 'utf8') } catch {}
  const session = (() => { try { return JSON.parse(stdin) } catch { return {} } })()
  const cwd = session.workspace?.current_dir ?? session.cwd ?? process.cwd()

  const prev = json(join(HERE, 'statusline.prev.json'))?.statusLine?.command
  if (prev) {
    const r = spawnSync('sh', ['-c', prev], { input: stdin, encoding: 'utf8', timeout: 1000 })
    const text = (r.stdout ?? '').replace(/\n+$/, '')
    if (text) out.push(text)
  }

  const script = existsSync(cwd) && statSync(cwd).isDirectory() ? renderer(cwd) : null
  if (script) {
    const r = spawnSync(process.execPath, [script, '--cwd', cwd], { encoding: 'utf8', timeout: 500 })
    const line = (r.stdout ?? '').replace(/\n+$/, '')
    if (line) out.push(line)
  }
} catch {}
if (out.length) process.stdout.write(out.join('\n') + '\n')
```

If the hang test takes ~5 s instead of ~1 s, a grandchild of `sh` is holding stdout open after the
timeout kills `sh`. Fix in the launcher, not the test: add `killSignal: 'SIGKILL'` to that
`spawnSync` call and run the command as `sh -c "exec $0"`-style only when it is a single simple
command — i.e. prefix `exec ` when `!/[;&|\n]/.test(prev)`. Re-run; it must finish in < 3 s.

Note: the fake renderer in the tests prints `process.argv[3]` — that is the `--cwd` value, which is how the tests prove the cwd was passed.

- [ ] **Step 4: Run — expect PASS**: `node --test scripts/test/statusline-launcher.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/statusline-launcher.mjs scripts/test/statusline-launcher.test.mjs
git commit -m "feat(statusline): a stable launcher that wraps the previous status line and finds the current builder"
```

---

### Task 4: the installer — `scripts/statusline-install.mjs`

**Files:**
- Create: `scripts/statusline-install.mjs`
- Test: `scripts/test/statusline-install.test.mjs`

**Interfaces:**
- Consumes: Task 3's `scripts/statusline-launcher.mjs` (copied); Task 2's `render({ cwd })` for `status`.
- Produces: CLI `node statusline-install.mjs [on|off|status|toggle]` (default `toggle`). Exit 0 on success, 1 on refusal. Writes `<config>/settings.json` `statusLine` = `{ "type": "command", "command": "node \"<config>/builder/statusline.mjs\"", "refreshInterval": 2 }`; `<config>/builder/statusline.prev.json`.

- [ ] **Step 1: Write the failing tests** — `scripts/test/statusline-install.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'statusline-install.mjs')
const GSD = { type: 'command', command: 'node "/x/gsd-statusline.js"' }

function config(settings) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')))
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n')
  return dir
}
const run = (dir, ...args) => spawnSync('node', [INSTALL, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
const settings = (dir) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

test('on wraps the existing line and copies the launcher; off restores it exactly', () => {
  const dir = config({ model: 'opus', statusLine: GSD })
  const on = run(dir, 'on')
  assert.equal(on.status, 0, on.stderr)
  const s = settings(dir)
  assert.equal(s.model, 'opus', 'other keys kept')
  assert.equal(s.statusLine.command, `node "${join(dir, 'builder', 'statusline.mjs')}"`)
  assert.equal(s.statusLine.refreshInterval, 2)
  assert.ok(existsSync(join(dir, 'builder', 'statusline.mjs')))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'builder', 'statusline.prev.json'), 'utf8')), { statusLine: GSD })
  const off = run(dir, 'off')
  assert.equal(off.status, 0, off.stderr)
  assert.deepEqual(settings(dir), { model: 'opus', statusLine: GSD })
  assert.ok(!existsSync(join(dir, 'builder', 'statusline.prev.json')))
})

test('with no previous status line, off removes the key again (and works with no settings file at all)', () => {
  const dir = config({ model: 'opus' })
  run(dir, 'on')
  run(dir, 'off')
  assert.deepEqual(settings(dir), { model: 'opus' })
  const none = config()
  assert.equal(run(none, 'on').status, 0)
  assert.equal(run(none, 'off').status, 0)
  assert.deepEqual(settings(none), {})
})

test('on twice keeps the original saved line; bare toggles', () => {
  const dir = config({ statusLine: GSD })
  run(dir, 'on')
  const again = run(dir, 'on')
  assert.match(again.stdout, /already on/)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'builder', 'statusline.prev.json'), 'utf8')), { statusLine: GSD })
  assert.match(run(dir).stdout, /off/)
  assert.deepEqual(settings(dir).statusLine, GSD)
  assert.match(run(dir).stdout, /on/)
  assert.match(settings(dir).statusLine.command, /builder/)
})

test('off refuses when the status line is no longer builder\'s; unparseable settings are never written', () => {
  const dir = config({ statusLine: GSD })
  run(dir, 'on')
  const other = { type: 'command', command: 'my-own-line' }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: other }))
  const off = run(dir, 'off')
  assert.equal(off.status, 1)
  assert.match(off.stdout + off.stderr, /isn't builder's/)
  assert.deepEqual(settings(dir).statusLine, other)
  const broken = config('{ nope')
  assert.equal(run(broken, 'on').status, 1)
  assert.equal(readFileSync(join(broken, 'settings.json'), 'utf8'), '{ nope')
})

test('status reports on/off and the wrapped command', () => {
  const dir = config({ statusLine: GSD })
  assert.match(run(dir, 'status').stdout, /^builder status line: off/m)
  run(dir, 'on')
  const s = run(dir, 'status').stdout
  assert.match(s, /^builder status line: on/m)
  assert.match(s, /gsd-statusline\.js/)
})
```

- [ ] **Step 2: Run — expect FAIL** (module not found → non-zero status)

Run: `node --test scripts/test/statusline-install.test.mjs`

- [ ] **Step 3: Implement** — `scripts/statusline-install.mjs`:

```js
#!/usr/bin/env node
/**
 * statusline-install — turn builder's status line on or off in the user's Claude Code settings.
 * The only code that edits settings.json; it touches the `statusLine` key and nothing else.
 *
 *   node <plugin>/scripts/statusline-install.mjs [on|off|status|toggle]     # default: toggle
 *
 * on:  copy the launcher to <config>/builder/statusline.mjs, save the current statusLine (unless it
 *      is already builder's) to <config>/builder/statusline.prev.json, point statusLine at the launcher.
 * off: put the saved statusLine back (remove the key when there was none). Refuses when the current
 *      statusLine is not builder's. <config> is $CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { render } from './statusline.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const SETTINGS = join(CONFIG, 'settings.json')
const LAUNCHER = join(CONFIG, 'builder', 'statusline.mjs')
const PREV = join(CONFIG, 'builder', 'statusline.prev.json')
const OURS = { type: 'command', command: `node "${LAUNCHER}"`, refreshInterval: 2 }

const fail = (msg) => {
  console.log(`✘ ${msg}`)
  process.exit(1)
}
function loadSettings() {
  if (!existsSync(SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch {
    fail(`${SETTINGS} is not valid JSON — fix it first; nothing was changed`)
  }
}
function saveSettings(s) {
  mkdirSync(CONFIG, { recursive: true })
  writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(s, null, 2) + '\n')
  renameSync(`${SETTINGS}.tmp`, SETTINGS)
}
const isOurs = (line) => typeof line?.command === 'string' && line.command.includes(LAUNCHER)
const prevLine = () => {
  try { return JSON.parse(readFileSync(PREV, 'utf8')).statusLine ?? null } catch { return null }
}

function on(s) {
  mkdirSync(dirname(LAUNCHER), { recursive: true })
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), LAUNCHER)
  if (isOurs(s.statusLine)) return console.log('builder status line: already on (launcher refreshed)')
  writeFileSync(PREV, JSON.stringify({ statusLine: s.statusLine ?? null }, null, 2) + '\n')
  saveSettings({ ...s, statusLine: OURS })
  console.log(`builder status line: on — ${s.statusLine ? 'your previous status line still shows above it' : 'no previous status line'}. Takes effect on the next refresh.`)
}

function off(s) {
  if (!isOurs(s.statusLine)) {
    if (!s.statusLine) return console.log('builder status line: already off')
    fail("the status line isn't builder's — left alone")
  }
  const prev = prevLine()
  const next = { ...s }
  if (prev) next.statusLine = prev
  else delete next.statusLine
  saveSettings(next)
  rmSync(PREV, { force: true })
  console.log(`builder status line: off — ${prev ? 'your previous status line is back' : 'status line removed (there was none before)'}`)
}

function status(s) {
  const onNow = isOurs(s.statusLine)
  console.log(`builder status line: ${onNow ? 'on' : 'off'}`)
  const wrapped = onNow ? prevLine() : s.statusLine
  console.log(`  ${onNow ? 'wrapping' : 'current'}: ${wrapped?.command ?? '(none)'}`)
  if (onNow) console.log(`  here: ${render({ cwd: process.cwd() }) || '(idle — nothing running)'}`)
}

const verb = process.argv[2] ?? 'toggle'
const s = loadSettings()
if (verb === 'on') on(s)
else if (verb === 'off') off(s)
else if (verb === 'status') status(s)
else if (verb === 'toggle') (isOurs(s.statusLine) ? off : on)(s)
else fail(`unknown verb ${verb} — use on, off or status`)
```

- [ ] **Step 4: Run — expect PASS**: `node --test scripts/test/statusline-install.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/statusline-install.mjs scripts/test/statusline-install.test.mjs
git commit -m "feat(statusline): install/restore the statusLine setting"
```

---

### Task 5: the skill, docs and the 4.4.0 release files

**Files:**
- Create: `skills/statusline/SKILL.md`
- Modify: `skills/help/SKILL.md` (the table row after `/builder:version`, line ~61)
- Modify: `README.md` (new `## Live progress in the status line` before `## What it never does`)
- Modify: `CHANGELOG.md` (new `## 4.4.0` on top), `.claude-plugin/plugin.json` (`"version": "4.4.0"`)
- Test: `scripts/test/skills-consistency.test.mjs` (append)

**Interfaces:**
- Consumes: Task 4's CLI.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/skills-consistency.test.mjs`:

```js
test('statusline: the skill drives the installer, help names it, and vendored copies carry it', () => {
  const s = read('skills/statusline/SKILL.md')
  assert.match(s, /^name: statusline$/m)
  assert.match(s, /scripts\/statusline-install\.mjs/)
  assert.match(read('skills/help/SKILL.md'), /\/builder:statusline/)
  assert.match(read('README.md'), /^## Live progress in the status line$/m)
  for (const f of ['statusline.mjs', 'statusline-launcher.mjs', 'statusline-install.mjs']) assert.ok(existsSync(join(ROOT, 'scripts', f)), f)
})
```

- [ ] **Step 2: Run — expect FAIL** (`skills/statusline/SKILL.md` missing)

Run: `node --test --test-name-pattern="statusline: the skill" scripts/test/skills-consistency.test.mjs`

- [ ] **Step 3: Write the skill** — `skills/statusline/SKILL.md`:

~~~markdown
---
name: statusline
description: Turn builder's live status line on or off — a line under your existing Claude Code status line showing what builder is running right now (fleet features with progress, a build in the chat, running gates and jobs), blank when nothing runs. Writes the statusLine key of your user settings, keeps your previous status line showing above it, and puts it back exactly on off. Use when the user asks for live progress, a progress bar or a status line for builder, or to turn it off.
---

# `/builder:statusline` — live progress under your status line

Invocation: **`/builder:statusline [on|off|status]`**. `--help` prints this line and stops. With no
argument it toggles.

Run, from this skill's base directory (two levels up is the plugin root):

```bash
node "<base directory>/../../scripts/statusline-install.mjs" <on|off|status, or nothing to toggle>
```

Print its output verbatim. Then:

- **on** → it shows from the next refresh (about 2 seconds), no restart. Say what it tracks: a
  running fleet, a build in the chat while its ledger moved in the last 5 minutes, running gates and
  jobs — and that the line is blank while nothing runs.
- **off** → their previous status line is back as it was.
- **A refusal** (`isn't builder's`, invalid settings JSON) → relay it; never edit settings.json by
  hand to get around it.

It writes only the `statusLine` key of the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`). A project's own `statusLine` setting overrides it in that project.
~~~

- [ ] **Step 4: Help row** — in `skills/help/SKILL.md`, after the `/builder:version` row add:

```markdown
| **Watch it run** | `/builder:statusline` — toggles a live line under your status line: fleet progress, a build in the chat, running gates. Blank when idle |
```

- [ ] **Step 5: README section** — insert before `## What it never does`:

```markdown
## Live progress in the status line

`/builder:statusline` adds one line under your Claude Code status line while builder is working:

    ⚙ fleet 2/4 · cover-sheet ▓▓▓▓▓░░░░░ build 4/9 · sheet-order ▓▓▓▓▓▓▓▓░░ walked · gate deep set ⏱ 3m

It shows a running fleet, a build in the chat (while its ledger has moved in the last five minutes)
and running gates and jobs, refreshes every two seconds, and is blank when nothing runs. A plugin
can't set the status line itself, so the skill writes the `statusLine` key of your user settings: it
points at a small launcher in `<config>/builder/` that runs your previous status line first and finds
the current builder on every refresh — so updates need no re-run. `/builder:statusline off` puts your
previous setting back exactly.
```

- [ ] **Step 6: Release files** — `.claude-plugin/plugin.json`: `"version": "4.4.0"`. `CHANGELOG.md`, above `## 4.3.1`:

```markdown
## 4.4.0

**New:**
- **`/builder:statusline`** — a live line under your Claude Code status line while builder works:
  a running fleet with each feature's progress, a build in the chat, running gates and jobs. Blank
  when nothing runs; refreshes every two seconds. `on`, `off`, `status`, or bare to toggle. It
  writes the `statusLine` key of your user settings, keeps your existing status line showing above
  it, and `off` restores it exactly. Survives plugin updates without a re-run, and uses a repo's
  own vendored copy of builder where there is one.
- **Gate runs leave a marker** — `.builder/gates/running.json` while a set is running, which the
  status line reads.
```

- [ ] **Step 7: Run the whole suite and validate**

```bash
node --test scripts/test/*.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"
claude plugin validate .
```

Expected: `# fail 0` (the `wait gives up after --max` job test is load-sensitive — if it alone fails, re-run it by itself: `node --test --test-name-pattern="wait gives up" scripts/test/job.test.mjs`) and `✔ Validation passed`.

- [ ] **Step 8: Check a vendored copy carries it and leaks nothing**

```bash
tmp=$(mktemp -d) && git -C "$tmp" init -q && node scripts/vendor.mjs "$tmp" && ls "$tmp/plugins/builder/scripts" | grep statusline && node scripts/vendor.mjs "$tmp" --check
```

Expected: the three `statusline*.mjs` files listed; `--check` clean.

- [ ] **Step 9: Commit** (the tag and push happen after review, per RELEASING.md)

```bash
git add skills/statusline skills/help/SKILL.md README.md CHANGELOG.md .claude-plugin/plugin.json scripts/test/skills-consistency.test.mjs
git commit -m "feat(4.4): /builder:statusline — live progress of running builder work under your status line"
```
