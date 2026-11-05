# Tests run in layer order, scoped to the phase's app — design

**Status:** open questions answered by the owner (D7–D9); replayed (§Measuring it); next, the plan — nothing built · **Date:** 2026-11-03 · **Branch:** `fix/verifier-landing-base`

## Why

A real fleet run (a consuming project, builder 6.1.1) built a server-side feature stacked on a branch of
unmerged iPhone work. During the server-only phase the verifier ran the iPhone suite (≈73 files, 665
tests, an `xcodebuild` run) in 32 of 45 commit runs — 238 minutes of commit-tier runs in all. Two
verifier bugs explain most of it, and are fixed on this branch: requests compared against
`merge_into` instead of the feature's own landing branch, so every commit below the branch counted as
changed; and a `--tree` snapshot as the newest green sent the next run back to the whole branch.

They don't explain all of it. Another feature in the same project, whose requests already compared
against the right branch, still ran the iPhone suite in 8 of 17 commit runs and 3 of 17 phase runs of
a server-led build. Selection is by **reach** — a test runs when the import graph says a changed file
can reach it (`scripts/verify/select.mjs` → `impact.mjs`: imports, workspace packages, schema
readers, co-changed specs). Reach says nothing about **readiness**: a server change that reaches a
shared contract reaches the app's tests too, and they run before the API they exercise is built or
proven. The owner's rule:

> The app's tests do not run until the data layer and the API logic are verified. Be certain the
> lower layers can't be shown working before an upper layer's tests are scheduled.

The plan already promises half of this — "the verifier waits on one app per phase" (plan §One app per
phase, the producer before its consumers) — but nothing in the verifier keeps that promise: every
suite is selected by reach, whatever the phase is building. And the 4.x test plan's `slice=own+app`
("a slice's own tests, plus the app's suite once its slices are done"), dropped in 6.0 as "the
verifier's now", has no counterpart in it.

## What exists to build on

- **Roles:** every app in `.claude/builder.md` has `role:` — `producer` (serves the API, owns the
  schema), `consumer` (web, mobile, desktop clients), `tool`, or `app` (a lone app, both).
- **Suites name their app:** `suites: <name>: { …, app: <app> }`. Checks run in an app's `cwd`.
- **Phases name one app**, producers before consumers (plan §One app per phase). The contract freezes
  when the producer's phase verifies.
- **Tiers:** commit (after each task, nobody waits), phase (at phase close, the build's one wait),
  merge (everything, on the merged result, before landing).

## Decisions (proposed)

- **D1. Commit and phase runs are scoped to the phase's app.** The build passes the phase's app on
  each request (`verify.mjs request … --app <app>`; the fleet and `dispatch.mjs` read it from the
  plan's phase). Only suites and checks of that app run, plus any with no `app:` (repo-wide checks
  such as lint). Another app's suite is not selected, whatever the change reaches. It is named in
  the verdict as `skipped — not this phase's app; runs in its own phase and at merge`. With no
  `--app` (a request made by hand), selection is as today.
- **D2. Layers, from roles.** A run orders its suites by the role of their app: `producer` (and
  `app`) first, then `consumer`, then `tool`. No new config key; an optional `layer:` on a suite can
  override its app's role where a repo needs it (for example a data-only suite ahead of the API's).
- **D3. A consumer suite runs only when the layers below it are proven at this commit.** Before a
  consumer suite is scheduled in any tier, the run checks that every producer suite and producer check
  whose tier it is passed **in this run, or at an ancestor commit with nothing since that reaches
  them**. When a producer is red, broken or unproven, the consumer suite is not run. The verdict
  names it: `<suite>: waits on <producer suite> — runs once that is green`. This holds at the merge
  tier too: a red server suite means the app suite isn't spent on a merge that can't land.
- **D4. A consumer's phase can't close before its producer's phase verified.** At a consumer phase's
  close the phase tier is requested only when the producer's phase tier is green on an ancestor of
  HEAD. Otherwise the build stops with the producer's verdict as the reason. This is the contract
  freeze the plan already relies on, now enforced where tests are scheduled.
- **D5. The merge tier still runs every suite whole** (in layer order, D3 applied). Nothing that
  lands skips an app's tests; D1–D4 only decide *when* they run, never *whether* they run before
  landing.
- **D6. The test plan says what happens.** The go-ahead's test plan line names the order: e.g. *server
  tests per task; iPhone tests in the iPhone phase, after the server is green; everything at merge*.
  An old manifest's `slice=` reads with a one-line warning that slices no longer limit runs — D1 does
  — never silently.

**Owner's ruling, 2026-11-04:** the 4.x `slice=own+app` is resolved here, not restored. D1 is what
limits a run to its app, and D6's warning replaces the silent drop of an old `slice=` line.

## Owner's answers, 2026-11-04

- **D7. Repo-wide checks run in every phase.** Lint, and checks with no `app:`, stay in every commit
  and phase run as today: they are small overhead and cost few tokens.
- **D8. A fix round's runs take every app its diff touches.** D1 scopes by the phase's app, widened
  for a fix round to each app whose files the round changed. D2 and D3 still order those apps' suites
  and hold back a consumer's suite until its producer's is green.
- **D9. `/builder:init` works out each suite's layer, and asks only when it isn't obvious.** It
  reads the suite's app role, runner, glob and the files the glob matches (schema, migrations and
  repositories → data; route and handler tests → API; component, view and UI tests → client). It
  writes `layer:` only where a suite differs from its app's role. It asks one question per suite it
  can't place, with its guess as the recommended answer. `/builder:init --update` does the same for
  suites added later.

## Not changed

Reach-based selection inside a suite (which files of a selected suite run), flake handling, known
failures, the merge queue and landing. The two bug fixes on this branch (landing-branch target,
ancestor green) stand on their own and ship first.

## Measuring it

**Replayed 2026-11-04**, on a local clone of the consuming project, from a copy of its verifier
ledger. All 94 recorded commit and phase runs of two features were replayed: one stacked on unmerged
iPhone work, one not. For each run: the selection that was recorded; the selection with this branch's two
bug fixes (the feature's landing branch; the newest green that is an ancestor), via `selectSuites`; and
that selection with D1/D8 applied (suites of the apps the run's own range touches, plus app-less ones).
Runs selecting each suite, test files selected in brackets:

| Feature · tier | Runs | Server suite: recorded → fixed → D1/D8 | iPhone suite: recorded → fixed → D1/D8 |
|---|---|---|---|
| stacked · commit | 56 | 50 (5293) → 47 (2646) → 34 (2495) | 42 (3076) → 22 (1546) → 22 (1546) |
| stacked · phase | 3 | 3 (227) → 3 (307) → 2 (237) | 1 (70) → 2 (143) → 2 (143) |
| not stacked · commit | 17 | 15 (669 + 4 whole) → 15 → 10 (596 + 4 whole) | 8 (424) → 8 → 6 (422) |
| not stacked · phase | 18 | 14 (298 + 4 whole) → 16 (738 + 4 whole) → 11 (664 + 4 whole) | 4 (220) → 8 (433) → 6 (431) |

What it shows:

- **The bug fixes do most of the work.** On the stacked feature, the iPhone suite ran in 42 of 56
  commit runs; with the fixes it runs in 22, and every one of those 22 is a range that changed iPhone
  code. The server files selected halve too.
- **D1/D8 cuts the other app's suite where the range didn't touch it**: the server suite stays out of
  iPhone-only commits (47 → 34 runs on the stacked feature, 15 → 10 on the other). It also cuts the
  shared-reach cases: 2 commit runs and 2 phase runs of the unstacked feature selected the iPhone suite
  from server-only ranges.
- **D3 and D4 held nothing back in these two histories.** Both builds already ran producer first: every
  iPhone-touching commit came after the server phase tier was green, and no run that selected the iPhone
  suite under D1/D8 had a red server suite. They are guarantees for builds that break the order (a fix
  round across apps, a plan that interleaves), not a saving here.
- The fixed selection is sometimes larger than what was recorded at the phase tier. The replay uses each
  phase's recorded `--since`, and the unstacked feature's target as it stood just before it landed.
  The recorded runs reused results the replay doesn't model. Minutes aren't replayed: the ledger
  keeps one duration per run, not per suite.
