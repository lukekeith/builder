# Land agent work on the branch you're on — design

**Date:** 2026-10-26 · **Release:** 5.1.0 (minor: a new optional config value)

## Why

In fai-erp, Luke specced `release-notes` on `feature/proposal-editor-wysiwyg` and handed it to agents.
Land on? recommended `main` (the config has no `merge_into`, so `base_branch`), it was taken, and the
fleet parked the feature 41 seconds in: the worktree is cut from `main`, and `main`'s
`.claude/builder.md` predated the `agent_walk:` block that lived only on the feature branch. Luke:
*"why would you merge into main? I am in a feature branch, I want it merged back into this branch."*

Two faults: the recommendation ignored the branch the human is working on, and the fleet found out
the target couldn't run agents only after launching.

## Rulings (Luke, 2026-10-26)

1. **`merge_into: current`** — an opt-in value. The target is the branch checked out in the **main
   worktree** (`git worktree list --porcelain`, first entry) — never `git branch --show-current`,
   which inside a fleet worktree answers `builder/<feature>`. Detached HEAD or no git → `base_branch`.
   Resolved lazily (a getter on the loaded config), because the statusline loads the config on every
   render and never asks for the target. The fleet resolves it at launch and keeps it in
   `fleet.json`, so switching branches mid-run changes nothing for that run.
2. **Land on? recommends the checked-out branch** when it is not `base_branch` and not `builder/*`;
   otherwise `merge_into`. `merge_into` and `base_branch` follow as alternatives where they differ.
   Plan's go-ahead A line names the same target.
3. **The dry run refuses a target without an `agent_walk:` block** (`git show <target>:.claude/builder.md`,
   parsed with the config loader's own rules): exit 2, naming the fix — commit the config to the
   target, or `--into <the branch checked out here>`.

Kept: the default stays `base_branch`. The rule "never whatever happens to be checked out" was there
because work got stranded on feature branches when the fleet merged into an implicit checkout;
`current` is explicit (opted into in config) and Land on? is a human's choice, so neither brings that
back.

## Not changed

- `tidy`, `inventory` and `list-features` read `cfg.mergeInto` as before; under `current` they follow
  the checkout, which is what the opt-in means.
- `fleet-core`'s shared-branch check excludes `cfg.mergeInto`: under `current`, features specced on
  the branch they will land on are not "shared" — correct.
- The Codex port follows through `$sync`.

## Tests

`config.test.mjs`: unset / named / `current` (incl. read from a linked worktree) / detached HEAD,
and `hasAgentWalk`. `fleet.test.mjs`: `merge_into: current` lands on the launch-time branch; a target
without `agent_walk:` refuses with the `--into` fix and `--into <branch>` passes.
`skills-consistency.test.mjs`: the Land on? recommendation rule.
