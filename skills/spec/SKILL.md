---
name: spec
description: Write the feature's spec from a confirmed design conversation — reads the workspace record /builder:brainstorm or /builder:intake left (the intent, how it works today, every decision with its reasoning, the approaches, the size), asks only the product choices the conversation left open (each as a real decision with its alternatives, never a section approval), records implementation details as assumed, then writes SPEC.md (§Idea first: why, what success looks like, the owner's rules in their own words, the concept, how it fits today, the approaches considered) + MANIFEST.md (or PROGRAM.md at xl), proves the obligations, commits, and hands on to /builder:resume. Also applies a brainstorm revision to a spec that has no go-ahead yet. Use after a brainstorm or intake is sized md, lg or xl.
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

## 1. Settle what the record left open — no section approvals

🔴 **The owner already approved the design** — at the brainstorm's §Confirm (or intake's). Never
present the spec section by section for approval, and never ask "Right?" about a section: an
approval of a summary the owner can't evaluate protects nothing and costs a stop.

Draft every section in your head from the record first (SPEC order: §Idea · §Apps and §Contract · the
per-app sections · §Schema & API changes · §Testing · §Out of scope; in prototype mode §Prototype and
§Replaced surfaces from the intake findings). Then list **every choice the draft makes that the
record's tree never ruled on** — a scope line, a behaviour, what an AI or another app may see or do,
what is stored, kept or lost — and sort each one:

- **A product choice** — it changes what the owner sees or can do, what data is kept, overwritten or
  lost, what an agent or AI may read or change, something made visible or irreversible, or a shape a
  released consumer depends on. **Ask it** before writing, as its own question in
  `/builder:brainstorm`'s §Rounds format: the briefing in chat (`**Q<n> — <the decision>**`, the
  question in one plain sentence, **Why it matters**, **What it affects**, **Recommendation** with its
  evidence), then one AskUserQuestion whose options are the real alternatives — the recommendation
  first, each option's description saying what picking it does. 🔴 **Never "Right / Change
  something"** — that is an approval, and this is a decision. Record the answer in the record's tree
  (Who/date the owner) and carry on. The owner's own words in the record already answering it → it was
  settled: no question.
- **An implementation detail** — how it is stored, a limit, an error code, a field's type, which
  internal module owns what. **Don't ask.** Write it as a §Decisions row marked
  `(assumed at spec) YYYY-MM-DD`, and list it in the closing summary.

Nothing open → no question at all; write the files. Pushback at any point amends the record's tree
first, then the spec. Under `--auto` every product choice takes its recommendation, recorded
`auto (recommended) YYYY-MM-DD`.

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

**Close with one plain summary — and no question.** Where it was written; **what it does**, in two
to four plain sentences for the owner (what they'll be able to do, not tables or field lists);
**what it touches**, from §Apps; **the choices you settled with them** in step 1, one line each;
**the details assumed at spec**, one line each, so a wrong one is easy to spot; the OPEN decisions
with their recommendations, if any; in prototype mode the gap tally in its three buckets —
fixed in the design · written into the SPEC · out of scope — and which items are not yet built. End the
summary with `Anything wrong? Just say what — it's revised before anything is built.` Then:

```
📍 <feature>: designed (<size>, <apps>) — next:
   1. resume — continue here, step by step: /builder:resume --path <registry>/<feature>
   2. agent  — hand it to agents to finish and merge: /builder:agent --path <registry>/<feature>
   3. here   — audit and plan it, then build it in this session without the ceremony: /builder:resume --path <registry>/<feature> --here
   Reply 1, 2 or 3 (or "resume" / "agent" / "here"; "go" is 1)
```

The numbered form is REFERENCE §The two-way footer (`../resume/REFERENCE.md`); without a config
`agent_walk:` block there is no **agent** option, so **here** is `2.` and the reply line reads
`Reply 1 or 2 (or "resume" / "here"; "go" is 1)`.
