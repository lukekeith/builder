# Fleet time — implementation plan (5.3.0)

Spec: `docs/specs/2026-10-26-fleet-time-design.md`. One branch, `feat/fleet-speed`, a commit per step.

1. **Timeline** — `fleet-core.mjs` `stagesFromCommits`, `walkFacts`, `wallSummary`; `fleet.mjs`
   run `start`/`end`, `noteStages` before the merge, `readWalkFacts` in `noteFacts`, `chargeBatch`,
   archive fields `wallMs`/`stages`/`walkQueueMs`/`walkRounds`/`parks`/`walk`; status heading.
   `commands/fleet/status.md`; every `/builder:fleet --status` mention → `/builder:fleet:status`;
   `vendor.mjs` copies `commands/`. Tests: fleet-core unit tests, the end-to-end landing row.
2. **Destructive check** — `forwardHalf`, `destructiveMigration` in `fleet-core.mjs`. Tests per tool.
3. **Untagged e2e** — `looksE2E`, `unwalkedE2E`, `@local` in `gates-core.mjs`; `gate.mjs` summary.
4. **Lane split** — `SPLIT = Boolean(AW.start)` for `laneOf`/`decide`; `walkOne` runs `@walk`
   gates after sign-off. Test: one walk at a time, verify in the pool.
5. **Launch check** — `envPreflight` + `--no-env-check`; the walk lane awaits it.
6. **Dead env** — `envDied`/`smokeOk` in `drive`; batch smoke and exit-3 restart.
7. **Line quoting** — `lineQuote`, `readLineMemo`/`writeLineMemo`; `impactOf({ since })`; `gate.mjs`
   wiring. Test through `gate.mjs` with a scoped line.
8. **Parallel** — `@parallel`, `startCommand`/`waitCommand`; build SKILL end gates beside the review.
9. **Dev DB** — `devDbPending` + `landedMigrations({ pending })`; template and init.
10. **Plan writers** — `planWriters` in config; plan SKILL step 2.
11. **Docs** — verify, REFERENCE, AGENT-MODE, fleet SKILL, template, README, CHANGELOG, preview.
