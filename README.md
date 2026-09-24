# builder — a dependency-free build pipeline (Claude Code plugin)

Invoked as `/builder:<skill>`. Start with **`/builder:brainstorm <what you want>`**; `/builder:help`
is the card.

**One command builds anything, and most of it never reaches a doc.** `/builder:brainstorm` sizes the
request first: **xs/sm** are designed and built in chat writing nothing under `docs/`; **md/lg** earn
one write-once `SPEC.md` plus a ~12-line `MANIFEST.md` and run the pipeline; **xl** becomes a program
of children. A spec is audited against the codebase **once** before any code, built **one app per
phase**, then 🔒 **walked by a human** before the one deep verify pass and a single PR.

## Installing it in another repo

Zero dependencies: no other plugin, no `npm install`, no network. Two ways in, both tested.

### A. Vendor it (what this repo does)

Copy the plugin folder in, declare a marketplace, enable it, write the config:

```bash
# 1. the plugin itself
mkdir -p plugins && cp -R /path/to/builder plugins/

# 2. declare a marketplace that points at it
mkdir -p .claude-plugin && cat > .claude-plugin/marketplace.json <<'JSON'
{
  "name": "<your-org>",
  "description": "<your-org>'s own Claude Code plugins, loaded from this repo.",
  "owner": { "name": "<Your Org>" },
  "plugins": [
    { "name": "builder", "source": "./plugins/builder", "description": "Build pipeline" }
  ]
}
JSON

# 3. enable it for the project — this is what a fresh clone reads
mkdir -p .claude && cat > .claude/settings.json <<'JSON'
{
  "enabledPlugins": { "builder@<your-org>": true },
  "extraKnownMarketplaces": {
    "<your-org>": { "source": { "source": "directory", "path": "." } }
  }
}
JSON

# 4. THE ONLY THING YOU WRITE YOURSELF
cp plugins/builder/PROJECT.template.md .claude/builder.md   # then fill it in

# 5. register + install (once per machine; step 3 is what makes it work for everyone else)
claude plugin marketplace add ./
claude plugin install builder@<your-org> --scope project
claude plugin validate .            # sanity-check the manifest
```

The plugin is now vendored with the repo, so the branch you have checked out **is** the pipeline you
run — and a teammate cloning it gets the same one.

### B. Install it from its own repository

Put `plugins/builder/` in a repo of its own with a root `.claude-plugin/marketplace.json`, then in
each consuming project add that marketplace and enable `builder@<marketplace>`. Every project tracks
one upstream instead of carrying a copy — at the cost of the pipeline no longer moving with the
branch. Same step 4 either way: **`.claude/builder.md` is the only file you write.**

### Verifying an install

```bash
claude plugin list | grep builder                        # enabled?
node plugins/builder/scripts/list-features.mjs           # reads YOUR config; "Nothing under …" is a clean pass on an empty registry
./plugins/builder/scripts/workspace --self-test          # scratch dir + gitignore work
```

If a script says it cannot find `.claude/builder.md`, that is step 4 — it is the one thing the
plugin does not ship.

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
