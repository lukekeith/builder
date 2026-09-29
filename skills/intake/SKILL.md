---
name: intake
description: Verify a worked-out input against reality before a spec is written — a spec or brief someone already wrote (a file, a pasted doc, a superpowers design spec), a ticket, or a finished design ref (prototype mode). Extracts every decision, architectural claim, requirement and constraint it states, checks each against the code with parallel sub-agents (confirmed with evidence, contradicted with what the code actually does, or unverifiable), hunts the gaps it never decides, then asks only about contradictions and gaps in rounds — confirmed claims are reported, not asked. Ends in a confirmed understanding and a size, then hands on to /builder:spec. Use when the user already has the design written down and wants it grounded in what's real.
---

# `/builder:intake` — the document is the authority; check it against the code

Invocation: **`/builder:intake [--path <folder>] [--<design.flag> <ref>] [--all] [--auto] [--keep]
[--help] <doc path | ticket id | pasted text>`**. Ignore any flag this step does not use.

**`--help` first.** If present, render the `builder:help` card and stop.

**The mechanics live in [../brainstorm/CONVERSATION.md](../brainstorm/CONVERSATION.md)** — the
record, rounds, confirm, size, steering. Read it now. Read `.claude/builder.md`. Load REFERENCE
§Prototype mode only for a design ref, and the three sections CONVERSATION.md names, when the
conversation reaches them — never REFERENCE wholesale.

**The difference from brainstorm:** brainstorm draws out what the user wants; intake takes what is
written as the requirements and finds where it meets reality. Intent is still played back — in one
paragraph, from the document.

## Where to start

- `--path` with a record whose `source: intake` → resume from its `status:` (CONVERSATION §The
  record). `source: brainstorm` →
  hand it to `/builder:brainstorm`.
- The name checks in brainstorm's §Where to start step 4 — the archive refusal, the DONE check and
  the pre-builder-layout hand-off — apply the same way.
- A live `SPEC.md` under the name → this is a revision: hand it to `/builder:brainstorm --path
  <folder>`, which owns revision conversations. `--path` to a folder with no `brainstorm.md` and no
  SPEC → start fresh with that name.
- **A ticket id** → read it with the config's ticket tooling, and its dossier when `ticket.dossier`
  names one.
- **A design flag** → prototype mode, below.
- Name the feature from the document's title; confirm it in the first turn.

## 1. Extract

Read the whole input. Every decision, architectural claim ("X already caches per request"),
requirement, constraint and non-goal becomes a tree row with status **`stated`**, citing where the
document says it. Write the record (`status: exploring`, `source: intake`, `input: <kind>`), then play
back the intent in one paragraph, from the document, the author's key rules quoted.

## 2. Verify

Check every `stated` row against the code with parallel sub-agents (Explore, `sonnet`; `opus` for a
verdict that needs judgment). Each row ends as:

- **`confirmed`** — the code agrees; the Evidence cell carries `file:line`.
- **`contradicted`** — the code does something else; the Evidence cell says what, with `file:line`.
- **`unverifiable`** — only running code or a person can say; name which.

Update `contradicted:` in the header as they land. A `contradicted` or `unverifiable` row the user
rules on becomes `settled`, with the ruling; the header's `contradicted:` counts the contradictions
still unresolved.

## 3. Find the gaps

Branches the document never decides but the build will meet become `open` rows:

- **states** it doesn't cover — empty, refused, done, legacy data, errors;
- **callers and consumers** it doesn't list — who else reads or writes what it changes;
- **rollout** — what a RELEASED build sees meanwhile, for an app the config marks
  `released_artifact: true`;
- **the four multi-app branches** when more than one app is involved (see brainstorm §Rounds);
- **what already exists** that the document would rebuild.

## 4. Report, then ask

Report first, briefly: `14 of 19 claims confirmed · 3 contradicted · 2 unverifiable · 6 gaps` — the
confirmed ones as a list, not questions. Then CONVERSATION §Rounds on the **contradicted,
unverifiable and open** rows only: for a contradiction, the question is which side changes — the
document or the code — with your recommendation.

## 5. Confirm, size, hand on

CONVERSATION §Confirm and §Size and the small path. md, lg and xl hand on to `/builder:spec`.

## Prototype mode — a design ref

**The design is the requirements** (REFERENCE §Prototype mode). Only when the config has a `design:`
block.

Prototype mode replaces §1–§3: the design's contract facts are the `stated` rows, and the five-axis
check is their verification — each fact ends `confirmed` or `contradicted` with evidence, and each gap
is an `open` row. §4 and §5 then run as written, and §5 sizes from the whole resolved set.

1. **Resolve the ref — never from memory** — with the config's `design.resolver`, following
   [`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md). Under `--auto` an ambiguous ref without `--all`
   refuses to start. Echo the resolved scope as a tree, naming what is NOT in scope and which items are
   not yet built. A feature whose manifest's design key already carries this ref IS the feature: hand
   it to `/builder:resume --path <folder>`. A design still being specced → `/builder:check` first.
2. **Inventory the design** per in-scope item — its contract read in full, its designed states and
   variant axes, props, tokens, open questions, whether it is built. Parallel `sonnet` agents for a
   wide ref. Each contract fact is a `stated` row; the full inventory goes to the workspace. If the
   design system carries owner notes, read them with the tool the config names — never by eye, and
   never write one.
3. **Verify against reality on five axes** (`sonnet` sweeps, `opus` verdicts): replaced surfaces
   ([`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md)); journey edges — ingress, egress, shared surfaces,
   including deep links; component coverage — every element resolves to a real component, and the
   legacy one it replaces is identified (a missing one is a design-system defect: route it, never
   invent inline); conventions — the config's §Design source, item by item; a light read of what the
   design persists (the full trace is align's).
4. **One gap list** across the whole scope — the same defect at eight sites is one gap with its eight
   sites — ordered by blast radius. Gaps are asked in rounds like any open row, but a gap whose
   disposition is "fix it in the design" ends that round: the fix is routed to the design's owner and
   the contract is re-read before the next round. Each gap is an `open` row offering REFERENCE §Prototype mode's three
   options, recommendation marked: fix it in the design (route to the config's `design.owned_by`, then
   re-read the contract), write it into the SPEC, or out of scope. 🔴 **This step never edits the
   design.** Under `--auto` a gap takes its recommended option; "fix it in the design" is recommended
   only for a bounded, mechanical fix.

The record carries, so `/builder:spec` can write §Prototype and §Replaced surfaces:

- the resolved scope;
- the inventory summary;
- the axis-1 surface table (REPLACES/ABSORBS/REUSES with fingerprints and each row's owning app,
  re-verified by fingerprint when a §Replaced surfaces already exists);
- the `S#` and `N#` rows;
- the journey edges found MISSING;
- the persistence read as §Prototype seams;
- each gap's disposition.

## Every pause

```
📍 <feature>: intake (<k> contradicted, <n>/<m> settled) — resume with /builder:intake --path <registry>/<feature>
```
