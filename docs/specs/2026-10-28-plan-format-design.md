# PLAN.md carries decisions, not bodies — design

**Status:** draft for review · **Date:** 2026-10-28 · **Branch:** `feat/plan-format` (from `feat/verifier`)

## Why

`/builder:plan` writes `PLAN.md` to a format adapted from superpowers' `writing-plans` as it stood at
6.x: *"assume the engineer has zero context… document everything they need: which files to touch, the
code, the tests"*, a **No placeholders** list that requires a code block for every code step and
forbids "Similar to Task N" (*"repeat the code; the implementer never sees Task N"*), and **No line
budget** (*"PLAN.md carries code and is deleted at sign-off"*).

The result is a plan that is mostly a transcript of the program, written without being run:

- The verifier's plan (`docs/plans/2026-10-27-verifier.md`) is **4,639 lines for a 299-line spec** —
  15× — with 95 code blocks. Its ledger had to rule that implementers stay on sonnet *"even where the
  plan carries full code — the plan's code was written without being run, so implementers will debug"*,
  and its pre-flight scan found test fix-ups and cross-task conflicts the code itself hid.
- The code is paid for twice: once by the plan writer (tokens, and the go-ahead read), then again by an
  implementer who must make it actually work.
- `builder:plan` runs over its turn budget on the smallest bench feature (`tags`: 11 turns against a
  budget of 7, 2026-10-26).

Superpowers itself has since moved (7.0.0, installed here): *"A step is done when the implementer can
write exactly one reasonable thing from it. That is the whole requirement: unambiguous, not complete."*
A code step carries the exact signature, the file and the values the spec pins — *"the implementer
writes the body"* — and its self-review adds a **Proportion** check: *"a plan longer than the code it
describes has written the code instead."*

What builder's implementer genuinely lacks is not code but **decisions**: which files, which names and
signatures, which values from the spec, which tests prove the task, and what neighbouring tasks call
things. Those are what a zero-context implementer cannot recover; a body it can write.

**Success:** a plan that keeps every decision a fresh implementer needs — and none of the bodies the
signature and tests already determine — so plans get several times shorter, the plan step gets cheaper
and faster, and build quality (fix rounds, task-review findings, parks) does not get worse.

## Decisions

- **D1. A step is unambiguous, not complete** (superpowers 7.0.0 §What a Step Contains, adopted):
  - **Test step:** the test's name and its assertions **as code**, with the spec's exact values. Kept in
    full — it is the contract, and `plan-slices.mjs` counts a slice's tests from the `it(`/`test(` lines
    inside its fences for the go-ahead table.
  - **Code step:** the exact signature (name, parameters, return type), the file, and the values the
    spec pins. **The implementer writes the body.** A body appears only for an algorithm the signature
    and tests don't determine, or for exact copy the spec fixes (a message, a migration, a config value).
  - **Verification step:** the command and the output that means it passed — unchanged.
  - **Reference to another task:** that task's **Interfaces** block — not a repeat of its code.
- **D1a. The task shape (owner, 2026-10-28)** — six parts, all in words except the tests:
  - **Files:** each path with its one responsibility (`Modify: path:lines — what it does`).
  - **Interfaces:** the function, class, field and type names neighbouring tasks rely on, each name in
    backticks (the scan pairs names by them), with parameters and return types described in words
    (`Produces: \`parseTags\` — takes the raw tag string, returns the list of normalised tags`).
  - **Behaviour:** the rules the task must meet, one per line, each citing the spec decision behind it
    (`both assignees set → 422 (D6)`).
  - **Pattern** (optional): existing code to follow, as `file:line`, never copied in. It sits above
    Tests because the head `plan-slices.mjs` reads ends at the first fence.
  - **Tests:** each test's name and what it proves, one line each — and under it **its assertions as
    code**, with the spec's exact values. The owner prefers stronger tests: the plan writer pins what
    each test checks; the implementer does not decide it. (`plan-slices.mjs` keeps counting them.)
  - **Steps:** the test-first cycle in words, with the commands and the commit message. No code in a
    task except where the plan must be opinionated: the test assertions, exact copy the spec fixes, the
    frozen contract verbatim, and an algorithm the signature and tests don't determine (owner, 2026-10-29:
    remove the code "without sacrificing areas where the plan needs to be opinionated").
  The task reviewer checks every Behaviour line has a test that would fail without it.
- **D2. Everything builder adds for the zero-context implementer stays:** the `App:` / `Phase:` /
  `Recipe:` lines, **Files** with exact paths (and line ranges for a modify), **Interfaces**
  (Consumes/Produces with exact names in backticks, types in words — now the main way a task learns its neighbours' names),
  `## Global Constraints` copied verbatim, the `## Phases` table, one app per task and per phase, the
  TDD step order, and the rule that nothing sits between task blocks (`task-brief`'s extraction).
- **D3. "No placeholders" becomes "every step decides something, no step transcribes".** The forbidden
  list keeps the lines that decide nothing (TBD, "handle edge cases", "write tests for the above", an
  undefined type or function). It drops "code blocks are required for code steps" and changes "Similar
  to Task N — repeat the code" to "name the Interfaces entry you mean".
- **D4. "No line budget" becomes a Proportion check** in the self-review: compare the plan's length to
  the spec's; if code blocks are most of the document, replace bodies with signatures, test names and
  assertions, and re-check each step is still unambiguous. A guide, not a hard limit.
- **D5. The implementer and task-reviewer prompts say so.** The implementer is told the plan gives
  signatures, interfaces and tests and it writes the bodies to them (its existing "stop and escalate"
  rule already covers a step that leaves a real design choice open). The task reviewer judges the diff
  against the Interfaces and the tests, not against a body the plan no longer carries.
- **D6. Old plans keep working.** A PLAN.md written with full bodies is still a valid plan — nothing
  that reads PLAN.md (`task-brief`, `plan-slices`, the build loop) depends on bodies. Only what new
  plans contain changes; no migration.

## What changes in builder

| File | Change |
|---|---|
| `skills/plan/PLAN-FORMAT.md` | Opening paragraph (D1's framing; the "fresh subagent sees only its block" reason stays); task-structure example's Step 3 becomes a signature + one line of approach; §No placeholders → D3; §No line budget → removed; §Self-review gains *Step scan* (gap or transcript) and *Proportion* (D4); attribution line names superpowers 7.0.0 |
| `skills/plan/SKILL.md` | line 55 "steps with the actual code" → "steps with the test code, the signatures and the values the spec pins" |
| `skills/resume/REFERENCE.md` | line 812, same wording |
| `skills/build/prompts/implementer.md` | one paragraph: the plan pins names, signatures, values and tests; you write the bodies to them (D5) |
| `skills/build/prompts/task-reviewer.md` | one line: judge against the task's Interfaces and tests (D5) |
| `scripts/list-features.mjs:176` | the "long, but it carries code" warning reads as a proportion note instead |
| `LICENSE-THIRD-PARTY.md` | the adaptation row names `writing-plans` 7.0.0 |
| `scripts/test/*` | `skills-consistency` asserts the new wording (and that "code blocks are required" is gone); `plan-slices` unchanged (tests stay in fences) |

Out of the change: the phase derivation, the go-ahead, the slice table, `task-brief`, the build loop.

## Testing

- **Unit:** the consistency tests above; `plan-slices` and `plan-index` tests pass unchanged (the
  proof that the go-ahead's test counts don't depend on bodies).
- **Preview:** `node preview/preview.mjs --check` — the plan step's printed output (the slice table,
  the go-ahead) should not change; restamp only if it does.
- **Bench:** `node scripts/bench.mjs run tags` and `run share`, 3 reps, against the same day's run of
  the previous version (a same-day control, per the benchmark memory). Compare `builder:plan` turns,
  tokens and minutes; `builder:build` fix rounds and task-review findings; accept and fixture scores;
  and the PLAN.md's line count and spec ratio. **Success:** plan cost clearly down, accept/fixture
  unchanged, build fix rounds not up.

## Open questions (the human's call)

1. **Adopt superpowers 7.0.0's `## Review Focus` section too?** It lists the five inputs or failure
   modes the spec implies but no task's tests exercise, and adds a test for each to the owning task.
   It is a separate idea (coverage, not size), cheap to add, and overlaps builder's audit gap hunt.
   Recommendation: a separate small change after this one is measured, so the bench isolates one thing.
2. ~~Release~~ — **decided (owner, 2026-10-28): ships in 6.0.0.** Built on `feat/plan-format` and
   merged into `feat/verifier` after the verifier's end-to-end benchmark runs (so those compare the
   verifier alone), before the 6.0.0 release.

## Out of scope

- Changing how phases or slices are derived, or the go-ahead.
- Any change to `/builder:build`'s loop, models or review tiers.
- Rewriting existing PLAN.md files.
