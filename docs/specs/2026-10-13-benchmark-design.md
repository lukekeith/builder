# Pipeline benchmark — design

> 2026-10-13 · builder 4.10.3 · status: approved in conversation (build and release end to end)

## Why

The full superpowers pipeline feels much faster than builder on the same size of feature, and today
there is no number behind the feeling. Builder's fleet records one duration and one token count per
`claude -p` run, nothing per step, and nothing at all exists for superpowers or GSD. Without a
per-step record there is no way to tell which of builder's steps earn their time, which profile
levers actually move the needle, or whether a change to builder made agent builds faster.

The goal is data to improve the performance of agent builds. The benchmark runs the same small
feature through builder at each of its build profiles and through superpowers and GSD at their
defaults, unattended, and reports how long each step took, what happened inside it, what it cost,
and whether the feature that came out actually works.

**Success:** `/builder:benchmark` runs the matrix and writes a report whose summary table lets the owner say
"this pipeline, at this profile, shipped a working feature in this time for this many tokens",
whose per-config sections say where the time went, and which can be re-run after a builder change
to see whether it got faster.

## Decisions (from the conversation)

- **D1 — What "performance level" means.** Builder's build profiles — rush, standard, thorough —
  against superpowers and GSD at their defaults. `thorough-you` needs a human and is out. Five
  configurations per feature.
- **D2 — Quality counts.** A fast run that ships a broken feature is not fast. Every run is scored
  by acceptance tests the agent never sees, plus the fixture's own tests.
- **D4 — How it is run.** A skill, `/builder:benchmark`, the way `/builder:fleet` wraps its script:
  it checks, confirms once, launches `scripts/bench.mjs` detached and reports; `--status` shows the
  run in progress or the last report.
- **D3 — How steps are measured.** From the `stream-json` output of each headless session alone:
  every event carries a `timestamp`, and events from inside a subagent carry its
  `parent_tool_use_id`, so step boundaries, turns, tokens, cost and every tool call — the
  subagents' included — are all in one stream. (The conversation planned a PostToolUse hook for
  the subagent view; a real fleet log showed the stream already has it, so there is no hook.) No
  instrumentation inside any of the three pipelines; all three are measured the same way.

## Design

### 1. Layout

```
bench/
  README.md                     how to run it, how to read a report, how to add a feature
  fixture/                      the project every run starts from (§2)
  features/<name>/
    request.md                  the ask, given to every pipeline word for word
    accept.test.mjs             acceptance tests the agent never sees
  results/<run-id>/
    REPORT.md                   committed (§6)
    runs.json                   committed — every derived number the report is built from
    <config>[/<rep>]/           git-ignored — raw session streams, the tool-call log, the fixture's git log
skills/benchmark/SKILL.md       /builder:benchmark (§8)
scripts/
  bench.mjs                     the runner (§3)
  bench-core.mjs                pure functions: stream parsing, step derivation, scoring, report rendering
  test/bench-core.test.mjs
  test/bench.test.mjs
  test/fixtures/bench/          recorded streams the tests parse
```

`<run-id>` is `YYYY-MM-DD-HHMM-<feature>`. `bench/results/*/` raw directories are listed in
`.gitignore`; `REPORT.md` and `runs.json` are not, so results travel with the repo. Run from a repo
that is not builder itself (the skill is in the plugin, so it can be), results go to that repo's
`.builder/bench/<run-id>/` instead, git-ignored like the fleet's files. `bench/` ships with the
plugin — the fixture and features are a few small files — so the skill works from any install.

### 2. The fixture and the feature

**Fixture** — `bench/fixture/` is a small Node CLI, a notes app: `notes add <text>`, `notes list`,
`notes rm <id>`, `notes show <id>`, storing notes in a JSON file whose path an env var sets. It has
its own tests under `node:test`, a `package.json` with `test` as its only script, no dependencies,
a README that says what it is, and:

- `.claude/builder.md` already filled in: one app at `.`, gates `node --test`, `commit: auto`,
  `agent_walk` with `claude_args: --permission-mode bypassPermissions`, a driver of "run the CLI
  with Bash", no `start`/`smoke` (there is no dev server), and `merge_into: main`.
- No `.git`: the runner initialises one per copy.

**Feature** — `bench/features/tags/`: "Notes can carry tags. `notes add --tag <t>` (repeatable)
stores them; `notes list --tag <t>` shows only notes with that tag; `notes show` prints a note's
tags; `notes tags` lists every tag in use with its count." Big enough that builder sizes it md
and runs its full pipeline, small enough for one run to take minutes. `accept.test.mjs` exercises
each of those behaviours through the CLI and is copied into the fixture copy only after the run
ends.

Adding a feature is a new directory with those two files. The README says so.

### 3. The runner

```
node scripts/bench.mjs run <feature> [--only <config,…>] [--repeat N] [--model <m>] [--dry-run] [--detach]
node scripts/bench.mjs report <run-id>
node scripts/bench.mjs status
node scripts/bench.mjs clean
```

`--detach` re-launches the runner as its own process group, prints `bench started detached (pid N)`
and returns, the way `fleet.mjs --detach` does; the run outlives the session that started it. A
lock file under the results directory stops two runs at once. `status` reads it: a run in progress
prints the table so far with the config and session now running and how long it has been at it; no
run prints the last report's summary table.

**`run`** — for each configuration in the matrix, `--repeat` times, in sequence (never in parallel:
API rate limits and CPU contention would skew one run against another):

1. **Prepare a copy.** Copy `bench/fixture/` to `$TMPDIR/bench/<run-id>/<config>[-<rep>]/`, `git
   init`, commit as `fixture`, create `main`. Write the feature's `request.md` nowhere the agent
   can find it — the request is passed in the prompt.
2. **Load the pipeline under test for the session only**, never changing the user's Claude home:
   - Every session gets `--settings <copy>/.claude/bench-settings.json`, written by the runner,
     whose `enabledPlugins` switches off the builder and superpowers installed at user scope, so
     exactly one copy of each pipeline is loaded and it is the one under test.
   - builder: `--plugin-dir <this repo>`, so the benchmark measures the checkout it runs from. The
     fleet's own `claude -p` runs take their flags from the fixture's `agent_walk.claude_args`;
     the runner fills that line at prepare time with the same `--plugin-dir` and `--settings`
     (the fleet splits it on whitespace, so the copy's path must contain no spaces — the runner
     refuses a `$TMPDIR` that does).
   - superpowers: `--plugin-dir` of the version installed in this machine's plugin cache.
   - GSD: `npx -y @opengsd/gsd-core@latest --claude --local` in the copy (GSD Core, the project's
     current home; a local install writes commands into the copy's `.claude/`, not a plugin). GSD
     is not installed on this machine today; the runner installs it per copy and records the
     version the installer prints. If the install fails, the gsd rows are marked
     `not run: <reason>` and the rest proceeds.
   - The dry run prints which plugins each session loaded (`claude plugin list` in the copy with
     the same flags), so a second builder sneaking in is caught before a real run.
3. **Drive the pipeline** (§4), each session a `claude -p` with `--output-format stream-json
   --verbose`, cwd the copy, `--model` when given, and the owner prompt (§4). Stream to
   `<config>/session-<n>-<name>.jsonl`. Per session a hard timeout (default 2h) and an idle timeout
   (default 20 min, reset by any output), both env-overridable, killing the process group the way
   the fleet does; a killed session ends the run as `timed out`.
4. **Score.** After the last session: `git checkout main` in the copy, `npm test` (fixture tests),
   copy `accept.test.mjs` in and run it, record pass/fail counts for both, then
   `git log --oneline main` and `git branch -a` for the record.
5. **Derive and save.** Parse the streams (§5) into the run's row of `runs.json`
   and rewrite `REPORT.md`. Saved after every config, so a matrix killed half-way still has a
   report of what finished.

`--dry-run` prepares one copy, installs, prints the sessions it would run and their prompts, and
stops. `status` prints the latest run's table from `runs.json`, or "no benchmark has run".

Nothing the runner does touches this repo except `bench/results/`. The copies stay under `$TMPDIR`
for inspection and are not deleted; `bench.mjs clean` removes them.

### 4. Driving each pipeline unattended

**The owner prompt**, passed to every session as `--append-system-prompt`:

> You are being benchmarked. The owner is not here. Whenever a step would ask the human a question,
> answer it yourself: take the option marked recommended, or the simplest one when none is. Never
> stop to wait for input and never ask the owner anything. The feature is done only when it is
> merged into `main` and the tests pass. Do not explain the benchmark in commits or files.

For builder configs one line is appended: "When asked for a build profile, choose **<profile>**."
That is the only place the profile enters: builder records it on the manifest at the go-ahead
exactly as it would for a real owner.

**builder** — the way `/builder:agent` reaches a merged feature from an idea:

| Session | Prompt | Ends when |
|---|---|---|
| 1 brainstorm | `/builder:brainstorm --auto <request>` | the workspace record is written and sized |
| 2 spec | `/builder:spec --auto` (resumes the record) | SPEC.md + MANIFEST.md committed |
| 3 fleet | `node <builder>/scripts/fleet.mjs <feature> --parallel 1` in the copy | the feature is merged or parked |

`--auto` is builder's own unattended mode (every product choice takes its recommendation,
recorded as such); the owner prompt covers whatever still asks.

Session 3 is the fleet engine itself, not a `claude -p`: it runs audit, plan, build, the agent
walk, sign-off, verify, ship and merge, with its own `claude -p` runs streamed under
`.builder/fleet/logs/`. The runner reads those logs as sessions of this config, in order, and the
fleet's `archive.jsonl` row for the feature. A parked feature ends the config as `parked:
<reason>`. If builder sizes the feature xs/sm and builds it in chat, the config records `path:
in-chat`, sessions 2 and 3 do not run, and the row is flagged in the report — the matrix was meant
to compare profiles, and the feature should be resized.

**superpowers** — one session, the way a person uses it:

> `/superpowers:brainstorming` — Build this feature end to end: <request>. Brainstorm it, write
> the plan, execute the plan with subagent-driven development, then finish the branch by merging
> it into `main`.

**GSD** — four sessions, one per command, since each GSD command is written to start fresh. The
request is written to `<copy>/REQUEST.md` (excluded from git) because GSD's unattended entry
takes a file:

| Session | Prompt |
|---|---|
| 1 | `/gsd-new-project --auto @REQUEST.md` — plus "plan it as one phase" |
| 2 | `/gsd-plan-phase 1` |
| 3 | `/gsd-execute-phase 1` |
| 4 | `/gsd-verify-work 1` — plus "then merge the work into `main` and leave it checked out" |

These are GSD Core 1.7's names (`docs/COMMANDS.md`); the driver is one table in `bench.mjs`, so a
rename is a one-line change. `/gsd-ship` opens a PR, which a repo with no remote cannot, so the
merge is asked for in words instead.

Every driver is a function `(copy, request, opts) → sessions[]` in `bench.mjs`; the matrix is a
list of `{ config, driver, profile }`. Adding a pipeline is adding a driver.

### 5. What gets recorded

**Sessions** — each `claude -p` stream, raw, one `.jsonl` per session. Every event has a
`timestamp`; an event from inside a subagent has `parent_tool_use_id` set, a top-level one has it
null. From the stream `bench-core.mjs` derives:

- `result`: duration, turns, input/output/cache-read tokens, cost, from the `result` event — the
  same fields `fleet-core.tokensOf` reads.
- `steps`: a step opens on each top-level `tool_use` of the `Skill` tool (its `skill` argument is
  the step's name — `superpowers:brainstorming`, `builder:audit`, `gsd:plan-phase`, …) and closes
  on the next or at session end. Time before the first Skill call is a step named `(prompt)`. A
  session that never calls Skill is one step named after its prompt. Each step records start,
  end, turns within it (top-level assistant events), and every tool call in its window, the
  subagents' included: calls by tool, files touched (Edit/Write/Read paths), commands run (Bash,
  first 80 chars), test commands among them, subagents spawned (the Agent/Task tool's type and
  the prompt's first line), and the five longest gaps between consecutive events (the model
  thinking, or a command running).
- Fleet sessions: the same derivation on `.builder/fleet/logs/*.jsonl`; the fleet's lane
  (`build`/`walk`/`ship`) is recorded on each.

**Per config, per rep** (`runs.json`): config, profile, pipeline and version, model, started,
ended, wall-clock, status (`done` | `parked: …` | `timed out` | `failed: …` | `not run: …`),
sessions with their steps, totals (turns, tokens, cost), the score (`accept` passed/total,
`fixture` passed/total), `path` (`pipeline` | `in-chat`), and the copy's path.

### 6. The report

`REPORT.md`, rendered by `bench-core.mjs` from `runs.json` alone, so `bench.mjs report <run-id>`
can rebuild it after a format change without re-running anything.

**Summary table** — one row per config, median over reps when `--repeat` > 1 (and `n`):

| Config | Status | Wall | Turns | Tokens | Cost | Accept | Fixture tests | Longest step |
|---|---|---|---|---|---|---|---|---|

**Steps table** — one row per config, one column per step name seen in any config, the time spent
in that step (blank where the config has no such step). Builder's and GSD's steps are their skills;
superpowers' are its skills. This is the table that answers "where does builder's time go".

**Per config** — one section per config (per rep under it when repeated): its sessions in order,
each step with duration, turns, tool calls by tool (`Edit 14 · Bash 22 · Agent 6`), files touched,
test commands run, subagents spawned with their prompts' first line, and the five longest gaps
between consecutive tool calls (where the model was thinking or a command was running). For a
parked, failed or timed-out run: the reason and the last ten log lines.

Durations print through `fleet-core.duration`; tokens through its `formatTokens`.

### 7. Tests

`node --test 'scripts/test/*.test.mjs'`, no dependencies, as every script here:

- `bench-core.test.mjs`: step derivation from recorded streams (a session with three Skill calls,
  one with none, one cut off without a result event, subagent events landing in the right step);
  scoring from `node --test` output; report rendering from a hand-written `runs.json` (medians,
  blanks, flagged rows); `(prompt)` and `in-chat` cases.
- `bench.test.mjs`: the runner against a stub `claude` (the fleet tests' `stub-claude.mjs` pattern:
  a scenario file says what each session writes), checking the copy is prepared, the owner prompt
  carries the profile, sessions run in order, a timed-out session ends the config, `runs.json` is
  saved after each config, `--only` and `--dry-run`.
- The fixture's own tests run in CI with the rest, so the fixture never ships broken.

### 8. The skill — `/builder:benchmark`

`skills/benchmark/SKILL.md`, built like `/builder:fleet`: the work is `scripts/bench.mjs`; the
skill checks, confirms once, launches and reports. Invocation:

**`/builder:benchmark [<feature>] [--only <config,…>] [--repeat N] [--model <m>] [--dry-run] [--status] [--report <run-id>]`**

1. **`--status`** → `node <builder>/scripts/bench.mjs status`, relayed as markdown. **`--report`**
   → `bench.mjs report <run-id>` then the report's summary table and its path.
2. **Otherwise, the pre-flight:** `claude` on the PATH, `bench/features/<feature>/` exists
   (default `tags`; the only feature today, so no question), the plugin cache has superpowers
   (else the superpowers row is `not run` and the skill says so), no run in progress. Then one
   dry run, `bench.mjs run … --dry-run`, shown as a short table: configs to run, sessions each
   will make, which plugins each session loads, the model, and the estimated span (sum of the
   last report's walls when there is one; "no estimate yet" otherwise).
3. **One confirmation** — "run it?" — then `bench.mjs run … --detach` in the foreground, exactly
   as the fleet skill launches, never as a background task of the session.
4. **Report** in two lines: it is running on its own and outlives this session, and
   `/builder:benchmark --status` shows where it is; when every config has landed, the same
   command shows the report. Footer: `▶ benchmark: <n> configs running — next: /builder:benchmark --status`.

The skill never runs a config in the foreground, never edits results, and never changes any
pipeline's behaviour. Listed in `/builder:help` and README with the other skills.

## Out of scope

- Running configs in parallel.
- Benchmarking `thorough-you` or any config that needs a human.
- A fixture with a dev server or UI; the walk drives a CLI.
- Comparing across machines or models in one report (one run is one model; `--model` is recorded).
- Any change to how builder, superpowers or GSD behave.

## Release

A new skill (`/builder:benchmark`): **minor**, 4.11.0. `bench/` ships with the plugin;
`bench/results/` raw directories do not, and `/builder:vendor` copies `bench/` without `results/`.
