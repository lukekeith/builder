---
name: brainstorm
description: The entry point for building anything — start here. Sizes the request first from recon (xs/sm are designed and built in chat with nothing under docs/; md/lg become a feature folder's SPEC.md + MANIFEST.md executed through the task loop; xl a PROGRAM.md of children), then runs the design conversation: recon the closest existing pattern in each affected app, settle which apps are in scope and what the shared contract is, grill one question at a time with a recommendation first, present the design in sections for approval, write the files, hand off to /builder:resume. With a design ref, a finished specced design is the requirements — every in-scope contract is compared against the app and each gap resolved one at a time. Also the revision conversation for an existing spec. Use when the user wants to build, add, change, design, spec or plan anything — a moved button or a new area.
---

# `/builder:brainstorm` — the entry: size it, design it, hand it on

Invocation: **`/builder:brainstorm [--path <folder>] [--size xs|sm|md|lg|xl] [--ticket <id>]
[--<design.flag> <ref>] [--all] [--auto] [--help] <what you want>`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

Output: `<registry>/<feature>/SPEC.md` + `MANIFEST.md` — or `PROGRAM.md` + a program manifest at
`--size xl`. **Load REFERENCE and `.claude/builder.md` before writing anything**: REFERENCE holds
every shape this step produces, the config holds every fact about this project, and this skill cites
both rather than restating either.

**`--help` first.** If present, render the `builder:help` card and stop — no recon, nothing written.

**Under `--auto`:** Phase 2's questions take their recommendation, recorded in §Decisions with
`auto (recommended) YYYY-MM-DD` as the decider; a prototype-mode gap takes its recommended option,
and a design change is never recommended as *fix it in the design*. Phase 3's design is still
presented section by section, but it proceeds rather than waiting. The human reads those rulings at
the go-ahead, which is where an autopilot run is checked.

**One entry for building anything, and most of it never reaches a doc.** The first thing this command
does is decide how heavy the work is (REFERENCE §Sizes): **xs and sm** are designed and built right
here (§Phase 1S); **md and lg** earn one write-once `SPEC.md` plus a ~12-line `MANIFEST.md`; **xl**
becomes a `PROGRAM.md`.

**Nothing here creates a branch, a worktree or a ticket, and nothing writes to the ticket system.**
Given `--ticket`, check that the current branch name carries the key and warn once if it does not —
and **read the dossier** when the config's `ticket.dossier` names one: a dossier recording a
confirmed blast radius is exactly the scope statement §Apps needs.

**The folder.** `--path` gives it. Without `--path`, derive a kebab-case name from the free text —
or, for a design ref with no free text, from the resolved item's name. Then **look for that name
under the config's `registry:`**. A `SPEC.md` or `MANIFEST.md` there **is** the folder, and the run
becomes the revision conversation below; a folder with **build state but no manifest** is a
pre-builder layout — hand it to `/builder:resume --path <folder>`, which offers the conversion, and
stop. Only when the folder holds neither is it new — confirm the derived name as part of the first
question.

**No `--path`, no free text and no design ref → the picker**, never an open "which feature?"
question. Run `node <builder>/scripts/list-features.mjs --json` and present ONE AskUserQuestion: one
option per in-flight feature or program (description = its `state` + `next`, and **"needs
conversion"** for a `convert: true` row), plus **New (describe it)**; shipped folders appear only as
a count.

⛔ **DONE is the first check:** a SPEC header carrying `SHIPPED`, or a README header opening
`SHIPPED` → run no step, print the header, and offer a new folder for follow-on work.

**An existing SPEC makes this a revision conversation.** Read it, say what exists, discuss. If the
manifest records a `go-ahead:`, settle the ruling here and let **`builder:revise`** apply it.

**This is a DIALOGUE, not a form.** The design is done when the human says it is.

## Phase 1 — Recon (before any question)

Find the **closest structural baseline already in the repo** and read it, instead of designing in the
abstract. 🔴 **Recon each affected app separately.** The config's `apps:` names them and its §House
rules says what each one's shape is; in a multi-app repo they usually share no code, so "the closest
existing pattern" is a different file in each. Spawn parallel Explore agents
(REFERENCE §Agent model tiering) and, per app, find:

- the nearest shipped example of this kind of work, at `file:line`;
- how it is wired — its entry point, its state, its tests;
- for the **producer**: how the contract is defined and where permission is checked;
- for a **consumer**: how it reads the producer's data and where that lands in its own state;
- for a **tool**: whether this surface exists in it today.

Plus, across all of them: **what already exists that must not be rebuilt** — the single most valuable
recon output, named with `file:line`. Check the component sources the config's §House rules and
§Design source name before inventing anything.

Then **classify from recon** (REFERENCE §The classifier). `--size` skips the classification but not
the announcement — **the size is stated with its evidence either way**, before anything is asked.
A verdict of **xs or sm goes to Phase 1S**; **lg is a prompt to split** — propose several features
now, before anything is built on one oversized spec; **xl** takes the program path in Phase 4.

🔴 **Question 4 is the one that bites.** Count the apps honestly from recon and from the config — a
change that crosses an app boundary is never sm, whatever it looks like, because the thing that
breaks is the contract between them.

**A feasibility question is a spike, not a build.** "Can we…", "is it possible…" → say so, answer it
as a question (read the code, run the experiment, report what you found) and do **not** wrap it in a
feature folder. A spike concluding "yes, and here's how" becomes a `/builder:brainstorm` run after.

**Prototype mode resolves the ref before sizing.** Run the config's `design.resolver` with
`--resolve "<ref>" --json`. Resolution and what it may ask:
[`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md). Size from the **whole resolved set**. A feature
whose manifest's design key already carries this ref IS the feature: hand it to
`/builder:resume --path <folder>` instead of designing it twice. A design still being specced is not
this command's work — `/builder:check --<design.flag> <ref>` is its pre-flight, and this command
takes it once that reports READY.

| Verdict | Where it goes |
|---|---|
| xs · sm | §Phase 1S — the chat path. Nothing under `docs/`; Phases 1P–5 do not run |
| md · lg | Phases 1P–5 → `SPEC.md` + `MANIFEST.md` → `/builder:resume --path <folder>` |
| xl | Phases 1P–5 with `--size xl` → `PROGRAM.md` + one program go-ahead |

## Phase 1S — xs/sm: the chat path

1. **Recon** — done in Phase 1: the app, the files, the nearest pattern to copy at `file:line`.
2. **Grill.** xs: 0–1 question. sm: at most 3, one per turn, recommendation first, explored before
   asked. Stop when the answers stop changing the design — **that cap is the whole stopping rule on
   this path**. **Prototype-mode sm** reads the design contract first; the design names what it
   implements.
3. **Design in chat.** xs: one sentence. sm: the app · approach · files touched · the recipe skills
   it will read · tests · what you will see in the running app.
4. **One approval.** Stop until yes. Presenting and starting in the same turn skips the gate.
5. **Implement in the main context.** Read the named recipe skills FIRST (the config's §Companion
   skills); TDD where behaviour changes; that app's §House rules and §Environment landmines.
   🔴 **In an app the config marks `commit: manual`, stage and stop** — that commit is the human's.
6. **Fast gates — the subset for that app that the diff can turn red, said out loud** (the config's
   §Quality gates). Report a delta where the config asks for one, never a green exit.
7. **The human's look at the running app** for anything visual — after REFERENCE §Walk readiness,
   so what they look at is running this change (a restart-class change is the usual xs/sm trap). Say what has and has not been
   human-checked; the PR lock holds in chat form.
8. **Resume.** An xs/sm fits one sitting by definition: the branch and `git log` carry it, and an
   interrupted one gets a three-line scratch note — what · where · next — never a doc.

```
📍 <the work>: <shipped | awaiting your look at the app> — next: <the command>
```

## Phase 1P — Prototype mode (a design ref only)

REFERENCE §Prototype mode steps 1–4 is the procedure; this is how to run it. Without a design ref,
skip this phase entirely.

**1. Resolve the ref — never from memory**, with the config's resolver.
[`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md) is the full procedure and the only thing that
decides what gets asked. **Under `--auto` an ambiguous ref without `--all` refuses to start.** Then
**echo the resolved scope as a tree before any other work**, naming what is NOT in scope and **which
items are not yet built**.

**2. Inventory the design.** Per in-scope item: its contract read **in full**, its designed states
and variant axes, its props, its tokens, its open questions, and whether it is built. Parallel
`sonnet` agents for a wide ref. The full inventory goes to the workspace; only the summary — items ·
states · open questions · unbuilt — reaches SPEC §Prototype. 🔴 **If the design system carries
owner notes, read them with whatever tool the config names** — never by eye, and never write one.

**3. Compare against reality — five axes**, parallel where it pays (`sonnet` sweeps, `opus`
verdicts):

| # | Axis | Where the result belongs |
|---|---|---|
| 1 | replaced surfaces ([`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md); an existing §Replaced surfaces re-verifies by fingerprint) | §Replaced surfaces: the table, then `S#`, then `N#`, each with its owning app |
| 2 | journey edges — ingress · egress · shared surfaces, **including deep links and anything that routes into this surface from outside** | 🔴 MISSING only → §Findings / §Decisions; the verified edges are said once in chat |
| 3 | component coverage — every element the contract names resolves to a real, existing component, and the legacy one it replaces is identified | a missing one is a **design-system** defect: route it, never invent inline |
| 4 | conventions — the config's §Design source, item by item | each miss is a gap |
| 5 | what the design persists — a **light** read; the full trace is align's | §Prototype seams; do not pre-empt align |

**4. Build ONE gap list**, across the whole scope rather than per item: the same defect at eight
sites is **one gap with its eight sites listed**. Order by blast radius — a missing capability or
architecture gap first, a convention miss next, copy and figures last. That list is Phase 2's agenda.

## Phase 2 — Grill, ONE question per turn (md/lg/xl only)

**AskUserQuestion**, recommendation first and marked.

**Keep a running list of open branches, and end Phase 2 when that list is empty** — not when new
answers stop changing the design, which stops a grill while a fork nobody ruled on is still open. A
**branch** is a choice with two or more defensible answers the build would otherwise re-litigate — a
data-model shape, an architecture fork, a lifecycle edge, a permission, where a surface lives,
**which app owns a capability**. A question recon already answered is not a branch: decide it and
record it. A branch **closes only when it is a §Decisions row** — ruled, or OPEN with a
recommendation for the decisions gate. The list lives in this conversation and in §Decisions, never
in a file of its own.

**The fundamentals to work.** Data-model shape (new model vs extension, scoping, what is sensitive);
the one or two **genuinely contested architecture choices** — 2–3 approaches with their trade-offs,
which is what the spec hangs on; lifecycle edges (soft delete, cascades, idempotence, timezones);
permissions (which roles, and what an unauthorized caller sees); UX placement per app.

🔴 **Four branches a multi-app repo always has, asked even when nobody raised them:**

1. **Which apps?** The §Apps table is a design decision, not a formality. Ask it early — it sets
   everything downstream — and check each ⬜ against what the config says that app is for.
2. **What does a RELEASED build see while this rolls out?** For every app the config marks
   `released_artifact: true`. Additive is safe; a rename or removal is not, and needs a stated
   transition. This is the branch whose wrong answer ships.
3. **Where does the capability live when the app is closed?** The N1 question — state that persists
   without being a field is what a field-by-field harvest walks past.
4. **Do all the consumers need it, or only one?** Consumers diverge deliberately more often than not;
   a divergence nobody wrote down becomes a parity bug report.

**In prototype mode the gap list IS the grill.** One gap per turn, offering REFERENCE §Prototype
mode's three options with the recommendation marked. Each gap closes on its **recorded disposition**:
*fixed in the design* leaves no row and routes to the command the config's `design.owned_by` names,
whose output this run re-reads before the next gap; *written into the SPEC* lands as an `N#` with its
`T#`/`SC#` rows, a §Findings row, or a §Decisions ruling; *out of scope* lands as a §Out of scope
line with the decider. 🔴 **This step never edits the design itself.**

## Phase 3 — Present the design, then approval

The full design in SPEC section order, each section scaled to its complexity; invite per-section
pushback; revise until approved. **Lead with §Apps and §Contract** — they are what the reader needs
to judge blast radius. **YAGNI ruthlessly** — cuts go to §Out of scope, where they stay visible.

## Phase 4 — Write the files

**`SPEC.md`** per REFERENCE §SPEC.md. md writes only the sections its work touches — **except §Apps
and §Contract, which are never skipped** in a multi-app repo; lg writes them all. Copy the §Decisions
comment block verbatim and write every ruling the way it demands — implementable, scoped, the
rejected alternative named, "etc." expanded, **never a quote of the user's prompt**. Verify that
every component the per-app sections name exists NOW and that its interface fits; a missing one is a
**(new)** row, and say plainly that approving the spec approves building it. Prototype mode adds
**§Prototype** and **§Replaced surfaces**. Target ≤ 300 lines.

**Then prove the obligations rather than trusting them**, and fix what it names before handing off:

```
node <builder>/scripts/check-obligations.mjs <folder>
```

**`MANIFEST.md`** per REFERENCE §MANIFEST.md: `size`, `state: spec`, `next:`, `head`, `ticket`,
`branch`, `pr: none`, **`apps:`** (the plus-joined in-scope apps), **`contract: open`** (or `none`
when no producer change), `hold: none`, `go-ahead`/`walk`/`verify: none`, the design key, `auto:`.

**`--size xl` stops here instead.** Write `PROGRAM.md` per REFERENCE §PROGRAM.md — the children,
their order (🔴 **ordered by the contract**), the decisions they share — plus a program manifest.
Take the one program go-ahead and stop.

**Self-review with fresh eyes** before committing: placeholder scan; internal consistency (does
§Testing cover every interface §Contract declares? does every ✅ in §Apps have its section?); scope
check; ambiguity check — a ruling a stranger could implement two ways is not written yet. Fix inline,
then commit `docs(<ticket-or-feature>): design <feature>`.

## Phase 5 — Hand off

Say what was written and where; **lead with the §Apps row**, because that is the blast radius; list
the OPEN decisions with their recommendations; in prototype mode add the gap tally — **fixed in the
design · written into the SPEC · out of scope** — and which items are not yet built. Say that the
audit re-verifies the spec against the codebase, so it has to be complete enough to audit, not
perfect. Then:

```
/builder:resume --path <registry>/<feature>     ← align (prototype mode) or audit (next step)
```

Every pause ends with the one-line resume footer:

```
📍 <feature>: spec drafting — resume with /builder:brainstorm --path <registry>/<feature> · or say go
📍 <feature>: designed (<size>, <apps>) — next: /builder:resume --path <registry>/<feature> · or say go
```

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
