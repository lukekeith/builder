# PLAN.md — the format

Adapted from superpowers' `writing-plans` (MIT — see
[LICENSE-THIRD-PARTY.md](../../LICENSE-THIRD-PARTY.md)). `builder:plan` derives the phases; this
file is the shape it writes them in, and the rules that keep the result executable.

**Write the plan assuming the engineer has zero context for this codebase and questionable taste.**
Document everything they need: which files to touch, the code, the tests, the command to run, how to
tell it worked. Assume a skilled developer who knows almost nothing about this toolset or problem
domain, and who does not know good test design well. DRY. YAGNI. TDD. Frequent commits.

That assumption is not pessimism — it is literally true here. Each task is executed by a **fresh
subagent that sees only its own task block plus its brief**. It cannot read the rest of the plan, it
has never seen this repo, and it will not ask you what you meant unless you left it no choice.

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
tasks, in two phases — a phase's gates are one app's commands, so a task that straddles apps cannot
be gated.

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
> fresh implementer and a review per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one sentence describing what this builds>

**Architecture:** <2-3 sentences on the approach>

**Tech Stack:** <the key technologies this feature touches, per app>

**Spec:** <path to SPEC.md — the plan argues from the spec, so the spec travels with it; the
executor reads both>

## Global Constraints

<The project config's §Global constraints, copied VERBATIM with <TICKET> replaced. Every task's
requirements implicitly include this section. Do not re-wrap the bullets.>

## Phases

| Phase | App | Tasks | Goal | Gates |
|---|---|---|---|---|
| 1 | <app> | 1–3 | <what exists at the end of this phase that didn't before> | <that app's fast gates> |

---
```

**The `## Phases` table is this format's one addition to the original**, and it is load-bearing: it
is the whole phase view, the thing the human approves at the go-ahead, and the membership source for
what a phase closes on. `App` names ONE app. `Tasks` is the task-number range. `Gates` is that app's
fast set — never another app's, never the deep set.

## Task structure

````markdown
### Task N: <name>
App: <app>
Phase: <n>
Recipe: <the companion skill to read FIRST, or the REFERENCE section that governs this work>

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`
- Test: `tests/exact/path/to/test.ts`

**Interfaces:**
- Consumes: <what this task uses from earlier tasks — exact signatures>
- Produces: <what later tasks rely on — exact names, parameter and return types. A task's
  implementer sees only their own block; this is how they learn the names neighbouring tasks use.>

- [ ] **Step 1: Write the failing test**

```ts
it('does the specific thing', () => {
  expect(fn(input)).toEqual(expected)
})
```

- [ ] **Step 2: Run it and watch it fail** — `<command>` → FAIL, "fn is not defined"

- [ ] **Step 3: Write the minimal implementation**

```ts
export const fn = (input: In): Out => expected
```

- [ ] **Step 4: Run it and watch it pass** — `<command>` → PASS

- [ ] **Step 5: Commit** — `feat(<TICKET>): <subject>`
````

**Task numbering runs across the whole plan** — Task 1 … Task N continue through every phase, because
`task-brief` keys on the literal `Task N` heading.

🔴 **Nothing sits between task blocks, and nothing after the last one** — no `## Phase N` heading, no
prose, no separator, no closing notes. `task-brief` extracts a task by taking everything from its
`### Task N` heading to the next `Task <n>` heading at any level, or — for the last task — **to the
end of the file** (headings inside fences are skipped). Anything parked between two blocks is handed
to the earlier task's implementer; anything below the final block is handed to the last one. Phases
live in the `## Phases` table and on each task's `Phase:` line. A heading written only as an example
goes inside a fence.

**No line budget.** `PLAN.md` carries code and is deleted at sign-off, so its length taxes only the
go-ahead read.

## No placeholders

Every step contains the actual content an engineer needs. These are **plan failures** — never write
them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" — without the actual test code
- "Similar to Task N" — repeat the code; the implementer never sees Task N
- steps describing what to do without showing how (code blocks are required for code steps)
- references to types, functions or methods not defined in any task

## Self-review

After writing the plan, read the SPEC with fresh eyes and check the plan against it. This is a
checklist you run yourself — not a subagent dispatch.

1. **Spec coverage.** Skim each SPEC section. Can you point to a task that implements it? List gaps.
2. **Placeholder scan.** Search for every red flag above. Fix them.
3. **Type consistency.** Do the types, signatures and property names in later tasks match what
   earlier tasks defined? A function called `clearLayers()` in Task 3 and `clearFullLayers()` in
   Task 7 is a bug.
4. **One app per task.** No task block's Files cross an app boundary; every block has an `App:` line
   that matches its phase's row.
5. **Gates are the right app's.** Every `## Phases` row's Gates cell is that row's app's fast set.

Fix what you find inline. No need to re-review — fix and move on. A SPEC requirement with no task
gets a task.
