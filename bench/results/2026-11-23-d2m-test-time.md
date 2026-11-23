# Where d2m's fleet time goes — 2026-11-23

Measured from the fleet that was running at the time, not re-run. The sources:

- the fleet's streams (`d2m/.builder/fleet/logs/*.jsonl`) and session transcripts
  (`~/.claude/projects/-Users-lukekeith-www-d2m-fleet-*`), where each tool call is timed from
  `tool_use` to `tool_result`;
- the verifier's requests, its per-test ledger (`d2m/.builder/verify/requests`, `results.jsonl`) and
  its suite reports (`reports/<id>/*.out`);
- `fleet.json` run timing.

`scripts/test-cost.mjs` now produces the headline and findings 1, 5 and 6 on any repo. Finding 9's
breakdown by agent came from a one-off script; E6 in
`docs/specs/2026-11-23-test-efficiency-bench-design.md` turns it into a tool.

## Headline

Building is cheap and verification is not. Most of verification's time doesn't go to running more
tests than needed. It goes to waiting, to contention, and to runs that end with no verdict.

| | Wall | Of which |
|---|---|---|
| project-new-screens, build run 3 (91 min, still building) | orchestrator session 144 min | **112 min blocked on `verify.mjs wait`** · implementers 12 min · audits 12 min |
| project-channel-resolver, build run 3 (10-31, builder 5.5) | 148 min | **~98 min orchestrator waiting on gate jobs** · implementer test runs 21 min · typecheck 5 min · reviewer test runs 5 min |
| Verifier, 2026-11-23 03:57–06:40Z | ~231 min of runs | **every run ended `env-broken`: zero verdicts** |

## Findings

| # | Finding | Evidence |
|---|---|---|
| 1 | **No run produced a verdict.** server-test ran past the per-suite cap in every run, so each one ended env-broken and was asked for again. The runs took 19–42 min each. | 7 completed requests, all `broken: server-test timed out after 15m` |
| 2 | **Postgres is out of connections.** It allows 100 and 96 were open: 65 on the dev `d2m` database and 13 for each verifier database. Tests then fail at startup with `PrismaClientInitializationError: Too many database connections`. Those are recorded as test failures, not as an environment problem. | `pg_stat_activity`; `reports/mwsuyuki-db416e/1-server-test.out` (1,900 lines, mostly that error) |
| 3 | **d2m serializes its database tests by design.** `resetDb()` takes one advisory lock, `SUITE_LOCK`, and holds it until the process exits. `node --test` starts files in parallel, but every database file queues on that one lock. The suite's wall time is therefore the sum of the database files' times. The "slow first test" in each file (30–136 s, while the rest take milliseconds) is the wait for the lock. | `packages/db/test/helpers/db.ts`; the slowest ledger entries are all the first DB test in an mcp file (min 30–68 s, max 70–136 s across 6 runs) |
| 4 | **Selection can't narrow server-test.** The import graph is correct, but `services/screens.ts` and `contracts/routes.ts` are hub files: a branch that touches 11 files reaches all 266 server test files. Even a phase run that reused 218 earlier results still ran all 266 server files. | `impact.mjs` on project-new-screens: 61 files selected because they "reach services/screens.ts", 35 through contracts/routes.ts, …; request `mwsu5bmk` |
| 5 | **One commit went through the full suites three times, two of those at once.** Commit and phase requests for `a8a0167` ran concurrently from 05:16 to 05:38, and a phase retry followed. That's about 84 verifier-minutes on one commit with no verdict. The commit-into-phase fold (`0e322ac`) didn't fire. | requests `mwss5f4g` (commit), `mwss5iaz` and `mwsu5bmk` (phase), all at `a8a0167` |
| 6 | **Merge-tier runs repeat the whole suite after every env-broken result.** project-channel-resolver had 5 merge runs in 2h40m, each running every suite including e2e, about 40 min per run. | requests at 03:57, 04:35, 05:16, 05:38 and 06:21 |
| 7 | **Raising the cap from 15m to 45m (d2m `1dfc57b4`) makes each failed run cost up to 3× more** unless the contention is fixed too. Under it, server-test finished in about 16 min in the 06:21 merge (855 pass, 1 fail). | `reports/mwsvno09-08dafa` |
| 8 | **Cheap tests aren't the problem.** 2,447 of 3,263 tests always finish in under 200 ms. Nearly all the time is in database-backed files (db-test, mcp-test, server-test). | ledger, 7 runs |
| 9 | **Implementers run broad suites themselves.** In resolver run 3, 31 broad runs (`packages/mcp/test/**`, `project-changes*.test.ts`) took 14.5 min, against 6.4 min for 60 targeted runs. Then the gates ran the same suites again. | stream `project-channel-resolver-03.jsonl` |

## What this does not show yet

- **Whether any test is redundant**, meaning it never catches a regression that another test would
  miss. d2m's ledger starts on 2026-11-07 and holds 7 runs, too little failure history to say. E4 (mutation
  replay) and E5 (tier redundancy) are designed to measure it.
- **The suite's real work time when it isn't contended.** Every run tonight overlapped other runs,
  and the times summed per test include waiting for the lock. E1, E2 and E3 measure it.
- **Any other repo.** The design is meant to produce this same table for every fleet.
