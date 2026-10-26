# bench — the pipeline benchmark

`/builder:benchmark` runs one small feature through builder — `builder` (the recommended test plan)
and `builder-everything` (`tests: slice=own+app end=everything review=slice`, pre-set on the manifest
before the fleet runs) — through superpowers and GSD, and through plain Claude Code with no plugin (`baseline`), unattended, and reports time per step, what happened in each step, tokens,
cost, and whether the feature works. Design: `docs/specs/2026-10-13-benchmark-design.md`.

- `fixtures/<name>/` — the projects a run starts from, each with its own tests and `.claude/builder.md`:
  - `notes` — one app, a notes CLI with a test suite that runs in seconds.
  - `notes-hub` — two apps, `apps/cli` (the notes CLI) and `apps/server` (a `node:http` JSON API),
    gates per app with a `@typecheck` line each, and an `agent_walk` that starts the server on its
    own port. Its suites are slow on purpose — every test file waits `SLOW_TESTS_MS` (default
    4000 ms) and the files run one at a time, so both suites cost ~30 s — so per-slice testing and
    the end walk have something to save. Scoring runs them with `SLOW_TESTS_MS=0`.
- `features/<name>/request.md` — the ask, given to every pipeline word for word.
- `features/<name>/feature.json` — optional, `{ "fixture": "<name>" }`; without it the feature runs on `notes`.
  `tags` runs on `notes`; `share` (sharing notes through the server, ~10–12 slices over both apps)
  on `notes-hub`; `edit` (one small command on `notes`) is the xs case — its `feature.json` says
  `"expect": "in-chat"`, so builder building it in the chat is the path it measures, not a flag.
- `features/<name>/accept.test.mjs` — acceptance tests the agent never sees, run after the feature lands.
- `results/<run-id>/REPORT.md` + `runs.json` — committed; the raw streams beside them are not.
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
