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
# verify, ship, and a merge into the branch you ran it from (local; never pushed).
# Omit the whole block and --agent-walk / /builder:fleet refuse.
agent_walk:
  driver: <how the agent drives the UI — e.g. "the Playwright MCP tools (mcp__playwright__*)">
  claude_args: --permission-mode bypassPermissions   # headless runs can't ask; this lets them act in their worktree
  # worktrees: ../myrepo.fleet     # default: a sibling of the repo named <repo>.fleet
  # parallel: 3                    # build-lane concurrency; use 1 if the tests share one database
  # keep_logs: 30                  # days a merged feature's run logs stay under .builder/fleet/logs/_archive/; 0 keeps them forever
  # auto_unpark: 2                 # times one fleet run unparks a feature on its own and has an agent dig into the park record; a human-step park always waits for you; 0 turns it off
  # copy: .env, certs/dev.pem      # untracked files copied into each NEW worktree; never overwrites a tracked file, and a missing one is just noted
  # worktree_env: TEST_DATABASE_URL="postgres://localhost/myrepo_test_{feature}"   # KEY=VALUE pairs reaching EVERY run and setup in a worktree, {feature} filled in — give each worktree its own TEST database and `parallel` builds stop colliding
  # setup: npm ci && createdb myrepo_test_{feature} && npm run db:migrate:test   # runs once per NEW worktree, after copy, with worktree_env and {feature} filled in; a failure parks the feature and is retried on the next fleet run
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

# ─── flaky gates (optional) ────────────────────────────────────────────────
# A test that fails under the whole suite and passes alone. When a gate fails and
# its output matches `match` (a regex), scripts/gate.mjs re-runs `rerun` once —
# the narrow command that proves the file alone — or the same gate when there is
# no `rerun`, and passes the gate on a green re-run. Omit the block if none.
# flaky:
#   - match: intake\.test\.ts
#     rerun: node --test apps/server/test/intake.test.ts
---

# <Your Project> — builder config

One paragraph: what this repo is, and how its units relate.

## Quality gates

The literal commands, per app, run by `scripts/gate.mjs` — never pasted by an
agent. **The fast set runs at every phase close** — a phase touches ONE app, so
its gates are one block below. **The deep set is only what the fast sets do NOT
cover** (an e2e suite, a whole-repo check): every in-scope app's fast set runs
beside it in `/builder:verify`, so a fast command repeated here runs twice.

The runner quotes a set whose inputs (the app's path, shared code, the commands)
are byte-identical to its last green run, so a gate is not re-run for an app
nothing has touched. Two markers go at the end of a line's comment:

- `@known-red` — red for inherited debt on the base branch; run and reported,
  never counted against a feature. Say what makes it red.
- `@delta` — the command prints a number (a type-error count, say) that must not
  exceed the base branch's, measured by `gate.mjs --baseline` (the fleet does
  this at start). No count is typed into this file to go stale.
- `@scoped <glob>` — run only the tests in `<glob>` this branch can reach: what
  it changed, code reading a schema field it changed, and everything that
  imports or loads either (`scripts/impact.mjs`). Put `{tests}` where the file
  list goes; a line without it runs whole when the branch reaches its glob at
  all, and is skipped when it doesn't. A change the graph can't see past (a
  file beside the tests nothing loads, a runner config, a lockfile) runs the
  whole suite. An e2e suite that takes minutes should always be scoped.

🔴 **Never put a wrapper in the deep set that re-runs the fast sets** — a
`gate:all` that re-runs the typecheck, the unit suites and the e2e suite again
multiplies the slowest step of every feature. List the checks only the deep set
makes, one per line, each `@scoped` to what it proves.

### <app> — fast

```
<command>          # what it proves
<command> 2>&1 | grep -c "error TS"   # type errors, must not grow @delta
```

### Deep set (verify only)

```
npx playwright test {tests}   # the UI suite, the tests this branch reaches @scoped e2e/**/*.spec.ts
<command>          # what it proves, and why the fast sets don't @scoped <the paths it covers>
```

## Walk readiness

What makes the **dev** environment run this branch before a human is asked to walk it — REFERENCE
§Walk readiness. Green tests run against a test database; the walk doesn't.

```
migrations: <dir holding migration files>             # e.g. packages/db/prisma/migrations
status:     <command>   # pending migrations on the DEV db, e.g. npx prisma migrate status
apply:      <command>   # e.g. npx prisma migrate deploy
apply_mode: ask         # ask (default) · human (print the command, never run it) · agent (just run it)
regenerate: <command>   # after a schema change, e.g. npx prisma generate — omit if none
start:      <command>   # how the dev env comes up, and who may start it
smoke:      <command>   # a health check / smoke subset against the running app — omit if none
```

- <what goes stale and needs a restart, and on what kind of change>

## Global constraints

🔴 **This block is pasted VERBATIM into every implementer and reviewer brief.**
Write each bullet as ONE long line — it survives the paste whole that way. Keep
it to what an implementer who has never seen this repo would get wrong.

- **Your task touches ONE app.** Its `App:` line says which. Do not edit another app "while you are in there".
- **Run the tests for the code you change and the type-check, not the app's whole suite** — the phase close runs the gate block once, on the committed tree. Run every command in the foreground. **Never kill a process you did not start in this task, and never `pkill`/`killall` by pattern**: other worktrees share this machine and their suites look like yours; wrap a command that may hang in `timeout`.
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
