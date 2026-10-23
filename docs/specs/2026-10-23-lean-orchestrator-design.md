# A leaner orchestrator — design (Part 1: nothing a user sees changes)

> 2026-10-23 · builder 4.14.0 (proposed) · status: Part 1 approved by the owner ("go with your
> recommendation … continue support for the agent run that can complete the work without human
> intervention")

## Why

The analysis (`2026-10-23-orchestrator-overhead-analysis.md`, from the 4.12.0 tags streams): the
orchestrator is 73% of wall time, and its cost is **output tokens** (~7.5 ms each) plus **~2.4 s per
model call**; context size is nearly free (~1 s per 117k tokens). So the cut is: type less by hand,
make fewer calls. Not: shrink the skill files.

## Decisions

- **D1 — Scripts write what the orchestrator types today, verbatim from templates or state:**
  - **P1 `scripts/dispatch`** renders a subagent's full prompt (implementer, task review, re-review,
    final review, agent walk) from `skills/build/prompts/*.md` and the task brief into the
    workspace; the Agent call becomes "Read <file> and do what it says" plus at most one paragraph
    of context the template can't know.
  - **P2 `scripts/advance`** — one call per state change: sets manifest keys, `head:`, appends the
    ledger line, commits with the conventional message. `scripts/condense` does the sign-off /
    ship condense; `plan-slices --index` writes SPEC §Plan's index.
  - **P5 `scripts/docs <step>`** prints exactly the REFERENCE/skill sections a step names, in one
    call. Every `echo =====` separator in the skills becomes `echo ---` (zsh reads `=====` as a
    filename expansion and fails the command).
  - **P6** the build lane writes `<WS>/handoff.md` (state, sha, gates, open items) at its end; the
    walk lane's resume reads it instead of re-deriving state in ~7 calls.
  - **P7 `scripts/walk-script`** generates walk.md from SPEC §Testing and the `[risk]` tags; the
    orchestrator only adds what the spec doesn't say.
  - **P3** under `--auto`, brainstorm writes SPEC.md directly and brainstorm.md is a stub that
    points at it (interactive runs unchanged).
- **D2 — Unattended runs are a hard requirement.** Every script is idempotent and safe to re-run
  after a crash; resume after `/clear` reads the same files as before; the fleet path is verified by
  a full benchmark run (brainstorm → merge with no human) before release.
- **D3 — Out of Part 1:** shorter agent-mode reports, compact auto-decision rows, merged agent-mode
  steps (Part 2), and the opt-in fast build that applies planned code by script.
- **D4 — Release: 4.14.0**, after 4.13.0, measured on tags and share against the 4.12.1 baseline.
