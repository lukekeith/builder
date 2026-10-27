# Fleet time — where it goes, and less of it lost (5.3.0)

## Why

One consuming project's fleet run (a FastAPI + Next.js monorepo, `slice=own end=everything
review=end`) took about 3½ hours a feature from start to merge. Building was about a fifth of it.
The rest was fixed stages — plan ~25–30 min, final review ~15–22, end gates ~32–40, verify 28–69 —
and the walk lane, which halved once the walk env stopped breaking under gates. The comparison had to
be rebuilt from commit timestamps by hand: the fleet recorded agent-run time per lane only, and the
walk's size and rounds were deleted with the workspace at merge.

Every change below must hold for a project with no walk env, one with no web app, one with a single
test command, and one with `commit: manual`.

## What the code did (5.2.0)

- **Instrumentation** — each run recorded `ms` (Claude's duration) and a lane, no timestamps
  (`fleet.mjs` runClaude); `--status` averaged lane sums of the last five landings — agent time, not
  wall-clock. `condense.mjs --ship` deleted the workspace (walk.md, round reports).
- **Duplicate gates** — the build lane ran `gate.mjs --deep <apps>` at the end; verify ran it again.
  The set memo hashes the app's whole tree (the deep set: everything but the registry), so any walk
  fix re-ran every suite; with a `@walk` line in the deep set the memo key was split per lane, so
  verify could never quote the build lane's run.
- **Lane split** — verify and fix rounds left the walk lane only when walks were batched
  (`start` and `batch > 1`); one at a time, they ran beside the env, in the folder it served from.
- **Env failures** — only a gate's exit 3 or readiness's restart line recovered without a park; a
  walk judged against a dead env became `## Fixes`.
- **Migrations** — "the dev DB is behind" came from git alone; the destructive check matched raw SQL
  over the whole file (a drop in `downgrade()` blocked an additive migration) and missed ORM
  operations in the upgrade path (`op.drop_column`, `remove_column`, `dropTable`, `RemoveField`).
- **Plan** — 87–88% of PLAN.md is code by design (PLAN-FORMAT); implementers then take 1.3–1.75 min a
  task on the cheapest tier. Kept. Task overhead measured at ~7% — task size left alone.

## Decisions

| # | Decision | Ruling |
|---|---|---|
| D1 | Stage timing | From the feature branch's own commits at landing (`stagesFromCommits`) — every step already ends in a commit with a known subject; park time kept apart. Runs record `start`/`end`. No new agent work. |
| D2 | Walk metadata | `walkFacts` reads walk.md and `agent-walk/round-*/report.md` in `noteFacts`, before ship deletes them, into the archive row. |
| D3 | Status estimate | Mean wall-clock start → merge by stage when rows have it; agent time per lane for older rows. |
| D4 | `/builder:fleet:status` | `commands/fleet/status.md` — a plugin command in a subfolder is the only shape that registers a two-level name (a skill's `name:` can't); `--status` still works. Vendored copies carry `commands/`. |
| D5 | Gate quoting | Per line (`.builder/gates/lines.json`): quoted when nothing changed since its green head is the set's input, or — `@scoped` — the import graph from that head reaches none of its tests. Never `@delta`, `@known-red`, `@walk`, `<…>`, a dirty tree, `--force`, `--whole`. A monolithic command quotes only on unchanged inputs. |
| D6 | Parallel gates | Opt-in `@parallel` per line (two suites may share a test DB); lines start together across sets. The end gates run beside the final review by default — re-run after its fix wave, quoting what it doesn't reach. |
| D7 | Lane split | Whenever `agent_walk.start` is set. Without it the env is the human's own checkout and nothing moves. |
| D8 | Untagged e2e | Under the fleet only: not run, reported unverified with the fix; `@local` opts out. |
| D9 | Env check at launch | Default with `start`: start/smoke/stop in a throwaway worktree, beside the build lanes; the walk lane waits for it; a failure is a note. `--no-env-check`. |
| D10 | Dead env | Default with `start` + `smoke`: smoke after every walk run / batch session; red → drop the run's doc-only commits, restart without reset, walk again once. A commit that touched code is never dropped. |
| D11 | Dev DB behind | Ask §Walk readiness `status:` (exit 0 = current); without it, "may be behind". |
| D12 | Destructive check | Forward half per file kind; each tool's operations; comments stripped; unknown kind held. Errs to a note. |
| D13 | Plan writers | Opt-in `plan_writers: per-app`; header and Phases written first fix numbering; a cross-app interface check before the usual checks. |
| D14 | Task size | Unchanged — overhead ~7%; folding loses blame and the red-green cycle. |

## Measure after release

Per feature, from the archive's `stages`: end gates and verify (D5, D6), walk and parked (D7, D9,
D10), plan (D13, where enabled); quoted vs run lines in verify's gate output; parks whose cause was
the env. D5 and D6 want a field test in two consuming projects before `@parallel` is suggested by
init for every repo.
