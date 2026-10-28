# PLAN.md — the format

Adapted from superpowers' `writing-plans`, as of 7.0.0 (MIT — see
[LICENSE-THIRD-PARTY.md](../../LICENSE-THIRD-PARTY.md)). `builder:plan` derives the phases; this
file is the shape it writes them in, and the rules that keep the result executable.

**Contents:** §File structure, before tasks · §Task right-sizing · §Bite-sized steps · §The header · §Task structure · §No placeholders · §Self-review

**Write the plan for an engineer who has not seen this codebase or this spec.** Assume they write
idiomatic code once they know the exact interface and the exact test, and that they make a reasonable
choice wherever the plan leaves one open. What they cannot know is what you decided: which files,
which names and signatures, which values from the spec, which tests prove each task. Document those.
DRY. YAGNI. TDD. Frequent commits.

That is literally true here. Each task is executed by a **fresh subagent that sees only its own task
block plus its brief**. It cannot read the rest of the plan, it has never seen this repo, and it will
not ask you what you meant unless you left it no choice.

**A step is unambiguous, not complete.** It is done when the implementer can write exactly one
reasonable thing from it. A task is six parts (Files, Interfaces, Behaviour, Pattern, Tests, Steps),
all in words except the tests:

- **Tests keep their assertions, as code,** with the spec's exact values in them. The plan writer pins
  what each test checks; the implementer does not decide it. A stronger test is the point.
  `plan-slices.mjs` counts a slice's tests from the `it(` / `test(` lines inside the fences for the
  go-ahead.
- **Everything else is words:** files with their one responsibility, interfaces (exact names in backticks,
  parameters and return types described), behaviour rules citing their decision, a pattern as `file:line`, steps with
  their commands. **The implementer writes the body.**
- **The only other code is exact copy the spec fixes** (a message, a migration, a config value).
- **A reference to another task:** that task's **Interfaces** block says what to use; the plan does
  not repeat that task's code.

---

## File structure, before tasks

Before defining tasks, map which files each phase creates or modifies and what each is responsible
for. This is where decomposition gets locked in.

- Design units with clear boundaries and well-defined interfaces; one clear responsibility per file.
- You reason best about code you can hold in context at once, and edits are more reliable when files
  are focused. Prefer smaller, focused files.
- Files that change together live together. Split by responsibility, not by technical layer.
- Follow the codebase's established patterns. If it uses large files, don't unilaterally
  restructure — but if a file you're modifying has grown unwieldy, planning a split is reasonable.

## Task right-sizing

A task is **the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate**.
Fold setup, configuration, scaffolding and documentation into the task whose deliverable needs them;
split only where a reviewer could meaningfully reject one task while approving its neighbour. Each
task ends with an independently testable deliverable.

🔴 **And a task touches exactly one app.** A task whose Files cross two of the config's apps is two
tasks, in two phases — the verifier waits on one app per phase, and a phase touching two apps makes
its wait cover neither cleanly: one app's tests say nothing about the other's.

## Bite-sized steps

🔴 **The cycle these steps follow is
[`test-driven-development`](../test-driven-development/SKILL.md)** — read it before writing a task's
steps. The order below is not a house style; it is that skill's red-green loop, and the "run it and
watch it fail" step is the one that makes the test worth having. A task whose steps write code
before a failing test is a plan defect, and the implementer is told to report it rather than follow
it.

Each step is ONE action, two to five minutes:

- "Write the failing test" — step
- "Run it and watch it fail" — step
- "Write the minimal code to pass" — step
- "Run the tests and watch them pass" — step
- "Commit" — step

## The header

Every plan starts with this, filled in:

```markdown
# <Feature> — implementation plan

> **For agentic workers:** this plan is executed by `/builder:build`, one task at a time, with a
> fresh implementer per task, tested and reviewed as the go-ahead's test plan sets. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one sentence describing what this builds>

**Architecture:** <2-3 sentences on the approach>

**Tech Stack:** <the key technologies this feature touches, per app>

**Spec:** <path to SPEC.md — the plan argues from the spec, so the spec travels with it; the
executor reads both>

## Global Constraints

<The project config's §Global constraints, copied VERBATIM with <TICKET> replaced. Every task's
requirements implicitly include this section. Do not re-wrap the bullets.>

## Phases

| Phase | App | Tasks | Goal |
|---|---|---|---|
| 1 | <app> | 1–3 | <what exists at the end of this phase that didn't before> |

---
```

**The `## Phases` table is this format's one addition to the original**, and it is load-bearing: it
is the whole phase view and the membership source for what a phase closes on — the build's, not the
human's: at the go-ahead the human sees slices, one per `### Task N`, which `plan-slices.mjs` prints
from this file with the test cases each block's fences carry. `App` names ONE app. `Tasks` is the
task-number range.

## Task structure

````markdown
### Task N: <name>
App: <app>
Phase: <n>
Recipe: <the companion skill to read FIRST, or the REFERENCE section that governs this work; append ` · tiny` for a one-file edit with its test, so the build reviews it at the cheapest tier>

**Files:**
- Create: `exact/path/to/file.ts` — <its one responsibility>
- Modify: `exact/path/to/existing.ts:123-145` — <what changes in it>
- Test: `tests/exact/path/to/test.ts` — <what it covers>

**Interfaces:**
- Consumes: <what this task uses from earlier tasks — each name in backticks, its parameters and
  return type in words>
- Produces: `parseTags` — takes the raw tag string, returns the list of normalised tags. <Names in
  backticks, types in words, no code. A task's implementer sees only their own block; this is how they
  learn the names neighbouring tasks use, and the scan pairs names by their backticks.>

**Behaviour:**
- <one rule per line, each citing the decision behind it> (D<n>)
- both assignees set → 422 (D6)

**Pattern:** (optional)
- `path/to/similar.ts:40` — <what to follow>

**Tests:**
- `test name` — <what it proves> (Behaviour line it covers)

```ts
it('test name', () => {
  expect(fn(input)).toEqual(expected)
})
```

- [ ] **Step 1: Write the listed tests** — in `tests/exact/path/to/test.ts`
- [ ] **Step 2: Run `<command>`, watch them fail** — FAIL, "fn is not defined"
- [ ] **Step 3: Implement `fn` in `exact/path/to/file.ts` to the Behaviour**
- [ ] **Step 4: Run `<command>`, watch them pass** — PASS
- [ ] **Step 5: Commit** — `feat(<TICKET>): <subject>`
````

Every Tests line is followed by its own fenced assertions (shown once above; repeat per test).
Behaviour is one rule per line; each cites its spec decision, and a Test covers each.

**Task numbering runs across the whole plan** — Task 1 … Task N continue through every phase, because
`task-brief` keys on the literal `Task N` heading.

🔴 **Nothing sits between task blocks, and nothing after the last one** — no `## Phase N` heading, no
prose, no separator, no closing notes. `task-brief` extracts a task by taking everything from its
`### Task N` heading to the next `Task <n>` heading at any level, or — for the last task — **to the
end of the file** (headings inside fences are skipped). Anything parked between two blocks is handed
to the earlier task's implementer; anything below the final block is handed to the last one. Phases
live in the `## Phases` table and on each task's `Phase:` line. A heading written only as an example
goes inside a fence.

## No placeholders

Every step decides something, and no step transcribes. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" — without the test's name and assertions
- "Similar to Task N" — name the Interfaces entry you mean; the implementer never sees Task N
- a step that names neither the file nor the Interfaces names it implements
- references to types, functions or methods not defined in any task
- a Behaviour line with no decision it comes from
- a Test line that doesn't say what it proves
- a code block in a task other than test assertions or exact spec copy
- a Pattern entry with code pasted instead of `file:line`
- an Interfaces name not in backticks

The opposite failure is a function body the signature and tests already determine: that is the
plan writing the code instead.

## Self-review

After writing the plan, read the SPEC with fresh eyes and check the plan against it. This is a
checklist you run yourself — not a subagent dispatch.

1. **Spec coverage.** Skim each SPEC section. Can you point to a task that implements it? List gaps.
2. **Step scan.** Each step lets the implementer write exactly one reasonable thing, and carries no
   more: a line that decides nothing is a gap (the red flags above); a body the signature and tests
   already determine is a transcript. Fix both.
3. **Behaviour coverage.** Check every Behaviour line has a Test that would fail without it.
4. **Type consistency.** Do the types, signatures and property names in later tasks match what
   earlier tasks defined? A function called `clearLayers()` in Task 3 and `clearFullLayers()` in
   Task 7 is a bug.
5. **One app per task.** No task block's Files cross an app boundary; every block has an `App:` line
   that matches its phase's row.
6. **One app per phase.** Every `## Phases` row names one app, and every task in it is that app's.
7. **Proportion.** Compare the plan's length to the SPEC's. A plan several times longer than its spec
   is a transcript of the program. The plan is words plus test assertions: if code blocks
   beyond the tests are most of the document, replace them with words, and re-check each step is
   still unambiguous. A guide, not a hard limit.

Fix what you find inline. No need to re-review — fix and move on. A SPEC requirement with no task
gets a task.
