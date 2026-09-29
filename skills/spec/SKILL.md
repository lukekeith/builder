---
name: spec
description: Write the feature's spec from a confirmed design conversation — reads the workspace record /builder:brainstorm or /builder:intake left (the intent, how it works today, every decision with its reasoning, the approaches, the size), presents the design section by section for approval with §Idea first (why, what success looks like, the owner's rules in their own words, the concept, how it fits today, the approaches considered), then writes SPEC.md + MANIFEST.md (or PROGRAM.md at xl), proves the obligations, commits, and hands on to /builder:resume. Also applies a brainstorm or intake revision to a spec that has no go-ahead yet. Use after a brainstorm or intake is sized md, lg or xl.
---

# `/builder:spec` — the confirmed concept, written down

Invocation: **`/builder:spec [--path <folder>] [--auto] [--help]`**.

**`--help` first.** If present, render the `builder:help` card and stop.

**Precondition:** `.builder/<feature>/brainstorm.md` with `status: sized md`, `sized lg` or
`sized xl` for new work — or, for a revision, `status: confirmed` (a revision conversation skips
§Size) with a live `SPEC.md` and no `go-ahead:` in its manifest. Otherwise say in one line what is
missing and name `/builder:brainstorm` or `/builder:intake`, and stop.

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

Pushback amends the record's tree first, then the section. Under `--auto` present and proceed.

## 2. Write the files

**`SPEC.md`** per REFERENCE §SPEC.md. md writes the sections its work touches — **§Idea, §Apps and
§Contract are never skipped**; lg writes them all. Every settled or confirmed branch becomes a
§Decisions row: an implementable ruling, its why in one line, the rejected option and why it lost —
copy the §Decisions comment block verbatim. Assumed branches the user never contested are rulings
too, marked `(assumed at brainstorm)` in Who/date. **An OPEN branch that reaches spec becomes an
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

**`MANIFEST.md`** per REFERENCE §MANIFEST.md: `size`, `state: spec`, `next:`, `head`, `ticket`,
`branch`, `pr: none`, **`apps:`** (the plus-joined in-scope apps), **`contract: open`** (or `none`
when no producer change), `hold: none`, `go-ahead`/`walk`/`verify: none`, the design key, `auto:`.
(A revision keeps the manifest it has and changes only what the amendment moves.)

**`--size xl`** writes `PROGRAM.md` per REFERENCE §PROGRAM.md instead — the children, their order
(🔴 ordered by the contract), the decisions they share — plus a program manifest; take the one program
go-ahead and stop.

## 3. Prove it, commit, hand on

```
node <builder>/scripts/check-obligations.mjs <folder>
```

Fix every FAIL; resolve every WARN or say why it stands. **Self-review** with fresh eyes: placeholder
scan; internal consistency (does §Testing cover every interface §Contract declares? does every ✅ in
§Apps have its section? does every "In your words" quote link to a real D#?); ambiguity — a ruling a
stranger could implement two ways is not written yet. Commit `docs(<ticket-or-feature>): design
<feature>`, set the record's `status: handed-off`.

Say what was written and where; **lead with the §Apps row**; list the OPEN decisions with their
recommendations; in prototype mode add the gap tally. Then:

```
📍 <feature>: designed (<size>, <apps>) — next: /builder:resume --path <registry>/<feature> · or say go
```
