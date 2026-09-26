# Agent walk + fleet — design

**Date:** 2026-09-26 · **Target release:** 2.5.0 (minor — additive, optional config) · **Status:** design approved in chat, awaiting spec review

## Goal

Write a batch of specs (~20), hand them to one command, walk away, and come back to a table: each
feature either **finished as a draft PR with the agent's walk evidence**, or **parked with a stated
reason**. No run ever waits on a question.

## Constraints and non-goals

- **Opt-in.** Without it, the pipeline behaves exactly as 2.4.0 does — every human gate intact.
- **The human sign-off is untouched.** `/builder:signoff` stays `disable-model-invocation`; an agent
  never writes a human sign-off. An agent's verdict is a *different record* with a different name.
- **Merging stays human.** An agent-verified feature reaches a **draft** PR, never a ready one.
- **Specs arrive written.** The fleet never runs `/builder:brainstorm` or `/builder:revise`; a spec
  needing a design conversation parks.
- **Project-agnostic.** The plugin names no browser tool; the driver comes from the config.
- **Dependency-free.** `fleet.mjs` uses Node's standard library plus `claude`, `git` and `gh` on PATH.

## Decisions (from the design conversation)

| # | Decision | Ruling |
|---|---|---|
| 1 | Where a finished feature lands | Branch pushed, **draft PR** opened with walk evidence in the body. Marking ready and merging are the human's. |
| 2 | Concurrency | **Hybrid.** Build lane in parallel (one worktree per spec, test-DB gates only). Walk lane **one at a time** through a single shared dev env: readiness → agent walk → fixes → verify → draft PR. |
| 3 | Walk driver | **Config-declared** (`agent_walk.driver`). No driver → the agent walk is API/log-level only and the PR body says so. |
| 4 | Orchestrator shape | **`scripts/fleet.mjs`** driving headless `claude -p` runs, fronted by a thin `/builder:fleet` skill. Survives outside any chat session. |

## 1. Trust model

**Two switches, both required:** the config's `agent_walk:` block (the repo permits it) and the
`--agent-walk` flag (this run asks for it). The flag implies `--auto`. The manifest records
`agent_walk: on YYYY-MM-DD` so a cold session keeps the mode, exactly as `auto:` works today.

**The agent walk** is a new, model-invocable skill, `/builder:agent-walk --path <folder>`. It
dispatches a **fresh subagent** — not the build's context — which works `walk.md` item by item with
the configured driver and records, per item, `PASS | FAIL` plus evidence (screenshots, console
output, server-log excerpts) under `<workspace>/agent-walk/round-<n>/`, and a `report.md` summarising
it. The skill writes the verdict:

| Verdict | Manifest | SPEC header | Next |
|---|---|---|---|
| AGENT-PASS | `walk: agent-pass YYYY-MM-DD <sha>` | `🤖 AGENT-VERIFIED YYYY-MM-DD <sha> — not human-tested` | `/builder:verify` |
| AGENT-PROBLEMS | `walk:` unchanged (`none`) | unchanged | each failing item a `- [ ]` under `## Fixes`, naming its app |

- **Fix rounds:** AGENT-PROBLEMS → the fixes are worked (resume §Working `## Fixes`) → walk readiness
  again → a fresh agent re-walks. Round count lives in the workspace (`agent-walk/round-<n>`). **After
  round 2 without a pass → park** with the still-failing items as the reason.
- **No condense on AGENT-PASS.** `PLAN.md` and §Plan stay until the human signs off, so a human-found
  problem still has its plan to work from.
- **What AGENT-PASS unlocks:** `/builder:verify`, and a **draft** PR. Nothing else.
- **The human's return:** review the draft PR, walk if wanted, type `/builder:signoff --path <folder>`
  in that feature's worktree. A human PASS **supersedes** the agent verdict (`walk:` becomes the human
  line, the 🤖 header line is replaced by the normal sign-off line), condenses the folder, and the next
  `/builder:resume` asks once (**Mark PR ready** / **Not yet**) before `gh pr ready`.

**The PR lock amendment** (REFERENCE, resume §The PR lock): *an `agent-pass` walk may open a PR only
with `--draft`, with the agent walk report in its body under a heading that states no human has
tested it. Marking a PR ready requires a human sign-off, as every PR did before.*

## 2. Headless mode — no question left waiting

Under `--agent-walk`: **never call AskUserQuestion or ExitPlanMode.** Every point that would ask
resolves one of two ways:

- **Take the recommendation** — when it is local and reversible.
- **Park** — write `blocked: <reason> — clears when <what>` to the manifest, commit
  (`chore(<key>): <feature> — parked: <reason>`), end with the 📍 footer, and exit.

| Pause | Under `--agent-walk` |
|---|---|
| Decisions gate · go-ahead · prototype gap · audit code defect | as `--auto`: the recommendation, recorded `auto (recommended)` |
| Open scope question · plan split | park — the spec needs a human |
| Audit `blocked:` finding | park, citing it |
| App marked `commit: manual` | park at the start of that app's phase; earlier phases stay committed |
| Dev-DB migrations | `apply_mode: ask` → apply · `human` → park · `agent` → apply |
| The walk | `/builder:agent-walk` (§1) |
| Opening the PR | `gh pr create --draft`, no question — starting the fleet was the permission |
| **Any other point that would ask, including new ones** | the general rule. A pause missing from this table is never a reason to ask. |

**`blocked:` is a new manifest key**, distinct from `hold:` (a human's deliberate parking of a PR).
`/builder:resume` reads it first: while it is set, resume prints the reason and runs nothing. The
human clears it by deleting the line (or resolving what it names) and re-running.

Without `--agent-walk`, every question is asked as today.

## 3. The fleet

### `/builder:fleet` (skill)

`/builder:fleet [--all | <spec folder>…] [--parallel N] [--dry-run] [--status]`

1. Resolve the specs (`--all` = every feature at `spec`, `aligned` or `audited` with no `blocked:`).
2. Pre-flight, per spec — refuse that spec, not the batch, on failure: config has `agent_walk:` with
   `claude_args`; spec has a `MANIFEST.md`; the folder is committed at `HEAD`; state is before the
   walk; no existing worktree on a different branch.
3. Print one screen: the specs, the branch each gets, the worktree root, the permission args, and
   plainly **"pushes branches and opens draft PRs"**. Take one confirmation.
4. Launch `node <builder>/scripts/fleet.mjs …` with `run_in_background`, and print the `nohup`
   form for running it outside the session.

`--status` prints `.builder/fleet/STATUS.md`. `--dry-run` runs pre-flight and prints the plan only.

### `scripts/fleet.mjs`

**Worktrees and branches.** Per spec: `git worktree add <worktrees>/<feature> -b builder/<feature>
HEAD` (`<worktrees>` defaults to `../<repo-dir>.fleet`). An existing worktree on the same branch is
reused. The family's "no skill creates a branch or worktree" rule holds — the fleet is not a skill
step; skills only run inside what it made.

**One `claude` run:**
`<claude> -p "/builder:resume --path <spec> --agent-walk" <claude_args>` with `cwd` = the worktree,
stdout+stderr to `.builder/fleet/logs/<feature>-<n>.log`, a per-run timeout (default 45 min). The
`claude` binary is `$FLEET_CLAUDE` when set (the self-test's stub), else `claude`.

**Progress** is read from the worktree's `MANIFEST.md` after each run — never from the run's output.

**Build lane** — up to `parallel` (default 3) features at once. Loop runs until the manifest reads
`state: built` with `walk: none` → hand to the walk lane; or `blocked:` → parked.

**Walk lane** — one feature at a time, in hand-off order:
1. `agent_walk.reset` in the worktree, if set (else note in the summary that dev-DB state accumulates).
2. Loop runs as above until `pr:` is set (→ done) or `blocked:` (→ parked). Walk readiness starts the
   dev env from the worktree using the config's §Walk readiness commands.
3. `agent_walk.stop` in the worktree, if set — always, even on park or failure.

**Guards:** a run leaving the manifest byte-identical → park `no progress`; a non-zero exit or
timeout → retry once, then park `run failed — see <log>`; max 12 runs per feature → park `run cap`.

**State.** `.builder/fleet/fleet.json` in the main checkout — per feature: `lane`, `status`
(`queued | building | awaiting-walk | walking | done | parked | failed`), `runs`, `worktree`,
`branch`, `pr`, `reason`, `log` — written atomically after every change. `.builder/fleet/STATUS.md`
is re-rendered from it each time. `.builder/fleet/lock` (pid) refuses a second fleet; a stale lock
(dead pid) is taken over with a warning. Re-running the fleet resumes: `done` skipped, `parked`
retried only when the manifest's `blocked:` is gone, in-flight features re-entered at their lane.

**The summary** (end of run, and `--status`): `Feature · Outcome · PR · Reason · Evidence · Worktree`.

## 4. Config, files, failures, testing

### Config (frontmatter, parsed by `config.mjs`)

```yaml
agent_walk:
  driver: <how the agent drives the UI — MCP tool prefix, CLI, or e2e runner>
  claude_args: --permission-mode bypassPermissions   # required for the fleet
  worktrees: ../<repo>.fleet                         # optional
  parallel: 3                                        # optional
  reset: <command>                                   # optional
  stop: <command>                                    # optional
```

Absent block → `--agent-walk` refuses with one line naming `/builder:init --update`. `driver` absent →
API/log-level agent walk, stated in the report and PR body.

### Files

| File | Change |
|---|---|
| `skills/agent-walk/SKILL.md` | **new** — §1 |
| `skills/fleet/SKILL.md` | **new** — §3 skill |
| `scripts/fleet.mjs` | **new** — §3 script, with `--self-test`, `--dry-run`, `--status` |
| `scripts/config.mjs` | parse `agent_walk` |
| `scripts/list-features.mjs` | `agent-pass` / `agent-problems` walk states; `blocked:` as a needs-attention row |
| `skills/resume/SKILL.md` | `--agent-walk` section (§2 table); Step 1 reads `blocked:` first; §The walk agent branch; §Ship draft PR + "mark ready" step; PR lock amendment |
| `skills/resume/REFERENCE.md` | §Flags `--agent-walk`; §MANIFEST.md `blocked:`, `agent_walk:`, `walk: agent-pass`; §Continuing on "go" row for `blocked:` |
| `skills/build/SKILL.md` | under `--agent-walk` the walk is not the terminal state; stop → park wording |
| `skills/verify/SKILL.md` | accept `walk: agent-pass`; READY footer names the draft PR |
| `skills/signoff/SKILL.md` | a human PASS supersedes an agent-pass |
| `skills/init/SKILL.md` | ask about the `agent_walk` block (and `--update` adds it) |
| `skills/help/SKILL.md`, `README.md`, `PROJECT.template.md`, `CHANGELOG.md` | document it |

### Failure handling

Every failure ends in a parked or failed feature with a reason and a log path — never a hang:
failed/timed-out run (retry once), push or `gh pr create` error, dev env that won't start (readiness
defect → fix rounds → park), worktree on the wrong branch, second fleet (lock), interrupted fleet
(resume from `fleet.json`), `agent_walk.stop` always runs.

### Testing

- `fleet.mjs --self-test`: temp git repo + a stub `claude` (via `FLEET_CLAUDE`) that advances or
  freezes manifests by script. Covers: parallel build lane, serial walk lane, park on `blocked:`,
  no-progress, retry-then-fail, run cap, lock, and resume after a kill.
- `config.mjs`: parse check for `agent_walk` present, partial, and absent.
- `claude plugin validate .` and `scripts/workspace --self-test` stay green.
- Skill edits read end to end for the rule each adds (CONTRIBUTING).
- Manual: `/builder:fleet --dry-run`, then a real run, on a sample repo with 2 small specs.
