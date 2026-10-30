# Benchmark suite — pick the cases, t-shirt sized, fit the night — design

**Status:** draft for the owner's review · **Date:** 2026-10-29 · **Branch:** `feat/verifier` (ships in 6.0.0)

## Why

`/builder:benchmark` runs one fixture feature through builder, superpowers, GSD and plain Claude
Code. That shows the small path against other tools, but not where builder spends tokens and time on
real work, and not across sizes. The verifier benchmark (Task 24) tried to answer that with a gate
replay over every archived feature plus hand-prepared fleet runs: it ran for days, every new project
needed hand work, and nothing could be re-run without the person who set it up.

**What the owner wants:** a catalogue of benchmark **cases** — small, medium and large features from
real work and from builder's fixtures, each with a t-shirt size and an estimate — from which they pick
one, several or all, see the time and cost before launching, fit a night (≤ 12 h), and add new cases
later. The goal stays: find where builder's tokens and time go, and prove a change cuts them.

**Success:** `/builder:benchmark` offers every case with its size and estimate; a picked set runs
unattended in parallel lanes within its estimate (±25%); the report says, per case and per stage,
tokens, turns, minutes and cost against the case's baseline, and names the top places the time and
tokens went; adding a case is one file.

## Decisions

- **D1. One skill, two kinds of case.** `/builder:benchmark` keeps the fixture runs and gains a picker
  over a catalogue:
  - **fixture** — today's `bench/features/<name>` (tags, share, edit): builder alone or against
    superpowers / GSD / baseline, as now. In the repo.
  - **archived** — a feature already built and merged in one of the owner's projects: its spec is run
    again through the fleet, in a scratch clone at the feature's base commit with its spec commits
    cherry-picked, on the builder under test. **Local only** (below).
- **D2. Real-project cases never enter the repo.** They name the owner's projects and their paths, and
  builder's public text never names a consuming project. They live in `bench/local/` —
  git-ignored, like `.claude/skills/update-*/` — as `bench/local/cases/<id>.json` and
  `bench/local/projects/<project>.json`. Only the fixture cases and the empty-catalogue README ship.
- **D3. A case file** (`bench/local/cases/<id>.json`):
  `{ id, size: "xs"|"sm"|"md"|"lg"|"xl", kind: "archived", project: "<profile name>", feature,
  covers: "<one line: what this case exercises>", estimate?: { minutes, usd } }`. With no
  `estimate`, it is read from the feature's original archive row (its runs' minutes and cost).
  Fixture cases get theirs from the last report that ran them, else "no estimate yet".
- **D4. A project profile** (`bench/local/projects/<name>.json`) is what makes a scratch clone safe and
  runnable: the repo path; `agent_walk` overrides (every database, port, store and simulator the
  bench's own — never the human's containers, dev databases or booted simulator); the `verify:`
  block to add for a treatment run; files to place untracked in the clone (bench `.env`s, a local
  binary); and its `lane` resources (a port offset, a database-name prefix). One profile per project,
  reused by every case of that project. The Task 24 prep (`e2e-prep.mjs`, the bench env files, the
  hand-reviewed verify blocks) becomes the first profiles.
- **D5. The baseline.** An archived case compares against **its original archive row** by default —
  same spec, same machine, the builder the human runs. `--control` adds a same-day run on `main` (a
  checkout of builder's main, as Task 24's control) for any picked case, to separate model drift from
  builder's change; the picker recommends one control per size bucket.
- **D6. The picker.** `/builder:benchmark` with no feature: one multi-select of every case (fixture and
  local), each labelled `<size> · <id> — <covers> · ~<minutes> · ~$<usd>`, then one question for
  options (lanes, `--control` picks, `--budget`). Above it, per memory *one menu per screen*: what each
  bucket is for and the recommended set. `--budget 12h` picks the largest spread of sizes that fits;
  `--all` takes every case. The confirmation shows the schedule (lanes, order, estimated end time,
  total cost) as a plain review before one Run it / Not now.
- **D7. Lanes.** Cases run in `--lanes N` parallel lanes (default 3); at most one case per project per
  lane at a time and never two cases of one project at once (they share a profile's resources);
  longest-first packing so the wall clock is the longest lane. A lane's runs are detached processes
  like the fleet's; the suite outlives the session; `--status` shows each lane.
- **D8. The report** (`bench/results/<date>-suite/REPORT.md`, committed with case ids and sizes only —
  no project names; the per-case detail with names stays under `bench/local/results/`): a table per
  case (wall, tokens, turns, cost against baseline and control), a per-stage breakdown (brainstorm,
  spec, audit, plan, build, walk, verify, ship, merge — from the archive row's timing and the
  fleet's stages), plan length against spec length and fix rounds (the plan-format signal), gate
  share of wall time, and **the top 5 places tokens and minutes went** across the suite.
- **D9. Safety is the profile's job, checked before launch.** A dry run per picked case resolves its
  profile, refuses a case whose profile is missing, whose `agent_walk` still names a non-bench
  database URL, port of a running process, or `docker` command on a non-bench container, and prints
  what the clone will touch. Nothing writes into the project repo; the origin remote is removed from
  every clone.

## What changes in builder

| File | Change |
|---|---|
| `skills/benchmark/SKILL.md` | §Picker (D6), `--budget`, `--all`, `--lanes`, `--control`, `--status` per lane; the fixture flow unchanged |
| `scripts/bench-suite.mjs` (new) | `list` (catalogue + estimates), `plan` (schedule into lanes, the review), `run --detach`, `status`, `report`; cases resolved from `bench/features/` and `bench/local/` |
| `scripts/bench-case.mjs` (new) | one archived case end to end: clone, base + spec commits, profile applied, `fleet.mjs <feature> --into <target>` (the go-ahead's branch, else the archive row's, else main), archive row collected (from `e2e-prep.mjs`) |
| `scripts/bench-suite-core.mjs` (new) | pure parts: estimates, lane packing, budget fill, report tables — unit-tested |
| `bench/local/README.md` (new, committed) + `.gitignore` | how to add a case and a profile; `bench/local/*` ignored except the README |
| `bench/README.md` | the suite |

## Testing

Unit: estimate from an archive row; lane packing (longest-first, one project per lane, never two of a
project at once); budget fill; the safety check refusing each unsafe profile shape; the report's
tables from fixture rows. Integration: a stub fleet (`BENCH_FLEET`, as bench.mjs already uses) runs a
two-lane suite of fake cases end to end. The first real use is the overnight run of the candidates
chosen on 2026-10-29.

## Out of scope

Superpowers/GSD on archived cases (they cannot run an existing project's spec unattended); a hosted
catalogue; changing what any pipeline does to make a number better.
