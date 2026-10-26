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
---

# Builder project configuration

Write this to `.codex/builder.md` inside the feature worktree. The existing
`.builder/config.md` or `.claude/builder.md` can be consumed without migration.
Read actual repository scripts and CI before replacing the placeholders.
Model IDs/efforts must be supported by the user's client; mappings are editable.
New builds land on explicit --into, else merge_into, else configured base_branch; without configured targets the starting branch is retained. The chosen target is immutable for the build. The go-ahead's test plan (slice · end · review) replaces the old rush/standard/thorough profiles, which still read; mandatory project checks apply to every plan.
An app may declare `depends_on: [other-app]` (or `[]`) to limit gate memo
invalidation to itself, shared code and its declared app dependencies. Without
that explicit declaration, all app changes invalidate its memo conservatively.

## Quality gates

### <app name> — fast

```
<focused tests / lint / typecheck / build / required stories commands>
```

### Deep set (verify only)

```
<assembled-system checks not already covered by the fast sets>
```

Gate markers supported by the inherited runner: `@known-red`, `@delta`,
`@scoped <glob>` with `{tests}` in the command, `@typecheck` (the line
type-checks the app — `gate.mjs <app> --typecheck` runs only these, the floor
every test plan keeps) and `@walk` (an e2e suite that needs the running app;
Claude's fleet runs it against its walk env, this port runs it as written). New violations cannot be hidden
by changing a baseline. Memo reuse does not prove live environment state.

## Global constraints

- Read applicable AGENTS.md and normative specifications before changing patterns.
- Each task changes one configured app. Shared packages need explicit ownership and dependency-aware verification.
- Workers edit only their assigned worktree, never create branches, merge, push, or publish, and never spawn other agents.
- Run focused checks per task; app gates close the phase; final integration checks exercise the assembled result.
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
apply:      <command>   # e.g. npx prisma migrate deploy
apply_mode: ask         # ask (default) · human (print the command, never run it) · agent (just run it — delivery also runs apply then regenerate in the target checkout after landing new additive migrations)
regenerate: <command>   # after a schema change — omit if none
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
gate, a failed walk) becomes one proposed line here, added only with the
owner's yes. Agents never edit this config themselves.

- <one line each>
