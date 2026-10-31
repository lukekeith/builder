# bench — the pipeline benchmark

`/builder:benchmark` runs one small feature through builder — `builder` (the recommended test plan)
and `builder-everything` (`tests: walk=full review=slice`, pre-set on the manifest
before the fleet runs) — through superpowers and GSD, and through plain Claude Code with no plugin (`baseline`), unattended, and reports time per step, what happened in each step, tokens,
cost, and whether the feature works. Design: `docs/specs/2026-10-13-benchmark-design.md`.

- `fixtures/<name>/` — the projects a run starts from, each with its own tests and `.claude/builder.md`:
  - `notes` — one app, a notes CLI with a test suite that runs in seconds.
  - `notes-hub` — two apps, `apps/cli` (the notes CLI) and `apps/server` (a `node:http` JSON API),
    a `verify:` suite per app plus a parse check each, and an `agent_walk` that starts the server on its
    own port. Its suites are slow on purpose — every test file waits `SLOW_TESTS_MS` (default
    4000 ms) and the files run one at a time, so both suites cost ~30 s — so per-slice testing and
    the end walk have something to save. Scoring runs them with `SLOW_TESTS_MS=0`.
- `features/<name>/request.md` — the ask, given to every pipeline word for word.
- `features/<name>/feature.json` — optional, `{ "fixture": "<name>" }`; without it the feature runs on `notes`.
  `tags` runs on `notes`; `share` (sharing notes through the server, ~10–12 slices over both apps)
  on `notes-hub`; `edit` (one small command on `notes`) is the xs case — its `feature.json` says
  `"expect": "in-chat"`, so builder building it in the chat is the path it measures, not a flag.
- `features/<name>/accept.test.mjs` — acceptance tests the agent never sees, run after the feature lands.
- `results/<run-id>/REPORT.md` + `runs.json` — committed; the raw streams beside them are not. `results/history.jsonl` —
  committed, one row per run of each case across builder versions (§Suite, History).
- `budgets.json` — turn budgets per step, by feature and config. The report's *Turns per step* table
  marks a step whose median goes over with ⚠. Lower a budget when a release beats it.

GSD's `--auto` may run the whole pipeline in its first session; the benchmark then stops after the session that verifies the phase and says so in the report.

Run it: `/builder:benchmark` (or `node scripts/bench.mjs run tags`; `run share` for the two-app feature). Watch it:
`/builder:benchmark --status`. Rebuild a report: `node scripts/bench.mjs report <run-id>` (runs from before the test plan, with
`builder-rush` / `-standard` / `-thorough` configs, rebuild as they were).

The fleet's own idle and run timeouts (`FLEET_IDLE_TIMEOUT_MS`, `FLEET_RUN_TIMEOUT_MS`) govern
builder's fleet sessions; `BENCH_IDLE_TIMEOUT_MS` and `BENCH_RUN_TIMEOUT_MS` govern the sessions the
runner starts itself. A vendored copy of builder (no `marketplace.json`) falls back to disabling only
`builder` when the installed-plugins list is unreadable, so the dry-run probe is the check there.

Scoring, on `main` after the run: the fixture's own `*.test.mjs` files, pristine (copied beside the
agent's, so an edited test can't pass itself), and the feature's `accept.test.mjs`, copied to
`<copy>/test/accept.test.mjs` — so it reaches the code relative to the repo root (`../src/cli.mjs`,
`../apps/cli/src/cli.mjs`).

Add a feature: a new directory under `features/` with `request.md` and `accept.test.mjs` (and
`feature.json` when it runs on a fixture other than `notes`). The acceptance test drives the code the
way the fixture's own tests do — the CLI with `NOTES_FILE` set, as `fixtures/notes/test/cli.test.mjs`
does; for `notes-hub`, the server started on a free port and the CLI pointed at it. Prove it before
committing it: green against a reference implementation in a scratch copy of the fixture, red
against the untouched fixture.

Add a fixture: a new directory under `fixtures/` with a complete `.claude/builder.md` (its
`agent_walk.claude_args` is `{claude_args}`, filled per run), no dependencies, and tests under
`*.test.mjs`.

## Suite

`/builder:benchmark` with no feature opens the suite: `scripts/bench-suite.mjs`, a catalogue of sized
cases scheduled into lanes that fit a night. Design: `docs/specs/2026-10-29-benchmark-suite-design.md`.

- **Two kinds of case.** A *fixture* case is a `features/<name>/` directory (its `feature.json` carries
  `size` and `covers`) run through `bench.mjs` on its fixture. An *archived* case is a feature a real
  project already merged: its spec is run again through the fleet in a scratch `git clone --no-local`
  of the project at the feature's base commit, with `origin` removed, on the builder under test.
  Nothing is ever written into the project repo. Archived cases live in `bench/local/` (see its README).
- **Sizes** are `xs`, `sm`, `md`, `lg`, `xl`, in that order; the picker explains each and the plan sorts by it.
- **Lanes.** Cases are packed longest first into `--lanes N` lanes (default 3), each starting on the lane that is free
  earliest; two cases of one project never run at the same time, and all fixture cases count as one project
  (`bench.mjs` holds one global lock). `--budget 12h` (a night) picks cases round-robin across sizes while the packed wall time fits.
- **Estimates** come from the newest fixture run, or from the case's archive row; a case with none is skipped
  by `--budget`. A result within 25% of its estimate is on target.
- **Baseline vs control.** The baseline is what the case measured when it first landed. A control runs a picked case again
  on builder's `main` (`--control <id,…>`) beside the builder under test, so a change in the number can be told from a
  change in the day. Controls fill lanes but do not count against `--budget`'s pick.
- **Running.** `plan` shows the schedule and every archived case's dry run — what its clone will touch — and refuses two
  picked projects whose profiles name one port (they may run at once); `run … --detach` launches it (a suite outlives the
  session; `run` without `--detach` is refused); `run --resume <suite-id> --detach` re-runs waiting, cut-off and refused
  items but not parked or timed-out ones; `status` and `report <suite-id>` show where it stands. `stop` stops a running
  suite safely: each running case stops its fleet, the fleet's sessions and what its setup started, runs its teardown and
  is marked `stopped`; nothing more starts; the reports are written and the lock released. `--resume` re-runs stopped
  items, and refuses while a case an earlier attempt started is still alive. Stop a suite with `/builder:benchmark --stop`
  (or `bench-suite.mjs stop`), never `kill -9`: a SIGKILL can't be trapped and leaves each running case's fleet going.
- **The builder under test is pinned.** The suite runs on a detached worktree at `--builder`'s HEAD
  (`$TMPDIR/bench-builder-<sha12>`, removed when the suite ends); a checkout with uncommitted changes to tracked files is
  refused unless `--allow-dirty`, which runs it as it is. `suite.json` and both reports' headers carry the treatment's SHA
  and, with controls, main's.
- **Results.** `bench/local/results/<suite-id>/` (git-ignored) holds `suite.json`, one folder per attempt and the named
  `REPORT.md`; the committed `bench/results/<date>-suite/REPORT.md` carries case ids, sizes and each status's category
  only (done, failed, refused, parked, timed out, stopped) — the detail is in the named report. A second suite on one
  date writes `bench/results/<date>-HHMM-suite/REPORT.md` instead.
- **History.** `bench/results/history.jsonl` (committed, append-only) holds one row per finished case or fixture config,
  across builder versions: the suite appends its cases when it writes its report, `bench.mjs` its configs when a run ends
  (in the builder repo, or wherever `BENCH_HISTORY` points). A row carries the case id, size, builder label, outcome, the
  status's category, wall, cost, tokens, turns, the build lane per plan task, stage minutes, plan and spec lines, fix
  rounds and findings — never a project name, a path or a status's detail; a rebuilt report adds nothing, a re-run is a
  new row. `bench-suite.mjs history [<case>…] [--since <date>]` (`/builder:benchmark --history`) shows each case's runs
  in time order with the change against its previous builder, and marks `⚠ regressed` a case whose newest run is over 10%
  worse on tokens ÷ task, wall or cost than the one before, or landed before and does not now. `history --backfill`
  appended the results already on this machine as `schema: 0` rows (measured before the per-task build numbers and the
  corrected stage split; a result that has them is `schema: 1`); schema-0 rows are shown but never flagged against.
  Regressions compare a case's newest run with its newest earlier run under a different builder. Outside the builder
  repo a fixture run writes no history unless `BENCH_HISTORY` is set. Design: `docs/specs/2026-10-31-benchmark-history-design.md`.
- **Before a run** `plan` warns when the shell sets `DATABASE_URL` or `PG*`: every case's setup, fleet and sessions inherit them.
- **Clones** live outside every repo — `$BENCH_TMP/<suite-id>/<item>/clone` (`$TMPDIR/bench-suite` by default) — so no
  repo's `CLAUDE.md` loads into a case's sessions; a clone inside any git repo is refused.
- **Env.** `BENCH_LOCAL`, `BENCH_SUITE_OUT`, `BENCH_FLEET`, `BENCH_CASE`, `BENCH_FIXTURE_RUNNER` (test stubs); `BENCH_TMP`; `BENCH_HISTORY` (the history file);
  `BENCH_SETUP_TIMEOUT_MS` (20 min), `BENCH_CASE_FLEET_TIMEOUT_MS` (24 h), `BENCH_CASE_KILL_GRACE_MS` (10 s).
