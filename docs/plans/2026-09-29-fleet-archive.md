# Fleet + Registry Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A finished feature is archived automatically on both layers — its spec folder moves to `<registry>/_archive/<feature>/` in the ship commit, and its fleet row moves from `fleet.json` to `.builder/fleet/archive.jsonl` at landing — so every routine read costs O(work in flight), not O(history).

**Architecture:** A new `scripts/registry.mjs` owns the registry layout (`features`, `isArchived`, `specDir`, `isShippedFolder`, the one-time `--sweep`); every script that enumerated the registry switches to it. `scripts/fleet-core.mjs` gains the fleet archive log (`appendArchive`, `tailArchive`), log housekeeping (`archiveLogs`, `pruneArchivedLogs`) and renders only in-flight rows. `scripts/fleet.mjs` evicts a row the moment it lands and resolves dependencies with `landedOn` (in-memory set, else `git cat-file` on the target). Skills tell `/builder:ship` to `git mv` into the archive.

**Tech Stack:** Node ≥ 20 ESM, standard library only, `git`; tests with `node --test`.

**Spec:** `docs/specs/2026-09-29-fleet-archive-design.md`

## Global Constraints

- Dependency-free: Node's standard library plus `git`; no npm packages.
- The archive folder is named exactly `_archive`, directly under the config's `registry:`, flat (no sharding).
- Nothing committed is deleted; archived specs stay in the repo.
- No shared append-only file in git; "is X archived?" is a path existence check.
- `archive.jsonl` lives at `.builder/fleet/archive.jsonl` (git-ignored) and is never pruned.
- `agent_walk.keep_logs` defaults to **30** days; `0` keeps archived logs forever.
- `--status --archived [N]` defaults to **20**; `list-features --archived --limit N` defaults to **50**.
- Release: **3.8.0** in `.claude-plugin/plugin.json` and `CHANGELOG.md`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command for everything: `node --test 'scripts/test/*.test.mjs'`.

## Review Focus

1. **A feature name that is a prefix of another** (`a` and `a-b`): archiving `a`'s logs must not move `a-b-01.log`. Pinned in Task 4 (`archiveLogs` test) and Task 6 (migration test).
2. **A fleet killed between the archive append and the save**: the next run must not double-append. Pinned in Task 4 (`appendArchive` dedupe test).
3. **The target moved without the working tree** (the human switched branches mid-run): a dependency landed that way must still count as landed. `landedOn` checks `git cat-file -e <TARGET>:…`, not the working tree; the in-run case is pinned by the existing "ships after the human switched branches" test staying green in Task 6.
4. **A spec named for the fleet that is already archived**: refused as shipped, not "no MANIFEST.md". Pinned in Task 6.
5. **Multibyte text across a read-chunk boundary in `archive.jsonl`**: `tailArchive` must not corrupt it. Pinned in Task 4 (small-chunk test with `é`).

---

### Task 1: `registry.mjs` — the registry layout, and archive-aware program dependencies

**Files:**
- Create: `scripts/registry.mjs`
- Modify: `scripts/program.mjs` (the `shippedFolder` helper moves out; `waitsOn` walks in-flight folders and treats an archived dependency as met)
- Test: `scripts/test/registry.test.mjs` (create), `scripts/test/program.test.mjs`

**Interfaces:**
- Produces:
  - `ARCHIVE: '_archive'`
  - `features(root: string, registry: string): string[]` — in-flight folder names (directories not starting with `_` or `.`), `[]` when the registry is missing. Unsorted.
  - `isArchived(root, registry, name): boolean`
  - `specDir(root, registry, name): string` — absolute path: live folder if it exists, else the archived one if it exists, else the live path.
  - `isShippedFolder(dir: string): boolean` — `✅ SHIPPED` in the first 800 chars of `SPEC.md` or `PROGRAM.md`, or a manifest with `state: shipped`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/registry.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCHIVE, features, isArchived, specDir, isShippedFolder } from '../registry.mjs'

const REG = 'docs/features'

function tree(paths) {
  const root = mkdtempSync(join(tmpdir(), 'reg-'))
  for (const [p, body] of Object.entries(paths)) {
    const full = join(root, REG, p)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('features lists in-flight folders only — never the archive, dot-folders or files', () => {
  const root = tree({ 'a/MANIFEST.md': 'x', 'b/SPEC.md': 'x', '_archive/old/SPEC.md': 'x', '.hidden/x.md': 'x', 'README.md': 'x' })
  assert.deepEqual(features(root, REG).sort(), ['a', 'b'])
  assert.equal(ARCHIVE, '_archive')
})

test('features of a missing registry is empty', () => {
  assert.deepEqual(features(mkdtempSync(join(tmpdir(), 'reg-')), REG), [])
})

test('isArchived and specDir: live first, then the archive, else the live path', () => {
  const root = tree({ 'live/SPEC.md': 'x', '_archive/gone/SPEC.md': 'x' })
  assert.equal(isArchived(root, REG, 'gone'), true)
  assert.equal(isArchived(root, REG, 'live'), false)
  assert.equal(specDir(root, REG, 'live'), join(root, REG, 'live'))
  assert.equal(specDir(root, REG, 'gone'), join(root, REG, '_archive', 'gone'))
  assert.equal(specDir(root, REG, 'nowhere'), join(root, REG, 'nowhere'))
})

test('isShippedFolder reads the SPEC or PROGRAM header, or a shipped manifest', () => {
  const root = tree({
    's/SPEC.md': '# s — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    'p/PROGRAM.md': '# p — program\n> ✅ **SHIPPED** 2026-09-01\n',
    'm/MANIFEST.md': 'size: md\nstate: shipped\n',
    'o/SPEC.md': '# o — spec\n> ✅ SIGNED OFF 2026-09-01\n',
  })
  for (const n of ['s', 'p', 'm']) assert.equal(isShippedFolder(join(root, REG, n)), true, n)
  assert.equal(isShippedFolder(join(root, REG, 'o')), false)
  assert.equal(isShippedFolder(join(root, REG, 'missing')), false)
})
```

Append to `scripts/test/program.test.mjs`:

```js
test('a dependency that lives only in the archive is met — child or registry feature', () => {
  const root = registry({
    children: { api: 'building', c: 'spec' },
    deps: { c: 'api, lib' },
    folders: {
      '_archive/api': { 'SPEC.md': '# api — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n' },
      '_archive/lib': { 'SPEC.md': '# lib — spec\n> ✅ SHIPPED 2026-08-01 — PR #0\n' },
    },
  })
  assert.deepEqual(waitsOn(root, REG, 'c'), [])
})
```

(`registry()` in that file already creates nested `folders` keys with `mkdirSync(..., { recursive: true })`, so `'_archive/api'` works as a key.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/registry.test.mjs scripts/test/program.test.mjs`
Expected: FAIL — `Cannot find module '../registry.mjs'`; the first new program test fails with `[{ name: 'api', state: 'building' }, { name: 'lib', state: 'no such child or feature' }]`.

- [ ] **Step 3: Write `scripts/registry.mjs`**

```js
/**
 * The registry's layout, in one place. In-flight features are folders directly under the config's
 * `registry:`; /builder:ship moves a shipped one into `<registry>/_archive/<feature>/` in the ship
 * commit, where nothing routine reads it. Listing in-flight work never touches the archive, and
 * "has X shipped?" is one existsSync — the same cost at ten shipped features as at ten thousand.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from './manifest.mjs'

export const ARCHIVE = '_archive'

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** In-flight feature and program folders: every directory but `_archive` (and any `_`/`.` name). */
export function features(root, registry) {
  try {
    return readdirSync(join(root, registry), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

export const isArchived = (root, registry, name) => existsSync(join(root, registry, ARCHIVE, name))

/** Where a feature's docs are: its live folder, else its archived one, else the live path (so a
 *  caller's "missing" handling is unchanged). */
export function specDir(root, registry, name) {
  const live = join(root, registry, name)
  if (existsSync(live)) return live
  const archived = join(root, registry, ARCHIVE, name)
  return existsSync(archived) ? archived : live
}

/** A folder that says it shipped: a `✅ SHIPPED` SPEC or PROGRAM header, or `state: shipped`. */
export function isShippedFolder(dir) {
  for (const doc of ['SPEC.md', 'PROGRAM.md']) if (/✅\s*\*{0,2}SHIPPED/.test((read(join(dir, doc)) ?? '').slice(0, 800))) return true
  const mf = read(join(dir, 'MANIFEST.md'))
  return mf != null && parseManifest(mf).state === 'shipped'
}
```

- [ ] **Step 4: Switch `scripts/program.mjs` to it**

Replace the import block and the `shippedFolder` helper:

```js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from './manifest.mjs'
import { features, isArchived, isShippedFolder } from './registry.mjs'
```

Delete the whole `const shippedFolder = (dir) => { … }` block. Add to the module doc comment, after "…met the same way.":

```
 * A dependency moved into `<registry>/_archive/` shipped — met by existence alone, before any read.
```

In `waitsOn`, replace

```js
  const reg = join(root, registry)
  if (!existsSync(reg)) return []
  for (const prog of readdirSync(reg)) {
```

with

```js
  const reg = join(root, registry)
  for (const prog of features(root, registry)) {
```

Replace the non-child branch

```js
        const dir = join(reg, tok)
        if (/^[\w.-]+$/.test(tok) && existsSync(dir)) {
          if (!shippedFolder(dir)) out.push({ name: tok, state: folderState(dir) })
        } else out.push({ name: tok, state: 'no such child or feature' })
        continue
```

with

```js
        const dir = join(reg, tok)
        if (/^[\w.-]+$/.test(tok) && isArchived(root, registry, tok)) continue
        if (/^[\w.-]+$/.test(tok) && existsSync(dir)) {
          if (!isShippedFolder(dir)) out.push({ name: tok, state: folderState(dir) })
        } else out.push({ name: tok, state: 'no such child or feature' })
        continue
```

and the child line

```js
      if (states.get(dep) === 'shipped' || shippedFolder(join(reg, dep))) continue
```

with

```js
      if (states.get(dep) === 'shipped' || isArchived(root, registry, dep) || isShippedFolder(join(reg, dep))) continue
```

`existsSync` is still used in the non-child branch — keep it in the import: `import { readFileSync, existsSync } from 'node:fs'`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/test/registry.test.mjs scripts/test/program.test.mjs scripts/test/list-features.test.mjs`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add scripts/registry.mjs scripts/program.mjs scripts/test/registry.test.mjs scripts/test/program.test.mjs
git commit -m "feat(registry): one module owns the layout; an archived dependency is met by existence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `registry.mjs --sweep` — the one-time migration of already-shipped folders

**Files:**
- Modify: `scripts/registry.mjs`
- Test: `scripts/test/registry.test.mjs`

**Interfaces:**
- Consumes: `features`, `isArchived`, `isShippedFolder`, `ARCHIVE` (Task 1); `requireConfig()` from `scripts/config.mjs` (returns `{ root, registry, … }`, exits 2 without a config).
- Produces: `sweep(root, registry): { ok: true, moved: string[], collisions: string[] } | { ok: false, reason: string }`; CLI `node scripts/registry.mjs --sweep` (exit 0 done, 1 refused, 2 usage).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/registry.test.mjs` (add `execFileSync, spawnSync` from `node:child_process`, `existsSync` from `node:fs`, and `dirname` + `fileURLToPath` imports):

```js
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'registry.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function repo(paths) {
  const root = tree(paths)
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  return root
}
const sweepCli = (root) => spawnSync('node', [SCRIPT, '--sweep'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

test('--sweep moves every shipped folder and shipped program into _archive, staged not committed', () => {
  const root = repo({
    'done/SPEC.md': '# done — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    'prog/PROGRAM.md': '# prog — program\n> ✅ SHIPPED 2026-09-02\n',
    'prog/MANIFEST.md': 'tier: program\nchild: x — shipped\n',
    'live/MANIFEST.md': 'size: md\nstate: building\nnext: x\n',
    'live/SPEC.md': '# live — spec\n',
  })
  const r = sweepCli(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Moved 2 shipped folder\(s\) into docs\/features\/_archive\//)
  assert.ok(existsSync(join(root, REG, '_archive/done/SPEC.md')))
  assert.ok(existsSync(join(root, REG, '_archive/prog/PROGRAM.md')))
  assert.ok(existsSync(join(root, REG, 'live/SPEC.md')), 'in-flight work stays')
  assert.equal(existsSync(join(root, REG, 'done')), false)
  assert.match(git(root, 'status', '--porcelain'), /^R  docs\/features\/done\/SPEC\.md -> docs\/features\/_archive\/done\/SPEC\.md$/m)
  assert.equal(git(root, 'log', '--oneline').split('\n').length, 1, 'nothing committed')
})

test('--sweep refuses on uncommitted registry changes and moves nothing', () => {
  const root = repo({ 'done/SPEC.md': '# done — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n' })
  writeFileSync(join(root, REG, 'done/notes.md'), 'wip\n')
  const r = sweepCli(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /uncommitted changes under docs\/features/)
  assert.ok(existsSync(join(root, REG, 'done/SPEC.md')))
})

test('--sweep leaves a folder whose name is already archived, and says so', () => {
  const root = repo({
    'dup/SPEC.md': '# dup — spec\n> ✅ SHIPPED 2026-09-01 — PR #1\n',
    '_archive/dup/SPEC.md': '# dup — spec\n> ✅ SHIPPED 2026-01-01 — PR #0\n',
  })
  const r = sweepCli(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /⚠ dup — docs\/features\/_archive\/dup already exists; left in place/)
  assert.match(r.stdout, /Nothing to archive/)
  assert.ok(existsSync(join(root, REG, 'dup/SPEC.md')))
})

test('registry.mjs without --sweep is a usage error', () => {
  const root = repo({ 'a/SPEC.md': 'x' })
  const r = spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Usage: registry\.mjs --sweep/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/registry.test.mjs`
Expected: the four new tests FAIL (the script prints nothing and exits 0 when run directly).

- [ ] **Step 3: Implement `sweep` and the CLI**

In `scripts/registry.mjs`, extend the doc comment with:

```
 *
 *   node <plugin>/scripts/registry.mjs --sweep   # one-time: git mv every shipped folder into _archive/
```

Change the imports to:

```js
import { readdirSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseManifest } from './manifest.mjs'
import { requireConfig } from './config.mjs'
```

Append:

```js
/**
 * Move every in-flight folder that says it shipped into the archive with `git mv`, leaving the
 * result staged for the human to commit. Refuses while anything under the registry is uncommitted,
 * so the move never mixes with work in progress. A name already in the archive is left in place.
 */
export function sweep(root, registry) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', registry], { cwd: root, encoding: 'utf8' }).trimEnd()
  if (dirty) return { ok: false, reason: `uncommitted changes under ${registry} — commit or stash them first:\n${dirty}` }
  const moved = []
  const collisions = []
  for (const name of features(root, registry).sort()) {
    if (!isShippedFolder(join(root, registry, name))) continue
    if (isArchived(root, registry, name)) {
      collisions.push(name)
      continue
    }
    mkdirSync(join(root, registry, ARCHIVE), { recursive: true })
    execFileSync('git', ['mv', join(registry, name), join(registry, ARCHIVE, name)], { cwd: root })
    moved.push(name)
  }
  return { ok: true, moved, collisions }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invoked) {
  if (!process.argv.slice(2).includes('--sweep')) {
    console.error('Usage: registry.mjs --sweep   (moves every shipped folder into <registry>/_archive/, staged)')
    process.exit(2)
  }
  const CFG = requireConfig()
  const r = sweep(CFG.root, CFG.registry)
  if (!r.ok) {
    console.error(r.reason)
    process.exit(1)
  }
  for (const n of r.collisions) console.log(`⚠ ${n} — ${CFG.registry}/${ARCHIVE}/${n} already exists; left in place`)
  if (!r.moved.length) console.log(`Nothing to archive — no shipped folder outside ${CFG.registry}/${ARCHIVE}/.`)
  else {
    console.log(`Moved ${r.moved.length} shipped folder(s) into ${CFG.registry}/${ARCHIVE}/ (staged, not committed):`)
    for (const n of r.moved) console.log(`  ${n}`)
    console.log('Commit them: git commit -m "docs: archive shipped features"')
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/registry.test.mjs scripts/test/program.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/registry.mjs scripts/test/registry.test.mjs
git commit -m "feat(registry): --sweep archives folders that shipped before 3.8

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `list-features.mjs` and `check-obligations.mjs` read only in-flight folders; `--archived` lists the archive

**Files:**
- Modify: `scripts/list-features.mjs`, `scripts/check-obligations.mjs`
- Test: `scripts/test/list-features.test.mjs`

**Interfaces:**
- Consumes: `features`, `ARCHIVE` (Task 1).
- Produces: `list-features.mjs --archived [--limit N] [--json]` — markdown table `| Feature | Shipped | PR | Path |` newest first by SHIPPED date (JSON: `{ total, archived: [{ feature, shipped, pr, path }] }`); `--status` footer `📦 N shipped features archived · list-features.mjs --archived lists them`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/list-features.test.mjs`, replace `function repo(…) { … }` with a setup/run split (the existing tests keep calling `repo`):

```js
function setup(manifests, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lf-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  mkdirSync(join(root, 'docs/features'), { recursive: true })
  for (const [name, body] of Object.entries(manifests)) {
    mkdirSync(join(root, 'docs/features', name), { recursive: true })
    writeFileSync(join(root, 'docs/features', name, 'MANIFEST.md'), `size: md\nnext: x\n${body}\n`)
  }
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'docs/features', path)), { recursive: true })
    writeFileSync(join(root, 'docs/features', path), body)
  }
  return root
}
const list = (root, ...args) => spawnSync('node', [LIST, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })

function repo(manifests, files = {}) {
  const r = list(setup(manifests, files), '--json')
  assert.equal(r.status, 0, r.stderr)
  return Object.fromEntries(JSON.parse(r.stdout).features.map((f) => [f.feature, f]))
}
```

Append:

```js
const SHIPPED = (n, date, pr) => `# ${n} — spec\n> ✅ SHIPPED ${date} — PR #${pr} · none\n`

test('archived features are never rows; --status counts them in one line', () => {
  const root = setup({ live: 'state: building' }, {
    '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4),
    '_archive/older/SPEC.md': SHIPPED('older', '2026-08-01', 2),
  })
  const json = list(root, '--json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).features.map((f) => f.feature), ['live'])
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /📦 2 shipped features archived · list-features\.mjs --archived lists them/)
})

test('--archived lists the archive newest first; --limit caps it', () => {
  const root = setup({}, {
    '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4),
    '_archive/mid/SPEC.md': SHIPPED('mid', '2026-08-15', 3),
    '_archive/older/SPEC.md': SHIPPED('older', '2026-08-01', 2),
  })
  const r = list(root, '--archived', '--limit', '2')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /3 archived — newest first, showing 2/)
  assert.match(r.stdout, /\| old \| 2026-09-01 \| #4 \| `docs\/features\/_archive\/old` \|/)
  assert.ok(r.stdout.indexOf('| old |') < r.stdout.indexOf('| mid |'))
  assert.doesNotMatch(r.stdout, /\| older \|/)
  const j = JSON.parse(list(root, '--archived', '--json').stdout)
  assert.equal(j.total, 3)
  assert.deepEqual(j.archived.map((a) => a.feature), ['old', 'mid', 'older'])
})

test('with nothing in flight, --status still says how many shipped', () => {
  const root = setup({}, { '_archive/old/SPEC.md': SHIPPED('old', '2026-09-01', 4) })
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /Nothing in progress in t — 1 shipped/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/list-features.test.mjs`
Expected: the three new tests FAIL — `_archive` shows up as a row (`['_archive', 'live']`), and `--archived` prints the normal table.

- [ ] **Step 3: Implement in `scripts/list-features.mjs`**

a) In the header comment's usage block add:

```
 *   node <plugin>/scripts/list-features.mjs --archived    # shipped features in <registry>/_archive/, newest first [--limit N] [--json]
```

and after the DONE paragraph:

```
 * ARCHIVED = moved into `<registry>/_archive/` by /builder:ship. Never a row: only --archived reads
 * inside the archive, and --status counts it with one directory listing.
```

b) Add the import: `import { features, ARCHIVE } from './registry.mjs'`

c) After `const includeDone = …` add:

```js
const asArchived = args.includes('--archived')
const limitAt = args.indexOf('--limit')
const LIMIT = limitAt >= 0 && Number(args[limitAt + 1]) > 0 ? Number(args[limitAt + 1]) : 50
```

d) Immediately before `let rows = []`, add:

```js
const ARCHIVE_DIR = join(ROOT, CFG.registry, ARCHIVE)
/** Names only — one directory listing, nothing inside it read. */
const archivedNames = () => {
  try {
    return readdirSync(ARCHIVE_DIR).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

if (asArchived) {
  const all = archivedNames()
    .map((name) => {
      const dir = join(ARCHIVE_DIR, name)
      const head = (read(join(dir, 'SPEC.md')) ?? read(join(dir, 'PROGRAM.md')) ?? '').slice(0, 800)
      return { feature: name, shipped: grab(head, /SHIPPED\s+([\d-]+)/), pr: grab(head, /PR\s*(#\d+)/), path: `${CFG.registry}/${ARCHIVE}/${name}` }
    })
    .sort((a, b) => (b.shipped ?? '').localeCompare(a.shipped ?? '') || a.feature.localeCompare(b.feature))
  const shown = all.slice(0, LIMIT)
  if (asJson) console.log(JSON.stringify({ total: all.length, archived: shown }, null, 2))
  else if (!all.length) console.log(`Nothing archived under ${CFG.registry}/${ARCHIVE}/ yet.`)
  else {
    console.log(`**${CFG.project}** — ${all.length} archived — newest first, showing ${shown.length}\n`)
    console.log('| Feature | Shipped | PR | Path |')
    console.log('|---|---|---|---|')
    for (const a of shown) console.log(`| ${a.feature} | ${a.shipped ?? '—'} | ${a.pr ?? '—'} | \`${a.path}\` |`)
  }
  process.exit(0)
}
```

e) Replace the enumeration loop

```js
for (const { root, requireManifest } of REGISTRY) {
  let names = []
  try {
    names = readdirSync(join(ROOT, root))
      .filter((f) => statSync(join(ROOT, root, f)).isDirectory())
      .sort()
  } catch {
    continue
  }
  for (const name of names) {
```

with

```js
for (const { root, requireManifest } of REGISTRY) {
  for (const name of features(ROOT, root).sort()) {
```

(the loop body and closing braces stay).

f) Replace

```js
if (!rows.length) {
  console.error(`Nothing under ${CFG.registry} — start one with ${PLAN_CMD} --size md <what you want>.`)
  process.exit(asJson || asStatus ? 0 : 1)
}
```

with

```js
const archivedCount = archivedNames().length
if (!rows.length && !archivedCount) {
  console.error(`Nothing under ${CFG.registry} — start one with ${PLAN_CMD} --size md <what you want>.`)
  process.exit(asJson || asStatus ? 0 : 1)
}
```

g) In the `if (asStatus) {` block: change `const doneCount = rows.length - open.length` to

```js
  const liveDone = rows.length - open.length
  const doneCount = liveDone + archivedCount
```

and replace `if (doneCount) console.log(`\n🔒 ${doneCount} shipped, not shown.`)` with

```js
  if (liveDone) console.log(`\n🔒 ${liveDone} shipped, not shown — \`node <builder>/scripts/registry.mjs --sweep\` archives them.`)
  if (archivedCount) console.log(`\n📦 ${archivedCount} shipped features archived · list-features.mjs --archived lists them.`)
```

h) In the default table, replace `console.log(`No features yet. Start one with ${PLAN_CMD} --size md <what you want>.`)` with

```js
  console.log(`No features in flight${archivedCount ? ` (${archivedCount} shipped, archived)` : ''}. Start one with ${PLAN_CMD} --size md <what you want>.`)
```

- [ ] **Step 4: Implement in `scripts/check-obligations.mjs`**

Add `import { features } from './registry.mjs'` and replace the `--all` IIFE

```js
  ? (() => {
      try {
        return readdirSync(join(ROOT, REGISTRY_ROOT))
          .map((d) => join(ROOT, REGISTRY_ROOT, d))
          .filter((d) => statSync(d).isDirectory() && hasSpec(d))
      } catch {
        return []
      }
    })()
```

with

```js
  ? features(ROOT, REGISTRY_ROOT)
      .map((d) => join(ROOT, REGISTRY_ROOT, d))
      .filter(hasSpec)
```

Remove `readdirSync` and `statSync` from its `node:fs` import if nothing else in the file uses them (`grep -n "readdirSync\|statSync" scripts/check-obligations.mjs` after the edit).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: PASS. Then `node --check scripts/check-obligations.mjs` — Expected: no output (it has no test file; this catches a broken edit).

- [ ] **Step 6: Commit**

```bash
git add scripts/list-features.mjs scripts/check-obligations.mjs scripts/test/list-features.test.mjs
git commit -m "feat(list-features): in-flight folders only; --archived lists the archive, --status counts it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `fleet-core.mjs` — the archive log, log housekeeping, and a status table of work in flight

**Files:**
- Modify: `scripts/fleet-core.mjs`
- Test: `scripts/test/fleet-core.test.mjs`

**Interfaces:**
- Consumes: `ARCHIVE` (Task 1).
- Produces:
  - `appendArchive(root, row): boolean` — appends one JSON line to `.builder/fleet/archive.jsonl`; `false` (no write) when one of the last 50 lines has the same `feature` and `merged`.
  - `tailArchive(root, n, chunk = 65536): object[]` — the last `n` parsed rows, oldest → newest; `[]` when absent. Reads backwards; never the whole file.
  - `archiveLogs(root, feature): string | null` — moves `logs/<feature>-(NN|setup|start|sync).(log|jsonl)` into `logs/_archive/<feature>/`; `null` on success/nothing to move, else a note.
  - `pruneArchivedLogs(root, days, now = Date.now()): number` — removes `logs/_archive/<feature>/` older than `days`; `days <= 0` keeps all.
  - `ago(iso, now = Date.now()): string` — `just now` · `Nm ago` · `Nh ago` (< 48h) · `Nd ago` · `unknown`.
  - `renderStatus(fleet, progress = null, last = null, now = Date.now())` — only rows whose `status !== 'done'`; archived line when `(fleet.archived ?? 0) + doneRows > 0`.
  - `renderArchived(rows, total, now = Date.now()): string`.
  - Archive row shape (used by Task 6): `{ feature, branch, target, merged, pr, runs, runsThisTime, landedAt }`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/fleet-core.test.mjs`, extend the imports:

```js
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { laneOf, decide, loadFleet, saveFleet, renderStatus, fleetDir, shippedPr, featureProgress, readProgress, progressBar, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, ago, renderArchived } from '../fleet-core.mjs'
```

Update the three existing tests that render a `done` row (done rows are archive material now):

In `saveFleet writes fleet.json atomically…` replace

```js
  assert.match(status, /2 feature\(s\): 1 done · 1 parked|2 feature\(s\): 1 parked · 1 done/)
  assert.ok(status.indexOf('| a |') < status.indexOf('| b |'), 'rows sorted by feature')
```

with

```js
  assert.match(status, /# builder fleet — 1 feature\(s\): 1 parked/)
  assert.match(status, /^1 archived · --status --archived for the latest 20$/m, 'a done row is counted, not listed')
  assert.doesNotMatch(status, /\| a \|/)
```

In `renderStatus keeps only informative columns…` replace the heading and `b` assertions:

```js
  assert.match(out, /^# builder fleet — 1 feature\(s\): 1 building\n\nmerges into \*\*main\*\* · worktrees under \/w\/root\n\n1 archived · --status --archived for the latest 20\n/)
  assert.match(out, /\| Feature \| Status \| Runs \| Reason \| Worktree \|/)
  assert.doesNotMatch(out, /Evidence|\| PR \|/)
  assert.match(out, /\| a \| building \| 2 \| — \| yes \|/)
  assert.doesNotMatch(out, /\| b \|/)
  assert.match(out, /- a note$/m)
```

In `renderStatus adds a Progress column…` replace the heading and `b` assertions:

```js
  assert.match(out, /^# builder fleet — 1 feature\(s\): 1 building · ▓▓▓▓░░░░░░ 43%\n/)
  assert.match(out, /\| Feature \| Status \| Progress \| Runs \| Reason \| Worktree \|/)
  assert.match(out, /\| a \| building \| ▓▓▓▓░░░░░░ 43% · build 2\/4 \| 2 \| — \| yes \|/)
  assert.doesNotMatch(out, /\| b \|/)
```

Append:

```js
// ---- the archive: what landed leaves fleet.json ----------------------------------------------

const row = (feature, merged = 'abc1234') => ({ feature, branch: `builder/${feature}`, target: 'main', merged, pr: null, runs: 3, runsThisTime: 3, landedAt: '2026-09-29T10:00:00.000Z' })

test('appendArchive appends one line per landing and skips a repeat of the same landing', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  assert.equal(appendArchive(root, row('a')), true)
  assert.equal(appendArchive(root, row('a')), false, 'a fleet killed before saving re-archives the same landing')
  assert.equal(appendArchive(root, row('a', 'def5678')), true, 'the same name landing again later is a new line')
  assert.deepEqual(tailArchive(root, 10).map((r) => [r.feature, r.merged]), [['a', 'abc1234'], ['a', 'def5678']])
})

test('tailArchive returns the last N rows, oldest first, reading backwards in chunks', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  mkdirSync(fleetDir(root), { recursive: true })
  for (let i = 0; i < 300; i++) appendFileSync(join(fleetDir(root), 'archive.jsonl'), JSON.stringify(row(`fé${i}`)) + '\n')
  assert.deepEqual(tailArchive(root, 3, 37).map((r) => r.feature), ['fé297', 'fé298', 'fé299'])
  assert.equal(tailArchive(root, 1000, 37).length, 300)
  assert.deepEqual(tailArchive(mkdtempSync(join(tmpdir(), 'fc-')), 5), [])
})

test('archiveLogs moves exactly this feature’s logs — not those of a feature whose name it prefixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const logs = join(fleetDir(root), 'logs')
  mkdirSync(logs, { recursive: true })
  for (const n of ['a-01.log', 'a-01.jsonl', 'a-12.log', 'a-setup.log', 'a-start.log', 'a-sync.log', 'a-b-01.log', 'baseline.log']) writeFileSync(join(logs, n), 'x')
  assert.equal(archiveLogs(root, 'a'), null)
  for (const n of ['a-01.log', 'a-01.jsonl', 'a-12.log', 'a-setup.log', 'a-start.log', 'a-sync.log']) assert.ok(existsSync(join(logs, '_archive', 'a', n)), n)
  assert.ok(existsSync(join(logs, 'a-b-01.log')))
  assert.ok(existsSync(join(logs, 'baseline.log')))
  assert.equal(archiveLogs(root, 'nothing-here'), null)
})

test('pruneArchivedLogs removes archived logs older than the window; 0 keeps them', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const base = join(fleetDir(root), 'logs', '_archive')
  for (const n of ['old', 'new']) {
    mkdirSync(join(base, n), { recursive: true })
    writeFileSync(join(base, n, `${n}-01.log`), 'x')
  }
  const now = Date.now()
  const old = new Date(now - 3 * 86400000)
  utimesSync(join(base, 'old'), old, old)
  assert.equal(pruneArchivedLogs(root, 0, now), 0)
  assert.ok(existsSync(join(base, 'old')))
  assert.equal(pruneArchivedLogs(root, 1, now), 1)
  assert.equal(existsSync(join(base, 'old')), false)
  assert.ok(existsSync(join(base, 'new')))
  assert.equal(pruneArchivedLogs(mkdtempSync(join(tmpdir(), 'fc-')), 30, now), 0, 'no logs dir is not an error')
})

test('ago', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  assert.equal(ago('2026-09-29T11:59:30Z', now), 'just now')
  assert.equal(ago('2026-09-29T11:15:00Z', now), '45m ago')
  assert.equal(ago('2026-09-29T02:00:00Z', now), '10h ago')
  assert.equal(ago('2026-09-25T12:00:00Z', now), '4d ago')
  assert.equal(ago('nonsense', now), 'unknown')
})

test('renderStatus names the archive with the last landing', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  const out = renderStatus({ target: 'main', archived: 412, features: {} }, null, { feature: 'auth-refresh', landedAt: '2026-09-29T10:00:00Z' }, now)
  assert.match(out, /^# builder fleet — 0 feature\(s\): none\n/)
  assert.match(out, /^412 archived \(last: auth-refresh, 2h ago\) · --status --archived for the latest 20$/m)
  assert.match(out, /^Nothing in flight\.$/m)
  assert.doesNotMatch(out, /\| Feature \|/)
})

test('renderArchived lists the latest landings newest first', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  const out = renderArchived([row('a'), { ...row('b', 'fff0000'), pr: '#9', landedAt: '2026-09-29T11:00:00Z' }], 412, now)
  assert.match(out, /^# builder fleet — archive: latest 2 of 412\n/)
  assert.match(out, /\| Feature \| Merged \| PR \| Landed \|/)
  assert.ok(out.indexOf('| b |') < out.indexOf('| a |'))
  assert.match(out, /\| b \| fff0000 \| #9 \| 1h ago \|/)
  assert.match(out, /\| a \| abc1234 \| — \| 2h ago \|/)
  assert.equal(renderArchived([], 0), 'No feature has landed from this fleet yet.\n')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/fleet-core.test.mjs`
Expected: FAIL — `appendArchive` etc. are not exported (SyntaxError on import).

- [ ] **Step 3: Implement in `scripts/fleet-core.mjs`**

Change the imports:

```js
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from './manifest.mjs'
import { ARCHIVE } from './registry.mjs'
```

Replace `saveFleet`'s last line `writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet, progress))` with

```js
  writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet, progress, tailArchive(root, 1)[0] ?? null))
```

Add after `saveFleet`:

```js
// ---- the archive -------------------------------------------------------------------------------
//
// A landed feature leaves fleet.json: one JSON line in archive.jsonl (git-ignored, written only by
// the fleet process, which lands one feature at a time), and its logs move under logs/_archive/.
// fleet.json then holds only work in flight — its size, and the cost of every save, stay flat.

const ARCHIVE_LOG = 'archive.jsonl'
const NL = 0x0a

/** The last `n` archive rows, oldest first. Reads backwards `chunk` bytes at a time as raw bytes, so
 *  a multibyte character split across chunks is joined before it is decoded. */
export function tailArchive(root, n, chunk = 64 * 1024) {
  const p = join(fleetDir(root), ARCHIVE_LOG)
  if (n <= 0 || !existsSync(p)) return []
  const fd = openSync(p, 'r')
  try {
    let pos = fstatSync(fd).size
    let data = Buffer.alloc(0)
    const newlines = () => data.reduce((k, b) => k + (b === NL ? 1 : 0), 0)
    while (pos > 0 && newlines() <= n) {
      const len = Math.min(chunk, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, pos)
      data = Buffer.concat([buf, data])
    }
    const lines = data.toString('utf8').split('\n').filter(Boolean)
    // Stopped short of the file's start: the first line is a fragment.
    return (pos > 0 ? lines.slice(1) : lines).slice(-n).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

/** One line per landing. A repeat of a landing already among the last 50 lines (a fleet killed
 *  between this append and its save re-archives the row on the next load) is skipped. */
export function appendArchive(root, row) {
  mkdirSync(fleetDir(root), { recursive: true })
  if (tailArchive(root, 50).some((r) => r.feature === row.feature && r.merged === row.merged)) return false
  appendFileSync(join(fleetDir(root), ARCHIVE_LOG), JSON.stringify(row) + '\n')
  return true
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** This feature's run, setup, start and sync logs into logs/_archive/<feature>/. Exact names only:
 *  `a` must not take `a-b-01.log`. Null when done (or nothing to move); else a note. */
export function archiveLogs(root, feature) {
  const logs = join(fleetDir(root), 'logs')
  if (!existsSync(logs)) return null
  const mine = new RegExp(`^${escapeRe(feature)}-(\\d+|setup|start|sync)\\.(log|jsonl)$`)
  const dest = join(logs, ARCHIVE, feature)
  try {
    const names = readdirSync(logs).filter((n) => mine.test(n))
    if (!names.length) return null
    mkdirSync(dest, { recursive: true })
    for (const n of names) renameSync(join(logs, n), join(dest, n))
    return null
  } catch (e) {
    return `${feature} merged, but its logs could not be moved into ${dest}: ${e.message}`
  }
}

/** Archived logs older than `days` go; `days` <= 0 keeps them. Best effort — the next start retries. */
export function pruneArchivedLogs(root, days, now = Date.now()) {
  if (!(days > 0)) return 0
  const base = join(fleetDir(root), 'logs', ARCHIVE)
  let removed = 0
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return 0
  }
  for (const n of names) {
    try {
      if (now - statSync(join(base, n)).mtimeMs > days * 86400000) {
        rmSync(join(base, n), { recursive: true, force: true })
        removed++
      }
    } catch {}
  }
  return removed
}

/** `just now` · `45m ago` · `10h ago` · `4d ago`. */
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return 'unknown'
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** `--status --archived [N]`: the latest landings, newest first. */
export function renderArchived(rows, total, now = Date.now()) {
  if (!rows.length) return 'No feature has landed from this fleet yet.\n'
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const lines = [`# builder fleet — archive: latest ${rows.length} of ${Math.max(total, rows.length)}`, '', '| Feature | Merged | PR | Landed |', '|---|---|---|---|']
  for (const r of [...rows].reverse()) lines.push(`| ${cell(r.feature)} | ${cell(r.merged)} | ${cell(r.pr)} | ${cell(r.landedAt ? ago(r.landedAt, now) : null)} |`)
  return lines.join('\n') + '\n'
}
```

Replace `renderStatus` (keep its doc comment; append one sentence to it: ` A \`done\` row is archive material — counted in the archived line, never listed.`):

```js
export function renderStatus(fleet, progress = null, last = null, now = Date.now()) {
  const all = Object.entries(fleet.features).sort(([a], [b]) => a.localeCompare(b))
  const rows = all.filter(([, f]) => f.status !== 'done')
  const archived = (fleet.archived ?? 0) + (all.length - rows.length)
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const counts = {}
  for (const [, f] of rows) counts[f.status] = (counts[f.status] ?? 0) + 1
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ')
  const roots = new Set(rows.map(([, f]) => f.worktree && f.worktree.replace(/\/[^/]+\/?$/, '')).filter(Boolean))
  const prog = progress ? Object.fromEntries(rows.map(([name, f]) => [name, progress(name, f) ?? { pct: 0, label: '—' }])) : null
  const overall = prog && rows.length ? progressBar(rows.reduce((s, [name]) => s + prog[name].pct, 0) / rows.length) : ''
  const lines = [`# builder fleet — ${rows.length} feature(s): ${summary || 'none'}${overall ? ` · ${overall}` : ''}`]
  if (fleet.target) lines.push('', `merges into **${fleet.target}**${roots.size ? ` · worktrees under ${[...roots].join(', ')}` : ''}`)
  if (archived) lines.push('', `${archived} archived${last ? ` (last: ${last.feature}, ${ago(last.landedAt, now)})` : ''} · --status --archived for the latest 20`)
  if (!rows.length) lines.push('', 'Nothing in flight.')
  else {
    const col = prog ? ' Progress |' : ''
    lines.push('', `| Feature | Status |${col} Runs | Reason | Worktree |`, `|---|---|${prog ? '---|' : ''}---|---|---|`)
    for (const [name, f] of rows) {
      const reason = f.pr && f.pr !== 'shipped' ? `${f.reason ? `${f.reason} · ` : ''}PR ${f.pr}` : f.reason
      const p = prog ? ` ${progressBar(prog[name].pct)} · ${cell(prog[name].label)} |` : ''
      lines.push(`| ${cell(name)} | ${cell(f.status)} |${p} ${f.runs ?? 0} | ${cell(reason)} | ${f.worktree ? 'yes' : '—'} |`)
    }
  }
  if (fleet.notes?.length) lines.push('', ...fleet.notes.map((n) => `- ${n}`))
  return lines.join('\n') + '\n'
}
```

Note: `renderStatus with nothing in it` (`/0 feature\(s\): none/`) still passes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/fleet-core.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet-core.mjs scripts/test/fleet-core.test.mjs
git commit -m "feat(fleet-core): archive log, log housekeeping; the status table shows work in flight

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `agent_walk.keep_logs` in the config

**Files:**
- Modify: `scripts/config.mjs` (`agentWalkOf` and its doc comment), `PROJECT.template.md` (the `agent_walk:` block)
- Test: `scripts/test/config.test.mjs`

**Interfaces:**
- Produces: `CFG.agentWalk.keepLogs: number` — integer ≥ 0 from `keep_logs`, else 30.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/config.test.mjs`, in `agent_walk parsed, with defaults for what is left out`, add `keepLogs: 30,` after `smoke: null,` in the expected object. Append:

```js
test('keep_logs: a whole number of days, 0 keeps forever, anything else is the default', () => {
  const kl = (v) => cfgWith(`agent_walk:\n  driver: x\n  claude_args: --a\n  keep_logs: ${v}`).agentWalk.keepLogs
  assert.equal(kl(7), 7)
  assert.equal(kl(0), 0)
  assert.equal(kl(-1), 30)
  assert.equal(kl('soon'), 30)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/config.test.mjs`
Expected: FAIL — `keepLogs` missing from the parsed object.

- [ ] **Step 3: Implement**

In `agentWalkOf` add after `smoke: block.smoke ?? null,`:

```js
    keepLogs: Number.isInteger(block.keep_logs) && block.keep_logs >= 0 ? block.keep_logs : 30,
```

In its doc comment, after "`parallel` defaults to 3;", add: "`keep_logs` — days a landed feature's archived logs are kept — defaults to 30, and 0 keeps them;".

In `PROJECT.template.md`, after the `# parallel: 3 …` line add:

```
  # keep_logs: 30                  # days a merged feature's run logs stay under .builder/fleet/logs/_archive/; 0 keeps them forever
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/config.mjs PROJECT.template.md scripts/test/config.test.mjs
git commit -m "feat(config): agent_walk.keep_logs — days archived fleet logs are kept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `fleet.mjs` evicts a landed feature; the stub ships into the archive

**Files:**
- Modify: `scripts/fleet.mjs`, `scripts/test/fixtures/stub-claude.mjs`
- Test: `scripts/test/fleet.test.mjs`

**Interfaces:**
- Consumes: `features`, `specDir`, `ARCHIVE` (Task 1); `appendArchive`, `tailArchive`, `archiveLogs`, `pruneArchivedLogs`, `renderStatus(fleet, progress, last)`, `renderArchived` (Task 4); `AW.keepLogs` (Task 5).
- Produces: `fleet.json` holds only rows not landed, plus `archived: number`; CLI `--status --archived [N]`.

- [ ] **Step 1: Make the stub do what `/builder:ship` will do**

In `scripts/test/fixtures/stub-claude.mjs`:

- Header comment: change the `SHIP` line to `//   SHIP            what /builder:ship leaves: MANIFEST.md gone, SPEC.md header SHIPPED, the folder in <registry>/_archive/`.
- Imports: `import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'` and `import { join, dirname } from 'node:path'`.
- In `finish`, stage the whole registry (the spec path is gone after an archive move):

```js
    execFileSync('git', ['add', '-A', '--', dirname(spec)], { stdio: 'ignore' })
```

- Replace the `SHIP` branch:

```js
else if (step === 'SHIP') {
  rmSync(mfPath)
  writeFileSync(join(process.cwd(), spec, 'SPEC.md'), `# ${feature} — spec\n> ✅ SHIPPED 2026-09-26 — merged into main · none · 🤖 agent signed off (round 1), not human-tested\n`)
  // /builder:ship's last step: the shipped folder moves into the archive, in the ship commit.
  mkdirSync(join(process.cwd(), dirname(spec), '_archive'), { recursive: true })
  execFileSync('git', ['add', '-A', '--', spec], { stdio: 'ignore' })
  execFileSync('git', ['mv', spec, join(dirname(spec), '_archive', feature)], { stdio: 'ignore' })
}
```

- [ ] **Step 2: Update the fleet tests to the new contract, and add the new ones**

In `scripts/test/fleet.test.mjs`:

a) Extend the `node:fs` import with `utimesSync`. Replace `runFleet`'s return with an archive read, and add the helpers right after `runFleet`:

```js
/** archive.jsonl as { feature: row } — the last line per feature wins. */
function archiveOf(root) {
  const p = join(root, '.builder/fleet/archive.jsonl')
  if (!existsSync(p)) return {}
  return Object.fromEntries(readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.feature, r]))
}

/** A feature the fleet merged: gone from fleet.json, one line in archive.jsonl. Returns that line. */
function assertLanded(r, name) {
  assert.equal(r.fleet.features[name], undefined, `${name} is still a row: ${JSON.stringify(r.fleet.features[name])}`)
  assert.ok(r.archived[name], `${name} is not in archive.jsonl`)
  return r.archived[name]
}
```

and in `runFleet` change the return to:

```js
  return { ...r, fleet: existsSync(fj) ? JSON.parse(readFileSync(fj, 'utf8')) : null, calls, archived: archiveOf(root) }
```

b) Mechanical replacement of every `assert.equal(<x>.fleet.features.<name>.status, 'done'[, <x>.fleet.features.<name>.reason])`:

```bash
perl -pi -e "s/assert\.equal\((\w+)\.fleet\.features\.(\w+)\.status, 'done'(?:, [\w.]+)?\)/assertLanded(\$1, '\$2')/g" scripts/test/fleet.test.mjs
grep -n "status, 'done'" scripts/test/fleet.test.mjs
```

Expected from the grep: only `assert.equal(a.status, 'done')` (the spec→merged test), and the three `fj.features.<x>.status` lines plus `fj().features.p.status` in the inbox tests — fixed by hand in c)–f).

c) `a spec goes from spec to merged through the build, walk and ship lanes`: replace

```js
  const a = r.fleet.features.a
  assert.equal(a.status, 'done')
  assert.equal(a.runs, 8)
```

with

```js
  const a = assertLanded(r, 'a')
  assert.equal(a.runs, 8)
  assert.equal(a.target, 'main')
  assert.equal(r.fleet.archived, 1)
```

and replace the SPEC and STATUS assertions

```js
  assert.match(readFileSync(join(root, 'docs/features/a/SPEC.md'), 'utf8'), /SHIPPED/)
  …
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /\| a \| done \| ▓▓▓▓▓▓▓▓▓▓ 100% · merged \| 8 \|/)
```

with

```js
  assert.match(readFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'utf8'), /SHIPPED/)
  assert.equal(existsSync(join(root, 'docs/features/a')), false, 'the ship moved the folder into the archive')
  …
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /^1 archived \(last: a, just now\)/m)
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/a/a-01.log')), 'its logs moved with it')
  assert.equal(existsSync(join(root, '.builder/fleet/logs/a-01.log')), false)
```

(keep the lines between them unchanged).

d) `re-running resumes and retries a cleared park`: replace

```js
  assertLanded(second, 'a')
  assert.equal(second.fleet.features.a.runs, 6, 'run count continues across fleet runs')
  assert.equal(second.fleet.features.a.runsThisTime, 4, 'the cap counts this fleet run only')
```

with

```js
  const a = assertLanded(second, 'a')
  assert.equal(a.runs, 6, 'run count continues across fleet runs')
  assert.equal(a.runsThisTime, 4, 'the cap counts this fleet run only')
```

and in `a feature parked at the run cap gets a fresh cap…` replace

```js
  assertLanded(second, 'a')
  assert.equal(second.fleet.features.a.runs, 16, 'lifetime runs for the table')
  assert.equal(second.fleet.features.a.runsThisTime, 4)
```

with

```js
  const a = assertLanded(second, 'a')
  assert.equal(a.runs, 16, 'lifetime runs for the table')
  assert.equal(a.runsThisTime, 4)
```

e) `--status renders the table live…`: replace its first half

```js
  runFleet(root, ['a'], { a: HAPPY })
  const r = runFleet(root, ['--status'], {})
  assert.match(r.stdout, /\| Feature \| Status \| Progress \|/)
  assert.match(r.stdout, /\| a \| done \| ▓▓▓▓▓▓▓▓▓▓ 100% · merged \| 8 \|/)
  // b never joined the fleet, so it is not a row; the overall bar is the mean over the fleet's rows.
  assert.match(r.stdout, /1 feature\(s\): 1 done · ▓▓▓▓▓▓▓▓▓▓ 100%/)
```

with

```js
  runFleet(root, ['a'], { a: HAPPY })
  const r = runFleet(root, ['--status'], {})
  // a landed, so it is archived, not a row; b never joined the fleet.
  assert.match(r.stdout, /# builder fleet — 0 feature\(s\): none/)
  assert.match(r.stdout, /^1 archived \(last: a, just now\) · --status --archived for the latest 20$/m)
  assert.doesNotMatch(r.stdout, /\| a \|/)
```

(the second half, which writes a `b` row and checks `| b | building | … 10% · audited | 1 |`, stays.)

f) `a merge your uncommitted changes would clobber parks…`: the ship now writes `_archive/a/SPEC.md`, so the human's untracked file must sit there. Replace

```js
  writeFileSync(join(root, 'docs/features/a/SPEC.md'), 'my local edit\n') // the ship writes SPEC.md
```

with

```js
  mkdirSync(join(root, 'docs/features/_archive/a'), { recursive: true })
  writeFileSync(join(root, 'docs/features/_archive/a/SPEC.md'), 'my local edit\n') // the ship writes this path
```

and the two later references `docs/features/a/SPEC.md` in that test (the `readFileSync` assert and the `unlinkSync`) become `docs/features/_archive/a/SPEC.md`.

g) `a feature that ships after the human switched branches…`: `main:docs/features/a/SPEC.md` → `main:docs/features/_archive/a/SPEC.md`.

h) Inbox tests. In `a spec named while a fleet runs joins its queue…` replace

```js
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.equal(fj.features.a.status, 'done')
  assert.equal(fj.features.b.status, 'done')
  assert.equal(fj.features.c.status, 'done')
```

with

```js
  const fj = JSON.parse(readFileSync(join(root, '.builder/fleet/fleet.json'), 'utf8'))
  assert.deepEqual(fj.features, {}, 'every landed row left fleet.json')
  assert.deepEqual(Object.keys(archiveOf(root)).sort(), ['a', 'b', 'c'])
```

and in `a parked feature named again while the fleet runs is re-queued…` replace `assert.equal(fj().features.p.status, 'done')` with

```js
  assert.equal(fj().features.p, undefined)
  assert.ok(archiveOf(root).p)
```

i) Append the new tests:

```js
test('a feature already in the archive is refused as shipped', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, 'docs/features/_archive/z'), { recursive: true })
  writeFileSync(join(root, 'docs/features/_archive/z/SPEC.md'), '# z — spec\n> ✅ SHIPPED 2026-09-01 — PR #3 · none\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'z archived')
  const r = runFleet(root, ['z', '--dry-run'], {})
  assert.match(r.stdout, /✗ z — .*already shipped/)
})

test('a child whose dependency landed in an earlier fleet run starts at once', () => {
  const root = makeRepo(['api', 'ui'])
  program(root, ['api', 'ui'], { ui: 'api' })
  assertLanded(runFleet(root, ['api'], { api: HAPPY }), 'api')
  const r = runFleet(root, ['ui'], { ui: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assertLanded(r, 'ui')
})

test('a done row an older fleet left is archived on the next run, its logs with it', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet/logs'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/logs/old-01.log'), 'x')
  writeFileSync(join(root, '.builder/fleet/logs/old-b-01.log'), 'another feature')
  writeFileSync(
    join(root, '.builder/fleet/fleet.json'),
    JSON.stringify({ target: 'main', features: { old: { status: 'done', runs: 5, branch: 'builder/old', worktree: null, pr: '#9', reason: null, merged: 'abc1234' } } })
  )
  const r = runFleet(root, [], {})
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.fleet.features, {})
  assert.equal(r.fleet.archived, 1)
  assert.deepEqual({ ...r.archived.old, landedAt: '-' }, { feature: 'old', branch: 'builder/old', target: 'main', merged: 'abc1234', pr: '#9', runs: 5, runsThisTime: 0, landedAt: '-' })
  assert.ok(existsSync(join(root, '.builder/fleet/logs/_archive/old/old-01.log')))
  assert.ok(existsSync(join(root, '.builder/fleet/logs/old-b-01.log')), 'a feature whose name starts the same keeps its logs')
})

test('--status --archived lists the latest landings', () => {
  const root = makeRepo(['a', 'b'])
  runFleet(root, ['a', 'b'], { a: HAPPY, b: HAPPY })
  const st = runFleet(root, ['--status'], {})
  assert.match(st.stdout, /^2 archived \(last: [ab], just now\) · --status --archived for the latest 20$/m)
  const ar = runFleet(root, ['--status', '--archived', '1'], {})
  assert.equal(ar.status, 0, ar.stderr)
  assert.match(ar.stdout, /# builder fleet — archive: latest 1 of 2/)
  assert.match(ar.stdout, /\| [ab] \| [0-9a-f]{7,} \| — \| just now \|/)
  const none = runFleet(makeRepo(['c']), ['--status', '--archived'], {})
  assert.match(none.stdout, /No feature has landed from this fleet yet\./)
})

test('archived logs older than keep_logs are pruned at fleet start', () => {
  const root = makeRepo(['a'], { lines: ['keep_logs: 1'] })
  const base = join(root, '.builder/fleet/logs/_archive')
  for (const n of ['stale', 'fresh']) {
    mkdirSync(join(base, n), { recursive: true })
    writeFileSync(join(base, n, `${n}-01.log`), 'x')
  }
  const old = new Date(Date.now() - 3 * 86400000)
  utimesSync(join(base, 'stale'), old, old)
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(join(base, 'stale')), false)
  assert.ok(existsSync(join(base, 'fresh')))
  assert.ok(existsSync(join(base, 'a', 'a-01.log')), 'this run’s landing is archived after the prune')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test scripts/test/fleet.test.mjs`
Expected: many FAIL — `assertLanded` finds rows still at `status: 'done'` in `fleet.json`, and no `archive.jsonl`; the preflight of a stub-shipped feature can't find `docs/features/<f>/SPEC.md`.

- [ ] **Step 4: Implement in `scripts/fleet.mjs`**

a) Header comment: change `* State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes.` to

```
 * State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes. A feature that
 * lands leaves fleet.json for archive.jsonl, and its logs move to logs/_archive/<feature>/ (pruned
 * after agent_walk.keep_logs days); fleet.json holds only work in flight.
```

and in the usage lines add `*   node <plugin>/scripts/fleet.mjs --status --archived [N]   # the latest N landings (20)`.

b) Imports:

```js
import { laneOf, decide, loadFleet, saveFleet, fleetDir, shippedPr, renderStatus, readProgress, appendArchive, tailArchive, archiveLogs, pruneArchivedLogs, renderArchived } from './fleet-core.mjs'
import { features, specDir, ARCHIVE } from './registry.mjs'
```

c) Flags: `USAGE` becomes

```js
const USAGE = 'Usage: fleet.mjs <feature|path>… | --all [--parallel N] [--dry-run] [--status [--archived [N]]]   (named while a fleet runs: added to its queue)'
const KNOWN_FLAGS = new Set(['--all', '--parallel', '--dry-run', '--status', '--archived'])
```

and `positional`:

```js
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--parallel', '--archived'].includes(argv[i - 1]))
```

d) `--status`:

```js
if (flag('--status')) {
  const fleet = existsSync(join(DIR, 'fleet.json')) ? loadFleet(ROOT) : null
  if (flag('--archived')) console.log(renderArchived(tailArchive(ROOT, Number(opt('--archived')) || 20), fleet?.archived ?? 0))
  else console.log(fleet ? renderStatus(fleet, progressOf, tailArchive(ROOT, 1)[0] ?? null) : 'No fleet has run in this repo yet.')
  process.exit(0)
}
```

e) Reading a feature's docs finds an archived folder too — replace `readManifest` and `readSpec`:

```js
/** A feature's doc from its live folder, or its archived one once the ship commit moved it there. */
const readDoc = (base, feature, doc) => {
  const p = join(specDir(base, CFG.registry, feature), doc)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const readManifest = (base, feature) => readDoc(base, feature, 'MANIFEST.md')
const readSpec = (base, feature) => readDoc(base, feature, 'SPEC.md')
```

f) `requested()` — replace

```js
  const reg = join(ROOT, CFG.registry)
  if (!existsSync(reg)) return []
  return readdirSync(reg).filter((n) => {
```

with

```js
  return features(ROOT, CFG.registry).filter((n) => {
```

g) Right after `const TARGET = HERE`, add:

```js
/**
 * Whether a dependency has merged into the target. A row still in fleet.json answers for itself.
 * An archived row is gone from it: landed by this process (the set), or by an earlier run — then
 * the target's own tree says so. Asked of the ref, not the working tree, so it holds when the merge
 * was written onto the target while another branch was checked out.
 */
const landed = new Set()
function landedOn(dep) {
  const row = fleet.features[dep]
  if (row) return row.status === 'done'
  return landed.has(dep) || tryGit(['cat-file', '-e', `${TARGET}:${CFG.registry}/${ARCHIVE}/${dep}`]) !== null
}
```

h) Replace the three dependency filters:

- in the admission loop: `.filter((d) => fleet.features[d.name]?.status !== 'done')` → `.filter((d) => !landedOn(d.name))`
- `const pendingDeps = (f) => (f.waitsOn ?? []).filter((d) => fleet.features[d]?.status !== 'done')` → `const pendingDeps = (f) => (f.waitsOn ?? []).filter((d) => !landedOn(d))`
- in `drainInbox`: `.filter((d) => fleet.features[d]?.status !== 'done')` → `.filter((d) => !landedOn(d))`

i) Add `archiveRow` just above `let landing = Promise.resolve()`:

```js
/** A landed feature leaves fleet.json: one line in archive.jsonl, its logs under logs/_archive/. */
function archiveRow(feature) {
  const f = fleet.features[feature]
  appendArchive(ROOT, {
    feature,
    branch: f.branch,
    target: fleet.target ?? TARGET,
    merged: f.merged ?? null,
    pr: f.pr ?? null,
    runs: f.runs ?? 0,
    runsThisTime: f.runsThisTime ?? 0,
    landedAt: new Date().toISOString(),
  })
  delete fleet.features[feature]
  fleet.archived = (fleet.archived ?? 0) + 1
  landed.add(feature)
  const why = archiveLogs(ROOT, feature)
  if (why) addNote(why)
}
```

j) In `landNow`, replace the tail

```js
  if (f.worktree) addNote(`${feature} merged; its worktree ${f.worktree} was kept (it has changes) — remove it with git worktree remove`)
  save()
  return 'done'
```

with

```js
  if (f.worktree) addNote(`${feature} merged; its worktree ${f.worktree} was kept (it has changes) — remove it with git worktree remove`)
  archiveRow(feature)
  save()
  return 'done'
```

k) In `enqueue`, replace

```js
  else if (lane === 'done') Object.assign(f, { status: 'done', pr: mf.pr ?? null, reason: null })
```

with

```js
  else if (lane === 'done') {
    f.pr = mf.pr ?? null
    archiveRow(feature)
  }
```

l) Migration and retention — right after the loop that creates the `fresh` rows (`for (const f of fresh) fleet.features[f] = { … }`), add:

```js
// A row a fleet before 3.8 left at `done`, or one killed between its landing and the save that
// would have archived it, is archived now — appendArchive skips a line already written.
for (const [feature, f] of Object.entries(fleet.features)) if (f.status === 'done') archiveRow(feature)
pruneArchivedLogs(ROOT, AW.keepLogs)
```

m) Keep `readdirSync` in the `node:fs` import — `drainInbox` still uses it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/test/fleet.test.mjs scripts/test/fleet-core.test.mjs`
Expected: PASS. Then the whole suite: `node --test 'scripts/test/*.test.mjs'` — PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/fleet.mjs scripts/test/fleet.test.mjs scripts/test/fixtures/stub-claude.mjs
git commit -m "feat(fleet): a landed feature leaves fleet.json for archive.jsonl; --status --archived

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scale — a 2,000-folder archive costs routine reads nothing

**Files:**
- Create: `scripts/test/fixtures/spy-reads.mjs`, `scripts/test/archive-scale.test.mjs`

**Interfaces:**
- Consumes: `waitsOn` (program.mjs), `list-features.mjs` CLI (Task 3).
- Produces: `spy(onPath: (p: string) => void): () => void` — patches `fs.readFileSync`, `fs.readdirSync`, `fs.statSync` (and the ESM named exports via `syncBuiltinESMExports`); returns the restore function. With `SPY_OUT` set, the module self-installs and appends each path to that file (for `node --import`).

- [ ] **Step 1: Write the spy fixture**

`scripts/test/fixtures/spy-reads.mjs`:

```js
// Records every path the process reads or lists. Imported by a test, `spy(fn)` patches fs and
// returns the restore; run as `node --import <this> …` with SPY_OUT set, it logs to that file.
// syncBuiltinESMExports makes `import { readFileSync } from 'node:fs'` in other modules see the patch.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const append = fs.appendFileSync

export function spy(onPath) {
  const saved = {}
  for (const k of ['readFileSync', 'readdirSync', 'statSync']) {
    saved[k] = fs[k]
    fs[k] = function (p, ...rest) {
      onPath(String(p))
      return saved[k].call(this, p, ...rest)
    }
  }
  syncBuiltinESMExports()
  return () => {
    Object.assign(fs, saved)
    syncBuiltinESMExports()
  }
}

if (process.env.SPY_OUT) spy((p) => append(process.env.SPY_OUT, `${p}\n`))
```

- [ ] **Step 2: Write the test**

`scripts/test/archive-scale.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spy } from './fixtures/spy-reads.mjs'
import { waitsOn } from '../program.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIST = join(HERE, '..', 'list-features.mjs')
const SPY = pathToFileURL(join(HERE, 'fixtures', 'spy-reads.mjs')).href
const REG = 'docs/features'
const N = 2000

/** A live program (api archived, ui in flight, ui depending on api and on archived f7) over N archived features. */
function bigRepo() {
  const root = mkdtempSync(join(tmpdir(), 'scale-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  const put = (p, body) => {
    mkdirSync(dirname(join(root, REG, p)), { recursive: true })
    writeFileSync(join(root, REG, p), body)
  }
  for (let i = 0; i < N; i++) put(`_archive/f${i}/SPEC.md`, `# f${i} — spec\n> ✅ SHIPPED 2026-09-01 — PR #${i} · none\n`)
  put('_archive/api/SPEC.md', '# api — spec\n> ✅ SHIPPED 2026-09-02 — PR #1 · none\n')
  put('big/MANIFEST.md', 'tier: program\nnext: x\nchild: api — building\nchild: ui — spec\n')
  put('big/PROGRAM.md', '# big — program\n\n## Children\n| # | Feature (folder) | Size | Apps | One line | Depends on |\n|---|---|---|---|---|---|\n| 1 | api | md | app | x | — |\n| 2 | ui | md | app | y | api, f7 |\n')
  put('ui/MANIFEST.md', 'size: md\nstate: spec\nnext: x\n')
  return root
}

const insideArchive = (paths) => paths.filter((p) => p.includes(`/${REG}/_archive/`))

test('waitsOn over a big archive reads nothing inside it', () => {
  const root = bigRepo()
  const seen = []
  const restore = spy((p) => seen.push(p))
  let deps
  try {
    deps = waitsOn(root, REG, 'ui')
  } finally {
    restore()
  }
  assert.deepEqual(deps, [])
  assert.ok(seen.some((p) => p.endsWith('big/MANIFEST.md')), 'the spy saw the program read')
  assert.deepEqual(insideArchive(seen), [])
})

test('list-features --json and --status over a big archive read nothing inside it', () => {
  const root = bigRepo()
  for (const mode of ['--json', '--status']) {
    const out = join(root, `spy${mode}.log`)
    const r = spawnSync('node', ['--import', SPY, LIST, mode], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, SPY_OUT: out } })
    assert.equal(r.status, 0, r.stderr)
    const seen = readFileSync(out, 'utf8').split('\n').filter(Boolean)
    assert.ok(seen.some((p) => p.endsWith('ui/MANIFEST.md')), `${mode}: the spy saw the live read`)
    assert.deepEqual(insideArchive(seen), [], mode)
    if (mode === '--status') assert.match(r.stdout, new RegExp(`📦 ${N + 1} shipped features archived`))
  }
})
```

- [ ] **Step 3: Run it**

Run: `node --test scripts/test/archive-scale.test.mjs`
Expected: PASS (Tasks 1 and 3 already made it true). To confirm the test can fail, temporarily change `features()` in `scripts/registry.mjs` to drop the `!/^[_.]/.test(e.name)` filter, re-run — Expected: FAIL listing `_archive/…` paths — then restore it and re-run to PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/test/fixtures/spy-reads.mjs scripts/test/archive-scale.test.mjs
git commit -m "test(archive): a 2,000-folder archive is never read by routine listing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Skills, docs and the 3.8.0 release notes

**Files:**
- Modify: `skills/ship/SKILL.md`, `skills/brainstorm/SKILL.md`, `skills/resume/SKILL.md`, `skills/resume/REFERENCE.md`, `skills/status/SKILL.md`, `skills/fleet/SKILL.md`, `skills/agent/SKILL.md`, `skills/help/SKILL.md`, `skills/update/SKILL.md`, `README.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`, `docs/specs/2026-09-29-fleet-archive-design.md`

**Interfaces:**
- Consumes: the behaviour of Tasks 1–7; the names `_archive`, `registry.mjs --sweep`, `list-features.mjs --archived`, `fleet.mjs --status --archived`, `keep_logs`.

- [ ] **Step 1: `skills/ship/SKILL.md` §At ship**

After step 4 (the program-child step, ending "…flip `PROGRAM.md`'s own header the same way."), add:

```markdown
5. **Archive the folder** — `git mv <registry>/<feature> <registry>/_archive/<feature>`, in this same
   commit, so it reaches the target exactly when `SHIPPED` does (the PR's merge, or the fleet's). A
   program whose header step 4 just flipped moves too: `git mv <registry>/<program>
   <registry>/_archive/<program>`. ⛔ If `<registry>/_archive/<feature>` already exists, stop before
   committing and name the collision — a second folder of that name would make "has it shipped?"
   answer for the wrong feature. Nothing routine reads the archive; `list-features.mjs --archived`
   lists it.
```

Change the ship hand-off line to:

```
📍 <feature>: shipped — header flipped, manifest and workspace removed, archived at <registry>/_archive/<feature>
```

In `skills/resume/REFERENCE.md` §Condense, extend the **ship** row's "What happens" cell with `; git mv the folder into <registry>/_archive/`.

- [ ] **Step 2: `skills/brainstorm/SKILL.md` — name reuse**

In **The folder.** paragraph, after "Then **look for that name under the config's `registry:`**.", insert:

```markdown
A folder of that name under `<registry>/_archive/` is a **shipped** feature — refuse the name, say
when it shipped (its header line), and suggest `<name>-v2`; follow-on work is a new feature whose
SPEC links the archived one.
```

- [ ] **Step 3: `skills/resume/SKILL.md` and `REFERENCE.md`**

In `SKILL.md` Step 1, before the table, add:

```markdown
**`--path` names a folder that is gone, and `<registry>/_archive/<name>/` exists** → it shipped. Say in
one line `<name> shipped <date> — archived at <registry>/_archive/<name>; nothing to resume` (the date
from its header) and stop.
```

In `SKILL.md` §Converting a folder from an earlier pipeline, after the paragraph beginning "Follow **REFERENCE §Condense", add:

```markdown
A legacy folder whose status is SHIPPED is not converted: `git mv` it into `<registry>/_archive/`.
```

In `REFERENCE.md` §Where things live, add under the `<registry>/<program>/` block:

```
<registry>/_archive/<feature>/       shipped: moved here by /builder:ship in the ship commit. Only the
  SPEC.md (PROGRAM.md for a program)  condensed SPEC. Never a row, never read by a routine step;
                                     `list-features.mjs --archived` lists it.
```

- [ ] **Step 4: `skills/status/SKILL.md`, `skills/fleet/SKILL.md`, `skills/agent/SKILL.md`, `skills/help/SKILL.md`, `skills/update/SKILL.md`**

`status/SKILL.md` §2, after "the table, then any branch-switch and needs-attention lines under it", add: `, and the 📦 archived-count line when there is one`.

`fleet/SKILL.md` §1, append to the section:

```markdown
A feature that landed is not a row: it is counted in the line under the heading
(`412 archived (last: …) · --status --archived for the latest 20`). `node <builder>/scripts/fleet.mjs
--status --archived [N]` lists the latest N landings — relay it the same way when asked what merged.
```

and in §5 replace the **done** bullet with:

```markdown
- **done** — merged into this branch, and archived: the row leaves the table for
  `.builder/fleet/archive.jsonl`, the spec folder is under `<registry>/_archive/`, and its logs under
  `.builder/fleet/logs/_archive/` (kept `agent_walk.keep_logs` days, 30 by default). `git log --merges`
  lists them. Test the result here; push when you're happy. `git revert -m 1 <merge>` takes one back out.
```

`agent/SKILL.md`: after the paragraph that describes the picker's source (`list-features.mjs --json`), add one line: `Archived (shipped) features are never offered — they are not in that list.`

`help/SKILL.md`: in the Q&A bullets after **Where is the plan?**, add:

```markdown
- **Where did a shipped spec go?** `<registry>/_archive/<name>/SPEC.md` — `/builder:ship` moves it
  there in the ship commit. `list-features.mjs --archived` lists them, newest first.
```

`update/SKILL.md` §3, append:

```markdown
From 3.8.0 a shipped folder lives under `<registry>/_archive/`. When `list-features.mjs --status` ends
with `🔒 N shipped, not shown — … --sweep …`, name `node <builder>/scripts/registry.mjs --sweep` once:
it `git mv`s them and leaves the commit to the human.
```

- [ ] **Step 5: README, spec, CHANGELOG, version**

`README.md` scripts tree, after the `list-features.mjs` line, add:

```
    registry.mjs             the registry's layout: in-flight folders vs <registry>/_archive/; --sweep archives old shipped ones
```

`docs/specs/2026-09-29-fleet-archive-design.md` §Eviction at landing step 1: the row is `{ feature, branch, target, merged, pr, runs, runsThisTime, landedAt }` (add `runsThisTime`).

`.claude-plugin/plugin.json`: `"version": "3.8.0"`. Check `.claude-plugin/marketplace.json` for a version field (`grep -n version .claude-plugin/marketplace.json`); bump it to `3.8.0` if one exists.

`CHANGELOG.md`, above `## 3.7.0`:

```markdown
## 3.8.0

**Finished features are archived, so nothing routine slows down as the count of shipped work grows.**

- **The registry.** `/builder:ship` moves a shipped folder into `<registry>/_archive/<feature>/` in the
  ship commit (a program follows when its last child ships). `list-features.mjs` — behind
  `/builder:status`, `/builder:resume` and `/builder:agent` — program dependencies,
  `check-obligations --all` and `fleet --all` read only in-flight folders; "has X shipped?" is one path
  check. `list-features.mjs --archived [--limit N]` lists the archive, newest first.
- **The fleet.** A feature that lands leaves `fleet.json` for `.builder/fleet/archive.jsonl`; its logs
  move to `logs/_archive/<feature>/` and are pruned after `agent_walk.keep_logs` days (30). `--status`
  shows work in flight plus one `N archived` line; `--status --archived [N]` lists the latest landings.
- **Migration.** An existing `fleet.json` archives its `done` rows the first time it loads. Folders
  that shipped before 3.8 stay where they are until you run `node <builder>/scripts/registry.mjs
  --sweep` once — it `git mv`s them and leaves the commit to you.
- `/builder:brainstorm` refuses a feature name that is already archived and suggests `<name>-v2`.
```

- [ ] **Step 6: Verify and commit**

Run: `node --test 'scripts/test/*.test.mjs'` — Expected: PASS.
Run: `grep -rn "_archive" skills | wc -l` — Expected: ≥ 8 (every file edited above names it).

```bash
git add skills README.md CHANGELOG.md .claude-plugin docs/specs/2026-09-29-fleet-archive-design.md
git commit -m "feat(archive): ship archives the folder; fleet and registry archive documented; 3.8.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
