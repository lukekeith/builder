---
# ─── builder project config ────────────────────────────────────────────────
# Copy this file to `.claude/builder.md` in your repo and fill it in. It is the
# ONLY thing `/builder:*` needs to know about your project: the plugin itself
# names no app, no language, no command.
#
# The frontmatter is machine-readable (the plugin's scripts parse it). The body
# is agent-readable (the skills read it). Both are required.

project: <Your Project>

# Where feature folders live. One folder per feature: SPEC.md + MANIFEST.md.
registry: docs/features

# The branch a PR targets. No skill ever commits or dispatches on it.
base_branch: main
# merge_into: develop   # where finished features merge (fleets, /builder:tidy); default base_branch.
#                       # `current` = the branch checked out when the fleet launches (feature-branch workflows)
# plan_writers: per-app   # /builder:plan writes each app's tasks in parallel, one writer per app, against SPEC §Contract — faster for multi-app plans; default one writer
#                         # per-phase — one writer per phase (6+ tasks split), each holding a small slice of the code: lower peak context on big plans
# agent_types: general-purpose   # what build's implementers and reviewers run as; default builder's lean agents (no MCP, no skills list).
#                                # `implementer=<agent>, reviewer=<agent>` names your own .claude/agents/* — e.g. an implementer that needs an MCP server
# build_profile_default: standard   # the test plan the go-ahead recommends: rush (no agent walk) · standard · thorough (an agent walks all of it)

# ─── apps ──────────────────────────────────────────────────────────────────
# The deployable/buildable units of this repo. A single-app repo lists ONE.
# Every feature SPEC gets a §Apps row per app, including untouched ones.
#
#   role: producer  — owns the API/data contract. Its phases run FIRST, and the
#                     contract FREEZES when its phase verifies.
#           consumer — codes against the frozen contract. Consumers are
#                     parallelizable when they don't import each other.
#           tool     — internal tooling; ships to nobody. Runs after the
#                     consumers it reads.
#           app      — the only unit (single-app repo): it is its own producer
#                     and consumer, and the freeze machinery stays quiet.
#   commit: auto    — the implementer commits its own task
#           manual  — a human approves every commit (staged, not committed)
#   released_artifact: true — a shipped build of this app cannot be hot-fixed,
#                     so any contract change it reads is a breaking change
#                     until §Apps states the transition.
apps:
  - name: <app>
    path: <dir>/
    role: app
    commit: auto

# ─── ticket system (optional) ──────────────────────────────────────────────
# `--ticket <id>` records the key and reads the dossier as design input.
# Omit the whole block if you don't use one.
ticket:
  system: <jira | linear | github | monday.com | …>
  dossier: <path/with/<id>/in/it.md>      # omit if there is none

# ─── design source (optional) ──────────────────────────────────────────────
# Prototype mode: a finished design read AS the requirements instead of an
# interview. `flag` is the CLI flag (`--design`, `--ui2`, `--figma`, …);
# `resolver` is a command taking `--resolve "<ref>" --json` and printing the
# resolved set. Omit the whole block and prototype mode simply doesn't exist.
design:
  flag: design
  resolver: <command that resolves a ref>
  contracts: <where the normative design contracts live>
  owned_by: <the commands that WRITE that design — builder only ever reads it>

# ─── unattended runs (optional) ────────────────────────────────────────────
# /builder:agent and /builder:fleet take specs all the way with no human in the
# loop: a worktree per spec, an agent walk and agent sign-off instead of yours,
# verify, ship, and a merge into merge_into (below; default base_branch), local and never pushed.
# /builder:init always writes this block. Without it the repo has no agent mode: --agent-walk and
# /builder:fleet refuse, and the build footers offer no Agent option.
agent_walk:
  driver: <how the agent drives the UI — e.g. "the Playwright MCP tools (mcp__playwright__*)">
  claude_args: --permission-mode bypassPermissions   # headless runs can't ask; this lets them act in their worktree
  # worktrees: ../myrepo.fleet     # default: a sibling of the repo named <repo>.fleet
  # parallel: 3                    # build-lane concurrency — tests run in the verifier, each in its own database, so builds never share one
  # keep_logs: 30                  # days a merged feature's run logs stay under .builder/fleet/logs/_archive/; 0 keeps them forever
  # auto_unpark: 2                 # times one fleet run unparks a feature on its own and has an agent dig into the park record; a human-step park always waits for you; 0 turns it off
  # batch: 8                      # with start set: how many features one walk takes at once — one walk branch, one env, one walker by screen; 1 walks them one at a time
  # copy: .env, certs/dev.pem      # untracked files copied into each NEW worktree; never overwrites a tracked file, and a missing one is just noted
  # worktree_env: TEST_DATABASE_URL="postgres://localhost/myrepo_test_{feature}"   # KEY=VALUE pairs reaching EVERY run and setup in a worktree, {feature} filled in — isolates the build lanes' own tool runs (dev servers, codegen) per worktree; the verifier isolates tests itself (`verify.db`)
  # setup: npm ci && createdb myrepo_test_{feature} && npm run db:migrate:test   # runs once per NEW worktree, after copy, with worktree_env and {feature} filled in — for the build lanes' own tools (the verifier prepares test databases itself); a failure parks the feature and is retried on the next fleet run
  # sync: npm ci && npm run db:migrate:test   # runs in a worktree right after the fleet merges the target in WITH new commits — the install and test-DB migration a merged-in package or migration needs; a failure parks the feature
  # env: PORT=4001 DATABASE_URL="postgres://localhost/myrepo_{feature}"   # KEY=VALUE pairs (quotes allowed), {feature} filled in; the walk lane only — its claude -p runs and reset/start/smoke/stop — never build-lane runs or setup, and never CLAUDE_PROJECT_DIR
  # reset, start, smoke and stop run with env. Give the walk env ports and a database of its own that
  # the repo's own tooling (tests, scripts, your dev env) doesn't also use. reset and stop must never
  # stop or recreate a service your own dev env shares — no `docker compose down`, and no `compose up`
  # from a branch whose compose file may differ: start an existing container by name, or pin -f to
  # the main checkout's compose file.
  # reset: <command>               # the walk env's DB back to base + seed, before each walk — never a shared service
  # start: npm run dev             # a second, isolated dev env for the walk lane — write it, and every command above, as plain shell text: a bare true/false/number is parsed as that, not a command
  # smoke: curl -sf localhost:4001/health   # polled every 2s for up to 5min; start with no smoke just waits 10s and proceeds
  # stop: <command>                # stop what the walk env needs stopped after each walk — never a service your own dev env shares

# ─── verify (the verifier: tests beside the build, everything on the merged result) ───
verify:
  workers: 2
  # setup: npm ci                       # runs in each test checkout when its lockfiles change
  # db: { kind: postgres, url: "postgres://localhost/myrepo", env: [TEST_DATABASE_URL], inputs: "prisma/**", prepare: "npm run db:migrate:test", max: 4 }
  suites:
    unit: { runner: vitest, files: "src/**/*.test.ts" }     # per-test results → selected per commit, whole at merge
  checks:
    typecheck: { run: "npx tsc --noEmit", tiers: [commit, phase, merge] }
    # lint: { run: "npx eslint . -f unix", compare: lines }  # fails only on a finding the target doesn't print
---

# <Your Project> — builder config

One paragraph: what this repo is, and how its units relate.

## Verification

Tests are run by the verifier (`scripts/verify/`), from the `verify:` block above — never by an
agent pasting commands. It runs each commit's affected tests in the background as the build goes,
waits only at phase boundaries, and runs every suite and check on the feature merged onto the
target before it lands. A test that fails on the target too is known debt and never blocks a
feature; one that fails then passes on the same commit goes on the flake list automatically.
Write here, in prose, anything a suite needs that the block can't say (a service to start, a
fixture to seed).

## Walk readiness

What makes the **dev** environment run this branch before a human is asked to walk it — REFERENCE
§Walk readiness. Green tests run against a test database; the walk doesn't.

```
migrations: <dir holding migration files>             # e.g. packages/db/prisma/migrations
status:     <command>   # pending migrations on the DEV db, e.g. npx prisma migrate status
pending:    <command>   # optional: exits 0 only when the DEV db has every migration — the fleet asks it after a merge instead of guessing from git; e.g. npx prisma migrate status, `alembic check`, `! rails db:migrate:status | grep -q '^\s*down'`
apply:      <command>   # e.g. npx prisma migrate deploy
apply_mode: ask         # ask (default) · human (print the command, never run it) · agent (just run it — the fleet also runs apply then regenerate in your checkout after landing a feature with new additive migrations)
regenerate: <command>   # after a schema change, e.g. npx prisma generate — omit if none
start:      <command>   # how the dev env comes up, and who may start it
restart:    <command>   # optional: restarts what doesn't reload by itself (a server container) — a fleet's wrap-up runs it after landing
fixtures:   <command>   # optional: resets the dev data a walk starts from — the wrap-up runs it after landing
smoke:      <command>   # a health check / smoke subset against the running app — omit if none
```

- <what goes stale and needs a restart, and on what kind of change>

## Global constraints

🔴 **This block is pasted VERBATIM into every implementer and reviewer brief.**
Write each bullet as ONE long line — it survives the paste whole that way. Keep
it to what an implementer who has never seen this repo would get wrong.

- **Your task touches ONE app.** Its `App:` line says which. Do not edit another app "while you are in there".
- **Run the tests for the code you change and the type-check, not the app's whole suite** — the verifier runs the rest on every commit, in the background. Run every command in the foreground. **Never kill a process you did not start in this task, and never `pkill`/`killall` by pattern**: other worktrees share this machine and their suites look like yours; wrap a command that may hang in `timeout`.
- <one line per binding rule: layering, validation, auth, styling, test policy…>
- Commits: **exactly one commit for this task** — code and tests together — `<type>(<TICKET>): <subject>`. If review sends you back, each fix round is its own commit. **Never `git commit --amend`.**
- Never create a branch, a worktree or a ticket. Never open a PR.
- Report: status · commits · one-line test summary · concerns, under 15 lines; the detail goes to your report file.

## House rules

The audit's checklist, per app. Point at the real source of truth (a per-app
`CLAUDE.md`, an architecture doc) rather than duplicating it; this is the
checklist, not a replacement.

**<app>** — <the rules that matter, semicolon-separated>

## Environment landmines

Things that cost hours when rediscovered. Ports, containers that don't
hot-reload, tools that must run from a particular directory, snapshots that lie.

- <one line each>

## Companion skills

The build step routes to these instead of freelancing; a task's `Recipe:` line
names one. Omit the table if the project has no recipe skills.

| Task | Skill |
|---|---|
| <kind of work> | `/<skill>` |

## Standing traps

What this project has already paid to learn. Keep it short and keep it true.

- <one line each>
