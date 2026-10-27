# Token economy, visible parks, finer progress, and archiving finished specs — design

**Status:** approved 2026-10-27 ("go in your recommended order"). Release: 5.4.0 (minor — a new skill,
new optional config keys).

## Why

A field report from one consuming monorepo (5.2.0, `slice=own end=everything review=end`) and 35 run
streams from four other projects (4.14.3–5.2.0) agree on where fleet money goes:

- **The build-lane orchestrator** is one `claude -p` that runs audit → plan → build in one context
  (`fleet.mjs:688`, `AGENT-MODE.md:88`). It loads three docs bundles (audit 60KB, plan 52KB, build
  65KB) and then reads the whole `PLAN.md` (`EXECUTION.md:73`; 386KB in the field report). It holds
  **186–306k tokens at its first implementer dispatch** and re-reads that every turn, on Opus. Opus is
  80–90% of every run's dollars; the orchestrator alone about half.
- **Plan writers**: 12 dispatches, 99M context, peaks to 525k, all Opus.
- **Sub-agent start-up**: every dispatch is `general-purpose`. Measured on Claude Code 2.1.311: a
  `general-purpose` sub-agent starts at 19–24K (skills list ≈10.5K, built-in schemas ≈4K, deferred MCP
  ≈4.5K) **plus the project's CLAUDE.md in full** (12K in the field report). An agent with a `tools:`
  list starts at 4.3K; MCP schemas are already deferred, so "105 tools" was not the cost.
- **Briefs** paste all of SPEC §Testing and §Decisions into every task (`dispatch.mjs:206-209`) and
  §Global constraints twice (brief and prompt); 16 of 121 implementers paid for their brief twice
  because `cat` overflowed to a persisted file.
- **Measurement** is per run only (`fleet.mjs:728`), misses cache-creation tokens
  (`fleet-core.mjs:268`), and the archive's `tokens` is the orchestrator's thread alone while
  `costUsd` is everything. Per-dispatch numbers needed hand-parsing of logs that are pruned.

Not true, and not changed: task reviews are not run inline by the orchestrator (under `review=end`
there are none, `build/SKILL.md:60`; under `review=slice` each is its own agent); one fix wave per
final review stays (measured, `EXECUTION.md:299-302`).

Three asks from the same user ride along: a park says nothing in the CLI; the fleet's percentage
stalls then jumps; finished specs stay in `/builder:status` and leave heavy files behind.

## Decisions

| # | Decision |
|---|---|
| D1 | **Measure per dispatch.** The fleet folds a summary of each run's stream into its `timing[]` entry as it streams: the orchestrator's turns / start / peak / summed context, and per Agent dispatch its kind, task, model, agent type, turns, start, peak, sum. Cache-creation tokens and per-model cost join `tokens`. The archive row gains `byKind` (totals per dispatch kind), `orchestrator`, `costByModel` and `quality` (final-review findings, fix rounds, walk rounds, parks). `tokens` keeps its keys and is documented as the orchestrator's thread. |
| D2 | **Builder ships its own agents** in `agents/`: `implementer` (Read, Edit, Write, Bash, Grep, Glob), `implementer-skills` (the same + Skill, for a recipe that can't be resolved to a path), `reviewer` (Read, Grep, Glob, Bash, Write). No MCP, CLAUDE.md still loads — house rules are a quality floor. `dispatch.mjs` prints the agent type on every dispatch, with "general-purpose if that type is not available". Walk, audit, plan writers and verify stay `general-purpose`. |
| D3 | **`agent_types:` config key** (optional) opts a project back out: `agent_types: general-purpose` for every kind, or `implementer=<type>, reviewer=<type>` (a project's own `.claude/agents/*` with its MCP tools). |
| D4 | **Recipes resolve to paths** where they can: a builder skill, a REFERENCE section, or the project's `.claude/skills/<name>/SKILL.md`. Only an unresolved recipe takes `implementer-skills`. |
| D5 | **Briefs:** §Global constraints and the craft-skill paths live in the dispatch prompt only, not again in the brief. The implementer reads its brief with the Read tool, never `cat`. Of the four craft skills, TDD and verification are read before starting; debugging and receiving-code-review at the moment each names. §Decisions and §Testing stay whole (filtering them needs a per-task `Binds:` line and a field test — not now). |
| D6 | **A fresh orchestrator per stage in the fleet's build lane.** Under `--no-dev-env`, resume ends the run after the audit's commit and after the plan's go-ahead commit; the fleet's existing `again` loop starts the next run fresh. The run cap rises 12 → 14 so two stage boundaries don't eat retries. |
| D7 | **The build orchestrator reads the plan's index, not the plan.** `plan-slices.mjs <folder> --brief` prints the header, Global Constraints, the Phases table and per task its App, Phase, Recipe, Files and Interfaces; `--scan` prints the pre-flight scan's mechanical rows (shared files/interfaces between tasks, Files outside the task's App). The orchestrator reads a task block only when a row needs judgment. |
| D8 | **`plan_writers: per-phase`** (opt-in): one writer per phase (a phase over 6 tasks split in two), each given what `per-app` gives plus the audit digest; the cross-writer interface check runs at every writer boundary. **The audit writes `<WS>/audit-digest.md`** — per app, the files its agents read with file:line and one line on what is there — and plan writers read it before reading code. |
| D9 | **Parks are told.** The statusline shows `⛔ <feature>: <why>` and keeps showing parked/failed rows after the fleet exits; the session brief lists them with their next step; a timed-out run keeps its cause; `--status` and the statusline warn when a running feature has had no commit or ledger tick for 45 minutes. |
| D10 | **Progress moves per task** — brief written 0.2, report written 0.7, ticked 1.0 of the task's share; plan by drafted tasks; walk by rows written — and a parked feature keeps its last progress instead of reading 0%. |
| D11 | **Finished means gone from status.** `list-features` uses `isShippedFolder` (manifest `state: shipped`, a SHIPPED PROGRAM.md); drafts skip archived names; `/builder:tidy` ships a verified feature before merging it. |
| D12 | **`/builder:archive`** — one table of folders it judges finished, one confirmation; each keeps only `SPEC.md` (`PROGRAM.md`) with a `SHIPPED`, `CLOSED — not walked` or `DROPPED` header, in `<registry>/_archive/`; PLAN, manifest, ledgers and workspace go (`git log` keeps them). `program.mjs` reads the header: a DROPPED feature never satisfies a dependency; a CLOSED one does (its code is in the target). Closed needs 14 days without a move and dropped 56 (`--days N`). |
| D13 | **Logs:** once a feature lands, its `.jsonl` transcripts are dropped (the D1 summary is in the archive row); `.log` files stay to `keep_logs`. |

## What is measured after each step

Per feature, from the D1 archive rows: `costUsd` per task, turns per task (`byKind.implement`),
orchestrator peak and summed context, final-review findings, fix rounds, walk rounds, parks.
A regression in findings, walk rounds or parks outweighs any saving.

**Field test before default:** D8 (opt-in), D3's per-kind agents in a project whose implementers use
MCP, and — not in this release — filtered §Decisions, `omitClaudeMd`, and a Sonnet orchestrator.
