---
name: ship
description: Collapse a feature's spec folder (docs/features/<feature>/) to its write-once SPEC matching the implementation — at sign-off, and flip the header to SHIPPED when the PR merges. Run by /builder:signoff on PASS; standalone for a merged PR, a legacy shipped suite, or a signed-off feature that was never condensed.
---

# `/builder:ship` — the docs match the implementation, and shrink

The fix for spec folders outliving their usefulness: once a human has walked and accepted the feature,
its plan has done its job. **The SPEC is the record** — nothing new is written, `PLAN.md` goes and its
index is cut out of the SPEC, and git history **is** the full process. Docs are high-level and written
at boundaries; building outranks record-keeping, and this is the boundary where the record gets short.

Invocation: **`/builder:ship --path <folder>`**. Flags: [REFERENCE](../resume/REFERENCE.md) §Flags —
**ignore any flag this step does not use rather than erroring on it**. Without `--path`,
`node .claude/scripts/list-feature-specs.mjs --json` offers the eligible rows: manifests at
`state: signed-off` (sign-off moment) and rows whose `pr:` is open and `verify: READY` (ship moment).

**Two moments, one file** — the table in REFERENCE §Condense says what each writes; the procedures
below say how.

## At sign-off

**Precondition: a PASS.** The manifest says `state: signed-off` with a `walk:` name and date — that pair
is the whole test, because **this step is what writes the header line** (from `/builder:signoff`, or
from the manifest when run standalone on a sign-off that was never condensed). ⛔ **No PASS → stop and
say so.** Condensing an unwalked feature deletes the plan it still needs, and a PROBLEMS or PARTIAL walk
keeps **both** the §Plan index and `PLAN.md`, because `## Fixes` work still runs against the task blocks.

1. **`SPEC.md`** — delete from the `## Plan` heading through to the next `## ` heading, or to EOF when
   no `## ` heading follows it. 🔴 **The cut is keyed on that heading, never on position** — §Prototype,
   §Replaced surfaces and `## Fixes` can all sit after §Plan, and cutting to EOF from a §Plan that is
   not last takes them with it. Nothing else in the file moves: §Apps, §Contract, §Decisions,
   §Findings & risks, §Testing and `## Fixes` are what `/builder:verify` and every later reader work
   from. Then write the header line(s) as the first line(s) after the title, exactly:

   ```markdown
   > ✅ SIGNED OFF <date> — <sha> · by <name>: "<words>"
   > 🛑 PR HELD (<date>): "<reason>"
   ```

   The second line only when the manifest's `hold:` is set. `/builder:signoff` supplies all four fields;
   standalone, `<name>` and `<date>` are the manifest's `walk:` line, `<sha>` its `head`, `<reason>` its
   `hold:`, and `<words>` the sign-off commit's body.

   **A header line whose commit did not come from `/builder:signoff` is void** — a standalone run of
   this moment happens only on a folder whose manifest already says `state: signed-off`.

2. **`git rm <folder>/PLAN.md`** in the same commit. Every planned feature has one, and at the sign-off
   it has done its job. What later steps need is the ledger's pre-flight table and `git log`;
   `git show <sign-off sha>^:<folder>/PLAN.md` prints the plan back when one is wanted. A folder with a
   manifest but **no `PLAN.md`** — a converted pre-builder folder, whose plan is its
   `10+-phase-N-*.md` docs — skips the `git rm` and says so in one line. 🔴 **Never delete a converted
   folder's numbered docs**: they were not written by this pipeline and the human may still want them.

3. **Read the state back**: `node .claude/scripts/list-feature-specs.mjs` shows the feature as
   `signed-off` with the manifest's `next:` — not DONE. Commit with the sign-off write as one commit
   (`/builder:signoff` §What gets written), or standalone as
   `docs(<key>): condense <feature> at sign-off`.

```
📍 <feature>: condensed at sign-off — §Plan index stripped · PLAN.md removed — next: /builder:verify --path <folder>
```

The middle clause names what actually went. A converted folder names `§Plan index stripped` alone, and
says that its numbered phase docs stay.

## At ship

**Precondition: verify is READY and the branch's PR is open.** `gh pr view --json number,state` on the
current branch says `OPEN`; `<pr>` is that number — the manifest's `pr:` line when the orchestrator's
§Ship wrote it, or the header note's PR when the feature rode another PR. When none names one, **ask**
rather than searching `gh` for a plausible PR. **The ship is written ON the open PR, so the merge
carries it** — after the merge there is no branch to commit on (`main` changes only through a PR), and a
header flip would need a second PR of its own. ⛔ **Never write `SHIPPED` on a branch with no PR, or on
a PR whose verify is not READY** — that line is what every skill in the family and
`list-feature-specs.mjs` treat as DONE, and a feature marked DONE runs no step again. If the PR is later
closed unmerged, revert the ship commit — the header must not say SHIPPED for code that never landed.

1. **Flip the header's first line** to, exactly:

   ```markdown
   > ✅ SHIPPED <date> — PR #N · <ticket> · signed off by <name>: "<words>"
   ```

   The sign-off's name and words carry over verbatim; the ticket comes from the manifest, read
   **before** step 2 removes it. A `🛑 PR HELD` line is dropped — the hold was lifted by the ship.

2. **`git rm MANIFEST.md`** — its `state:` has arrived, and the SPEC header now carries the state.

3. **Remove the workspace** — git-ignored scratch whose walk script, briefs, reports and ledger have
   done their job:

   ```
   rm -rf "$(.claude/scripts/build-spec-workspace.sh <feature>)"
   ```

   Re-resolve that path inline in the command that uses it; a shell variable does not survive between
   Bash calls.

4. **A program child** — a child's manifest carries no parent key, so find the parent by its own
   `child:` line:

   ```
   grep -l 'child: <name>' docs/features/*/MANIFEST.md
   ```

   Set that program's `child: <name> — shipped` line; when every child reads `shipped`, flip
   `PROGRAM.md`'s own header the same way.

Commit: `docs(<key>): <feature> shipped in PR #N`.

🔴 **Shipping does not update the monday ticket.** `/monday-resolve` is the explicit call that reports a
fix back with its evidence, and it is the human's to make. Name it in the hand-off when the manifest
carries a `ticket:`.

**What `pr:` means.** The manifest's `pr:` is set by the orchestrator's ship step after a PR is opened
**for that feature**. A feature whose code rode someone else's PR records `pr: none` and a SPEC header
note naming the carrying PR; its ship moment is the same header flip citing that PR, taken on that PR
while it is open.

```
📍 <feature>: shipped — header flipped, manifest and workspace removed
```

## Standalone use on a pre-builder shipped suite

Invoked on an old numbered suite that is finished (its README `**Status:**` line opens `SHIPPED`), write
the header into that README in place and keep its bold form —
`**Status:** ✅ **SHIPPED YYYY-MM-DD** — PR #N · <ticket> · signed off by <name>: "<words>"` — because
that is the marker `list-feature-specs.mjs` reads as DONE for a suite layout. Steps whose file is absent
(no `MANIFEST.md`, no workspace) are skipped and **named as skipped**, not treated as an error.

🔴 **Do not delete the suite.** The temptation is to collapse thousands of lines, and this pipeline's
first principle would endorse it — but a numbered suite's analysis was written by a different pipeline
and its content was never duplicated into a SPEC. Condensing it destroys the only copy. If the human
explicitly asks for that, name the file count and the line count being removed in the hand-off, and note
they remain one `git log -- docs/features/<feature>` away.
