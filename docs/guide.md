# builder — the guide

The details behind the [README](../README.md): installing and updating every way, the config, how
multi-app repos are handled, agent runs, the test plan, hooks, and what builder never does. The
skills themselves are the source of truth — `skills/resume/REFERENCE.md` says what the pipeline
does, and `.claude/builder.md` says what it does it to.

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
claude plugin details builder@claude-builder      # its skills, and what it costs in context

# and from inside a Claude session, where $CLAUDE_PLUGIN_ROOT is set:
node "$CLAUDE_PLUGIN_ROOT/scripts/list-features.mjs"   # reads YOUR config
"$CLAUDE_PLUGIN_ROOT/scripts/workspace" --self-test
```

If a script says it cannot find `.claude/builder.md`, run `/builder:init` — the config is the one
thing the plugin deliberately does not ship.


## The four craft skills

Beside the pipeline skills, the plugin carries four that bind *how* work is done rather than what
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
    registry.mjs             the registry's layout: in-flight folders vs <registry>/_archive/; --sweep archives old shipped ones
    check-obligations.mjs    the cross-section gate on a SPEC.md
    gate.mjs                 runs an app's gate block or the deep set; flaky re-runs, @delta baselines,
                             and a memo that quotes a green run whose inputs haven't changed
    workspace                the git-ignored per-feature scratch directory (--remove at ship)
    task-brief               extracts one task's text for its implementer
    review-package           the diff a reviewer reads in one call
  skills/
    init/SKILL.md            writes .claude/builder.md for a repo
    brainstorm/SKILL.md      the exploration conversation; CONVERSATION.md is the mechanics it shares with intake
    intake/SKILL.md          verifies a worked-out spec, ticket or design ref against the code
    spec/SKILL.md            writes SPEC.md (§Idea first) + MANIFEST.md from the confirmed conversation
    status/SKILL.md          the table of in-progress work, with a paste-able command per row
    update/SKILL.md          takes the newest release of a plugin install (never vendored)
    <the pipeline skills>/SKILL.md
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

## Agent runs — the default

**With an `agent_walk:` block — and `/builder:init` always writes one — agents build, test and
merge a feature by default.** Saying "go" at the build go-ahead, or picking **Agent** on a hand-off,
hands the feature to agents: they build it in its own worktree, an agent tests it in the running app
(the *agent walk*), it is verified, and it is merged into the `merge_into` branch on your machine,
recorded as `🤖 AGENT SIGNED OFF — not human-tested`. Nothing is pushed and no PR is opened.

**To test it yourself instead**, either pick **In this session** on a hand-off before the build (it
builds in your session and stops for your walk and `/builder:signoff`), or at the go-ahead choose
*Change the test plan*, set the end to the risky parts or everything, and answer **Yes** to *Walk it
yourself before it lands?*.

Several specs at once, or work in flight, can be handed over directly:

```
/builder:agent                  # pick unfinished features from a list
/builder:fleet --all            # or: every fresh spec, scripted — or name the features
/builder:fleet <feature>…       # while a fleet runs: the specs join its queue, no second fleet
```

Or build it yourself, without the ceremony: pick **In this session** on the handoff (or `/builder:resume --path <folder> --here`).
The audit and plan still run; then the session works the plan task by task, test first, with each app's fast gates,
and stops at `built`. No fleet, no reviewer agents, no walk lock, and `/builder:resume` can finish it later.

Each spec gets its own worktree and `builder/<feature>` branch. Builds run in parallel; walks run one
at a time through your dev environment, done by an agent (`/builder:agent-walk`) that records evidence
per `walk.md` item and signs it off as the agent (`🤖 AGENT SIGNED OFF — not human-tested`). Then it
verifies, ships, and **merges it into the `merge_into` branch** (default `base_branch`, or `--into` for one
run) — one merge commit per feature, its worktree and branch removed — so a batch of five specs lands as five merges on one branch for you to
test. Nothing is pushed and no PR is opened. Every feature ends **merged**. Merge conflicts, red
gates, failed agent walks and a walk env that won't start are work the agents do, not reasons to
stop; a feature **parks** only when its spec leaves a product decision open, or on a step you reserve
to yourself (a `commit: manual` app, a `hold:`, your uncommitted change in the way of the merge). Nothing waits on a question, and nothing runs in the background of a headless run:
long gates go through `scripts/job.mjs`, and a run is killed only after 30 minutes of silence.

With an `agent_walk:` block, **the plan's go-ahead hands every feature to agents.** Every go-ahead —
in chat or for agents — shows the plan as numbered slices, one per task, grouped by app, with what
each one tests, and the **test plan** with what it costs: test runs, and minutes once the gates have
been timed. "go" takes the recommended plan; *Change the test plan* asks three questions, recorded as
`tests:` on the manifest:

| Question | Options (recommended first) |
|---|---|
| **Testing per slice** | its own tests · plus the app's suite when its slices are done · the app's suite after every slice · none while building |
| **Testing at the end** | the touched apps' suites once · plus an agent tries the risky parts · everything: deep set, cross-app E2E, the full agent walk · nothing — you test it |
| **Review** | once at the end · once per app · after every slice |

**Measuring it.** `/builder:benchmark` runs one small feature (a notes CLI gaining tags) through
builder with the recommended test plan and with everything, and through superpowers and GSD,
unattended, and writes
`bench/results/<run>/REPORT.md`: wall time, time per step, what each step did, turns, tokens, cost,
and whether the feature passes acceptance tests the agent never saw. Configs run one at a time;
nothing in your Claude home changes. `/builder:benchmark --status` while it runs.

The recommended plan is the fast one; a breaking schema change, a migration or a released consumer raises only the end, and
says why. *Other* reaches the rest (models, persistence, open choices), and an agent build that tests
the risky parts or everything can add your own walk before it lands. Landing is always the local
merge; PR + CI landing is deferred, since the fleet never pushes. **The floors hold under every
plan:** a type-check of every touched app before the work lands, and the final whole-branch review.
An old `profile:` line on a manifest is still read, and `build_profile_default` in the config still
sets the project's default plan.

Needs an `agent_walk:` block in `.claude/builder.md` — `/builder:init --update` offers to add one when
the config has none. Headless runs need permissions set explicitly (`claude_args`), because nobody is
there to approve a prompt.

Add `agent_walk.start` (and `smoke`) to give the walk lane its own dev env, on other ports and its own
database, instead of the one you're using — the fleet starts it fresh after each `reset` and always
stops it after, and never restarts it mid-walk. `copy` brings along untracked files (a `.env`, local
certs) a fresh worktree wouldn't have, `setup` runs once per new worktree, and `env` reaches the walk
lane — its headless `claude` runs and the `reset`/`start`/`smoke`/`stop` hooks — with `{feature}`
filled in so each worktree's walk env can have its own port and database. Build-lane runs and `setup`
never see `env`, so parallel builds stay off the walk env. **`worktree_env`** reaches every run and
`setup` in a worktree with `{feature}` filled in — a `TEST_DATABASE_URL` per worktree is what makes
`parallel: 3` safe when the test suites would otherwise share one database.

Every worktree is merged up to the branch the fleet runs from before each build run and before its
walk env starts, so features integrate as they land rather than all at ship; `sync` (an install plus
the test-DB migration) runs after a merge that brought new commits. Gate blocks run through
`scripts/gate.mjs`, which re-runs the config's known flakes once, judges `@delta` counts against the
base branch, and quotes a green run whose inputs have not changed instead of re-running it — the
measured reason a d2m-sized feature spent 60% of its wall-clock in tests was the same suite running
about fourteen times.

## Nothing left behind

Finished features merge into one branch — `merge_into` in `.claude/builder.md`, defaulting to
`base_branch` — whatever you have checked out, and `--into <branch>` picks another for one run.
A merged feature's worktree and branch are removed; a parked one keeps only its branch, with why and
the next step. `/builder:status` and every fleet report end with a `repo:` line — `repo: clean`, or
what is left over — and **`/builder:tidy`** takes a repo back to clean: one table of every branch and
worktree, one OK for everything safe (delete what's merged, remove dead worktrees, merge what's
verified), one question each for the rest. It never pushes and never loses uncommitted work.

## Live progress in the status line

`/builder:statusline` adds builder's progress to the end of your Claude Code status line while
builder is working — one bar for everything running, then what each part is doing:

    Opus 5.5 │ my-app ██░░░░░░░░ 21% │ builder ▓▓▓▓▓░░░░░ 52% · ⚙ fleet 2/4 · cover-sheet build 4/9 · gate deep set ⏱ 3m

It shows a running fleet, a build in the chat (while its ledger has moved in the last five minutes)
and running gates and jobs, refreshes every two seconds, and reads `builder ░░░░░░░░░░ idle` when
nothing runs. A plugin
can't set the status line itself, so the skill writes the `statusLine` key of your user settings: it
points at a small launcher in `<config>/builder/` that runs your previous status line first and finds
the current builder on every refresh — so updates need no re-run (a release that changes the launcher
itself says so; `/builder:statusline` refreshes it). `/builder:statusline --off` puts your
previous setting back exactly.

## Hooks

The plugin ships two hooks (`hooks/hooks.json`), and both are silent in any repo without
`.claude/builder.md` — builder is installed for every repo, so the others pay nothing.

- **A session brief** (SessionStart, on startup, `/clear` and compaction) — a dozen lines telling
  Claude builder is set up here: new work starts with `/builder:brainstorm`, `/builder:status` and
  `/builder:resume` for work in flight, the features in flight (up to five) with their next step,
  and that in this repo builder's skills take precedence over their superpowers twins (brainstorm,
  plan and build, test-driven-development, systematic-debugging, verification-before-completion,
  receiving-code-review). Skipped under unattended runs.
- **The PR lock** (PreToolUse on Bash) — `gh pr create` on a builder feature's branch is denied
  until the feature has been walked and signed off (`walk: none` → "🔒 walk it, then
  `/builder:signoff`"); an agent's sign-off passes only in agent mode. A PR on any other branch is
  never touched, and any error in the hook lets the command through.

`/hooks` lists them (labelled with the plugin) and shows what each runs; it is read-only. Claude
Code has no switch for one plugin's hooks: `"disableAllHooks": true` in your settings turns off every
hook (builder's included), and disabling the builder plugin turns them off with the rest of builder.

## What it never does

- **Open a PR before a human has walked the feature.** The PR lock is spent by `/builder:signoff`,
  which is `disable-model-invocation` — an agent cannot type it, and a sign-off written any other way
  is void. Agent mode — the default for a build, and `/builder:agent`, `/builder:fleet` — never
  opens a PR at all: its sign-off is the agent's, labelled 🤖 *not human-tested*, and it lands the
  feature by a local merge into `merge_into`. It never writes your sign-off and never pushes.
- **Write your design system.** Prototype mode *reads* a design as requirements and routes every gap
  to the command your config says owns it.
- **Write to your ticket system, or deploy.** Both are explicit commands of yours.
- **Create a branch, a worktree or a ticket**, or commit on the base branch.
