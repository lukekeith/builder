# Fleet context growth — keep a build session's context near where it starts — design

**Status:** approved by the owner in conversation ("let's proceed with those fixes") · **Date:** 2026-10-31 · **Branch:** `feat/verifier`

## Why

After the token cuts (`2026-10-31-fleet-token-cuts-design.md`) a fleet build session starts at ~45k of
context but still ends at 127–187k: b03 grew +141.5k over 114 turns, d03 +69k over 49. Every turn
re-reads all of it. The measured breakdown (`growth-analysis`, suite `2026-10-31-1237`/`-1418`):

- **Up-front reads, 31–42% of the growth** — the plan outline (`plan-slices --brief`, 30 KB on b03, read
  back from a file) and the bundles, of which 13k is the project config printed whole.
- **The per-task loop, 40–55%** — ~2.7k per task: implementer replies (18.5%) plus the harness wrapper
  (11%), `dispatch.mjs next` output (16%: the workspace path ~4 times, a 4-line Agent-call block), and the
  orchestrator's own commands (22%: a path prefix on every command, `--context` repeating environment
  facts the brief does not carry).
- **The end, 13–18%** — final review and re-review reply with the whole report already in its file.
- **A plan session reaches 181k in 7 minutes** — 35k of it just routing through `/builder:resume`.
- A red verdict shows the npm banner, not the failing test, so the orchestrator fetches it again.

About 22% of the growth (harness frames, kept thinking, per-turn wrappers) is not builder's to cut.

**Success:** re-running the same cases, the build orchestrator's summed context per task falls a further
≥20% and its peak a further ≥20% against the `2026-10-31-1237`/`-1418` runs (b03, d03, a26, a19); the
plan session's peak falls ≥25%; landing, fix rounds and final-review findings are no worse.

## Decisions

All of D1–D7 are neutral — they change what the orchestrator *reads*, not what a build dispatches,
commits, verifies or merges — except D6, which gives implementers more environment facts.

- **D1. A compact plan outline.** `plan-slices --brief` prints the plan header without §Global
  constraints (the brief carries them) and one line per task — `N · app · phase · title · recipe ·
  <k> files` — never over 30,000 characters. A pre-flight ruling that needs a task's Files or Interfaces
  reads that task with `task-brief`.
- **D2. A planned-for feature goes straight to `/builder:plan`.** An `audited` feature with no OPEN
  decision and no `blocked:` row starts its lane on `/builder:plan --path … --auto --agent-walk
  --no-dev-env` (the fleet's prompt), not `/builder:resume`; anything else keeps resume. The
  `resume-agent` bundle stays under 30,000 characters.
- **D3. Script output is one line per fact.** `dispatch.mjs` prints relative paths, no `brief:` line, and a
  one-line Agent call that names the model tier it chose (so the orchestrator never needs §Model
  selection for a routine dispatch); `advance.mjs --ledger` prints `ledger: +1 line`. The implementer's
  reply is ≤6 lines of ≤100 characters (status, commit, one test line, one line per concern); the final
  reviewer replies with the verdict and one line per finding by severity, the re-review with one verdict
  line per finding and "new breakage: …". The full reports stay in their files, as today.
- **D4. Bundles carry only what the step acts on.** `fleet-setup` prints only the config sections the
  orchestrator acts on — the apps list, House rules, Environment landmines, Standing traps — leaving
  `verify:`, `agent_walk:`, Quality gates, Walk readiness and Global constraints to the scripts and briefs
  that use them. `fleet-build` is lever-aware: under `review=end` it leaves out EXECUTION §3 Review the
  task, and it carries a short AGENT-MODE excerpt for the build lane (never ask, never background work,
  foreground verify wait, never kill what you did not start, build to done, the never-do list, the end
  commit) instead of the whole §`--agent-walk`. The redundant fleet fetch of EXECUTION §The final
  whole-branch review goes (SKILL §When the last phase signs already carries it).
- **D5. The builder root is an environment variable.** The fleet exports `BUILDER_DIR` to every session;
  the build, plan and resume skills write `node "$BUILDER_DIR"/scripts/…` where they wrote `<builder>`
  under the fleet, ending the path prefix on every command. A human session resolves `<builder>` as
  today.
- **D6. Environment facts ride in the brief.** Every implementer brief carries the config's §Environment
  landmines and the ledger's `## env notes`; the orchestrator's `--context` carries only the hand-over
  from the previous task.
- **D7. A red verdict shows the failure.** `verify.mjs` summarises a red check by its failing lines (lines
  matching FAIL, ✗, Error or expected; else the tail), not its first lines.

## Later (measured, not in this change)

A fresh orchestrator per phase on long builds (restart at a phase close after ~10 tasks; the run cap of
14 would count these separately): measured −41% on b03 together with D1–D7, a net loss on short builds.

## Out of scope

The harness's own frame on agent results; what a build checks or reviews.
