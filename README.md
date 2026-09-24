# builder — a dependency-free build pipeline (Claude Code plugin)

Invoked as `/builder:<skill>`. Start with **`/builder:brainstorm <what you want>`**; `/builder:help`
is the card.

**One command builds anything, and most of it never reaches a doc.** `/builder:brainstorm` sizes the
request first: **xs/sm** are designed and built in chat writing nothing under `docs/`; **md/lg** earn
one write-once `SPEC.md` plus a ~12-line `MANIFEST.md` and run the pipeline; **xl** becomes a program
of children. A spec is audited against the codebase **once** before any code, built **one app per
phase**, then 🔒 **walked by a human** before the one deep verify pass and a single PR.

## Installing it in a repo

Two steps, and there is no third.

1. **Make the plugin available.** Either vendor it (`plugins/builder/` plus a repo-root
   `.claude-plugin/marketplace.json` listing it), or install it from a marketplace. Enable it in
   `.claude/settings.json`:

   ```json
   { "enabledPlugins": { "builder@<marketplace>": true } }
   ```

2. **Write the project config** — the only thing the plugin does not ship:

   ```
   cp <plugin>/PROJECT.template.md .claude/builder.md
   ```

   Then fill it in. That file carries **every** fact about your repo: the apps and their roles, the
   literal gate commands, the global constraints pasted into every implementer brief, the house rules
   the audit enforces, the environment landmines, the recipe skills, and (optionally) a design source
   the pipeline can read as requirements.

🔴 **Nothing else is installed.** No other plugin, no `npm install`. The execution engine, the plan
format and the four craft skills are vendored (`LICENSE-THIRD-PARTY.md`), and the scripts ship in
`scripts/`.

## The four craft skills

Beside the 13 pipeline skills, the plugin carries four that bind *how* work is done rather than what
the pipeline does next — `test-driven-development`, `systematic-debugging`, `receiving-code-review`
and `verification-before-completion`. They are invocable on their own (`/builder:<name>`), handed to
every implementer **by path**, and cited at the points where they bite: the plan's steps are written
in the TDD cycle, a fix round that stops converging gets the debugging skill, a review finding is
read through the review skill, and every gate claim answers to the verification skill's iron law —
*no completion claim without fresh verification evidence.*

## What lives where

```
plugins/builder/
  PROJECT.template.md        the blank config a host repo fills in
  LICENSE-THIRD-PARTY.md     what is vendored, from where, and what the adaptation changed
  scripts/
    config.mjs               parses .claude/builder.md — the one thing that knows your project
    list-features.mjs        every feature and its next command; the picker's data source
    check-obligations.mjs    the cross-section gate on a SPEC.md
    workspace                the git-ignored per-feature scratch directory
    task-brief               extracts one task's text for its implementer
    review-package           the diff a reviewer reads in one call
  skills/
    <13 pipeline skills>/SKILL.md
    test-driven-development/ · systematic-debugging/ · receiving-code-review/
    verification-before-completion/        the four craft skills — how work is DONE
    resume/REFERENCE.md      the family's fact sheet — what the pipeline DOES
    resume/SCOPE-SELECTION.md · SURFACE-CHECK.md    prototype-mode procedures
    build/EXECUTION.md       the task loop
    build/prompts/*.md       implementer · task-reviewer · re-review · final-reviewer
    plan/PLAN-FORMAT.md      the shape of PLAN.md
```

**The split that makes it portable:** `REFERENCE.md` says what the pipeline does; `.claude/builder.md`
says what it does it *to*. No skill names an app, a language, a framework or a command.

## Multi-app, and single-app

The config's `apps:` gives each unit a **role**:

- **`producer`** owns the contract. Its phases run first, and 🔴 **the contract FREEZES when its phase
  verifies** — consumers then code against a shape that cannot move under them.
- **`consumer`** codes against the frozen contract. Consumers parallelize when they don't import each
  other.
- **`tool`** is internal; it runs after whatever it reads.
- **`app`** is the only unit — a single-app repo. The freeze machinery stays quiet and everything else
  works identically, including the day the repo grows a second unit.

Two further flags earn their keep: `commit: manual` means **an agent never commits in that app** (it
stages and stops), and `released_artifact: true` means a shipped build cannot be hot-fixed, so any
contract change it reads is breaking until §Apps states the transition.

## What it never does

- **Open a PR before a human has walked the feature.** The PR lock is spent by `/builder:signoff`,
  which is `disable-model-invocation` — an agent cannot type it, and a sign-off written any other way
  is void.
- **Write your design system.** Prototype mode *reads* a design as requirements and routes every gap
  to the command your config says owns it.
- **Write to your ticket system, or deploy.** Both are explicit commands of yours.
- **Create a branch, a worktree or a ticket**, or commit on the base branch.
