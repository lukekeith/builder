# Pipeline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/builder:benchmark` runs one small feature through builder at rush, standard and thorough and through superpowers and GSD, unattended, and writes a report of time per step, what happened in each step, tokens, cost and whether the feature works.

**Architecture:** A fixture project (`bench/fixture/`) is copied per configuration; each pipeline is driven as a sequence of headless `claude -p … --output-format stream-json` sessions (builder's last "session" is the fleet engine itself); `scripts/bench-core.mjs` turns the streams into steps and a report with pure functions; `scripts/bench.mjs` does the side effects (copies, sessions, timeouts, scoring, `runs.json`, lock, detach); `skills/benchmark/SKILL.md` wraps the script the way `/builder:fleet` wraps `fleet.mjs`.

**Tech Stack:** Node ≥ 20, `node:test`, no dependencies (as every script in this repo). The Claude Code CLI (`claude`) with `--plugin-dir`, `--settings`, `--append-system-prompt`, `--output-format stream-json`.

**Spec:** `docs/specs/2026-10-13-benchmark-design.md`

## Global Constraints

- No npm dependencies anywhere: not in `scripts/`, not in `bench/fixture/`. Node's own modules only.
- Every script is an ES module (`.mjs`), tested with `node --test 'scripts/test/*.test.mjs'`.
- Nothing the runner does touches this repo except `bench/results/` (or `.builder/bench/` when run from another repo). It never installs into the user's Claude home; plugins load with `--plugin-dir` and user-scope ones are switched off with `--settings`.
- Configurations run in sequence, never in parallel.
- The owner prompt (spec §4) is passed verbatim to every session; builder sessions get one extra line naming the profile.
- Durations are formatted by `duration()` and token counts by `formatTokens()` from `scripts/fleet-core.mjs`.
- Release: minor, `4.11.0`; `bench/` ships with the plugin, `bench/results/<run>/<config>*/` raw directories are git-ignored; `/builder:vendor` skips `bench/results`.
- The copy's path must contain no spaces (the fleet splits `claude_args` on whitespace); the runner refuses such a `$TMPDIR`.

## Review Focus

1. A stream cut off without a `result` event (killed on timeout): totals must come from the last event's timestamp and token fields must be zeros, never a crash. → Task 3 test "a stream with no result event".
2. A session whose first assistant event is a Skill call at the very start: the `(prompt)` step must be omitted when it would be zero-length. → Task 3 test "no (prompt) step when the first event is a Skill".
3. Builder sizes the feature xs/sm and builds it in chat: no `docs/features/*/MANIFEST.md` after the spec session. The row must be `path: in-chat`, flagged, with sessions 2–3 skipped, not a crash in the fleet driver. → Task 7 test "builder config with no manifest is in-chat".
4. The GSD installer fails (no network, package gone): the gsd row is `not run: <reason>` and the other configs still run and are saved. → Task 7 test "a failing gsd install marks the row not run".
5. A runner killed between configs: `runs.json` already holds the finished configs and `status` says the run is not in progress (lock pid dead). → Task 8 test "status with a dead lock".

---

### Task 1: The fixture project — a notes CLI with tests and a builder config

**Files:**
- Create: `bench/fixture/package.json`
- Create: `bench/fixture/README.md`
- Create: `bench/fixture/src/store.mjs`
- Create: `bench/fixture/src/cli.mjs`
- Create: `bench/fixture/test/cli.test.mjs`
- Create: `bench/fixture/.gitignore`
- Create: `bench/fixture/.claude/builder.md`
- Create: `bench/README.md`

**Interfaces:**
- Produces: a project whose `npm test` runs `node --test --test-reporter=tap test/*.test.mjs`; a CLI at `src/cli.mjs` reading the notes file from `$NOTES_FILE` (default `./notes.json`); a `.claude/builder.md` with the literal placeholders `{claude_args}` on its `claude_args:` line, which Task 6 fills.

- [ ] **Step 1: Write the fixture's test file (it is the fixture's own suite, so it is written before the CLI)**

`bench/fixture/test/cli.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes() {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  return (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NOTES_FILE: file } }).trim()
}

test('add prints the new id and list shows the note', () => {
  const run = notes()
  assert.equal(run('add', 'buy milk'), '1')
  assert.equal(run('add', 'call mum'), '2')
  assert.equal(run('list'), '1  buy milk\n2  call mum')
})

test('show prints one note and rm removes it', () => {
  const run = notes()
  run('add', 'buy milk')
  run('add', 'call mum')
  assert.equal(run('show', '2'), 'call mum')
  assert.equal(run('rm', '1'), 'removed 1')
  assert.equal(run('list'), '2  call mum')
})

test('show of a missing id fails with a message', () => {
  const run = notes()
  assert.throws(() => run('show', '9'), /no note 9/)
})

test('no command prints usage and fails', () => {
  const run = notes()
  assert.throws(() => run(), /usage: notes/)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd bench/fixture && node --test test/cli.test.mjs`
Expected: 4 failing tests (cannot find `../src/cli.mjs`).

- [ ] **Step 3: Write the store and the CLI**

`bench/fixture/src/store.mjs`:

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export const NOTES_FILE = process.env.NOTES_FILE || './notes.json'

/** { nextId, notes: [{ id, text }] } — an empty store when the file is missing. */
export function load(file = NOTES_FILE) {
  if (!existsSync(file)) return { nextId: 1, notes: [] }
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function save(store, file = NOTES_FILE) {
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n')
}
```

`bench/fixture/src/cli.mjs`:

```js
#!/usr/bin/env node
import { load, save } from './store.mjs'

const USAGE = 'usage: notes add <text> | list | show <id> | rm <id>'
const [cmd, ...args] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
const find = (store, id) => store.notes.find((n) => n.id === Number(id)) ?? fail(`no note ${id}`)

const store = load()
switch (cmd) {
  case 'add': {
    const text = args.join(' ').trim()
    if (!text) fail(USAGE)
    const note = { id: store.nextId++, text }
    store.notes.push(note)
    save(store)
    console.log(String(note.id))
    break
  }
  case 'list':
    console.log(store.notes.map((n) => `${n.id}  ${n.text}`).join('\n'))
    break
  case 'show':
    console.log(find(store, args[0]).text)
    break
  case 'rm': {
    const note = find(store, args[0])
    store.notes = store.notes.filter((n) => n !== note)
    save(store)
    console.log(`removed ${note.id}`)
    break
  }
  default:
    fail(USAGE)
}
```

`bench/fixture/package.json`:

```json
{
  "name": "notes",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "notes": "src/cli.mjs" },
  "scripts": { "test": "node --test --test-reporter=tap test/*.test.mjs" }
}
```

`bench/fixture/.gitignore`:

```
notes.json
node_modules/
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd bench/fixture && npm test`
Expected: `# pass 4` and `# fail 0` in the TAP output.

- [ ] **Step 5: Write the fixture's README and builder config**

`bench/fixture/README.md`:

```markdown
# notes

A small command-line notes app: `notes add <text>`, `notes list`, `notes show <id>`, `notes rm <id>`.
Notes live in a JSON file named by `NOTES_FILE` (default `./notes.json`). No dependencies.

Run the tests with `npm test`. The CLI entry point is `src/cli.mjs` and must stay there.
```

`bench/fixture/.claude/builder.md` — the frontmatter keys are the ones `scripts/config.mjs` reads; `claude_args` holds a placeholder the runner fills (`{claude_args}` is not a `<…>` template placeholder, so `loadConfig` accepts it, but it is only ever meant to be filled):

```markdown
---
project: notes
registry: docs/features
base_branch: main
merge_into: main
apps:
  - name: notes
    path: ./
    role: app
    commit: auto
agent_walk:
  driver: the CLI itself — run `node src/cli.mjs …` with Bash against a scratch NOTES_FILE and read what it prints
  claude_args: {claude_args}
  parallel: 1
  keep_logs: 0
  auto_unpark: 0
---

# notes — builder config

A single-app repo: one Node CLI (`src/cli.mjs`) over one JSON store (`src/store.mjs`), tested with
Node's own test runner. There is no server and no UI; a feature is walked by running the CLI.

## Quality gates

### notes — fast

```
npm test          # the CLI's own tests, every command end to end
```

### Deep set (verify only)

```
```

## Walk readiness

No dev environment: the walk runs `node src/cli.mjs` directly with `NOTES_FILE` pointing at a
scratch file. Nothing to apply, start or smoke.

## Global constraints

- No dependencies. Node's own modules only.
- The CLI entry stays `src/cli.mjs`; tests stay under `test/` and run with `npm test`.
- Every command prints its result on stdout and fails (exit 1, message on stderr) on bad input.
```

`bench/README.md`:

```markdown
# bench — the pipeline benchmark

`/builder:benchmark` runs one small feature through builder at each build profile and through
superpowers and GSD, unattended, and reports time per step, what happened in each step, tokens,
cost, and whether the feature works. Design: `docs/specs/2026-10-13-benchmark-design.md`.

- `fixture/` — the project every run starts from: a notes CLI with its own tests and `.claude/builder.md`.
- `features/<name>/request.md` — the ask, given to every pipeline word for word.
- `features/<name>/accept.test.mjs` — acceptance tests the agent never sees, run after the feature lands.
- `results/<run-id>/REPORT.md` + `runs.json` — committed; the raw streams beside them are not.

Run it: `/builder:benchmark` (or `node scripts/bench.mjs run tags`). Watch it:
`/builder:benchmark --status`. Rebuild a report: `node scripts/bench.mjs report <run-id>`.

Add a feature: a new directory under `features/` with those two files; the acceptance test must
drive the CLI through `src/cli.mjs` with `NOTES_FILE` set, as `fixture/test/cli.test.mjs` does.
```

- [ ] **Step 6: Prove the config parses**

Run: `node -e "import('./scripts/config.mjs').then(m => { const c = m.loadConfig('bench/fixture'); console.log(c.ok, c.agentWalk?.claudeArgs, c.appNames) })"`
Expected: `true {claude_args} [ 'notes' ]`.

- [ ] **Step 7: Commit**

```bash
git add bench/
git commit -m "feat(bench): the fixture — a notes CLI with tests and a builder config"
```

---

### Task 2: The first feature — tags on notes

**Files:**
- Create: `bench/features/tags/request.md`
- Create: `bench/features/tags/accept.test.mjs`

**Interfaces:**
- Produces: `request.md` (the prompt text; Task 7 reads it) and `accept.test.mjs`, which Task 7 copies to `<copy>/test/accept.test.mjs` and runs with `node --test --test-reporter=tap`.

- [ ] **Step 1: Write the request**

`bench/features/tags/request.md`:

```markdown
Notes can carry tags.

- `notes add <text> --tag <t>` stores the note with that tag; `--tag` may be given more than once.
  A tag is one word, lower-case letters, digits and dashes.
- `notes list` is unchanged for untagged notes; a tagged note's line ends with its tags as
  ` #t1 #t2` (sorted, space before each `#`).
- `notes list --tag <t>` shows only notes carrying that tag, in id order.
- `notes show <id>` prints the text on the first line and, when the note has tags, `tags: t1, t2`
  (sorted) on the second.
- `notes tags` lists every tag in use with its count, one per line as `<tag>  <count>`, sorted by
  tag. With no tags at all it prints nothing.
- Existing notes files without tags keep working.

The CLI entry stays `src/cli.mjs`, the tests stay under `test/` and run with `npm test`, and
there are still no dependencies. The feature is done when it is merged into `main` and
`npm test` is green.
```

- [ ] **Step 2: Write the acceptance tests**

`bench/features/tags/accept.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes(seed = null) {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  if (seed) writeFileSync(file, JSON.stringify(seed))
  return (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NOTES_FILE: file } }).trim()
}

test('add --tag stores tags and list shows them sorted', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop', '--tag', 'home')
  run('add', 'call mum')
  assert.equal(run('list'), '1  buy milk #home #shop\n2  call mum')
})

test('list --tag filters', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop')
  run('add', 'call mum', '--tag', 'family')
  run('add', 'buy bread', '--tag', 'shop')
  assert.equal(run('list', '--tag', 'shop'), '1  buy milk #shop\n3  buy bread #shop')
})

test('show prints tags on a second line', () => {
  const run = notes()
  run('add', 'buy milk', '--tag', 'shop', '--tag', 'home')
  run('add', 'call mum')
  assert.equal(run('show', '1'), 'buy milk\ntags: home, shop')
  assert.equal(run('show', '2'), 'call mum')
})

test('tags lists every tag with its count', () => {
  const run = notes()
  run('add', 'a', '--tag', 'shop')
  run('add', 'b', '--tag', 'shop', '--tag', 'home')
  assert.equal(run('tags'), 'home  1\nshop  2')
})

test('tags prints nothing when no note is tagged', () => {
  const run = notes()
  run('add', 'a')
  assert.equal(run('tags'), '')
})

test('an invalid tag fails', () => {
  const run = notes()
  assert.throws(() => run('add', 'a', '--tag', 'Bad Tag'))
})

test('an old notes file without tags still works', () => {
  const run = notes({ nextId: 2, notes: [{ id: 1, text: 'old' }] })
  assert.equal(run('list'), '1  old')
  assert.equal(run('show', '1'), 'old')
  assert.equal(run('tags'), '')
})
```

- [ ] **Step 3: Prove the acceptance tests run and fail against the bare fixture**

Run: `cp bench/features/tags/accept.test.mjs bench/fixture/test/accept.test.mjs && (cd bench/fixture && node --test --test-reporter=tap test/accept.test.mjs; true) | grep -E '^# (pass|fail)'; rm bench/fixture/test/accept.test.mjs`
Expected: `# pass 1` or `# pass 2` (the old-file and no-tags cases may pass) and `# fail 5` or `# fail 6`. What matters: the file loads, and most tests fail without the feature.

- [ ] **Step 4: Commit**

```bash
git add bench/features/tags
git commit -m "feat(bench): the first feature — tags on notes, with acceptance tests the agent never sees"
```

---

### Task 3: `bench-core.mjs` — parse a stream and derive its steps

**Files:**
- Create: `scripts/bench-core.mjs`
- Create: `scripts/test/bench-core.test.mjs`
- Create: `scripts/test/fixtures/bench/session.jsonl`

**Interfaces:**
- Produces:
  - `parseStream(text: string) → { sessionId: string|null, model: string|null, result: object|null, events: Event[] }` where `Event = { t: number (epoch ms), type: 'system'|'assistant'|'user'|'result', top: boolean, parent: string|null, blocks: Block[] }` and `Block = { kind: 'tool_use', id, name, input } | { kind: 'text', text } | { kind: 'tool_result', id }`.
  - `deriveSteps(parsed, { prompt: string }) → Step[]` where `Step = { name, start, end, ms, turns, toolCalls: Record<string, number>, files: string[], commands: string[], tests: string[], subagents: { type: string, first: string }[], gaps: { ms: number, after: string }[] }`.
  - `sessionTotals(parsed) → { ms, turns, tokens: { input, output, cacheRead }, costUsd, ended: 'result'|'cut' }`.
  - `AGENT_TOOLS = new Set(['Agent', 'Task'])`, `STEP_TOOL = 'Skill'`.

- [ ] **Step 1: Write a recorded stream fixture**

`scripts/test/fixtures/bench/session.jsonl` — hand-written, the shapes a real `--verbose` stream has (`timestamp` on every event, `parent_tool_use_id` null at top level). One line each; keep the file exactly these 12 lines:

```
{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"sess-1","model":"claude-sonnet-5-5","timestamp":"2026-10-13T10:00:00.000Z"}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:00:05.000Z","message":{"model":"claude-sonnet-5-5","content":[{"type":"text","text":"Starting."}]}}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:00:10.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"superpowers:brainstorming","args":"tags"}}]}}
{"type":"user","parent_tool_use_id":null,"timestamp":"2026-10-13T10:00:11.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:01:00.000Z","message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/tmp/x/src/cli.mjs"}}]}}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:02:00.000Z","message":{"content":[{"type":"tool_use","id":"t3","name":"Skill","input":{"skill":"superpowers:writing-plans"}}]}}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:03:00.000Z","message":{"content":[{"type":"tool_use","id":"t4","name":"Agent","input":{"subagent_type":"general-purpose","prompt":"Implement task 1: add --tag\nmore"}}]}}
{"type":"assistant","parent_tool_use_id":"t4","timestamp":"2026-10-13T10:03:30.000Z","message":{"content":[{"type":"tool_use","id":"t5","name":"Edit","input":{"file_path":"/tmp/x/src/cli.mjs","old_string":"a","new_string":"b"}}]}}
{"type":"assistant","parent_tool_use_id":"t4","timestamp":"2026-10-13T10:04:00.000Z","message":{"content":[{"type":"tool_use","id":"t6","name":"Bash","input":{"command":"npm test"}}]}}
{"type":"user","parent_tool_use_id":"t4","timestamp":"2026-10-13T10:04:20.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t6","content":"# pass 4"}]}}
{"type":"assistant","parent_tool_use_id":null,"timestamp":"2026-10-13T10:05:00.000Z","message":{"content":[{"type":"text","text":"Done."}]}}
{"type":"result","subtype":"success","duration_ms":300000,"num_turns":7,"total_cost_usd":0.5,"usage":{"input_tokens":100,"output_tokens":900,"cache_read_input_tokens":5000},"result":"Done.","session_id":"sess-1","timestamp":"2026-10-13T10:05:00.000Z"}
```

- [ ] **Step 2: Write the failing tests**

`scripts/test/bench-core.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStream, deriveSteps, sessionTotals } from '../bench-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM = readFileSync(join(HERE, 'fixtures/bench/session.jsonl'), 'utf8')
const T0 = Date.parse('2026-10-13T10:00:00.000Z')

test('parseStream keeps the session, model, result and every event with a timestamp and a parent', () => {
  const p = parseStream(STREAM)
  assert.equal(p.sessionId, 'sess-1')
  assert.equal(p.model, 'claude-sonnet-5-5')
  assert.equal(p.result.num_turns, 7)
  assert.equal(p.events.length, 12)
  assert.equal(p.events[1].t, T0 + 5000)
  assert.equal(p.events[1].top, true)
  assert.equal(p.events[7].top, false)
  assert.equal(p.events[7].parent, 't4')
  assert.deepEqual(p.events[2].blocks[0], { kind: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming', args: 'tags' } })
})

test('parseStream skips blank and non-JSON lines', () => {
  const p = parseStream('\n[fleet] could not start\n' + STREAM.split('\n')[0] + '\n')
  assert.equal(p.events.length, 1)
})

test('steps open on each top-level Skill call; time before the first is (prompt)', () => {
  const steps = deriveSteps(parseStream(STREAM), { prompt: '/superpowers:brainstorming tags' })
  assert.deepEqual(steps.map((s) => s.name), ['(prompt)', 'superpowers:brainstorming', 'superpowers:writing-plans'])
  assert.equal(steps[0].start, T0)
  assert.equal(steps[0].end, T0 + 10000)
  assert.equal(steps[1].ms, 110000)
  assert.equal(steps[2].end, T0 + 300000)
})

test('a step counts its top-level turns and every tool call inside it, subagents included', () => {
  const [, brainstorm, plan] = deriveSteps(parseStream(STREAM), { prompt: 'x' })
  assert.equal(brainstorm.turns, 2)
  assert.deepEqual(brainstorm.toolCalls, { Skill: 1, Read: 1 })
  assert.deepEqual(plan.toolCalls, { Skill: 1, Agent: 1, Edit: 1, Bash: 1 })
  assert.deepEqual(plan.files, ['/tmp/x/src/cli.mjs'])
  assert.deepEqual(plan.commands, ['npm test'])
  assert.deepEqual(plan.tests, ['npm test'])
  assert.deepEqual(plan.subagents, [{ type: 'general-purpose', first: 'Implement task 1: add --tag' }])
})

test('gaps are the longest waits between consecutive events in the step, naming what came before', () => {
  const [, brainstorm] = deriveSteps(parseStream(STREAM), { prompt: 'x' })
  assert.deepEqual(brainstorm.gaps[0], { ms: 60000, after: 'Read /tmp/x/src/cli.mjs' })
  assert.ok(brainstorm.gaps.length <= 5)
})

test('a session that never calls Skill is one step named after its prompt', () => {
  const lines = STREAM.split('\n').filter((l) => l && !l.includes('"name":"Skill"'))
  const steps = deriveSteps(parseStream(lines.join('\n')), { prompt: '/gsd-plan-phase 1' })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].name, '/gsd-plan-phase 1')
  assert.equal(steps[0].ms, 300000)
})

test('no (prompt) step when the first event is a Skill', () => {
  const lines = STREAM.split('\n').filter(Boolean)
  const first = JSON.parse(lines[2])
  first.timestamp = '2026-10-13T10:00:00.000Z'
  const steps = deriveSteps(parseStream([lines[0], JSON.stringify(first), ...lines.slice(3)].join('\n')), { prompt: 'x' })
  assert.equal(steps[0].name, 'superpowers:brainstorming')
})

test('a stream with no result event is cut: totals from the last event, zero tokens', () => {
  const lines = STREAM.split('\n').filter(Boolean).slice(0, -1)
  const p = parseStream(lines.join('\n'))
  const t = sessionTotals(p)
  assert.equal(t.ended, 'cut')
  assert.equal(t.ms, 300000)
  assert.equal(t.turns, 6)
  assert.deepEqual(t.tokens, { input: 0, output: 0, cacheRead: 0 })
  assert.equal(t.costUsd, 0)
  const steps = deriveSteps(p, { prompt: 'x' })
  assert.equal(steps.at(-1).end, T0 + 300000)
})

test('sessionTotals reads the result event when there is one', () => {
  const t = sessionTotals(parseStream(STREAM))
  assert.deepEqual(t, { ms: 300000, turns: 7, tokens: { input: 100, output: 900, cacheRead: 5000 }, costUsd: 0.5, ended: 'result' })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: every test fails with "Cannot find module '../bench-core.mjs'".

- [ ] **Step 4: Write `bench-core.mjs` (this part of it)**

`scripts/bench-core.mjs`:

```js
/**
 * The benchmark's meaning, free of processes and files: a stream → its steps and totals; a set
 * of runs → the report. bench.mjs does the side effects.
 */
import { duration, formatTokens, tokensOf } from './fleet-core.mjs'

export const STEP_TOOL = 'Skill'
export const AGENT_TOOLS = new Set(['Agent', 'Task'])
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'])
const TEST_RE = /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bnode\s+--test\b|\bvitest\b|\bjest\b|\bpytest\b|\bplaywright\s+test\b/

const ms = (iso) => (iso ? Date.parse(iso) : NaN)

/** One stream-json file → { sessionId, model, result, events }. Non-JSON lines are skipped. */
export function parseStream(text) {
  const out = { sessionId: null, model: null, result: null, events: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object' || !ev.type) continue
    out.sessionId ??= ev.session_id ?? null
    out.model ??= ev.model ?? ev.message?.model ?? null
    if (ev.type === 'result') out.result = ev
    const parent = ev.parent_tool_use_id ?? null
    const blocks = []
    for (const b of ev.message?.content ?? []) {
      if (b?.type === 'tool_use') blocks.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
      else if (b?.type === 'text') blocks.push({ kind: 'text', text: b.text ?? '' })
      else if (b?.type === 'tool_result') blocks.push({ kind: 'tool_result', id: b.tool_use_id })
    }
    out.events.push({ t: ms(ev.timestamp), type: ev.type, top: parent == null, parent, blocks })
  }
  return out
}

const firstLine = (s) => String(s ?? '').split('\n')[0].trim().slice(0, 80)

/** What a tool call did, in a few words — the label a gap or a file list uses. */
export function describeCall(b) {
  const i = b.input ?? {}
  if (b.name === STEP_TOOL) return `Skill ${i.skill ?? ''}`.trim()
  if (b.name === 'Bash') return `Bash ${firstLine(i.command)}`
  if (FILE_TOOLS.has(b.name)) return `${b.name} ${i.file_path ?? i.notebook_path ?? ''}`.trim()
  if (AGENT_TOOLS.has(b.name)) return `${b.name} ${i.subagent_type ?? ''} ${firstLine(i.description ?? i.prompt)}`.trim()
  return b.name
}

function emptyStep(name, start) {
  return { name, start, end: start, ms: 0, turns: 0, toolCalls: {}, files: [], commands: [], tests: [], subagents: [], gaps: [] }
}

/** The last timestamp in the stream — the result's when there is one. */
export function endOf(parsed) {
  const ts = parsed.events.map((e) => e.t).filter(Number.isFinite)
  return ts.length ? Math.max(...ts) : NaN
}

/**
 * Steps: one opens on each top-level Skill call and closes on the next, or at the end. Time before
 * the first is `(prompt)`; a session with no Skill call is one step named after its prompt.
 */
export function deriveSteps(parsed, { prompt }) {
  const events = parsed.events.filter((e) => Number.isFinite(e.t))
  if (!events.length) return []
  const t0 = events[0].t
  const end = endOf(parsed)
  const steps = []
  let cur = null
  let lastEvent = null
  const open = (name, at) => {
    if (cur) cur.end = at
    cur = emptyStep(name, at)
    steps.push(cur)
  }
  for (const e of events) {
    // The wait that ends at this event belongs to the step that was running during it — so it is
    // recorded before a Skill call in this event opens the next step.
    if (cur && lastEvent && e.t - lastEvent.t > 0) cur.gaps.push({ ms: e.t - lastEvent.t, after: lastEvent.label })
    const skill = e.top ? e.blocks.find((b) => b.kind === 'tool_use' && b.name === STEP_TOOL) : null
    if (skill) open(skill.input.skill ?? 'Skill', e.t)
    else if (!cur) open('(prompt)', t0)
    if (e.type === 'assistant' && e.top) cur.turns++
    let label = lastEvent?.label ?? '(start)'
    for (const b of e.blocks) {
      if (b.kind !== 'tool_use') continue
      cur.toolCalls[b.name] = (cur.toolCalls[b.name] ?? 0) + 1
      const i = b.input
      if (FILE_TOOLS.has(b.name) && i.file_path && !cur.files.includes(i.file_path)) cur.files.push(i.file_path)
      if (b.name === 'Bash' && i.command) {
        const c = firstLine(i.command)
        cur.commands.push(c)
        if (TEST_RE.test(i.command)) cur.tests.push(c)
      }
      if (AGENT_TOOLS.has(b.name)) cur.subagents.push({ type: i.subagent_type ?? 'agent', first: firstLine(i.description ?? i.prompt) })
      label = describeCall(b)
    }
    lastEvent = { t: e.t, label }
  }
  cur.end = end
  if (steps.length > 1 && steps[0].name === '(prompt)' && steps[0].end === steps[0].start) steps.shift()
  if (steps.length === 1 && steps[0].name === '(prompt)') steps[0].name = prompt
  for (const s of steps) {
    s.ms = s.end - s.start
    s.gaps = s.gaps.sort((a, b) => b.ms - a.ms).slice(0, 5)
  }
  return steps
}

/** Duration, turns, tokens and cost — the result event's when the session ended with one. */
export function sessionTotals(parsed) {
  const r = parsed.result
  const events = parsed.events.filter((e) => Number.isFinite(e.t))
  const wall = events.length ? endOf(parsed) - events[0].t : 0
  if (r) {
    const tk = tokensOf(r)
    return { ms: r.duration_ms ?? wall, turns: r.num_turns ?? 0, tokens: { input: tk.input, output: tk.output, cacheRead: tk.cacheRead }, costUsd: tk.costUsd, ended: 'result' }
  }
  return { ms: wall, turns: events.filter((e) => e.type === 'assistant' && e.top).length, tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0, ended: 'cut' }
}

export { duration, formatTokens }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: 9 passing. If "turns" for brainstorm is off by one, check that the Skill event itself (a top-level assistant event) counts as a turn of the step it opens — it should: `brainstorm.turns === 2` is the Skill call and the Read.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench-core.mjs scripts/test/bench-core.test.mjs scripts/test/fixtures/bench/session.jsonl
git commit -m "feat(bench): bench-core parses a stream-json session into steps and totals"
```

---

### Task 4: `bench-core.mjs` — scores, config totals, medians, the summary

**Files:**
- Modify: `scripts/bench-core.mjs`
- Modify: `scripts/test/bench-core.test.mjs`

**Interfaces:**
- Produces:
  - `parseTap(text) → { passed, failed, total }` from `node --test --test-reporter=tap` output (`# pass N` / `# fail N` lines).
  - `runTotals(sessions: { totals: SessionTotals }[]) → { ms, turns, tokens: {input,output,cacheRead}, costUsd }` (sums).
  - `median(nums: number[]) → number` (NaN for an empty list).
  - `summarize(runs: Run[]) → SummaryRow[]`: one row per config, median over its reps of each numeric field; `Run` is the row shape Task 7 writes into `runs.json`:
    ```
    Run = { config, pipeline, profile, rep, status, path: 'pipeline'|'in-chat', startedAt, endedAt, ms,
            sessions: [{ name, file, lane, sessionId, model, prompt, totals: SessionTotals, steps: Step[], tail: string[] }],
            totals: { ms, turns, tokens, costUsd }, score: { accept: {passed,failed,total}|null, fixture: {…}|null }, copy, gitLog: string[] }
    SummaryRow = { config, n, status, ms, turns, tokens, costUsd, accept, fixture, longest: { name, ms }|null, steps: Record<name, ms (median)>, flagged: string|null }
    ```

- [ ] **Step 1: Add the failing tests**

Append to `scripts/test/bench-core.test.mjs` (extend the import line to `{ parseStream, deriveSteps, sessionTotals, parseTap, runTotals, median, summarize }`):

```js
test('parseTap reads the pass and fail counts', () => {
  assert.deepEqual(parseTap('TAP version 13\nok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n'), { passed: 1, failed: 1, total: 2 })
  assert.deepEqual(parseTap(''), { passed: 0, failed: 0, total: 0 })
})

test('runTotals sums the sessions', () => {
  const s = (ms, turns, input, output, cacheRead, costUsd) => ({ totals: { ms, turns, tokens: { input, output, cacheRead }, costUsd, ended: 'result' } })
  assert.deepEqual(runTotals([s(10, 1, 1, 2, 3, 0.1), s(20, 2, 10, 20, 30, 0.2)]), { ms: 30, turns: 3, tokens: { input: 11, output: 22, cacheRead: 33 }, costUsd: 0.30000000000000004 })
})

test('median', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.ok(Number.isNaN(median([])))
})

const run = (config, rep, over = {}) => ({
  config, pipeline: config.split('-')[0], profile: config.startsWith('builder') ? config.split('-')[1] : null, rep, status: 'done', path: 'pipeline',
  startedAt: 0, endedAt: 0, ms: 100, sessions: [{ name: 'a', steps: [{ name: 'builder:audit', ms: 40 }, { name: 'builder:build', ms: 60 }] }],
  totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1 }, score: { accept: { passed: 7, failed: 0, total: 7 }, fixture: { passed: 4, failed: 0, total: 4 } }, copy: '/tmp/c', gitLog: [], ...over,
})

test('summarize gives one row per config with medians over reps and the longest step', () => {
  const rows = summarize([run('builder-rush', 1), run('builder-rush', 2, { ms: 300, totals: { ms: 300, turns: 30, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 3 } }), run('gsd', 1)])
  assert.equal(rows.length, 2)
  const rush = rows.find((r) => r.config === 'builder-rush')
  assert.equal(rush.n, 2)
  assert.equal(rush.ms, 200)
  assert.equal(rush.costUsd, 2)
  assert.deepEqual(rush.longest, { name: 'builder:build', ms: 60 })
  assert.deepEqual(rush.steps, { 'builder:audit': 40, 'builder:build': 60 })
  assert.deepEqual(rush.accept, { passed: 7, total: 7 })
})

test('summarize flags an in-chat builder row and carries a not-done status', () => {
  const rows = summarize([run('builder-rush', 1, { path: 'in-chat' }), run('gsd', 1, { status: 'not run: npx failed', score: { accept: null, fixture: null } })])
  assert.equal(rows[0].flagged, 'built in chat (sized xs/sm) — not the pipeline; resize the feature')
  assert.equal(rows[1].status, 'not run: npx failed')
  assert.equal(rows[1].accept, null)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: the five new tests fail (`parseTap is not a function` etc.).

- [ ] **Step 3: Implement**

Append to `scripts/bench-core.mjs`:

```js
/** `# pass N` / `# fail N` from node --test's TAP reporter. */
export function parseTap(text) {
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(text ?? '')?.[1] ?? 0)
  const passed = n('pass')
  const failed = n('fail')
  return { passed, failed, total: passed + failed }
}

export function runTotals(sessions) {
  const t = { ms: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, costUsd: 0 }
  for (const s of sessions) {
    const x = s.totals ?? {}
    t.ms += x.ms ?? 0
    t.turns += x.turns ?? 0
    t.tokens.input += x.tokens?.input ?? 0
    t.tokens.output += x.tokens?.output ?? 0
    t.tokens.cacheRead += x.tokens?.cacheRead ?? 0
    t.costUsd += x.costUsd ?? 0
  }
  return t
}

export function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return NaN
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

export const IN_CHAT_FLAG = 'built in chat (sized xs/sm) — not the pipeline; resize the feature'

/** Every step of a run, by name, with its time — the same name twice (two fleet runs both auditing) adds up. */
export function stepTimes(run) {
  const out = {}
  for (const s of run.sessions ?? []) for (const st of s.steps ?? []) out[st.name] = (out[st.name] ?? 0) + st.ms
  return out
}

/** One row per config: medians over its reps. Status is the worst rep's (`done` only when every rep is). */
export function summarize(runs) {
  const byConfig = new Map()
  for (const r of runs) (byConfig.get(r.config) ?? byConfig.set(r.config, []).get(r.config)).push(r)
  const rows = []
  for (const [config, reps] of byConfig) {
    const med = (f) => median(reps.map(f))
    const stepNames = [...new Set(reps.flatMap((r) => Object.keys(stepTimes(r))))]
    const steps = Object.fromEntries(stepNames.map((n) => [n, med((r) => stepTimes(r)[n] ?? 0)]))
    const longest = Object.entries(steps).sort((a, b) => b[1] - a[1])[0]
    const scored = (k) => (reps.some((r) => r.score?.[k]) ? { passed: med((r) => r.score?.[k]?.passed ?? 0), total: med((r) => r.score?.[k]?.total ?? 0) } : null)
    rows.push({
      config,
      n: reps.length,
      status: reps.find((r) => r.status !== 'done')?.status ?? 'done',
      ms: med((r) => r.ms),
      turns: med((r) => r.totals?.turns),
      tokens: med((r) => (r.totals?.tokens?.input ?? 0) + (r.totals?.tokens?.output ?? 0)),
      costUsd: med((r) => r.totals?.costUsd),
      accept: scored('accept'),
      fixture: scored('fixture'),
      longest: longest ? { name: longest[0], ms: longest[1] } : null,
      steps,
      flagged: reps.some((r) => r.path === 'in-chat') ? IN_CHAT_FLAG : null,
    })
  }
  return rows
}
```

- [ ] **Step 4: Run to see them pass**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: 14 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-core.mjs scripts/test/bench-core.test.mjs
git commit -m "feat(bench): scores, run totals, medians and the per-config summary"
```

---

### Task 5: `bench-core.mjs` — render the report

**Files:**
- Modify: `scripts/bench-core.mjs`
- Modify: `scripts/test/bench-core.test.mjs`

**Interfaces:**
- Consumes: `summarize`, `stepTimes`, `duration`, `formatTokens`.
- Produces: `renderReport(data) → string` (markdown) where `data` is the whole `runs.json`: `{ runId, feature, model, startedAt, endedAt, versions: { builder, superpowers, gsd }, runs: Run[] }`; and `renderStatusTable(data, progress|null) → string` — the summary table plus a line about the config now running, used by `bench.mjs status`.

- [ ] **Step 1: Add the failing tests**

Append to `scripts/test/bench-core.test.mjs` (add `renderReport, renderStatusTable` to the import):

```js
const DATA = {
  runId: '2026-10-13-1200-tags', feature: 'tags', model: 'claude-sonnet-5-5', startedAt: 1, endedAt: 2,
  versions: { builder: '4.11.0', superpowers: '6.4.1', gsd: '1.7.0' },
  runs: [
    run('builder-rush', 1, { sessions: [{ name: 'brainstorm', prompt: '/builder:brainstorm --auto …', totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1, ended: 'result' },
      steps: [{ name: 'builder:brainstorm', start: 0, end: 40, ms: 40, turns: 3, toolCalls: { Read: 2, Skill: 1 }, files: ['src/cli.mjs'], commands: ['ls'], tests: [], subagents: [], gaps: [{ ms: 30, after: 'Read src/cli.mjs' }] },
              { name: 'builder:build', start: 40, end: 100, ms: 60, turns: 7, toolCalls: { Agent: 2, Edit: 4, Bash: 3 }, files: ['src/cli.mjs', 'test/cli.test.mjs'], commands: ['npm test'], tests: ['npm test'], subagents: [{ type: 'general-purpose', first: 'Implement task 1' }], gaps: [] }], tail: [] }] }),
    run('gsd', 1, { status: 'timed out', score: { accept: { passed: 2, failed: 5, total: 7 }, fixture: { passed: 4, failed: 0, total: 4 } }, sessions: [{ name: '/gsd-plan-phase 1', prompt: '/gsd-plan-phase 1', totals: { ms: 100, turns: 10, tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: 1, ended: 'cut' }, steps: [{ name: '/gsd-plan-phase 1', start: 0, end: 100, ms: 100, turns: 10, toolCalls: {}, files: [], commands: [], tests: [], subagents: [], gaps: [] }], tail: ['last line'] }] }),
  ],
}

test('renderReport has the summary table, the steps table and a section per config', () => {
  const md = renderReport(DATA)
  assert.match(md, /^# benchmark 2026-10-13-1200-tags — tags/m)
  assert.match(md, /builder 4\.11\.0 · superpowers 6\.4\.1 · gsd 1\.7\.0 · claude-sonnet-5-5/)
  assert.match(md, /\| Config \| Status \| Wall \| Turns \| Tokens \| Cost \| Accept \| Fixture tests \| Longest step \|/)
  assert.match(md, /\| builder-rush \| done \| 0s \| 10 \| 3 \| \$1\.00 \| 7\/7 \| 4\/4 \| builder:build 0s \|/)
  assert.match(md, /\| gsd \| timed out \|/)
  assert.match(md, /\| Config \| builder:brainstorm \| builder:build \| \/gsd-plan-phase 1 \|/)
  assert.match(md, /\| builder-rush \| 0s \| 0s \| — \|/)
  assert.match(md, /^## builder-rush$/m)
  assert.match(md, /builder:build — 0s, 7 turns, Agent 2 · Edit 4 · Bash 3/)
  assert.match(md, /files: src\/cli\.mjs, test\/cli\.test\.mjs/)
  assert.match(md, /subagents: general-purpose — Implement task 1/)
  assert.match(md, /longest waits: 0s after Read src\/cli\.mjs/)
  assert.match(md, /^## gsd — timed out$/m)
  assert.match(md, /last line/)
})

test('renderReport flags an in-chat row and prints medians with n', () => {
  const md = renderReport({ ...DATA, runs: [run('builder-rush', 1, { path: 'in-chat' }), run('builder-rush', 2, { path: 'in-chat' })] })
  assert.match(md, /\| builder-rush ⚠ \| done \|/)
  assert.match(md, /median of 2 reps/)
  assert.match(md, /⚠ builder-rush: built in chat/)
})

test('renderStatusTable adds the config now running', () => {
  const s = renderStatusTable(DATA, { config: 'superpowers', rep: 1, session: 'superpowers', startedAt: Date.now() - 65000 })
  assert.match(s, /\| builder-rush \|/)
  assert.match(s, /running: superpowers \(session superpowers, 1m\)/)
  assert.match(renderStatusTable(DATA, null), /not running/)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: 3 new failures.

- [ ] **Step 3: Implement**

Append to `scripts/bench-core.mjs`:

```js
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : '—')
const dur = (n) => (Number.isFinite(n) ? duration(n) : '—')
const score = (s) => (s ? `${Math.round(s.passed)}/${Math.round(s.total)}` : '—')
const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
const calls = (tc) => Object.entries(tc ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')

export function renderSummary(data) {
  const rows = summarize(data.runs ?? [])
  const reps = Math.max(1, ...rows.map((r) => r.n))
  const lines = ['| Config | Status | Wall | Turns | Tokens | Cost | Accept | Fixture tests | Longest step |', '|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) {
    lines.push(`| ${r.config}${r.flagged ? ' ⚠' : ''} | ${cell(r.status)} | ${dur(r.ms)} | ${Number.isFinite(r.turns) ? Math.round(r.turns) : '—'} | ${Number.isFinite(r.tokens) ? formatTokens(r.tokens) : '—'} | ${usd(r.costUsd)} | ${score(r.accept)} | ${score(r.fixture)} | ${r.longest ? `${r.longest.name} ${dur(r.longest.ms)}` : '—'} |`)
  }
  if (reps > 1) lines.push('', `median of ${reps} reps`)
  for (const r of rows) if (r.flagged) lines.push('', `⚠ ${r.config}: ${r.flagged}`)
  return { rows, text: lines.join('\n') }
}

export function renderReport(data) {
  const { rows, text: summary } = renderSummary(data)
  const v = data.versions ?? {}
  const out = [`# benchmark ${data.runId} — ${data.feature}`, '', `builder ${v.builder ?? '—'} · superpowers ${v.superpowers ?? '—'} · gsd ${v.gsd ?? '—'} · ${data.model ?? 'default model'} · ${new Date(data.startedAt).toISOString()}`, '', '## Summary', '', summary]
  const stepNames = [...new Set(rows.flatMap((r) => Object.keys(r.steps)))]
  out.push('', '## Time per step', '', `| Config | ${stepNames.map(cell).join(' | ')} |`, `|---|${stepNames.map(() => '---').join('|')}|`)
  for (const r of rows) out.push(`| ${r.config} | ${stepNames.map((n) => (n in r.steps ? dur(r.steps[n]) : '—')).join(' | ')} |`)
  for (const run of data.runs ?? []) {
    const reps = (data.runs ?? []).filter((x) => x.config === run.config).length
    out.push('', `## ${run.config}${reps > 1 ? ` — rep ${run.rep}` : ''}${run.status === 'done' ? '' : ` — ${run.status}`}`, '')
    if (run.path === 'in-chat') out.push(`⚠ ${IN_CHAT_FLAG}`, '')
    out.push(`wall ${dur(run.ms)} · ${run.totals?.turns ?? 0} turns · ${formatTokens((run.totals?.tokens?.input ?? 0) + (run.totals?.tokens?.output ?? 0))} tokens · ${usd(run.totals?.costUsd)} · accept ${score(run.score?.accept)} · fixture ${score(run.score?.fixture)}`, `copy: \`${run.copy ?? '—'}\``, '')
    for (const s of run.sessions ?? []) {
      out.push(`### ${s.name}${s.lane ? ` (${s.lane})` : ''} — ${dur(s.totals?.ms)}, ${s.totals?.turns ?? 0} turns${s.totals?.ended === 'cut' ? ', cut off' : ''}`, '', `prompt: \`${firstLine(s.prompt)}\``, '')
      for (const st of s.steps ?? []) {
        out.push(`- **${st.name}** — ${dur(st.ms)}, ${st.turns} turns${calls(st.toolCalls) ? `, ${calls(st.toolCalls)}` : ''}`)
        if (st.files?.length) out.push(`  - files: ${st.files.join(', ')}`)
        if (st.tests?.length) out.push(`  - tests: ${[...new Set(st.tests)].join(' · ')}`)
        if (st.subagents?.length) out.push(`  - subagents: ${st.subagents.map((a) => `${a.type} — ${a.first}`).join(' · ')}`)
        if (st.gaps?.length) out.push(`  - longest waits: ${st.gaps.map((g) => `${dur(g.ms)} after ${g.after}`).join(' · ')}`)
      }
      if (run.status !== 'done' && s.tail?.length) out.push('', '```', ...s.tail.slice(-10), '```')
      out.push('')
    }
    if (run.gitLog?.length) out.push('git log main:', '', '```', ...run.gitLog.slice(0, 20), '```')
  }
  return out.join('\n') + '\n'
}

export function renderStatusTable(data, progress) {
  const { text } = renderSummary(data)
  const line = progress ? `running: ${progress.config} (session ${progress.session}, ${duration(Date.now() - progress.startedAt)})` : 'not running'
  return `${text}\n\n${line}\n`
}
```

`firstLine` is defined in Task 3's code above; it is in scope.

- [ ] **Step 4: Run to see them pass**

Run: `node --test scripts/test/bench-core.test.mjs`
Expected: 17 passing. `fleet-core.duration` prints whole seconds and minutes only (`0s`, `1m`, `1h05m`), which is what the expectations above assume.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-core.mjs scripts/test/bench-core.test.mjs
git commit -m "feat(bench): render the report — summary, time per step, a section per config"
```

---

### Task 6: `bench.mjs` — paths, the copy, the session runner, `--dry-run`

**Files:**
- Create: `scripts/bench.mjs`
- Create: `scripts/test/bench.test.mjs`
- Create: `scripts/test/fixtures/bench/stub-claude.mjs`

**Interfaces:**
- Consumes: `parseStream`, `deriveSteps`, `sessionTotals` (Task 3).
- Produces (module exports, used by Task 7 and 8 inside the same file and by the tests):
  - `resultsDir(root) → string`: `<root>/bench/results` when `<root>/.claude-plugin/plugin.json` names `builder`, else `<root>/.builder/bench`.
  - `prepareCopy({ fixture, dest, claudeArgs }) → { copy }`: copies the fixture, writes `.claude/bench-settings.json`, fills `{claude_args}` in `.claude/builder.md`, `git init`, first commit `fixture` on `main`, `.git/info/exclude` with `REQUEST.md`.
  - `runSession({ copy, name, prompt, outFile, claudeArgs, systemPrompt, model, runTimeoutMs, idleTimeoutMs }) → Promise<{ exit: number|null, file }>` (exit `null` = killed on a timeout).
  - `sessionRecord({ name, lane, prompt, file }) → Session` — parses the file into the `Session` row shape of Task 4.
  - Env: `BENCH_CLAUDE` (the `claude` binary; the tests point it at the stub), `BENCH_RUN_TIMEOUT_MS` (default 2h), `BENCH_IDLE_TIMEOUT_MS` (default 20 min), `BENCH_TMP` (where copies go; default `$TMPDIR/bench`).
  - CLI: `node scripts/bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach]`, plus `report`, `status`, `clean` (Task 8).

- [ ] **Step 1: Write the stub claude**

`scripts/test/fixtures/bench/stub-claude.mjs` — stands in for `claude -p`. The scenario (`STUB_SCENARIO`, JSON) maps a substring of the prompt to what to do; the first key found in the prompt wins. It records every call to `STUB_STATE/calls.log` as `<prompt first 60 chars> | <flags>`.

```js
#!/usr/bin/env node
// A stand-in for `claude -p` in the bench tests. Scenario: { "<prompt substring>": { skills: [...],
// files: { "rel/path": "content" }, commit: "msg", manifest: "feature-name", exit: 0, hang: false } }.
// Emits a stream-json session: init, one Skill tool_use per skill (10 ms apart), a result.
import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
if (argv[0] === 'plugin') {
  console.log('builder 0.0.0-stub (plugin-dir)')
  process.exit(0)
}
const prompt = argv[argv.indexOf('-p') + 1] ?? ''
const flags = argv.filter((a) => a.startsWith('--')).join(' ')
appendFileSync(join(process.env.STUB_STATE, 'calls.log'), `${prompt.slice(0, 60).replace(/\n/g, ' ')} | ${flags}\n`)
const all = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'))
const key = Object.keys(all).find((k) => prompt.includes(k))
const s = all[key] ?? { skills: [] }
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let t = Date.now()
const ts = () => new Date((t += 10)).toISOString()
line({ type: 'system', subtype: 'init', session_id: 'stub', model: 'stub-model', timestamp: ts() })
for (const skill of s.skills ?? []) {
  line({ type: 'assistant', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_use', id: `t-${skill}`, name: 'Skill', input: { skill } }] } })
  line({ type: 'user', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: `t-${skill}`, content: 'ok' }] } })
}
for (const [rel, content] of Object.entries(s.files ?? {})) {
  mkdirSync(join(process.cwd(), dirname(rel)), { recursive: true })
  writeFileSync(join(process.cwd(), rel), content)
}
if (s.manifest) {
  mkdirSync(join(process.cwd(), 'docs/features', s.manifest), { recursive: true })
  writeFileSync(join(process.cwd(), 'docs/features', s.manifest, 'MANIFEST.md'), 'size: md\nstate: spec\nnext: /builder:resume\n')
  writeFileSync(join(process.cwd(), 'docs/features', s.manifest, 'SPEC.md'), '# spec\n')
}
if (s.commit) {
  execFileSync('git', ['add', '-A'], { cwd: process.cwd() })
  execFileSync('git', ['-c', 'user.name=stub', '-c', 'user.email=stub@x', 'commit', '-qm', s.commit], { cwd: process.cwd() })
}
if (s.hang) setInterval(() => {}, 1000)
else {
  line({ type: 'result', subtype: 'success', duration_ms: 30, num_turns: (s.skills ?? []).length, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 }, result: 'done', session_id: 'stub', timestamp: ts() })
  process.exit(s.exit ?? 0)
}
```

- [ ] **Step 2: Write the failing tests**

`scripts/test/bench.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = realpathSync(join(HERE, '..', '..'))
const BENCH = join(REPO, 'scripts', 'bench.mjs')
const STUB = join(HERE, 'fixtures', 'bench', 'stub-claude.mjs')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

/** A root that is NOT the builder repo (so results go to .builder/bench) with a stub state dir. */
export function makeRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-')))
  mkdirSync(join(root, '.stub'))
  return root
}

export function runBench(root, args, scenario = {}, env = {}) {
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify(scenario))
  const r = spawnSync('node', [BENCH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, BENCH_CLAUDE: STUB, BENCH_TMP: join(root, 'tmp'), BENCH_GSD_INSTALL: 'true', BENCH_FLEET: join(HERE, 'fixtures', 'bench', 'stub-fleet.mjs'), STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub'), BENCH_RUN_TIMEOUT_MS: '20000', BENCH_IDLE_TIMEOUT_MS: '20000', ...env },
  })
  const calls = existsSync(join(root, '.stub/calls.log')) ? readFileSync(join(root, '.stub/calls.log'), 'utf8').trim().split('\n') : []
  return { ...r, calls }
}

test('resultsDir: bench/results inside the builder repo, .builder/bench elsewhere', async () => {
  const { resultsDir } = await import('../bench.mjs')
  assert.equal(resultsDir(REPO), join(REPO, 'bench', 'results'))
  const root = makeRoot()
  assert.equal(resultsDir(root), join(root, '.builder', 'bench'))
})

test('prepareCopy: a git repo on main with the fixture committed, settings written, claude_args filled, REQUEST.md excluded', async () => {
  const { prepareCopy } = await import('../bench.mjs')
  const root = makeRoot()
  const { copy } = prepareCopy({ fixture: join(REPO, 'bench', 'fixture'), dest: join(root, 'c1'), claudeArgs: '--permission-mode bypassPermissions --plugin-dir /p --settings /s' })
  assert.equal(copy, join(root, 'c1'))
  assert.equal(git(copy, 'branch', '--show-current'), 'main')
  assert.equal(git(copy, 'log', '--format=%s'), 'fixture')
  assert.equal(git(copy, 'status', '--porcelain'), '')
  const settings = JSON.parse(readFileSync(join(copy, '.claude', 'bench-settings.json'), 'utf8'))
  assert.deepEqual(settings.enabledPlugins, { 'builder@claude-builder': false, 'superpowers@claude-plugins-official': false })
  assert.match(readFileSync(join(copy, '.claude', 'builder.md'), 'utf8'), /claude_args: --permission-mode bypassPermissions --plugin-dir \/p --settings \/s/)
  assert.match(readFileSync(join(copy, '.git', 'info', 'exclude'), 'utf8'), /^REQUEST\.md$/m)
  writeFileSync(join(copy, 'REQUEST.md'), 'x')
  assert.equal(git(copy, 'status', '--porcelain'), '')
})

test('prepareCopy refuses a destination with a space in it', async () => {
  const { prepareCopy } = await import('../bench.mjs')
  const root = makeRoot()
  assert.throws(() => prepareCopy({ fixture: join(REPO, 'bench', 'fixture'), dest: join(root, 'has space'), claudeArgs: '' }), /no spaces/)
})

test('runSession streams to the file, passes the flags, and sessionRecord reads it back', async () => {
  const { runSession, sessionRecord } = await import('../bench.mjs')
  const root = makeRoot()
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ hello: { skills: ['superpowers:brainstorming', 'superpowers:writing-plans'] } }))
  const out = join(root, 'session-01-sp.jsonl')
  const r = await runSession({ copy: root, name: 'sp', prompt: 'hello world', outFile: out, claudeArgs: ['--plugin-dir', '/p'], systemPrompt: 'OWNER', model: 'm1', runTimeoutMs: 20000, idleTimeoutMs: 20000, claude: STUB, env: { STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') } })
  assert.equal(r.exit, 0)
  const calls = readFileSync(join(root, '.stub/calls.log'), 'utf8')
  assert.match(calls, /hello world \| .*--output-format.*--plugin-dir.*--append-system-prompt.*--model/)
  const s = sessionRecord({ name: 'sp', lane: null, prompt: 'hello world', file: out })
  assert.deepEqual(s.steps.map((x) => x.name), ['superpowers:brainstorming', 'superpowers:writing-plans'])
  assert.equal(s.totals.ended, 'result')
  assert.equal(s.sessionId, 'stub')
})

test('runSession kills a hung session on the idle timeout and reports exit null', async () => {
  const { runSession, sessionRecord } = await import('../bench.mjs')
  const root = makeRoot()
  writeFileSync(join(root, '.stub/scenario.json'), JSON.stringify({ hang: { skills: ['a'], hang: true } }))
  const out = join(root, 'session-01-h.jsonl')
  const r = await runSession({ copy: root, name: 'h', prompt: 'hang', outFile: out, claudeArgs: [], systemPrompt: '', model: null, runTimeoutMs: 20000, idleTimeoutMs: 500, claude: STUB, env: { STUB_SCENARIO: join(root, '.stub/scenario.json'), STUB_STATE: join(root, '.stub') } })
  assert.equal(r.exit, null)
  assert.equal(sessionRecord({ name: 'h', lane: null, prompt: 'hang', file: out }).totals.ended, 'cut')
})

test('--dry-run prepares one copy, prints the sessions per config with their prompts, and runs nothing', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /builder-rush: 3 sessions/)
  assert.match(r.stdout, /\/builder:brainstorm --auto/)
  assert.match(r.stdout, /choose \*\*rush\*\*/)
  assert.match(r.stdout, /superpowers: 1 session/)
  assert.match(r.stdout, /gsd: 4 sessions/)
  assert.match(r.stdout, /\/gsd-new-project --auto @REQUEST\.md/)
  assert.match(r.stdout, /--plugin-dir/)
  assert.deepEqual(r.calls.filter((c) => !c.startsWith('plugin')), [])
})

test('run refuses an unknown feature and an unknown --only config', () => {
  const root = makeRoot()
  assert.match(runBench(root, ['run', 'nope', '--dry-run']).stderr, /no feature 'nope'/)
  assert.match(runBench(root, ['run', 'tags', '--only', 'x', '--dry-run']).stderr, /unknown config 'x'/)
})
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test scripts/test/bench.test.mjs`
Expected: all fail (`Cannot find module '../bench.mjs'`).

- [ ] **Step 4: Write `bench.mjs` — the first half**

`scripts/bench.mjs`:

```js
#!/usr/bin/env node
/**
 * bench — run one feature through builder (rush / standard / thorough), superpowers and GSD,
 * unattended, and report time per step. Design: docs/specs/2026-10-13-benchmark-design.md.
 *
 *   node scripts/bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach]
 *   node scripts/bench.mjs report <run-id>
 *   node scripts/bench.mjs status
 *   node scripts/bench.mjs clean
 *
 * Env: BENCH_CLAUDE (the claude binary), BENCH_TMP (where copies go; $TMPDIR/bench),
 * BENCH_RUN_TIMEOUT_MS (2h), BENCH_IDLE_TIMEOUT_MS (20 min), BENCH_FLEET (the fleet script —
 * tests point it at a stub), BENCH_GSD_INSTALL (the install command — tests set `true`).
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, createWriteStream, openSync, renameSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseStream, deriveSteps, sessionTotals, runTotals, parseTap, renderReport, renderStatusTable } from './bench-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUILDER = resolve(HERE, '..')
const CLAUDE = process.env.BENCH_CLAUDE || 'claude'
const RUN_TIMEOUT_MS = Number(process.env.BENCH_RUN_TIMEOUT_MS) || 2 * 60 * 60 * 1000
const IDLE_TIMEOUT_MS = Number(process.env.BENCH_IDLE_TIMEOUT_MS) || 20 * 60 * 1000
const TMP = process.env.BENCH_TMP || join(process.env.TMPDIR || tmpdir(), 'bench')

const die = (msg) => {
  console.error(msg)
  process.exit(2)
}
const sh = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const git = (cwd, ...a) => sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...a], cwd)

/** bench/results inside the builder repo; .builder/bench (git-ignored) anywhere else. */
export function resultsDir(root) {
  const p = join(root, '.claude-plugin', 'plugin.json')
  try {
    if (JSON.parse(readFileSync(p, 'utf8')).name === 'builder') return join(root, 'bench', 'results')
  } catch {}
  return join(root, '.builder', 'bench')
}

export const OWNER_PROMPT = [
  'You are being benchmarked. The owner is not here. Whenever a step would ask the human a question,',
  'answer it yourself: take the option marked recommended, or the simplest one when none is. Never',
  'stop to wait for input and never ask the owner anything. The feature is done only when it is',
  'merged into `main` and the tests pass. Do not explain the benchmark in commits or files.',
].join(' ')

/** The fixture, copied and made a repo on `main`; the fleet's claude_args filled in. */
export function prepareCopy({ fixture, dest, claudeArgs }) {
  if (/\s/.test(dest)) throw new Error(`the copy's path must contain no spaces (the fleet splits claude_args on whitespace): ${dest} — set BENCH_TMP`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(fixture, dest, { recursive: true })
  const cfg = join(dest, '.claude', 'builder.md')
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('{claude_args}', claudeArgs))
  writeFileSync(join(dest, '.claude', 'bench-settings.json'), JSON.stringify({ enabledPlugins: { 'builder@claude-builder': false, 'superpowers@claude-plugins-official': false } }, null, 2) + '\n')
  git(dest, 'init', '-q', '-b', 'main')
  mkdirSync(join(dest, '.git', 'info'), { recursive: true })
  writeFileSync(join(dest, '.git', 'info', 'exclude'), 'REQUEST.md\n.claude/bench-settings.json\n')
  git(dest, 'add', '-A')
  git(dest, 'commit', '-qm', 'fixture')
  return { copy: dest }
}

/**
 * One headless session. Its stream goes to outFile as it arrives. Killed (exit null) after
 * idleTimeoutMs with no output, or runTimeoutMs in all — the whole process group, as the fleet does.
 */
export function runSession({ copy, name, prompt, outFile, claudeArgs, systemPrompt, model, runTimeoutMs = RUN_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, claude = CLAUDE, env = {} }) {
  return new Promise((done) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...claudeArgs]
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    if (model) args.push('--model', model)
    const out = createWriteStream(outFile)
    const child = spawn(claude, args, { cwd: copy, env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: copy }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let timedOut = false
    let settled = false
    const kill = () => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    let idle = setTimeout(kill, idleTimeoutMs)
    const hard = setTimeout(kill, runTimeoutMs)
    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(kill, idleTimeoutMs)
    }
    child.stdout.on('data', (c) => {
      touch()
      out.write(c)
    })
    child.stderr.on('data', (c) => {
      touch()
      out.write(c)
    })
    const finish = (exit) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(hard)
      out.end(() => done({ exit, file: outFile }))
    }
    child.on('error', (e) => {
      out.write(`\n[bench] could not start ${claude}: ${e.message}\n`)
      finish(127)
    })
    child.on('exit', (code) => setTimeout(() => finish(timedOut ? null : (code ?? 1)), 500))
    child.on('close', (code) => finish(timedOut ? null : (code ?? 1)))
  })
}

/** A session file → the Session row of runs.json. */
export function sessionRecord({ name, lane, prompt, file }) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = parseStream(text)
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('{'))
  return { name, file, lane, sessionId: parsed.sessionId, model: parsed.model, prompt, totals: sessionTotals(parsed), steps: deriveSteps(parsed, { prompt }), tail: lines.slice(-10) }
}
```

- [ ] **Step 5: Write `bench.mjs` — the matrix, the drivers and the CLI's `run --dry-run`**

Append to `scripts/bench.mjs`:

```js
// ---- the matrix and the drivers ------------------------------------------------------------------

/** Where the superpowers plugin is on this machine, newest version — or null. */
export function superpowersDir() {
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude'), 'plugins', 'cache', 'claude-plugins-official', 'superpowers')
  const alt = join(process.env.HOME || '', '.claude-home', 'plugins', 'cache', 'claude-plugins-official', 'superpowers')
  for (const d of [base, alt]) {
    if (!existsSync(d)) continue
    const vs = readdirSync(d).filter((n) => /^\d/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (vs.length) return join(d, vs[0])
  }
  return null
}

const GSD_INSTALL = process.env.BENCH_GSD_INSTALL || 'npx -y @opengsd/gsd-core@latest --claude --local'

/**
 * A driver: (ctx) → the sessions to run, in order. ctx = { copy, request, profile, flags }.
 * A session is { name, prompt, system?: extra owner line, lane?: 'brainstorm'|…, fleet?: true }.
 * `fleet: true` is builder's third step: the fleet engine, not a claude -p (see runFleet).
 */
export const DRIVERS = {
  builder: ({ request, profile }) => [
    { name: 'brainstorm', prompt: `/builder:brainstorm --auto ${request}`, system: `When asked for a build profile, choose **${profile}**.` },
    { name: 'spec', prompt: '/builder:spec --auto', system: `When asked for a build profile, choose **${profile}**.` },
    { name: 'fleet', fleet: true, system: `When asked for a build profile, choose **${profile}**.` },
  ],
  superpowers: ({ request }) => [
    { name: 'superpowers', prompt: `/superpowers:brainstorming — Build this feature end to end: ${request}\n\nBrainstorm it, write the plan, execute the plan with subagent-driven development, then finish the branch by merging it into \`main\`.` },
  ],
  gsd: () => [
    { name: 'new-project', prompt: '/gsd-new-project --auto @REQUEST.md', system: 'Plan the whole request as ONE phase.' },
    { name: 'plan-phase', prompt: '/gsd-plan-phase 1' },
    { name: 'execute-phase', prompt: '/gsd-execute-phase 1' },
    { name: 'verify-work', prompt: '/gsd-verify-work 1 — then merge the work into `main` and leave `main` checked out.' },
  ],
}

export const MATRIX = [
  { config: 'builder-rush', pipeline: 'builder', profile: 'rush' },
  { config: 'builder-standard', pipeline: 'builder', profile: 'standard' },
  { config: 'builder-thorough', pipeline: 'builder', profile: 'thorough' },
  { config: 'superpowers', pipeline: 'superpowers', profile: null },
  { config: 'gsd', pipeline: 'gsd', profile: null },
]

/** The claude flags every session of a pipeline gets: permissions, the plugin under test, the settings. */
export function flagsFor(pipeline, copy) {
  const flags = ['--permission-mode', 'bypassPermissions', '--settings', join(copy, '.claude', 'bench-settings.json')]
  if (pipeline === 'builder') flags.push('--plugin-dir', BUILDER)
  if (pipeline === 'superpowers') {
    const sp = superpowersDir()
    if (sp) flags.push('--plugin-dir', sp)
  }
  return flags
}

export const runId = (feature, now = new Date()) => `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}-${feature}`

// ---- CLI -----------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null)
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const RESULTS = resultsDir(ROOT)
const FEATURES = join(BUILDER, 'bench', 'features')
const FIXTURE = join(BUILDER, 'bench', 'fixture')

function planRun() {
  const feature = argv[1]
  if (!feature || feature.startsWith('--')) die('usage: bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach]')
  if (!existsSync(join(FEATURES, feature, 'request.md'))) die(`no feature '${feature}' — bench/features/ has: ${readdirSync(FEATURES).join(', ') || 'nothing'}`)
  const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
  for (const c of only ?? []) if (!MATRIX.some((m) => m.config === c)) die(`unknown config '${c}' — one of ${MATRIX.map((m) => m.config).join(', ')}`)
  const repeat = Math.max(1, Number(opt('--repeat')) || 1)
  const model = opt('--model')
  const request = readFileSync(join(FEATURES, feature, 'request.md'), 'utf8').trim()
  const configs = MATRIX.filter((m) => !only || only.includes(m.config))
  return { feature, request, configs, repeat, model, id: runId(feature) }
}

/** The sessions a config would run in a copy, with the flags and the owner prompt each gets. */
export function sessionsFor(m, copy, request) {
  const flags = flagsFor(m.pipeline, copy)
  return DRIVERS[m.pipeline]({ copy, request, profile: m.profile }).map((s) => ({ ...s, flags, system: s.system ? `${OWNER_PROMPT}\n\n${s.system}` : OWNER_PROMPT }))
}

function dryRun(plan) {
  const dest = join(TMP, plan.id, '_dry')
  const m0 = plan.configs[0]
  prepareCopy({ fixture: FIXTURE, dest, claudeArgs: flagsFor('builder', dest).join(' ') })
  console.log(`benchmark ${plan.id} — feature ${plan.feature}, ${plan.configs.length} config(s) × ${plan.repeat} rep(s)${plan.model ? `, model ${plan.model}` : ''}`)
  console.log(`copies under ${join(TMP, plan.id)}; results in ${join(RESULTS, plan.id)}`)
  console.log('')
  for (const m of plan.configs) {
    const sessions = sessionsFor(m, dest, plan.request)
    console.log(`${m.config}: ${sessions.length} session${sessions.length === 1 ? '' : 's'}  (claude ${sessions[0].flags.join(' ')})`)
    for (const s of sessions) console.log(`  ${s.name}: ${s.fleet ? `node ${process.env.BENCH_FLEET || join(BUILDER, 'scripts', 'fleet.mjs')} <feature> --parallel 1` : s.prompt.split('\n')[0].slice(0, 110)}${s.system.includes('choose **') ? `   [${/choose \*\*\w+\*\*/.exec(s.system)[0]}]` : ''}`)
  }
  console.log('')
  const list = spawnSync(CLAUDE, ['plugin', 'list', ...flagsFor(m0.pipeline, dest)], { cwd: dest, encoding: 'utf8' })
  console.log(list.status === 0 ? `plugins a ${m0.config} session loads:\n${list.stdout.trim()}` : `could not list plugins (${list.stderr?.trim() || `exit ${list.status}`})`)
  console.log(`gsd install: ${GSD_INSTALL}`)
}

const cmd = argv[0]
if (cmd === 'run' && flag('--dry-run')) {
  dryRun(planRun())
  process.exit(0)
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test scripts/test/bench.test.mjs`
Expected: 7 passing. The `--dry-run` test's `r.calls` filter drops the stub's `plugin list` call (its prompt is empty; the stub logs `plugin` only via the early exit, which writes nothing — so `calls` is `[]` either way).

- [ ] **Step 7: Commit**

```bash
git add scripts/bench.mjs scripts/test/bench.test.mjs scripts/test/fixtures/bench/stub-claude.mjs
git commit -m "feat(bench): the runner — copies, the session runner with timeouts, drivers, --dry-run"
```

---

### Task 7: `bench.mjs` — the run loop: sessions, the fleet, GSD, scoring, `runs.json`

**Files:**
- Modify: `scripts/bench.mjs`
- Modify: `scripts/test/bench.test.mjs`
- Create: `scripts/test/fixtures/bench/stub-fleet.mjs`

**Interfaces:**
- Consumes: Task 6's `prepareCopy`, `runSession`, `sessionRecord`, `sessionsFor`, `planRun`; Task 4's `runTotals`, `parseTap`; Task 5's `renderReport`.
- Produces: `runConfig(plan, m, rep) → Run` (one config, one rep: prepare, sessions, score, record); `runAll(plan)` (the loop, saving `runs.json` + `REPORT.md` after every config, writing `progress.json` while a session runs); `runFleet({ copy, feature, outDir, claudeArgs })` → the fleet's sessions as records; `installGsd(copy) → { ok, version|null, reason|null }`; `score(copy, feature) → { accept, fixture }`.
- `runs.json` shape: `{ runId, feature, model, startedAt, endedAt, versions: { builder, superpowers, gsd }, runs: Run[] }`, `Run` as in Task 4.

- [ ] **Step 1: Write the stub fleet**

`scripts/test/fixtures/bench/stub-fleet.mjs` — stands in for `scripts/fleet.mjs`: writes one fleet log with two Skill steps and an archive row, merges nothing (the stub spec session already committed on main), exits 0. With `STUB_FLEET_PARK=1` it writes a `PARKED` archive-less outcome: the manifest stays with `blocked:` set.

```js
#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const feature = process.argv[2]
const root = process.cwd()
const logs = join(root, '.builder', 'fleet', 'logs')
mkdirSync(logs, { recursive: true })
let t = Date.now()
const ts = () => new Date((t += 10)).toISOString()
const L = (o) => JSON.stringify(o) + '\n'
let s = L({ type: 'system', subtype: 'init', session_id: 'fleet-1', model: 'stub-model', timestamp: ts() })
for (const skill of ['builder:audit', 'builder:plan', 'builder:build']) {
  s += L({ type: 'assistant', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_use', id: skill, name: 'Skill', input: { skill, args: `--path docs/features/${feature}` } }] } })
  s += L({ type: 'assistant', parent_tool_use_id: skill, timestamp: ts(), message: { content: [{ type: 'tool_use', id: `${skill}-sub`, name: 'Edit', input: { file_path: 'src/cli.mjs' } }] } })
}
s += L({ type: 'result', subtype: 'success', duration_ms: 70, num_turns: 3, total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0 }, result: 'done', session_id: 'fleet-1', timestamp: ts() })
writeFileSync(join(logs, `${feature}-01.jsonl`), s)
if (process.env.STUB_FLEET_PARK) {
  writeFileSync(join(root, 'docs/features', feature, 'MANIFEST.md'), 'size: md\nstate: building\nblocked: "spec leaves the tag format open — next: decide it"\n')
} else {
  appendFileSync(join(root, '.builder', 'fleet', 'archive.jsonl'), L({ feature, profile: 'rush', merged: 'main', pr: null, landedAt: Date.now(), timing: [{ n: 1, lane: 'build', ms: 70 }] }))
}
```

- [ ] **Step 2: Write the failing tests**

Append to `scripts/test/bench.test.mjs`:

```js
const SP = { skills: ['superpowers:brainstorming', 'superpowers:writing-plans', 'superpowers:subagent-driven-development'], files: { 'src/tags.mjs': 'export const x = 1\n' }, commit: 'feat: tags' }

test('run: superpowers only — one session, scored, runs.json and REPORT.md written under .builder/bench', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.equal(data.feature, 'tags')
  assert.equal(data.runs.length, 1)
  const run = data.runs[0]
  assert.equal(run.config, 'superpowers')
  assert.equal(run.status, 'done')
  assert.deepEqual(run.sessions.map((s) => s.name), ['superpowers'])
  assert.deepEqual(run.sessions[0].steps.map((s) => s.name), SP.skills)
  assert.equal(run.score.fixture.total, 4)
  assert.equal(run.score.fixture.passed, 4)
  assert.ok(run.score.accept.total >= 7)
  assert.ok(run.score.accept.failed >= 5)
  assert.ok(run.gitLog.some((l) => /feat: tags/.test(l)))
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /\| superpowers \| done \|/)
  assert.match(r.calls[0], /--append-system-prompt/)
  assert.ok(existsSync(join(root, 'tmp', id, 'superpowers', 'REQUEST.md')))
})

test('run: builder — brainstorm, spec, then the fleet; its logs become sessions; the profile is in the owner prompt', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.status, 'done')
  assert.equal(run.path, 'pipeline')
  assert.deepEqual(run.sessions.map((s) => s.name), ['brainstorm', 'spec', 'fleet 01'])
  assert.equal(run.sessions[2].lane, 'build')
  assert.deepEqual(run.sessions[2].steps.map((s) => s.name), ['builder:audit', 'builder:plan', 'builder:build'])
  assert.deepEqual(run.sessions[2].steps[0].toolCalls, { Skill: 1, Edit: 1 })
  assert.equal(run.totals.turns, 1 + 1 + 3)
  assert.match(r.calls[0], /\/builder:brainstorm --auto/)
  assert.ok(r.calls.length === 2, `expected 2 claude calls, got ${r.calls.length}`)
})

test('run: builder config with no manifest after spec is in-chat — the fleet is not run', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'], files: { 'src/tags.mjs': 'x' }, commit: 'feat: tags in chat' }, '/builder:spec': { skills: [] } })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.path, 'in-chat')
  assert.equal(run.status, 'done')
  assert.deepEqual(run.sessions.map((s) => s.name), ['brainstorm'])
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /built in chat/)
})

test('run: a parked fleet feature ends the config as parked with the reason', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'builder-rush'], { '/builder:brainstorm': { skills: ['builder:brainstorm'] }, '/builder:spec': { skills: ['builder:spec'], manifest: 'tags', commit: 'spec(tags)' } }, { STUB_FLEET_PARK: '1' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.match(run.status, /^parked: spec leaves the tag format open/)
})

test('run: a failing gsd install marks the row not run and the other configs still run', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'gsd,superpowers'], { '/superpowers:brainstorming': SP }, { BENCH_GSD_INSTALL: 'sh -c "echo no network >&2; exit 1"' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.deepEqual(data.runs.map((x) => x.config), ['superpowers', 'gsd']) // the matrix's order, whatever --only says
  assert.equal(data.runs[0].status, 'done')
  assert.match(data.runs[1].status, /^not run: gsd install failed: no network/)
})

test('run: gsd — four sessions in order, REQUEST.md in the copy, the version recorded', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'gsd'], { '/gsd-new-project': { skills: [] }, '/gsd-plan-phase': { skills: [] }, '/gsd-execute-phase': { files: { 'src/tags.mjs': 'x' }, commit: 'tags' }, '/gsd-verify-work': { skills: [] } }, { BENCH_GSD_INSTALL: 'echo "gsd-core 1.7.0 installed"' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['/gsd-new-project', '/gsd-plan-phase', '/gsd-execute-phase', '/gsd-verify-work'])
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.equal(data.versions.gsd, '1.7.0')
  assert.equal(data.runs[0].sessions[1].steps[0].name, '/gsd-plan-phase 1')
})

test('run: a timed-out session ends the config as timed out; runs.json is still written', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': { skills: ['a'], hang: true } }, { BENCH_IDLE_TIMEOUT_MS: '500' })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const run = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0]
  assert.equal(run.status, 'timed out')
  assert.equal(run.sessions[0].totals.ended, 'cut')
})

test('run: --repeat 2 gives two reps and the report says median of 2', () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers', '--repeat', '2'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  const data = JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8'))
  assert.deepEqual(data.runs.map((x) => x.rep), [1, 2])
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /median of 2 reps/)
})
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test scripts/test/bench.test.mjs`
Expected: the 8 new tests fail (`run` without `--dry-run` does nothing yet and exits 0 with no files, so the `readdirSync` calls throw).

- [ ] **Step 4: Implement the run loop**

Insert into `scripts/bench.mjs` before the `// ---- CLI` section:

```js
// ---- running one config ----------------------------------------------------------------------------

const FLEET = process.env.BENCH_FLEET || join(BUILDER, 'scripts', 'fleet.mjs')

/** The feature folder builder's spec session left, or null (xs/sm: built in chat; or nothing). */
export function featureOf(copy) {
  const reg = join(copy, 'docs', 'features')
  if (!existsSync(reg)) return null
  return readdirSync(reg).find((n) => !n.startsWith('_') && existsSync(join(reg, n, 'MANIFEST.md'))) ?? null
}

/** The fleet engine on one feature; its stream logs become this config's sessions. */
export function runFleet({ copy, feature, outDir, env }) {
  const log = join(outDir, 'fleet.out')
  const r = spawnSync(process.execPath, [FLEET, feature, '--parallel', '1'], { cwd: copy, encoding: 'utf8', env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: copy }, timeout: RUN_TIMEOUT_MS * 3 })
  writeFileSync(log, `${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  const logs = join(copy, '.builder', 'fleet', 'logs')
  const files = existsSync(logs) ? readdirSync(logs).filter((n) => n.startsWith(`${feature}-`) && n.endsWith('.jsonl')).sort() : []
  const sessions = files.map((n) => {
    const file = join(outDir, `session-fleet-${n}`)
    cpSync(join(logs, n), file)
    const text = readFileSync(file, 'utf8')
    const prompt = /"-p","([^"]*)"/.exec(text)?.[1] ?? `/builder:resume --path docs/features/${feature} --agent-walk`
    const rec = sessionRecord({ name: `fleet ${n.slice(feature.length + 1, -6)}`, lane: null, prompt, file })
    rec.lane = rec.steps.some((s) => /walk|signoff/.test(s.name)) ? 'walk' : rec.steps.some((s) => /verify|ship/.test(s.name)) ? 'ship' : 'build'
    return rec
  })
  const mfPath = join(copy, 'docs', 'features', feature, 'MANIFEST.md')
  const mf = existsSync(mfPath) ? readFileSync(mfPath, 'utf8') : null
  const blocked = mf && /^blocked:\s*(?!none\b)(.+)$/m.exec(mf)?.[1]?.replace(/^"(.*)"$/, '$1')
  const status = r.status === null ? 'timed out' : blocked ? `parked: ${blocked}` : r.status !== 0 && !existsSync(join(copy, '.builder', 'fleet', 'archive.jsonl')) ? `failed: fleet exit ${r.status}` : 'done'
  return { sessions, status }
}

export function installGsd(copy) {
  const r = spawnSync('sh', ['-c', GSD_INSTALL], { cwd: copy, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  if (r.status !== 0) return { ok: false, version: null, reason: `gsd install failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop()}` }
  return { ok: true, version: /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null, reason: null }
}

/** After the run: main checked out, the fixture's tests and the hidden acceptance tests, both TAP. */
export function score(copy, feature) {
  try {
    git(copy, 'checkout', '-q', 'main')
  } catch {}
  const tap = (file) => {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: copy, encoding: 'utf8', timeout: 5 * 60 * 1000 })
    return parseTap(`${r.stdout}\n${r.stderr}`)
  }
  const fixture = tap(join('test', 'cli.test.mjs'))
  cpSync(join(FEATURES, feature, 'accept.test.mjs'), join(copy, 'test', 'accept.test.mjs'))
  const accept = tap(join('test', 'accept.test.mjs'))
  rmSync(join(copy, 'test', 'accept.test.mjs'), { force: true })
  return { accept, fixture }
}

const writeJson = (p, o) => {
  writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 2) + '\n')
  renameSync(`${p}.tmp`, p)
}

export async function runConfig(plan, m, rep, data, outRoot) {
  const label = plan.repeat > 1 ? `${m.config}-${rep}` : m.config
  const copy = join(TMP, plan.id, label)
  const outDir = join(outRoot, label)
  mkdirSync(outDir, { recursive: true })
  const flags = flagsFor(m.pipeline, copy)
  prepareCopy({ fixture: FIXTURE, dest: copy, claudeArgs: flags.join(' ') })
  writeFileSync(join(copy, 'REQUEST.md'), plan.request + '\n')
  const run = { config: m.config, pipeline: m.pipeline, profile: m.profile, rep, status: 'done', path: 'pipeline', startedAt: Date.now(), endedAt: null, ms: 0, sessions: [], totals: null, score: null, copy, gitLog: [] }
  const progress = (session) => writeJson(join(outRoot, 'progress.json'), { config: m.config, rep, session, startedAt: Date.now() })
  if (m.pipeline === 'gsd') {
    progress('install gsd')
    const g = installGsd(copy)
    data.versions.gsd ??= g.version
    if (!g.ok) run.status = `not run: ${g.reason}`
  }
  const sessions = sessionsFor(m, copy, plan.request)
  let n = 0
  for (const s of sessions) {
    if (run.status !== 'done') break
    n++
    progress(s.name)
    if (s.fleet) {
      const feature = featureOf(copy)
      if (!feature) {
        run.path = 'in-chat'
        break
      }
      const f = runFleet({ copy, feature, outDir, env: {} })
      run.sessions.push(...f.sessions)
      run.status = f.status
      continue
    }
    const file = join(outDir, `session-${String(n).padStart(2, '0')}-${s.name}.jsonl`)
    const r = await runSession({ copy, name: s.name, prompt: s.prompt, outFile: file, claudeArgs: s.flags, systemPrompt: s.system, model: plan.model })
    run.sessions.push(sessionRecord({ name: s.name, lane: null, prompt: s.prompt, file }))
    if (r.exit === null) run.status = 'timed out'
    else if (r.exit !== 0) run.status = `failed: session ${s.name} exit ${r.exit}`
    else if (m.pipeline === 'builder' && s.name === 'spec' && !featureOf(copy)) {
      run.path = 'in-chat'
      run.sessions.pop()
      break
    }
  }
  if (!run.status.startsWith('not run')) {
    run.score = score(copy, plan.feature)
    try {
      run.gitLog = git(copy, 'log', '--oneline', 'main').split('\n')
    } catch {}
  }
  run.endedAt = Date.now()
  run.ms = run.endedAt - run.startedAt
  run.totals = runTotals(run.sessions)
  return run
}

function versions() {
  const builder = JSON.parse(readFileSync(join(BUILDER, '.claude-plugin', 'plugin.json'), 'utf8')).version
  const sp = superpowersDir()
  return { builder, superpowers: sp ? basename(sp) : null, gsd: null }
}

export async function runAll(plan) {
  const outRoot = join(RESULTS, plan.id)
  mkdirSync(outRoot, { recursive: true })
  const data = { runId: plan.id, feature: plan.feature, model: plan.model, startedAt: Date.now(), endedAt: null, versions: versions(), runs: [] }
  const save = () => {
    writeJson(join(outRoot, 'runs.json'), data)
    writeFileSync(join(outRoot, 'REPORT.md'), renderReport(data))
  }
  save()
  for (let rep = 1; rep <= plan.repeat; rep++) {
    for (const m of plan.configs) {
      console.log(`▶ ${m.config}${plan.repeat > 1 ? ` rep ${rep}` : ''}`)
      data.runs.push(await runConfig(plan, m, rep, data, outRoot))
      data.endedAt = Date.now()
      save()
      console.log(`  ${data.runs.at(-1).status} in ${Math.round(data.runs.at(-1).ms / 1000)}s`)
    }
  }
  rmSync(join(outRoot, 'progress.json'), { force: true })
  console.log(`\n${renderStatusTable(data, null)}\nreport: ${join(outRoot, 'REPORT.md')}`)
}
```

And replace the CLI tail with:

```js
const cmd = argv[0]
if (cmd === 'run') {
  const plan = planRun()
  if (flag('--dry-run')) {
    dryRun(plan)
    process.exit(0)
  }
  await runAll(plan)
  process.exit(0)
}
```

The gitignore for raw result directories (Task 9) is needed before a real run in this repo, but the tests run from a temp root, so the order of tasks holds.

- [ ] **Step 5: Run the tests**

Run: `node --test scripts/test/bench.test.mjs`
Expected: 15 passing. Things that bite here: (a) the stub's `commit` runs in the copy — the copy's `.git` must exist (prepareCopy made it); (b) the `in-chat` test: the brainstorm stub commits code, the spec stub writes no manifest, so after `spec` the run pops the spec session and marks in-chat — the test expects only `['brainstorm']`; (c) `score` runs `test/cli.test.mjs` from the copy, which spawns `node src/cli.mjs` — it must still pass after the stub's extra file.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench.mjs scripts/test/bench.test.mjs scripts/test/fixtures/bench/stub-fleet.mjs
git commit -m "feat(bench): the run loop — sessions, the fleet, gsd install, scoring, runs.json after every config"
```

---

### Task 8: `bench.mjs` — `status`, `report`, `clean`, the lock and `--detach`

**Files:**
- Modify: `scripts/bench.mjs`
- Modify: `scripts/test/bench.test.mjs`

**Interfaces:**
- Produces: `node scripts/bench.mjs status` (the latest run's summary and whether it is running), `report <run-id>` (rebuilds `REPORT.md` from `runs.json`), `clean` (removes `$BENCH_TMP`), the lock at `<results>/lock` (pid), `--detach`.

- [ ] **Step 1: Add the failing tests**

Append to `scripts/test/bench.test.mjs`:

```js
test('status: nothing has run', () => {
  const root = makeRoot()
  const r = runBench(root, ['status'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /no benchmark has run/)
})

test('status after a run shows the table and not running; report rebuilds REPORT.md', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  const s = runBench(root, ['status'])
  assert.match(s.stdout, /\| superpowers \| done \|/)
  assert.match(s.stdout, /not running/)
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  writeFileSync(join(dir, id, 'REPORT.md'), 'stale')
  const rp = runBench(root, ['report', id])
  assert.equal(rp.status, 0, rp.stderr)
  assert.match(readFileSync(join(dir, id, 'REPORT.md'), 'utf8'), /^# benchmark/)
  assert.match(rp.stdout, /\| superpowers \| done \|/)
})

test('status with a dead lock says the run stopped; a second run refuses while a live lock is held', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  const dir = join(root, '.builder', 'bench')
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 999999, runId: id }))
  writeFileSync(join(dir, id, 'progress.json'), JSON.stringify({ config: 'gsd', rep: 1, session: 'plan-phase', startedAt: Date.now() }))
  assert.match(runBench(root, ['status']).stdout, /⚠ benchmark stopped mid-run \(config gsd\)/)
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: process.pid, runId: id }))
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /a benchmark is running \(pid/)
  assert.match(runBench(root, ['status']).stdout, /running: gsd \(session plan-phase/)
})

test('--detach starts the run in its own process and returns at once', async () => {
  const root = makeRoot()
  const r = runBench(root, ['run', 'tags', '--only', 'superpowers', '--detach'], { '/superpowers:brainstorming': SP })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /bench started detached \(pid \d+\)/)
  const dir = join(root, '.builder', 'bench')
  for (let i = 0; i < 100 && !readdirSync(dir).some((n) => n.endsWith('-tags') && existsSync(join(dir, n, 'runs.json')) && JSON.parse(readFileSync(join(dir, n, 'runs.json'), 'utf8')).runs.length); i++) await new Promise((res) => setTimeout(res, 200))
  const id = readdirSync(dir).find((n) => n.endsWith('-tags'))
  assert.equal(JSON.parse(readFileSync(join(dir, id, 'runs.json'), 'utf8')).runs[0].status, 'done')
  assert.ok(existsSync(join(dir, 'bench.out')))
})

test('clean removes the copies', () => {
  const root = makeRoot()
  runBench(root, ['run', 'tags', '--only', 'superpowers'], { '/superpowers:brainstorming': SP })
  assert.ok(existsSync(join(root, 'tmp')))
  const r = runBench(root, ['clean'])
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(root, 'tmp')))
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test scripts/test/bench.test.mjs`
Expected: 5 new failures.

- [ ] **Step 3: Implement**

Replace the CLI tail of `scripts/bench.mjs` with:

```js
// ---- the lock, status, report, clean, detach ------------------------------------------------------

const LOCK = join(RESULTS, 'lock')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** { pid, runId } of a live benchmark, 'dead' with the stale lock's runId, or null. */
function lockState() {
  let l
  try {
    l = JSON.parse(readFileSync(LOCK, 'utf8'))
  } catch {
    return null
  }
  return Number.isInteger(l.pid) && alive(l.pid) ? { live: true, ...l } : { live: false, ...l }
}
const latestRun = () => (existsSync(RESULTS) ? readdirSync(RESULTS).filter((n) => existsSync(join(RESULTS, n, 'runs.json'))).sort().at(-1) ?? null : null)
const readRun = (id) => JSON.parse(readFileSync(join(RESULTS, id, 'runs.json'), 'utf8'))

function status() {
  const lock = lockState()
  const id = lock?.runId && existsSync(join(RESULTS, lock.runId, 'runs.json')) ? lock.runId : latestRun()
  if (!id) return console.log('no benchmark has run here yet — /builder:benchmark starts one')
  const data = readRun(id)
  const pf = join(RESULTS, id, 'progress.json')
  const progress = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : null
  console.log(`# benchmark ${id} — ${data.feature}\n`)
  if (lock?.live) console.log(renderStatusTable(data, progress))
  else {
    console.log(renderStatusTable(data, null))
    if (lock && !lock.live && progress) console.log(`⚠ benchmark stopped mid-run (config ${progress.config}) — its process is gone; the finished configs are in the table. Re-run with --only for the rest.`)
  }
  console.log(`report: ${join(RESULTS, id, 'REPORT.md')}`)
}

const cmd = argv[0]
if (cmd === 'status') {
  status()
  process.exit(0)
}
if (cmd === 'report') {
  const id = argv[1]
  if (!id || !existsSync(join(RESULTS, id, 'runs.json'))) die(`no run '${id ?? ''}' under ${RESULTS}`)
  const data = readRun(id)
  writeFileSync(join(RESULTS, id, 'REPORT.md'), renderReport(data))
  console.log(renderStatusTable(data, null))
  console.log(`report: ${join(RESULTS, id, 'REPORT.md')}`)
  process.exit(0)
}
if (cmd === 'clean') {
  rmSync(TMP, { recursive: true, force: true })
  console.log(`removed ${TMP}`)
  process.exit(0)
}
if (cmd === 'run') {
  const plan = planRun()
  if (flag('--dry-run')) {
    dryRun(plan)
    process.exit(0)
  }
  const lock = lockState()
  if (lock?.live) die(`a benchmark is running (pid ${lock.pid}, ${lock.runId}) — /builder:benchmark --status`)
  mkdirSync(RESULTS, { recursive: true })
  if (!resultsDir(ROOT).endsWith(join('bench', 'results'))) {
    const ignore = join(ROOT, '.builder', '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  }
  if (flag('--detach')) {
    const outFd = openSync(join(RESULTS, 'bench.out'), 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', outFd, outFd] })
    child.unref()
    console.log(`bench started detached (pid ${child.pid}) — output in ${join(RESULTS, 'bench.out')} · /builder:benchmark --status`)
    process.exit(0)
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, runId: plan.id }))
  try {
    await runAll(plan)
  } finally {
    rmSync(LOCK, { force: true })
  }
  process.exit(0)
}
die('usage: bench.mjs run <feature> [--only a,b] [--repeat N] [--model m] [--dry-run] [--detach] | report <run-id> | status | clean')
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test 'scripts/test/*.test.mjs'`
Expected: all green, including the 20 bench tests and the existing ones. The detach test waits up to 20 s for the child; if it is flaky on a slow machine, raise the loop to 150 iterations.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench.mjs scripts/test/bench.test.mjs
git commit -m "feat(bench): status, report, clean, the lock and --detach"
```

---

### Task 9: The skill, the listings, the ignore rules, the release

**Files:**
- Create: `skills/benchmark/SKILL.md`
- Modify: `.gitignore`
- Modify: `scripts/vendor.mjs:108` (the `SKIP` set)
- Modify: `skills/help/SKILL.md` (the "what do you want" table, after the `/builder:fleet` row)
- Modify: `README.md` (the "Unattended runs" section, after the profiles table at lines 196–199)
- Modify: `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json` (`version`)
- Test: `scripts/test/skills-consistency.test.mjs` (existing; it checks every skill's frontmatter and listing — run it)

- [ ] **Step 1: Write the skill**

`skills/benchmark/SKILL.md`:

```markdown
---
name: benchmark
description: Run one small feature through builder at rush, standard and thorough and through superpowers and GSD, unattended, and report time per step, what happened in each step, turns, tokens, cost and whether the feature works (acceptance tests the agent never sees). Launches scripts/bench.mjs detached and reports its table; --status shows the run in progress or the last report; --report <run-id> rebuilds one. Use when the user asks to benchmark builder, compare it with superpowers or GSD, measure a pipeline, or find where agent builds spend their time.
---

# `/builder:benchmark` — where the time goes

Invocation: **`/builder:benchmark [<feature>] [--only <config,…>] [--repeat N] [--model <m>] [--dry-run] [--status] [--report <run-id>]`**.

The work is `scripts/bench.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts. Design and the report's meaning:
`bench/README.md` in the plugin.

**What it does:** for each configuration — `builder-rush`, `builder-standard`, `builder-thorough`,
`superpowers`, `gsd` — it copies the fixture project (`bench/fixture/`, a notes CLI), makes it a
repo on `main`, and drives the pipeline unattended through `claude -p` sessions: builder as
brainstorm → spec → the fleet engine (audit, plan, build, agent walk, verify, ship, merge);
superpowers as one session from brainstorming to a merged branch; GSD as its four commands. Every
session gets an owner prompt that answers every question with the recommendation and never waits;
builder sessions are told which profile to pick. Afterwards the fixture's tests and the feature's
hidden acceptance tests score what landed. Configs run one at a time — never in parallel — so one
never skews another. Nothing in the user's Claude home changes: plugins load with `--plugin-dir`
for the session only, and GSD installs into the copy.

## 1. `--status` and `--report`

`node <builder>/scripts/bench.mjs status` — reply with its contents as markdown. Running: the
summary so far and the config and session it is on. Finished: the summary table and the report's
path. `⚠ benchmark stopped mid-run` means its process is gone; the finished configs are kept, and
`--only` runs the rest. **`--report <run-id>`**: `node <builder>/scripts/bench.mjs report <run-id>`,
then its table and the path.

## 2. Pre-flight

- `claude` on the PATH (`which claude`); if not, stop and say so.
- The feature: `<feature>` if given, else `tags` — the only one today, so no question. An unknown
  one is refused by the script with the list.
- Superpowers in the plugin cache: the script's dry run names the `--plugin-dir` it found; if the
  `superpowers` line has none, say that row will run without the plugin and offer `--only` without it.
- No run in progress: `status` says `running:` → offer `--status` and stop.

Then the dry run, in the foreground:

```bash
node <builder>/scripts/bench.mjs run <feature> <the same flags> --dry-run
```

Show it as a short table — one row per config: the sessions it will make, their first prompts,
the profile a builder row is told to pick — plus the plugins a session loads (so a second builder
sneaking in is caught here), the model, and the estimate: the sum of the last report's walls for
these configs when `status` has one, else "no estimate yet".

## 3. One confirmation, then launch

One AskUserQuestion — **Run it** / **Not now** — saying it runs on its own, how many sessions,
and that nothing in this repo changes but `bench/results/` (or `.builder/bench/` outside the
builder repo). On yes, **in the foreground, with `--detach`**:

```bash
node <builder>/scripts/bench.mjs run <feature> <the same flags> --detach
```

It prints `bench started detached (pid N)` and returns. 🔴 **Never** launch it as a background task
of this session: the session ending would kill it mid-run. Detached, it outlives the session.

Then say, in two lines: it is running on its own and outlives this session; `/builder:benchmark
--status` shows where it is, and shows the report once every config has landed — nothing here is
notified when it ends. Footer:

~~~
▶ benchmark: <n> config(s) running — next: /builder:benchmark --status
~~~

## Never

- Run a config in the foreground of this session, or run two benchmarks at once.
- Edit `runs.json` or a report by hand; `--report` rebuilds one from `runs.json`.
- Change how builder, superpowers or GSD behave to make a number better.
```

- [ ] **Step 2: Ignore raw results, skip them in vendor, list the skill**

`.gitignore` — append:

```
# benchmark: the raw streams beside each committed REPORT.md + runs.json
/bench/results/*/*/
/bench/results/lock
/bench/results/bench.out
```

`scripts/vendor.mjs:108`:

```js
  const SKIP = new Set([join('scripts', 'test'), join('skills', 'update'), join('bench', 'results')])
```

`skills/help/SKILL.md` — after the `**Several specs, built while you're away**` row, add:

```markdown
| **Is builder fast enough, and where does its time go?** | `/builder:benchmark` — one small feature through builder at rush, standard and thorough and through superpowers and GSD, unattended; a report of time per step, what each step did, tokens, cost and whether the feature works. `--status` while it runs |
```

`README.md` — after the profiles table in "Unattended runs" (after the `Thorough + you` row), add a paragraph:

```markdown
**Measuring it.** `/builder:benchmark` runs one small feature (a notes CLI gaining tags) through
builder at each profile and through superpowers and GSD, unattended, and writes
`bench/results/<run>/REPORT.md`: wall time, time per step, what each step did, turns, tokens, cost,
and whether the feature passes acceptance tests the agent never saw. Configs run one at a time;
nothing in your Claude home changes. `/builder:benchmark --status` while it runs.
```

- [ ] **Step 3: Changelog and version**

`CHANGELOG.md` — insert after the intro, before `## 4.10.2` (or after `## 4.10.3` if it has landed by then):

```markdown
## 4.11.0

**New:**
- **`/builder:benchmark`** — runs one small feature through builder at rush, standard and thorough and
  through superpowers and GSD, unattended, and reports time per step, what happened in each step,
  turns, tokens, cost, and whether the feature works (acceptance tests the agent never sees). Steps
  come from each session's `stream-json` — the Skill calls that open them, with subagent work inside
  them. Results land in `bench/results/<run>/` (`REPORT.md` + `runs.json` committed, raw streams
  not). `--status` while it runs; `--report <run-id>` rebuilds one. Design:
  `docs/specs/2026-10-13-benchmark-design.md`.
```

`.claude-plugin/plugin.json`: `"version": "4.11.0"`.

- [ ] **Step 4: Validate and run everything**

Run: `claude plugin validate . && node --test 'scripts/test/*.test.mjs'`
Expected: validation passes; every test green, `skills-consistency.test.mjs` included (if it requires each skill to be listed somewhere specific — the help table, the README — follow what it asserts).

- [ ] **Step 5: A real dry run from this repo**

Run: `node scripts/bench.mjs run tags --dry-run`
Expected: five configs listed with their sessions; the plugin list shows exactly one `builder` (from `--plugin-dir`) and, for a superpowers session, one `superpowers`; the copy under `$TMPDIR/bench/<id>/_dry`. If the user-scope builder still shows, the `enabledPlugins` key in `bench-settings.json` is not the one this CLI version honours — check `claude plugin list --help` / the settings reference and adjust the key in `prepareCopy` (and its test).

- [ ] **Step 6: Commit**

```bash
git add skills/benchmark/SKILL.md .gitignore scripts/vendor.mjs skills/help/SKILL.md README.md CHANGELOG.md .claude-plugin/plugin.json
git commit -m "feat(benchmark): /builder:benchmark — builder profiles vs superpowers vs GSD, per step (4.11.0)"
```

---

### Task 10: The first real run

**Files:** none new; `bench/results/<run-id>/REPORT.md` + `runs.json` get committed.

- [ ] **Step 1: Run one cheap config end to end first**

Run: `node scripts/bench.mjs run tags --only superpowers`
Expected: one session, minutes; a `done` row with an acceptance score. Read `bench/results/<id>/REPORT.md` and the session's `.jsonl`. Check: the steps are the superpowers skills in order; the subagents list is populated; the merge to `main` happened (`gitLog`). If the session ended waiting for input (the owner prompt was not enough), the result event's text says so — tighten the prompt in `DRIVERS.superpowers` and rerun.

- [ ] **Step 2: Builder at rush**

Run: `node scripts/bench.mjs run tags --only builder-rush`
Expected: brainstorm, spec, then the fleet's sessions. Check `path` is `pipeline` (if `in-chat`, the feature was sized sm: add a behaviour to `request.md`, e.g. `notes untag <id> <t>`, and rerun). Check `fleet.out` in the results dir if the fleet parked.

- [ ] **Step 3: GSD alone**

Run: `node scripts/bench.mjs run tags --only gsd`
Expected: the install succeeds and `versions.gsd` is set; four sessions. If a command name is wrong, the first session's result text says "unknown command" — fix the name in `DRIVERS.gsd` from the installed `.claude/commands/` listing in the copy, and rerun.

- [ ] **Step 4: The full matrix, detached**

Run: `node scripts/bench.mjs run tags --detach`, then `node scripts/bench.mjs status` until it finishes.
Expected: five rows. Commit the results:

```bash
git add bench/results/
git commit -m "bench: first full run of tags — builder rush/standard/thorough vs superpowers vs gsd"
```

- [ ] **Step 5: Release**

Follow `RELEASING.md`: `claude plugin validate .`, then `claude plugin tag --push -m "builder %s"` after merging `feat/bench` into `main`.
