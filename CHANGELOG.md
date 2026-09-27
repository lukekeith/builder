# Changelog

`version` in `.claude-plugin/plugin.json` is the release number. Cut a release with
`claude plugin tag --push`, which refuses to tag unless `plugin.json` and the marketplace entry
agree — see [RELEASING.md](RELEASING.md).

## 3.0.1

- **A *Depends on* entry outside the program counts.** `glyph-library (shipped)` named a shipped
  program in the registry, but the parser read it as two unknown children and held the child back
  for good. A parenthetical is now a note, and a token that isn't a child is looked up as a registry
  feature or program — met when its SPEC or PROGRAM header says SHIPPED or its manifest says
  `state: shipped`. A token naming nothing still holds the child back.
- **A planned feature no longer claims its spec branch.** A manifest's `branch:` is honoured only from
  `building` on (was `planned`), so a feature planned on the branch another feature is building on
  gets its own `builder/<feature>` branch instead of colliding with it.

## 3.0.0

**Agent mode finishes the job, on your branch.** `/builder:agent` and `/builder:fleet` now take every
feature all the way — verified and **merged into the branch you ran them from** — or park it with the
reason a human is needed. Run it against five specs and you get five merge commits on one branch to
test, not five worktrees to walk. No config key changes, but what `--agent-walk` does has changed, so
it is a major.

- **Agent sign-off.** An agent walk that passes writes the agent's sign-off (`walk: agent-pass`,
  `state: signed-off`, SPEC header `> 🤖 AGENT SIGNED OFF … not human-tested`) and condenses the
  folder, the way `/builder:signoff` does for a human. `/builder:signoff` stays human-only, and a
  human sign-off over an agent one hands the feature back to the human flow.
- **Ship in agent mode** (resume): merge the target branch in (fast gates if it moved; a conflict
  that isn't mechanical parks), then `/builder:ship` with a `SHIPPED … merged into <branch>` header.
- **The fleet merges** each shipped feature into the branch checked out where it was started — its
  target, kept in `fleet.json` — as one `--no-ff` merge commit, `merge(<feature>): agent-verified,
  not human-tested`, then removes the feature's worktree and `builder/` branch. A merge your
  uncommitted changes are in the way of parks, untouched, and the next fleet run retries it. A
  re-run from another branch is refused while the fleet has unfinished work. **Nothing is pushed and
  no PR is opened** — both stay yours. Every run is told the target (`--into <branch>`).
- **The fleet has a ship lane** sharing the parallel pool with builds, so shipping never holds the
  one-at-a-time walk lane. A feature with an open PR (an agent draft from 2.x) is taken on and
  merged locally; its PR is left for you to close.
- **Program chains run in one fleet run.** A child waits for its dependencies in the same run to be
  merged into the target, then is branched from it. A dependency outside the run refuses the child;
  one that parks parks its waiters.

**Headless runs finish what they start.** A `claude -p` run exits when its last turn ends, taking
anything it backgrounded with it — in practice, a verify whose gate suite was cut off three runs in a
row, then parked for "no progress".

- Under `--agent-walk` nothing runs in the background: no `run_in_background`, `ScheduleWakeup` or
  `Monitor`; subagents run in the foreground; a long command goes through the new
  **`scripts/job.mjs`** (`start` it detached, `wait` on it in bounded foreground calls until it
  reports an exit code); and a run's last message is a handoff after the work finished.
- The fleet streams each run's output (`--output-format stream-json`) and kills a run only after **30
  minutes of silence** (`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`),
  instead of a flat 45 minutes that killed healthy long builds. The `.log` gets the run's words as it
  works; the raw stream goes to a `.jsonl` beside it.
- One run with no progress gets another; two in a row park.

## 2.7.0

**Program dependencies are enforced for unattended runs.** A program child whose PROGRAM §Children
*Depends on* entries haven't all shipped is no longer offered by `/builder:agent`, and the fleet
refuses it (`✗ <child> — waits on <dep> (<state>)`) instead of building it off `HEAD` against a
contract that isn't merged. `list-features.mjs --json` gains a `waitsOn` array per row, and
`/builder:status` shows `⏳ waits on …` as the next step. A dependency counts as shipped when its
program `child:` line says so or its own folder does (a `✅ SHIPPED` header or `state: shipped`); a
*Depends on* token naming no child holds the child back. Chains run one wave per fleet run, after
each merge. No config change.

## 2.6.0

**An isolated walk env, owned by the fleet.** `agent_walk` gains five optional keys: `copy` (untracked
files — a `.env`, local certs — brought into each NEW worktree; never overwrites a tracked file, and a
missing source is just noted), `setup` (runs once per new worktree, after `copy`; a failure parks the
feature with `setup failed — see <log>` and is retried on the next fleet run), `env` (whitespace-
separated `KEY=VALUE` pairs, quotes allowed, `{feature}` substituted, merged over the environment and
passed to the walk lane only — its headless `claude -p` runs and the `reset`/`start`/`smoke`/`stop`
hooks; build-lane runs and `setup` never see it, so parallel builds can't hit the walk env's ports or
database — and it can never set `CLAUDE_PROJECT_DIR`; the fleet drops it and notes that), and
`start`/`smoke` (a second dev env for the walk lane: the fleet spawns `start` detached after `reset`,
polls `smoke` every 2s for up to 5 min, and — after the walk ends for any reason, including a park —
always kills `start`'s process group before running `stop`).
If `smoke` never passes, or `start` exits first, the feature parks with "walk env didn't come up". A
`start` with no `smoke` just waits 10s. REFERENCE §Walk readiness now says what changes when the fleet
has already started this env: it runs `agent_walk.smoke` in place of its own, never starts or
restarts anything, and a restart-class change parks instead of restarting.

**`/builder:init`'s `--update`** now **offers** an `agent_walk:` block once, rather than filling it in
outright, when the config has none — a missing optional block is not a gap.

**Correction:** 2.5.0 said `/builder:init --update` adds the `agent_walk:` block. It offers it instead.

## 2.5.0

**Unattended runs.** `/builder:agent` lets you tick unfinished features — at any step before the PR — and hands them to agents until each is a draft PR or parked with a reason; `/builder:fleet` takes a batch of written specs to draft PRs with no human in the
loop: one worktree and `builder/<feature>` branch per spec, builds in parallel, walks one at a time
through the shared dev environment. `scripts/fleet.mjs` does the work and resumes from
`.builder/fleet/fleet.json` if stopped, and continues a feature already underway on its own branch; `--dry-run` and `--status` show the plan and the table.

**`--agent-walk`** — the mode the fleet runs in — implies `--auto` and never asks: each pause takes
its recommendation or **parks** the feature with a new manifest line, `blocked:`, which
`/builder:resume` honours until a human clears it. **`--no-dev-env`** keeps parallel builds off the dev
environment. **`/builder:agent-walk`** replaces the human walk with a fresh agent working `walk.md`
with the configured driver, and records `walk: agent-pass` and `🤖 AGENT-VERIFIED — not human-tested`
— never a human sign-off. Two failed rounds park the feature.

**The PR lock, amended once:** an agent-verified feature may open a **draft** PR; marking it ready
still requires `/builder:signoff`, which stays human-only. A human PASS supersedes the agent's verdict.

**Config:** an optional `agent_walk:` block (`driver`, `claude_args`, and optionally `worktrees`,
`parallel`, `reset`, `stop`). Without it nothing changes. `/builder:init --update` adds it.

**Scripts:** `scripts/manifest.mjs` (shared parser), `scripts/fleet-core.mjs`, `scripts/fleet.mjs`, and
the first test suite — `node --test 'scripts/test/*.test.mjs'`.

## 2.4.0

**Say "go" instead of pasting the next command.** Every handoff still ends with its 📍 footer, but a
bare affirmative in reply — "go", "yes", "proceed", "continue" — now runs that footer's command in the
same turn. Nothing is skipped: the command runs as if typed, and every gate it reaches still asks.
`/builder:resume` is no longer `disable-model-invocation`, so "continue where I left off" works in a
fresh session too, and a mid-build context stop offers "go" to carry on in the session instead of
requiring `/clear`. Footers that "go" can continue end with ` · or say go`; `/builder:status` accepts
a feature's name as the reply.

Unchanged by design: `/builder:signoff` is still typed by the human only, and "approve" after a walk
is answered with the command to type, not a sign-off. A step only the human can do, a hold, and
anything with more than one candidate still stop, and opening the PR asks once even after a "go".
The rule lives in REFERENCE §Continuing on "go".

## 2.3.0

**Walk readiness** — the pipeline no longer asks a human to walk, or sign off, a build the dev
environment isn't running. Green gates run against a test database; the walk doesn't. Before the walk
script is printed (and after walk fixes, and at the end of an xs/sm change) it now checks the dev
database for pending migrations and **asks before applying them**, regenerates and restarts what went
stale, and smokes each changed surface — endpoints, pages, their console and the server log. An
error it finds is fixed as a build defect, not handed over as a walk item. A new manifest line,
`ready:`, records it; `/builder:signoff` refuses a PASS while it is pending, and `/builder:status`
shows what's left.

**Config:** a new `## Walk readiness` section in `.claude/builder.md` — the migrations directory and
the status / apply / regenerate / start / smoke commands, plus `apply_mode: ask | human | agent`.
Optional: without it the pipeline infers the commands and says so. `/builder:init --update` adds it
to an existing config.

## 2.2.0

**`/builder:status`** — every in-progress feature and program in one table, most recently touched
first: what it is (the SPEC's first Overview sentence), the step last completed, the step next, when
it last moved, and the `/builder:resume` command to paste to pick it up. Flags a feature whose branch
isn't the one checked out, and one that can't be resumed as it stands. Backed by
`list-features.mjs --status`, so it reads manifests only and writes nothing.

## 2.1.0

**`/builder:init`** — per-repo setup in one command. It reads the repo (workspaces, gate commands, CI,
`git log`), asks only what it cannot tell, writes `.claude/builder.md` and proves it parses.
`--update` fills gaps in an existing config without touching what a human wrote. The missing-config
message in every script and skill now points at it. No change to the config format.

## 2.0.3

Public release. Correct authorship and homepage, a contribution guide and a PR template. No change
to the pipeline.

## 2.0.2

Corrects the 2.0.1 note, which named the wrong cause. A marketplace install **does** materialise the
plugin on disk immediately. What was wrong is that the fallback hardcoded `~/.claude`, and the
config directory moves — `CLAUDE_CONFIG_DIR` pointed at `~/.claude-home` on the machine this was
found on, where the files were sitting the whole time. The fallback now reads
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.

## 2.0.1

Script resolution now prefers **`$CLAUDE_PLUGIN_ROOT`**, the documented, portable way for a plugin
to reference its own files, with the previous paths kept as fallbacks. (The cause given for the bug
in this release was wrong — see 2.0.2.)

## 2.0.0

**Dependency-free and project-agnostic.** The plugin no longer requires any other plugin, and no
longer knows anything about the repo it runs in.

- The execution engine, its four agent prompts, the plan format and two scripts are vendored
  (MIT — `LICENSE-THIRD-PARTY.md` records what came from where and what the adaptation changed).
- Every project fact moved to a single host file, `.claude/builder.md`: the apps and their roles,
  the literal gate commands, the global constraints pasted into every implementer brief, the house
  rules, the environment landmines, the recipe skills and an optional design source.
- **Apps have roles** — `producer` owns the contract and its phase freezes it, `consumer` codes
  against the frozen shape, `tool` runs after what it reads, `app` is a single-unit repo. Plus
  `commit: manual` (an agent never commits there) and `released_artifact: true` (a contract change
  it reads is breaking until §Apps states the transition).
- **Four craft skills** vendored essentially verbatim: `test-driven-development`,
  `systematic-debugging`, `receiving-code-review`, `verification-before-completion` — handed to
  every implementer by path and cited where they bite.
- Scripts moved into the plugin and read the config: `list-features.mjs`, `check-obligations.mjs`,
  `workspace`, `task-brief`, `review-package`.

Fixes in this line: an app literally named `app` matched the §Apps table header and reported every
app out of scope; a `SPEC.md` with no manifest was misread as analysis rather than an incomplete
feature; the script-resolution recipe used a bare glob (aborts under zsh) and an unsorted `find`
(picked a stale cached version).

## 1.0.0

First release — the pipeline as a plugin: sizing, SPEC/PLAN/MANIFEST, the one-pass audit, one app
per phase, the human walk and the PR lock. Depended on the superpowers plugin.
