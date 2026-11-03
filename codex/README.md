# Builder for Codex

Claude Builder is developed first in this repository's root. The self-contained `codex/` package adapts those features to Codex and uses the same release version after migration is verified. It requires Node and Git, with no npm dependencies, GSD or Superpowers.

## What's new in 6.1.1 — only the commit that was signed off lands

`lifecycle.mjs deliver` now lands only the commit that was signed off: code committed after the sign-off — a fix after a red merge test, a resolved conflict — is refused with "changed since it was signed off — walk it again and sign off, then deliver" (registry commits still pass). After an agent or no-walk sign-off the agent walk runs again on its own (at most twice); after your own walk, `$builder` asks whether you walk it again or hand it to the agent walk. A recorded quick check or skip holds only at its own commit. Nothing to change in your config.

## What's new in 6.1.0 — verify is optional after sign-off

Once a feature is signed off, `$builder` asks one question: **Quick check** (recommended — `scripts/verify-quick.mjs`, one script and no agents: the sign-off, open fixes, schema rows, open decisions, the spec's obligations and the merge tier on this commit, each ✓ or ✗), **Ship it** (no check) or **Full verify** (the verified checkpoint, as before). None is required: `lifecycle.mjs deliver` lands any signed-off feature through the merge queue and records which check ran; a ✗ is advice. Under `--auto` or an agent handoff the quick check runs and its gaps go in the report. The archive's SHIPPED header names the check. Nothing to change in your config.

## Upgrading to 6.0.0 — run `$builder init --update` in each repo first

**6.0.0 is a major release: every project must migrate its config once before its next build.** Tests now run through the verifier, configured by a `verify:` block that **replaces `## Quality gates`**. In each repo, after updating the plugin and starting a new session:

```text
$builder init --update
```

It shows the migrated `verify:` block as a review — each suite and check and when it runs, what is removed (the gates section, `flaky:`, the `@` gate markers) and what to check — and writes it, in a feature worktree, only once you approve. It migrates the config Codex selects (`.codex/builder.md` → `.builder/config.md` → `.claude/builder.md`), so a repo that shares `.claude/builder.md` with Claude Code is migrated once for both editions (Claude's `/builder:init --update` does the same migration). Until then, every test request is env-broken with "run `$builder init --update`" — nothing falls back to the old gates, and nothing is reported green untested.

What else changes for you:

- **Builds test through the verifier** (`codex/scripts/verify/`): each task's commit is tested in the background, the phase close is the build's only wait, and a failing test becomes a fix to the task that broke it. The verifier learns known failures and flaky tests itself — they are never configured.
- **Landing goes through the verifier's merge queue**: the feature merged onto the target is tested whole, held while the walk runs, and the exact commit every suite ran on is what lands (compare-and-swap). READY = the merge tier green + the walk passed.
- **A landing your uncommitted changes would run into asks you** — set them aside, land, put them back (recommended for 3 files or fewer) · commit them, then land (recommended above 3) · leave it — and never touches them without your answer. `$builder status` and `$builder resume` raise it.
- **The test plan is `walk · review`** (`slice`/`end` are gone; a plan approved under 5.x maps onto it on read).
- **`$builder archive`** moves finished feature folders out of the registry (SHIPPED · CLOSED · DROPPED), in one reviewed commit.
- In-flight features carry on: a mid-build feature's next phase close uses the verifier, and an old `.builder/gates/` folder is ignored.

## Install a published release

```sh
codex plugin marketplace add lukekeith/builder --ref main
codex plugin add builder@builder-codex
```

Start a new Codex session, then use `$builder init` in a project and `$builder brainstorm <idea>` or `$builder <request>`. An existing `.claude/builder.md` is read where it is (no renaming); a 5.x one needs the one-time `verify:` migration above. Configuration precedence is `.codex/builder.md`, `.builder/config.md`, then `.claude/builder.md`; the first existing file is authoritative.

Updates:

```sh
codex plugin marketplace upgrade builder-codex
codex plugin add builder@builder-codex
```

For a local development package, replace `lukekeith/builder --ref main` with the absolute repository path. The catalog at `.agents/plugins/marketplace.json` points to `./codex`. Restart/new session loads the updated skills. Open sessions retain their loaded version.

## Claude-first development and sync

Make and release changes to Claude Builder normally. In Codex, open this repository and run:

```text
$sync
```

Sync reads changes since `codex/upstream.json`, adapts new behavior, adds meaningful verification, obtains review, aligns the release version, and publishes a separate Codex tag and GitHub release. `$sync --no-release` performs the migration and verification locally; `$sync --check` reports readiness. An installed skill cache is never edited as the maintained source.

Sync is an agent workflow. A deterministic script cannot translate new Claude workflows into correct Codex behavior by changing words or bumping a version. These helper commands make the work inspectable:

```sh
node codex/scripts/sync.mjs plan --ref main
node codex/scripts/sync.mjs copy-shared --ref <pinned-upstream-sha>
# Adapt changes and fill every disposition/evidence row in the generated decisions.json.
node codex/scripts/sync.mjs finish --ref <pinned-upstream-sha> --report <decisions.json>
node codex/scripts/sync.mjs check
```

Plan writes the complete upstream diff and a decisions template in ignored `.builder/codex-sync/<base>/<sha>/`. Only `manifest.mjs`, `impact.mjs`, `registry.mjs`, `task-brief`, and `review-package` are automatically copyable; conflicting Codex edits stop all shared copying. Changed scripts, skills, config, additions and deletions otherwise require explicit adaptation/equivalence/exclusion rulings. Finish validates coverage, runs the full Codex tests and records a digest. Release refuses stale upstream changes, package edits after verification, dirty trees, wrong branches and tag collisions. Coordinator review and evidence establish behavior; the digest establishes package identity.

The legacy `sync-version.mjs` helper only aligns version metadata. It does not migrate features and cannot satisfy the release check.

## Local rollout

```text
$update-local
```

This mirrors Claude's maintainer rollout: plugin-mode consumers use one global Codex install; vendored consumers get a runtime-only vendored copy. No consumer commits are made. Preview/check by hand:

```sh
node codex/scripts/update-local.mjs --dry-run
node codex/scripts/update-local.mjs --check
node codex/scripts/update-local.mjs
# Roll out an explicitly selected local build:
node codex/scripts/update-local.mjs --source /absolute/path/to/builder
```

List your repos in `~/.codex/builder-local.json` or `--repos <json-file>`:

```json
{"repos":[{"name":"my-project","path":"/absolute/path/to/project","mode":"plugin"}]}
```

Use `vendor` mode for a host-owned runtime copy. Vendoring uses the host's existing Codex Builder catalog entry or `plugins/builder-codex`; it preserves other marketplace entries/configuration, enables the host family and disables the global family in that project. Maintainer sync/release/rollout tools and source repository metadata are excluded. Whole-tree replacement deletes retired files. Ownership receipts, content digests and Git status protect unrelated destinations and local edits. `--force` is only for explicitly authorized overwrites. A known local marketplace registration can be switched to the published source with rollback on registration failure. A failed repository is reported independently; a failed global refresh stops the rollout. Project-local catalogs and disabled global entries are reported as possible shadowing, never assumed to load the updated global install.

## Release

After reviewed changes are committed and landed on main:

```sh
node codex/scripts/release.mjs --dry-run
node codex/scripts/release.mjs --pack       # verified archive in ignored dist/
node codex/scripts/release.mjs --publish   # tag, atomic push, GitHub release
```

Tags are `builder-codex--v<version>`, independent from Claude's `builder--v<version>`. The archive contains the marketplace and package so an extracted archive is also a local marketplace. See [RELEASING.md](../RELEASING.md).

## Codex adaptation boundaries

- Every size starts in an isolated worktree before config/spec edits and retains a short durable spec/plan.
- Feature artifacts, a compact handoff and Git-common metadata preserve identity across context clearing. A new clone explicitly reconstructs identity from tracked records and Git.
- Native session-owned Codex workers replace Claude's detached fleet. Session termination needs a durable resume; background survival is not claimed.
- Profiles select testing, independent review, model routing, persistence and acceptance. Required project checks always remain mandatory. Preference selection occurs before delegation, even without a plan; recorded choices survive later approval.
- Immutable landing targets, the verifier's merge queue (the exact merged commit every suite ran on is what lands, by compare-and-swap), per-feature pause/revision and actual human-walk evidence protect delivery. Human-walk worktrees remain available until completion.
- Value-sized decomposition offers One spec and the fewest independently usable shipping outcomes. Missing plans yield no numerical estimate.
- Claude-specific status-line integration and repo-wide tidy are excluded. `$builder status` prints the verifier's `verify.mjs status` lines and the registry's `archive.mjs plan --summary` line instead.
- `$builder archive` is Claude's `/builder:archive` without a ship step or fleet: a feature that landed through the merge queue (its `Merge builder feature <name>` commit, or the runtime record's merged head) is SHIPPED, naming the check that ran after its sign-off (verified, quick-checked or not verified); one merged by hand is SHIPPED the same way once signed off, and CLOSED — never called shipped — when it never was; a feature with a live Codex record (not merged or cleaned up, its worktree still there) is never touched. It is `codex/scripts/archive.mjs`, not a subcommand of the shared `registry.mjs`, so `sync.mjs copy-shared` can keep copying `registry.mjs` byte for byte. The Codex release supplies its own sync, update-local and vendor tooling.
- Claude's `/builder:benchmark` (`bench.mjs`, `bench-core.mjs`, its fixtures and vendored `bench/`) is excluded. It is a maintainer measurement of Claude Code pipelines: it drives `claude -p --output-format stream-json` sessions with `--plugin-dir`, compares the Claude plugin's profiles against the Superpowers and GSD Claude plugins, and derives steps from Claude's `Skill`/`Agent` tool events. Codex has no Superpowers or GSD port to compare against, its stream has no such step events, and this package never invokes Claude subprocesses. A Codex-native benchmark would be a new product, not a port.
- `build: here` keeps Codex isolation: the coordinator works PLAN in the existing feature worktree (never the starting checkout), and a here build never lands without the independent final review, walk and the merge tier.
- The test plan is `walk · review` as in Claude 6.0 (how much an agent walks the running app · when the work is reviewed); tests are not a lever — the verifier runs them under every plan. `tests:` is written by `lifecycle.mjs approve --tests`; an old `profile:` or a 5.x `slice=… end=…` value maps onto it on read. Under every plan the merged result is tested whole before it lands, beside Claude's final-review floor.
- Claude's lean-orchestrator scripts (`dispatch.mjs`, `advance.mjs`, `condense.mjs`, `docs.mjs`, `handoff.mjs`, `walk-script.mjs`, `plan-slices.mjs`, `feature-core.mjs`, `list-features.mjs`) render Claude Agent-tool prompts and Claude manifest/ledger edits; Codex's coordinator, `lifecycle.mjs` and `task-brief` already own those steps, so they are not ported.
- Claude's fleet machinery is excluded: the walk lane and batched walks (`agent_walk.batch` is parsed so a shared config reads the same), `job.mjs`, `stub-claude`, the status line, session hooks and the PR lock (Claude Code hooks), `claude plugin eval` behaviour evals, CI for the Claude package, and the skill-description token budget (a Claude Code skill-list limit). The lean-walk rules (one-app script, walk by screen, re-walk only what changed) are carried as coordinator instructions.
- `merge_into: current` resolves at `lifecycle.mjs start` to the branch the starting checkout is on (a detached HEAD or a `builder/*` branch falls back to `base_branch`); an agent handoff refuses a landing target whose config has no `agent_walk:` block.
- The 6.0 verifier is vendored in `codex/scripts/verify/` (Claude's `fleet-hooks.mjs` excluded). Builds request its commit tier after each task's commit and wait only for its phase tier at each phase close (execution.md); landing goes through its merge queue: `lifecycle.mjs prepare` asks for a held merge tier beside the walk, `deliver` lands it with `release` (or `carry` after registry-only commits), and on a conflict the target is merged into the feature and the merge asked again. The gate system (`gate.mjs`, `gates-core.mjs`, `flaky:`, gate memos) is removed; an old `.builder/gates/` folder is ignored. It reads its `verify:` block from the same config `loadConfig` selects (`.codex/builder.md` → `.builder/config.md` → `.claude/builder.md`; a malformed first file is an error, never a fall-through). Service lifetime: `codex/tests/verify-codex.test.mjs` proves, for an ordinary macOS/Linux process tree, that the detached service a `request` starts outlives the client process — including a SIGKILL of the client's whole process group — that a later, separate `wait` reads its verdict, and that the idle service then exits by itself. It does not prove that a Codex sandbox or a session ending leaves a detached process running between tool calls; that has not been observed under Codex. If it does not, the next `wait` restarts the service and a request that was running goes back to the queue — and a second death while running it makes that request env-broken (the risk named in Decision 2 of the port plan, `docs/plans/2026-11-01-codex-6-port.md`, kept outside the package).
- Landed migrations: `lifecycle.mjs deliver` applies new additive migrations to the target checkout only under Walk readiness `apply_mode: agent`; otherwise it notes the exact command. A landing the owner's overlapping uncommitted changes block is a needs-you: Claude's fleet offers `--land --commit-mine | --set-aside`; Codex asks in the session (set mine aside, land, put back · commit mine, then land · leave it — the first recommended for 3 overlapping files or fewer, the second above that, as Claude recommends) through `lifecycle.mjs deliver --set-aside | --commit-mine`, and never touches those changes without an answer. Agent handoffs refuse a feature another session is building; Codex's per-feature `builder/<feature>` branches make Claude's shared-branch refusal unnecessary.

No ordinary `$builder` invocation grants push, PR or publication permission. `$sync` explicitly includes publication unless `--no-release` is selected. Numerical estimates need at least three comparable measured landings; unknown runtime tokens/cost remain unknown.

## Verify

```sh
node --test codex/tests/*.test.mjs
node codex/scripts/sync.mjs check
codex plugin list --json
```

Lifecycle assertions and routing preferences are not substitutes for actual tests, observed acceptance or human reports. Run the appropriate checks before recording verified state.
