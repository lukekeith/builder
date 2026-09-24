---
name: prototype
description: Get a design into a state the /builder:* pipeline can consume as requirements — the router into whatever design pipeline the project config names, plus the checklist of what a BUILD needs from a design contract that a faithful spec of the design tool does not always supply. Writes nothing itself: it reports what is missing, names the command that supplies it, and hands to /builder:check. Use when the user asks how to get a design ready to build from, wants to prototype a screen or component for the pipeline, or asks what the build needs that the design doesn't have yet.
---

# `/builder:prototype` — get a design ready to be requirements

Invocation: **`/builder:prototype [--<design.flag> <ref>] <what the flow is>`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags.

**This command exists only when `.claude/builder.md` has a `design:` block.** Without one there is no
design pipeline to route into: say so in one line, and point at `/builder:brainstorm`, which designs
from a conversation instead.

🔴 **This skill writes nothing.** The design system belongs to the commands the config's
`design.owned_by` names — they write the contracts, the registry, the tokens, the notes and the
rendered previews. This command is the **router into them**, plus the one thing they do not have on
their own: *what a BUILD needs from a design*, which is a different and slightly longer list than
what a faithful spec of the design tool needs.

## Why the bar is this high

In prototype mode the design **is** the requirements: `/builder:brainstorm --<flag> <ref>` does not
interview generically — it reads the in-scope contracts, compares them against the codebase, and
writes the SPEC from what remains. **A state nobody designed is a capability the build will not
ship.** An open question nobody dispositioned is a mid-build surprise. A contract specced from an
instance rather than the source component describes one state as though it were the component, and
the build ships that one state.

## The routing table

Read the config's **§Design source** — it names the commands this project actually has. The shapes
they come in, and what each is for:

| What is missing | The kind of command that supplies it |
|---|---|
| the screen or flow has no spec at all | the project's **screen-spec** command — specs one screen and decomposes it against the component registry |
| a component has no registry row, or its contract is a paragraph inside a screen spec | the project's **component-spec** command — ingests every designed variant and state from the **source component**, mints or enriches the row, writes the contract |
| a contract exists but has never been rendered | the project's **build/preview** command — renders it, derives its fixture, captures it and diffs it against the frozen design snapshot |
| the render disagrees with the design | the project's **resolve** command — the design is the reference; the render, its fixture, or (for an owner ruling) the contract is what changes |
| the contract has fallen behind the build and the rulings since | the project's **refresh** command |
| there are pending owner notes | the project's **notes** command. 🔴 Read them first with the tool the config names, never by eye, and never write one as test data |
| two rows are the same component | the project's **merge** command |
| a row should never have existed | the project's **delete** command |

**Run `/builder:check --<design.flag> <ref>` between steps.** It is the stateless pre-flight, it
writes nothing, and its punch list is the shortest path to knowing what is still owed.

## What a BUILD needs that a design spec doesn't always carry

The config's §Design source should carry this list for your project; where it does, read it there.
These are the classes that recur everywhere, and every one of them has cost a real build:

1. **Every designed state, from the SOURCE component.** 🔴 Never from an instance — an instance
   exposes one value of each variant axis, so a whole axis is invisible from it and the contract reads
   as though the component has one state.
2. **The states the design forgot, as proposed defaults plus an open question.** A real flow produces
   loading, empty, each error class, and permission-denied. Design tools usually draw the happy path.
   A proposed default with an open question is buildable; silence is not.
3. **Roles.** Where the product has more than one, surfaces diverge by role and a contract that never
   mentions one is making an unchecked claim.
4. **Which fields it renders**, at field granularity, so `/builder:align` can trace each one to a
   model column and to the property each consumer holds it in. A fixture or sample payload usually
   already is this answer.
5. **Which consumer it is for.** One, the other, or both — consumers that share no code make this a
   different build in each.
6. **What it replaces**, named by file: the existing component this supersedes. A "modify the existing
   one" row needs a **closed** change list; an open-ended "modernise it" is not buildable.
7. **Tokens, not literals** — every value binding a row in the project's token source.
8. **Its open questions dispositioned** — blocks the build · rides as a decision · rides as a finding ·
   irrelevant here. `/builder:check` step 3 produces exactly this list.

## Adding to a design already in the pipeline

A contract or render changed after `/builder:brainstorm --<flag> <ref>` has run **invalidates only the
steps that read it** — the design step's gap list, `/builder:align`'s field map, and the audit's
coverage and render items. Say exactly that in the hand-off, naming the items touched, so the next
`/builder:resume --path <folder>` re-checks those scoped instead of redoing the flow. `<folder>` is
the feature folder under the config's `registry:`, never a design directory.

⛔ **After the go-ahead the design layer is frozen.** A change then goes through
`/builder:revise --path <folder>`, because the spec was written from the contract as it stood — and
revise's design row routes the edit back to the command that owns it.

## Hand off

What the ref resolves to, which items are specced, which are built, what each still owes, and the one
command that supplies the next missing thing. Then:

```
📍 <ref>: <n> items — <specced>/<built>, <m> owed — next: <the design command, or /builder:check --<flag> "<ref>">
```
