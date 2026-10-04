# Builder for Codex

Claude Builder is developed first in this repository's root. The self-contained `codex/` package adapts those features to Codex and uses the same release version after migration is verified. It requires Node and Git, with no npm dependencies, GSD or Superpowers.

## Install a published release

```sh
codex plugin marketplace add lukekeith/builder --ref main
codex plugin add builder@builder-codex
```

Start a new Codex session, then use `$builder init` in a project and `$builder brainstorm <idea>` or `$builder <request>`. Existing `.claude/builder.md` works without migration. Configuration precedence is `.codex/builder.md`, `.builder/config.md`, then `.claude/builder.md`; the first existing file is authoritative.

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

This mirrors Claude's maintainer rollout: d2m, fai-cd (truesheet), makeready and fai-erp use one global Codex install; finpro gets a runtime-only vendored copy. No consumer commits are made. Preview/check by hand:

```sh
node codex/scripts/update-local.mjs --dry-run
node codex/scripts/update-local.mjs --check
node codex/scripts/update-local.mjs
# Roll out an explicitly selected local build:
node codex/scripts/update-local.mjs --source /absolute/path/to/builder
```

Customize `~/.codex/builder-local.json` or `--repos <json-file>`:

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
- Immutable landing targets, fresh exact merge-candidate verification, per-feature pause/revision and actual human-walk evidence protect delivery. Human-walk worktrees remain available until completion.
- Value-sized decomposition offers One spec and the fewest independently usable shipping outcomes. Missing plans yield no numerical estimate.
- Claude-specific status-line integration and repo-wide tidy are excluded. The Codex release supplies its own sync, update-local and vendor tooling.

No ordinary `$builder` invocation grants push, PR or publication permission. `$sync` explicitly includes publication unless `--no-release` is selected. Numerical estimates need at least three comparable measured landings; unknown runtime tokens/cost remain unknown.

## Verify

```sh
node --test codex/tests/*.test.mjs
node codex/scripts/sync.mjs check
codex plugin list --json
```

Lifecycle assertions and routing preferences are not substitutes for actual tests, observed acceptance or human reports. Run the appropriate checks before recording verified state.
