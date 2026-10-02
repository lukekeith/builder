# Fleet + registry archive — design

**Date:** 2026-09-29 · **Target release:** 3.8.0 (minor — new registry layout, automatic migration of fleet state, one-time sweep for the registry) · **Status:** design approved in chat, awaiting spec review

## Goal

Fleet mode will take hundreds, then thousands, of specs through the pipeline. Today every finished
feature stays visible and keeps costing work forever:

- `.builder/fleet/fleet.json` never drops a row — a `done` row stays, and `--status` renders it,
  across every later run. The whole file is re-serialized (plus `STATUS.md`) on every save.
- A shipped feature's condensed folder stays in `docs/features/`. `list-features.mjs` (behind
  `/builder:status`, `/builder:resume`, `/builder:agent`), `program.waitsOn`, `check-obligations.mjs`
  and `fleet --all` each `readdirSync` the whole registry and read files in every folder.
- `.builder/fleet/logs/` grows by several transcripts per feature, unbounded.

After this change, a finished feature is **archived automatically at the moment it is done**, on
both layers, and every routine read costs O(work in flight), not O(history).

## Constraints and non-goals

- **Nothing committed is deleted.** An archived spec stays in the repo, readable and greppable.
- **No shared append-only file in git.** Parallel fleet lanes merge into one target; a shared index
  would conflict on almost every landing. "Is X archived?" is a path existence check.
- **Archiving rides an existing commit.** No extra commit, no second PR.
- **Dependency resolution stays correct** after the dependency is archived, on both layers.
- **Dependency-free.** Node's standard library and `git` only, as today.
- **Not in scope:** hiding parked/failed fleet rows (they need attention; a `--forget <feature>` can
  follow if they pile up), pruning `archive.jsonl`, sharding `_archive/`.

## Decisions (from the design conversation)

| # | Decision | Ruling |
|---|---|---|
| 1 | Scope | **Both layers** — the fleet's run state and the spec registry. |
| 2 | Trigger | **Automatically on done** — at ship (both paths) for the registry, at landing for fleet state. No manual housekeeping. |
| 3 | Registry location | **`<registry>/_archive/<feature>/`**, flat, in the repo. Moved by `git mv` inside the ship commit. |
| 4 | Fleet state | **Evict done rows** to a local append-only `.builder/fleet/archive.jsonl`; `fleet.json` holds only work in flight. (Rejected: per-run rotation — breaks a long-lived inbox-fed fleet; hide-in-render — the file still grows.) |

## Layer 1 — the registry archive

### When it moves

`/builder:ship` gains **step 5**, after `git rm MANIFEST.md` (step 2), the workspace removal
(step 3) and the program-child update (step 4):

```
git mv <registry>/<feature> <registry>/_archive/<feature>
```

It is part of the existing `docs(<key>): <feature> shipped …` commit, so it reaches the target
exactly when `SHIPPED` does:

- **Human path** — ship is written on the open PR; the PR's merge carries the move.
- **Agent path** — ship is written on the feature branch; `landNow`'s `--no-ff` merge carries it.

A merge that never happens never moves anything on the target — the same guarantee `SHIPPED` has.

**Programs.** When step 4 flips `PROGRAM.md` to `✅ SHIPPED` (every child `— shipped`), the program
folder is moved to `_archive/<program>/` in the same commit. Its children are already there.

If `_archive/<feature>` already exists, ship stops before committing and names the collision.

### `scripts/registry.mjs` (new) — the one place registry layout lives

| Export | Behaviour |
|---|---|
| `ARCHIVE = '_archive'` | The folder name. |
| `features(root, registry)` | In-flight folder names: `readdirSync` of the registry, skipping names starting with `_` or `.`. `[]` when the registry is missing. |
| `isArchived(root, registry, name)` | `existsSync(<registry>/_archive/<name>)`. O(1). |
| `specDir(root, registry, name)` | The live folder if it exists, else the archived one, else the live path (so callers' "missing" handling is unchanged). |
| CLI `--sweep` | One-time migration: `git mv` every in-flight folder whose SPEC or PROGRAM header is `✅ SHIPPED` (or whose manifest says `state: shipped`) into `_archive/`, leaving the result staged for the human to commit. Refuses if `git status --porcelain -- <registry>` is non-empty. Prints what moved. |

Callers switch to it:

- `list-features.mjs` — enumerates with `features()`. New `--archived [--limit N]` (default 50)
  lists `_archive/` newest first by the `SHIPPED` date in each header; the only code that reads
  inside `_archive/`. `--status` gains a footer `N shipped features archived · list-features --archived`,
  counted by one `readdirSync` of `_archive/` (names only, no reads).
- `program.mjs` — `waitsOn`'s outer loop walks `features()` only. A dependency is met when
  `isArchived` is true, checked before the existing header/manifest checks. A dependency neither
  live nor archived stays unmet (`no such child or feature`).
- `check-obligations.mjs` — enumerates with `features()`.
- `fleet.mjs` — `--all` enumerates with `features()`; `readSpec`/`readManifest` resolve through
  `specDir` where a shipped spec must be read (`landNow`'s PR lookup, `preflight`'s "already shipped").

### Name reuse

`/builder:brainstorm` refuses a new feature name that exists under `_archive/` and suggests `<name>-v2`.
Revising shipped work is a new feature whose SPEC links the archived one — archived specs are
write-once. (A reused name would make `isArchived` answer for the wrong feature.)

### Resuming an archived feature

`/builder:resume --path <registry>/<name>` where only `_archive/<name>` exists answers in one line:
`<name> shipped <date> — archived at <registry>/_archive/<name>; nothing to resume`. A legacy folder
whose status is SHIPPED converts straight into `_archive/`.

## Layer 2 — the fleet state archive

### Eviction at landing

`landNow`, after a successful merge, replaces `Object.assign(f, { status: 'done', … })` with, in order:

1. `appendArchive(root, row)` — one JSON line to `.builder/fleet/archive.jsonl`:
   `{ feature, branch, target, merged, pr, runs, runsThisTime, landedAt }` (`landedAt` ISO-8601). Gitignored with
   the rest of `.builder/`. Single writer (the fleet process; `land()` already serializes landings).
   **Idempotent:** skips the append when one of the file's last 50 lines has the same `feature` and
   `merged`.
2. `delete fleet.features[feature]`; `fleet.archived = (fleet.archived ?? 0) + 1`.
3. Move `logs/<feature>-*` into `logs/_archive/<feature>/`. A failure is a note, never a park.
4. `save()`.

The worktree cleanup is unchanged; a kept (dirty) worktree still gets its note, and its row is still
evicted.

### What depended on `done` rows

- **Dependency waits** — `pendingDeps` and the preflight wait: a dependency is met when it is not in
  `fleet.features` **and** `landedOn(dep)` — an in-memory `Set` of features landed by this process,
  else `git cat-file -e <TARGET>:<registry>/_archive/<dep>`. The git check is correct even when
  `mergeIntoTarget` wrote the target ref without touching the working tree. A failing check (ref gone)
  means unmet: the child waits, then parks with the existing `waits on …` reason.
- **Target guard** (`fleet.target !== HERE`): now "any rows left" — an empty `fleet.json` lets the
  next run take the checked-out branch.
- **Resume loop and exit code:** the `done` special cases go; exit 0 when no rows remain.

### `--status`

- The table and the summary counts cover active rows only; the overall progress bar averages them.
- When `fleet.archived > 0`, one line under the header:
  `412 archived (last: auth-refresh, 2h ago) · --status --archived for the latest 20`
  (the "last" comes from `tailArchive(…, 1)`).
- `--status --archived [N]` (default 20) prints the last N lines of `archive.jsonl` as a table —
  Feature, Merged, PR, Landed. `tailArchive` reads backwards from the end in fixed-size chunks; it
  never reads the whole file.

### Log retention

At fleet start, `logs/_archive/<feature>/` folders whose mtime is older than `agent_walk.keep_logs`
days are removed (default **30**; `0` keeps them forever). A failure is silent; the next start retries.
`archive.jsonl` is never pruned (~200 bytes a line — 10,000 features ≈ 2 MB).

### Migration

On load, every existing row with `status: 'done'` is evicted through the same path (append —
deduplicated — delete, move logs). An existing `fleet.json` cleans itself up the first time it is
loaded. The same path also repairs a process killed between the append and the save.

## Skills and docs

| File | Change |
|---|---|
| `skills/ship/SKILL.md` | Step 5 (`git mv` into `_archive/`); step 4 moves a fully shipped program; collision stop; footer names the archived path. |
| `skills/brainstorm/SKILL.md` | Name-reuse refusal with the `-v2` suggestion. |
| `skills/resume/SKILL.md`, `REFERENCE.md` | Archived-path answer; `_archive/` in the registry layout; legacy SHIPPED conversion lands in `_archive/`. |
| `skills/status/SKILL.md` | The archived-count footer. |
| `skills/fleet/SKILL.md` | §`--status`: the archived line and `--archived`; the **done** paragraph says done rows move to the archive. |
| `skills/agent/SKILL.md` | One line: archived features are never offered. |
| `skills/help/SKILL.md` | "Where did a shipped spec go?" row. |
| `skills/update/SKILL.md` | Names `registry.mjs --sweep` when a `✅ SHIPPED` folder sits outside `_archive/`. |
| `PROJECT.template.md`, `scripts/config.mjs` | `agent_walk.keep_logs` (default 30). |
| `CHANGELOG.md`, `.claude-plugin/plugin.json` | 3.8.0. |

## Failure handling (summary)

| Failure | Behaviour |
|---|---|
| `_archive/<name>` exists at ship | Ship stops before committing, names the collision. |
| Killed between append and save | Row survives as `done`; load-time migration evicts it; the append deduplicates. |
| Log move fails | Note; row still evicted. |
| Retention prune fails | Silent; retried next start. |
| `git cat-file` on the target fails | Dependency unmet → wait → park with `waits on …`. |
| `--sweep` with registry changes uncommitted | Refuses, names them. |

## Tests

`node --test 'scripts/test/*.test.mjs'`:

- **`registry.test.mjs`** (new) — `features` skips `_archive` and dot-folders; `isArchived` /
  `specDir` resolution order; `--sweep` moves only shipped folders and fully shipped programs, and
  refuses on a dirty registry.
- **`program.test.mjs`** — a dependency present only in `_archive/` is met; an absent one is unmet.
- **`list-features.test.mjs`** — archived features absent from the default table and `--json`;
  `--archived --limit` ordering by SHIPPED date; the archived-count footer.
- **`fleet-core.test.mjs`** — `renderStatus` renders active rows plus the archived line;
  `appendArchive` deduplicates; `tailArchive` returns the last N lines of a file larger than one chunk.
- **`fleet.test.mjs`** — load-time migration evicts `done` rows; a landing evicts, appends and moves
  logs; a waiting child is released by an evicted dependency; exit 0 with no rows.
- **Scale** — a generated 2,000-folder `_archive/` in a temp dir: `list-features --json` and
  `waitsOn` read no file under `_archive/`, asserted by spying on `readFileSync` (not by timing).
