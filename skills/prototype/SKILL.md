---
name: prototype
description: Get a UI 2.0 design into a state the /builder:* pipeline can consume as requirements — the router into MakeReady's existing design pipeline (/ui2-screen, /ui2-component, /ui2-component-build, /ui2-resolve, /d2m-*) plus the checklist of what a build actually needs from a contract that specced-for-Figma work does not always supply. Writes nothing itself: it reports what is missing, names the command that supplies it, and hands to /builder:check. Use when the user asks how to get a design ready to build from, wants to prototype a screen or component for the pipeline, or asks what the build needs that the design doesn't have yet.
---

# `/builder:prototype` — get a design ready to be requirements

Invocation: **`/builder:prototype [--ui2 <ref>] <what the flow is>`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this skill does not use rather than erroring on it**.

🔴 **This skill writes nothing.** MakeReady already has a design pipeline, and it is not this one: the
UI 2.0 spec program owns every contract, registry row, token, note and preview under `docs/ui2/`,
`capture/fixtures/ui2/` and `iphone/MakeReady/UI2Preview/`. This command is the **router into it**, plus
the one thing that pipeline does not have on its own — *what a BUILD needs from a design*, which is a
different and slightly longer list than what a faithful spec of Figma needs.

## Why the bar is this high

In prototype mode the design **is** the requirements (REFERENCE §Prototype mode):
`/builder:brainstorm --ui2 <ref>` does not interview generically — it reads the in-scope contracts,
compares them against four codebases, and writes the SPEC from what remains. **A state nobody designed
is a capability the build will not ship.** An open question nobody dispositioned is a mid-build
surprise. A contract specced from a Figma *instance* rather than the main component describes one state
as though it were the component, and the build ships that one state.

## The routing table

| What is missing | The command that supplies it |
|---|---|
| the screen has no spec at all | `/ui2-screen` — specs one screen, decomposes it against the registry, writes the screen spec and updates the shared artifacts |
| a component has no registry row, or its contract is a paragraph in a screen spec | `/ui2-component` — ingests every designed variant and state from the **component set**, mints or enriches the `C-###` row, writes the contract under `docs/ui2/design-system/components/` |
| a contract exists but has never been rendered | `/ui2-component-build` — writes the preview, derives the fixture and capture-registry case, captures it in the simulator and diffs it against the frozen Figma snapshot |
| the preview disagrees with Figma | `/ui2-resolve` — Figma is the reference; the preview, its fixture, or (for an owner ruling) the contract is what changes |
| the contract has fallen behind the build and the rulings since | `/ui2-component-refresh` |
| there are PENDING owner notes on the row | `/d2m-notes-assimilate` — folds them into the contract and marks them assimilated. 🔴 Read them first with `node capture/lib/ui2-notes.mjs read`, never by eye, and never write one as test data |
| two rows are the same component | `/ui2-component-merge <keep> <duplicate>` |
| a row should never have existed | `/ui2-component-delete <C-###> <reason>` |

**Run `/builder:check --ui2 <ref>` between steps.** It is the stateless pre-flight, it writes nothing,
and its punch list is the shortest path to knowing what is still owed.

## What a BUILD needs that a Figma spec doesn't always carry

Report these against the in-scope rows, and route each miss to the command above. They are the delta
between "this contract faithfully describes the design" and "a fresh implementer can build it without
guessing" — and every one of them has cost a real build here.

1. **Every designed state, from the component SET.** 🔴 Never from a frame instance — an instance types
   as a one-value union, so a whole variant axis is invisible from it, and the contract then reads as
   though the component has one state. Check the main component and its variant props.
2. **The states the design forgot, as proposed defaults plus an open question.** A real flow produces
   loading, empty, each error class with distinct copy, and permission-denied. Figma usually draws the
   happy path. A proposed default with an OQ is buildable; silence is not.
3. **Roles.** This app has five (Super Admin, Owner, Admin, Group Leader, Member) and the surfaces
   diverge by role. A contract that never mentions a role is making an unchecked claim.
4. **Where its data comes from, at the level of a field.** Not the endpoint — that is the spec's job —
   but *which* fields the component renders, so `/builder:align` can trace each one to a Prisma column
   and an `AppState` property. The **fixture** is usually this answer already: its keys are the payload.
5. **Which consumer it is for.** iPhone, web, or both. The registry's `Platform` column says `ios` for
   most 2.0 rows, and a row that both consumers will render is a different build — say so, because the
   two never share code.
6. **What it replaces.** The legacy component in `iphone/MakeReady/Components/` or `client/ui/`, named
   by file. `existing-modified` rows must carry a **closed change list**: anything not listed stays as
   is, and an open-ended "modernise it" is not buildable.
7. **Tokens, not literals.** Every colour, type and spacing value binding a row in
   `docs/ui2/design-system/tokens.md`. A literal is an unminted token or a wrong value.
8. **Its open questions dispositioned** — blocks the build · rides as a decision · rides as a finding ·
   irrelevant here. `/builder:check` step 3 produces exactly this list.

## Adding to a design already in the pipeline

A contract or preview changed after `/builder:brainstorm --ui2 <ref>` has run **invalidates only the
steps that read it** — the design step's gap list, `/builder:align`'s field map, and the audit's
coverage and render items. Say exactly that in the hand-off, naming the rows touched, so the next
`/builder:resume --path <folder>` re-checks those rows scoped instead of redoing the flow. `<folder>` is
the feature folder under `docs/features/`, never a design directory.

⛔ **After the go-ahead the design layer is frozen** (REFERENCE §Prototype mode). A change then goes
through `/builder:revise --path <folder>`, because the spec was written from the contract as it stood —
and `/builder:revise`'s design row routes the edit back to the `/ui2-*` command that owns it.

## Hand off

What the ref resolves to, which rows are specced, which are built, what each one still owes, and the
one command that supplies the next missing thing. Then:

```
📍 <ref>: <n> rows — <specced>/<built>, <m> items owed — next: <the /ui2-* command, or /builder:check --ui2 "<ref>">
```
