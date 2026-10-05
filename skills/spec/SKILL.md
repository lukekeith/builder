---
name: spec
description: Write the feature's spec from a confirmed design conversation — reads the workspace record /builder:brainstorm or /builder:intake left (the intent, how it works today, every decision with its reasoning, the approaches, the size), presents the design section by section for approval with §Idea first (why, what success looks like, the owner's rules in their own words, the concept, how it fits today, the approaches considered), then writes SPEC.md + MANIFEST.md (or PROGRAM.md at xl), proves the obligations, commits, and hands on to /builder:resume. Also applies a brainstorm revision to a spec that has no go-ahead yet. Use after a brainstorm or intake is sized md, lg or xl.
---

# `/builder:spec` — the confirmed concept, written down

Invocation: **`/builder:spec [--path <folder>] [--auto] [--help]`**.

**`--help` first.** If present, render the `builder:help` card and stop.

**Precondition:** `.builder/<feature>/brainstorm.md` with `status: sized md`, `sized lg` or
`sized xl` for new work — or, for a revision, `status: confirmed` (a revision conversation skips
§Size) with a live `SPEC.md` and no `go-ahead:` in its manifest. Otherwise say in one line what is
missing and name `/builder:brainstorm` or `/builder:intake`, and stop.

**Where things go.** `--path <registry>/<feature>` names the feature; the record is
`.builder/<feature>/brainstorm.md` and the output folder is `<registry>/<feature>/`, created if new.
Without `--path`: if exactly one record is at `sized md|lg|xl`, use it; otherwise run
`node <builder>/scripts/list-features.mjs --json` and offer the rows whose state starts with `sized`
in one AskUserQuestion.

**Revision:** amend the existing SPEC rather than writing a new one. Keep the existing §Decisions
rows — supersede a row in place with a date, never delete one (REFERENCE's rule) — and add rows for
the newly settled branches.

**Load REFERENCE and `.claude/builder.md` before writing anything**: REFERENCE §SPEC.md,
§MANIFEST.md and §PROGRAM.md hold every shape this step produces; the config holds every fact about
the project. Read the whole record.

## 1. Present the design, section by section

In SPEC order, each section scaled to its complexity, asking after each whether it is right:

1. **§Idea** — from the record's Intent, How it works today, Approaches and the Tree's Why and
   Rejected columns: why, what success looks like, **the owner's key rules verbatim** each linked to
   the D# that operationalizes it, the concept (a mermaid diagram when several parts move), how it
   fits today (prose; `file:line` only as footnotes), the approaches considered with why each lost.
2. **§Apps and §Contract** — the blast radius.
3. The per-app sections, §Schema & API changes, §Testing, §Out of scope; in prototype mode §Prototype
   and §Replaced surfaces from the record's intake findings.

**How a section is shown.** Never paste the section as the file will hold it: no tables, field
lists, types, status codes or length limits. Show each one in three parts:

- **What it says.** Two to four plain sentences about what changes for the user and between the
  apps. Routine plumbing (a new field, an error code, a limit, a command shown on a page) gets one
  closing "Also:" line.
- **What to check.** List only the items where a different answer changes the product or would be
  expensive to undo: something that acts without the user (an agent closing, merging or deleting),
  data overwritten or lost, something made visible or irreversible, a shape a released consumer
  already depends on, a real fork between alternatives. Give each one line saying what happens and
  what it means for them. If nothing qualifies, say "Nothing here needs your judgement — it follows
  from what we settled." Never invent an item to fill the list.
- **The ask.** One AskUserQuestion whose options are only **Right** and **Change something** —
  🔴 **never alternative designs as options**: an approval approves; it doesn't decide. Its
  `question` text stands on its own, because the question box can hide the message above it: name
  every "What to check" item in it in a few words ("Right — design boxes hidden outside the designer,
  a click tags it in chat, the next Design doesn't get them?"), never "the three checks". Show the
  full section text only when they ask for it.

**A check that is really an unsettled choice is not a check.** If a "What to check" item has two
defensible answers that the record never ruled on, the brainstorm missed a branch: add it to the
record's tree as `open` and ask it before the section, as its own question in
`/builder:brainstorm`'s §Rounds format — the briefing in chat (the decision, why it matters, what it
affects, the recommendation with its evidence) and one AskUserQuestion whose options each say what
picking it does. Quote the owner's own words when they already answer it — then it was settled, and
it's a check again.

For §Apps and §Contract, say once why the check matters: the contract freezes when the producer's
build phase closes, and changing it after that means `/builder:revise` and a re-check of every
consumer.

Pushback amends the record's tree first, then the section. Under `--auto` present and proceed.

## 2. Write the files

**`SPEC.md`** per REFERENCE §SPEC.md. md writes the sections its work touches — **§Idea, §Apps and
§Contract are never skipped**; lg writes them all. Every settled branch — a choice — becomes a
§Decisions row: an implementable ruling, its why in one line, the rejected option and why it lost,
and the Tree row's Who / date as its Who/date (an `auto (recommended) YYYY-MM-DD` stays exactly
that) — copy the §Decisions comment block verbatim. Intake tags each row with its kind. A
`confirmed` `decision`, `requirement`, `constraint` or `non-goal` row is a choice the document made
and the code agrees with: it becomes a §Decisions row like any settled branch, credited to the
document — Who/date is the record's `input:` source and the date intake confirmed it (the Tree row's
Who / date). A `confirmed` `claim` — a fact about how the code already works — goes to §Idea's how
it fits today, or to §Findings & risks when it constrains the build, never to §Decisions. **A
`confirmed` row with no kind tag** (an older record, or a missed tag): read the document line it
cites — a choice the document makes is a `decision`, a statement about existing code is a `claim`;
when it could be either, write an OPEN §Decisions row with your recommendation rather than guess. A `contradicted` or `unverifiable` row still unresolved when spec runs
(possible after "that's enough") becomes an OPEN §Decisions row that states the contradiction and
its recommendation; it blocks the go-ahead like any OPEN row. Assumed branches the user never
contested are rulings too, marked `(assumed at brainstorm)` in Who/date. **An OPEN branch that reaches spec becomes an
OPEN §Decisions row carrying its recommendation** — it blocks the go-ahead. Verify that every
component the per-app sections name exists NOW and that its interface fits; a missing one is a
**(new)** row, and say plainly that approving the spec approves building it. Target ≤ 350 lines.

**Prototype mode** (the record says `input: design ref <ref>`): §Prototype and §Replaced surfaces
come from the record's prototype material, per REFERENCE §Prototype mode step 5 — the resolved
scope, the inventory summary, the axis-1 surface table (REPLACES / ABSORBS / REUSES with
fingerprints and owning apps), the S#/N# rows, the journey edges found MISSING, the §Prototype seams
and each gap's disposition. Gaps dispositioned "write it into the SPEC" become `T#`/`SC#` rows,
§Decisions rulings or §Findings rows; "out of scope" ones become §Out of scope lines with the
decider. The manifest's design key carries `<ref>`.

**`MANIFEST.md`** per REFERENCE §MANIFEST.md: `size`, `state: spec`, `next:`, `head`, `ticket`
(the record's `ticket:` header line, else its `input: ticket <id>`, else `none`), `branch`,
`pr: none`, **`apps:`** (the plus-joined in-scope apps), **`contract: open`** (or `none` when no
producer change), `hold: none`, `go-ahead`/`walk`/`verify: none`, the design key, `auto:`.
(A revision keeps the manifest it has and changes only what the amendment moves.)

**When the record says `sized xl`** write `PROGRAM.md` per REFERENCE §PROGRAM.md instead — the children, their order
(🔴 ordered by the contract), the decisions they share — plus a program manifest; take the one program
go-ahead, then continue to §3.

## 3. Prove it, commit, hand on

```
node <builder>/scripts/check-obligations.mjs <folder>
```

(At xl skip this: the script checks a SPEC.md, not a PROGRAM.md — self-review the PROGRAM instead.)

Fix every FAIL; resolve every WARN or say why it stands. **Self-review** with fresh eyes: placeholder
scan; internal consistency (does §Testing cover every interface §Contract declares? does every ✅ in
§Apps have its section? does every "In your words" quote link to a real D#?); ambiguity — a ruling a
stranger could implement two ways is not written yet. Commit `docs(<ticket-or-feature>): design
<feature>` (scope from the manifest's `ticket`, otherwise the feature name), set the record's
`status: handed-off`.

Say what was written and where; **lead with the §Apps row**; list the OPEN decisions with their
recommendations; in prototype mode add the gap tally in its three buckets — fixed in the design · written into the SPEC · out of scope — and name which items are not yet built. Then:

```
📍 <feature>: designed (<size>, <apps>) — next:
   1. resume — continue here, step by step: /builder:resume --path <registry>/<feature>
   2. agent  — hand it to agents to finish and merge: /builder:agent --path <registry>/<feature>
   Reply 1 or 2 (or "resume" / "agent"; "go" is 1)
```

The numbered form is REFERENCE §The two-way footer (`../resume/REFERENCE.md`); without a config
`agent_walk:` block, the single line `📍 … — next: <option 1> · or say go`.
