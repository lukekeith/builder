# Test-efficiency benchmark — design

**Status:** proposal. **Why:** `bench/results/2026-11-23-d2m-test-time.md`. On d2m, verification took
about 3/4 of a feature's wall time, and none of tonight's verifier runs ended with a verdict. Any
change to builder's testing should come from measurements like these, taken on any repo, not from
how a fleet feels.

## Principles

1. **Measure before changing.** Every proposed change names the experiment that justifies it, and a
   threshold set before the experiment runs (see Decision rules below).
2. **Most experiments need no agents.** Test time can be replayed against history that has already
   landed: fixed commits, fixed suites, no LLM. Such runs are cheap, deterministic and repeatable, so
   they can run on every fleet repo. Only E6 reads agent sessions, and it only reads them.
3. **Same table for every repo.** E0 is always on. E1–E5 run against any repo with a `verify:`
   block, through one command.

## E0 — always-on accounting (every fleet, every run)

Today, answering "where did the time go?" took ad-hoc parsing of streams and the ledger. E0 has the
fleet and the verifier record it as they run.

**Recorded for each verifier request:**
- queued ms and run ms;
- each suite's wall ms and outcome;
- selected and reused file counts, and the top three reasons for the selection;
- `duplicateOf`: the request that ran, or is running, the same sha and suite;
- the verdict: `green`, `red`, `env-broken`, or `cut` (superseded).

**Recorded for each fleet run:** agent ms, verifier-wait ms, gate-wait ms, test-command ms by role
(implementer, reviewer or orchestrator), broad vs targeted.

**Kept:** the verifier's requests and `results.jsonl` are never pruned. d2m's history starts on
2026-11-07 because its verify directory was recreated then, not because anything was removed.

**Reported** by `node scripts/test-cost.mjs [--since 7d]` (built), per feature and fleet-wide:
- **verification share** = (verifier wait + gate wait) / wall;
- **no-verdict minutes**: runs that ended env-broken or were superseded;
- **duplicate minutes**: the same sha and suite run again;
- **retry minutes**.

These four numbers are the fleet's test-efficiency KPIs, and every later change is judged against
them.

## Experiments (`node scripts/test-bench.mjs <exp> --repo <path> [--sha <sha>]`)

E1–E3 are built: `floor`, `contention` and `serial`. Each runs in the bench's own checkouts
(`<repo>-bench/co/<n>`, registered as worktrees of the repo) at a fixed sha, by default the
target's tip. It uses the repo's own `verify:` suite, with the verifier's setup, database template,
leases and runner command. It refuses while the repo's verifier or fleet is busy (`--force` runs
anyway and marks the row). Each run appends a row to `<repo>/.builder/bench/test-bench.jsonl`, and
a finished study is copied into `bench/results/`. E3's option (c), one database per process, needs
the repo's own test harness changed, so the bench measures (a) and (b) only.

| Exp | Question | Method | Output |
|---|---|---|---|
| **E1** Floor and variance | How long does each suite take on an idle machine, and how much does that vary? | Each suite ×3, alone, at one sha. | Wall time, per-file time, coefficient of variation, flaky tests |
| **E2** Contention curve | How many runs at once can the machine and its database take? | server-test (or the slowest suite) at 1, 2, 3 and 4 concurrent runs, with and without the dev server's connections open. Sample `pg_stat_activity` throughout. | Wall time(n), connection errors, peak connections, p95 per file. This sets `workers` and `db.max` from data, not guesses. |
| **E3** Lock-wait vs work | How much of the suite is waiting? | (a) Each DB-backed file alone, one after another: Σ of actual work. (b) The normal parallel run. (c) Parallel with one database per process, cloned from a template (`CREATE DATABASE … TEMPLATE`). | serialization ratio = parallel wall / Σ work; the speedup (c) would give |
| **E4** Selection precision and recall | How many selected tests could catch this change? | For the last K merged features (fleet `archive.jsonl`), mutate the changed lines (negate conditions, return early, drop calls). Run every test to find which ones kill each mutant; that is the ground truth. Compare the selection strategies: **S0** everything; **S1** the import graph at any depth (today's); **S2** the import graph to depth 2; **S3** direct importers plus co-change; **S4** a coverage map, one `NODE_V8_COVERAGE` pass per file, selecting tests that execute the changed lines. | Per strategy: recall (mutants caught / caught by S0), cost (selected file time), and the Pareto table. **This is the measure of "how much testing is unnecessary".** |
| **E5** Tier redundancy | Do the commit, phase and merge tiers, and the agents' own runs, re-test inputs that haven't changed? | From E0 history: for each (test file, tier), hash the file's dependency closure. A re-run with the same hash is a duplicate. For each real regression, record which tier caught it first. | Duplicate minutes per tier; regressions caught per tier. A tier that never catches anything first is a candidate to drop. |
| **E6** Agent test behaviour | What do implementers and reviewers run, and how often do they repeat it? | Parse the stream as the prototype does: classify each test command as broad or targeted, and flag a re-run with no edit in between. | Minutes by role and class; repeats with no change |

## Decision rules (set now, before the results)

- **Selection.** Adopt strategy S as the default if it keeps **≥ 98% mutant recall** on every
  measured feature and costs **≤ 50%** of S1.
- **Concurrency.** Set default `workers` and `db.max` to the largest n where wall time(n) ≤ 1.2 ×
  wall time(1), with no connection errors.
- **Database per process.** Recommend it in `/builder:init` if E3's speedup is ≥ 2× on two or more
  repos.
- **Tiers.** Drop or merge a tier if, across ≥ 20 features, it catches **0** regressions first and
  costs ≥ 10% of verification minutes.
- **Agent runs.** Restrict implementers to targeted runs if broad runs cost ≥ 25% of implementer test
  time and E5 shows the same tests run again at the next tier.
- **No-verdict minutes.** Any fleet whose E0 reports > 20% no-verdict minutes is a defect, fixed
  directly without a benchmark.

## Defects these measurements found

1. **Fixed: the commit and phase tiers ran the same sha at the same time.** The `0e322ac` fold
   needed a green run below the sha to measure the commit run's range from. A branch whose every run
   was env-broken had none, so it never folded. It now measures from the fork point when there is no
   green, and folds when only registry commits lie between that point and the phase run's `--since`.
2. **Named; no fail-fast yet: "Too many database connections".** A suite cut at its timeout now says
   how many tests had already failed because the database refused connections. Failing fast before
   a run would need a threshold (how many connections a suite needs), and E2 measures that. No
   threshold is set until E2 has run.
3. **Open: an env-broken run is retried at once, under the same conditions.** The backoff needs E2's
   numbers too. E0 already reports retry minutes.

## Order of work

1. **E0** first. It's cheap and every later decision rests on it.
2. **E1–E3 on d2m**, while the fleet is idle. They give the floor and the contention numbers.
3. **E4** on d2m plus one other consumer (truesheet or makeready), so a result isn't specific to one
   repo.
4. **E5** once E0 has two weeks of history.
5. **Defects 2 and 3**, once E2 has measured how many connections a suite uses.
