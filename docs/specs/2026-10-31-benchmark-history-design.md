# Benchmark history — one committed record of every case, across builder versions — design

**Status:** approved by the owner in conversation · **Date:** 2026-10-31 · **Branch:** `feat/verifier`

## Why

Benchmark results are saved per run — `bench/local/results/<suite>/` (git-ignored, full detail),
`bench/results/<date>-suite/REPORT.md` (committed, ids and sizes only), and each fixture run's
`runs.json` — but nothing lines them up over time. Answering "is builder getting better?" means
digging through folders by hand, and formats changed between runs. The owner benchmarks to find and
remove wasted time and tokens; that needs the same case compared across builder versions, every run.

## Decisions

- **D1. One append-only file, committed: `bench/results/history.jsonl`.** One row per finished case or
  fixture config, appended when its result is written (suite cases when the suite writes its report;
  fixture runs when `bench.mjs` writes `runs.json`). Never edited, never deleted; a re-run is a new row.
- **D2. A row carries no project name.** Fields: `at` (ISO), `suite` (suite id or fixture run id),
  `case` (id), `size`, `kind` (`archived` | `fixture`), `config` (fixture config, else null), `builder`
  (`<version>+<sha>[-dirty]`), `control` (bool), `replan` (`prefix` | `from-audited` | null),
  `outcome` (`landed` | `parked` | `failed` | `timed out`), `reason` (the status's category only, as the
  committed report prints it — never a path or project text), `wallMin`, `costUsd`, `tokens`, `turns`,
  `build` (`{ tokens, turns, tasks, tokensPerTask, turnsPerTask, peakCtx }` for the build-lane session(s),
  null when none ran), `stages` (minutes by stage), `planLines`, `specLines`, `fixRounds`,
  `findings` (`{ critical, important, minor }`), `schema` (an integer, starting at 1). Unknown → null.
- **D3. `bench-suite.mjs history [<case>…] [--since <date>]`** prints, per case, one row per run in time
  order with the builder label, outcome and the key numbers, and the change against the case's previous
  run under a different builder. A case whose newest run is worse than the one before by more than 10%
  on tokens per task, wall, or cost — or that landed before and does not now — is marked `⚠ regressed`.
  `/builder:benchmark --history` shows it.
- **D4. Backfill.** A one-time `bench-suite.mjs history --backfill` appends rows for the results already
  on this machine — the `bench/local/results/*-suite/*/result.json` cases and the fixture runs under
  `bench/results/*/runs.json` — each with `schema: 0` (measured before the per-task build numbers and
  the corrected stage split existed). The history view shows schema-0 rows but never flags a
  regression against one.
- **D5. What it never does.** Write a project name, a path, or a status's detail; rewrite or reorder an
  existing row.

## Testing

Unit: a row from a suite Result and from a fixture run carries every field and no project name (a
status naming a path stays out); the history view orders rows, computes per-case deltas, flags a >10%
regression and a landed→parked one, and never flags against a schema-0 row. Integration: a stub suite
run and a stub fixture run each append exactly one row per case/config; backfill is idempotent (a second
backfill appends nothing).
