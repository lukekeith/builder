---
name: ship
description: Collapse a feature's folder to its write-once SPEC matching the implementation — at sign-off, and flip the header to SHIPPED when the PR merges. Run by /builder:signoff on PASS; standalone for a merged PR, a legacy shipped folder, or a signed-off feature that was never condensed.
---

# `/builder:ship` — the docs match the implementation, and shrink

The fix for spec folders outliving their usefulness: once a human has walked and accepted the feature,
its plan has done its job. **The SPEC is the record** — nothing new is written, `PLAN.md` goes and its
index is cut out of the SPEC, and git history **is** the full process.

Invocation: **`/builder:ship --path <folder>`**. Without `--path`,
`node <builder>/scripts/list-features.mjs --json` offers the eligible rows: manifests at
`state: signed-off` (sign-off moment) and rows whose `pr:` is open and `verify: READY` (ship moment).

**Two moments, one file** — REFERENCE §Condense says what each writes; the procedures below say how.

## At sign-off

**Precondition: a PASS.** The manifest says `state: signed-off` with a `walk:` name and date — that
pair is the whole test, because **this step is what writes the header line**. ⛔ **No PASS → stop and
say so.** Condensing an unwalked feature deletes the plan it still needs, and a PROBLEMS or PARTIAL
walk keeps **both** the §Plan index and `PLAN.md`.

1. **`SPEC.md`** — delete from the `## Plan` heading to the next `## ` heading, or to EOF when none
   follows. 🔴 **The cut is keyed on that heading, never on position** — §Prototype, §Replaced
   surfaces and `## Fixes` can all sit after §Plan, and cutting to EOF from a §Plan that is not last
   takes them with it. Nothing else moves: §Apps, §Contract, §Decisions, §Findings, §Testing and
   `## Fixes` are what verify and every later reader work from. Then write the header line(s) as the
   first line(s) after the title, exactly:

   ```markdown
   > ✅ SIGNED OFF <date> — <sha> · by <name>: "<words>"
   > 🛑 PR HELD (<date>): "<reason>"
   ```

   The second line only when `hold:` is set. `/builder:signoff` supplies all four fields; standalone,
   `<name>`/`<date>` come from `walk:`, `<sha>` from `head`, `<reason>` from `hold:`, `<words>` from
   the sign-off commit's body.

   **A header line whose commit did not come from `/builder:signoff` is void** — a standalone run of
   this moment happens only on a folder whose manifest already says `state: signed-off`.

2. **`git rm <folder>/PLAN.md`** in the same commit. What later steps need is the ledger's pre-flight
   table and `git log`; `git show <sign-off sha>^:<folder>/PLAN.md` prints it back when wanted. A
   folder with a manifest but **no `PLAN.md`** — a converted folder whose plan is its existing phase
   docs — skips the `git rm` and says so in one line. 🔴 **Never delete a converted folder's existing
   docs**: they were not written by this pipeline and the human may still want them.

3. **Read the state back**: `node <builder>/scripts/list-features.mjs` shows the feature as
   `signed-off` with the manifest's `next:` — not DONE. Commit with the sign-off write as one commit,
   or standalone as `docs(<key>): condense <feature> at sign-off`.

```
📍 <feature>: condensed at sign-off — §Plan index stripped · PLAN.md removed — next: /builder:verify --path <folder>
```

The middle clause names what actually went. A converted folder names `§Plan index stripped` alone, and
says its existing phase docs stay.

## At ship

**Precondition: verify is READY and the branch's PR is open.** `gh pr view --json number,state` says
`OPEN`; `<pr>` is that number — the manifest's `pr:` line, or the header note's PR when the feature
rode another PR. When none names one, **ask** rather than searching for a plausible PR. **The ship is
written ON the open PR, so the merge carries it** — after the merge there is no branch to commit on,
and a header flip would need a second PR of its own. ⛔ **Never write `SHIPPED` on a branch with no
PR, or on a PR whose verify is not READY** — that line is what every skill and `list-features.mjs`
treat as DONE, and a feature marked DONE runs no step again. If the PR is later closed unmerged,
revert the ship commit.

1. **Flip the header's first line** to, exactly:

   ```markdown
   > ✅ SHIPPED <date> — PR #N · <ticket> · signed off by <name>: "<words>"
   ```

   The sign-off's name and words carry over verbatim; the ticket comes from the manifest, read
   **before** step 2 removes it. A `🛑 PR HELD` line is dropped — the hold was lifted by the ship.

2. **`git rm MANIFEST.md`** — its `state:` has arrived, and the SPEC header now carries the state.

3. **Remove the workspace** — git-ignored scratch whose job is done:
   `rm -rf "$(<builder>/scripts/workspace <feature>)"`. Re-resolve that path inline.

4. **A program child** — find the parent by its own `child:` line
   (`grep -l 'child: <name>' <registry>/*/MANIFEST.md`), set that program's
   `child: <name> — shipped`, and when every child reads `shipped`, flip `PROGRAM.md`'s own header the
   same way.

Commit: `docs(<key>): <feature> shipped in PR #N`.

🔴 **Shipping does not update the ticket system.** The config's §Companion skills names the command
that reports a fix back with its evidence, and it is the human's to make. Name it in the hand-off when
the manifest carries a `ticket:`.

**What `pr:` means.** It is set by the orchestrator's ship step after a PR is opened **for that
feature**. A feature whose code rode someone else's PR records `pr: none` and a SPEC header note
naming the carrying PR; its ship moment is the same header flip citing that PR, taken while it is open.

```
📍 <feature>: shipped — header flipped, manifest and workspace removed
```

## Standalone use on a folder from an earlier pipeline

Invoked on an old folder that is finished, write the header into whichever file carries its status, in
place, keeping that file's own form — because that marker is what `list-features.mjs` reads as DONE
for a legacy layout. Steps whose file is absent (no `MANIFEST.md`, no workspace) are skipped and
**named as skipped**, not treated as an error.

🔴 **Do not delete the old folder's docs.** The temptation is to collapse thousands of lines, and this
pipeline's first principle would endorse it — but a legacy folder's analysis was written by a
different pipeline and was never duplicated into a SPEC. Condensing it destroys the only copy. If the
human explicitly asks for that, name the file count and line count being removed in the hand-off, and
note they remain one `git log -- <folder>` away.
