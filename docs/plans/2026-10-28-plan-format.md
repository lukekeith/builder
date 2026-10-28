# PLAN.md carries decisions, not bodies — implementation plan

> Executed by one implementer, reviewed once. Written in the format it introduces.

**Goal:** `/builder:plan` writes plans whose steps are unambiguous, not complete — test code, signatures, files and spec values kept; bodies left to the implementer.

**Architecture:** Prose and prompt edits to the plan format, the plan skill, the implementer and task-reviewer prompts; one script message; consistency tests pin the new wording.

**Spec:** `docs/specs/2026-10-28-plan-format-design.md` (D1–D6, §What changes in builder)

## Global Constraints

- Builder repo house style: terse, plain words; no new dependencies.
- No consumer project names in any user-readable text.
- Run focused tests only (`node --test scripts/test/<file>.test.mjs`), never the whole glob.

## Phases

| Phase | App | Tasks | Goal |
|---|---|---|---|
| 1 | builder | 1–2 | the format, skill, prompts and tests say D1–D6 |

### Task 1: The consistency tests pin the new format
App: builder
Phase: 1
Recipe: skills/test-driven-development/SKILL.md

**Files:**
- Test: `scripts/test/skills-consistency.test.mjs`

**Interfaces:**
- Produces: assertions Task 2 must satisfy.

- [ ] **Step 1: Write the failing tests** — one `test('the plan format carries decisions, not bodies', …)` asserting, on `skills/plan/PLAN-FORMAT.md`:

```js
assert.match(fmt, /unambiguous, not complete/)
assert.match(fmt, /The implementer writes the body/)
assert.match(fmt, /Proportion/)
assert.doesNotMatch(fmt, /code blocks are required for code steps/)
assert.doesNotMatch(fmt, /No line budget/)
assert.match(fmt, /writing-plans.*7\.0\.0|7\.0\.0.*writing-plans/s)
```

and on `skills/build/prompts/implementer.md` `/you write the bodies/i`, on `skills/build/prompts/task-reviewer.md` `/Interfaces/`, on `skills/plan/SKILL.md` and `skills/resume/REFERENCE.md` `doesNotMatch(/steps with the actual code/)`.

- [ ] **Step 2: Run it and watch it fail** — `node --test scripts/test/skills-consistency.test.mjs` → FAIL on the new test only.

- [ ] **Step 3: Commit** — `test(plan): the plan format carries decisions, not bodies`

### Task 2: The format, skill, prompts and message say D1–D6
App: builder
Phase: 1
Recipe: the spec's §Decisions

**Files:**
- Modify: `skills/plan/PLAN-FORMAT.md` (opening, §Task structure Step 3, §No placeholders, §No line budget, §Self-review, attribution)
- Modify: `skills/plan/SKILL.md:55`, `skills/resume/REFERENCE.md:812`
- Modify: `skills/build/prompts/implementer.md`, `skills/build/prompts/task-reviewer.md`
- Modify: `scripts/list-features.mjs:176`, `LICENSE-THIRD-PARTY.md` (the PLAN-FORMAT row's source version)

**Interfaces:**
- Consumes: Task 1's assertions.

- [ ] **Step 1: Edit PLAN-FORMAT.md** to D1 (step kinds, verbatim spirit of superpowers 7.0.0 §What a Step Contains, adapted to builder's names), D2 (keep every builder line — App/Phase/Recipe, Files, Interfaces, Global Constraints, Phases table, one-app rules, TDD order, nothing between blocks), D3 (the forbidden list: decide-nothing lines kept; "code blocks are required…" dropped; "Similar to Task N" → name the Interfaces entry), D4 (remove "No line budget"; self-review gains *Step scan* and *Proportion*). The §Task structure example keeps Steps 1, 2, 4, 5; Step 3 becomes `Implement \`fn(input: In): Out\` in \`exact/path.ts\`` plus one line on the approach. Source: `~/.claude-home/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/writing-plans/SKILL.md`.
- [ ] **Step 2: Edit SKILL.md:55 and REFERENCE.md:812** — "steps with the test code, the signatures and the values the spec pins, the run command and the commit".
- [ ] **Step 3: Edit the prompts (D5)** — implementer: one paragraph near the brief's description: the plan pins files, names, signatures, spec values and tests; you write the bodies to them; a step that leaves a real design choice open is the existing escalate case. Task reviewer: one line — judge the diff against the task's Interfaces and tests, not against a body the plan no longer carries.
- [ ] **Step 4: list-features.mjs:176** — the warning reads `PLAN.md is N lines — long; a plan carries decisions, not bodies (PLAN-FORMAT §Self-review, Proportion); not a blocker`. Update any test asserting the old text.
- [ ] **Step 5: Run and watch them pass** — `node --test scripts/test/skills-consistency.test.mjs scripts/test/plan-slices.test.mjs scripts/test/plan-index.test.mjs` and any test touching list-features → PASS; then `node preview/preview.mjs --check` → no stale stage (restamp per preview/README.md only if the plan step's printed output changed).
- [ ] **Step 6: Commit** — `feat(plan): PLAN.md carries decisions, not bodies — steps are unambiguous, not complete (superpowers writing-plans 7.0.0)`
