# Codex Builder 6.0 port — inventory and plan

**Date:** 2026-11-01 · **Source of truth:** `feat/needs-you` (6.0.0, unreleased; its `plugin.json` still reads 5.5.0)
· **Read:** CHANGELOG 4.9.1–5.5.0, `docs/specs/2026-10-27-verifier-design.md`, verifier plan Task 25,
`docs/specs/2026-10-31-landing-needs-you-design.md`, `git log bb75acd..feat/needs-you` (5.5.0 → tip).

## Starting point — this branch is not the base

This branch (`codex/port-6.0`, from `codex/builder-port` at 4368bfd) carries Codex **4.9.0**. That
lineage is superseded: `main` re-imported the port in 6d7dcfb (a superset of 4368bfd's `codex/` — 934
lines added, nothing in `lifecycle.mjs` removed) and has since taken **4.9.1–5.2.0** through `$sync`
(3fe5d9e, e0d8ca4). `main` and `feat/needs-you` carry Codex **5.2.0**, with `codex/upstream.json`
pinned at 8dde46e and the Claude-first sync tooling (`sync.mjs plan | copy-shared | finish | check`,
`release.mjs`, the `$sync` skill). RELEASING.md on `feat/needs-you` replaces this branch's "Codex
version alignment" section with "Codex release (Claude-first)".

So the real port is **5.2.0 → 6.0.0**, done the way `$sync` does it: one decisions row per changed
upstream file, evidence under `codex/`, `finish` against a pinned upstream commit. The 4.9.1–5.2.0 rows
below are already done and listed only so the inventory is complete.

## 1. Inventory — 4.9.1 → 6.0

**port** = same behaviour · **adapt** = same intent, Codex-shaped · **n/a** = Claude-only runtime ·
**done** = already on `main`'s Codex 5.2.0.

| Release | Change | Disp. | Codex shape / why |
|---|---|---|---|
| 4.9.1–4.11.0 | Profile asked before agents; value-sized splits; migrations reach the dev DB on landing; named next step; build here; spec approval is the brainstorm's yes | done | 6d7dcfb, 3fe5d9e; `landing.mjs`, `lifecycle.mjs deliver`, SKILL.md |
| 4.11.1–5.2.0 | Discovery and quick path; one menu per screen; reviews in the chat; test plan replaces profiles (4.12); `merge_into: current`; `@typecheck`/`@walk`; standing traps; agent mode at every install | done | e0d8ca4; dispositions in `codex/upstream.json` |
| 4.11.0, 4.12.1 | `/builder:benchmark` | n/a | README excludes it: drives `claude -p` stream events; no Codex equivalent |
| 4.14.4–4.14.5 | Session brief and PR lock hooks; vendored hooks | n/a | Claude Code hooks; Codex has none — `$builder status`/resume print the same facts on demand |
| 5.3.0 | `/builder:fleet:status`, stage timeline, walk-env launch proof, dead walk env restarted, walk lane stops at sign-off, `--no-env-check`, e2e without `@walk` skipped under the fleet | n/a | Fleet only. Codex workers are session-owned; `$builder status` and `history.mjs` durations cover the reporting |
| 5.3.0 | Line quoting, `@parallel`, `@local` gate tags | n/a | Superseded in 6.0 by the verifier; never ported to `gates-core.mjs` |
| 5.3.0 / 5.4.0 | `plan_writers: per-app` / `per-phase` | n/a | Claude plan-writer subagents. The Codex coordinator writes PLAN; planning.md already allows parallel read-only investigation |
| 5.3.0 | §Walk readiness `pending:` — ask the DB before writing "the dev DB is behind" | adapt | `landing.mjs` runs `pending:` after `deliver`; without it the note says *may* be behind |
| 5.3.0 | Destructive-migration check reads only the forward half; tool-specific ops | adapt | `landing.mjs` already has `forwardPart`/`DESTRUCTIVE_CODE`; port the missing ops (`ALTER COLUMN … TYPE`, `UPDATE … SET`, `deleteMany`, `bulkDelete`) with tests |
| 5.4.0 | Per-dispatch meter, cost per task, transcript pruning | n/a | Read from Claude stream-json. `history.mjs` keeps measured tokens/cost only when Codex reports them |
| 5.4.0 | `builder:implementer`/`reviewer` lean agent types; `agent_types:` | n/a | Claude subagent types. Codex already dispatches `spawn_agent` with `fork_turns:"none"` (models.md). `config.mjs` parses `agent_types:` so a shared config reads the same |
| 5.4.0 | `plan-slices --brief/--scan`; constraints once per brief; fresh orchestrator per stage | n/a | Claude dispatch/fleet. Codex `task-brief` + execution.md already read PLAN once and brief per task |
| 5.4.0 | The audit's code map (`audit-digest.md`), read before planning | adapt | discovery.md: audit writes the map to the feature scratch; planning.md reads it first |
| 5.4.0 | `/builder:archive` (SHIPPED / CLOSED / DROPPED, one commit); a dropped child never satisfies a program dependency; `condense --ship --merged` | adapt | `$builder archive` over `registry.mjs` (`_archive/` already exists); program dependency rule in discovery.md's xl section |
| 5.4.0 | Finished means gone from `/builder:status` | adapt | `lifecycle.mjs list` drops merged/shipped/archived rows (today it shows merged as terminal) |
| 5.4.0 / 5.4.1 | Parks and merges told on the status line and session brief; quiet run `⚠`; per-task progress | n/a | Status line and hooks. Codex lands in-session and reports; parks already write PARKED.md with a next step |
| 5.4.0 | `/builder:tidy` ships before merging | n/a | Repo-wide tidy is excluded (README) |
| 5.5.0 | The wrap-up: checkout target, apply migrations, regenerate, restart, fixtures, smoke, tidy; `restart:`/`fixtures:` keys | adapt | Codex lands in the session, so the wrap-up is the tail of `deliver`: `landing.mjs` parses `restart:`/`fixtures:`; the coordinator offers the remaining steps in one question. The tidy step stays n/a |
| 6.0 | **The verifier**: `scripts/verify/*` — service, client, scheduler, run checkouts, selector over `impact.mjs`, 7 runner adapters, env pool (Postgres templates, ports, hooks), ledgers, failure judging (env-broken · known · flake · debt · regression), bisect | adapt | Vendor into `codex/scripts/verify/` (Decision 2) |
| 6.0 | **`verify:` replaces `## Quality gates`**; `gate.mjs`, `gates-core.mjs`, memo, `@delta`, `--baseline`, `flaky:`, `@scoped`/`@typecheck`/`@walk`/`@known-red` removed | port | Delete Codex's gate system; an un-migrated config is env-broken with the next step, never untested-green (Decision 4) |
| 6.0 | `init` writes `verify:`; `init --update` migrates 5.x gates via `migrate.mjs` | adapt | `$builder init --update` runs the Codex copy of `migrate.mjs` on the config Codex selected (`.codex/builder.md` → `.builder/config.md` → `.claude/builder.md`), shows it as a review, writes it in the feature worktree |
| 6.0 | Commit tier beside the build; phase tier the only wait; a regression becomes a fix against the task that introduced it | adapt | execution.md: request after each task commit, read `verdict` before each dispatch, `wait` at phase close. Writers stay sequential in one worktree |
| 6.0 | Merge queue: merged result tested whole, `--hold` until the walk passes, `release` lands by compare-and-swap; READY = merge tier green + walk passed | adapt | `lifecycle.mjs prepare/deliver` call the merge tier instead of building an integration worktree (Decision 3) |
| 6.0 | Test plan is `walk · review` (+ models/persist/unruled/human); `slice`/`end` gone; old manifests map on read | port | `profile.mjs` `TEST_LEVERS`, `parseTests`, the mapping; `lifecycle.mjs approve --tests` |
| 6.0 | Landing needs-you: overlapping uncommitted changes detected early; park names the files and offers commit-then-land · set-aside-land-restore · leave it; "ready to land" until the merge exists; every human-only park carries a choice | adapt | `release` exit 1 + `overlap:` line → `lifecycle.mjs` records a needs-you park; the coordinator asks the three choices; `deliver --set-aside` stashes with a unique message, applies by sha, keeps the stash on conflict. `$builder resume`/`status` raise it |
| 6.0 | PLAN carries decisions, not bodies — six-part task (Files, Interfaces, Behaviour, Tests, Pattern, Steps); pinned list (frozen contract verbatim, migrations, security) | adapt | planning.md task block; `task-brief` extraction is unchanged (shared helper) |
| 6.0 | §Environment landmines and ledger env notes in every brief | adapt | execution.md step 1 appends them to the brief (not into `task-brief`, which is copy-shared) |
| 6.0 | `dispatch next`, `--model` only raises, fleet bundles (`docs.mjs`), `BUILDER_DIR`, fleet hooks fill `{feature}`, audited → plan straight, tracked test output restored | n/a | Claude dispatch/fleet. `route.mjs` already refuses a silent downgrade. The verifier's own walk-env `{feature}` fill comes with the vendored code |
| 6.0 | Status line, handoff and tidy read the verifier's runs | n/a / adapt | Status line and tidy are n/a; `$builder status` adds a `verify.mjs status` line; `lifecycle.mjs cleanup` never touches `<root>-verify/` |
| 6.0 | Benchmark suite, gate replay, history view; `preview/` stages | n/a | Benchmark excluded (README). `preview/` is the Claude response preview, local to this repo |

## 2. Key decisions for the owner

1. **Base the port on `feat/needs-you`'s Codex 5.2.0, not this branch's 4.9.0.**
   *Recommendation:* rebase `codex/port-6.0` onto `feat/needs-you`, keeping only this document's
   commit, and run it as a `$sync`: `sync.mjs plan --ref <pinned feat/needs-you sha>`, adapt, one
   decisions row per file. Before dropping `codex/builder-port`, confirm with
   `git diff 4368bfd 6d7dcfb -- codex` that nothing in it is missing from `main`.
2. **The verifier in Codex: vendor it, and remove gates.**
   *Recommendation:* copy `scripts/verify/*` into `codex/scripts/verify/`, without `fleet-hooks.mjs`
   (it only serves the Claude fleet). The copy is about 2.6k lines and needs only `config.mjs` and
   `impact.mjs`. Three changes are needed: `verify/config.mjs` and `migrate.mjs` hard-code
   `.claude/builder.md` and must use Codex's `CONFIG_PATHS` precedence; `CLIENT_KEYS` drops
   `CLAUDE_PROJECT_DIR`; `checkedOutBranch` comes from Codex `config.mjs`. Keeping gates is rejected:
   once a shared repo runs Claude's `init --update`, its config has no `## Quality gates` left, so
   Codex gates would have nothing to run, and the repo would have two test systems with two ledgers.
   **Risk to prove first:** the service is a detached node process that exits when idle.
   codex/README.md makes no claim that it outlives a tool call ("background survival is not
   claimed"). If the Codex sandbox kills it, the rule that a request whose service died on it twice is
   env-broken would make every run env-broken. Phase 1 tests this. If it fails, add a
   foreground `serve --until-idle` used inside `wait`, upstream first.
   *Later, optional:* move the config path into one resolver upstream, so `verify/` can join
   `sync.mjs`'s copy-shared list.
3. **Landing: the verifier's merge queue replaces Codex's integration worktree.**
   *Recommendation:* `lifecycle.mjs prepare` keeps its guards (pause, human wait, immutable target,
   clean verified feature) and then runs `verify.mjs request … --tier merge --hold --target
   <captured target>`. The walk runs beside it. `deliver` runs `release` and then records history and
   the landed migrations. The result is one compare-and-swap landing path, and the whole suite runs on
   the exact commit that lands. On a conflict verdict, the target is merged into the feature worktree
   and the merge is requested again. Testing the old integration-worktree candidate is rejected: the
   verifier always merges with `--no-ff`, so it would test a merge of a merge, and Codex would keep
   two landing implementations.
4. **What a Codex consumer must do on upgrade (major).**
   *Recommendation:* run `$builder init --update` once. It shows the migrated `verify:` block as a
   review and writes it on approval, in a worktree as Codex already does for config. One migration
   serves both editions when the repo shares `.claude/builder.md`. With no `verify:` block, every
   request is env-broken with "run `$builder init --update`", and nothing falls back to gates.
   In-flight features: `slice`/`end` map on read, a mid-build feature's next phase close uses the
   verifier, and old `.builder/gates/` memos are ignored. Codex 6.0.0's README leads with this step,
   the same as Task 25 does for Claude's CHANGELOG.
5. **Version: Codex 6.0.0 only after Claude 6.0.0 exists.**
   *Recommendation:* do not publish a Codex 5.5.0, because 5.3–5.5 is almost all fleet work or gate
   work that 6.0 supersedes. Phases 1–4 commit with `codex/plugin.json` still at 5.2.0, and
   `sync.mjs check` reports pending until then. Phase 5 runs
   `sync.mjs finish --ref <Claude 6.0.0 release sha>`. `finish` copies the upstream `plugin.json`
   version, so running it against today's `feat/needs-you` would stamp 5.5.0.

## 3. Phased implementation plan

Each phase ends with `node --test codex/tests/*.test.mjs` green and one commit. The baseline on
`feat/needs-you` is 185 passing tests, about 3.3 minutes. The gate system stays
in place until Phase 4, so Phases 1–3 only add code or switch callers. Each commit message ends with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Phase 0 — rebase and pin (S, ~30 min)
Rebase onto `feat/needs-you` (Decision 1) and run `node codex/scripts/sync.mjs plan --ref <sha>`. The
decisions template it writes under ignored `.builder/codex-sync/` is the checklist for Phases 1–5.
No commit: the rebased doc commit is the starting point.

### Phase 1 — vendor the verifier (L, ~2.6k lines copied, ~150 adapted, 2.9k lines of tests; ~1 day)
- **Files:** `codex/scripts/verify/{adapters,checkouts,classify,config,envpool,git,ledger,migrate,node-reporter,reports,run,schedule,select,serve,verify}.mjs`;
  `codex/scripts/config.mjs` (export the config-path resolver and `checkedOutBranch`).
- **Tests:** `codex/tests/verify-*.test.mjs` from `scripts/test/verify-*.test.mjs` (14 files, without
  `fleet-hooks`), with import paths rewritten. Add tests for the config precedence (`.codex/builder.md`
  wins, and a malformed first file is an error) and a service-survival test: two separate `node`
  invocations, request then `wait`, with the service gone in between.
- **Commit:** `feat(codex): vendor the verifier — verify: config, runner adapters, service and client`

### Phase 2 — `verify:` config and init (M, ~300 lines; ½ day)
- **Files:** `codex/assets/PROJECT.template.md` (`verify:` block; §Quality gates and §Deep set out;
  §Walk readiness `pending:`/`restart:`/`fixtures:`); `codex/scripts/config.mjs` (`agent_types:`
  parsed; Quality gates still parsed for `gate.mjs` until Phase 4); `codex/skills/builder/SKILL.md`
  (`$builder init` writes `verify:`, `init --update` migrates and shows the review);
  `codex/scripts/landing.mjs` (`pending:`, the 5.3 destructive ops, `restart:`/`fixtures:`).
- **Tests:** `config.test.mjs`, `landing.test.mjs`, `skills.test.mjs` (the template has no Quality
  gates; init names `migrate.mjs`).
- **Commit:** `feat(codex): verify: replaces ## Quality gates — init writes it, init --update migrates it`

### Phase 3 — build on the verifier; the walk · review test plan; the plan shape (M–L, ~500 lines; 1 day)
- **Files:** `codex/scripts/profile.mjs` (`TEST_LEVERS` walk · review, mapping of old `slice`/`end`
  and `profile:` values, recommendation, cost); `codex/scripts/lifecycle.mjs` (`approve --tests`,
  `list` labels and drops finished rows); `codex/scripts/route.mjs` and `history.mjs` (lever names);
  references `execution.md` (commit tier, verdicts before dispatch, regression → fix against the
  introducing task, phase tier as the only wait, landmines in briefs; no `gate.mjs`), `planning.md`
  (six-part task shape, pinned list, read the audit code map), `discovery.md` (audit code map,
  dropped program children), `profiles.md` (the test plan table).
- **Tests:** `profile.test.mjs` (levers, old manifests mapping onto walk · review), `lifecycle.test.mjs`,
  `route.test.mjs`, `skills.test.mjs` (no reference names `gate.mjs`; execution names `verify.mjs request`).
- **Commit:** `feat(codex): builds on the verifier — commit tier beside the build, phase tier the only wait; test plan walk · review`

### Phase 4 — land through the merge queue; a blocked landing asks; gates removed (L, ~600 lines changed, ~900 removed; 1 day)
- **Files:** `codex/scripts/lifecycle.mjs` (`prepare` → merge tier `--hold`; `deliver` → `release`,
  then history and landed migrations; `deliver --set-aside`; a needs-you park with the overlap list and
  the three choices; "ready to land" until the merge exists; `cleanup` leaves `<root>-verify/` alone);
  references `delivery.md` (READY = merge tier green + walk passed; the walk beside the merge tier;
  the wrap-up steps), `persistence.md` (every human-only park names a choice; resume raises needs-you),
  `profiles.md` (human walk with a held merge). Delete `codex/scripts/gate.mjs`, `gates-core.mjs`,
  `codex/tests/gates-core.test.mjs`, and Quality gates parsing in `config.mjs`.
- **Tests:** `lifecycle.test.mjs` with a real git fixture: green held merge → release lands the
  tested sha; target moved → exit 7 and the request runs again; an overlapping dirty target → needs-you
  park lists every file and changes nothing; set-aside → landed and changes restored; a conflict on
  re-apply keeps the stash. `skills.test.mjs`: no human-only park text without a choice.
- **Commit:** `feat(codex)!: land through the verifier's merge queue; a blocked landing asks — the gate system is removed`

### Phase 5 — archive, README, sync finish at 6.0.0 (M, ~250 lines; ½ day; waits for Claude 6.0.0)
- **Files:** `$builder archive` in SKILL.md and a `registry.mjs` subcommand (SHIPPED / CLOSED /
  DROPPED, one commit); `$builder status` shows the `verify.mjs status` line; `codex/README.md` (6.0.0
  section leading with `$builder init --update`, the verifier, adaptation boundaries updated: gates
  gone, merge queue, needs-you, the service-lifetime finding from Phase 1);
  `codex/upstream.json` and `codex/plugin.json` via `finish`. Move this file to
  `docs/plans/2026-11-01-codex-6.0-port.md` so it is not packaged (`packageHash` covers `codex/`).
- **Tests:** `registry.test.mjs` (archive), `skills.test.mjs`, then
  `node codex/scripts/sync.mjs finish --ref <6.0.0 sha> --report <decisions.json>` and
  `node codex/scripts/sync.mjs check` green. Get an independent review before `finish`, as the `$sync`
  skill requires.
- **Commit:** `feat(codex): Codex Builder 6.0.0 — sync Claude 5.2.1–6.0.0 (verifier, merge queue, needs-you landing)`

## 4. Size

| Phase | Size | Effort | Main risk |
|---|---|---|---|
| 0 Rebase and pin | S | 30 min | none |
| 1 Vendor the verifier | L | ~1 day | the service may not survive between tool calls (Decision 2) |
| 2 Config and init | M | ½ day | the migration's runner inference on configs only Codex reads |
| 3 Build on the verifier | M–L | ~1 day | prose drift between execution/planning/profiles |
| 4 Merge queue, needs-you, gates out | L | ~1 day | `lifecycle.mjs` landing transaction rewrite |
| 5 Archive, README, finish | M | ½ day | blocked on Claude 6.0.0 |

Total is about 4 days of focused work. Phases 1–4 can land on the port branch before Claude 6.0.0
ships; only Phase 5 waits for it.
