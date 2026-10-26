# Lean walks and batched walks — design

> 2026-10-26 · builder 5.2.0 · status: approved by the owner ("Fixes 1–4 and batching together")

## Why

**Within a feature** — one consumer project's chart feature (one app, one screen, 9 checks):
- `walk.md` held the 9 items **and** the same script again as `## Cross-app (verify E2E)` E1–E9:
  `walk-script.mjs` adds the cross-app section to every agent-mode walk, however many apps are in
  scope. 18 checks per round.
- `end=risk` should have walked items 1, 7, 8 — but the cross-app section is always walked in full,
  so all 18 ran.
- Round 2's brief: "Work every `[risk]` item and every step of the `## Cross-app` section" — the fix
  was for item 1; everything was walked again. Three rounds at ~27 min each.
- The project's driver ran "one test per walk item" — a fresh app launch per item, on one screen.

**Across features** — the walk lane is one at a time. One project's archive (20 features): 623 min of walk
lane Claude time, of which **verify 339 min** (median 15 min/feature) — verify ran in the walk lane
though it needs the env only for `@walk` gates — agent walk 194 min, readiness 75 min; plus a full
`reset` + `start` + `smoke` per feature outside that time. Another project: 41 min median per feature.

## Decisions

**Lean walk (every fleet):**
1. **One app in scope → no cross-app section.** The verification script *is* the walk — its steps
   are the app's items; §Testing's per-app test items are the gates' to prove. Multi-app keeps the
   per-app items and E1…En. (note-tags: 19 → 7 items.)
2. **Risk scope holds** — with (1), `end=risk` walks the `[risk]` items of a one-app feature only.
3. **A round after the first walks only what the fix could change** — the items the last round
   didn't pass, plus a passed one only when the fix's diff touches code it exercises; other passes
   are carried (`PASS (carried from round <n> @ <sha>)`, same evidence). `dispatch.mjs` writes the
   scope and `git diff --stat <last sha>..HEAD`.
4. **Walk by screen** — the walker groups items by screen/component and reaches each once.

**Batched walks (`agent_walk.start` set, `agent_walk.batch` > 1, default 8):**
5. The walk lane takes every feature waiting to walk (up to the cap), merges their branches onto the
   target in `<worktrees>/_walk` (branch `builder/_walk`, never merged, removed when the fleet ends),
   brings the env up **once** (`reset` once; a restart line restarts it without a reset), and runs
   one `/builder:agent-walk --batch` session there: readiness for the batch, one walker across
   every feature by screen (`dispatch.mjs walk-batch`), each verdict in its own worktree. A feature
   that conflicts with the others waits for the next batch; one batch of one is a plain walk.
6. **Verify and ship leave the walk lane**: `signed-off` routes to the pool (`--no-dev-env`). The
   deep set's `@walk` lines run once per batch, against the batch env (`gate.mjs --walk-only`), into
   each signed-off feature's `walk-gates.md`, before it is handed on; verify quotes it.
7. **A walk's fixes go to the pool**: `built` with an open `## Fixes` row routes to the build lane;
   the fix run ends `ready: pending`, and a later batch re-walks only what changed (3).
8. A verify INCOMPLETE whose fix changes something walked sends the feature back to `built` /
   `walk: none` for a scoped re-walk — verify never drives the app without an env.
9. Anything a batch can't do — a walk tree that won't prepare, an env that won't come up — falls
   back to one walk per feature (`walkOne`, with its env-repair run).

## Not in this release

- No gather window: a batch takes what is waiting when the lane frees. The first walk of a run often
  goes alone; batches fill as the queue builds behind a walk.
- Project drivers that launch per item still say so in their own config; the walker's
  brief now overrides that habit by grouping, and `/builder:init` can be asked to rewrite a driver.

## Tests

`walk-script.test.mjs` (one app → the script is the walk), `dispatch.test.mjs` (round-2 scope with
carried passes; `walk-batch` brief), `fleet-core.test.mjs` (batched lanes, `hasOpenFixes`),
`fleet.test.mjs` (two features in one batch — one env start, verify/ship in the pool, walk worktree
gone; `batch: 1` as before; a walk's fixes in the pool, rejoining a later batch),
`gates-core.test.mjs` (`--walk-only`), `config.test.mjs` (`batch` default 8).
