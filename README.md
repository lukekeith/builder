# builder — a dependency-free build pipeline for Claude Code

`claude plugin marketplace add lukekeith/builder` → `claude plugin install builder@claude-builder`

Invoked as `/builder:<skill>`. Start with **`/builder:brainstorm <what you want>`**; `/builder:help`
is the card.

**One command builds anything, and most of it never reaches a doc.** `/builder:brainstorm` sizes the
request first: **xs/sm** are designed and built in chat writing nothing under `docs/`; **md/lg** earn
one write-once `SPEC.md` plus a ~12-line `MANIFEST.md` and run the pipeline; **xl** becomes a program
of children. A spec is audited against the codebase **once** before any code, built **one app per
phase**, then 🔒 **walked by a human** before the one deep verify pass and a single PR.

## Installing it

Zero dependencies: no other plugin, no `npm install`. Install once, then configure each repo.

```bash
# 1. add the marketplace and install the plugin — once per machine
claude plugin marketplace add lukekeith/builder
claude plugin install builder@claude-builder     # user scope: every repo on this machine
```

```
# 2. in each repo, inside a Claude session — writes .claude/builder.md from what the repo contains
/builder:init
```

`/builder:init` reads the workspace layout, the gate commands, the CI workflow and `git log`, asks
only what it cannot tell (app roles, commit mode), and proves the result parses. Commit the file it
writes. `--update` fills the gaps in an existing config.

To make the plugin itself install for everyone who clones your repo, declare it in the project's
`.claude/settings.json` rather than relying on the machine-local install:

```json
{
  "enabledPlugins": { "builder@claude-builder": true },
  "extraKnownMarketplaces": {
    "claude-builder": { "source": { "source": "github", "repo": "lukekeith/builder" } }
  }
}
```

### A local copy inside the repo

Some repos won't take a plugin fetched from outside them — a settings entry naming this marketplace
gets a PR rejected. Vendor it instead: a copy inside the repo that names nothing outside it.

```
/builder:vendor            # inside a Claude session in that repo, with the plugin installed at user scope
```

or, from a clone of this repo, `node scripts/vendor.mjs <path to the repo>`. It copies only what runs
(`skills/`, `scripts/` without tests, `PROJECT.template.md`, the licences, and a `plugin.json` cut to
name, description, version and the host as author) into the folder the repo's own
`.claude-plugin/marketplace.json` names for `builder` — else `plugins/builder`, in a marketplace
named after the repo. It enables `builder@<that marketplace>` in `.claude/settings.json`, removes any
entry there naming this one, and switches the user-scope install off in the git-ignored
`.claude/settings.local.json` so the repo answers `/builder:*` from its own copy. It **refuses to write
anything** if the copy would name its source (this marketplace, repo, homepage or path), and scans
again after. **Updating is running it again**: the copy is replaced whole, and a file a newer version
dropped is deleted. `--dry-run` previews; `--check` proves an existing copy clean and says whether a
newer version is available. Project facts stay in `.claude/builder.md`, which it never touches.

### Updating

`/builder:update` in any Claude session does it: it refreshes the marketplace, updates the user-scope
install, summarises the changelog since your version, and names any project-scope install pinning an
older one in the repo you're in. `--check` only reports. By hand:

```bash
claude plugin marketplace update claude-builder   # re-read the marketplace from GitHub
claude plugin update builder                      # take the new version (restart to apply)
```

### Verifying an install

```bash
claude plugin list | grep builder                 # enabled?
claude plugin details builder@claude-builder      # 19 skills, and the token cost

# and from inside a Claude session, where $CLAUDE_PLUGIN_ROOT is set:
node "$CLAUDE_PLUGIN_ROOT/scripts/list-features.mjs"   # reads YOUR config
"$CLAUDE_PLUGIN_ROOT/scripts/workspace" --self-test
```

If a script says it cannot find `.claude/builder.md`, run `/builder:init` — the config is the one
thing the plugin deliberately does not ship.

### Vendoring it instead

Copy this repo's contents to `plugins/builder/` in your project, declare a directory marketplace
(`{"source": {"source": "directory", "path": "."}}`) and enable `builder@<your-marketplace>`. The
pipeline then moves with your branch — the checked-out code **is** the pipeline you run — at the cost
of updating by hand. The script resolution prefers a vendored copy over an installed one, so a repo
that vendors it ignores any marketplace copy on the same machine.

## The four craft skills

Beside the 13 pipeline skills, `init` and `status`, the plugin carries four that bind *how* work is done rather than what
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
    list-features.mjs        every feature and its next command; the picker's data source and /builder:status
    check-obligations.mjs    the cross-section gate on a SPEC.md
    workspace                the git-ignored per-feature scratch directory
    task-brief               extracts one task's text for its implementer
    review-package           the diff a reviewer reads in one call
  skills/
    init/SKILL.md            writes .claude/builder.md for a repo
    status/SKILL.md          the table of in-progress work, with a paste-able command per row
    update/SKILL.md          takes the newest release of a plugin install (never vendored)
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

## Unattended runs

Write the specs, then hand them over:

```
/builder:agent                  # pick unfinished features from a list
/builder:fleet --all            # or: every fresh spec, scripted — or name the features
```

Each spec gets its own worktree and `builder/<feature>` branch. Builds run in parallel; walks run one
at a time through your dev environment, done by an agent (`/builder:agent-walk`) that records evidence
per `walk.md` item and signs it off as the agent (`🤖 AGENT SIGNED OFF — not human-tested`). Then it
verifies, ships, and **merges it into the branch you ran it from** — one merge commit per feature,
and the worktree removed — so a batch of five specs lands as five merges on one branch for you to
test. Nothing is pushed and no PR is opened. Every feature ends **merged**, or **parked** with the
reason a human is needed — a conflict it can't resolve mechanically, a hold, your uncommitted change
in the way of a merge. Nothing waits on a question, and nothing runs in the background of a headless run:
long gates go through `scripts/job.mjs`, and a run is killed only after 30 minutes of silence.

Needs an `agent_walk:` block in `.claude/builder.md` — `/builder:init --update` offers to add one when
the config has none. Headless runs need permissions set explicitly (`claude_args`), because nobody is
there to approve a prompt.

Add `agent_walk.start` (and `smoke`) to give the walk lane its own dev env, on other ports and its own
database, instead of the one you're using — the fleet starts it fresh after each `reset` and always
stops it after, and never restarts it mid-walk. `copy` brings along untracked files (a `.env`, local
certs) a fresh worktree wouldn't have, `setup` runs once per new worktree, and `env` reaches the walk
lane — its headless `claude` runs and the `reset`/`start`/`smoke`/`stop` hooks — with `{feature}`
filled in so each worktree's walk env can have its own port and database. Build-lane runs and `setup`
never see `env`, so parallel builds stay off the walk env.

## What it never does

- **Open a PR before a human has walked the feature.** The PR lock is spent by `/builder:signoff`,
  which is `disable-model-invocation` — an agent cannot type it, and a sign-off written any other way
  is void. (Agent mode — `/builder:agent`, `/builder:fleet` — is the one exception you opt into: its
  sign-off is the agent's, labelled 🤖, and it merges into your branch locally; it never writes
  yours, pushes, or opens a PR.)
- **Write your design system.** Prototype mode *reads* a design as requirements and routes every gap
  to the command your config says owns it.
- **Write to your ticket system, or deploy.** Both are explicit commands of yours.
- **Create a branch, a worktree or a ticket**, or commit on the base branch.
