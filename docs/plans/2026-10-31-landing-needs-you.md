# Landing needs-you Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A landing blocked by the user's uncommitted changes parks as "needs you" with the overlapping files and three choices the next session raises — commit mine then land · set mine aside, land, put them back · leave it — and no human-only park ever lacks a way forward.

**Architecture:** Detection in `scripts/verify/checkouts.mjs` (`land`) and a fleet-start check in `scripts/fleet.mjs`; the park text and PARKED.md through `fleet-core.mjs` (`parkBlock`, `HUMAN_STEP`); the choices as a `fleet.mjs --land <feature> --commit-mine "<msg>" | --set-aside` verb; the picker in the fleet:status command and the session-start brief; the status line's `needs you` form; the ship commit's wording.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, git.

**Spec:** `docs/specs/2026-10-31-landing-needs-you-design.md` (a 6.0 release blocker — `docs/plans/2026-10-27-verifier.md` Task 25).

## Global Constraints

- Builder never commits, stashes or discards the user's uncommitted work without one of the three answers.
- A stash is never dropped by builder and a re-apply conflict is never force-resolved; it is reported file by file.
- No consuming project's name in anything committed. Human-facing text follows the house rules: the review shown in the CLI, one menu per screen, the next step in words.

## Review Focus

1. A dirty checkout whose changes do **not** overlap the feature — must land as today, no park. Task 1.
2. An untracked file at a path the feature also adds — git refuses; must count as overlap. Task 1.
3. Set aside, land, put back where the re-apply conflicts — stash kept, files listed, never dropped. Task 3.
4. The target checked out in another linked worktree — the existing refusal gains the same choice shape (D6). Task 2.
5. A status line too narrow for the reason — the `/builder:fleet:status` pointer always survives. Task 4.

---

### Task 1: Detect the overlap (D1)
**Files:** `scripts/verify/checkouts.mjs` (`land`, ~:96), `scripts/fleet.mjs` (fleet start: one check per ready-to-land or building feature), test `scripts/test/verify-checkouts.test.mjs`, `scripts/test/fleet.test.mjs`
- [ ] Produce `landOverlap(root, expectedOld, tested) → string[]`: the paths in `git status --porcelain` (tracked modified/staged; untracked only when `expectedOld..tested` adds that path) ∩ `git diff --name-only expectedOld..tested`. `land` returns `{ ok: false, overlap: [...], reason: 'your uncommitted changes overlap this feature' }` when non-empty, before any git write.
- [ ] Tests: tracked-modified, staged, untracked-same-path each overlap; a dirty file the feature does not touch → `[]` and the land succeeds; nothing is written to the working tree in the overlap case (status before == after).
- [ ] At fleet start, a feature already built whose branch overlaps the dirty checkout gets a note (`⚠ <feature> will need you to land: <n> files you are editing overlap it — /builder:fleet:status`), not a park.
- [ ] Commit `feat(fleet): a landing detects the user's overlapping uncommitted changes before touching anything`.

### Task 2: The needs-you park, with its choices (D2, D6)
**Files:** `scripts/fleet-core.mjs` (`parkBlock`, `HUMAN_STEP`, a `choices` field), `scripts/fleet.mjs` (`mergeThroughVerifier` / landing → park with overlap; the "checked out in" refusal), `scripts/verify/fleet-hooks.mjs` if `release` must pass `overlap` through, tests `fleet-core.test.mjs`, `fleet.test.mjs`
- [ ] The overlap parks with reason `needs you: your uncommitted changes overlap this feature — <n> files: <first 3>…` and PARKED.md lists every file, the branch and its sha ("the work is done and waiting"), and three choices with the exact commands: `fleet.mjs --land <f> --commit-mine "<message>"`, `fleet.mjs --land <f> --set-aside`, leave it.
- [ ] `parkBlock` takes `choices: [{ label, command }]`; a `human-step` park without choices throws in tests (D6): a test feeds every human-step reason the fleet can produce (grep `HUMAN_STEP` alternatives and their producers) and asserts each PARKED.md block has ≥ 1 choice. The "checked out in" refusal gains choices (switch that worktree's branch, then `/builder:fleet <f>` · leave it).
- [ ] Commit `feat(fleet): a needs-you park names the files and offers its choices; no human-step park without one`.

### Task 3: The choices, as one fleet verb (D3)
**Files:** `scripts/fleet.mjs` (`--land <feature>` with `--commit-mine "<msg>"` or `--set-aside`), test `fleet.test.mjs` (real git fixture)
- [ ] `--commit-mine "<msg>"`: commit exactly the user's current changes (all tracked changes plus untracked files in the overlap — never ignored files) with the message, then land the parked feature (same path the fleet lands by), clearing the park. Refuses with no message.
- [ ] `--set-aside`: `git stash push --include-untracked -m "builder: before landing <feature>"`, land, `git stash apply` the named stash; on success `git stash drop` that one entry; on conflict leave the stash, list the conflicting files, print the exact commands to finish (and print the note to the next session).
- [ ] Tests: each path on a real fixture repo with overlapping dirty files; the conflict path keeps the stash and lists files; the target never ends half-landed.
- [ ] Commit `feat(fleet): --land <feature> --commit-mine | --set-aside — the needs-you choices, done for you`.

### Task 4: Raised in the next session; the status line leads with the need (D3, D4)
**Files:** `commands/fleet/status.md` and the fleet skill text it uses, `hooks/brief-features.mjs` (~:57), `scripts/statusline.mjs` (~:96–110), tests `statusline.test.mjs`, the brief-features test, `skills-consistency.test.mjs`
- [ ] `/builder:fleet:status`: a `needs you` park shows the plain explanation and the files as a review in the CLI, then one AskUserQuestion with the three choices (house rule: explain above the picker, recommended first — "Set aside, land, put back" when the overlap is small, else "Commit mine, then land" — say why); on an answer it runs the matching `--land` command (commit-mine: show the proposed message and the files first, commit only on approval).
- [ ] Session-start brief: a needs-you park reads `- ⛔ <f> needs you — <short why> — /builder:fleet:status to choose`.
- [ ] Status line: `⛔ <f> needs you: <why cut to fit> — /builder:fleet:status`; the command is never cut (test at narrow widths).
- [ ] `preview --check` — rewrite/stamp what changed · commit `feat(fleet): a needs-you park is raised with its choices — fleet:status, the session brief and the status line`.

### Task 5: Honest landing words (D5)
**Files:** `scripts/condense.mjs` (~:203), `skills/ship/SKILL.md` (~:146), test `condense.test.mjs`
- [ ] The agent-form ship commit before the merge reads `docs(<key>): <feature> ready to land on <branch>`; "shipped into" appears only in text written after the merge commit exists (the fleet's landing note). Tests for both forms.
- [ ] Commit `fix(ship): the ship commit says ready to land until the merge exists`.

### Task 6: Release blockers carried here
**Files:** `scripts/verify/run.mjs` (`reapStrays` tty check), `scripts/dispatch.mjs` / `skills/build/EXECUTION.md` (batch order), `scripts/fleet.mjs` (feature-name charset), tests in their files
- [ ] `reapStrays`: when `ps` errors or returns nothing for a pid, skip it (fail closed). Test with a stubbed failing `ps`.
- [ ] Batched tasks: EXECUTION's batching paragraph says to ledger every batch member complete before closing the first with `next`; `next --close N` skips members already ledgered (exists) — add a test for the batch order.
- [ ] Reject feature names outside `[A-Za-z0-9._-]` where the fleet takes them (`nameOf`, `features()`), with a clear message; use `fill()` at the two inline `{feature}` sites. Tests.
- [ ] A red summary of a thrown error keeps its first `at` frame (verify.mjs); env notes written later in a build reach the brief — gather every `- ` bullet under any `## env notes` heading anywhere in the ledger (dispatch.mjs `envNotesOf`). Tests.
- [ ] Commit `fix: 6.0 release blockers — reap fails closed, batch order, safe feature names, error frames, late env notes`.
