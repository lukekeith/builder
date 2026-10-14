# bench — the pipeline benchmark

`/builder:benchmark` runs one small feature through builder at each build profile and through
superpowers and GSD, unattended, and reports time per step, what happened in each step, tokens,
cost, and whether the feature works. Design: `docs/specs/2026-10-13-benchmark-design.md`.

- `fixture/` — the project every run starts from: a notes CLI with its own tests and `.claude/builder.md`.
- `features/<name>/request.md` — the ask, given to every pipeline word for word.
- `features/<name>/accept.test.mjs` — acceptance tests the agent never sees, run after the feature lands.
- `results/<run-id>/REPORT.md` + `runs.json` — committed; the raw streams beside them are not.

Run it: `/builder:benchmark` (or `node scripts/bench.mjs run tags`). Watch it:
`/builder:benchmark --status`. Rebuild a report: `node scripts/bench.mjs report <run-id>`.

Add a feature: a new directory under `features/` with those two files; the acceptance test must
drive the CLI through `src/cli.mjs` with `NOTES_FILE` set, as `fixture/test/cli.test.mjs` does.
