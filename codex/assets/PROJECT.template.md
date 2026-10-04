---
project: <project name>
registry: docs/features
base_branch: main
merge_into: main
build_profile_default: thorough
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
---

# Builder project configuration

Write this to `.codex/builder.md` inside the feature worktree. The existing
`.builder/config.md` or `.claude/builder.md` can be consumed without migration.
Read actual repository scripts and CI before replacing the placeholders.
Model IDs/efforts must be supported by the user's client; mappings are editable.
New builds land on explicit --into, else merge_into, else configured base_branch; without configured targets the starting branch is retained. The chosen target is immutable for the build. Profiles are rush, standard, thorough, thorough-you or custom; mandatory project checks apply to every profile.
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

Gate markers supported by the inherited runner: `@known-red`, `@delta`, and
`@scoped <glob>` with `{tests}` in the command. New violations cannot be hidden
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
State whether a personal human walk is mandatory or agent verification is acceptable.

## Companion skills

| Task | Skill |
|---|---|
| <project-specific work> | <installed skill name/path> |

## Environment landmines

Record only established ports, resource ownership, setup constraints, and known traps.
