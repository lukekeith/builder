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
---

# <Your Project> — builder config

One paragraph: what this repo is, and how its units relate.

## Quality gates

The literal commands, per app. **The fast set runs at every phase close** — a
phase touches ONE app, so its gates are one block below. **The deep set runs
once, in `/builder:verify`.**

> Record any gate that is KNOWN-RED repo-wide here, with what makes it red, so
> a feature is judged on the gates that actually exist rather than failing on
> inherited debt.

### <app> — fast

```
<command>          # what it proves
```

### Deep set (verify only)

```
<command>          # what it proves
```

## Global constraints

🔴 **This block is pasted VERBATIM into every implementer and reviewer brief.**
Write each bullet as ONE long line — it survives the paste whole that way. Keep
it to what an implementer who has never seen this repo would get wrong.

- **Your task touches ONE app.** Its `App:` line says which. Do not edit another app "while you are in there".
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
