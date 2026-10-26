---
name: ship
description: Condenses a feature's folder to its final SPEC at sign-off and marks it SHIPPED when the PR merges. Run by /builder:signoff; standalone for a merged PR or a folder that was never condensed.
---

# `/builder:ship` — the docs match the implementation, and shrink

The fix for spec folders outliving their usefulness: once a human has walked and accepted the feature,
its plan has done its job. **The SPEC is the record** — nothing new is written, `PLAN.md` goes and its
index is cut out of the SPEC, and git history **is** the full process.

Invocation: **`/builder:ship --path <folder>`**. Without `--path`,
`node <builder>/scripts/list-features.mjs --json` offers the eligible rows: manifests at
`state: signed-off` (sign-off moment) and rows whose `pr:` is open and `verify: READY` (ship moment).

**Two moments, one file** — REFERENCE §Condense says what each writes; the procedures below say how.
`node <builder>/scripts/docs.mjs ship` prints §Condense, §Continuing on "go" and the config in one call.

**The script does the mechanical part of both moments** — `node <builder>/scripts/condense.mjs`
writes exactly what the steps below describe, in one call and one commit. **What stays yours is the
judgment it cannot make:** that there was a PASS, the signer's name and verbatim words, that the PR is
open and which number it is (`gh pr view` — ask, never guess). After a crash, re-run the same command
— each step looks before it writes, and a finished call prints `already applied` / `already shipped`
(REFERENCE §The scripts).

## At sign-off

**Precondition: a PASS.** The manifest says `state: signed-off` with a `walk:` name and date — that
pair is the whole test, because **this step is what writes the header line**. (Agent mode's sign-off
runs this same condense from `/builder:agent-walk` §4, with its own 🤖 header line.) ⛔ **No PASS → stop and
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
   docs**: they were not written by this pipeline and the human may still want them. A
   **`PARKED.md`** goes in the same `git rm`: the feature got past its park, and `git log --
   <folder>/PARKED.md` keeps every version.

3. **Read the state back**: `node <builder>/scripts/list-features.mjs` shows the feature as
   `signed-off` with the manifest's `next:` — not DONE. Commit with the sign-off write as one commit,
   or standalone as `docs(<key>): condense <feature> at sign-off`.

Steps 1–2 and the commit are one call — from `/builder:signoff` with its manifest keys (signoff §What
gets written), standalone with the fields read as step 1 says:
`node <builder>/scripts/condense.mjs <folder> --signoff human --name "<name>" --words "<words>" --sha <sha> [--hold "<reason>"]`
(the default subject is the standalone one).

```
📍 <feature>: condensed at sign-off — §Plan index stripped · PLAN.md removed — next: /builder:verify --path <folder> · or say go
```

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.

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

**Agent form** (`walk: agent-pass …`, header `> 🤖 AGENT SIGNED OFF …`, run by resume §Ship in
agent mode with `--into <branch>`): there is **no PR** — the precondition is `verify: READY` and the
target branch already merged into this one; the fleet merges the result into `<branch>` once this
commit lands. Without `--agent-walk` and `--into`, refuse in one line: nobody has tested it, and the
human either hands it back to agents (`/builder:fleet <feature>`) or tests it and runs
`/builder:signoff --path <folder>`.

⛔ **Archive collision check, before step 1.** If `<registry>/_archive/<feature>` already exists — or,
when this ship will flip the program header (this is the program's last child),
`<registry>/_archive/<program>` — stop before touching anything and name the collision: a second
folder of that name would make "has it shipped?" answer for the wrong feature, and a stop after the
header flip would leave a half-shipped tree.

1. **Flip the header's first line** to, exactly:

   ```markdown
   > ✅ SHIPPED <date> — PR #N · <ticket> · signed off by <name>: "<words>"
   ```

   The sign-off's name and words carry over verbatim; the ticket comes from the manifest, read
   **before** step 2 removes it. A `🛑 PR HELD` line is dropped — the hold was lifted by the ship.
   **Agent form**, the line is instead:
   `> ✅ SHIPPED <date> — merged into <branch> · <ticket> · 🤖 agent signed off (walk round <n>), not human-tested`.

2. **`git rm MANIFEST.md`** — its `state:` has arrived, and the SPEC header now carries the state.

3. **Remove the workspace** — git-ignored scratch whose job is done:
   `<builder>/scripts/workspace --remove <feature>`, **in its own Bash call**. 🔴 Never
   `rm -rf "$(…)"`: the harness refuses an `rm -rf` on a substituted path, and when that refusal is
   inside a chained ship command nothing in the chain runs — five of five agent-mode ships lost a turn
   to exactly this.

4. **A program child** — find the parent by its own `child:` line
   (`grep -l 'child: <name>' <registry>/*/MANIFEST.md`), set that program's
   `child: <name> — shipped`, and when every child reads `shipped`, flip `PROGRAM.md`'s own header the
   same way.

5. **Archive the folder** — `git mv <registry>/<feature> <registry>/_archive/<feature>`, in this same
   commit, so it reaches the target exactly when `SHIPPED` does (the PR's merge, or the fleet's). A
   program whose header step 4 just flipped moves too: `git mv <registry>/<program>
   <registry>/_archive/<program>`. The collision was ruled out before step 1. Nothing routine reads the archive; `list-features.mjs --archived`
   lists it.

Commit: `docs(<key>): <feature> shipped in PR #N` — agent form: `docs(<key>): <feature> shipped into <branch>`.

**Before the ship call, one lesson for next time.** The config's §Standing traps is what this repo
has already paid to learn, and every step reads it — so a cost this feature paid goes there, or the
next feature pays it again. Read what it cost: `## Fixes` rows, `PARKED.md` when there is one, the
ledger's fix rounds (`<WS>/progress.md` — the ship call removes the workspace, so read it first) and
§Findings rows marked `build-time risk`. **A lesson qualifies only when all three hold:**

- it cost this feature a fix round, a red gate, a failed walk or a park;
- it is about the repo, not this feature — a test that needs a service started, a convention the code
  enforces, a command that must run first — so the next feature here would hit it too;
- neither §Standing traps nor §House rules already says it.

At most one, as one line a newcomer could act on. None qualifies → nothing, and say nothing.

- **A human ship** → show the line, then one AskUserQuestion: **Add it to §Standing traps
  (Recommended)** · **Skip**. Add → append `- <the line> (<feature>, <date>)` under the config's
  `## Standing traps` (replacing a `- none recorded yet` line) and commit it on its own,
  `chore(builder): standing trap from <feature>`, before the ship call — it rides the same PR.
- **Agent form** → never edit the config: the human hasn't seen it. Add a §Findings & risks row to
  the SPEC — `| L1 | lesson for §Standing traps: <the line> | proposed |` — before the ship call,
  which commits it with the folder. The fleet's report offers it to the human (fleet §5).

The collision check, steps 1–5 and the commit are one call, after you have confirmed the precondition:
`node <builder>/scripts/condense.mjs <folder> --ship --pr <N>` — agent form
`node <builder>/scripts/condense.mjs <folder> --ship --into <branch>`. It refuses unless `verify:
READY` (and, with `--into`, until `<branch>` is merged into this branch), removes the workspace itself
(no `rm -rf`), and an interrupted ship — header flipped, manifest gone, folder already moved — is
finished by running it again.

🔴 **Shipping does not update the ticket system.** The config's §Companion skills names the command
that reports a fix back with its evidence, and it is the human's to make. Name it in the hand-off when
the manifest carries a `ticket:`.

**What `pr:` means.** It is set by the orchestrator's ship step after a PR is opened **for that
feature**. A feature whose code rode someone else's PR records `pr: none` and a SPEC header note
naming the carrying PR; its ship moment is the same header flip citing that PR, taken while it is open.

```
📍 <feature>: shipped — header flipped, manifest and workspace removed, archived at <registry>/_archive/<feature>
```

## Standalone use on a folder from an earlier pipeline

Invoked on an old folder that is finished, write the header into whichever file carries its status, in
place, keeping that file's own form — because that marker is what `list-features.mjs` reads as DONE
for a legacy layout. Steps whose file is absent (no `MANIFEST.md`, no workspace) are skipped and
**named as skipped**, not treated as an error. Step 5 (archive the folder with `git mv` into
`<registry>/_archive/`) applies to it too, after its status header is written.

🔴 **Do not delete the old folder's docs.** The temptation is to collapse thousands of lines, and this
pipeline's first principle would endorse it — but a legacy folder's analysis was written by a
different pipeline and was never duplicated into a SPEC. Condensing it destroys the only copy. If the
human explicitly asks for that, name the file count and line count being removed in the hand-off, and
note they remain one `git log -- <folder>` away.
