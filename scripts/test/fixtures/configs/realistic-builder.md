---
project: sample-monorepo
registry: docs/features
base_branch: main
merge_into: current
plan_writers: per-app
apps:
  - name: api
    path: apps/api/
    role: producer
    commit: auto
  - name: web
    path: apps/web/
    role: consumer
    commit: auto
  - name: worker
    path: apps/worker/
    role: consumer
    commit: auto
    released_artifact: true
# The fleet: how agents build, walk and land features here.
agent_walk:
  driver: a browser — the dev web app at http://localhost:3000, logged in as the seeded admin
  start: docker compose -f infra/dev.yml up -d --wait
  stop: docker compose -f infra/dev.yml down
  env: COMPOSE_PROJECT_NAME=wt-{feature} WEB_PORT=0 API_PORT=0
  claude_args: --model default
  parallel: 3
  batch: 2
  worktrees: ../sample-monorepo-wt
  keep_logs: 20
  auto_unpark: 1
  build_profile_default: standard
# The verifier: every suite, per tier.
verify:
  workers: 4
  setup: pnpm install --frozen-lockfile && pnpm -r build
  db:
    url: postgres://dev:dev@localhost:5432/verify_{id}
  suites:
    api: { runner: vitest, cwd: apps/api, files: "src/**/*.test.ts", tier: phase }
    api-int: { runner: vitest, cwd: apps/api, files: "test/integration/**/*.test.ts", tier: merge }
    web: { runner: vitest, cwd: apps/web, files: "src/**/*.test.tsx", tier: phase }
    web-e2e: { runner: playwright, cwd: apps/web, files: "e2e/**/*.spec.ts", tier: merge }
    worker: { runner: pytest, cwd: apps/worker, files: "tests", tier: phase }
    lint: { runner: command, cmd: "pnpm -r lint && pnpm -r typecheck", tier: phase }
---

# sample-monorepo — builder config

A three-app monorepo: a TypeScript HTTP API over Postgres (`apps/api`), a React web client that
consumes it (`apps/web`), and a Python background worker shipped as a versioned container image
(`apps/worker`) that reads the same database through the API's published contract.

## Verification

The verifier runs each app's unit suite at the phase tier and the integration and end-to-end suites
at the merge tier, from the `verify:` block above. A red lint or typecheck fails the phase.

## Walk readiness

```
migrations: apps/api/migrations
status:     pnpm --filter api migrate:status
pending:    pnpm --filter api migrate:check
apply:      pnpm --filter api migrate:deploy
apply_mode: agent
regenerate: pnpm --filter api db:generate
start:      docker compose -f infra/dev.yml up -d --wait
restart:    docker compose -f infra/dev.yml restart api worker
fixtures:   pnpm --filter api seed:reset
smoke:      curl -fsS http://localhost:3001/health
```

## Walk readiness notes

- Step 1: after a migration the worker must be restarted, because it caches the schema version at boot; a walk started before the restart reads stale columns and fails on the first job it picks up. Check `docker compose ps` shows the worker healthy before walking.
- Step 2: after a migration the worker must be restarted, because it caches the schema version at boot; a walk started before the restart reads stale columns and fails on the first job it picks up. Check `docker compose ps` shows the worker healthy before walking.
- Step 3: after a migration the worker must be restarted, because it caches the schema version at boot; a walk started before the restart reads stale columns and fails on the first job it picks up. Check `docker compose ps` shows the worker healthy before walking.
- Step 4: after a migration the worker must be restarted, because it caches the schema version at boot; a walk started before the restart reads stale columns and fails on the first job it picks up. Check `docker compose ps` shows the worker healthy before walking.
- Step 5: after a migration the worker must be restarted, because it caches the schema version at boot; a walk started before the restart reads stale columns and fails on the first job it picks up. Check `docker compose ps` shows the worker healthy before walking.

## Global constraints

- No new runtime dependency without a ruling in the SPEC.
- Every public API change is versioned; the worker pins the contract version it reads.
- Commit style: `type(scope): summary`, scope is the app.
- Tests live beside the code they cover.

## House rules

- **Validation 1 (api).** Keep validation for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new validation rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a validation change that arrives without one. See `apps/api/docs/validation.md`.
- **Error mapping 2 (api).** Keep error mapping for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new error mapping rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a error mapping change that arrives without one. See `apps/api/docs/error-mapping.md`.
- **Logging 3 (api).** Keep logging for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new logging rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a logging change that arrives without one. See `apps/api/docs/logging.md`.
- **Data access 4 (api).** Keep data access for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new data access rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a data access change that arrives without one. See `apps/api/docs/data-access.md`.
- **State shape 5 (api).** Keep state shape for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new state shape rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a state shape change that arrives without one. See `apps/api/docs/state-shape.md`.
- **Caching 6 (api).** Keep caching for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new caching rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a caching change that arrives without one. See `apps/api/docs/caching.md`.
- **Feature flags 7 (api).** Keep feature flags for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new feature flags rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a feature flags change that arrives without one. See `apps/api/docs/feature-flags.md`.
- **Permissions 8 (api).** Keep permissions for api in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new permissions rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a permissions change that arrives without one. See `apps/api/docs/permissions.md`.
- **Validation 1 (web).** Keep validation for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new validation rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a validation change that arrives without one. See `apps/web/docs/validation.md`.
- **Error mapping 2 (web).** Keep error mapping for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new error mapping rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a error mapping change that arrives without one. See `apps/web/docs/error-mapping.md`.
- **Logging 3 (web).** Keep logging for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new logging rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a logging change that arrives without one. See `apps/web/docs/logging.md`.
- **Data access 4 (web).** Keep data access for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new data access rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a data access change that arrives without one. See `apps/web/docs/data-access.md`.
- **State shape 5 (web).** Keep state shape for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new state shape rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a state shape change that arrives without one. See `apps/web/docs/state-shape.md`.
- **Caching 6 (web).** Keep caching for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new caching rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a caching change that arrives without one. See `apps/web/docs/caching.md`.
- **Feature flags 7 (web).** Keep feature flags for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new feature flags rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a feature flags change that arrives without one. See `apps/web/docs/feature-flags.md`.
- **Permissions 8 (web).** Keep permissions for web in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new permissions rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a permissions change that arrives without one. See `apps/web/docs/permissions.md`.
- **Validation 1 (worker).** Keep validation for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new validation rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a validation change that arrives without one. See `apps/worker/docs/validation.md`.
- **Error mapping 2 (worker).** Keep error mapping for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new error mapping rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a error mapping change that arrives without one. See `apps/worker/docs/error-mapping.md`.
- **Logging 3 (worker).** Keep logging for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new logging rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a logging change that arrives without one. See `apps/worker/docs/logging.md`.
- **Data access 4 (worker).** Keep data access for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new data access rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a data access change that arrives without one. See `apps/worker/docs/data-access.md`.
- **State shape 5 (worker).** Keep state shape for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new state shape rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a state shape change that arrives without one. See `apps/worker/docs/state-shape.md`.
- **Caching 6 (worker).** Keep caching for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new caching rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a caching change that arrives without one. See `apps/worker/docs/caching.md`.
- **Feature flags 7 (worker).** Keep feature flags for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new feature flags rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a feature flags change that arrives without one. See `apps/worker/docs/feature-flags.md`.
- **Permissions 8 (worker).** Keep permissions for worker in the module that owns it; a handler, screen or job never reaches past its own layer to do it. When a change needs a new permissions rule, add it beside the existing ones and cover it with a test in the same commit — the reviewer rejects a permissions change that arrives without one. See `apps/worker/docs/permissions.md`.

## Environment landmines

- **Landmine 1.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 2.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 3.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 4.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 5.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 6.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 7.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.
- **Landmine 8.** The dev stack shares one Postgres across worktrees unless `COMPOSE_PROJECT_NAME` is set per worktree; two fleet runs without it migrate each other's databases mid-walk. Ports are dynamic under the fleet — read them from `docker compose port`, never assume 3000/3001. Node 20 is required; Node 22 breaks the worker's build script.

## Companion skills

| App | Skill | When |
|---|---|---|
| api | `api-recipes:routes` | every task that touches routes in api |
| api | `api-recipes:models` | every task that touches models in api |
| api | `api-recipes:tests` | every task that touches tests in api |
| api | `api-recipes:ui` | every task that touches ui in api |
| api | `api-recipes:jobs` | every task that touches jobs in api |
| web | `web-recipes:routes` | every task that touches routes in web |
| web | `web-recipes:models` | every task that touches models in web |
| web | `web-recipes:tests` | every task that touches tests in web |
| web | `web-recipes:ui` | every task that touches ui in web |
| web | `web-recipes:jobs` | every task that touches jobs in web |
| worker | `worker-recipes:routes` | every task that touches routes in worker |
| worker | `worker-recipes:models` | every task that touches models in worker |
| worker | `worker-recipes:tests` | every task that touches tests in worker |
| worker | `worker-recipes:ui` | every task that touches ui in worker |
| worker | `worker-recipes:jobs` | every task that touches jobs in worker |

## Quality gates

- Gate 1: coverage on changed lines stays at or above 80% per app; a drop needs a ruling naming the lines and why they cannot be tested.
- Gate 2: coverage on changed lines stays at or above 80% per app; a drop needs a ruling naming the lines and why they cannot be tested.
- Gate 3: coverage on changed lines stays at or above 80% per app; a drop needs a ruling naming the lines and why they cannot be tested.
- Gate 4: coverage on changed lines stays at or above 80% per app; a drop needs a ruling naming the lines and why they cannot be tested.
- Gate 5: coverage on changed lines stays at or above 80% per app; a drop needs a ruling naming the lines and why they cannot be tested.

## Standing traps

- **Trap 1.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 2.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 3.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 4.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 5.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 6.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
- **Trap 7.** The web client's generated API types are committed; after an API contract change run `pnpm --filter web gen:api` and commit the result in the consumer's phase, or the typecheck passes locally against stale types and fails in the merge tier.
