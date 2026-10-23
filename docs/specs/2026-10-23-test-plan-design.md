# The test plan — slices you can see, testing and review you set — design

> 2026-10-23 · builder 4.12.0 (proposed) · status: decisions taken in conversation; awaiting go-ahead

## Why

The build profiles — Rush, Standard, Thorough — don't do what their names promise. On the
benchmark's md feature they took 13, 15 and 14 minutes (`bench/results/2026-10-14-0136-tags`).
They differ mostly in the walk and the final verify, while the time goes to the build step: a
reviewer agent after every task, and the implementer loop.

The owner's diagnosis, in their words:

> "what if we asked the user how many tests they want to run per slice and then how much to defer to
> the end when all slices are built. This way the user can effectively say 'Don't test' or 'Test
> every slice'."
>
> "There needs to be a good way of providing visibility to slices and tests per slice and giving the
> user the ability to pull those levers as needed for the feature they are building."
>
> "most people using claude are not engineers and are likely to go with the recommended path, so the
> recommended path should not always be the most comprehensive path because implementations could
> take hours. We want to prioritize getting work done."

What builder runs today, which nobody can see from the go-ahead:

| When | What runs |
|---|---|
| After each task | the implementer's own new tests and the type-check — never the app's suite (build §The loop) |
| After each phase (one app's tasks) | that app's fast set, once |
| At the end | verify (fast sets again, the deep set, the cross-app E2E) and the walk |

The go-ahead shows a `Phase · App · Tasks · Goal · Gates` table and asks a question in pipeline
vocabulary ("review", "walk", "verify floors"). Nothing says how many slices there are, what each
tests, or what a choice costs in minutes.

**Success:** at the go-ahead a non-engineer sees the slices, what each one tests, and what the
recommended plan will cost, and gets going with "go". The recommended plan is the fast one. Anyone
can pull it toward "test every slice" or "don't test", and see the cost change before choosing.
The same choice governs an in-chat build and an agent build.

## Decisions (from the conversation)

- **D1 — A slice is a task.** The go-ahead shows tasks as numbered slices, grouped by app — the way
  superpowers' plans read. "Test every slice" means after every task.
- **D2 — Three levers, asked the same way:** testing per slice, testing at the end, review cadence.
  They replace Rush / Standard / Thorough as the question users answer.
- **D3 — Review is a lever beside testing**: after each slice, once per app, or once at the end.
  Recommended: once at the end.
- **D4 — "Nothing" keeps a type-check.** No tests while building and none at the end still
  type-checks every touched app before the work lands, and the final whole-branch review still
  runs. Those two are the floors.
- **D5 — The recommended plan is the fast one**: each slice runs its own tests, the touched apps'
  suites run once at the end, review once at the end. A signal (a schema change, a released
  consumer) raises only the *end* recommendation, with the reason said; nothing ever recommends
  the full suite per slice.
- **D6 — Release: a minor (4.12.0)** — a substantially new choice at the go-ahead. Old manifests
  keep working (§Compatibility), so not a major.

## Design

### 1. The slice table at the go-ahead

`/builder:plan` ends with the plan as slices, not phases. In chat, before any question:

```
cert-tags — 12 slices in 3 apps · lands on main

api     1  Tag and CertificateTag models + migration            +3 tests
        2  Tag create / rename / delete endpoints               +6 tests
        3  ?tag= filter on GET /certificates                    +4 tests
        4  Contract: tags on the certificate payload            +2 tests
web     5  Tag chips on the certificate row                     +2 tests
        …
mobile 11  Tag filter sheet                                     +3 tests
       12  Tag chips on the certificate card                    +2 tests

Test plan (recommended): each slice runs its own tests · at the end, the api, web and
mobile suites once · one review at the end
  12 quick test runs + 3 suite runs (≈ 6 min of tests) · build ≈ 35 min

A. Build it with this plan (recommended)
B. Change the test plan — how much to test per slice, at the end, and when to review
C. Keep planning
Reply A, B or C — "go" is A.
```

- The `+N tests` column counts the test cases the task's steps name (PLAN-FORMAT already puts them
  in the steps); `scripts/plan-slices.mjs` (new) prints the table from `PLAN.md`.
- The phase table stays in `PLAN.md` for the build's own use; the user sees slices.
- **B** opens the three questions (§2), then shows the table's test-plan lines again with the new
  counts and the same A/B/C.

### 2. The three questions (B)

One AskUserQuestion with three questions. Each option's description leads with **what it costs
for this plan** — counts always, minutes when known (§4).

**Testing while building — after each slice:**
| Option | Runs | Lever |
|---|---|---|
| **Its own tests (Recommended)** | the tests that slice adds, and the type-check | `slice=own` |
| Its own, plus the app's suite when the app's slices are done | today's behaviour | `slice=own+app` |
| The app's suite after every slice | slowest — `@scoped` lines still narrow it | `slice=full` |
| None while building | tests are still written; they run at the end | `slice=none` |

**Testing at the end — once every slice is built:**
| Option | Runs | Lever |
|---|---|---|
| **The touched apps' suites, once (Recommended)** | every touched app's fast set, the tests §Testing names, released-consumer parity | `end=touched` |
| Plus an agent tries the risky parts | the above, the `[risk]` walk items in the running app, and `@scoped` deep lines | `end=risk` |
| Everything | the deep set, the cross-app E2E, the full walk — today's Thorough | `end=everything` |
| Nothing — I'll test it | the type-check only (D4); the verdict says nothing was tested | `end=none` |

**Review:**
| Option | Lever |
|---|---|
| **Once at the end (Recommended)** — one whole-branch review | `review=end` |
| Once per app — after each app's slices | `review=app` |
| After every slice — today's behaviour | `review=slice` |

*Other* on any of them is the escape to the rest: `models`, `persist`, `unruled` — the levers that
exist today, unchanged.

**The human walk is not a lever.** An in-chat build keeps the 🔒 walk before a PR whatever the test
plan — it is a human's look at the feature, not a test run. An agent build asks one more question
only when B was chosen and the end is `risk` or `everything`: *Walk it yourself before it lands?*
(No recommended) — today's `thorough-you`.

### 3. What each lever changes

| Lever | build | agent-walk | verify |
|---|---|---|---|
| `slice=none` | implementer writes the tests, runs only the type-check | — | — |
| `slice=own` | implementer runs its own tests + type-check (today's per-task rule); **no fast set at the phase close** | — | — |
| `slice=own+app` | as `own`, plus the app's fast set at the phase close (today) | — | — |
| `slice=full` | the app's fast set after every task, through `gate.mjs` (quoted when unchanged) | — | — |
| `end=none` | — | no walk | type-check of every touched app; checklist items needing tests are named as skipped; the verdict's first line says nothing was tested |
| `end=touched` | — | no walk | today's `verify: floors` |
| `end=risk` | — | `[risk]` items + the cross-app section | today's `verify: full` |
| `end=everything` | — | the full walk | today's `verify: everything` |
| `review=end` | no task reviewer; the final whole-branch review | | |
| `review=app` | one review per app's slices, at its phase close | | |
| `review=slice` | today's task review after each task | | |

**A red result is still a stop wherever it runs.** Testing less moves where failures surface; it
never lets a red gate pass. With `slice=own` a failure the app suite would have caught surfaces at
the end — the fix dispatch then names the slice that caused it, as a phase-close fix does today.

**The floors (D4):** the type-check of every touched app before the work lands, and the final
whole-branch review. `released parity` moves from a floor into `end=touched` and up; `end=none` on a
feature with a released consumer or a schema change carries a one-line warning — it never refuses.

### 4. Estimates

- **Counts, always** — from `PLAN.md` (slices, apps) and the levers: "12 quick test runs + 3 suite
  runs".
- **Minutes, when known.** `gate.mjs` already times every command (`gates-core.mjs` `runCommand`
  returns `ms`); it now records the last green duration per command in its gate record. Test minutes
  = per-app suite duration × suite runs the plan implies + a per-slice average for own-test runs.
  Unknown → counts only.
- **Build time** keeps `profile.mjs --estimate`'s fleet-history method, keyed by the test plan
  instead of the preset, falling back to counts.

### 5. Where it is asked, and recorded

- **The go-ahead** (`/builder:plan`), in chat and for agents alike — the in-chat build now reads the
  levers too (today it only does under `--agent-walk`).
- **`/builder:agent` and `/builder:fleet`** ask it ahead for picks with no test plan, as they do the
  profile today — the slice table per pick when `PLAN.md` exists, the questions with ladder words
  when it doesn't.
- **`--auto` / `--agent-walk`** take the recommendation, recorded `auto (recommended)`.
- **The manifest:** `tests: slice=own end=touched review=end` (plus any `models= persist= unruled=`
  from *Other*). The status and fleet tables show it short: `own · touched · end`.
- **The quick path and small path** are one slice and keep what they do now: that app's fast gates
  the diff can turn red, and a human look.

### 6. Compatibility

A manifest with `profile:` and no `tests:` keeps working — `profile.mjs` maps it:

| `profile:` | `tests:` equivalent |
|---|---|
| `rush` | `slice=own+app end=touched review=end models=economy persist=low` |
| `standard` | `slice=own+app end=risk review=slice` |
| `thorough` | `slice=own+app end=everything review=slice` |
| `thorough-you` | the same, plus your walk |
| `custom k=v …` | the old levers translated key by key |

New go-aheads write `tests:`. `/builder:benchmark` replaces its rush/standard/thorough configs with
`builder` (the recommended plan) and `builder-everything` (`own+app · everything · slice`), so the
benchmark measures the default users will take against the old full pipeline.

## Out of scope

- A depth lever for the front half (audit and plan run as they do).
- PR + CI landing (still deferred).

## Touches

`scripts/profile.mjs` (levers, mapping, estimate), `scripts/plan-slices.mjs` (new), `scripts/gate.mjs`
/ `gates-core.mjs` (record durations), `scripts/fleet.mjs` and `list-features.mjs` (labels),
`skills/plan` (go-ahead), `skills/build` (+ EXECUTION.md), `skills/verify`, `skills/agent-walk`,
`skills/agent`, `skills/fleet`, `skills/status`, `skills/help`, `skills/resume/REFERENCE.md`,
`skills/benchmark` + `scripts/bench.mjs`, the preview stages, tests, CHANGELOG.
