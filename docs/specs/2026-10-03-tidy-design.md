# Nothing left behind — design

> 2026-10-03 · builder 4.8.0 · status: approved in conversation (build and release end to end)

## Why

Builder's promise is that work started with `/builder:brainstorm` or `/builder:intake` ends merged
into the branch you want, with nothing left lying around and no doubt about what is done. d2m on
2026-10-03 shows the promise broken:

| Left behind | What it was |
|---|---|
| `builder/owner-corrections` + worktree `d2m.fleet/owner-corrections` | a fleet feature that parked, never finished or cleared (34 commits not in `main`) |
| `feat/owner-corrections` + worktree `~/www/d2m-owner-corrections` | an earlier attempt at the same feature (1 commit) |
| `feat/component-pane-tabs` + worktree `d2m.fleet/cpt-merge` | a feature mid-merge (22 commits) |
| worktrees `d2m.fleet/_base`, a session scratchpad's `mainwt` | detached scratch nobody removed |
| `feat/contract-bar-icons`, `feat/run-stop-resolution`, `feat/screen-build`, `feat/screen-previews`, `feat/stop-weighs-intent` | fully merged into `main`, never deleted |

Three causes:

1. **The fleet lands on whatever branch was checked out** when it was launched. d2m's fleets ran
   from `feat/stop-weighs-intent`, so every feature landed there and needed a second, manual merge
   into `main`.
2. **The fleet only cleans up a perfectly clean worktree.** A merged feature whose worktree held a
   rewritten test artefact (`test-results/.last-run.json`) was kept "because it has changes"; a
   branch not named `builder/…` was never deleted; a parked feature's worktree stays forever.
3. **Nothing shows the whole picture.** `/builder:status` lists features, not branches and
   worktrees, so leftovers are invisible until someone audits git by hand.

**Success:** after any fleet run, the only branches and worktrees left are ones a feature still
needs, each listed with why and the next step; and one command takes a messy repo to that state,
asking only where a decision is genuinely the owner's.

## Decisions (from the conversation)

- **D1 — Where work lands.** A config key names the branch finished features merge into; agents
  merge there whatever is checked out. Overridable per run.
- **D2 — Unfinished work.** A parked or failed feature keeps its branch only; its worktree is
  removed when the fleet exits and recreated from the branch when it is picked again.
- **D3 — Cleanup autonomy.** One confirmation for everything safe; a question per item for anything
  unverified, not builder's, or parked.

## Design

### 1. `merge_into` — where work lands (D1)

- New optional frontmatter key in `.claude/builder.md`: `merge_into: <branch>`. Default:
  `base_branch` (itself defaulting to `main`). `loadConfig` exposes it as `mergeInto`.
- `fleet.mjs` target = `--into <branch>` if given, else `cfg.mergeInto`. It no longer reads the
  current checkout for the target, and a detached HEAD is no longer fatal.
- A fleet whose saved `fleet.target` differs from the new target while rows are unfinished refuses,
  as today, naming both and the `--into` that continues the old one.
- The existing merge paths stay: the target checked out here → `git merge --no-ff` (needs a clean
  tree); checked out nowhere → the merge commit is written onto the target ref; checked out in
  another worktree → park with that reason.
- The target branch must exist; a missing one refuses with the fix (`git branch <target>` or set
  `merge_into`).
- `/builder:init` asks for `merge_into` only when the repo has a `develop`-style branch besides
  `base_branch`; otherwise it leaves it unset (= base).

### 2. The fleet leaves nothing behind (D2)

A shared helper `clearWorktree(root, wt, label)` in `tidy-core.mjs`:

1. Lists the worktree's dirty tracked paths (`dirtyPaths`).
2. Paths that are all **test output** — `test-results/`, `playwright-report/`, `coverage/`,
   `.nyc_output/`, `junit*.xml`, `.builder/` — are restored (`git checkout -- <paths>`).
3. Anything else is stashed: `git -C <wt> stash push -m "builder: <label> leftovers <YYYY-MM-DD>"`,
   and the stash is named in the result.
4. `git worktree remove --force <wt>`, then `git worktree prune`.

It returns `{ removed: boolean, stash: string|null }`.

- **On landing** (`landNow`): `clearWorktree`, then delete the feature's branch with `git branch -d`
  whatever its name — safe, because `-d` refuses an unmerged branch — unless it is the target or
  `base_branch`. The "kept (it has changes)" note goes; a stash gets a note naming it.
- **At fleet exit**: every row `parked` or `failed` with a worktree → `clearWorktree`,
  `f.worktree = null`, branch kept. `ensureWorktree` already recreates a worktree from an existing
  branch when the feature is picked again.
- **At fleet exit**: the repo summary line (§3) is added to STATUS.md's notes.

### 3. The inventory — one picture (read-only)

`scripts/inventory.mjs [--into <branch>] [--json | --summary]`, logic in `tidy-core.mjs`
(`inventory(root, cfg, target)`), returns items:

```
{ kind: 'branch'|'worktree', name, path?, group, feature?, ahead, touched, why?, next? }
```

Groups, decided in this order:

| Group | Rule | Proposed action |
|---|---|---|
| `target` | the target or `base_branch` | none (not listed) |
| `current` | checked out in the main checkout | none |
| `running` | a live fleet holds it (lock alive, row unfinished), or its in-chat ledger moved in 5 min | none |
| `merged` | branch fully in the target | delete branch (and its worktree) |
| `ready` | a feature branch whose manifest on that branch is `state: verified` (or `signed-off` with `verify: READY…`) | merge (hand to the fleet) |
| `parked` | a feature branch whose manifest has `blocked:` set, or its fleet row is parked/failed | keep branch, remove worktree; show why and next |
| `in-progress` | a feature branch, manifest unfinished, nothing running | finish with agents |
| `unknown` | anything else with commits not in the target | ask |
| `dead` (worktree) | detached HEAD, path missing, path under a temp/scratchpad dir, or its branch is `merged` | remove |

A branch is a **feature branch** when a manifest on it names it: `builder/<f>` with
`<registry>/<f>/MANIFEST.md` present on that branch, or any manifest on that branch whose `branch:`
line equals the branch name (`git grep` against the branch's tree).

`--summary` prints one line: `repo: 3 merged branches to delete · 2 dead worktrees · 1 ready to
merge · 1 parked · 1 unknown → /builder:tidy` or `repo: clean`.

### 4. `/builder:tidy [--into <branch>]` (D3)

A new skill driving `scripts/tidy.mjs`:

- `tidy.mjs plan [--into b] --json` — the inventory with each item's proposed action.
- `tidy.mjs apply <action> <name>… [--into b]` — actions `delete-branch` (`-d`, refuses unmerged),
  `force-delete-branch` (`-D`, only after the owner chose delete), `remove-worktree`
  (`clearWorktree`), `merge` (§below). Prints one line per item: done, or why not.

The skill:

1. Prints the inventory as a table grouped as above, each row with location, commits ahead, last
   touched and the proposed action.
2. **One** AskUserQuestion for the safe batch — `merged` branches, `dead` worktrees, the worktrees of
   `parked` features, and merging `ready` features: **Do all of it** / **Not now**.
3. One AskUserQuestion per `unknown`, `in-progress` and `parked` branch (up to four per question
   via tabs): **Finish with agents** (`/builder:agent --path`) · **Merge as is** · **Keep** ·
   **Delete** (deleting unmerged commits says how many are lost).
4. Applies, then prints the inventory again; ends `📍 repo: clean` or the summary line.

**Merging** (`merge` action): a branch that already carries the target merges directly with the
fleet's rule (§1). One that doesn't is handed to the fleet — `fleet.mjs --detach <features> --into
<target>` — which syncs, resolves conflicts and merges, then removes it (§2). A non-feature branch
that doesn't carry the target is tried with `git merge --no-ff` in the target checkout when that is
checked out and clean; a conflict aborts and is reported.

It never pushes, never touches remote branches, never discards uncommitted work (it stashes, by
name), and never deletes an unmerged branch without that item's own answer.

### 5. Where the picture shows

- `/builder:status` runs `inventory.mjs --summary` and prints the line under its table.
- The fleet's STATUS.md ends with it (§2).
- `/builder:help` lists `/builder:tidy`.

### 6. Text that changes

Everywhere the skills say features merge into "the branch it was run from" / "the branch you're on":
`agent`, `fleet`, `resume`, `help`, README → "the `merge_into` branch (default `base_branch`), or
`--into`".

## Testing

- `tidy-core`: `clearWorktree` restores test output, stashes real changes by name, removes the
  worktree; `inventory` puts one fixture branch/worktree in each group; feature-branch detection by
  `builder/<f>` and by a manifest's `branch:` line.
- `fleet.test`: the target comes from `merge_into` / `--into`, not the checkout; a detached HEAD
  works; a landed feature leaves no worktree and no branch even with `test-results/` dirty and a
  non-`builder/` branch name; a parked feature at exit keeps its branch and loses its worktree, and
  picking it again recreates it.
- `tidy.test`: `plan --json` on a fixture; `apply delete-branch` refuses an unmerged branch;
  `apply remove-worktree` stashes real changes.
- Skills consistency: `tidy` skill exists and drives `tidy.mjs`; help names it; no skill text still
  says features land on the branch you're on.

## Out of scope

- Remote branches and pushing.
- Cleaning stashes.
- Deciding for the owner what an `unknown` branch is.

## Release

**4.8.0** (minor): a new skill and config key. A consumer need do nothing; the one visible change is
that fleets merge into `merge_into` (default `base_branch`) rather than the checked-out branch.
