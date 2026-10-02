# Brainstorm, Intake and Spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/builder:brainstorm` into an exploration conversation, add `/builder:intake` (verify a worked-out doc against the code) and `/builder:spec` (write the spec from the conversation's record), and give every new SPEC a prose §Idea section.

**Architecture:** Two conversation skills (brainstorm, intake) share one small mechanics file, `skills/brainstorm/CONVERSATION.md`, and write one workspace record, `.builder/<feature>/brainstorm.md`. A third skill, spec, reads that record and writes `SPEC.md` + `MANIFEST.md` exactly as today's brainstorm Phase 4 does, plus §Idea. Scripts learn to list in-progress conversations (`scripts/brainstorm-file.mjs` → `list-features.mjs`) and `check-obligations.mjs` warns on a rejected option with no reason. Nothing downstream of `SPEC.md` changes.

**Tech Stack:** Markdown skills (Claude Code plugin); Node ≥ 20 ESM scripts, standard library only; `node --test`.

**Spec:** `docs/specs/2026-09-29-brainstorm-intake-spec-design.md`

## Global Constraints

- Release **4.0.0** in `.claude-plugin/plugin.json` and `CHANGELOG.md` (breaking changes listed first).
- Dependency-free: Node standard library + `git` only.
- The workspace record is exactly `.builder/<feature>/brainstorm.md`; its header is the lines up to the first blank line, and scripts read only the header.
- Status values, verbatim: `exploring` · `confirmed` · `sized <xs|sm|md|lg|xl>` · `parked` · `handed-off`. Source values: `brainstorm` · `intake`.
- Tree statuses, verbatim: `open` · `settled` · `assumed` · `stated` · `confirmed` · `contradicted` · `unverifiable`.
- `/builder:brainstorm` never loads `skills/resume/REFERENCE.md`; `/builder:spec` does.
- SPEC line target ~350 (was ~300). Pre-4.0 specs without §Idea stay valid; nothing requires §Idea of them.
- A new check in `check-obligations.mjs` is a **WARN**, never a FAIL.
- Nothing downstream of `SPEC.md` (align, audit, plan, build, walk, signoff, verify, ship, fleet, agent) changes behaviour.
- Skill prose style: second person imperative, bold for rules, 🔴 for hard rules, lines wrapped at ~100 chars, cite REFERENCE sections as `REFERENCE §Name`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command: `node --test 'scripts/test/*.test.mjs'`. Two timing tests may flake under the parallel suite (job.test.mjs "wait gives up after --max…", fleet.test.mjs "keeps talking…"); re-run them alone if only they fail.

## Review Focus

1. **A `brainstorm.md` whose Tree body contains a `status:` line** — the header parser must stop at the header's end and report the header's status. Pinned in Task 1.
2. **A feature with both a live registry folder and a `brainstorm.md`** (a revision of an existing spec) — listed once, as the registry row. Pinned in Task 1.
3. **A truncated or empty `brainstorm.md`** (a session killed mid-write) — listing must not crash; the row shows `unreadable brainstorm.md`. Pinned in Task 1.
4. **`.builder/fleet/`, `.builder/gates/` and other non-feature workspace dirs** — never listed as features. Pinned in Task 1.
5. **Existing specs** — with no §Idea and terse `Rejected:` clauses they still exit 0 from `check-obligations` (the new rule warns, never fails). Pinned in Task 2.

---

### Task 1: `brainstorm-file.mjs` and in-progress conversations in `list-features`

**Files:**
- Create: `scripts/brainstorm-file.mjs`
- Modify: `scripts/list-features.mjs`
- Test: `scripts/test/brainstorm-file.test.mjs` (create), `scripts/test/list-features.test.mjs`

**Interfaces:**
- Produces:
  - `BRAINSTORM_FILE = 'brainstorm.md'`
  - `readBrainstormHeader(path: string): { status, size, source, input, updated, settled: {n, m} | null, contradicted: number | null } | null` — reads at most 4096 bytes; the header is the lines before the first blank line; `null` when the file is missing, empty, or has no `status:` line. `status` is the first word (`sized md` → status `sized`, size `md`).
  - `draftRows(root: string, registry: string): Row[]` — one row per `.builder/<name>/brainstorm.md` whose status is not `handed-off` and whose name has no live `<registry>/<name>` folder. Row fields: `feature, layout: 'brainstorm', path: '<registry>/<name>', done: false, state, lastDone, nextStep, command, next, updatedAt, updated, source, description: null, branch: null, waitsOn: [], warnings: [], problems: []`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/brainstorm-file.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrainstormHeader, draftRows, BRAINSTORM_FILE } from '../brainstorm-file.mjs'

const REG = 'docs/features'
const HEAD = (lines) => `# x — brainstorm\n${lines}\n\n## Intent\nOutcome.\n\n## Tree\n| # | Branch | Depends on | Status |\n| B1 | a | — | settled |\nstatus: handed-off\n`

function ws(files) {
  const root = mkdtempSync(join(tmpdir(), 'bf-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}

test('the header is read up to the first blank line — a status: line in the body is ignored', () => {
  const root = ws({ [`.builder/a/${BRAINSTORM_FILE}`]: HEAD('status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 6 of 11') })
  assert.deepEqual(readBrainstormHeader(join(root, '.builder/a/brainstorm.md')), {
    status: 'exploring', size: null, source: 'brainstorm', input: 'abstract idea', updated: '2026-09-29T10:00:00Z', settled: { n: 6, m: 11 }, contradicted: null,
  })
})

test('sized carries its size; intake carries its contradicted count', () => {
  const root = ws({ '.builder/b/brainstorm.md': HEAD('status: sized md\nsource: intake\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 14 of 19\ncontradicted: 3') })
  const h = readBrainstormHeader(join(root, '.builder/b/brainstorm.md'))
  assert.equal(h.status, 'sized')
  assert.equal(h.size, 'md')
  assert.equal(h.contradicted, 3)
})

test('missing, empty or status-less files read as null', () => {
  const root = ws({ '.builder/e/brainstorm.md': '', '.builder/t/brainstorm.md': '# t — brainstorm\nsour' })
  assert.equal(readBrainstormHeader(join(root, '.builder/e/brainstorm.md')), null)
  assert.equal(readBrainstormHeader(join(root, '.builder/t/brainstorm.md')), null)
  assert.equal(readBrainstormHeader(join(root, '.builder/none/brainstorm.md')), null)
})

test('draftRows: one row per conversation in progress, with its state and command', () => {
  const root = ws({
    '.builder/explore/brainstorm.md': HEAD('status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 6 of 11'),
    '.builder/check/brainstorm.md': HEAD('status: confirmed\nsource: intake\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 14 of 19\ncontradicted: 3'),
    '.builder/ready/brainstorm.md': HEAD('status: sized md\nsource: brainstorm\ninput: brief\nupdated: 2026-09-29T10:00:00Z\nsettled: 9 of 9'),
    '.builder/small/brainstorm.md': HEAD('status: sized sm\nsource: brainstorm\ninput: directed request\nupdated: 2026-09-29T10:00:00Z\nsettled: 3 of 3'),
    '.builder/later/brainstorm.md': HEAD('status: parked\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 2 of 8'),
    '.builder/done/brainstorm.md': HEAD('status: handed-off\nsource: brainstorm\ninput: brief\nupdated: 2026-09-29T10:00:00Z\nsettled: 9 of 9'),
    '.builder/revise/brainstorm.md': HEAD('status: exploring\nsource: brainstorm\ninput: spec\nupdated: 2026-09-29T10:00:00Z\nsettled: 1 of 4'),
    [`${REG}/revise/SPEC.md`]: '# revise — spec\n',
    '.builder/fleet/fleet.json': '{}',
    '.builder/gates/baseline.json': '{}',
    '.builder/broken/brainstorm.md': '',
  })
  const rows = Object.fromEntries(draftRows(root, REG).map((r) => [r.feature, r]))
  assert.deepEqual(Object.keys(rows).sort(), ['broken', 'check', 'explore', 'later', 'ready', 'small'])
  assert.equal(rows.explore.state, 'brainstorming (6/11 settled)')
  assert.equal(rows.explore.command, `/builder:brainstorm --path ${REG}/explore`)
  assert.equal(rows.check.state, 'intake (3 contradicted, 14/19 settled)')
  assert.equal(rows.check.command, `/builder:intake --path ${REG}/check`)
  assert.equal(rows.ready.state, 'sized md — spec not written')
  assert.equal(rows.ready.command, `/builder:spec --path ${REG}/ready`)
  assert.equal(rows.small.command, `/builder:brainstorm --path ${REG}/small`)
  assert.equal(rows.later.state, 'parked idea (2/8 settled)')
  assert.equal(rows.broken.state, 'unreadable brainstorm.md')
  assert.equal(rows.explore.layout, 'brainstorm')
  assert.equal(rows.explore.done, false)
  assert.equal(rows.explore.path, `${REG}/explore`)
  assert.equal(rows.explore.updatedAt, '2026-09-29T10:00:00Z')
})

test('draftRows with no .builder dir is empty', () => {
  assert.deepEqual(draftRows(mkdtempSync(join(tmpdir(), 'bf-')), REG), [])
})
```

Append to `scripts/test/list-features.test.mjs` (it has `setup(manifests, files)` writing under `docs/features`, and `list(root, ...args)`; add `mkdirSync`/`writeFileSync` use via a helper for `.builder`):

```js
const draft = (root, name, header) => {
  mkdirSync(join(root, '.builder', name), { recursive: true })
  writeFileSync(join(root, '.builder', name, 'brainstorm.md'), `# ${name} — brainstorm\n${header}\n\n## Intent\nx\n`)
}

test('a conversation in progress is listed in --json and --status with its command', () => {
  const root = setup({ live: 'state: building' })
  draft(root, 'idea', 'status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 2 of 7')
  const json = JSON.parse(list(root, '--json').stdout).features
  const idea = json.find((f) => f.feature === 'idea')
  assert.equal(idea.layout, 'brainstorm')
  assert.equal(idea.nextStep, 'Continue the brainstorm')
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /\| \*\*idea\*\* \|.*brainstorming \(2\/7 settled\).*`\/builder:brainstorm --path docs\/features\/idea`/)
})

test('a registry with only a conversation in progress is not "nothing"', () => {
  const root = setup({})
  draft(root, 'idea', 'status: exploring\nsource: brainstorm\ninput: abstract idea\nupdated: 2026-09-29T10:00:00Z\nsettled: 0 of 3')
  const st = list(root, '--status')
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /1 in progress/)
})

test('a new SPEC with §Idea instead of §Overview describes itself from its Why', () => {
  const root = setup({ f: 'state: spec' }, { 'f/SPEC.md': '# f — spec\n\n## Idea\n**Why.** Owners need to see which sheets changed since the last issue. More text.\n\n## Apps\n' })
  const f = JSON.parse(list(root, '--json').stdout).features.find((r) => r.feature === 'f')
  assert.equal(f.description, 'Owners need to see which sheets changed since the last issue.')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/test/brainstorm-file.test.mjs scripts/test/list-features.test.mjs`
Expected: FAIL — `Cannot find module '../brainstorm-file.mjs'`; the list-features tests fail (no `idea` row; description is `f` from the title).

- [ ] **Step 3: Write `scripts/brainstorm-file.mjs`**

```js
/**
 * The design conversation's workspace record, `.builder/<feature>/brainstorm.md`, written by
 * /builder:brainstorm and /builder:intake and read by /builder:spec. Scripts read only its HEADER —
 * the lines before the first blank line — so listing a hundred conversations reads a few KB.
 * The format is skills/brainstorm/CONVERSATION.md §The record.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const BRAINSTORM_FILE = 'brainstorm.md'
const HEADER_BYTES = 4096

/** The header's fields, or null when the file is missing, empty, or has no `status:` line. */
export function readBrainstormHeader(path) {
  if (!existsSync(path)) return null
  const buf = Buffer.alloc(HEADER_BYTES)
  const fd = openSync(path, 'r')
  let len = 0
  try {
    len = readSync(fd, buf, 0, HEADER_BYTES, 0)
  } finally {
    closeSync(fd)
  }
  const head = buf.subarray(0, len).toString('utf8').split(/\r?\n\s*\r?\n/)[0]
  const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head)?.[1].trim() ?? null
  const status = field('status')
  if (!status) return null
  const [word, size = null] = status.split(/\s+/)
  const settled = /^(\d+)\s+of\s+(\d+)$/.exec(field('settled') ?? '')
  const contradicted = field('contradicted')
  return {
    status: word,
    size,
    source: field('source'),
    input: field('input'),
    updated: field('updated'),
    settled: settled ? { n: Number(settled[1]), m: Number(settled[2]) } : null,
    contradicted: contradicted != null && /^\d+$/.test(contradicted) ? Number(contradicted) : null,
  }
}

const frac = (h) => (h.settled ? `${h.settled.n}/${h.settled.m} settled` : 'nothing settled yet')

/** How one header reads in the status table, and the command that picks it up. The status table
 *  shows lastDone, not state, so lastDone carries the state label. */
function describe(name, registry, h) {
  const path = `${registry}/${name}`
  const row = (state, nextStep, command) => ({ state, lastDone: state, nextStep, command })
  if (!h) return row('unreadable brainstorm.md', 'Restart the brainstorm', `/builder:brainstorm --path ${path}`)
  const skill = h.source === 'intake' ? 'intake' : 'brainstorm'
  const again = `/builder:${skill} --path ${path}`
  if (h.status === 'parked') return row(`parked idea (${frac(h)})`, 'Pick it back up when ready', again)
  if (h.status === 'sized' && ['md', 'lg', 'xl'].includes(h.size)) return row(`sized ${h.size} — spec not written`, 'Write the spec', `/builder:spec --path ${path}`)
  if (h.status === 'sized') return row(`sized ${h.size ?? '?'} — build in chat`, 'Design in chat and build', again)
  if (skill === 'intake') return row(`intake (${h.contradicted ?? 0} contradicted, ${frac(h)})`, 'Continue the intake', again)
  return row(`brainstorming (${frac(h)})`, 'Continue the brainstorm', again)
}

/** Rows for conversations that have no registry folder yet. A live folder owns its own row. */
export function draftRows(root, registry) {
  const base = join(root, '.builder')
  let names = []
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[_.]/.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const rows = []
  for (const name of names.sort()) {
    const file = join(base, name, BRAINSTORM_FILE)
    if (!existsSync(file) || existsSync(join(root, registry, name))) continue
    const h = readBrainstormHeader(file)
    if (h?.status === 'handed-off') continue
    const d = describe(name, registry, h)
    rows.push({
      feature: name,
      layout: 'brainstorm',
      path: `${registry}/${name}`,
      done: false,
      source: h?.source ?? null,
      state: d.state,
      lastDone: d.lastDone,
      nextStep: d.nextStep,
      command: d.command,
      next: d.command,
      updatedAt: h?.updated ?? null,
      updated: null,
      description: null,
      branch: null,
      waitsOn: [],
      warnings: [],
      problems: [],
    })
  }
  return rows
}
```

- [ ] **Step 4: Wire it into `scripts/list-features.mjs`**

a) Header comment: after the `ARCHIVED = …` paragraph add:

```
 * DRAFTS = a design conversation in progress with no registry folder yet — `.builder/<f>/brainstorm.md`
 * (scripts/brainstorm-file.mjs). Listed with their resume command; only the header is read.
```

b) Imports: add `import { draftRows } from './brainstorm-file.mjs'` and `import { ago } from './fleet-core.mjs'`.

c) In `describe = (r) => {…}` (the one-line "what it is"), replace

```js
  const overview = /^##\s+Overview\s*\n+([\s\S]*?)(?=\n##\s|$)/m.exec(text)
```

with

```js
  // A pre-4.0 SPEC opens with §Overview; a 4.0 SPEC opens with §Idea, whose **Why.** says it.
  const overview = /^##\s+Overview\s*\n+([\s\S]*?)(?=\n##\s|$)/m.exec(text) ?? /^##\s+Idea\s*\n+\*\*Why\.\*\*\s*([\s\S]*?)(?=\n\s*\n|\n##\s|$)/m.exec(text)
```

d) Immediately after the `for (const r of rows) { r.description = describe(r) … }` enrichment loop, add:

```js
// Conversations with no registry folder yet — added after the enrichment loop, which reads git
// and the folder, neither of which a draft has.
for (const d of draftRows(ROOT, CFG.registry)) {
  d.updatedAt = d.updatedAt ?? new Date(0).toISOString()
  d.updated = d.updatedAt === new Date(0).toISOString() ? 'unknown' : ago(d.updatedAt)
  rows.push(d)
}
```

e) In `--check`, drafts carry no problems or warnings, so no change. In the default table nothing changes (drafts have `state` and `next`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/test/brainstorm-file.test.mjs scripts/test/list-features.test.mjs scripts/test/archive-scale.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/brainstorm-file.mjs scripts/list-features.mjs scripts/test/brainstorm-file.test.mjs scripts/test/list-features.test.mjs
git commit -m "feat(list-features): conversations in progress are listed from their brainstorm.md header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `check-obligations` warns on a rejected option with no reason

**Files:**
- Modify: `scripts/check-obligations.mjs`
- Test: `scripts/test/check-obligations.test.mjs` (create)

**Interfaces:**
- Produces: a WARN finding `rule: 'rejected option gives no reason'`, `id: <D#>`, for each `Rejected:` clause in a §Decisions row whose text has no reason marker.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/check-obligations.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-obligations.mjs')

function run(spec) {
  const root = mkdtempSync(join(tmpdir(), 'co-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), '---\nproject: t\nregistry: docs/features\napps:\n  - name: app\n    path: app/\n    role: app\n---\n')
  mkdirSync(join(root, 'docs/features/f'), { recursive: true })
  writeFileSync(join(root, 'docs/features/f/SPEC.md'), spec)
  const r = spawnSync('node', [SCRIPT, 'f', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  return { ...r, findings: r.stdout ? JSON.parse(r.stdout)[0].findings : null }
}

const DECISIONS = (rows) => `# f — spec\n\n## Decisions\n| # | Decision | Ruling | Who / date |\n|---|---|---|---|\n${rows}\n`

test('a Rejected: clause naming only the option warns, and the spec still passes', () => {
  const r = run(DECISIONS('| D1 | Cache | Memoize per request. Rejected: Redis. | Luke 2026-09-29 |'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings.map((f) => [f.severity, f.rule, f.id]), [['WARN', 'rejected option gives no reason', 'D1']])
})

test('a Rejected: clause with its reason passes silently', () => {
  for (const clause of ['Rejected: Redis — a second service to run.', 'Rejected: Redis, because nothing else needs it.', 'Rejected: Redis (ops cost).', 'Rejected: Redis; it would need a second deploy.']) {
    const r = run(DECISIONS(`| D1 | Cache | Memoize per request. ${clause} | Luke 2026-09-29 |`))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.findings, [], clause)
  }
})

test('a pre-4.0 spec with §Overview and no §Idea raises nothing about §Idea', () => {
  const r = run('# f — spec\n\n## Overview\nOld.\n\n## Decisions\n| # | Decision | Ruling | Who / date |\n|---|---|---|---|\n| D1 | a | b | c |\n')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.findings, [])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/check-obligations.test.mjs`
Expected: the first test FAILS (no findings); the other two PASS.

- [ ] **Step 3: Implement**

In `scripts/check-obligations.mjs`, just before `results.push({ feature, findings })`, add:

```js
  // ── Obligation 5: a rejected option says why it lost ──────────────────────
  // The reasoning is what a later reader needs to not re-propose it. A WARN, not a FAIL: specs
  // written before 4.0 recorded bare rejections by rule, and they stay valid.
  const decisionsText = section(spec, DECISIONS_SECTION)
  for (const line of decisionsText.split('\n')) {
    const id = /^\|\s*`?(D\d+)`?\s*\|/.exec(line)?.[1]
    if (!id) continue
    for (const [, clause] of line.matchAll(/Rejected:\s*([^|]*)/gi)) {
      const text = clause.trim().replace(/[.\s]+$/, '')
      if (!/—|–|\s-\s|[(;:,]|\b(because|since|as|would|so)\b/i.test(text)) {
        findings.push({
          severity: 'WARN',
          rule: 'rejected option gives no reason',
          id,
          detail: `${id} rejects "${text}" without saying why. One line of why is what stops it being re-proposed.`,
        })
      }
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/test/check-obligations.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-obligations.mjs scripts/test/check-obligations.test.mjs
git commit -m "feat(check-obligations): warn on a rejected option that gives no reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `CONVERSATION.md` and REFERENCE — the shared mechanics and the new §Idea

**Files:**
- Create: `skills/brainstorm/CONVERSATION.md`
- Modify: `skills/resume/REFERENCE.md` (§SPEC.md block and target line; the §Decisions comment block; §Prototype mode's first paragraph; the spike sentence near line 117)
- Test: `scripts/test/skills-consistency.test.mjs` (create — grows in Task 8)

**Interfaces:**
- Produces: `skills/brainstorm/CONVERSATION.md` with the sections **§The record**, **§Rounds**, **§Approaches**, **§Confirm**, **§Size and the small path**, **§Steering and --auto** — cited by brainstorm (Task 4) and intake (Task 5). REFERENCE **§SPEC.md** now opens with `## Idea` — used by spec (Task 6).

- [ ] **Step 1: Write the failing test**

Create `scripts/test/skills-consistency.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('CONVERSATION.md carries every section the two conversation skills cite', () => {
  const c = read('skills/brainstorm/CONVERSATION.md')
  for (const s of ['The record', 'Rounds', 'Approaches', 'Confirm', 'Size and the small path', 'Steering and --auto']) assert.match(c, new RegExp(`^## ${s}$`, 'm'), s)
  for (const v of ['exploring', 'confirmed', 'sized', 'parked', 'handed-off']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
  for (const v of ['open', 'settled', 'assumed', 'stated', 'confirmed', 'contradicted', 'unverifiable']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
})

test('REFERENCE §SPEC.md opens with §Idea and keeps rulings operational', () => {
  const r = read('skills/resume/REFERENCE.md')
  const spec = r.slice(r.indexOf('## SPEC.md'), r.indexOf('### §Apps'))
  assert.ok(spec.indexOf('## Idea') > 0 && spec.indexOf('## Idea') < spec.indexOf('## Apps'), '§Idea comes before §Apps')
  assert.doesNotMatch(spec, /^## Overview/m)
  assert.match(spec, /In your words/)
  assert.match(spec, /Target ≤ 350 lines/)
  assert.match(spec, /why the rejected option lost/)
  assert.match(spec, /NEVER quote the user's prompt as the ruling/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: FAIL — `ENOENT … CONVERSATION.md`; the REFERENCE test fails on `## Idea`.

- [ ] **Step 3: Create `skills/brainstorm/CONVERSATION.md`**

````markdown
# The design conversation — shared by `/builder:brainstorm` and `/builder:intake`

Both skills run the same conversation machinery and write the same record; they differ in where the
tree comes from (brainstorm: the user's intent; intake: a document's claims). This file is that
machinery. It is short on purpose: nothing here loads REFERENCE — the conversation comes first, and
the spec formats belong to `/builder:spec`.

## The record

`.builder/<feature>/brainstorm.md` (`<builder>/scripts/workspace <feature>` prints the directory).
**Rewrite it after every round** — it is how a long conversation survives `/clear`, and it is the only
thing `/builder:spec` reads. The header is the lines before the first blank line; scripts read only
the header, so keep it exactly this shape:

```markdown
# <feature> — brainstorm
status: exploring | confirmed | sized <xs|sm|md|lg|xl> | parked | handed-off
source: brainstorm | intake
input: abstract idea | directed request | brief | spec | ticket <id> | design ref <ref>
updated: <ISO 8601 timestamp>
settled: <n> of <m>
contradicted: <n>                       ← intake only

## Intent
Outcome · who it's for · what success looks like — each marked "(assumed)" until the user confirms it.
In your words: "<the user's key rules, verbatim — never paraphrased>"
Assumed (not yet confirmed): …

## How it works today
<plain prose; an ASCII or mermaid diagram when several parts move; file:line only as footnotes>
Explained on request: <topic> — <what was found>

## Tree
| # | Branch | Depends on | Status | Ruling | Why | Rejected (and why) | Evidence |
|---|---|---|---|---|---|---|---|
Frontier: <branch ids ready to ask>
Waiting on facts: <branch id> — <what a sub-agent is checking>

## Approaches
Chosen: <approach> — <trade-offs> · Rejected: <approach> — <why it lost>

## Size
<size> — evidence: <apps, contract, surfaces, tasks it implies>
```

**Tree statuses:** `open` (no answer yet) · `settled` (the user ruled) · `assumed` (recon answered it;
stated to the user, not yet contested) · `stated` (intake: the document says so, not yet checked) ·
`confirmed` (intake: the code agrees — evidence required) · `contradicted` (intake: the code does
something else — evidence required) · `unverifiable` (needs running code or a person).

🔴 **Every settled row keeps its Why, and every rejected option its reason.** `/builder:spec` writes
§Idea and the §Decisions rows from these columns; a row without them becomes a thin spec.

## Rounds

- **Ask the whole frontier each round**: every `open` branch whose prerequisites are settled. A
  question whose answer depends on another question still open this round waits for a later round.
- **Format** — numbered, each with the context a person needs to answer it and a recommendation:

  ```
  ❓ **Q1 — <title>**: <the question, with what makes it matter; several paragraphs if needed>

  ➡️ <your recommendation, and why>
  ```

  A round made only of quick closed choices (which app, yes/no, one of three names) goes through
  AskUserQuestion instead, recommendation first and marked.
- **Facts are never the user's job.** A question the code can answer goes to a sub-agent (Explore,
  `sonnet`); only the branches downstream of that lookup wait — ask the rest of the frontier now, and
  record the lookup under *Waiting on facts*.
- **Say what recon settled, never decide it silently**: `Assumed B5: reuse Toaster — AppShell already
  mounts it (app/shell.tsx:40). Say if not.` An assumption the user doesn't contest stays `assumed`
  and is listed again at §Confirm.
- **After each round** recompute the frontier, rewrite the record, and open the next round with one
  line of progress: `8 of 12 settled — 3 open, 1 waiting on a lookup.`
- **"Explain X" at any point** — "how does X work", "what would this touch", "show me the data flow" —
  dispatches a sub-agent, and the answer comes back in plain words (a diagram when parts move),
  recorded under *Explained on request*. It is never refused as off-topic: understanding the system
  is part of the work.

## Approaches

Only when the tree holds a real fork — two or more viable designs that shape the rest of the tree.
Present 2–3, the recommendation first: what each is, its trade-offs, and **what it makes harder
later**. The chosen one becomes a settled branch; the others go to *Rejected* with the reason each
lost. No fork → no approaches step, and say so in one line.

## Confirm

When the frontier is empty: **"Here's the shared understanding — <intent in two lines>, <the approach>,
<n> decisions, <k> assumptions. Is anything missing or wrong?"** List every `assumed` branch. Nothing
leaves the workspace before a yes; a correction reopens its branch. Set `status: confirmed`, then
offer three ways on:

- **Build it** → §Size and the small path.
- **Park it** → `status: parked`. With `--keep`, also write `<registry>/<feature>/NOTES.md` — a
  one-page summary of Intent, How it works today and the Tree — and commit it
  `docs(<feature>): notes`; `list-features` reads it as analysis, and a later brainstorm resumes from
  the record.
- **Stop at understanding** → leave the record as it is and say so. Nothing is written to the repo.

## Size and the small path

Size the **confirmed concept**, not the first request: REFERENCE §Sizes and §The classifier are the
rules — read just those two sections. Announce the size with its evidence; the user confirms or
overrides; lg is offered a split before anything else. Record it: `status: sized <size>`.

- **md · lg · xl** → hand off: `📍 <feature>: concept confirmed (<size>) — next: /builder:spec --path <registry>/<feature> · or say go`.
- **xs · sm** — no spec, no folder:
  1. **Design in chat.** xs: one sentence. sm: the app · approach · files touched · the recipe skills
     it will read · tests · what you will see in the running app.
  2. **One approval.** Stop until yes. Presenting and starting in the same turn skips the gate.
  3. **Implement in the main context.** Read the named recipe skills FIRST (the config's §Companion
     skills); TDD where behaviour changes; that app's §House rules and §Environment landmines.
     🔴 **In an app the config marks `commit: manual`, stage and stop** — that commit is the human's.
  4. **Fast gates** — the subset for that app that the diff can turn red, said out loud (the config's
     §Quality gates). Report a delta where the config asks for one, never a green exit.
  5. **The human's look at the running app** for anything visual — after REFERENCE §Walk readiness.
     Say what has and has not been human-checked; the PR lock holds in chat form.
  6. Set `status: handed-off` and end: `📍 <the work>: <shipped | awaiting your look at the app> — next: <the command>`.

## Steering and --auto

**The user steers at any time**: "go deeper on X" (open sub-branches under X), "skip that, use your
recs" (settle the frontier on the recommendations, recorded as the user's ruling), "that's enough"
(jump to §Confirm, listing what is still open as assumed).

**Under `--auto`**: play the intent back as `(assumed)`; every round settles on its recommendations,
recorded `auto (recommended) YYYY-MM-DD` in the Ruling cell; the recommended approach is chosen;
§Confirm and §Size proceed without waiting. The human reads the assumptions and every auto ruling at
the go-ahead.
````

- [ ] **Step 4: Edit `skills/resume/REFERENCE.md`**

a) In §SPEC.md's code block, replace the line `## Overview` with:

```
## Idea                 prose, never a table — written from brainstorm.md by /builder:spec:
                       **Why.** the outcome and who it's for · **What success looks like.** how a person
                       will know it works · **In your words.** "<the owner's key rules, verbatim>" → D3, D7
                       (each quote linked to its ruling) · **The concept.** how it works (mermaid when
                       several parts move) · **How it fits today.** prose, file:line only as footnotes ·
                       **Approaches considered.** chosen and why · rejected and why
```

b) Replace `Target ≤ 300 lines; \`list-features.mjs --check\` warns at 500 — a longer SPEC is usually two features.` with:

```
Target ≤ 350 lines; `list-features.mjs --check` warns at 500 — a longer SPEC is usually two features.
A SPEC written before 4.0.0 opens with `## Overview` instead of `## Idea`; it stays valid as it is.
```

c) In the §Decisions comment block, replace the first line
`<!-- The one place rulings live. Record the DECISION, not the conversation: a stated preference`
with
`<!-- The one place rulings live. Record the DECISION — and, in one line, why, and why the rejected option lost. A stated preference`
and replace
`       · the rejected alternative named, when it would otherwise be re-proposed`
with
`       · the rejected alternative named, with the reason it lost (check-obligations warns on a bare one)`
and after the line `     Who/date carries the provenance, so the Ruling itself needs no quote marks.` add
`     The owner's own words go in §Idea "In your words", linked to this row — never in the Ruling.`

d) In §Prototype mode, replace the first sentence `Entered by the config's design flag.` with
`Entered through \`/builder:intake --<design.flag> <ref>\`, which runs steps 1–4 below; \`/builder:spec\` runs step 5.`

e) Near line 117, replace `A spike that concludes "yes, and here's how" becomes a \`/builder:brainstorm\` run` with `A spike that concludes "yes, and here's how" becomes a \`/builder:brainstorm\` (or \`/builder:intake\`) run` (keep the rest of that sentence).

- [ ] **Step 5: Run to verify it passes**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/brainstorm/CONVERSATION.md skills/resume/REFERENCE.md scripts/test/skills-consistency.test.mjs
git commit -m "docs(reference): the shared conversation mechanics; SPEC opens with a prose §Idea

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite `/builder:brainstorm` as the exploration conversation

**Files:**
- Modify (full rewrite): `skills/brainstorm/SKILL.md`
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Consumes: `skills/brainstorm/CONVERSATION.md` sections (Task 3).
- Produces: `/builder:brainstorm [--path <folder>] [--auto] [--keep] [--help] <what you want>`; writes `.builder/<feature>/brainstorm.md` with `source: brainstorm`; hands md+ to `/builder:spec`, a document or design ref to `/builder:intake`.

- [ ] **Step 1: Write the failing test** — append to `scripts/test/skills-consistency.test.mjs`:

```js
test('brainstorm is the exploration conversation: no REFERENCE load, no design flag, sizing after confirm', () => {
  const b = read('skills/brainstorm/SKILL.md')
  assert.match(b, /^name: brainstorm$/m)
  assert.match(b, /CONVERSATION\.md/)
  assert.doesNotMatch(b, /Load REFERENCE/)
  assert.doesNotMatch(b, /Phase 1P|Prototype mode|design\.resolver/)
  assert.match(b, /\/builder:intake/)
  assert.match(b, /\/builder:spec/)
  assert.ok(b.indexOf('## Intent') < b.indexOf('## Size'), 'intent comes before sizing')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: FAIL (the current skill loads REFERENCE and has Phase 1P).

- [ ] **Step 3: Replace `skills/brainstorm/SKILL.md` with:**

````markdown
---
name: brainstorm
description: The exploration conversation — start here with an idea, a request or a question about how something should work. Plays back what you intend, explains how the code works today in plain words, then asks in rounds only what is still open (every question ready to ask, each with a recommendation; facts are looked up, never asked), lays out approaches when there is a real fork, and confirms a shared understanding before anything is written. Only then does it size the work — xs/sm are designed and built in chat, md/lg/xl hand on to /builder:spec — or park the idea, or stop at understanding. A worked-out spec, ticket or design ref goes to /builder:intake instead. Resumable from its workspace record. Use when the user wants to explore, think through, design, build, add or change anything.
---

# `/builder:brainstorm` — understand it together, then decide what to build

Invocation: **`/builder:brainstorm [--path <folder>] [--auto] [--keep] [--help] <what you want>`**.
Flags first; free text after them is the work. Ignore any flag this step does not use rather than
erroring on it.

**`--help` first.** If present, render the `builder:help` card and stop.

**The mechanics live in [CONVERSATION.md](CONVERSATION.md)** — the record, rounds, approaches,
confirm, size, steering. Read it now. **Do not load REFERENCE**: the conversation comes first, and
the spec formats belong to `/builder:spec`. Read `.claude/builder.md` for the apps and the house-rule
sources only.

**This is a dialogue.** It is done when the user says the understanding is right — not when enough is
known to build.

## Where to start

- **`--path <folder>` with a `brainstorm.md` in its workspace** → resume: say what is settled and what
  is open, then ask the next round. A record with `source: intake` belongs to `/builder:intake` —
  hand it there.
- **`--path` or a derived name that exists under `<registry>/_archive/`** → it shipped: refuse the
  name, say when (its header line), suggest `<name>-v2`.
- **A live `SPEC.md` in the folder** → a revision conversation: seed the tree from the SPEC (every
  §Decisions row a `settled` branch), then run the rounds on the change. With no `go-ahead:` yet the
  result goes to `/builder:spec`; after a go-ahead it goes to `/builder:revise`.
- **A folder with build state but no manifest** → a pre-builder layout: hand it to
  `/builder:resume --path <folder>` and stop.
- **No `--path`, no text** → the picker: `node <builder>/scripts/list-features.mjs --json`, one
  AskUserQuestion — the in-progress features and conversations (their `state` + `nextStep`), plus
  **New (describe it)**.
- **A design flag, a ticket id, or a pasted or linked document that already decides most of the
  design** → offer the better entry: "This reads like a worked-out spec — want me to verify it
  against the code with `/builder:intake` instead of exploring from scratch?" On yes, hand it over
  verbatim. A design flag always goes to intake.
- Otherwise it is new: derive a kebab-case name from the text and confirm it in the first turn.

## Intent — the first turn

1. **Read the input** and name what it is: an abstract idea, a directed request, or a brief.
2. **Map it into the tree** (CONVERSATION §The record): the branches the input already settles and
   the ones it leaves open. Say the depth plainly: "Your brief settles 9 of 12 decisions — 3 open" or
   "This is an open idea — I'll explore it with you."
3. **Play back the intent**: the outcome, who it is for, what success looks like — what the user said
   kept apart from what you assume, the user's key rules quoted in their words. Ask what is wrong.
4. **Start recon in parallel** (Explore agents, `sonnet`, one per app the idea plausibly touches) —
   it never holds up this turn.

Write the record (`status: exploring`, `source: brainstorm`). The intent stays `(assumed)` until the
user confirms or corrects it.

## How it works today

Once the intent is confirmed, explain what recon found **to the user**, in plain words: what exists
that the idea touches, how it works, where it lives — with a small diagram when several parts move.
Scale it to the input: a paragraph for a directed request, a real walk-through for an abstract idea.
Name **what already exists that must not be rebuilt**. `file:line` goes in footnotes, never instead
of the explanation. Record it under *How it works today*.

From here on, "explain X" works at any point (CONVERSATION §Rounds).

## Rounds

CONVERSATION §Rounds, until the frontier is empty. Where the branches come from:

- **The input first** — every choice it leaves open with more than one defensible answer.
- **The fundamentals, when the idea reaches them**: the data-model shape, lifecycle edges (deletes,
  cascades, idempotence, time), permissions and what an unauthorized caller sees, where a surface
  lives in each app.
- **When more than one app is plausibly involved**, four branches join the tree even if nobody raised
  them: which apps; what a RELEASED build sees while this rolls out (for an app the config marks
  `released_artifact: true`); where the capability lives when the app is closed; do all the consumers
  need it, or only one.

## Approaches, confirm, size

CONVERSATION §Approaches, §Confirm and §Size and the small path, in that order. Sizing happens only
after the user confirms the understanding and chooses to build.

## Size

The size comes from the confirmed concept (CONVERSATION §Size and the small path). md, lg and xl hand
on to `/builder:spec`; xs and sm are designed and built here.

## Every pause

End each turn that waits on the user with the resume footer:

```
📍 <feature>: brainstorming (<n>/<m> settled) — resume with /builder:brainstorm --path <registry>/<feature>
```

**Continuing:** a bare "go", "yes" or "proceed" after a hand-off footer runs its command yourself.
````

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/brainstorm/SKILL.md scripts/test/skills-consistency.test.mjs
git commit -m "feat(brainstorm): the exploration conversation — intent, how it works today, rounds, then size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: New `/builder:intake` — verify a worked-out input

**Files:**
- Create: `skills/intake/SKILL.md`
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Consumes: CONVERSATION.md (Task 3); REFERENCE §Prototype mode (Task 3 d), `skills/resume/SCOPE-SELECTION.md`, `skills/resume/SURFACE-CHECK.md` (existing).
- Produces: `/builder:intake [--path <folder>] [--<design.flag> <ref>] [--all] [--auto] [--keep] [--help] <doc path | ticket id | pasted text>`; writes `brainstorm.md` with `source: intake` and a `contradicted:` header line.

- [ ] **Step 1: Write the failing test** — append:

```js
test('intake verifies claims, owns prototype mode, and shares the record', () => {
  const i = read('skills/intake/SKILL.md')
  assert.match(i, /^name: intake$/m)
  assert.match(i, /CONVERSATION\.md/)
  for (const s of ['confirmed', 'contradicted', 'unverifiable', 'stated']) assert.match(i, new RegExp(`\\b${s}\\b`))
  assert.match(i, /SCOPE-SELECTION\.md/)
  assert.match(i, /source: intake/)
  assert.match(i, /\/builder:spec/)
})
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/test/skills-consistency.test.mjs` → FAIL (ENOENT).

- [ ] **Step 3: Create `skills/intake/SKILL.md`:**

````markdown
---
name: intake
description: Verify a worked-out input against reality before a spec is written — a spec or brief someone already wrote (a file, a pasted doc, a superpowers design spec), a ticket, or a finished design ref (prototype mode). Extracts every decision, architectural claim, requirement and constraint it states, checks each against the code with parallel sub-agents (confirmed with evidence, contradicted with what the code actually does, or unverifiable), hunts the gaps it never decides, then asks only about contradictions and gaps in rounds — confirmed claims are reported, not asked. Ends in a confirmed understanding and a size, then hands on to /builder:spec. Use when the user already has the design written down and wants it grounded in what's real.
---

# `/builder:intake` — the document is the authority; check it against the code

Invocation: **`/builder:intake [--path <folder>] [--<design.flag> <ref>] [--all] [--auto] [--keep]
[--help] <doc path | ticket id | pasted text>`**. Ignore any flag this step does not use.

**`--help` first.** If present, render the `builder:help` card and stop.

**The mechanics live in [../brainstorm/CONVERSATION.md](../brainstorm/CONVERSATION.md)** — the
record, rounds, confirm, size, steering. Read it now. Read `.claude/builder.md`. Load REFERENCE
§Prototype mode only for a design ref.

**The difference from brainstorm:** brainstorm draws out what the user wants; intake takes what is
written as the requirements and finds where it meets reality. Intent is still played back — in one
paragraph, from the document.

## Where to start

- `--path` with a record whose `source: intake` → resume at the frontier. `source: brainstorm` →
  hand it to `/builder:brainstorm`.
- The archived-name refusal and the pre-builder-layout hand-off are brainstorm's (see its §Where to
  start) — apply them the same way.
- **A ticket id** → read it with the config's ticket tooling, and its dossier when `ticket.dossier`
  names one.
- **A design flag** → prototype mode, below.
- Name the feature from the document's title; confirm it in the first turn.

## 1. Extract

Read the whole input. Every decision, architectural claim ("X already caches per request"),
requirement, constraint and non-goal becomes a tree row with status **`stated`**, citing where the
document says it. Write the record (`status: exploring`, `source: intake`, `input: <kind>`), then play
back the intent in one paragraph, from the document, the author's key rules quoted.

## 2. Verify

Check every `stated` row against the code with parallel sub-agents (Explore, `sonnet`; `opus` for a
verdict that needs judgment). Each row ends as:

- **`confirmed`** — the code agrees; the Evidence cell carries `file:line`.
- **`contradicted`** — the code does something else; the Evidence cell says what, with `file:line`.
- **`unverifiable`** — only running code or a person can say; name which.

Update `contradicted:` in the header as they land.

## 3. Find the gaps

Branches the document never decides but the build will meet become `open` rows:

- **states** it doesn't cover — empty, refused, done, legacy data, errors;
- **callers and consumers** it doesn't list — who else reads or writes what it changes;
- **rollout** — what a RELEASED build sees meanwhile, for an app the config marks
  `released_artifact: true`;
- **the four multi-app branches** when more than one app is involved (see brainstorm §Rounds);
- **what already exists** that the document would rebuild.

## 4. Report, then ask

Report first, briefly: `14 of 19 claims confirmed · 3 contradicted · 2 unverifiable · 6 gaps` — the
confirmed ones as a list, not questions. Then CONVERSATION §Rounds on the **contradicted,
unverifiable and open** rows only: for a contradiction, the question is which side changes — the
document or the code — with your recommendation.

## 5. Confirm, size, hand on

CONVERSATION §Confirm and §Size and the small path. md, lg and xl hand on to `/builder:spec`.

## Prototype mode — a design ref

**The design is the requirements** (REFERENCE §Prototype mode). Only when the config has a `design:`
block.

1. **Resolve the ref — never from memory** — with the config's `design.resolver`, following
   [`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md). Under `--auto` an ambiguous ref without `--all`
   refuses to start. Echo the resolved scope as a tree, naming what is NOT in scope and which items are
   not yet built. A feature whose manifest's design key already carries this ref IS the feature: hand
   it to `/builder:resume --path <folder>`. A design still being specced → `/builder:check` first.
2. **Inventory the design** per in-scope item — its contract read in full, its designed states and
   variant axes, props, tokens, open questions, whether it is built. Parallel `sonnet` agents for a
   wide ref. Each contract fact is a `stated` row; the full inventory goes to the workspace. If the
   design system carries owner notes, read them with the tool the config names — never by eye, and
   never write one.
3. **Verify against reality on five axes** (`sonnet` sweeps, `opus` verdicts): replaced surfaces
   ([`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md)); journey edges — ingress, egress, shared surfaces,
   including deep links; component coverage — every element resolves to a real component, and the
   legacy one it replaces is identified (a missing one is a design-system defect: route it, never
   invent inline); conventions — the config's §Design source, item by item; a light read of what the
   design persists (the full trace is align's).
4. **One gap list** across the whole scope — the same defect at eight sites is one gap with its eight
   sites — ordered by blast radius. Each gap is an `open` row offering REFERENCE §Prototype mode's three
   options, recommendation marked: fix it in the design (route to the config's `design.owned_by`, then
   re-read the contract), write it into the SPEC, or out of scope. 🔴 **This step never edits the
   design.** Under `--auto` a gap takes its recommended option; "fix it in the design" is recommended
   only for a bounded, mechanical fix.

The resolved scope, the inventory summary and each gap's disposition go in the record, so
`/builder:spec` can write §Prototype and §Replaced surfaces.

## Every pause

```
📍 <feature>: intake (<k> contradicted, <n>/<m> settled) — resume with /builder:intake --path <registry>/<feature>
```
````

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/test/skills-consistency.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/intake/SKILL.md scripts/test/skills-consistency.test.mjs
git commit -m "feat(intake): verify a worked-out doc, ticket or design ref against the code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: New `/builder:spec` — write the spec from the record

**Files:**
- Create: `skills/spec/SKILL.md`
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Consumes: the record format (CONVERSATION §The record); REFERENCE §SPEC.md with §Idea (Task 3); REFERENCE §MANIFEST.md, §PROGRAM.md, §Prototype mode step 5 (existing); `scripts/check-obligations.mjs`.
- Produces: `/builder:spec [--path <folder>] [--auto] [--help]`; sets the record's `status: handed-off`.

- [ ] **Step 1: Write the failing test** — append:

```js
test('spec needs a sized record, loads REFERENCE, writes §Idea first and hands off', () => {
  const s = read('skills/spec/SKILL.md')
  assert.match(s, /^name: spec$/m)
  assert.match(s, /status: sized/)
  assert.match(s, /Load REFERENCE/)
  assert.match(s, /§Idea/)
  assert.match(s, /check-obligations\.mjs/)
  assert.match(s, /handed-off/)
  assert.match(s, /\/builder:resume --path/)
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (ENOENT).

- [ ] **Step 3: Create `skills/spec/SKILL.md`:**

````markdown
---
name: spec
description: Write the feature's spec from a confirmed design conversation — reads the workspace record /builder:brainstorm or /builder:intake left (the intent, how it works today, every decision with its reasoning, the approaches, the size), presents the design section by section for approval with §Idea first (why, what success looks like, the owner's rules in their own words, the concept, how it fits today, the approaches considered), then writes SPEC.md + MANIFEST.md (or PROGRAM.md at xl), proves the obligations, commits, and hands on to /builder:resume. Also applies a brainstorm or intake revision to a spec that has no go-ahead yet. Use after a brainstorm or intake is sized md, lg or xl.
---

# `/builder:spec` — the confirmed concept, written down

Invocation: **`/builder:spec [--path <folder>] [--auto] [--help]`**.

**`--help` first.** If present, render the `builder:help` card and stop.

**Precondition:** `.builder/<feature>/brainstorm.md` with `status: sized md`, `sized lg` or
`sized xl` — or, for a revision, a live `SPEC.md` with no `go-ahead:` and a record whose rounds
settled the change. Otherwise say in one line what is missing and name `/builder:brainstorm` or
`/builder:intake`, and stop.

**Load REFERENCE and `.claude/builder.md` before writing anything**: REFERENCE §SPEC.md,
§MANIFEST.md and §PROGRAM.md hold every shape this step produces; the config holds every fact about
the project. Read the whole record.

## 1. Present the design, section by section

In SPEC order, each section scaled to its complexity, asking after each whether it is right:

1. **§Idea** — from the record's Intent, How it works today, Approaches and the Tree's Why and
   Rejected columns: why, what success looks like, **the owner's key rules verbatim** each linked to
   the D# that operationalizes it, the concept (a mermaid diagram when several parts move), how it
   fits today (prose; `file:line` only as footnotes), the approaches considered with why each lost.
2. **§Apps and §Contract** — the blast radius.
3. The per-app sections, §Schema & API changes, §Testing, §Out of scope; in prototype mode §Prototype
   and §Replaced surfaces from the record's intake findings.

Pushback amends the record's tree first, then the section. Under `--auto` present and proceed.

## 2. Write the files

**`SPEC.md`** per REFERENCE §SPEC.md. md writes the sections its work touches — **§Idea, §Apps and
§Contract are never skipped**; lg writes them all. Every settled or confirmed branch becomes a
§Decisions row: an implementable ruling, its why in one line, the rejected option and why it lost —
copy the §Decisions comment block verbatim. Assumed branches the user never contested are rulings
too, marked `(assumed at brainstorm)` in Who/date. Verify that every component the per-app sections
name exists NOW and that its interface fits; a missing one is a **(new)** row, and say plainly that
approving the spec approves building it. Target ≤ 350 lines.

**`MANIFEST.md`** per REFERENCE §MANIFEST.md: `size`, `state: spec`, `next:`, `head`, `ticket`,
`branch`, `pr: none`, **`apps:`** (the plus-joined in-scope apps), **`contract: open`** (or `none`
when no producer change), `hold: none`, `go-ahead`/`walk`/`verify: none`, the design key, `auto:`.

**`--size xl`** writes `PROGRAM.md` per REFERENCE §PROGRAM.md instead — the children, their order
(🔴 ordered by the contract), the decisions they share — plus a program manifest; take the one program
go-ahead and stop.

## 3. Prove it, commit, hand on

```
node <builder>/scripts/check-obligations.mjs <folder>
```

Fix every FAIL; resolve every WARN or say why it stands. **Self-review** with fresh eyes: placeholder
scan; internal consistency (does §Testing cover every interface §Contract declares? does every ✅ in
§Apps have its section? does every "In your words" quote link to a real D#?); ambiguity — a ruling a
stranger could implement two ways is not written yet. Commit `docs(<ticket-or-feature>): design
<feature>`, set the record's `status: handed-off`.

Say what was written and where; **lead with the §Apps row**; list the OPEN decisions with their
recommendations; in prototype mode add the gap tally. Then:

```
📍 <feature>: designed (<size>, <apps>) — next: /builder:resume --path <registry>/<feature> · or say go
```
````

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/spec/SKILL.md scripts/test/skills-consistency.test.mjs
git commit -m "feat(spec): write SPEC.md from the confirmed conversation, §Idea first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Routing, docs and the 4.0.0 release

**Files:**
- Modify: `skills/resume/SKILL.md`, `skills/help/SKILL.md`, `skills/check/SKILL.md`, `skills/prototype/SKILL.md`, `skills/revise/SKILL.md`, `skills/plan/SKILL.md`, `skills/resume/SCOPE-SELECTION.md`, `README.md`, `.claude-plugin/plugin.json`, `CHANGELOG.md`
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Consumes: the three skills' invocations (Tasks 4–6); the record statuses (Task 3).

- [ ] **Step 1: Write the failing test** — append:

```js
import { readdirSync } from 'node:fs'

test('no skill routes a design ref to brainstorm; resume knows the record; help names the entries', () => {
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const p = `skills/${dir}/SKILL.md`
    if (!existsSync(join(ROOT, p))) continue
    assert.doesNotMatch(read(p), /\/builder:brainstorm --<(design\.)?flag>/, p)
  }
  const r = read('skills/resume/SKILL.md')
  assert.match(r, /brainstorm\.md/)
  assert.match(r, /\/builder:spec/)
  assert.match(r, /\/builder:intake/)
  const h = read('skills/help/SKILL.md')
  assert.match(h, /\/builder:intake/)
  assert.match(h, /\/builder:spec/)
  assert.match(read('.claude-plugin/plugin.json'), /"version": "4\.0\.0"/)
  assert.match(read('CHANGELOG.md'), /^## 4\.0\.0$/m)
})
```

(Move the `readdirSync` import to the file's top import line from `node:fs`.)

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Edit the skills**

a) `skills/resume/SKILL.md`:
- Replace `**This command never sizes or designs anything.** New work — free text, a \`--size\`, a design ref with no folder behind it — is \`/builder:brainstorm\`'s: hand it there verbatim, flags included, and stop.` with:

```markdown
**This command never sizes or designs anything.** New work is a conversation's: free text or a
`--size` → `/builder:brainstorm`; a design ref, a ticket or a worked-out document with no folder
behind it → `/builder:intake`. Hand it there verbatim, flags included, and stop.
```

- In Step 1, before the paragraph `**No \`MANIFEST.md\`**`, add:

```markdown
**No registry folder, but a `.builder/<feature>/brainstorm.md`** → a design conversation in progress
(its header: `status`, `source`). `sized md|lg|xl` → `/builder:spec --path <folder>`; `handed-off`
with no folder → the spec was never committed: `/builder:spec --path <folder>`; anything else →
`/builder:<source> --path <folder>`. Run it and stop.
```

- In §The picker, after the bullet `- **Offerable** — …`, add: `- Rows with \`layout: brainstorm\` are conversations in progress; selecting one runs its \`command\`.`

b) `skills/help/SKILL.md`:
- Replace the paragraph starting `**One command builds anything, and most of it never reaches a doc.** \`/builder:brainstorm\` sizes the request first (REFERENCE §Sizes):` up to `…**xl** becomes a \`PROGRAM.md\` whose children each run it.` with:

```markdown
**Start with a conversation, size it once it's understood.** `/builder:brainstorm` explores an idea
with you — your intent played back, how the code works today, questions in rounds, approaches — and
`/builder:intake` checks a worked-out spec, ticket or design against the code. Once the concept is
confirmed it is sized (REFERENCE §Sizes): **xs and sm** are designed and built in chat and write
nothing under `docs/`; **md and lg** go to `/builder:spec`, which writes one `SPEC.md` (opening with
the idea, in prose) plus a ~12-line `MANIFEST.md` and runs the pipeline below; **xl** becomes a
`PROGRAM.md` whose children each run it.
```

- In the "Which command do I run?" table, replace the four rows `Wanting something built, unsure how big it is`, `Sure it's a small change inside one app`, `Sure it's a new feature`, `Building from a design that is already specced` with:

```markdown
| **An idea, a request, or something to think through** | `/builder:brainstorm <what you want>` — plays back your intent, explains how the code works today, asks in rounds, confirms, then sizes it: xs/sm built in chat, md+ on to `/builder:spec`. The normal way in |
| **A spec, brief or ticket someone already wrote** | `/builder:intake <file · ticket · pasted doc>` — checks every claim against the code (confirmed · contradicted · unverifiable), finds the gaps, asks only about those |
| Building from a design that is already specced | `/builder:intake --<design.flag> <ref>` — the contracts are the requirements. The flag's name comes from your config |
| A confirmed concept to write up | `/builder:spec --path <folder>` — normally reached by brainstorm's or intake's hand-off |
```

- In the row `Running one step by hand`, replace `` `/builder:brainstorm` · `` with `` `/builder:brainstorm` · `/builder:intake` · `/builder:spec` · ``.

c) `skills/check/SKILL.md` — in the frontmatter description replace `before it enters /builder:brainstorm` with `before it enters /builder:intake`; replace `belongs to \`builder:brainstorm\`\nPhase 1P.` with `belongs to \`builder:intake\`'s prototype mode.`; replace `written once by \`builder:brainstorm\`` with `written once by \`builder:spec\``.

d) `skills/prototype/SKILL.md` — replace every `/builder:brainstorm --<flag> <ref>` with `/builder:intake --<flag> <ref>`, and in line 12's sentence replace `point at \`/builder:brainstorm\`, which designs` with `point at \`/builder:intake\`, which verifies`.

e) `skills/resume/SCOPE-SELECTION.md` line 4 — replace `` `builder:check` and `builder:brainstorm` `` with `` `builder:check` and `builder:intake` ``.

f) `skills/revise/SKILL.md` line 24 — keep `/builder:brainstorm` (a question still goes to a conversation); append to that bullet: `, then \`/builder:spec\` if the spec has no go-ahead yet`.

g) `skills/plan/SKILL.md` line ~183 — replace `` `/builder:brainstorm --path <folder>` `` with `` `/builder:brainstorm --path <folder>` (or `/builder:intake` for a document) ``.

- [ ] **Step 4: README, plugin.json, CHANGELOG**

`README.md`: in the paragraph at line 8 starting `**One command builds anything…**`, replace the first sentence with the same text as help's new paragraph first sentence (`**Start with a conversation, size it once it's understood.** …` through `…checks a worked-out spec, ticket or design against the code.`). In the skills tree, after the `init/SKILL.md` line add:

```
    brainstorm/SKILL.md      the exploration conversation; CONVERSATION.md is the mechanics it shares with intake
    intake/SKILL.md          verifies a worked-out spec, ticket or design ref against the code
    spec/SKILL.md            writes SPEC.md (§Idea first) + MANIFEST.md from the confirmed conversation
```

`.claude-plugin/plugin.json`: `"version": "4.0.0"`, and in `description` replace `Sizes the work first (xs/sm in chat, md/lg as a SPEC + manifest through its own subagent task loop, xl as a program), then drives brainstorm →` with `Explores the idea first (brainstorm) or verifies a worked-out spec against the code (intake), sizes the confirmed concept (xs/sm in chat, md/lg as a SPEC + manifest through its own subagent task loop, xl as a program), then drives spec →` and `Entry: /builder:brainstorm.` with `Entry: /builder:brainstorm, or /builder:intake for a written spec.`

`CHANGELOG.md`, above `## 3.8.0`:

```markdown
## 4.0.0

**Breaking:**
- `/builder:brainstorm` is now an exploration conversation. It plays back your intent, explains how
  the code works today, asks in rounds (every ready question, each with a recommendation; facts are
  looked up, never asked), lays out approaches, and confirms before anything is written. **Sizing
  happens after the concept is confirmed**, not first; an idea can also be parked or left at
  understanding.
- **Prototype mode moved to the new `/builder:intake`.** `/builder:brainstorm --<design.flag> <ref>`
  is now `/builder:intake --<design.flag> <ref>`.
- **Spec writing moved to the new `/builder:spec`**, which reads the conversation's workspace record
  (`.builder/<feature>/brainstorm.md`). md/lg/xl brainstorms hand off to it.

**New:**
- `/builder:intake <doc | ticket | design ref>` verifies a worked-out input claim by claim —
  confirmed, contradicted or unverifiable — finds the gaps it never decides, and asks only about
  those.
- Every new `SPEC.md` opens with **§Idea**: why, what success looks like, your key rules in your own
  words (linked to the rulings), the concept, how it fits today, and the approaches considered.
  Decisions keep one line of why and why the rejected option lost; `check-obligations` warns on a
  bare rejection. Specs written before 4.0 stay valid.
- `/builder:status` and `/builder:resume` list conversations in progress (`brainstorming (6/11
  settled)`, `intake (3 contradicted…)`, `sized md — spec not written`, `parked idea`).
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test scripts/test/skills-consistency.test.mjs` → PASS; then the full suite once.

- [ ] **Step 6: Commit**

```bash
git add skills README.md .claude-plugin/plugin.json CHANGELOG.md scripts/test/skills-consistency.test.mjs
git commit -m "feat: brainstorm → intake → spec routing across the family; 4.0.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Consistency read-through

**Files:**
- Modify: whatever the read-through finds (skills only)
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the cross-skill checks** — append:

```js
test('every status value is handled somewhere, and every section cited in CONVERSATION.md exists', () => {
  const skills = ['brainstorm/SKILL.md', 'brainstorm/CONVERSATION.md', 'intake/SKILL.md', 'spec/SKILL.md', 'resume/SKILL.md'].map((p) => read(`skills/${p}`)).join('\n')
  for (const s of ['exploring', 'confirmed', 'sized', 'parked', 'handed-off']) assert.match(skills, new RegExp(`\\b${s}\\b`), s)
  const conv = read('skills/brainstorm/CONVERSATION.md')
  for (const p of ['brainstorm/SKILL.md', 'intake/SKILL.md']) {
    for (const [, name] of read(`skills/${p}`).matchAll(/CONVERSATION §([A-Z][A-Za-z -]+?)(?=[,.;)]| and| in|$)/gm)) {
      assert.match(conv, new RegExp(`^## ${name.trim()}`, 'm'), `${p} cites CONVERSATION §${name.trim()}`)
    }
  }
})
```

- [ ] **Step 2: Run it** — `node --test scripts/test/skills-consistency.test.mjs`. Fix any citation that names a section CONVERSATION.md does not have (edit the citing skill, not the test).

- [ ] **Step 3: Read-through** — read `skills/brainstorm/SKILL.md`, `skills/brainstorm/CONVERSATION.md`, `skills/intake/SKILL.md`, `skills/spec/SKILL.md`, the edited parts of `skills/resume/SKILL.md` and `skills/help/SKILL.md` end to end, checking:
  - who loads REFERENCE (spec yes; brainstorm never; intake only §Prototype mode, and CONVERSATION §Size reads only §Sizes, §The classifier and §Walk readiness);
  - prototype mode is described in exactly one skill (intake) and cited by REFERENCE §Prototype mode;
  - every hand-off footer names a command that exists;
  - `--keep`, `--auto`, `--path`, `--help` behave the same in brainstorm and intake.
  Record each check and its result in the commit body; fix what fails.

- [ ] **Step 4: Full suite** — `node --test 'scripts/test/*.test.mjs'` → PASS (re-run the two known timing tests alone if only they fail).

- [ ] **Step 5: Commit**

```bash
git add skills scripts/test/skills-consistency.test.mjs
git commit -m "test(skills): cross-skill consistency for the conversation family

<the read-through checks and results, one per line>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**After the plan (the human's):** dry runs on real input — an abstract idea through `/builder:brainstorm`; one of fai-cd's superpowers-era specs through `/builder:intake`; the result through `/builder:spec`. A good spec has §Idea with a Why, at least one *In your words* quote, and approaches with reasons.
