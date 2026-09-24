---
name: check
description: The stateless pre-flight for a design ref — run it repeatedly while a design settles, before it enters /builder:brainstorm. Resolves the ref, reads every in-scope contract, checks it against the project config's design conventions, disposes the open questions, diffs a built item against its frozen design snapshot, lists coverage owed and dead-end affordances, and runs the surface check (which live surfaces the ref replaces and what each side can do that the other can't), returned as one punch list ending READY or NOT READY. Never touches app code, never writes the design; writes nothing but the punch list. Use when the user asks whether a design is ready to build from, what the app does that the design doesn't, or "am I missing anything" before starting a build.
---

# `/builder:check` — the pre-flight, run as often as you like

Invocation: **`/builder:check --<design.flag> <ref> [--all] [--diff]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — `--diff` is local to this command and forces step 5.

**This command exists only when `.claude/builder.md` has a `design:` block.** Without one there is no
design source to check: say so in one line and stop.

🔴 **Stateless: it writes nothing but the punch list.** Not a design contract, registry row, token or
note — those belong to the commands the config's `design.owned_by` names. Not app code. Not a file
under `docs/`, including SPEC §Replaced surfaces: the design step writes that section, a stateless
caller reports the rows. Nothing is cached between runs — the ref is re-resolved and the scripts
re-run every time, which is right for a command run repeatedly while a design settles.

**Never start or stop a server, and never build a design item.** Tooling that does not answer → the
step is reported `BLOCKED on environment` with what clears it; never silently skipped, never reported
as PASS. An **unbuilt** item is reported as unbuilt, and the command that would render it is named —
this command never runs it.

**The feature folder, where one exists.** Derive the kebab-case name from the resolved title and look
for it under the config's `registry:`. Found with a `MANIFEST.md` → step 7 verifies by fingerprint and
the obligations checker runs at the end. Found as a pre-builder folder → say so and name
`/builder:resume --path <folder>` as the conversion. Neither → the design is pre-pipeline; skip both
and say so in one line.

## 0. Resolve the surface

Run the config's `design.resolver` with `--resolve "<ref>" --json`.
[`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md) is the whole procedure and the only thing that
decides what gets asked — follow its table rather than guessing; everything it does not name asks
nothing, because **a ref means everything beneath it**. Say which **kind** the ref resolved to and
name the dependency edge the scope stops at.

**Echo the resolved scope as a tree before any other work**, saying which items you took, what is not
in scope, and **which items are not yet built**, so a wrong resolution is caught before the expensive
part. For a wide ref, run steps 2–4 as one `sonnet` agent per item and fold each result in as it
lands; the judgment calls and the verdict stay here.

## 1. The contracts, read in full

For every in-scope item, open the document the resolution names and read it **whole**. Report per
item: its designed states and variant axes, its props, the tokens it binds, and where its contract
lives.

🔴 **Where the design system carries owner notes, read them with the tool the config names**, never by
eye. A **pending** note is a ruling the contract may not yet reflect — report it as a blocker and name
the command that folds it in. This command never writes a note and never marks one assimilated.

## 2. Conventions

The config's **§Design source** lists what a build needs from a contract beyond a faithful spec of the
design tool. Check it **item by item** and report per item: satisfied, or the item and the shape of
the fix.

Two failure classes are worth naming here because they recur across projects:

- 🔴 **States enumerated from an INSTANCE rather than the source component.** In most design tools an
  instance exposes one value of each variant axis, so a whole axis is invisible from it — and the
  contract then describes one state as if it were the component. The tell is a contract with exactly
  one state on a component that obviously has several. Treat that as a blocker.
- **A literal where a token belongs** — a colour, a size or a spacing number written into the
  contract with no row in the project's token source. Either the token is unminted (a finding for the
  design pipeline) or the value is wrong.

## 3. Open questions, and whether they block

Every open question in every in-scope contract, listed with a proposed disposition:

| Disposition | When |
|---|---|
| **blocks the build** | the answer changes what gets built — a prop that may not exist, a state whose behaviour is undecided, two items that may be one. Report it as a blocker and, where it is the owner's to answer, phrase the question |
| **rides as a §Decisions row** | more than one defensible answer, and the feature spec will rule |
| **rides as a §Findings row** | a build phase settles it in passing |
| **irrelevant to this build** | it concerns a consumer outside this scope. Say which |

One nobody dispositioned is the commonest source of a mid-build surprise, which is why this step runs
before the SPEC rather than inside it.

## 4. Coverage owed

Per item: the happy path · each error class with distinct copy · loading and empty · the
permission-denied variant where roles differ · the terminal state. Report as **"states designed /
states owed"**, each owed row naming the item and the state — those become `B#` rows in §Testing once
the design enters the pipeline.

🔴 **Roles are the axis designs skip.** Where the project has more than one role, a contract that
never mentions one is making a claim it probably hasn't checked. Ask it explicitly.

## 5. The render against the design

Runs when `--diff` is given, **or** when an in-scope item's rendered form has uncommitted changes
(`git status`) or was touched by the last commit (`git log -1 --name-only`) — nothing is recorded
between runs, so those are the stateless proxy for "changed since the last run". Otherwise skipped,
said so in one line.

For each **built** item, diff its rendered form against its frozen design snapshot with the command
the config names. Read the result the way the config says to read it: where it warns that a
percentage is advisory, or that a particular rendering artifact is expected, honour that before
calling anything a regression. A real disagreement between the render and the design is a blocker, and
the config names the command that fixes it.

For each **unbuilt** item: report it as unbuilt, name the command that would render it, and say
plainly that its states have never been seen — a risk the build carries, not a failure of the design.

## 6. Dead-end affordances

Every action, navigation target and terminal destination the in-scope contracts name: does what it
points at exist — another designed state, a real route, a real endpoint, a registered link? Flag
pointers to nowhere, and nothing else. The full journey graph belongs to `builder:brainstorm`
Phase 1P.

## 7. The surface check

[`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md) is the procedure — **Phase A** (discover from every
applicable angle; one grep always misses), **Phase B** (enumerate each REPLACES / ABSORBS surface in
both directions, structure over content), **Phase C** (the per-app disposition) and **Phase D**'s row
shapes and fingerprint rule. Two differences here, because this command is stateless:

- **Phase D's rows are REPORTED, not written.** They go into the punch list as `S#` lines (what the
  live surface does that the design doesn't cover) and `N#` lines (what the design specifies that the
  app can't do), each carrying its owning app and, for an `N#`, its disposition — answer *where does
  this live when the app is closed?* in the same sitting. Their durable home is SPEC §Replaced
  surfaces, written once by `builder:brainstorm`.
- **Fingerprint first when the feature folder has a SPEC with §Replaced surfaces**: re-fingerprint
  each surface (`git log -1 --format=%h -- <path>`); an unchanged sha means the rows are still
  accurate — report and move on. Re-run discovery only when the selection changed or a new surface
  appeared in the domain.

Then, only when that folder exists and carries a `SPEC.md`:

```
node <builder>/scripts/check-obligations.mjs <folder>
```

**Exit 1 is the blocker** — it names its own rows, and a capability the design adds with nothing
downstream is the N1 class. **Exit 2 is bad usage or no such folder**, not an obligation failure: fix
the argument, never report it as a finding.

## Output

One punch list, ordered **blockers** (a pending note, a single-state contract on a component with
states, a render that disagrees with the design, a build-blocking open question) → **surface gaps**
(`S#` / `N#`, grouped by app) → **coverage owed** → **dead ends** → **nits**. Every item names its
item and the fix pattern; a bare complaint is not an item.

Then the verdict — **READY** or **NOT READY** — with lettered options: the recommendation first and
marked, each option a literal copy/paste command, and the proceed-anyway override last with its
consequence named ("the design step will surface these as gaps and ask about each one"). A blocker
that is really a decision gets the *answers* as options, not tasks. 🔴 **Every option that changes the
design is one of the commands the config's `design.owned_by` names** — this family proposes, it does
not edit.

Footer — the command matching the verdict, never the pipeline when NOT READY:

```
📍 <ref>: pre-flight <READY | N blockers> — next: <option A's literal command>
```
