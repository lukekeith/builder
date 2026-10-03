# Agent walk + fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an orchestrator take a batch of written specs through the whole `/builder:*` pipeline unattended, ending each feature at a draft PR with agent walk evidence, or parked with a reason.

**Architecture:** Two new pipeline flags (`--agent-walk`, `--no-dev-env`) make every step headless-safe; a new `/builder:agent-walk` skill replaces the human walk with a separately-labelled agent verdict; `scripts/fleet.mjs` creates one worktree per spec (continuing on a feature's own branch when it is already underway), runs `claude -p "/builder:resume …"` in a parallel build lane and a serial walk lane, and reads progress only from each worktree's `MANIFEST.md`. The pure decisions live in `scripts/fleet-core.mjs` so they can be tested without processes. `/builder:fleet` (scripted) and `/builder:agent` (pick from a list) are two front doors to that one engine.

**Tech Stack:** Node ≥ 18 standard library only (`node:test`, `node:child_process`, `node:fs`), POSIX shell, `git`, `gh`, `claude` CLI. Skills are Markdown.

**Spec:** `docs/specs/2026-09-26-agent-walk-fleet-design.md`

## Global Constraints

- **No dependencies.** No `package.json`, no `npm install`, no network in scripts. Node stdlib and POSIX shell only (CONTRIBUTING).
- **Project-agnostic.** The plugin names no app, framework or browser tool; every project fact comes from `.claude/builder.md`.
- **Default behaviour unchanged.** Without `--agent-walk`, every human gate and question behaves exactly as in 2.4.0.
- **`/builder:signoff` stays `disable-model-invocation: true`.** No task changes that line.
- **An agent verdict is never a human sign-off:** manifest `walk: agent-pass YYYY-MM-DD <sha>`, SPEC header `🤖 AGENT-VERIFIED … not human-tested`. Never `✅ SIGNED OFF`.
- **An agent-verified PR is only ever a draft.** `gh pr ready` requires a human sign-off.
- **Manifest keys are `[a-z-]+`** (the parser's rule): the new keys are `blocked:` and `agent-walk:`. The config key is `agent_walk` (config parser allows `_`).
- **Accepted features:** any step before the PR (`spec` … `verified`), not blocked. A manifest `branch:` other than the base branch is continued on; else `builder/<feature>`. `--all` alone keeps to `spec`/`aligned`/`audited`.
- **Guards:** per-run timeout 45 min (`FLEET_RUN_TIMEOUT_MS` overrides), run cap 12 per feature, retry a failed run once, 2 agent walk rounds, default `parallel: 3`, branch `builder/<feature>`, worktrees default `../<repo-dir>.fleet`.
- **Version:** 2.5.0, minor — the config block is optional and additive.
- **Commits:** conventional style, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:** `node --test 'scripts/test/*.test.mjs'` must pass; `claude plugin validate .` and `scripts/workspace --self-test` stay green.

## Review Focus

1. **A child `claude` inheriting `CLAUDE_PROJECT_DIR`** from a fleet launched inside a Claude session would read the *main checkout's* config and manifests, not its worktree's — every run would appear to make no progress. Expected: the child env never carries it. Test: Task 4, `child runs never see CLAUDE_PROJECT_DIR`.
2. **Two walk-lane features overlapping** would fight over the one dev env. Expected: walk-lane runs never overlap in time, even while builds finish concurrently. Test: Task 4, `walk lane runs one feature at a time`.
3. **A killed or re-run fleet** must not restart finished work or lose parked reasons. Expected: `done` skipped, a parked feature retried only once its `blocked:` line is gone, counters continue. Test: Task 4, `re-running resumes and retries a cleared park`.
4. **`agent_walk.stop` not running after a park or failure** would leave a dev server holding the port for the next feature. Expected: `stop` runs after every walk-lane feature. Test: Task 4, `reset and stop run around each walk, even on park`.
5. **An existing worktree on the wrong branch, or a feature's branch checked out in the main folder** (a user's own checkout at the default path) must never be reused. Expected: that spec is refused with the reason; others proceed. Tests: Task 4, `a worktree on another branch is refused` and `refusals: uncommitted, already has a PR, branch checked out here`.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/manifest.mjs` (new) | Parse `MANIFEST.md`; `isSet`. Shared by `list-features.mjs` and the fleet. |
| `scripts/config.mjs` (modify) | Parse the optional `agent_walk:` block into `cfg.agentWalk`. |
| `scripts/fleet-core.mjs` (new) | Pure fleet logic: `laneOf`, `decide`, `loadFleet`, `saveFleet`, `renderStatus`, `fleetDir`. |
| `scripts/fleet.mjs` (new) | The runner: CLI, pre-flight, worktrees, `claude -p` processes, lanes, lock, hooks. |
| `scripts/list-features.mjs` (modify) | Import `parseManifest`; show parked and agent-walked states. |
| `scripts/test/*.test.mjs` (new) | `node:test` suites; `scripts/test/fixtures/stub-claude.mjs` stands in for `claude`. |
| `skills/agent-walk/SKILL.md` (new) | The agent walk. |
| `skills/fleet/SKILL.md` (new) | Scripted front door for `fleet.mjs` (`--all`, named features, overnight). |
| `skills/agent/SKILL.md` (new) | Interactive front door: multi-select over unfinished features, then the fleet. |
| `skills/resume/SKILL.md`, `skills/resume/REFERENCE.md` (modify) | Flags, `--agent-walk` rules, `blocked:`, PR-lock amendment, draft ship. |
| `skills/build`, `verify`, `signoff`, `init` SKILL.md (modify) | Honour the new flags and the agent verdict. |
| `PROJECT.template.md`, `README.md`, `skills/help/SKILL.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `.claude-plugin/plugin.json` | Document and release. |

---

### Task 1: Shared manifest parser

**Files:**
- Create: `scripts/manifest.mjs`
- Modify: `scripts/list-features.mjs:86-104` (remove local `parseManifest`, import it)
- Test: `scripts/test/manifest.test.mjs`

**Interfaces:**
- Produces: `parseManifest(text: string) → Record<string,string> & { children?: string[] }`, `isSet(v: string|undefined|null) → boolean` (false for absent, `''`, `none`).

- [ ] **Step 1: Write the failing test**

`scripts/test/manifest.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest, isSet } from '../manifest.mjs'

test('parses key/value lines, keeps a PR reference, drops comments', () => {
  const mf = parseManifest(
    'state: built   # trailing comment\npr: #12\nhold: "PR #9 must land first"\nchild: a — spec\nchild: b — shipped\n'
  )
  assert.equal(mf.state, 'built')
  assert.equal(mf.pr, '#12')
  assert.equal(mf.hold, '"PR #9 must land first"')
  assert.deepEqual(mf.children, ['a — spec', 'b — shipped'])
})

test('reads the new blocked: and agent-walk: keys', () => {
  const mf = parseManifest('blocked: "plan wants to split — clears when you split it"\nagent-walk: on 2026-09-26\n')
  assert.equal(mf.blocked, '"plan wants to split — clears when you split it"')
  assert.equal(mf['agent-walk'], 'on 2026-09-26')
})

test('isSet treats absent, empty and none as unset', () => {
  assert.equal(isSet(undefined), false)
  assert.equal(isSet(null), false)
  assert.equal(isSet(''), false)
  assert.equal(isSet('none'), false)
  assert.equal(isSet('#4'), true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: FAIL — `Cannot find module '…/scripts/manifest.mjs'`.

- [ ] **Step 3: Create `scripts/manifest.mjs`**

```js
/**
 * MANIFEST.md — the ~12-line `key: value` file every builder feature carries. Shared by
 * list-features.mjs and the fleet, so both read a manifest the same way.
 *
 * A `#` starts a comment only when it is set off from the value — two or more spaces before it,
 * or a space after it. A single space plus `#<something>` is a PR reference, not a comment:
 * `pr: #1234` and `hold: "PR #1179 must land first"` both keep their `#`. `child:` repeats into
 * `children[]`.
 */
export const parseManifest = (text) => {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s{2,}#.*$|\s+#\s.*$/, '').trim()
    const m = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, v] = m
    if (k === 'child') (out.children ??= []).push(v)
    else out[k] = v
  }
  return out
}

/** A manifest value that means "nothing": absent, empty, or the literal `none`. */
export const isSet = (v) => v != null && v !== '' && v !== 'none'
```

- [ ] **Step 4: Point `list-features.mjs` at it**

In `scripts/list-features.mjs`, delete the whole block from the comment line `/**` above `const parseManifest = (text) => {` (starts `* \`key: value\` lines; a trailing …`) through the function's closing `}` (lines 86–104), and add to the imports at the top:

```js
import { parseManifest, isSet } from './manifest.mjs'
```

- [ ] **Step 5: Run the tests and the script**

Run: `node --test 'scripts/test/*.test.mjs' && node scripts/list-features.mjs --json >/dev/null; echo $?`
Expected: tests PASS. The script exits `2` with "No .claude/builder.md" (this repo has no config) — that proves it still loads and imports cleanly.

- [ ] **Step 6: Commit**

```bash
git add scripts/manifest.mjs scripts/list-features.mjs scripts/test/manifest.test.mjs
git commit -m "refactor: share the manifest parser between list-features and the fleet"
```

---

### Task 2: `agent_walk` in the config

**Files:**
- Modify: `scripts/config.mjs` (add `agentWalkOf`, add `agentWalk` to `loadConfig`'s return)
- Test: `scripts/test/config.test.mjs`

**Interfaces:**
- Consumes: `loadConfig(root)` (existing).
- Produces: `cfg.agentWalk: null | { driver: string|null, claudeArgs: string|null, worktrees: string|null, parallel: number, reset: string|null, stop: string|null }`.

- [ ] **Step 1: Write the failing test**

`scripts/test/config.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config.mjs'

const APPS = 'apps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto'
const cfgWith = (extra) => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), `---\nproject: t\n${APPS}\n${extra}\n---\nbody\n`)
  return loadConfig(root)
}

test('no agent_walk block → null', () => {
  assert.equal(cfgWith('').agentWalk, null)
})

test('agent_walk parsed, with defaults for what is left out', () => {
  const cfg = cfgWith('agent_walk:\n  driver: the Playwright MCP tools\n  claude_args: --permission-mode bypassPermissions')
  assert.deepEqual(cfg.agentWalk, {
    driver: 'the Playwright MCP tools',
    claudeArgs: '--permission-mode bypassPermissions',
    worktrees: null,
    parallel: 3,
    reset: null,
    stop: null,
  })
})

test('parallel, worktrees and hooks are read', () => {
  const cfg = cfgWith(
    'agent_walk:\n  driver: x\n  claude_args: --a\n  worktrees: ../w\n  parallel: 5\n  reset: make db-reset\n  stop: make down'
  )
  assert.equal(cfg.agentWalk.parallel, 5)
  assert.equal(cfg.agentWalk.worktrees, '../w')
  assert.equal(cfg.agentWalk.reset, 'make db-reset')
  assert.equal(cfg.agentWalk.stop, 'make down')
})

test('a template placeholder left in the block means unconfigured', () => {
  const cfg = cfgWith('agent_walk:\n  driver: <how the agent drives the UI>\n  claude_args: --a')
  assert.equal(cfg.agentWalk, null)
})

test('the rest of the config is unaffected', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a')
  assert.equal(cfg.ok, true)
  assert.deepEqual(cfg.appNames, ['app'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/test/config.test.mjs`
Expected: FAIL — `agentWalk` is `undefined`, not `null`/the object.

- [ ] **Step 3: Implement**

In `scripts/config.mjs`, inside `loadConfig`'s returned object, after the `design:` line add:

```js
    agentWalk: agentWalkOf(fm.agent_walk),
```

and after the `unfilled` function add:

```js
/**
 * The optional `agent_walk:` block — what an unattended /builder:fleet run needs. Absent, not a
 * map, or still carrying a template `<placeholder>` → null, and `--agent-walk` refuses. `parallel`
 * defaults to 3; `worktrees` is resolved by the fleet (default: a sibling of the repo).
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
  }
}
```

(`agentWalkOf` is a module-level `const`; `loadConfig` only calls it at run time, after the module has initialised, so declaring it below `loadConfig` is safe — the same pattern `unfilled` already uses.)

- [ ] **Step 4: Run the tests**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add scripts/config.mjs scripts/test/config.test.mjs
git commit -m "feat: config reads the optional agent_walk block"
```

---

### Task 3: Fleet core — lanes, decisions, state

**Files:**
- Create: `scripts/fleet-core.mjs`
- Test: `scripts/test/fleet-core.test.mjs`

**Interfaces:**
- Consumes: `parseManifest`, `isSet` from `scripts/manifest.mjs`.
- Produces:
  - `laneOf(mf) → 'blocked' | 'done' | 'build' | 'walk' | 'unknown'`
  - `decide({ lane, manifestText, exit, failures, runs, cap, progressed }) → { action: 'retry' | 'again' | 'handoff' | 'done' | 'park' | 'fail', reason?: string, pr?: string|null }` — `exit` is the process exit code, or `null` on timeout; `failures` = consecutive failed runs *before* this one.
  - `fleetDir(root) → string` (`<root>/.builder/fleet`)
  - `loadFleet(root) → { features: Record<string, FeatureRow>, notes?: string[] }`
  - `saveFleet(root, fleet) → void` (atomic `fleet.json`, re-renders `STATUS.md`, ensures `.builder/.gitignore`)
  - `renderStatus(fleet) → string`
  - `FeatureRow = { status: 'queued'|'building'|'awaiting-walk'|'walking'|'done'|'parked'|'failed', runs: number, branch: string, worktree: string|null, pr: string|null, reason: string|null, log?: string, evidence?: string }`

- [ ] **Step 1: Write the failing test**

`scripts/test/fleet-core.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laneOf, decide, loadFleet, saveFleet, renderStatus, fleetDir } from '../fleet-core.mjs'

test('laneOf routes each state', () => {
  assert.equal(laneOf({ state: 'spec' }), 'build')
  assert.equal(laneOf({ state: 'building' }), 'build')
  assert.equal(laneOf({ state: 'building', ready: 'pending "dev env (fleet walk lane)"' }), 'walk')
  assert.equal(laneOf({ state: 'built' }), 'walk')
  assert.equal(laneOf({ state: 'verified' }), 'walk')
  assert.equal(laneOf({ state: 'verified', pr: '#3' }), 'done')
  assert.equal(laneOf({ state: 'shipped' }), 'done')
  assert.equal(laneOf({ state: 'audited', blocked: '"x"' }), 'blocked')
  assert.equal(laneOf({ state: 'audited', blocked: 'none' }), 'build')
  assert.equal(laneOf({ state: 'weird' }), 'unknown')
})

const base = { lane: 'build', exit: 0, failures: 0, runs: 1, cap: 12, progressed: true }
const mf = (s) => `size: md\n${s}\nnext: x\n`

test('a failed run is retried once, then fails', () => {
  assert.deepEqual(decide({ ...base, exit: 3, manifestText: mf('state: spec') }), { action: 'retry' })
  const d = decide({ ...base, exit: 3, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /failed \(exit 3\) twice/)
})

test('a timeout counts as a failure', () => {
  const d = decide({ ...base, exit: null, failures: 1, manifestText: mf('state: spec') })
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /timed out twice/)
})

test('blocked parks with the reason, unquoted', () => {
  const d = decide({ ...base, manifestText: mf('state: audited\nblocked: "plan wants to split"') })
  assert.deepEqual(d, { action: 'park', reason: 'plan wants to split' })
})

test('a PR means done', () => {
  assert.deepEqual(decide({ ...base, lane: 'walk', manifestText: mf('state: verified\npr: #7') }), { action: 'done', pr: '#7' })
})

test('the build lane hands off once the feature needs the dev env', () => {
  const d = decide({ ...base, manifestText: mf('state: building\nready: pending "dev env (fleet walk lane)"') })
  assert.deepEqual(d, { action: 'handoff' })
})

test('no progress parks', () => {
  const d = decide({ ...base, progressed: false, manifestText: mf('state: planned') })
  assert.equal(d.action, 'park')
  assert.match(d.reason, /no progress/)
})

test('the run cap parks', () => {
  const d = decide({ ...base, runs: 12, manifestText: mf('state: planned') })
  assert.deepEqual(d, { action: 'park', reason: 'run cap (12) reached' })
})

test('progress under the cap runs again', () => {
  assert.deepEqual(decide({ ...base, manifestText: mf('state: planned') }), { action: 'again' })
})

test('a missing manifest or unknown state parks', () => {
  assert.equal(decide({ ...base, manifestText: null }).action, 'park')
  assert.match(decide({ ...base, manifestText: mf('state: weird') }).reason, /weird/)
})

test('saveFleet writes fleet.json atomically, STATUS.md, and the .builder ignore', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-'))
  const fleet = {
    features: {
      b: { status: 'parked', runs: 2, branch: 'builder/b', worktree: '/w/b', pr: null, reason: 'x | y' },
      a: { status: 'done', runs: 7, branch: 'builder/a', worktree: '/w/a', pr: '#1', reason: null },
    },
    notes: ['No agent_walk.reset — dev-DB state accumulates from one walk to the next.'],
  }
  saveFleet(root, fleet)
  assert.deepEqual(loadFleet(root), fleet)
  assert.equal(existsSync(join(fleetDir(root), 'fleet.json.tmp')), false)
  assert.equal(readFileSync(join(root, '.builder/.gitignore'), 'utf8'), '*\n')
  const status = readFileSync(join(fleetDir(root), 'STATUS.md'), 'utf8')
  assert.match(status, /2 feature\(s\): 1 done · 1 parked|2 feature\(s\): 1 parked · 1 done/)
  assert.ok(status.indexOf('| a |') < status.indexOf('| b |'), 'rows sorted by feature')
  assert.match(status, /x \\\| y/, 'pipes escaped')
  assert.match(status, /- No agent_walk.reset/)
})

test('loadFleet on a fresh repo is empty', () => {
  assert.deepEqual(loadFleet(mkdtempSync(join(tmpdir(), 'fc-'))), { features: {} })
})

test('renderStatus with nothing in it', () => {
  assert.match(renderStatus({ features: {} }), /0 feature\(s\): none/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/test/fleet-core.test.mjs`
Expected: FAIL — cannot find `../fleet-core.mjs`.

- [ ] **Step 3: Implement `scripts/fleet-core.mjs`**

```js
/**
 * The fleet's decisions, kept free of processes and git so they can be tested directly.
 * fleet.mjs does the side effects; this module says what a manifest and a finished run MEAN.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from './manifest.mjs'

const BUILD_STATES = new Set(['spec', 'aligned', 'audited', 'planned', 'building'])
const WALK_STATES = new Set(['built', 'signed-off', 'verified'])
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')

/**
 * Which lane a feature belongs in. `building` with `ready: pending` is every phase closed and only
 * walk readiness left — that needs the dev env, so it is walk-lane work.
 */
export function laneOf(mf) {
  if (isSet(mf.blocked)) return 'blocked'
  if (isSet(mf.pr) || mf.state === 'shipped') return 'done'
  if (mf.state === 'building' && /^pending/.test(mf.ready ?? '')) return 'walk'
  if (BUILD_STATES.has(mf.state)) return 'build'
  if (WALK_STATES.has(mf.state)) return 'walk'
  return 'unknown'
}

/** What one finished `claude -p` run means for its feature. See the plan's Task 3 interface. */
export function decide({ lane, manifestText, exit, failures, runs, cap, progressed }) {
  if (exit !== 0) {
    const what = exit === null ? 'timed out' : `failed (exit ${exit})`
    return failures >= 1 ? { action: 'fail', reason: `run ${what} twice` } : { action: 'retry' }
  }
  if (manifestText == null) return { action: 'park', reason: 'MANIFEST.md missing after the run' }
  const mf = parseManifest(manifestText)
  const next = laneOf(mf)
  if (next === 'blocked') return { action: 'park', reason: unquote(mf.blocked) }
  if (next === 'done') return { action: 'done', pr: mf.pr ?? null }
  if (next === 'unknown') return { action: 'park', reason: `manifest state '${mf.state ?? ''}' is not one the fleet knows` }
  if (lane === 'build' && next === 'walk') return { action: 'handoff' }
  if (!progressed) return { action: 'park', reason: 'no progress — the run changed neither MANIFEST.md nor HEAD' }
  if (runs >= cap) return { action: 'park', reason: `run cap (${cap}) reached` }
  return { action: 'again' }
}

export const fleetDir = (root) => join(root, '.builder', 'fleet')

export function loadFleet(root) {
  const p = join(fleetDir(root), 'fleet.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { features: {} }
}

/** Atomic: a fleet killed mid-write leaves the previous fleet.json, never half of one. */
export function saveFleet(root, fleet) {
  const dir = fleetDir(root)
  mkdirSync(dir, { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const tmp = join(dir, 'fleet.json.tmp')
  writeFileSync(tmp, JSON.stringify(fleet, null, 2) + '\n')
  renameSync(tmp, join(dir, 'fleet.json'))
  writeFileSync(join(dir, 'STATUS.md'), renderStatus(fleet))
}

export function renderStatus(fleet) {
  const rows = Object.entries(fleet.features).sort(([a], [b]) => a.localeCompare(b))
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  const counts = {}
  for (const [, f] of rows) counts[f.status] = (counts[f.status] ?? 0) + 1
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ')
  const lines = [
    `# builder fleet — ${rows.length} feature(s): ${summary || 'none'}`,
    '',
    '| Feature | Status | Runs | PR | Reason | Evidence | Worktree |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const [name, f] of rows)
    lines.push(`| ${cell(name)} | ${cell(f.status)} | ${f.runs ?? 0} | ${cell(f.pr)} | ${cell(f.reason)} | ${cell(f.evidence)} | ${cell(f.worktree)} |`)
  if (fleet.notes?.length) lines.push('', ...fleet.notes.map((n) => `- ${n}`))
  return lines.join('\n') + '\n'
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet-core.mjs scripts/test/fleet-core.test.mjs
git commit -m "feat: fleet core — lanes, run decisions, resumable state"
```

---

### Task 4: The fleet runner

**Files:**
- Create: `scripts/fleet.mjs`
- Create: `scripts/test/fixtures/stub-claude.mjs` (executable)
- Test: `scripts/test/fleet.test.mjs`

**Interfaces:**
- Consumes: `requireConfig` (`cfg.root`, `cfg.registry`, `cfg.agentWalk`), `parseManifest`, everything Task 3 produces.
- Produces (CLI): `node scripts/fleet.mjs <feature|path>… | --all [--parallel N] [--dry-run] [--status]`. Named features may be at any step before the PR; `--all` takes only `spec`/`aligned`/`audited`. Exit 0 when every feature ends `done`, 1 otherwise, 2 on bad config/args, 3 when another fleet holds the lock.
- Produces (child contract): build-lane prompt `/builder:resume --path <registry>/<feature> --agent-walk --no-dev-env`; walk-lane prompt `/builder:resume --path <registry>/<feature> --agent-walk`; `cwd` = the worktree; `CLAUDE_PROJECT_DIR` removed from the env; args = `-p <prompt>` then `agent_walk.claude_args` split on whitespace. Env overrides: `FLEET_CLAUDE` (binary), `FLEET_RUN_TIMEOUT_MS`.

- [ ] **Step 1: Write the stub `claude`**

`scripts/test/fixtures/stub-claude.mjs`:

```js
#!/usr/bin/env node
// Stands in for `claude -p` in the fleet tests. The scenario file maps a feature to a list of
// steps; each call applies the next one to the manifest in cwd and logs start/end to calls.log.
//   <state>         set state:        READY-PENDING  state: building + ready: pending
//   BLOCK:<reason>  set blocked:      PR:<#n>        set pr:
//   NOOP            change nothing    FAIL           exit 3        HANG   never exit
//   SLOW:<step>     wait 150 ms, then <step>
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const prompt = process.argv[process.argv.indexOf('-p') + 1]
const spec = /--path (\S+)/.exec(prompt)[1]
const feature = spec.split('/').pop()
const S = process.env.STUB_STATE
const scenario = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'))[feature] ?? []
const countFile = join(S, `${feature}.count`)
const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0
writeFileSync(countFile, String(n + 1))
let step = scenario[n] ?? 'NOOP'
const lane = prompt.includes('--no-dev-env') ? 'build' : 'walk'
const log = (s) => appendFileSync(join(S, 'calls.log'), `${s}\n`)
log(`start ${feature} ${lane} ${Date.now()} ${step} project_dir=${process.env.CLAUDE_PROJECT_DIR ?? '-'}`)

const mfPath = join(process.cwd(), spec, 'MANIFEST.md')
const set = (k, v) => {
  let t = readFileSync(mfPath, 'utf8')
  const re = new RegExp(`^${k}:.*$`, 'm')
  t = re.test(t) ? t.replace(re, `${k}: ${v}`) : `${t.trimEnd()}\n${k}: ${v}\n`
  writeFileSync(mfPath, t)
}
const finish = (code = 0) => {
  log(`end ${feature} ${lane} ${Date.now()}`)
  process.exit(code)
}

if (step.startsWith('SLOW:')) {
  step = step.slice(5)
  await new Promise((r) => setTimeout(r, 150))
}
if (step === 'HANG') await new Promise(() => setInterval(() => {}, 1e6))
if (step === 'FAIL') finish(3)
if (step === 'NOOP') finish(0)
if (step.startsWith('BLOCK:')) set('blocked', step.slice(6))
else if (step.startsWith('PR:')) set('pr', step.slice(3))
else if (step === 'READY-PENDING') {
  set('state', 'building')
  set('ready', 'pending "dev env (fleet walk lane)"')
} else set('state', step)
finish(0)
```

Run: `chmod +x scripts/test/fixtures/stub-claude.mjs`

- [ ] **Step 2: Write the failing integration tests**

`scripts/test/fleet.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLEET = join(HERE, '..', 'fleet.mjs')
const STUB = join(HERE, 'fixtures', 'stub-claude.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

function makeRepo(features, { reset, stop } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  const hooks = [reset && `  reset: ${reset}`, stop && `  stop: ${stop}`].filter(Boolean).join('\n')
  writeFileSync(
    join(root, '.claude/builder.md'),
    `---\nproject: fleet-test\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto\n` +
      `agent_walk:\n  driver: none\n  claude_args: --stub-flag\n  worktrees: ${root}-wt\n${hooks}\n---\nbody\n`
  )
  for (const f of features) {
    mkdirSync(join(root, 'docs/features', f), { recursive: true })
    writeFileSync(join(root, 'docs/features', f, 'MANIFEST.md'), `size: md\nstate: spec\nnext: /builder:resume --path docs/features/${f}\n`)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  mkdirSync(join(root, '.stub'))
  return root
}

function runFleet(root, args, scenario, env = {}) {
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const r = spawnSync('node', [FLEET, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, FLEET_CLAUDE: STUB, STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), ...env },
  })
  const fj = join(root, '.builder/fleet/fleet.json')
  const calls = existsSync(join(root, '.stub/calls.log')) ? readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n') : []
  return { ...r, fleet: existsSync(fj) ? JSON.parse(readFileSync(fj, 'utf8')) : null, calls }
}

const HAPPY = ['audited', 'planned', 'building', 'READY-PENDING', 'built', 'verified', 'PR:#1']

test('a spec goes from spec to a draft PR through both lanes', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  const a = r.fleet.features.a
  assert.equal(a.status, 'done')
  assert.equal(a.pr, '#1')
  assert.equal(a.runs, 7)
  assert.equal(git(a.worktree, 'branch', '--show-current'), 'builder/a')
  const lanes = r.calls.filter((l) => l.startsWith('start')).map((l) => l.split(' ')[2])
  assert.deepEqual(lanes, ['build', 'build', 'build', 'build', 'walk', 'walk', 'walk'])
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /\| a \| done \| 7 \| #1 \|/)
})

test('a blocked spec parks with its reason and the fleet exits 1', () => {
  const root = makeRepo(['b'])
  const r = runFleet(root, ['b'], { b: ['audited', 'BLOCK:plan wants to split'] })
  assert.equal(r.status, 1)
  assert.equal(r.fleet.features.b.status, 'parked')
  assert.equal(r.fleet.features.b.reason, 'plan wants to split')
})

test('a run that changes nothing parks as no progress', () => {
  const root = makeRepo(['c'])
  const r = runFleet(root, ['c'], { c: ['NOOP'] })
  assert.equal(r.fleet.features.c.status, 'parked')
  assert.match(r.fleet.features.c.reason, /no progress/)
})

test('a run that fails twice fails, naming the log', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', 'FAIL'] })
  assert.equal(r.fleet.features.d.status, 'failed')
  assert.match(r.fleet.features.d.reason, /failed \(exit 3\) twice — see .*d-02\.log/)
})

test('a run that fails once is retried and carries on', () => {
  const root = makeRepo(['d'])
  const r = runFleet(root, ['d'], { d: ['FAIL', ...HAPPY] })
  assert.equal(r.fleet.features.d.status, 'done')
})

test('a hung run times out twice and fails', () => {
  const root = makeRepo(['e'])
  const r = runFleet(root, ['e'], { e: ['HANG', 'HANG'] }, { FLEET_RUN_TIMEOUT_MS: '300' })
  assert.equal(r.fleet.features.e.status, 'failed')
  assert.match(r.fleet.features.e.reason, /timed out twice/)
})

test('walk lane runs one feature at a time', () => {
  const root = makeRepo(['w1', 'w2', 'w3'])
  const slow = ['READY-PENDING', 'SLOW:built', 'SLOW:verified', 'SLOW:PR:#9']
  const r = runFleet(root, ['w1', 'w2', 'w3', '--parallel', '3'], { w1: slow, w2: slow, w3: slow })
  assert.equal(r.status, 0, r.stderr)
  const walk = []
  for (const line of r.calls) {
    const [kind, feature, lane, ts] = line.split(' ')
    if (lane !== 'walk') continue
    if (kind === 'start') walk.push({ feature, start: Number(ts) })
    else walk.findLast((w) => w.feature === feature).end = Number(ts)
  }
  walk.sort((x, y) => x.start - y.start)
  for (let i = 1; i < walk.length; i++) assert.ok(walk[i].start >= walk[i - 1].end, `walk runs overlap: ${JSON.stringify(walk)}`)
})

test('child runs never see CLAUDE_PROJECT_DIR', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.ok(r.calls.filter((l) => l.startsWith('start')).every((l) => l.endsWith('project_dir=-')), r.calls.join('\n'))
})

test('reset and stop run around each walk, even on park', () => {
  const root = makeRepo(['f'], { reset: 'touch reset-ran', stop: 'touch stop-ran' })
  const r = runFleet(root, ['f'], { f: ['READY-PENDING', 'BLOCK:agent walk failed twice'] })
  const wt = r.fleet.features.f.worktree
  assert.equal(r.fleet.features.f.status, 'parked')
  assert.ok(existsSync(join(wt, 'reset-ran')), 'reset ran')
  assert.ok(existsSync(join(wt, 'stop-ran')), 'stop ran')
})

test('without reset, the summary says dev-DB state accumulates', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: HAPPY })
  assert.match(readFileSync(join(root, '.builder/fleet/STATUS.md'), 'utf8'), /dev-DB state accumulates/)
})

test('re-running resumes and retries a cleared park', () => {
  const root = makeRepo(['a'])
  const scenario = { a: ['audited', 'BLOCK:plan wants to split', 'planned', 'READY-PENDING', 'PR:#2'] }
  const first = runFleet(root, ['a'], scenario)
  assert.equal(first.fleet.features.a.status, 'parked')
  const mfPath = join(first.fleet.features.a.worktree, 'docs/features/a/MANIFEST.md')
  // A still-blocked feature is not retried.
  const idle = runFleet(root, [], scenario)
  assert.equal(idle.fleet.features.a.status, 'parked')
  assert.equal(idle.calls.length, first.calls.length, 'no run while still blocked')
  writeFileSync(mfPath, readFileSync(mfPath, 'utf8').replace(/^blocked:.*\n/m, ''))
  const second = runFleet(root, [], scenario)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.fleet.features.a.status, 'done')
  assert.equal(second.fleet.features.a.pr, '#2')
  assert.equal(second.fleet.features.a.runs, 5, 'run count continues across fleet runs')
})

test('a worktree on another branch is refused, the rest proceed', () => {
  const root = makeRepo(['a', 'g'])
  git(root, 'worktree', 'add', '-q', '-b', 'other', `${root}-wt/g`)
  const r = runFleet(root, ['a', 'g'], { a: HAPPY })
  assert.match(r.stderr, /g — .*exists on branch 'other'/)
  assert.equal(r.fleet.features.g, undefined)
  assert.equal(r.fleet.features.a.status, 'done')
})

test('--dry-run creates nothing', () => {
  const root = makeRepo(['a'])
  const r = runFleet(root, ['a', '--dry-run'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /draft PRs/)
  assert.match(r.stdout, /✓ a → builder\/a/)
  assert.equal(existsSync(`${root}-wt/a`), false)
  assert.equal(r.calls.length, 0)
})

test('refusals: uncommitted, already has a PR, branch checked out here', () => {
  const root = makeRepo(['a', 'h', 'k'])
  writeFileSync(join(root, 'docs/features/h/MANIFEST.md'), 'size: md\nstate: verified\npr: #3\nnext: x\n')
  writeFileSync(join(root, 'docs/features/k/MANIFEST.md'), 'size: md\nstate: building\nbranch: feat/k\nnext: x\n')
  git(root, 'commit', '-qam', 'h has a PR, k underway')
  git(root, 'switch', '-q', '-c', 'feat/k')
  writeFileSync(join(root, 'docs/features/a/MANIFEST.md'), 'size: md\nstate: audited\nnext: x\n')
  const r = runFleet(root, ['a', 'h', 'k', '--dry-run'], {})
  assert.match(r.stdout, /✗ a — .*uncommitted changes/)
  assert.match(r.stdout, /✗ h — .*already has a PR \(#3\)/)
  assert.match(r.stdout, /✗ k — feat\/k is checked out in this folder/)
})

test('a feature already underway continues on its own branch, in the lane it is in', () => {
  const root = makeRepo(['u'])
  git(root, 'switch', '-q', '-c', 'feat/u')
  writeFileSync(join(root, 'docs/features/u/MANIFEST.md'), 'size: md\nstate: built\nready: yes 2026-09-26 abc\nbranch: feat/u\nnext: x\n')
  git(root, 'commit', '-qam', 'u built')
  git(root, 'switch', '-q', 'main')
  git(root, 'merge', '-q', '--ff-only', 'feat/u')
  const r = runFleet(root, ['u'], { u: ['verified', 'PR:#4'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.u.branch, 'feat/u')
  assert.equal(git(r.fleet.features.u.worktree, 'branch', '--show-current'), 'feat/u')
  assert.ok(r.calls.filter((l) => l.startsWith('start')).every((l) => l.split(' ')[2] === 'walk'), 'went straight to the walk lane')
  assert.equal(r.fleet.features.u.pr, '#4')
})

test('a planned feature joins the build lane where it is', () => {
  const root = makeRepo(['p'])
  writeFileSync(join(root, 'docs/features/p/MANIFEST.md'), 'size: md\nstate: planned\ngo-ahead: auto (recommended) 2026-09-26\nnext: x\n')
  git(root, 'commit', '-qam', 'p planned')
  const r = runFleet(root, ['p'], { p: ['building', 'READY-PENDING', 'verified', 'PR:#6'] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.fleet.features.p.branch, 'builder/p')
  assert.equal(r.fleet.features.p.runs, 4)
})

test('a second fleet is refused while one holds the lock', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/lock'), String(process.pid))
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /Another fleet is running/)
})

test('a stale lock is taken over', () => {
  const root = makeRepo(['a'])
  mkdirSync(join(root, '.builder/fleet'), { recursive: true })
  writeFileSync(join(root, '.builder/fleet/lock'), '999999')
  const r = runFleet(root, ['a'], { a: HAPPY })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /stale fleet lock/)
  assert.equal(existsSync(join(root, '.builder/fleet/lock')), false, 'lock released at the end')
})

test('--status prints the last table', () => {
  const root = makeRepo(['a'])
  runFleet(root, ['a'], { a: HAPPY })
  const r = runFleet(root, ['--status'], {})
  assert.match(r.stdout, /\| a \| done/)
})

test('no agent_walk block refuses with the fix', () => {
  const root = makeRepo(['a'])
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  const r = runFleet(root, ['a'], {})
  assert.equal(r.status, 2)
  assert.match(r.stderr, /\/builder:init --update/)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test scripts/test/fleet.test.mjs`
Expected: FAIL — every test, `Cannot find module …/scripts/fleet.mjs`.

- [ ] **Step 4: Implement `scripts/fleet.mjs`**

```js
#!/usr/bin/env node
/**
 * fleet — take a batch of specs through the /builder:* pipeline unattended.
 *
 * Each spec gets its own worktree and branch (builder/<feature>). The BUILD lane runs up to
 * `parallel` of them at once with --no-dev-env, so nothing touches the shared dev environment; the
 * WALK lane takes them one at a time through that environment — walk readiness, the agent walk,
 * verify, the draft PR. Progress is read from each worktree's MANIFEST.md, never from a run's output.
 *
 *   node <plugin>/scripts/fleet.mjs <feature|path>… [--parallel N]
 *   node <plugin>/scripts/fleet.mjs --all [--parallel N]
 *   node <plugin>/scripts/fleet.mjs … --dry-run     # pre-flight and the plan; nothing created
 *   node <plugin>/scripts/fleet.mjs --status        # the last run's table
 *
 * State lives in .builder/fleet/ (fleet.json, STATUS.md, logs/). Re-running resumes.
 */
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { requireConfig } from './config.mjs'
import { parseManifest } from './manifest.mjs'
import { laneOf, decide, loadFleet, saveFleet, fleetDir } from './fleet-core.mjs'

const RUN_CAP = 12
const RUN_TIMEOUT_MS = Number(process.env.FLEET_RUN_TIMEOUT_MS) || 45 * 60 * 1000
const CLAUDE = process.env.FLEET_CLAUDE || 'claude'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--parallel')

const CFG = requireConfig()
const ROOT = CFG.root
const DIR = fleetDir(ROOT)

if (flag('--status')) {
  const p = join(DIR, 'STATUS.md')
  console.log(existsSync(p) ? readFileSync(p, 'utf8') : 'No fleet has run in this repo yet.')
  process.exit(0)
}

const AW = CFG.agentWalk
if (!AW) {
  console.error('No usable agent_walk: block in .claude/builder.md — run /builder:init --update to add one.')
  process.exit(2)
}
if (!AW.claudeArgs) {
  console.error('agent_walk.claude_args is not set — headless runs need explicit permissions. Run /builder:init --update.')
  process.exit(2)
}
const PARALLEL = Number(opt('--parallel')) || AW.parallel
const WORKTREES = AW.worktrees ? resolve(ROOT, AW.worktrees) : join(dirname(ROOT), `${basename(ROOT)}.fleet`)

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}
const specOf = (feature) => `${CFG.registry}/${feature}`
const readManifest = (base, feature) => {
  const p = join(base, specOf(feature), 'MANIFEST.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const unquote = (s) => String(s ?? '').replace(/^"(.*)"$/, '$1')
const nameOf = (a) => basename(a.replace(/\/(MANIFEST|SPEC)\.md$/, '').replace(/\/+$/, ''))

function requested() {
  if (!flag('--all')) return positional.map(nameOf)
  const reg = join(ROOT, CFG.registry)
  if (!existsSync(reg)) return []
  return readdirSync(reg).filter((n) => {
    const t = readManifest(ROOT, n)
    if (!t) return false
    const mf = parseManifest(t)
    return laneOf(mf) === 'build' && ['spec', 'aligned', 'audited'].includes(mf.state)
  })
}

/** The branch a feature runs on: the one it is already underway on, else a fresh builder/<feature>. */
function branchOf(feature, mf) {
  const own = mf.branch && mf.branch !== 'none' ? mf.branch : null
  return own && own !== CFG.baseBranch ? own : `builder/${feature}`
}

/** The one reason this spec cannot join the fleet, or null. Accepts any step before the PR. */
function preflight(feature) {
  const spec = specOf(feature)
  const text = readManifest(ROOT, feature)
  if (text == null) return `no ${spec}/MANIFEST.md`
  if (tryGit(['ls-files', '--error-unmatch', `${spec}/MANIFEST.md`]) === null) return `${spec} is not committed — commit it so the worktree gets it`
  if (tryGit(['diff', '--quiet', 'HEAD', '--', spec]) === null) return `${spec} has uncommitted changes — commit them first`
  const mf = parseManifest(text)
  const lane = laneOf(mf)
  if (lane === 'blocked') return `${spec} is blocked: ${unquote(mf.blocked)}`
  if (lane === 'done') return `${spec} already has a PR (${mf.pr ?? 'shipped'}) — nothing left for the fleet`
  if (lane === 'unknown') return `${spec} is at a state the fleet doesn't know (${mf.state ?? 'none'})`
  const branch = branchOf(feature, mf)
  if (tryGit(['branch', '--show-current']) === branch)
    return `${branch} is checked out in this folder — switch away, or run /builder:resume --path ${spec} here`
  if (!branch.startsWith('builder/') && tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) === null)
    return `its manifest names branch ${branch}, which doesn't exist locally — fetch it first`
  return worktreeProblem(feature, branch)
}

function worktreeProblem(feature, branch) {
  const wt = join(WORKTREES, feature)
  if (!existsSync(wt)) return null
  const cur = tryGit(['branch', '--show-current'], wt)
  return cur === branch ? null : `${wt} exists on branch '${cur}', not ${branch}`
}

function ensureWorktree(feature, branch) {
  const problem = worktreeProblem(feature, branch)
  if (problem) throw new Error(problem)
  const wt = join(WORKTREES, feature)
  if (existsSync(wt)) return wt
  mkdirSync(WORKTREES, { recursive: true })
  const exists = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null
  git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, 'HEAD'])
  return wt
}

// ---- dry run -------------------------------------------------------------------------------
const fleet = loadFleet(ROOT)
const asked = requested()
if (!asked.length && !Object.keys(fleet.features).length) {
  console.error('Name the specs to run (feature names or folders), or pass --all.')
  process.exit(2)
}
const fresh = []
const refused = {}
for (const feature of asked) {
  if (fleet.features[feature]) continue // already in the fleet — resumed below
  const why = preflight(feature)
  if (why) refused[feature] = why
  else fresh.push(feature)
}

if (flag('--dry-run')) {
  console.log('builder fleet — plan (nothing created)')
  console.log(`  worktrees:   ${WORKTREES}`)
  console.log(`  permissions: claude ${AW.claudeArgs}`)
  console.log(`  build lane:  ${PARALLEL} at a time · walk lane: one at a time`)
  console.log('  pushes a branch and opens DRAFT PRs for each feature that passes')
  for (const f of fresh) console.log(`  ✓ ${f} → ${branchOf(f, parseManifest(readManifest(ROOT, f)))}`)
  for (const [f, why] of Object.entries(refused)) console.log(`  ✗ ${f} — ${why}`)
  for (const [f, row] of Object.entries(fleet.features)) console.log(`  ↻ ${f} — resuming (${row.status})`)
  process.exit(0)
}

// ---- lock ----------------------------------------------------------------------------------
const LOCK = join(DIR, 'lock')
mkdirSync(DIR, { recursive: true })
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'))
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch (e) {
    alive = e.code === 'EPERM'
  }
  if (alive) {
    console.error(`Another fleet is running in this repo (pid ${pid}). Stop it, or wait for it.`)
    process.exit(3)
  }
  console.error(`note: taking over a stale fleet lock (pid ${pid} is gone)`)
}
writeFileSync(LOCK, String(process.pid))
const unlock = () => {
  try {
    unlinkSync(LOCK)
  } catch {}
}
const save = () => saveFleet(ROOT, fleet)
const active = new Set()
const stopAll = (code) => {
  for (const c of active) c.kill('SIGTERM')
  save()
  unlock()
  process.exit(code)
}
process.on('SIGINT', () => stopAll(130))
process.on('SIGTERM', () => stopAll(143))

for (const [f, why] of Object.entries(refused)) console.error(`✗ ${f} — ${why}`)
for (const f of fresh)
  fleet.features[f] = { status: 'queued', runs: 0, branch: branchOf(f, parseManifest(readManifest(ROOT, f))), worktree: null, pr: null, reason: null }

// ---- one claude run ------------------------------------------------------------------------
function runClaude(wt, feature, lane, n) {
  const prompt = `/builder:resume --path ${specOf(feature)} --agent-walk${lane === 'build' ? ' --no-dev-env' : ''}`
  const log = join(DIR, 'logs', `${feature}-${String(n).padStart(2, '0')}.log`)
  mkdirSync(dirname(log), { recursive: true })
  // The child must read ITS worktree's config and manifests — never the main checkout's.
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  return new Promise((done) => {
    const out = createWriteStream(log)
    let settled = false
    let timedOut = false
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(child)
      out.end(() => done({ exit, log }))
    }
    const child = spawn(CLAUDE, ['-p', prompt, ...AW.claudeArgs.split(/\s+/).filter(Boolean)], { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'] })
    active.add(child)
    child.stdout.pipe(out, { end: false })
    child.stderr.pipe(out, { end: false })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, RUN_TIMEOUT_MS)
    child.on('error', (e) => {
      out.write(`\n[fleet] could not start ${CLAUDE}: ${e.message}\n`)
      finish(127)
    })
    child.on('close', (code) => finish(timedOut ? null : (code ?? 1)))
  })
}

const snapshot = (wt, feature) => `${readManifest(wt, feature)}\n@${tryGit(['rev-parse', 'HEAD'], wt)}`

/** Run a feature's lane until it hands off, finishes, parks or fails. Returns the outcome. */
async function drive(feature, lane) {
  const f = fleet.features[feature]
  let failures = 0
  for (;;) {
    const before = snapshot(f.worktree, feature)
    f.runs = (f.runs ?? 0) + 1
    save()
    const { exit, log } = await runClaude(f.worktree, feature, lane, f.runs)
    f.log = log
    const d = decide({
      lane,
      manifestText: readManifest(f.worktree, feature),
      exit,
      failures,
      runs: f.runs,
      cap: RUN_CAP,
      progressed: snapshot(f.worktree, feature) !== before,
    })
    if (d.action === 'retry') {
      failures++
      continue
    }
    failures = 0
    if (d.action === 'again') continue
    if (d.action === 'handoff') {
      Object.assign(f, { status: 'awaiting-walk', reason: null })
      save()
      return 'handoff'
    }
    if (d.action === 'done') {
      Object.assign(f, { status: 'done', pr: d.pr, reason: null, evidence: join(f.worktree, '.builder', feature, 'agent-walk') })
      save()
      return 'done'
    }
    Object.assign(f, d.action === 'fail' ? { status: 'failed', reason: `${d.reason} — see ${log}` } : { status: 'parked', reason: d.reason })
    save()
    return f.status
  }
}

/** A config hook (reset/stop) in the worktree. False when it failed. */
function hook(cmd, cwd) {
  if (!cmd) return true
  try {
    execSync(cmd, { cwd, stdio: 'ignore', timeout: 10 * 60 * 1000 })
    return true
  } catch {
    return false
  }
}

async function walkOne(feature) {
  const f = fleet.features[feature]
  f.status = 'walking'
  save()
  try {
    if (!hook(AW.reset, f.worktree)) {
      Object.assign(f, { status: 'parked', reason: `agent_walk.reset failed: ${AW.reset}` })
      save()
      return
    }
    await drive(feature, 'walk')
  } finally {
    if (!hook(AW.stop, f.worktree)) {
      fleet.notes = [...new Set([...(fleet.notes ?? []), `agent_walk.stop failed after ${feature}: ${AW.stop}`])]
      save()
    }
  }
}

// ---- queue everything ----------------------------------------------------------------------
const buildQueue = []
const walkQueue = []
for (const [feature, f] of Object.entries(fleet.features)) {
  if (f.status === 'done') continue
  try {
    f.worktree = ensureWorktree(feature, f.branch)
  } catch (e) {
    Object.assign(f, { status: 'failed', reason: `worktree: ${e.message.split('\n')[0]}` })
    continue
  }
  const text = readManifest(f.worktree, feature)
  const mf = text == null ? {} : parseManifest(text)
  const lane = text == null ? 'unknown' : laneOf(mf)
  if (lane === 'blocked') Object.assign(f, { status: 'parked', reason: unquote(mf.blocked) })
  else if (lane === 'done') Object.assign(f, { status: 'done', pr: mf.pr ?? null, reason: null })
  else if (lane === 'build') Object.assign(f, { status: 'queued', reason: null }) && buildQueue.push(feature)
  else if (lane === 'walk') Object.assign(f, { status: 'awaiting-walk', reason: null }) && walkQueue.push(feature)
  else Object.assign(f, { status: 'parked', reason: 'MANIFEST.md missing or its state not understood' })
}
fleet.notes = (fleet.notes ?? []).filter((n) => !n.startsWith('No agent_walk.reset'))
if (!AW.reset) fleet.notes.push('No agent_walk.reset — dev-DB state accumulates from one walk to the next.')
save()

// ---- the two lanes -------------------------------------------------------------------------
let wake = () => {}
const signal = () => wake()
const nextWake = () => new Promise((r) => (wake = r))
let buildsDone = false

async function buildWorker() {
  while (buildQueue.length) {
    const feature = buildQueue.shift()
    fleet.features[feature].status = 'building'
    save()
    if ((await drive(feature, 'build')) === 'handoff') {
      walkQueue.push(feature)
      signal()
    }
  }
}

async function walkLane() {
  for (;;) {
    if (walkQueue.length) {
      await walkOne(walkQueue.shift())
      continue
    }
    if (buildsDone) return
    await nextWake()
  }
}

await Promise.all([
  Promise.all(Array.from({ length: PARALLEL }, buildWorker)).then(() => {
    buildsDone = true
    signal()
  }),
  walkLane(),
])

save()
unlock()
console.log(readFileSync(join(DIR, 'STATUS.md'), 'utf8'))
process.exit(Object.values(fleet.features).every((f) => f.status === 'done') ? 0 : 1)
```

- [ ] **Step 5: Run the tests**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: PASS, every suite. If `walk lane runs one feature at a time` fails, the walk lane is being entered twice — check that only `walkLane()` ever calls `walkOne`.

- [ ] **Step 6: Commit**

```bash
chmod +x scripts/fleet.mjs
git add scripts/fleet.mjs scripts/test/fleet.test.mjs scripts/test/fixtures/stub-claude.mjs
git commit -m "feat: fleet runner — worktree per spec, parallel build lane, serial walk lane"
```

---

### Task 5: Parked and agent-walked rows in `list-features`

**Files:**
- Modify: `scripts/list-features.mjs` (`inspect` manifest branch ~line 133; `statusOf` ~lines 341–388)
- Test: `scripts/test/list-features.test.mjs`

**Interfaces:**
- Consumes: `isSet` (Task 1).
- Produces: `--json` rows whose `nextStep` reads `⛔ parked — <reason>` when `blocked:` is set; `lastDone` `Agent-walked — not human-tested` at `state: built` with `walk: agent-pass …`; `nextStep` `Review the draft PR, then /builder:signoff` at `state: verified` with an agent pass and a `pr:`.

- [ ] **Step 1: Write the failing test**

`scripts/test/list-features.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'list-features.mjs')

function repo(manifests) {
  const root = mkdtempSync(join(tmpdir(), 'lf-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  for (const [name, body] of Object.entries(manifests)) {
    mkdirSync(join(root, 'docs/features', name), { recursive: true })
    writeFileSync(join(root, 'docs/features', name, 'MANIFEST.md'), `size: md\nnext: x\n${body}\n`)
  }
  const r = spawnSync('node', [LIST, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 0, r.stderr)
  return Object.fromEntries(JSON.parse(r.stdout).features.map((f) => [f.feature, f]))
}

test('a parked feature says so, with its reason', () => {
  const rows = repo({ p: 'state: audited\nblocked: "plan wants to split — clears when you split it"' })
  assert.equal(rows.p.nextStep, '⛔ parked — plan wants to split — clears when you split it')
})

test('an agent-walked feature is not reported as human-walked', () => {
  const rows = repo({
    a: 'state: built\nwalk: agent-pass 2026-09-26 abc123',
    v: 'state: verified\nverify: READY 2026-09-26\nwalk: agent-pass 2026-09-26 abc123\npr: #5',
  })
  assert.equal(rows.a.lastDone, 'Agent-walked — not human-tested')
  assert.equal(rows.a.nextStep, 'Deep verify, then a draft PR')
  assert.equal(rows.v.nextStep, 'Review the draft PR, then /builder:signoff')
})

test('an agent-walk run at built says the agent walks next', () => {
  const rows = repo({ b: 'state: built\nready: yes 2026-09-26 abc\nagent-walk: on 2026-09-26' })
  assert.equal(rows.b.nextStep, 'Agent walk (fleet)')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/test/list-features.test.mjs`
Expected: FAIL — `nextStep` values are the pre-change strings (e.g. `Settle open decisions, then plan`).

- [ ] **Step 3: Implement**

In `inspect`'s manifest branch, after `if (out.blocked) bits.push('🛑 PR HELD')` add:

```js
      if (isSet(mf.blocked)) bits.push('⛔ parked')
      if (mf['agent-walk'] && /^on/i.test(mf['agent-walk'])) bits.push('agent-walk')
```

In `statusOf`, replace the tail — from `const held = mf.hold && …` through the function's `return {…}` — with:

```js
  const agentPass = /^agent-pass/.test(mf.walk ?? '')
  if (state === 'built' && agentPass) {
    lastDone = 'Agent-walked — not human-tested'
    nextStep = 'Deep verify, then a draft PR'
  } else if (state === 'built' && /^on/i.test(mf['agent-walk'] ?? '') && /^yes/.test(ready)) nextStep = 'Agent walk (fleet)'
  if (state === 'verified' && agentPass && r.pr) nextStep = 'Review the draft PR, then /builder:signoff'
  const held = mf.hold && mf.hold !== 'none' ? mf.hold.replace(/^"|"$/g, '') : null
  const parked = isSet(mf.blocked) ? mf.blocked.replace(/^"|"$/g, '') : null
  return {
    lastDone: lastDone + (r.pr ? ` (PR ${r.pr})` : ''),
    nextStep: parked ? `⛔ parked — ${parked}` : held ? `🛑 PR held — ${held}` : nextStep,
    command: resume,
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/list-features.mjs scripts/test/list-features.test.mjs
git commit -m "feat: status shows parked and agent-walked features for what they are"
```

---

### Task 6: The pipeline's rules — REFERENCE and resume

**Files:**
- Modify: `skills/resume/REFERENCE.md` (§Flags table, §MANIFEST.md block + prose, §Continuing on "go" table)
- Modify: `skills/resume/SKILL.md` (Invocation line 9; Step 1 table; §Working `## Fixes`; new §`--agent-walk` after §`--auto`; §Ship step 2; §The PR lock)

**Interfaces:**
- Produces (names later tasks cite): REFERENCE §Flags rows `--agent-walk`, `--no-dev-env`; manifest keys `blocked:`, `agent-walk:`, `walk: agent-pass YYYY-MM-DD <sha>`; resume §`--agent-walk` (the headless table); the park procedure; the PR lock's "agent-verified drafts" exception.

- [ ] **Step 1: REFERENCE §Flags** — after the `| \`--auto\` | …` row add:

```markdown
| `--agent-walk` | **unattended mode**, what `/builder:fleet` runs: implies `--auto`, and **never asks** — every pause takes its recommendation or parks the feature (resume §`--agent-walk`). The walk is `/builder:agent-walk`; the PR opens as a draft. Needs the config's `agent_walk:` block. Recorded on the manifest as `agent-walk: on` |
| `--no-dev-env` | never start, migrate or touch the dev environment. Where a step needs it, write `ready: pending "dev env (fleet walk lane)"`, commit, and end the run. The fleet's build lane passes it, so parallel worktrees never share a dev env |
```

- [ ] **Step 2: REFERENCE §MANIFEST.md** — in the code block, replace the line starting `walk: <name YYYY-MM-DD> | none` with the first line below, and add the other two directly after the `auto:` line:

```markdown
walk: <name YYYY-MM-DD> | agent-pass YYYY-MM-DD <sha> | none   # agent-pass: written by /builder:agent-walk — never a human sign-off
blocked: none | "<reason> — clears when <what>"       # parked by an unattended run; resume runs nothing while it is set
agent-walk: on YYYY-MM-DD | off                        # --agent-walk, recorded so a cold session keeps it
```

and after the paragraph that begins `**\`apps:\` and \`contract:\` are the multi-app lines.**` add:

```markdown
**`blocked:` is not `hold:`.** `hold:` is a human parking a finished PR on purpose; `blocked:` is an
unattended run that could not go on without a human — a scope question, a manual-commit app, a
migration the config says a human applies, two failed agent walks. While it is set, `/builder:resume`
prints it and runs nothing. The human resolves what it names and deletes the line.
```

- [ ] **Step 3: REFERENCE §Continuing on "go"** — add a row to its table, after the `🛑 held` row:

```markdown
| `⛔ parked` (`blocked:` set) | an unattended run stopped on something only the human can settle | the reason, and "delete the `blocked:` line once it's settled, then say go" |
```

- [ ] **Step 4: resume Invocation** — line 9 becomes:

```markdown
Invocation: **`/builder:resume [--path <folder|file>] [--ticket <id>] [--auto] [--agent-walk] [--no-dev-env] [--help]`**. Flags:
```

- [ ] **Step 5: resume Step 1 table** — insert as the table's **second** row (right after the `✅ SHIPPED` row):

```markdown
| `blocked:` set (anything but `none`) | ⛔ **parked — run no step.** Print the reason and what clears it (REFERENCE §MANIFEST.md). Under `--agent-walk`, end the run: the fleet reads the line |
```

Replace the row beginning `| \`state: built\`, \`walk: none\`, no open \`## Fixes\` row |` with:

```markdown
| `state: built`, `walk: none`, no open `## Fixes` row | 🔒 stop — §The walk. **Under `--agent-walk`:** `/builder:agent-walk --path <folder>` instead |
| `state: built`, `walk: agent-pass …`, `verify: none` | `/builder:verify --path <folder>` — an agent pass unlocks verify and a **draft** PR, nothing more |
```

Insert immediately **before** the row beginning `| \`pr: #N\` open, SPEC header not yet \`SHIPPED\` |`:

```markdown
| `pr: #N` is a **draft** (`gh pr view <N> --json isDraft`) **and** `walk:` now carries a human name | the human signed off an agent-verified feature. Ask once — **Mark PR ready** / **Not yet** — then `gh pr ready <N>`. Never under `--agent-walk` |
```

- [ ] **Step 6: resume §Working `## Fixes`** — append to the paragraph beginning `**Where it goes back to depends on which list it came from.**`:

```markdown
Tasks from an **agent walk** (`--agent-walk`, rows tagged `(agent walk round <n>)`) end with REFERENCE
§Walk readiness again, then `/builder:agent-walk --path <folder>` — never a human re-walk request.
```

- [ ] **Step 7: resume — new section** — insert directly after the `--auto` section's closing paragraph (the one ending `Nothing about it touches the PR lock.`):

```markdown
## `--agent-walk`

Unattended mode, for `/builder:fleet` (REFERENCE §Flags). It **implies `--auto`** and is recorded on
the manifest as `agent-walk: on YYYY-MM-DD`, so a cold session keeps it. No `agent_walk:` block in the
config → refuse in one line naming `/builder:init --update`.

🔴 **Never call AskUserQuestion or ExitPlanMode** — nobody is there to answer, and a headless run that
asks hangs until it times out. Every point that would ask resolves one of two ways:

- **Take the recommendation** — when it is local and reversible.
- **Park** — write `blocked: "<reason> — clears when <what>"` and `next: /builder:resume --path
  <folder>` to the manifest, commit `chore(<ticket-or-feature>): <feature> — parked: <reason>`, print
  the footer, and **end the run**.

| Pause | Under `--agent-walk` |
|---|---|
| Decisions gate · go-ahead · prototype gap · audit code defect | as `--auto`: the recommendation, recorded `auto (recommended)` |
| An open scope question · a plan that wants to split | park — the spec needs a human |
| An audit `blocked:` finding | park, citing it |
| An app the config marks `commit: manual` | park at the start of that app's phase; earlier phases stay committed |
| Dev-DB migrations (§Walk readiness) | `apply_mode: ask` → apply · `human` → park · `agent` → apply |
| The walk | `/builder:agent-walk --path <folder>` |
| Opening the PR | §Ship's draft path, no question — starting the fleet was the permission |
| **Any other point that would ask, including ones added later** | the rule above. A pause missing from this table is never a reason to ask |

**The flags carry through:** every step this command runs gets `--agent-walk`, and `--no-dev-env`
when this run has it. Under `--no-dev-env`, reaching walk readiness writes `ready: pending "dev env
(fleet walk lane)"`, commits, and ends the run.

`--agent-walk` never writes a human sign-off, never marks a PR ready, never lifts a `hold:`, and never
merges.
```

- [ ] **Step 8: resume §Ship step 2** — append to step 2, after its "**Ask once first** …" sentence block:

```markdown
   **Agent-verified** (`walk: agent-pass …`): `git push -u origin <branch>`, then the same command
   with `--draft`, the body adding `## 🤖 Agent walk — not human-tested` and the last round's
   `report.md` table. Under `--agent-walk` there is no question here. Step 3 records `pr:` as usual.
```

- [ ] **Step 9: resume §The PR lock** — after the paragraph that starts `**No \`/builder:*\` skill may open, reopen, or push toward a PR until`, add:

```markdown
**The one exception — agent-verified drafts.** A feature whose `walk:` reads `agent-pass …` and whose
`verify:` reads `READY` may open its PR **only as a draft**, with the agent walk report in its body
under `## 🤖 Agent walk — not human-tested`. **Marking it ready (`gh pr ready`) requires a human
sign-off**, exactly as opening a PR always has.
```

- [ ] **Step 10: Verify**

Run: `claude plugin validate . && grep -c "agent-walk" skills/resume/SKILL.md skills/resume/REFERENCE.md`
Expected: validation passes; both counts ≥ 5. Then read resume §Step 1, §`--agent-walk` and §Ship end to end and confirm a fresh agent would (a) never ask under `--agent-walk`, (b) never mark a PR ready without a human name in `walk:`.

- [ ] **Step 11: Commit**

```bash
git add skills/resume/SKILL.md skills/resume/REFERENCE.md
git commit -m "feat: --agent-walk and --no-dev-env — headless rules, parking, draft-only PRs"
```

---

### Task 7: `/builder:agent-walk`

**Files:**
- Create: `skills/agent-walk/SKILL.md`

**Interfaces:**
- Consumes: `cfg.agentWalk.driver` (via the config body/frontmatter), `<WS>/walk.md`, REFERENCE §Agent model tiering, §The scripts.
- Produces: `<WS>/agent-walk/round-<n>/report.md` + evidence; manifest `walk: agent-pass YYYY-MM-DD <sha>` or `## Fixes` rows tagged `(agent walk round <n>)`; SPEC header line `> 🤖 AGENT-VERIFIED …`; the park after round 2.

- [ ] **Step 1: Write the skill**

`skills/agent-walk/SKILL.md`:

```markdown
---
name: agent-walk
description: The unattended stand-in for the human walk, run only under --agent-walk (the /builder:fleet path) — a fresh subagent works the feature's walk.md item by item with the driver the project config's agent_walk block names, records PASS/FAIL per item with evidence, and this step writes an AGENT-PASS or AGENT-PROBLEMS verdict. Never a human sign-off — an agent pass unlocks /builder:verify and a DRAFT PR only, and the SPEC header says the feature is not human-tested. Use when /builder:resume routes here under --agent-walk.
---

# `/builder:agent-walk` — an agent walks it, and says so

Invocation: **`/builder:agent-walk --path <folder> [--ticket <id>]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — ignore any flag this step does not use.

🔴 **This is not a sign-off.** It never writes `✅ SIGNED OFF`, never writes a name into `walk:`,
never condenses, and never runs `/builder:signoff`. It exists so an unattended run can reach a
**draft** PR carrying evidence. Whether that PR goes ready is still the human's sign-off.

## Precondition — read `<folder>/MANIFEST.md`

| The manifest says | What to do |
|---|---|
| `agent-walk:` is not `on …` | refuse in one line: this step runs only under `--agent-walk`. A human walk is recorded by `/builder:signoff` |
| the config has no `agent_walk:` block | refuse; name `/builder:init --update` |
| `blocked:` set | parked — print it, run nothing |
| `walk:` already set | nothing to do; hand back to `/builder:resume --path <folder>` |
| `ready:` is not `yes` at the current HEAD | not walkable yet — hand back to `/builder:resume` (walk readiness comes first) |
| `state: built`, `walk: none`, `ready: yes` at HEAD | run |

## 1. Which round

`<WS>` is `"$(<builder>/scripts/workspace <feature>)"` — re-resolve it inline in every command
(REFERENCE §The scripts). The round is one more than the highest existing `<WS>/agent-walk/round-*`.
**Round 3 would start → park instead** (resume §`--agent-walk`):
`blocked: "agent walk failed twice — <the items still failing> — clears when a human walks it or the fixes land"`.

## 2. Dispatch the walker

**One fresh subagent** — Agent tool, on the most capable model (REFERENCE §Agent model tiering) — and
never the build's context: the agent that built it does not grade it. Its brief is exactly:

- the path to `<WS>/walk.md`, to read in full;
- the config's `agent_walk.driver`, verbatim — how it drives the UI. **No driver** → "there is no UI
  driver: exercise each item through its endpoints, the server log and the database, and mark any
  item that can only be checked by looking at the screen `UNVERIFIABLE`";
- the config's §Environment landmines, verbatim;
- the output directory `<WS>/agent-walk/round-<n>/`;
- the rules: work **every** item, in order, per app; for each, record `PASS`, `FAIL` or
  `UNVERIFIABLE`, what it did, what it saw, and its evidence files — screenshots `NN-<slug>.png`,
  console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.
  **Never edit code, never commit, never touch the manifest or the SPEC.**
- the report: `<WS>/agent-walk/round-<n>/report.md` — a table `# · App · Item · Result · Evidence`,
  then one line: `verdict: PASS` or `verdict: PROBLEMS (<k>)`.

## 3. Judge the report

Read `report.md`. Open an evidence file only to spot-check a `FAIL`.

- Every `walk.md` item present and `PASS` — `UNVERIFIABLE` allowed only when there is no driver, and
  each one listed — → **AGENT-PASS**.
- Any `FAIL`, or an item of `walk.md` missing from the report (count it `FAIL — not walked`) →
  **AGENT-PROBLEMS**.

## 4. Write it

**AGENT-PASS**
- Manifest: `walk: agent-pass YYYY-MM-DD <sha>`, `next: /builder:verify --path <folder>`, `head`.
- SPEC header, directly under the title:
  `> 🤖 AGENT-VERIFIED YYYY-MM-DD — <sha> · round <n> · not human-tested · evidence: .builder/<feature>/agent-walk/round-<n>/`
- Commit both: `chore(<ticket-or-feature>): <feature> — agent walk PASS (not human-tested)`.

**AGENT-PROBLEMS**
- Each failing item becomes `- [ ] <app>: <item> — expected <x>, saw <y> (agent walk round <n>)`
  under SPEC `## Fixes` — created as the SPEC's last section if absent.
- Manifest: `walk:` stays `none`; `next: /builder:resume --path <folder>`.
- Commit: `docs(<ticket-or-feature>): <feature> — agent walk round <n>: <k> fixes`.
- `/builder:resume` works them (§Working `## Fixes`), re-runs walk readiness, and routes back here.

## Hand off

The verdict, the round, the counts (pass · fail · unverifiable), and where the evidence is. Then:

~~~
📍 <feature>: agent walk PASS (round <n>, not human-tested) — next: /builder:verify --path <folder> · or say go
📍 <feature>: agent walk round <n> — <k> fixes owed — next: /builder:resume --path <folder> · or say go
📍 <feature>: ⛔ parked — agent walk failed twice — next: a human walk, then /builder:signoff --path <folder>
~~~

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
```

- [ ] **Step 2: Verify**

Run: `claude plugin validate . && claude plugin details builder@claude-builder 2>/dev/null | head -3; ls skills/agent-walk/SKILL.md`
Expected: validation passes; the file exists. Read it end to end: confirm it never names a human, never writes `✅`, and parks at round 3.

- [ ] **Step 3: Commit**

```bash
git add skills/agent-walk/SKILL.md
git commit -m "feat: /builder:agent-walk — an agent walks walk.md and records a separate verdict"
```

---

### Task 8: build, verify and signoff honour the new flags

**Files:**
- Modify: `skills/build/SKILL.md` (Invocation line 8; §When the last phase signs items 3 and 5)
- Modify: `skills/verify/SKILL.md` (Precondition table; checklist item 1)
- Modify: `skills/signoff/SKILL.md` (Procedure step 1 table; §What gets written)

**Interfaces:**
- Consumes: Task 6's flags, keys and park procedure; Task 7's verdict format.

- [ ] **Step 1: build Invocation** — line 8 becomes:

```markdown
Invocation: **`/builder:build --path <folder> [--ticket <id>] [--auto] [--agent-walk] [--no-dev-env]`**. Flags:
```

- [ ] **Step 2: build item 3** — append to item 3 (after `…and this precedes it.`):

```markdown
   **Under `--no-dev-env`** (the fleet's build lane): don't run readiness at all — write
   `state: building`, `ready: pending "dev env (fleet walk lane)"`, `next: /builder:resume --path <folder>`,
   commit `chore(<ticket-or-feature>): <feature> — phases closed, awaiting the walk lane`, and end the
   run. **Under `--agent-walk`**, readiness never asks: resume §`--agent-walk` says what each question
   becomes.
```

- [ ] **Step 3: build item 5** — append to item 5:

```markdown
   **Under `--agent-walk`:** `next: /builder:agent-walk --path <folder>` and keep going into it — the
   walk script is still written (the agent walks it), and no human is asked to.
```

- [ ] **Step 4: verify Precondition table** — insert after the row beginning `| \`walk:\` carries a name + date`:

```markdown
| `walk: agent-pass …` **and** the SPEC header carries `🤖 AGENT-VERIFIED` | run, as an **agent-verified** feature: checklist item 1 holds on the agent walk report, the verdict says "agent-walked, not human-tested", and READY's `next:` is `/builder:resume --path <folder>` — which opens a **draft** |
```

and replace the row beginning `| \`state: built\` with \`walk: none\` |` with:

```markdown
| `state: built` with `walk: none` | 🔴 **stop and offer the walk instead** — print `walk.md` and name `/builder:signoff --path <folder>` as what records the verdict. **Under `--agent-walk`:** hand to `/builder:agent-walk --path <folder>` instead. Never run the deep pass on a build nobody has looked at |
```

- [ ] **Step 5: verify checklist item 1** — append to item 1:

```markdown
   **Agent-verified** (`walk: agent-pass …`): the proof is instead `<WS>/agent-walk/round-<n>/report.md`
   with every item `PASS` at a sha this verify covers. It proves an agent walked it — never that a
   human did — and the verdict says so in its first line.
```

- [ ] **Step 6: signoff routing table** — in Procedure step 1's table, insert after the `| \`state: built\` · \`walk: none\` |` row:

```markdown
   | `walk: agent-pass …` (an agent walked it; a draft PR may be open) | the walk sign-off below. A human PASS **supersedes** the agent's verdict — §What gets written, *Over an agent pass* |
```

- [ ] **Step 7: signoff §What gets written** — append at the end of that section:

```markdown
**Over an agent pass.** `walk:` becomes the human line (the `agent-pass` value is replaced, not kept
beside it), and the SPEC's `> 🤖 AGENT-VERIFIED …` header line is replaced by the sign-off line. If
`verify: READY` was recorded at the current HEAD, keep it and write `next: /builder:resume --path
<folder>` — it marks the draft PR ready, after asking. Otherwise set `verify: none`: the code moved
since the agent's verify, so it runs again.
```

- [ ] **Step 8: Verify**

Run: `claude plugin validate . && grep -n "agent" skills/build/SKILL.md skills/verify/SKILL.md skills/signoff/SKILL.md | wc -l && grep -n "disable-model-invocation" skills/signoff/SKILL.md`
Expected: validation passes; ≥ 8 lines; signoff still has `disable-model-invocation: true`.

- [ ] **Step 9: Commit**

```bash
git add skills/build/SKILL.md skills/verify/SKILL.md skills/signoff/SKILL.md
git commit -m "feat: build, verify and signoff understand the agent walk"
```

---

### Task 9: `/builder:fleet`, init and the config template

**Files:**
- Create: `skills/fleet/SKILL.md`
- Modify: `skills/init/SKILL.md` (§3 bullet list; §4 frontmatter bullet)
- Modify: `PROJECT.template.md` (frontmatter, after the `design:` block)

**Interfaces:**
- Consumes: `scripts/fleet.mjs` CLI (Task 4), `cfg.agentWalk` keys (Task 2).

- [ ] **Step 1: Write the fleet skill**

`skills/fleet/SKILL.md`:

```markdown
---
name: fleet
description: Take a batch of written specs through the whole /builder:* pipeline unattended — one worktree and branch per spec, a parallel build lane, a one-at-a-time walk lane through the shared dev environment, an agent walk in place of the human one, verify, and a DRAFT PR per feature; anything that would ask a question takes its recommendation or parks the feature with a reason. Launches scripts/fleet.mjs in the background and reports its table. Use when the user wants several specs built unattended, overnight, or "sent to an orchestrator"; --status shows the last run.
---

# `/builder:fleet` — many specs, no one watching

Invocation: **`/builder:fleet [--all | <feature|folder>…] [--parallel N] [--dry-run] [--status]`**.

The work is `scripts/fleet.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

**What it will do, per spec:** a worktree at `<agent_walk.worktrees>/<feature>` on a new branch
`builder/<feature>`; `claude -p "/builder:resume --path <spec> --agent-walk"` runs until the feature
is a **draft PR** or **parked** (resume §`--agent-walk`). It **pushes branches and opens draft PRs**.
It never marks a PR ready, never merges, never signs off for a human.

## 1. `--status`

`node <builder>/scripts/fleet.mjs --status` — print it verbatim and stop.

## 2. Always dry-run first

```bash
node <builder>/scripts/fleet.mjs <the same arguments> --dry-run
```

Print it verbatim. For every `✗` line, say what fixes it in a few words. The script refusing the whole
batch (no `agent_walk:` block, no `claude_args`) → name `/builder:init --update` and stop. `--dry-run`
was asked for → stop here.

## 3. Confirm once

One AskUserQuestion — **Start the fleet** / **Not now** — whose question restates: how many specs, the
worktree root, the permission args (`claude <claude_args>`), and "pushes branches and opens draft PRs".
This is the only question the fleet ever asks.

## 4. Launch

Run with the Bash tool's `run_in_background`:

```bash
node <builder>/scripts/fleet.mjs <the same arguments>
```

Then say, in two lines: it's running, `/builder:fleet --status` shows where it stands, and a run that
must outlive this session goes in a terminal instead:
`nohup node <absolute builder path>/scripts/fleet.mjs <arguments> > .builder/fleet/fleet.out 2>&1 &`.

## 5. When it finishes

Print `.builder/fleet/STATUS.md` verbatim. Then, briefly:

- **done** — each draft PR, and: review it, walk what you want, then in its worktree
  `cd <worktree> && claude` → `/builder:signoff --path <spec>`; the next `/builder:resume` marks it ready.
- **parked** — the reason; delete the `blocked:` line in the worktree's manifest once it's settled, and
  re-run `/builder:fleet` — it resumes, and retries only what you cleared.
- **failed** — the log path.

~~~
📍 fleet: <n> done · <m> parked · <k> failed — next: review the draft PRs; /builder:signoff in each worktree
~~~
```

- [ ] **Step 2: init §3** — add this bullet to the list in "## 3. Ask only what recon couldn't answer", before the `the **ticket** and **design** blocks` bullet:

```markdown
- the **`agent_walk` block** — only if the user wants unattended `/builder:fleet` runs (recommend
  *not yet* unless they asked). If yes: `driver` — recon first: a Playwright/browser MCP server in
  `.mcp.json`, or `playwright`/`cypress` in a manifest; else ask; `claude_args` — recommend
  `--permission-mode bypassPermissions` and **say plainly** it lets every headless run execute any
  command inside its fleet worktree without asking; `reset` and `stop` from the §Walk readiness recon;
```

and in "## 4. Write `.claude/builder.md`", change the sentence `Delete the optional \`ticket:\` and \`design:\` blocks outright when unused;` to:

```markdown
Delete the optional `ticket:`, `design:` and `agent_walk:` blocks outright when unused;
```

- [ ] **Step 3: PROJECT.template.md** — insert after the `design:` block's last line (`  owned_by: …`), still inside the frontmatter:

```yaml

# ─── unattended runs (optional) ────────────────────────────────────────────
# /builder:fleet takes a batch of specs to draft PRs with no human in the loop:
# a worktree per spec, an agent walk instead of yours, draft PRs only. Omit the
# whole block and --agent-walk / /builder:fleet refuse.
agent_walk:
  driver: <how the agent drives the UI — e.g. "the Playwright MCP tools (mcp__playwright__*)">
  claude_args: --permission-mode bypassPermissions   # headless runs can't ask; this lets them act in their worktree
  # worktrees: ../myrepo.fleet     # default: a sibling of the repo named <repo>.fleet
  # parallel: 3                    # build-lane concurrency
  # reset: <command>               # dev DB back to base + seed, before each walk
  # stop: <command>                # stop the dev env after each walk
```

- [ ] **Step 4: Verify the template still parses as "unconfigured"**

Run:

```bash
tmp=$(mktemp -d) && mkdir "$tmp/.claude" && cp PROJECT.template.md "$tmp/.claude/builder.md" && \
node -e "import('./scripts/config.mjs').then(m => { const c = m.loadConfig('$tmp'); console.log(c.ok, c.agentWalk) })"
```

Expected: `true null` — the `<placeholder>` driver keeps the block unconfigured, so a copied template never turns fleet mode on. Then `claude plugin validate .` passes.

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/SKILL.md skills/init/SKILL.md PROJECT.template.md
git commit -m "feat: /builder:fleet, and init/template support for the agent_walk block"
```

---

### Task 9b: `/builder:agent` — pick unfinished features, run them until done

**Files:**
- Create: `skills/agent/SKILL.md`

**Interfaces:**
- Consumes: `list-features.mjs --json` rows (`feature`, `path`, `state`, `done`, `pr`, `manifest.blocked`, `updatedAt`, `nextStep`); `fleet.mjs <features…> [--dry-run]` (Task 4); `/builder:fleet` §3–5 (Task 9).
- Produces: the `/builder:agent` command.

- [ ] **Step 1: Write the skill**

`skills/agent/SKILL.md`:

```markdown
---
name: agent
description: Pick one or more unfinished /builder:* features from a list and hand them to agents that run each one until it is done — a draft PR with agent walk evidence, or parked with the reason a human is needed. Offers every feature at any step before its PR (written spec, audited, planned, part-built, built, verified) that is not parked; one multi-select, one confirmation, then the /builder:fleet engine runs them in the background, continuing each on its own branch in its own worktree. Use when the user wants agents to take over, finish, or keep working on specs or plans that are already written.
---

# `/builder:agent` — pick the work, let agents finish it

Invocation: **`/builder:agent`**. No arguments; `--help` prints this line and stops.

The engine is `/builder:fleet`'s — `scripts/fleet.mjs` — so everything it promises holds here: a
worktree per feature, builds in parallel, walks one at a time, an agent walk in place of yours,
**draft PRs only**, and nothing that waits on a question. "Done" means a **draft PR** or **parked
with a reason**; your `/builder:signoff` is what marks a draft ready. Resolve `<builder>` per
[REFERENCE](../resume/REFERENCE.md) §The scripts.

## 1. What can be picked

```bash
node <builder>/scripts/list-features.mjs --json
```

A row is offered when `done` is false, it has no `pr`, its `manifest.blocked` is unset or `none`, and
its `state` is one of `spec aligned audited planned building built signed-off verified`. No config
`agent_walk:` block → stop here and name `/builder:init --update`. Nothing offerable → say so, and
name `/builder:brainstorm` for writing a spec. Parked rows are listed underneath as a count with
their reasons, so it's clear why they're missing.

## 2. Pick — one multi-select

One AskUserQuestion with `multiSelect: true`. Each option: the `feature` as the label; its step and
`nextStep` as the description. **More than four offerable** → offer the four most recently touched
(`updatedAt`), and say in the question that any others can be named with
`/builder:fleet <feature> <feature>…`. Nothing picked → stop.

## 3. Check, confirm, launch

```bash
node <builder>/scripts/fleet.mjs <picked features> --dry-run
```

Print it verbatim. A `✗` pick → say what fixes it (a feature whose branch is checked out in this
folder: switch branches, or just `/builder:resume` it here). If no pick survives, stop.

Then `/builder:fleet` §3 (the one confirmation), §4 (launch in the background) and §5 (the report
when it finishes), with the picks as the arguments.

~~~
📍 agents: <n> feature(s) running — next: /builder:fleet --status
~~~
```

- [ ] **Step 2: Verify**

Run: `claude plugin validate . && ls skills/agent/SKILL.md`
Expected: validation passes. Read it end to end: the offer filter matches what `fleet.mjs` pre-flight accepts (any step before the PR, not blocked), and it asks exactly two questions — the pick and the confirmation.

- [ ] **Step 3: Commit**

```bash
git add skills/agent/SKILL.md
git commit -m "feat: /builder:agent — pick unfinished features, agents run them to a draft PR"
```

---

### Task 10: Documentation and the 2.5.0 release notes

**Files:**
- Modify: `skills/help/SKILL.md` (§Which command do I run? table; §The human gates)
- Modify: `README.md` (new `## Unattended runs` section before `## What it never does`; that section's PR line)
- Modify: `CONTRIBUTING.md` (§Before you open a PR)
- Modify: `CHANGELOG.md` (new `## 2.5.0` at the top)
- Modify: `.claude-plugin/plugin.json` (`"version": "2.5.0"`)

- [ ] **Step 1: help** — add a row to the "Which command do I run?" table:

```markdown
| **Hand work in progress to agents** | `/builder:agent` — tick any unfinished features from a list; agents run each until it's a **draft PR** or parked with a reason |
| **Several specs, built while you're away** | `/builder:fleet <features…>` — a worktree each, an agent walk instead of yours, a **draft** PR each or a parked reason. Needs the config's `agent_walk:` block |
```

and append to §The human gates, after the `**\`--auto\`**` paragraph:

```markdown
**`--agent-walk`** (what `/builder:fleet` runs) goes further: it never asks, parks what only you can
settle, and replaces the walk with `/builder:agent-walk`, recorded as `🤖 AGENT-VERIFIED — not
human-tested`. That reaches a **draft** PR and no further: marking it ready still takes your
`/builder:signoff`.
```

- [ ] **Step 2: README** — insert before `## What it never does`:

```markdown
## Unattended runs

Write the specs, then hand them over:

```
/builder:agent                  # pick unfinished features from a list
/builder:fleet --all            # or: every fresh spec, scripted — or name the features
```

Each spec gets its own worktree and `builder/<feature>` branch. Builds run in parallel; walks run one
at a time through your dev environment, done by an agent (`/builder:agent-walk`) that records evidence
per `walk.md` item. Every feature ends as a **draft PR** marked `🤖 AGENT-VERIFIED — not human-tested`,
or **parked** with the reason a human is needed. Nothing waits on a question. Review the drafts, walk
what you like, and `/builder:signoff` in a feature's worktree to mark it ready.

Needs an `agent_walk:` block in `.claude/builder.md` — `/builder:init --update` adds it. Headless runs
need permissions set explicitly (`claude_args`), because nobody is there to approve a prompt.
```

In `## What it never does`, find the line about opening a PR before a human has tested the feature and append: `(An agent-walked feature gets a **draft** PR; only your sign-off marks it ready.)`

- [ ] **Step 3: CONTRIBUTING** — in the `## Before you open a PR` code block, add a line:

```bash
node --test 'scripts/test/*.test.mjs'      # the scripts' tests — no dependencies, Node's own runner
```

- [ ] **Step 4: CHANGELOG** — insert above `## 2.4.0`:

```markdown
## 2.5.0

**Unattended runs.** `/builder:agent` lets you tick unfinished features — at any step before the PR — and hands them to agents until each is a draft PR or parked with a reason; `/builder:fleet` takes a batch of written specs to draft PRs with no human in the
loop: one worktree and `builder/<feature>` branch per spec, builds in parallel, walks one at a time
through the shared dev environment. `scripts/fleet.mjs` does the work and resumes from
`.builder/fleet/fleet.json` if stopped, and continues a feature already underway on its own branch; `--dry-run` and `--status` show the plan and the table.

**`--agent-walk`** — the mode the fleet runs in — implies `--auto` and never asks: each pause takes
its recommendation or **parks** the feature with a new manifest line, `blocked:`, which
`/builder:resume` honours until a human clears it. **`--no-dev-env`** keeps parallel builds off the dev
environment. **`/builder:agent-walk`** replaces the human walk with a fresh agent working `walk.md`
with the configured driver, and records `walk: agent-pass` and `🤖 AGENT-VERIFIED — not human-tested`
— never a human sign-off. Two failed rounds park the feature.

**The PR lock, amended once:** an agent-verified feature may open a **draft** PR; marking it ready
still requires `/builder:signoff`, which stays human-only. A human PASS supersedes the agent's verdict.

**Config:** an optional `agent_walk:` block (`driver`, `claude_args`, and optionally `worktrees`,
`parallel`, `reset`, `stop`). Without it nothing changes. `/builder:init --update` adds it.

**Scripts:** `scripts/manifest.mjs` (shared parser), `scripts/fleet-core.mjs`, `scripts/fleet.mjs`, and
the first test suite — `node --test 'scripts/test/*.test.mjs'`.
```

- [ ] **Step 5: Version** — in `.claude-plugin/plugin.json` change `"version": "2.4.0"` to `"version": "2.5.0"`.

- [ ] **Step 6: Verify everything**

Run: `node --test 'scripts/test/*.test.mjs' && scripts/workspace --self-test && claude plugin validate .`
Expected: all tests PASS, `ok: workspace self-test`, `✔ Validation passed`.

- [ ] **Step 7: Commit**

```bash
git add skills/help/SKILL.md README.md CONTRIBUTING.md CHANGELOG.md .claude-plugin/plugin.json
git commit -m "docs: unattended runs — help, README, changelog; 2.5.0"
```

---

### Task 11: End-to-end check on a throwaway repo

**Files:** none committed — a scratch repo under the scratchpad directory.

- [ ] **Step 1: Dry run against a real config**

Create a throwaway repo with `.claude/builder.md` (one app, an `agent_walk:` block with a real `claude_args`) and two small committed specs at `state: spec`. Run from inside it:

```bash
node /Users/lukekeith/www/builder/scripts/fleet.mjs --all --dry-run
```

Expected: both specs `✓`, the worktree root, the permission args, "DRAFT PRs"; nothing created.

- [ ] **Step 2: One real headless run — ask the human first**

This spends real model time and, at the end, pushes a branch and opens a draft PR. **Ask before running.** With approval, load the plugin from the working copy (`claude --plugin-dir /Users/lukekeith/www/builder`, or `claude_args` including `--plugin-dir /Users/lukekeith/www/builder`) and run the fleet on **one** spec with a remote you own. Confirm: the child reads the worktree's config; `/builder:resume … --agent-walk` asks nothing; the manifest shows `agent-walk: on`; the feature ends `done` with a draft PR whose body carries `## 🤖 Agent walk — not human-tested`, or `parked` with a reason you can act on.

- [ ] **Step 3: Record what surprised you**

Anything the real run did that the stub didn't model (a prompt that still asked, a slash command `-p` didn't expand, a permission the args didn't cover) becomes a fix task before release — not a changelog footnote.
