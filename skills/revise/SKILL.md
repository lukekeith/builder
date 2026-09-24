---
name: revise
description: Apply ONE change to a feature that is already audited, planned or part-built — a new requirement, a reversed ruling, a conflict found mid-build. Post-build the default is a code fix plus at most one line of docs; the SPEC write-back is reserved for contract changes that un-built work depends on. It is also the ONLY way a FROZEN cross-app contract re-opens, and it names which consumers must be re-checked. Records human rulings as implementable statements in SPEC §Decisions and never re-audits. Use when a spec needs to change after /builder:brainstorm has run — revising, correcting, extending or reversing part of a feature spec.
---

# `/builder:revise` — the cheapest honest write-back

Invocation: **`/builder:revise --path <folder> [--ticket <monday id>] <the change>`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, the free text after them **is the change**,
and **ignore any flag this step does not use rather than erroring on it**.

**Where the feature stands is the manifest** — `<folder>/MANIFEST.md`'s `state:`, `go-ahead:` and
`contract:` lines, plus, once it is signed off, the `✅ SIGNED OFF` line in the SPEC header. Read those
before routing; the route is keyed on them, never on memory of the session.
⛔ A SPEC header carrying `SHIPPED` is DONE — run no step; follow-on work is a new feature folder. A
pre-builder layout with no `MANIFEST.md` is not revised here: say so in one line, name
`/builder:resume --path <folder>` as the conversion, and stop.

**Without `--path`,** run `node .claude/scripts/list-feature-specs.mjs --json` and present **one
AskUserQuestion** over the in-flight features — one option each, its state and next step as the
description. Never ask "which feature?" as an open question.

## Step 1 — Is the change settled, and is it true?

- A settled ruling ("always store the full number") → proceed. **Do not re-litigate it** — a pause whose
  only answer is "continue" is noise.
- A question / conflict / more than one defensible answer → run `/builder:brainstorm`'s conversation
  first, come back with the ruling.
- The user is reporting a **problem, not a solution** → investigate in code before proposing anything;
  report what you found, then ask.
- **Verify the premise in code before propagating it.** If the change asserts something about the
  codebase that turns out false, say so and stop — a revision built on a wrong premise costs more than
  the original spec. 🔴 **In this monorepo, check the premise in every app it names**: "the endpoint
  already returns that" is a claim about the server *and* about what each consumer reads.

## Step 2 — Route it (the whole skill is this table)

| The manifest says | The complete write-back |
|---|---|
| **before the go-ahead** — `state:` `spec` · `aligned` · `audited` · `planned` with `go-ahead: none` | Nothing is built yet, so edit the docs directly. A ruling → a §Decisions row written as an implementable statement. If `<folder>/PLAN.md` exists and the change alters what gets built, amend the affected task block there — and SPEC §Plan's one-line index gains or loses a line only when a task is added or dropped; if `PLAN.md`'s `## Phases` table changed shape, re-present it and re-take the go-ahead. If the audit already ran and a **contract** changed, re-check that one contract against the code — never a fresh pass |
| **after the go-ahead** (`planned` with a go-ahead · `building` · `built`) — **a bug** (code wrong, spec right or silent) | the fix + its test, **in the one app that has the bug**. **No doc edit.** Never "spec" a bug fix — writing a section describing behaviour that was always intended adds a page every later step must read |
| **after the go-ahead — a human ruling** | one SPEC §Decisions row (an implementable statement) + the fix, or the `PLAN.md` task block that carries it |
| **after the go-ahead — something a future phase must know** | one SPEC §Findings & risks row |
| **after the go-ahead — a contract change un-built tasks depend on** | §The contract row below — the one route that fans out, and the one that re-opens a freeze |
| **after the go-ahead — a UI 2.0 design change** (prototype mode: the manifest carries a `ui2:` line) | the design layer is frozen after the go-ahead, so this is a **contract change**: route the design edit to the command that owns it (`/ui2-component-update`, `/ui2-resolve`, `/d2m-notes-assimilate`) — 🔴 **never edit a contract, registry row or note here** — then re-read the contract, give the steps that read it a **scoped** re-check (`/builder:align`'s field map for the touched fields, `/builder:audit`'s coverage for the touched rows), and edit the SPEC sections those steps wrote (§Schema & API changes `SC#` · §Findings `T#` · §Prototype · §Replaced surfaces · §Testing `B#`). Scoped means those rows and what keys on them, never a re-run of either step |
| **after sign-off** — `signed-off` · `verified`, SPEC header `✅ SIGNED OFF`, the §Plan index stripped and `PLAN.md` removed | the fix + its test, and **at most one line**: a ruling → §Decisions; a verify or review finding → a `- [ ]` under `## Fixes` naming its app; a dropped item → §Out of scope |

Say which route you took. The fan-out is the exception, not the default. **When two rows fit, pick by
what un-built work depends on, not by how the change was phrased** — so in practice take the lower row:
the contract row already contains the ruling row's §Decisions write.

## 🔴 The contract row — the only way a freeze re-opens

A change to §Contract (a route, a field, a type, a nullability, a permission, an error code, a push
payload) is the heaviest route this skill has, because **two consumers are coding against it and one of
them ships in a binary**. The complete write-back:

1. **Name what breaks, before editing anything.** For each consumer §Contract lists: does this change
   break code that is already written? And separately — 🔴 **does it break a RELEASED iPhone build?**
   A rename, a removal, a type change, a nullability change or an enum narrowing on a field a shipped
   build reads is breaking, and needs a stated transition in §Apps *Backward compatibility*, not a
   sentence about users updating. Additive is safe; say which this is.
2. **Edit §Contract, and §Apps if the blast radius moved.** Then grep the whole spec for the old shape
   so it does not disagree with itself.
3. **A §Decisions row for the ruling**, written as an implementable statement.
4. **Amend the affected `PLAN.md` task blocks** the ledger does **not** mark `Task N: complete` — in
   every app, not only the one that raised it. The §Plan index moves only if a task is added or dropped.
5. **If the manifest reads `contract: frozen`, re-open it deliberately:** set `contract: open
   (reopened <YYYY-MM-DD>)`, say in the hand-off which server work re-closes it, and 🔴 **name every
   consumer task that must be re-checked against the new shape** — a frozen contract exists so
   consumers can stop looking, and re-opening it means they must look again.
6. **Owed rework on ALREADY-BUILT consumer code** is a new task block at the end of `PLAN.md` (before
   sign-off), numbered on from the last task and carrying its `App:` and `Phase:` lines — or a `- [ ]`
   under `## Fixes` naming its app (after sign-off).
7. **If the phase table changed shape, re-take the go-ahead.** Adding a phase is a change to what was
   approved.

**This never triggers a re-audit.** The audit's pass cap is spent; a contract change is checked against
the code for that one contract and nothing else.

## Rules that keep it honest

- **Never edit a `PLAN.md` task block the ledger marks `Task N: complete`** — it describes work that
  happened. The ledger is `"$(.claude/scripts/build-spec-workspace.sh <feature>)/progress.md"`,
  re-resolved inline in every command. Owed rework is a **new** block or a `## Fixes` row, per the
  contract row above. **Appending a task block also extends that phase's `Tasks` cell in the
  `## Phases` table** — the table is what says which tasks a phase closes on, so a block left out of it
  is a task the phase never waits for.
- 🔴 **A new task block names ONE app**, like every other. A change that needs work in two apps is two
  blocks in two phases, server first.
- A reversed ruling **supersedes in place** in §Decisions (old ruling struck through, dated) — the
  history of *decisions* is the one record worth keeping.
- If the change grows the work (a new phase), say so plainly — the definition of done grew.
- Every behavioural change owes its test in the same task block.
- **The manifest moves only when the route changed something it records:** a re-taken go-ahead rewrites
  `go-ahead:`; a re-opened freeze rewrites `contract:`; a changed blast radius rewrites `apps:`. Nothing
  here advances or rewinds `state:`.
- **Gate the revision at its own size, not the feature's.** A moved button or a reworded label takes
  that app's fast gates — and a look at the running app if it's visual. It does **not** re-run the
  cross-app E2E walk, and it does not re-run `/builder:verify` wholesale: the feature was already
  verified, and a tweak that cannot change what a consumer does has nothing new to prove. The walk comes
  back only when the diff touches a §Contract row, an auth path, a load/save/delete path, a push payload
  or a `Route` case — the table in `builder:verify` §A re-verify is SCOPED decides it. Several tweaks in
  one sitting share ONE run at the end, if they earn one at all.
- 🔴 **An iPhone fix is staged, not committed** — the same rule the build follows.

## A behaviour change on a signed-off surface

It **voids that surface's sign-off** — say so in the hand-off and re-offer that part of the walk. 🔴 **It
voids it for that APP only**: a client fix leaves the iPhone walk standing, so name which app's walk is
affected rather than asking for the whole thing again. The manifest's `walk:` line stays: it records the
walk that happened. If the human walks it now, `/builder:signoff` records the new PASS; if they decline
for now, write `- [ ] re-walk: <surface> (<app>) — voided by <sha>` under `## Fixes`, where
`/builder:verify` item 2 blocks READY on it until the walk happens.

## Hand off

Commit docs with (or ahead of) the fix they describe; the commit key is `--ticket` when given, else the
manifest's `ticket:`, else the feature name. State: what changed and where (one line per file, grouped
by app), what it invalidated (usually nothing; a re-taken go-ahead, a re-opened contract freeze or a
voided sign-off surface when real), and the next command. Keep going — the fix task is usually startable
in the same turn.

```
📍 <feature>: revised (<route taken>) — next: /builder:resume --path <folder>
```
