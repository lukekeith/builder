# note-tags — implementation plan

> **For agentic workers:** this plan is executed by `/builder:build`, one task at a time, with a
> fresh implementer per task, tested and reviewed as the go-ahead's test plan sets. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes can carry lower-case tags: `add --tag`, a tagged `list` line, `list --tag` filtering, a `tags:` line on `show`, and a `notes tags` summary.

**Architecture:** Everything lands in `src/cli.mjs`: a hand-written argument parser that splits `--tag <t>` values from text words, a tag validator, a `line(note)` formatter, and a new `tags` case. Notes gain an optional sorted, de-duplicated `tags` array; readers treat a missing key as no tags, so old files load unchanged. `src/store.mjs` changes only its shape comment.

**Tech Stack:** notes — Node ESM CLI, `node:fs` JSON store, `node:test` end-to-end tests via `child_process`.

**Spec:** `docs/features/note-tags/SPEC.md`

## Global Constraints

- No dependencies. Node's own modules only.
- The CLI entry stays `src/cli.mjs`; tests stay under `test/` and run with `npm test`.
- Every command prints its result on stdout and fails (exit 1, message on stderr) on bad input.

## Phases

| Phase | App | Tasks | Goal | Gates |
|---|---|---|---|---|
| 1 | notes | 1–2 | `add --tag` stores validated, sorted, unique tags; `list` prints them and filters by one tag | `npm test` |
| 2 | notes | 3 | `show` prints a `tags:` line, `notes tags` counts tags, old files proven, README updated; contract frozen | `npm test` |

---

### Task 1: Tag parsing, `add --tag`, and the tagged `list` line
App: notes
Phase: 1
Recipe: builder:test-driven-development

**Files:**
- Modify: `src/cli.mjs` (whole file is 38 lines: `USAGE` at :4, `add` at :14-22, `list` at :23-25)
- Modify: `src/store.mjs:5` (shape comment only)
- Create: `test/tags.test.mjs`

**Interfaces:**
- Consumes: `load()` / `save()` from `src/store.mjs`; `fail(msg)` and `find(store, id)` already in `src/cli.mjs`.
- Produces (in `src/cli.mjs`, module-level consts used by Tasks 2 and 3):
  - `USAGE` = `'usage: notes add <text> [--tag <t>]... | list [--tag <t>] | show <id> | rm <id> | tags'`
  - `isTag(t: string): boolean` — `/^[a-z0-9-]+$/`
  - `parse(argv: string[]): { words: string[], tags: string[] }` — each `--tag` consumes the next argument; a trailing `--tag` → `fail(USAGE)`; any invalid tag → `fail(\`invalid tag: ${t}\`)`.
  - `tagsOf(note): string[]` — `note.tags ?? []`
  - `line(note): string` — `` `${id}  ${text}` `` plus `` ` #${t}` `` per tag
- Produces (in `test/tags.test.mjs`): `notes()` returns `run(...args)` (stdout, trimmed; throws on non-zero exit), with `run.fails(...args) → { status, stdout, stderr }` and `run.file` (the temp `NOTES_FILE` path).

- [ ] **Step 1: Write the failing tests** — create `test/tags.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

function notes() {
  const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json')
  const env = { ...process.env, NOTES_FILE: file }
  const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env }).trim()
  run.fails = (...args) => {
    const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  run.file = file
  return run
}

test('add --tag stores tags and list prints them sorted', () => {
  const run = notes()
  assert.equal(run('add', 'buy', 'milk', '--tag', 'shop', '--tag', 'home'), '1')
  assert.equal(run('list'), '1  buy milk #home #shop')
})

test('untagged notes list exactly as before beside tagged ones', () => {
  const run = notes()
  run('add', 'call', 'mum')
  run('add', 'buy', 'milk', '--tag', 'home')
  run('add', 'read')
  assert.equal(run('list'), '1  call mum\n2  buy milk #home\n3  read')
})

test('--tag may come before the text', () => {
  const run = notes()
  run('add', '--tag', 'home', 'buy', 'milk')
  assert.equal(run('list'), '1  buy milk #home')
})

test('a repeated tag is stored once', () => {
  const run = notes()
  run('add', 'x', '--tag', 'a', '--tag', 'a')
  assert.equal(run('list'), '1  x #a')
})

test('an invalid tag fails, stores nothing, and keeps the next id', () => {
  const run = notes()
  for (const bad of ['Work', 'a_b', '', 'a b', '#a']) {
    const r = run.fails('add', 'x', '--tag', bad)
    assert.equal(r.status, 1)
    assert.match(r.stderr, new RegExp(`invalid tag: ${bad.replace(/[#]/g, '\\$&')}`))
    assert.equal(r.stdout, '')
  }
  assert.equal(run('list'), '')
  assert.equal(run('add', 'ok'), '1')
})

test('add with tags but no text, or a dangling --tag, fails with usage', () => {
  const run = notes()
  for (const args of [['add', '--tag', 'home'], ['add', 'x', '--tag']]) {
    const r = run.fails(...args)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /usage: notes/)
  }
  assert.equal(run('list'), '')
})

test('stored shape: no tags key when untagged, sorted unique array when tagged', () => {
  const run = notes()
  run('add', 'plain')
  run('add', 'x', '--tag', 'b', '--tag', 'a', '--tag', 'b')
  const store = JSON.parse(readFileSync(run.file, 'utf8'))
  assert.deepEqual(store.notes[0], { id: 1, text: 'plain' })
  assert.equal('tags' in store.notes[0], false)
  assert.deepEqual(store.notes[1], { id: 2, text: 'x', tags: ['a', 'b'] })
})
```

`writeFileSync` is imported now for Task 3's old-file test; leave it.

- [ ] **Step 2: Run it and watch it fail** — `npm test` → FAIL: `add buy milk --tag shop --tag home` lists as `1  buy milk --tag shop --tag home`, and the invalid-tag tests exit 0.

- [ ] **Step 3: Write the minimal implementation** — in `src/cli.mjs` replace line 4 (`USAGE`) and add the helpers right after `find` (line 10):

```js
const USAGE = 'usage: notes add <text> [--tag <t>]... | list [--tag <t>] | show <id> | rm <id> | tags'
```

```js
const isTag = (t) => /^[a-z0-9-]+$/.test(t)
const parse = (argv) => {
  const words = []
  const tags = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--tag') words.push(argv[i])
    else if (i + 1 < argv.length) tags.push(argv[++i])
    else fail(USAGE)
  }
  for (const t of tags) if (!isTag(t)) fail(`invalid tag: ${t}`)
  return { words, tags }
}
const tagsOf = (note) => note.tags ?? []
const line = (note) => `${note.id}  ${note.text}` + tagsOf(note).map((t) => ` #${t}`).join('')
```

Replace the `add` and `list` cases:

```js
  case 'add': {
    const { words, tags } = parse(args)
    const text = words.join(' ').trim()
    if (!text) fail(USAGE)
    const note = { id: store.nextId++, text }
    if (tags.length) note.tags = [...new Set(tags)].sort()
    store.notes.push(note)
    save(store)
    console.log(String(note.id))
    break
  }
  case 'list':
    console.log(store.notes.map(line).join('\n'))
    break
```

In `src/store.mjs` line 5, the comment becomes:

```js
/** { nextId, notes: [{ id, text, tags? }] } — an empty store when the file is missing. */
```

- [ ] **Step 4: Run it and watch it pass** — `npm test` → PASS (all of `test/cli.test.mjs` and `test/tags.test.mjs`).

- [ ] **Step 5: Commit** — `feat(note-tags): add --tag and tagged list lines`

### Task 2: `list --tag <t>` filter
App: notes
Phase: 1
Recipe: builder:test-driven-development · tiny

**Files:**
- Modify: `src/cli.mjs` (the `list` case)
- Test: `test/tags.test.mjs` (append)

**Interfaces:**
- Consumes: from Task 1 in `src/cli.mjs` — `USAGE`, `fail(msg)`, `parse(argv) → { words, tags }` (validates tags, fails on a dangling `--tag`), `tagsOf(note)`, `line(note)`. In `test/tags.test.mjs` — `notes()` returning `run(...args)` (trimmed stdout, throws on non-zero) with `run.fails(...args) → { status, stdout, stderr }`.
- Produces: `list` accepts at most one `--tag` and no other arguments.

- [ ] **Step 1: Write the failing tests** — append to `test/tags.test.mjs`:

```js
test('list --tag shows only matching notes in id order', () => {
  const run = notes()
  run('add', 'a', '--tag', 'home')
  run('add', 'b', '--tag', 'work')
  run('add', 'c', '--tag', 'home', '--tag', 'work')
  run('add', 'd')
  assert.equal(run('list', '--tag', 'home'), '1  a #home\n3  c #home #work')
  assert.equal(run('list', '--tag', 'unused'), '')
})

test('list --tag rejects a bad tag, a second tag, stray words and a dangling flag', () => {
  const run = notes()
  run('add', 'a', '--tag', 'home')
  const bad = run.fails('list', '--tag', 'Bad')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /invalid tag: Bad/)
  for (const args of [['list', '--tag', 'a', '--tag', 'b'], ['list', 'home'], ['list', '--tag']]) {
    const r = run.fails(...args)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /usage: notes/)
  }
})
```

- [ ] **Step 2: Run it and watch it fail** — `npm test` → FAIL: `list --tag home` prints every note.

- [ ] **Step 3: Write the minimal implementation** — replace the `list` case in `src/cli.mjs`:

```js
  case 'list': {
    const { words, tags } = parse(args)
    if (words.length || tags.length > 1) fail(USAGE)
    const shown = tags.length ? store.notes.filter((n) => tagsOf(n).includes(tags[0])) : store.notes
    console.log(shown.map(line).join('\n'))
    break
  }
```

- [ ] **Step 4: Run it and watch it pass** — `npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(note-tags): filter list by one tag`

### Task 3: `show` tags line, `notes tags`, old files, README, contract freeze
App: notes
Phase: 2
Recipe: builder:test-driven-development

**Files:**
- Modify: `src/cli.mjs` (the `show` case; a new `tags` case before `default`)
- Modify: `README.md:3` (the command line)
- Modify: `docs/features/note-tags/MANIFEST.md` (`contract:` line)
- Test: `test/tags.test.mjs` (append)

**Interfaces:**
- Consumes: from Task 1 in `src/cli.mjs` — `USAGE`, `fail(msg)`, `find(store, id)`, `tagsOf(note) → string[]` (`note.tags ?? []`, stored sorted). In `test/tags.test.mjs` — `notes()` returning `run(...args)` (trimmed stdout, throws on non-zero) with `run.fails(...args) → { status, stdout, stderr }` and `run.file`; `writeFileSync` is already imported.
- Produces: the finished CLI contract (SPEC §Contract), frozen on the manifest.

- [ ] **Step 1: Write the failing tests** — append to `test/tags.test.mjs`:

```js
test('show prints a tags line only for tagged notes', () => {
  const run = notes()
  run('add', 'buy', 'milk', '--tag', 'shop', '--tag', 'home')
  run('add', 'call', 'mum')
  assert.equal(run('show', '1'), 'buy milk\ntags: home, shop')
  assert.equal(run('show', '2'), 'call mum')
})

test('tags counts notes per tag, sorted by tag', () => {
  const run = notes()
  assert.equal(run.fails('tags').stdout, '')
  run('add', 'plain')
  assert.equal(run.fails('tags').stdout, '')
  run('add', 'a', '--tag', 'shop', '--tag', 'home')
  run('add', 'b', '--tag', 'home', '--tag', 'home')
  assert.equal(run('tags'), 'home  2\nshop  1')
  run('rm', '3')
  assert.equal(run('tags'), 'home  1\nshop  1')
  run('rm', '2')
  assert.equal(run.fails('tags').stdout, '')
})

test('tags with extra arguments fails with usage', () => {
  const run = notes()
  const r = run.fails('tags', 'home')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /usage: notes/)
})

test('a notes file from before tags still works', () => {
  const run = notes()
  writeFileSync(run.file, JSON.stringify({ nextId: 3, notes: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] }))
  assert.equal(run('list'), '1  a\n2  b')
  assert.equal(run('show', '1'), 'a')
  assert.equal(run.fails('tags').stdout, '')
  assert.equal(run('add', 'c', '--tag', 'x'), '3')
  assert.equal(run('list'), '1  a\n2  b\n3  c #x')
})
```

- [ ] **Step 2: Run it and watch it fail** — `npm test` → FAIL: `show 1` prints only `buy milk`; `tags` fails with usage.

- [ ] **Step 3: Write the minimal implementation** — in `src/cli.mjs` replace the `show` case:

```js
  case 'show': {
    const note = find(store, args[0])
    console.log(note.text)
    if (tagsOf(note).length) console.log(`tags: ${tagsOf(note).join(', ')}`)
    break
  }
```

and add before `default:`:

```js
  case 'tags': {
    if (args.length) fail(USAGE)
    const counts = new Map()
    for (const n of store.notes) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) ?? 0) + 1)
    const out = [...counts.keys()].sort().map((t) => `${t}  ${counts.get(t)}`)
    if (out.length) console.log(out.join('\n'))
    break
  }
```

In `README.md` line 3 becomes:

```markdown
A small command-line notes app: `notes add <text> [--tag <t>]...`, `notes list [--tag <t>]`, `notes show <id>`, `notes rm <id>`, `notes tags`.
```

- [ ] **Step 4: Run it and watch it pass** — `npm test` → PASS.

- [ ] **Step 5: Freeze the contract** — in `docs/features/note-tags/MANIFEST.md` set `contract: frozen 2026-10-23` (use the build date).

- [ ] **Step 6: Commit** — `feat(note-tags): show tags and the tags command`
