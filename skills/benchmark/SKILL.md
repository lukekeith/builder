---
name: benchmark
disable-model-invocation: true
description: Maintainer tool — runs a fixture feature through builder, superpowers and GSD unattended and reports time, turns, cost and acceptance for each step.
---

# `/builder:benchmark` — where the time goes

Invocation: **`/builder:benchmark [<feature>] [--only <config,…>] [--repeat N] [--model <m>] [--dry-run] [--status] [--report <run-id>]`**
for one fixture feature, or **`/builder:benchmark`** with no feature for the suite picker (§Picker), which also takes
**`--all`**, **`--budget <h>`**, **`--lanes N`**, **`--control <ids>`**, **`--resume <suite-id>`** and **`--stop`**.
`/builder:benchmark tags` is the quick fixture run the no-feature path used to start.

The work is `scripts/bench.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts. Design and the report's meaning:
`bench/README.md` in the plugin.

**What it does:** for each configuration — `builder` (the recommended test plan: what a user who
says "go" gets), `builder-everything` (`walk=full review=slice`: the full
pipeline), `superpowers`, `gsd`, `baseline` (plain Claude Code, no plugin) — it copies the feature's fixture project (`bench/fixtures/<name>/`:
`notes`, a notes CLI, unless the feature's `feature.json` names another, such as `notes-hub`, a CLI
and a server with slow suites), makes it a repo on `main`, and drives the pipeline unattended through `claude -p` sessions: builder as
brainstorm → spec → the fleet engine (audit, plan, build, agent walk, verify, ship, merge);
superpowers as one session from brainstorming to a merged branch; GSD as its four commands. Every
session gets an owner prompt that answers every question with the recommendation and never waits;
`builder-everything` sessions are told which test plan to pick. Afterwards the fixture's tests and
the feature's hidden acceptance tests score what landed. Configs run one at a time — never in
parallel — so one never skews another. Nothing in the user's Claude home changes: plugins load with
`--plugin-dir` for the session only, and GSD installs into the copy.

## Picker (no feature)

`/builder:benchmark` with no `<feature>` runs the suite (`scripts/bench-suite.mjs`; `bench/README.md`
§Suite): a catalogue of sized cases, scheduled into lanes that fit a night. It never starts a run
without asking. `--resume <suite-id>` skips the picker: `node <builder>/scripts/bench-suite.mjs run --resume <suite-id> --detach`
re-runs that suite's waiting, cut-off and refused items (parked and timed-out ones are final), after a confirmation as in step 5.

1. `node <builder>/scripts/bench-suite.mjs list --json` — the catalogue: fixture cases and any archived
   cases under `bench/local/`. A case with a `problem` is shown with it and cannot be picked.
2. **Above the picker, in prose** (one menu per screen): what each size bucket is for — `xs` a small
   change built in the chat, `sm` one app and one feature, `md` several slices or apps, `lg` and `xl`
   the long, costly runs — and the recommended set: what `plan --budget 12h` picks (run it and read its
   schedule) with its recommended controls, and why: it takes the sizes in turn so one night covers
   them all, and a control runs a case again on builder's main so a change in the number can be told from
   a change in the day. No lettered list beside the picker.
3. **One multi-select** of every case, each labelled with its `pickLabel` (`size · id — covers · ~minutes · ~$cost`, or `no estimate yet`).
4. **One question for the options**: lanes (default 3), controls (none, or the recommended ones),
   budget (none, or `--budget <h>` in place of a hand pick).
5. `node <builder>/scripts/bench-suite.mjs plan <ids|--all|--budget …> [--lanes N] [--control <ids>]`,
   shown as a plain review, not a path: the cases and controls, each lane with start and end times,
   when all lanes end, the cost, what was skipped and why, and — summarised from each archived case's dry
   run — what its clone will touch: the `agent_walk` lines applied, the files placed, the setup and
   teardown, the ports, and where clones go (outside every repo, removed after each case).
   Exit 2 is shown as its reasons (a refusal names what to fix; two projects naming one port is one) and nothing launches.
6. One AskUserQuestion — **Run it** / **Not now** — saying it runs on its own, outlives this session
   and writes only under `bench/local/results/` and `bench/results/`. On yes, **in the foreground**:
   `node <builder>/scripts/bench-suite.mjs run <the same selection> --detach` (`run` without
   `--detach` is refused; `🔴 never` launch it as a background task of this session).

`--builder <checkout>` points the suite at another builder; the default is this checkout. The suite pins it: it runs
on a detached worktree at its HEAD, so a commit made overnight changes nothing that runs, and both reports name
that SHA and main's. A checkout with uncommitted changes is refused; say so, and offer committing them or
`--allow-dirty` (runs the tree as it is, unpinned). Footer:

~~~
▶ benchmark suite: <n> case(s) in <lanes> lanes, ends ~<time> — next: /builder:benchmark --status
~~~

## 1. `--status` and `--report`

When a suite is running or the newest run, `--status` shows `node <builder>/scripts/bench-suite.mjs status`
(and `--report <suite-id>` runs `bench-suite.mjs report <suite-id>`); otherwise today's:

`node <builder>/scripts/bench.mjs status` — reply with its contents as markdown. Running: the
summary so far and the config and session it is on. Finished: the summary table and the report's
path. `⚠ benchmark stopped mid-run` means its process is gone; the finished configs are kept, and
`--only` runs the rest. **`--report <run-id>`**: `node <builder>/scripts/bench.mjs report <run-id>`,
then its table and the path.

**`--stop`** — after one **Stop it** / **Not now** — runs `node <builder>/scripts/bench-suite.mjs stop` in the foreground: each running
case stops cleanly and is marked `stopped`, nothing more starts, the reports are written; `--resume` runs the rest.

## 2. Pre-flight

- `claude` on the PATH (`which claude`); if not, stop and say so.
- The feature: `<feature>`; with none, this section does not apply — see §Picker. `bench/features/` has `tags` (one app, small — the
  quick run) and `share` (two apps on the `notes-hub` fixture, ~10–12 slices and ~30 s test suites —
  where the test-plan levers have something to save; a run takes far longer). An unknown one is refused by the script with the list.
- Superpowers in the plugin cache: the script's dry run names the `--plugin-dir` it found; if the
  `superpowers` line has none, say that row will run without the plugin and offer `--only` without it.
- No run in progress: `status` says `running:` → offer `--status` and stop. The launch itself also refuses with `a benchmark is running (pid N, …)`
  when one holds the lock, so a stale `status` reading cannot start a second run.

Then the dry run, in the foreground. It spends up to three one-turn model calls (one probe per pipeline) and prints the
plugins each loads; a `builder` line naming any path but `<builder>`, or a `superpowers` line that
is `(none)`, or more than one line for a pipeline, means stop and say so.

```bash
node <builder>/scripts/bench.mjs run <feature> <the same flags> --dry-run
```

Show it as a short table — one row per config: the sessions it will make, their first prompts,
the test plan a builder row is told to pick (`recommended` for `builder`) — plus the plugins a session loads (so a second builder
sneaking in is caught here), the model, and the estimate: the sum of the last report's walls for
these configs when `status` has one, else "no estimate yet".

## 3. One confirmation, then launch

One AskUserQuestion — **Run it** / **Not now** — saying it runs on its own, how many sessions,
and that nothing in this repo changes but `bench/results/` (or `.builder/bench/` outside the
builder repo). On yes, **in the foreground, with `--detach`**:

```bash
node <builder>/scripts/bench.mjs run <feature> <the same flags> --detach
```

It prints `bench started detached (pid N)` and returns. 🔴 **Never** launch it as a background task
of this session: the session ending would kill it mid-run. Detached, it outlives the session.

Then say, in two lines: it is running on its own and outlives this session; `/builder:benchmark
--status` shows where it is, and shows the report once every config has landed — nothing here is
notified when it ends. Footer:

~~~
▶ benchmark: <n> config(s) running — next: /builder:benchmark --status
~~~

## Never

- Run a config in the foreground of this session, or run two benchmarks at once.
- Edit `runs.json` or a report by hand; `--report` rebuilds one from `runs.json`.
- Change how builder, superpowers or GSD behave to make a number better.
- Name a consuming project in anything committed — cases, profiles and results stay under the git-ignored `bench/local/`.
- Launch a suite without `--detach`, or from a background task of this session.
