---
project: <project name>
registry: docs/features
base_branch: main
merge_into: main   # where finished features land; `current` = the branch checked out where the feature starts
# build_profile_default: standard   # the test plan the go-ahead recommends: rush (least testing) · standard · thorough (most)
apps:
  - name: <app name>
    path: <relative app directory>/
    role: app
    commit: auto
models:
  fast: gpt-6-luna
  fast_effort: high
  standard: gpt-6.1-sol
  standard_effort: medium
  judgment: gpt-6-astra
  judgment_effort: high
# Agent mode: $builder agent and the Agent handoff option need this block; init always writes it
# unless the owner says agents should never run here.
agent_walk:
  driver: <how a worker drives the running app — e.g. "Playwright via npx playwright">
  # start: <command>   # an isolated running environment for walks — its own ports and database
  # smoke: <command>   # proves the app is up AND sign-in can work (a CORS preflight, not only /health)
  # env: PORT=4001 DATABASE_URL="postgres://localhost/myrepo_walk"   # the walk env's own values; give a Next.js/Nuxt/SvelteKit/Rails app its own build output folder here too
# The verifier (scripts/verify/): tests beside the build, everything on the merged result.
verify:
  workers: 2
  # setup: npm ci                       # runs in each test checkout when its lockfiles change
  # (verify.db runs `psql` against the project's own Postgres server, so `psql` must be on PATH; a project without verify.db needs no database and no psql)
  # db: { kind: postgres, url: "postgres://localhost/myrepo", env: [TEST_DATABASE_URL], inputs: "prisma/**", prepare: "npm run db:migrate:test", max: 4 }
  suites:
    unit: { runner: vitest, files: "src/**/*.test.ts" }     # per-test results → selected per commit, whole at merge
    # e2e: { runner: playwright, files: "e2e/**/*.spec.ts", tiers: [merge], needs: [walk-env] }   # needs the running app
  checks:
    typecheck: { run: "npx tsc --noEmit", tiers: [commit, phase, merge] }
    # lint: { run: "npx eslint . -f unix", compare: lines }  # fails only on a finding the target doesn't print
---

# Builder project configuration

Write this to `.codex/builder.md` inside the feature worktree. The existing
`.builder/config.md` or `.claude/builder.md` can be consumed without migration.
Read actual repository scripts and CI before replacing the placeholders.
Model IDs/efforts must be supported by the user's client; mappings are editable.
New builds land on explicit --into, else merge_into, else configured base_branch; without configured targets the starting branch is retained. The chosen target is immutable for the build. The go-ahead's test plan (slice · end · review) replaces the old rush/standard/thorough profiles, which still read; mandatory project checks apply to every plan.

## Verification

Tests are run by the verifier (`scripts/verify/`), from the `verify:` block above — never by an
agent pasting commands. Each suite is one runner over a file glob (`node-test`, `vitest`, `jest`,
`phpunit`, `playwright`, `xcodebuild`, `junit`), with `cwd`, `app`, `args`, `needs` (`db`,
`walk-env`, `simulator`, `{ ports: [NAMES] }`) and `tiers` (`commit`, `phase`, `merge`); each check
is one command that passes or fails. It runs each commit's affected tests in the background as the
build goes, waits only at phase boundaries, and runs every suite and check on the feature merged
onto the target before it lands. A test that fails on the target too is known debt and never blocks
a feature; one that fails then passes on the same commit goes on the flake list automatically.
Write here, in prose, anything a suite needs that the block can't say (a service to start, a
fixture to seed).

## Global constraints

- Read applicable AGENTS.md and normative specifications before changing patterns.
- Each task changes one configured app. Shared packages need explicit ownership and dependency-aware verification.
- Workers edit only their assigned worktree, never create branches, merge, push, or publish, and never spawn other agents.
- Run the tests for the code you change and the type-check, not the app's whole suite — the verifier runs the rest on every commit, in the background, and everything on the merged result.
- Never stop a process or modify an external resource owned by another session/worktree.

## House rules

Point to project documentation and architectural boundaries rather than duplicating it.
Describe producer/consumer roles and released-artifact compatibility if there are multiple apps.
Mark app `commit: manual` where every commit requires its owner's action.

## Walk readiness

Document how to start, smoke-test and stop an isolated running environment.
Name migrations and ownership restrictions; never put secret values in this file.

```
migrations: <dir holding migration files>             # e.g. packages/db/prisma/migrations
status:     <command>   # pending migrations on the DEV db
pending:    <command>   # optional: exits 0 only when the DEV db has every migration — delivery asks it after landing instead of guessing from git; e.g. npx prisma migrate status, `alembic check`, `! rails db:migrate:status | grep -q '^\s*down'`
apply:      <command>   # e.g. npx prisma migrate deploy
apply_mode: ask         # ask (default) · human (print the command, never run it) · agent (just run it — delivery also runs apply then regenerate in the target checkout after landing new additive migrations)
regenerate: <command>   # after a schema change — omit if none
restart:    <command>   # optional: restarts what doesn't reload by itself (a server container) — offered after landing
fixtures:   <command>   # optional: resets the dev data a walk starts from — offered after landing
smoke:      <command>   # optional: a health check against the running dev app — offered last, after any of the above
```

State whether a personal human walk is mandatory or agent verification is acceptable.

## Companion skills

| Task | Skill |
|---|---|
| <project-specific work> | <installed skill name/path> |

## Environment landmines

Record only established ports, resource ownership, setup constraints, and known traps.

## Standing traps

What this project has already paid to learn — every step reads it. At delivery,
a cost this feature paid that the next one would pay too (a fix round, a red
test, a failed walk) becomes one proposed line here, added only with the
owner's yes. Agents never edit this config themselves.

- <one line each>
