# A benchmark you can trust — design

> 2026-10-23 · builder 4.12.1 · status: from the owner's go on the benchmark recommendations

## Why

The 4.12.0 run (`bench/results/2026-10-23-1336-tags`) could not tell whether the new test-plan
levers did anything: the recommended plan and `everything` both took 14 min. Digging into the
streams showed three things the report hides:

- **One rep is noise.** The 2026-10-14 runs ranged 805–956 s for near-identical work; the review
  lever's real saving (build 323 s vs 399 s) is smaller than that spread.
- **The orchestrator is two thirds of the time.** In the build lane, 287 s of 476 s was the
  controlling session itself — reading skills, writing briefs, ledgers and commits — against 147 s
  of subagents doing the work and 42 s of tools. Nothing in the report shows that split.
- **The fixture can't exercise the levers.** One app, three slices, a test suite that runs in
  seconds: per-slice testing has nothing to save, and an end walk is the same size either way.

## Decisions

- **D1 — Spread beside every median.** With `--repeat N > 1` the summary and the per-step table show
  `median (min–max)`, and the report says how many reps each figure is from.
- **D2 — The time split is a first-class column.** For every session and every step: *orchestrator*
  (time not inside a tool call), *agents* (inside `Agent`/`Task` calls), *tools* (every other tool
  call). Summary gains `Orchestrator · Agents · Tools`. Computed from each session's stream
  timestamps; a step's split is the part of the session inside that step.
- **D3 — A second, bigger fixture and feature.** Fixtures become selectable: `bench/fixtures/<name>/`,
  with a feature naming its fixture (`features/<f>/feature.json` `{ "fixture": "<name>" }`; absent →
  `notes`, today's fixture, moved to `bench/fixtures/notes/`). The new fixture **`notes-hub`** has two
  apps — `cli` (the notes CLI) and `server` (a small `node:http` API) — and a test suite made slow on
  purpose (a fixed per-file delay, `SLOW_TESTS_MS`, default 4000 ms, so a full suite run costs ~30 s).
  The new feature **`share`** spans both apps in ~10–12 slices: the server stores shared notes behind
  a share code with expiry and owner delete; the CLI gains `share`, `fetch` and `shares`. Hidden
  acceptance tests drive both apps end to end.
- **D4 — Release: a patch (4.12.1)** — the benchmark measures better; nothing a user reaches for by
  name changes beyond a feature argument.
