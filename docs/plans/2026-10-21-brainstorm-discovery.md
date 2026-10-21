# Brainstorm Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/builder:brainstorm` runs a discovery phase (frame → pattern-aware recon → concepts) in front of its decision tree when the input is an abstract idea, so a vague idea is explored before it is decided.

**Architecture:** This is a plugin made of instructions. The change is new and amended prose in `skills/brainstorm/SKILL.md` and `skills/brainstorm/CONVERSATION.md` (the conversation machinery), a reading rule in `skills/spec/SKILL.md`, the listings (help, README), and the release metadata. The record's header does not change, so `scripts/brainstorm-file.mjs` and everything that reads records keeps working; a new `## Discovery` body section is added between `## Intent` and `## How it works today`. Tests are the existing `node --test` suites plus two small assertions that pin the cross-file contract.

**Tech Stack:** Markdown skill files; Node's `node:test` for the two pinning tests; `claude plugin validate .`.

**Spec:** `docs/specs/2026-10-21-brainstorm-discovery-design.md`

## Global Constraints

- The record header (`# <feature> — brainstorm` through the first blank line: `status:`, `source:`, `input:`, `ticket:`, `updated:`, `settled:`, `contradicted:`) keeps its exact shape; `## Discovery` is a body section only.
- Discovery runs for an input classified **abstract idea**, for any input on "let's explore" / "explore this", and never for a revision conversation (a live SPEC); "skip discovery" / "just build it" leaves it. No new flag.
- **No AskUserQuestion inside discovery.** The frame's questions are open, in chat, one per turn, four at most; the exit is the user naming the concept, confirmed in two lines.
- Concepts are two to four, each naming the existing patterns it is built from.
- Under `--auto`: frame `assumed`, recon runs, concepts written, the recommended concept taken with `auto (recommended) YYYY-MM-DD`; no extra turns.
- Release is a **patch, 4.11.1**; `.claude-plugin/plugin.json` and the top `CHANGELOG.md` heading must agree (the skills-consistency test checks this).
- Write in the skills' existing voice: terse, bold for rules, 🔴 for rules that must never be broken, `§` for sections, "the user" not "you" in CONVERSATION.md.

## Review Focus

1. An abstract idea whose input already answers two of the four frame questions: those two must be stated as assumed, not asked. → Task 2's text says so; Task 5 checks it in the real conversation.
2. The user names a concept that is a combination ("the chips from A with B's panel"): the agent must write the combination as a new concept and confirm that, not force a pick. → Task 2 §Concepts text; Task 5 checks it.
3. `--auto` on an abstract idea must not add a turn or an AskUserQuestion; the benchmark's builder rows are the proof. → Task 4's benchmark run.
4. A record with a `## Discovery` body must still parse; `status:` lines inside the body must not be mistaken for the header. → Task 1's brainstorm-file test.
5. A directed request must not enter discovery, and "let's explore" must. → Task 2's fork text; Task 5 checks the directed case with a one-line request.

---

### Task 1: CONVERSATION.md — the record's §Discovery, the recon brief, the steering and --auto rulings

**Files:**
- Modify: `skills/brainstorm/CONVERSATION.md` (the record block in §The record; a new §Discovery recon after §Grounding; §Steering and --auto)
- Modify: `scripts/test/brainstorm-file.test.mjs` (one new test)
- Modify: `scripts/test/skills-consistency.test.mjs` (one new test)

**Interfaces:**
- Produces: the record's `## Discovery` body section (its exact lines below), referenced by Task 2's SKILL.md text and Task 3's spec text as "the record's §Discovery"; the section name `## Discovery recon` in CONVERSATION.md, which Task 2 refers to as "CONVERSATION §Discovery recon".

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/brainstorm-file.test.mjs` (it has a `ws(files)` helper that writes the given files into a temp root and returns the root, and imports `readBrainstormHeader` and `BRAINSTORM_FILE`):

```js
test('a record with a Discovery body still reads its header; a status-like line in Discovery is ignored', () => {
  const body = [
    '# tags — brainstorm',
    'status: exploring',
    'source: brainstorm',
    'input: abstract idea',
    'updated: 2026-10-21T10:00:00Z',
    'settled: 0 of 6',
    '',
    '## Intent',
    'Outcome: tags on notes (assumed)',
    '',
    '## Discovery',
    'Frame: for the person using the notes CLI · pain/outcome: finding notes by topic · today: by eye · better: filter by tag (assumed)',
    'What the product already has: a list command with no filters[^1]',
    'Concepts:',
    '- Tag chips — tags shown inline and filterable · built from: the list line format · standing: chosen',
    '- Folders — a notebook per topic · built from: nothing existing · standing: rejected (heavier than the pain)',
    'Concept: tag chips — notes carry tags, list filters by one. status: parked',
    '',
    '## How it works today',
    'status: sized xl',
    '',
  ].join('\n')
  const root = ws({ [`.builder/tags/${BRAINSTORM_FILE}`]: body })
  const h = readBrainstormHeader(join(root, '.builder/tags/brainstorm.md'))
  assert.equal(h.status, 'exploring')
  assert.equal(h.size, null)
  assert.equal(h.input, 'abstract idea')
})
```

Append to `scripts/test/skills-consistency.test.mjs` (use its existing `read(path)` helper):

```js
test('brainstorm discovery: the record, the skill, spec and the listings agree on the Discovery section', () => {
  const conv = read('skills/brainstorm/CONVERSATION.md')
  const skill = read('skills/brainstorm/SKILL.md')
  // The record template carries the section between Intent and How it works today.
  const rec = /## Intent[\s\S]*?## Discovery[\s\S]*?## How it works today/.exec(conv)
  assert.ok(rec, 'CONVERSATION §The record lacks ## Discovery between Intent and How it works today')
  assert.match(rec[0], /Concept: </)
  assert.match(conv, /^## Discovery recon$/m)
  assert.match(conv, /let's explore/)
  assert.match(conv, /skip discovery/)
  assert.match(skill, /^## Discovery$/m)
  assert.match(skill, /CONVERSATION §Discovery recon/)
  assert.match(skill, /No AskUserQuestion in discovery/)
  assert.match(read('skills/spec/SKILL.md'), /§Discovery/)
  for (const f of ['skills/help/SKILL.md', 'README.md']) assert.match(read(f), /explore/i, f)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/test/brainstorm-file.test.mjs scripts/test/skills-consistency.test.mjs`
Expected: the brainstorm-file test PASSES already (the header parser is unchanged; it stays as the regression pin), the consistency test FAILS on the first assertion (no `## Discovery` in the record template).

- [ ] **Step 3: Add §Discovery to the record template**

In `skills/brainstorm/CONVERSATION.md` §The record, the fenced record template currently has `## Intent` (three lines) followed by a blank line and `## How it works today`. Insert between them:

```markdown
## Discovery
Frame: for <who> · pain/outcome: <what is hard, slow, missing — or what becomes possible> · today: <how it is handled now> · better: <what the user would notice>   — each "(assumed)" until the user confirms it
What the product already has: <plain prose — the capabilities near the idea, the components, layouts and UX patterns in use with where each is used, prior art, constraints; file:line only as footnotes>
Concepts:
- <name> — <what the user would experience, one line> · built from: <the existing patterns, named> · standing: chosen | open | rejected (<why>)
Concept: <the chosen one — two lines: what it is, and the patterns it uses>
```

Directly after the closing fence of the template, add this paragraph:

```markdown
§Discovery exists only when discovery ran (an abstract idea, or the user asked to explore); a
directed request or a brief has no §Discovery section. The header above it never changes shape —
scripts read only the header.
```

- [ ] **Step 4: Add §Discovery recon after §Grounding**

After the last paragraph of `## Grounding` (the 🔴 self-check paragraph) and before `## Rounds`, insert:

```markdown
## Discovery recon

When discovery runs (SKILL §Discovery), the Explore agents that start on the first turn — `sonnet`,
one per app the idea plausibly touches — are briefed to find what concepts can be built from, not
only how the touched code works. Each agent reports, in plain words with `file:line` as footnotes:

1. **What the product already has near the idea** — the capabilities, screens, data and flows the
   idea neighbours or overlaps, and what must not be rebuilt.
2. **The design system and UX patterns in use** — the components, layouts, navigation and
   interaction conventions, and the empty, loading and error states, each named with where it is
   used ("filter chips: the certificate list, the owner view"). When the config's `design:` block is
   configured, its `contracts` directory is read as well.
3. **Prior art** — the registry's `_archive/` specs, `NOTES.md` files and `.builder/*/brainstorm.md`
   records that touch the idea, and `git log -S <term> --oneline | head` for the idea's terms.
4. **Constraints** — that app's §House rules, apps marked `released_artifact: true`, and the
   permissions in the area.

The findings go under the record's §Discovery · *What the product already has*. They are the
material the concepts are built from, and *How it works today* then covers only what discovery did
not. Recon never holds up a turn: the frame goes on while it runs; the concepts step waits for it.
```

- [ ] **Step 5: Add the discovery steering words and the --auto ruling**

In `## Steering and --auto`, the first paragraph ends with `(jump to §Confirm, listing what is still open as assumed).` Replace that paragraph with:

```markdown
**The user steers at any time**: "go deeper on X" (open sub-branches under X), "skip that, use your
recs" (settle every open branch on its recommendation, recorded as the user's ruling), "that's enough"
(jump to §Confirm, listing what is still open as assumed — or, inside discovery, converge on the
recommended concept, stated as such), **"let's explore" / "explore this"** (enter SKILL §Discovery for
any input, or return to its concepts step), **"skip discovery" / "just build it"** (leave discovery
for the tree, the concept taken as the one the input implies). Each steer is recorded under
*Steering* in the record with the user as Who.
```

In the `**Under `--auto`**` paragraph, after `play the intent back as `(assumed)`;` insert:

```
when discovery runs, the frame is written as `(assumed)` from the input, recon runs, the concepts
are written to §Discovery, and the recommended concept is taken — `Concept:` carries it with
`auto (recommended) YYYY-MM-DD`;
```

so the paragraph reads `play the intent back as `(assumed)`; when discovery runs, … `auto (recommended) YYYY-MM-DD`; every question settles on its recommendation …`.

- [ ] **Step 6: Run the two tests**

Run: `node --test scripts/test/brainstorm-file.test.mjs scripts/test/skills-consistency.test.mjs`
Expected: the brainstorm-file test passes; the consistency test now fails on `skills/brainstorm/SKILL.md` lacking `## Discovery` (Task 2's job). That is the expected state at the end of this task.

- [ ] **Step 7: Commit**

```bash
git add skills/brainstorm/CONVERSATION.md scripts/test/brainstorm-file.test.mjs scripts/test/skills-consistency.test.mjs
git commit -m "feat(brainstorm): the record's §Discovery, the discovery recon brief, the steering words and the --auto ruling"
```

---

### Task 2: SKILL.md — the fork after the intent, the §Discovery section, the tree seeded from the concept

**Files:**
- Modify: `skills/brainstorm/SKILL.md` (`description:`; §Intent steps 5–6; a new §Discovery between §Intent and §How it works today; §How it works today's first paragraph; §Rounds' first paragraph)

**Interfaces:**
- Consumes: CONVERSATION §Discovery recon, the record's §Discovery (Task 1).
- Produces: the section heading `## Discovery` in SKILL.md and the sentence `No AskUserQuestion in discovery` (both pinned by Task 1's consistency test).

- [ ] **Step 1: The description**

In the frontmatter `description:`, replace the clause `explains how the code works today in plain words, then asks only what is still open, one question at a time` with:

```
explores a vague idea before deciding anything — frames the problem in open questions, finds the design system, UX patterns and prior art the product already has, and proposes two to four concepts built from them until you name one; explains how the code works today in plain words, then asks only what is still open, one question at a time
```

- [ ] **Step 2: The fork after the intent**

In `## Intent — the first turn`, step 5 currently reads:

```
5. **Recon of the wider area carries on in parallel** (Explore agents, `sonnet`, one per app the
   idea plausibly touches) — how the neighbouring parts work, for *How it works today*. It never holds
   up this turn.
```

Replace it with steps 5 and 6:

```
5. **Recon of the wider area carries on in parallel** (Explore agents, `sonnet`, one per app the
   idea plausibly touches) — how the neighbouring parts work, for *How it works today*; for an
   abstract idea, the wider brief of CONVERSATION §Discovery recon. It never holds up this turn.
6. **Where it goes next.** An **abstract idea** → §Discovery, then §How it works today. A **directed
   request** or a **brief** → §How it works today, then §Rounds. The user overrides either in words
   at any point — "let's explore" enters discovery for any input; "skip discovery" / "just build it"
   leaves it (CONVERSATION §Steering and --auto). A revision conversation never enters discovery.
```

- [ ] **Step 3: The §Discovery section**

Insert a new section between the paragraph `Write the record (`status: exploring`, `source: brainstorm`). The intent stays `(assumed)` until the user confirms or corrects it.` and `## How it works today`:

```markdown
## Discovery

For a vague idea, the decision tree is the wrong first move: it asks the user to choose before they
know what they want. Discovery comes first — a frame, recon aimed at what the product already has,
and concepts built from it — and ends when the user names the concept. The record's §Discovery
(CONVERSATION §The record) is rewritten after every turn.

### The frame

Open questions, in plain chat, **one per turn — no AskUserQuestion, no option list, no
recommendation.** In this order, each one skipped when the input or an earlier answer already
answers it (then stated as `assumed`, with what it was taken from):

1. **Who it is for** — the people or roles, and what they are doing when they meet it.
2. **The pain or the outcome** — what is hard, slow, missing or wrong today, or what becomes possible.
3. **How it is handled today** — by the product, by a workaround, or not at all.
4. **What better looks like** — what the user would notice, and how they would know it worked.

- **Grounding holds** (CONVERSATION §Grounding): a term in the user's words is looked up before it is
  asked about. The frame asks about intent and judgement, never about a fact the code holds.
- **Reflect, then follow.** After every answer, play the frame back in a few lines — what the user
  said kept apart from what you assume — and follow where they went, a tangent included. Never pull
  them back to the next scripted question while they are mid-thought.
- **Four is the ceiling**; the user ends it sooner with "that's the problem" or similar.

### Concepts

When the frame is played back and recon (CONVERSATION §Discovery recon) is in, propose **two to four
concepts** in chat. Each:

- a short name
- what the user would experience, as a paragraph, from their point of view
- **the existing patterns it is built from, named** — "the filter chips the certificate list uses",
  "a side panel like the owner view" — and anything it needs that the product does not have
- what it is good at, and what it closes off
- a rough feel for size (a day, a week, a program) — never a sized estimate

The user may pick one; combine two (write the combination as a new concept); ask "what if …"
(answer in the concept's terms and revise it); ask for one sketched deeper (a flow in prose, or an
ASCII layout or mermaid diagram when parts move); add their own; or say none fit, which reopens the
frame with what was learned. Every turn rewrites §Discovery · *Concepts* with each concept's
standing and why.

🔴 **No AskUserQuestion in discovery.** The exit is the user naming the concept, in their words;
confirm it in two lines — "**Concept:** <name> — <what it is, one sentence>. <The patterns it uses.>
Right?" — and a yes ends discovery. "That's enough" converges on your recommended concept, stated
as such. Under `--auto`, CONVERSATION §Steering and --auto takes the recommended concept without a
turn.

### After discovery

The chosen concept seeds the tree: each choice it embodies becomes a `settled` branch with its Why
and the user as Who; the other concepts go to *Rejected* with the reason each lost; the concept's
open questions become the first `open` branches. §How it works today then covers only what
discovery did not, and §Rounds runs unchanged. §Confirm's playback opens with the concept.
```

- [ ] **Step 4: Two one-line touches**

In `## How it works today`, the first paragraph begins `Once the intent is confirmed (under `--auto`, once it is played back), explain what recon found`. Insert before it, as its own line:

```
After discovery, only what §Discovery · *What the product already has* did not cover.
```

In `## Rounds`, the first line `CONVERSATION §Rounds — one question at a time — until the frontier is empty. Where the branches come from:` becomes:

```
CONVERSATION §Rounds — one question at a time — until the frontier is empty. After discovery the
tree starts seeded from the concept (§Discovery · After discovery). Where the branches come from:
```

- [ ] **Step 5: Run the consistency test**

Run: `node --test scripts/test/skills-consistency.test.mjs`
Expected: the new test now fails only on `skills/spec/SKILL.md` lacking `§Discovery` (Task 3) — or passes if the listings already contain "explore" (they do: "explores an idea"); read the failure and confirm it is the spec assertion.

- [ ] **Step 6: Read the skill end to end**

Read `skills/brainstorm/SKILL.md` top to bottom once, as the agent that will run it: the intent turn forks cleanly, discovery's three subsections read in order, nothing refers to a section that does not exist, and `## Every pause` still follows `## Size`.

- [ ] **Step 7: Commit**

```bash
git add skills/brainstorm/SKILL.md
git commit -m "feat(brainstorm): discovery before the tree — frame, concepts from the product's own patterns, the concept seeds the rounds"
```

---

### Task 3: spec reads §Discovery; the listings; the release

**Files:**
- Modify: `skills/spec/SKILL.md` (§2 Write the files)
- Modify: `skills/help/SKILL.md` (the intro paragraph and the brainstorm row)
- Modify: `README.md` (the "Start with a conversation" paragraph)
- Modify: `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json` (`version`)

- [ ] **Step 1: spec reads §Discovery into §Idea**

In `skills/spec/SKILL.md` `## 2. Write the files`, after the sentence `**§Idea, §Apps and §Contract are never skipped**; lg writes them all.` insert:

```
When the record has a §Discovery section, §Idea is written from it: the frame's *for whom* and
*pain/outcome* become the why, *better* becomes what success looks like, `Concept:` is the concept,
and the rejected concepts join the approaches considered with the reason each lost (an `auto
(recommended)` ruling stays exactly that). Without §Discovery, §Idea comes from §Intent as before.
```

- [ ] **Step 2: The listings**

`skills/help/SKILL.md` — the intro paragraph's clause `explores an idea with you — your intent played back, how the code works today, questions in rounds, approaches — and` becomes:

```
explores an idea with you — a vague idea framed and explored as concepts built from what the product already has, your intent played back, how the code works today, questions in rounds, approaches — and
```

The brainstorm row `| **An idea, a request, or something to think through** | `/builder:brainstorm <what you want>` — plays back your intent, explains how the code works today, asks in rounds, confirms, then sizes it: xs/sm built in chat, md+ on to `/builder:spec`. The normal way in |` becomes:

```
| **An idea, a request, or something to think through** | `/builder:brainstorm <what you want>` — a vague idea is explored first (the problem framed, concepts proposed from the product's own patterns, until you name one), then it plays back your intent, explains how the code works today, asks in rounds, confirms, then sizes it: xs/sm built in chat, md+ on to `/builder:spec`. The normal way in |
```

`README.md` — the same intro clause as help's (`explores an idea with you — your intent played back, how the code works today, questions in rounds, approaches — and`) gets the same replacement.

- [ ] **Step 3: Changelog and version**

`CHANGELOG.md` — insert before `## 4.11.0`:

```markdown
## 4.11.1

**Changed:**
- **`/builder:brainstorm` explores before it decides.** A vague idea now enters a discovery phase in
  front of the decision tree: the problem is framed in open questions (who, pain or outcome, how it
  is handled today, what better looks like — one per turn, no option lists), recon finds the design
  system, UX patterns and prior art the product already has, and two to four concepts built from
  those patterns are proposed and explored in plain conversation until the user names one. The
  concept then seeds the rounds, which run as before. A directed request or brief is unaffected;
  "let's explore" opens discovery for any input, "skip discovery" leaves it. `--auto` takes the
  recommended concept with no extra turn, so `/builder:agent`, the fleet and the benchmark are
  unchanged. Design: `docs/specs/2026-10-21-brainstorm-discovery-design.md`.
```

`.claude-plugin/plugin.json`: `"version": "4.11.1"`.

- [ ] **Step 4: Validate and run the suite**

Run: `claude plugin validate . && node --test 'scripts/test/*.test.mjs'`
Expected: validation passes (the pre-existing CLAUDE.md warning is fine); every test green except the two known timing flakes in `fleet.test.mjs` ("a run that keeps talking outlives the idle timeout") and `job.test.mjs` ("wait gives up after --max"), which fail on main too.

- [ ] **Step 5: Commit**

```bash
git add skills/spec/SKILL.md skills/help/SKILL.md README.md CHANGELOG.md .claude-plugin/plugin.json
git commit -m "feat(brainstorm): spec writes §Idea from §Discovery; listings; 4.11.1"
```

---

### Task 4: The cost, measured — the benchmark before and after

**Files:** none new; `bench/results/<run-id>/REPORT.md` + `runs.json` get committed.

- [ ] **Step 1: Run builder at one profile on the new brainstorm**

Run: `node scripts/bench.mjs run tags --only builder-rush --detach`, then `node scripts/bench.mjs status` until it finishes (about 15 minutes).

- [ ] **Step 2: Compare the brainstorm step**

The baseline is `bench/results/2026-10-14-0136-tags/runs.json` (brainstorm session: 135 s, 12 turns; its steps `/builder:brainstorm` 54 s and `builder:spec` 78 s). In the new run's `runs.json`, read the builder-rush row's brainstorm session: its `totals.ms`, `totals.turns`, `totals.tokens`, and whether the record under the copy (`<copy>/.builder/<feature>/brainstorm.md`, the copy path is in the row) has a `## Discovery` section with two to four concepts and a `Concept:` line marked `auto (recommended)`. Expected: the brainstorm step costs more (the frame and concepts are written) but adds no turn waiting on input, the session ends with `ended: result`, and the row is `done` with 7/7.

- [ ] **Step 3: Record it**

Commit the run's `REPORT.md` and `runs.json`:

```bash
git add bench/results/
git commit -m "bench: builder-rush on tags with discovery in brainstorm (4.11.1) — brainstorm step before/after"
```

Note the before/after brainstorm numbers in the CHANGELOG entry's last sentence (one line: "Measured on the benchmark: brainstorm <before> → <after>, no extra turns.") and amend the Task 3 commit or add a `docs` commit.

---

### Task 5: The behaviour, read — one real conversation

**Files:** none.

- [ ] **Step 1: A vague idea in a repo with a design system**

In a consumer repo on this machine that has a real UI and `.claude/builder.md` (d2m or makeready; the memory says personal projects use the global builder, so load this checkout for the session with `--plugin-dir /Users/lukekeith/www/builder` and disable the user-scope builder via a settings file with `enabledPlugins: { "builder@claude-builder": false }`, the way the benchmark does), start `/builder:brainstorm` with a one-line vague idea, for example "I want people to find things faster".

Check, turn by turn:

1. The first turn plays the intent back and asks the frame's first open question, in chat, with no option list and no AskUserQuestion.
2. Any frame question the idea already answered is stated as assumed, not asked.
3. After at most four frame turns, two to four concepts are proposed, each naming real components or patterns from that repo by name, with what each is good at and closes off.
4. Say "combine the first two": the agent writes the combination as a new concept and asks whether that is it, in two lines, still with no AskUserQuestion.
5. Say yes: the tree starts seeded from the concept (the first round's question is one the concept left open), and the record under `.builder/<feature>/brainstorm.md` has a filled §Discovery.
6. Stop there ("park it"), so nothing is built in that repo.

- [ ] **Step 2: A directed request does not enter discovery**

In the same repo: `/builder:brainstorm add a --json flag to the export command`. Expected: no frame, no concepts; the intent playback is followed by how it works today and the first round, as before. Then "let's explore": discovery opens. Park it.

- [ ] **Step 3: Fix what the reading found**

Anything the conversation showed the text does not say clearly goes back into SKILL.md or CONVERSATION.md as a wording fix, committed as `fix(brainstorm): …`, and the consistency test is run again.

- [ ] **Step 4: Release**

Follow `RELEASING.md`: merge the branch into `main`, `claude plugin validate .`, then `claude plugin tag --push -m "builder %s"` and `git push origin main` (the tag command pushes only the tag).
