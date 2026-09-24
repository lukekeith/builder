---
name: check
description: The stateless pre-flight for a UI 2.0 ref — run it repeatedly while a design settles, before it enters /builder:brainstorm. Resolves the ref, reads every in-scope contract, checks the prototype conventions, disposes the open questions, diffs a built preview against its frozen Figma snapshot, lists coverage owed and dead-end affordances, and runs the surface check (which live iPhone/web surfaces the ref replaces and what each side can do that the other can't), returned as one punch list ending READY or NOT READY for /builder:brainstorm --ui2 <ref>. Never touches the app, never writes a contract; writes nothing but the punch list. Use when the user asks whether a UI 2.0 component or screen is ready to build from, what the app does that the design doesn't, or "am I missing anything" before starting a build.
---

# `/builder:check` — the pre-flight, run as often as you like

Invocation: **`/builder:check --ui2 <ref> [--all] [--diff]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this skill does not use rather than erroring on it**. `--diff` is local to this
command and forces step 5.

🔴 **Stateless: it writes nothing but the punch list.** Not a UI 2.0 contract, registry row, note or
open question — those belong to `/ui2-*` and `/d2m-*`, and a note is normative owner input. Not
`server/`, `client/`, `iphone/` or `capture/`. Not a file under `docs/`, including SPEC §Replaced
surfaces: the design step writes that section, a stateless caller reports the rows. Nothing is cached
between runs — the ref is re-resolved and the scripts re-run every time, which is right for a command
run repeatedly while a design settles.

**Never start or stop a server, and never build a preview.** The capture stack is `:5950` / `:5951`.
Not answering → step 5 is reported `BLOCKED on environment` with `/capture-start` as what clears it; it
is never silently skipped and never reported as PASS. An **unbuilt** row is reported as unbuilt, and
`/ui2-component-build` is named as what would change that — this command never runs it.

**The feature folder, where one exists.** Derive the kebab-case name from the resolved title —
`C-034 SearchField` → `search-field`; screen `home-dashboard` → `home-dashboard` — and look for it under
`docs/features/`. Found with a `MANIFEST.md` → step 7 verifies by fingerprint and the obligations
checker runs at the end. Found as a pre-builder numbered suite → say so and name
`/builder:resume --path <folder>` as the conversion. Neither → the design is pre-pipeline; skip both and
say so in one line.

## 0. Resolve the surface

```
node .claude/scripts/list-ui2-refs.mjs --resolve "<ref>" --json
```

[`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md) is the whole procedure and the only thing that
decides what gets asked — follow its table rather than guessing; everything it does not name asks
nothing, because **a ref means everything beneath it**. Say which **kind** the ref resolved to — a
screen (every row it consumes) or a component (that row plus its dependencies) — and name the
dependency edge the scope stops at.

**Echo the resolved scope as a tree before any other work**, saying which rows you took, what is not in
scope, and **which rows are not yet built as previews**, so a wrong resolution is caught before the
expensive part. For a wide screen ref, run steps 2–4 as one `sonnet` agent per row and fold each result
in as it lands (REFERENCE §Agent model tiering); the judgment calls and the verdict stay here.

## 1. The contracts, read in full

For every in-scope row, open the document the resolution's `contract` field names — or the screen-spec
section its `Defined in` column names when the row has no file of its own — and read it **whole**.
Report per row: the designed states and variant axes, the props, the tokens it binds, and where its
contract lives. A row whose contract is a paragraph in a screen spec rather than its own file is a nit,
not a blocker, unless the row is non-trivial (REFERENCE §Prototype conventions item 2).

🔴 **Read its notes with the tool**, never by eye:

```
node capture/lib/ui2-notes.mjs read
```

A **PENDING** note is an owner ruling the contract may not yet reflect — report it as a blocker and name
`/d2m-notes-assimilate` as what folds it in. This command never writes a note and never marks one
assimilated.

## 2. Conventions

REFERENCE §Prototype conventions, **item by item** — its eight items are the checklist and are not
restated here. Report per item: satisfied, or the row and the shape of the fix.

The two that fail most often, and what they look like:

- 🔴 **States enumerated from an INSTANCE rather than the main component.** A Figma instance types as a
  one-value union, so a whole variant axis is invisible from it — and the contract then describes one
  state as if it were the component. The tell is a contract with exactly one state and a `Figma ref`
  pointing at a node inside a frame rather than at a set. This is the trap that broke the program's
  first spec; treat a single-state contract on a component that obviously has states as a blocker.
- **A literal where a token belongs** — a hex colour, a point size or a spacing number written into the
  contract with no row in `docs/ui2/design-system/tokens.md`. Either the token is unminted (a finding
  for the design pipeline) or the value is wrong.

## 3. Open questions, and whether they block

Every `OQ-C-###-n` in every in-scope contract, listed with a proposed disposition:

| Disposition | When |
|---|---|
| **blocks the build** | the answer changes what gets built — a prop that may not exist, a state whose behaviour is undecided, two rows that may be one. Report it as a blocker and, where it is the owner's to answer, phrase the question |
| **rides as a §Decisions row** | it has more than one defensible answer and the feature spec will rule on it |
| **rides as a §Findings row** | a build phase settles it in passing |
| **irrelevant to this build** | the OQ is about a consumer outside this scope. Say which |

An OQ nobody has dispositioned is the commonest source of a mid-build surprise, which is why this step
exists before the SPEC rather than inside it.

## 4. Coverage owed

REFERENCE §Prototype conventions' **Coverage discipline** paragraph is the demand. Per row: the happy
path · each error class with distinct copy · loading and empty · the permission-denied variant where
the five roles differ · the terminal. Report as **"states designed / states owed"**, each owed row
naming the component and the state — those become `B#` rows in SPEC §Testing once the design enters the
pipeline.

🔴 **Roles are the axis designs skip.** This app has Super Admin, Owner, Admin, Group Leader and Member,
and a component whose contract never mentions a role is making a claim it probably hasn't checked. Ask
it explicitly rather than assuming the design covered it.

## 5. The render against the design

Runs when `--diff` is given, **or** when an in-scope row's preview or fixture has uncommitted changes
(`git status`) or was touched by the last commit (`git log -1 --name-only`) — nothing is recorded
between runs, so those are the stateless proxy for "changed since the last run". Otherwise skipped, said
so in one line.

For each **built** row, diff its captured preview against its frozen Figma snapshot:

```
node capture/runners/compare/diff.mjs …
```

The percentage is **advisory**: judge the delta PNG and the hot bands. Consult the `compare-*`
auto-memories before calling a known snapshot artifact a regression — `.ultraThinMaterial` renders
invisible, `AsyncImage` falls back to initials, `CachedAsyncImage` shows a spinner, fixed-width tiles
collapse. A real disagreement between the preview and Figma is a blocker, and `/ui2-resolve` is what
fixes it.

For each **unbuilt** row: report it as unbuilt, name `/ui2-component-build` as what would render it, and
say plainly that its states have never been seen — which is a risk the build carries, not a failure of
the design.

## 6. Dead-end affordances

Every action, navigation target and terminal destination the in-scope contracts name: does what it
points at exist — another designed state, a live `Route` case, a real endpoint, a registered deep link?
Flag pointers to nowhere, and nothing else. The full ingress / egress / shared-surface graph belongs to
`builder:brainstorm` Phase 1P, not here.

## 7. The surface check

[`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md) is the procedure — **Phase A** (discover from every
applicable angle; one grep always misses, and a surface exists up to three times here), **Phase B**
(enumerate each REPLACES / ABSORBS surface in both directions, structure over content), **Phase C** (the
per-app disposition) and **Phase D**'s row shapes and fingerprint rule. Two differences here, both
because this command is stateless:

- **Phase D's rows are REPORTED, not written.** They go into the punch list as `S#` lines (what the live
  surface does that the design doesn't cover) and `N#` lines (what the design specifies that the app
  can't do), each carrying its owning app and, for an `N#`, its disposition — answer *where does this
  live when the app is closed?* in the same sitting. Their durable home is SPEC §Replaced surfaces,
  written once by `builder:brainstorm` Phase 1P.
- **Fingerprint first when the feature folder has a SPEC with §Replaced surfaces**: re-fingerprint each
  surface (`git log -1 --format=%h -- <path>`); an unchanged sha means the rows are still accurate —
  report and move on. Re-run discovery only when the row selection changed or a new route, page or
  registry row appeared in the domain.

Then, only when that folder exists and carries a `SPEC.md`:

```
node .claude/scripts/check-flow-obligations.mjs <folder>
```

Two seconds. **Exit 1 is the blocker** — it names its own rows, and a capability the design adds with
nothing downstream is the N1 class (REFERENCE §Standing traps). **Exit 2 is bad usage or no such
folder**, not an obligation failure: fix the argument, never report it as a finding.

## Output

One punch list, ordered **blockers** (a pending note, a single-state contract on a component with
states, a preview that disagrees with Figma, a build-blocking open question) → **surface gaps**
(`S#` / `N#`, grouped by app) → **coverage owed** → **dead ends** → **nits**. Every item names its row
and the fix pattern; a bare complaint is not an item.

Then the verdict — **READY** or **NOT READY** — with lettered options: the recommendation first and
marked, each option a literal copy/paste command, and the proceed-anyway override last with its
consequence named ("the design step will surface these as gaps and ask about each one"). A blocker that
is really a decision gets the *answers* as options, not tasks. 🔴 **Every option that changes the design
is a `/ui2-*` or `/d2m-*` command** — this family proposes, it does not edit.

Footer — the command matching the verdict, never the pipeline when NOT READY. READY's option A is
`/builder:brainstorm --ui2 "<ref>"`:

```
📍 <ref>: pre-flight <READY | N blockers> — next: <option A's literal command>
```
