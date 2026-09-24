---
name: brainstorm
description: The entry point for building anything in MakeReady — start here. Sizes the request first from recon (xs/sm are designed and built in chat with nothing under docs/; md/lg become docs/features/<feature>/SPEC.md + MANIFEST.md executed through subagent-driven-development; xl a PROGRAM.md of children), then runs the design conversation: recon the closest existing pattern in each affected app, settle which of the four apps are in scope and what the shared API contract is, grill one question at a time with a recommendation first, present the design in sections for approval, write the files, hand off to /builder:resume. With --ui2 <ref> a specced UI 2.0 component set is the requirements — every in-scope contract is compared against the app and each gap resolved one at a time. Also the revision conversation for an existing spec. Use when the user wants to build, add, change, design, spec or plan anything — a moved button or a new area.
---

# `/builder:brainstorm` — the entry: size it, design it, hand it on

Invocation: **`/builder:brainstorm [--path <folder>] [--size xs|sm|md|lg|xl] [--ticket <monday id>]
[--ui2 <ref>] [--all] [--auto] [--help] <what you want>`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

Output: `docs/features/<feature>/SPEC.md` + `MANIFEST.md` (REFERENCE §SPEC.md, §MANIFEST.md) — or
`PROGRAM.md` + a program manifest at `--size xl`. **Load REFERENCE before writing anything**: it holds
every shape this step produces, and this skill cites it rather than restating it.

**Under `--auto`** (REFERENCE §Flags): Phase 2's questions take their recommendation, recorded in
§Decisions with `auto (recommended) YYYY-MM-DD` as the decider; a prototype-mode gap takes its
recommended option, and a design change is never recommended as *fix it in the design*. Phase 3's design
is still presented section by section, but it proceeds rather than waiting. The human reads those
rulings at the go-ahead gate, which is where an autopilot run is checked.

**`--help` first.** If it is present, render the `builder:help` card
(`plugins/builder/skills/help/SKILL.md`) and stop — no recon, nothing written.

**One entry for building anything, and most of it never reaches a doc.** The first thing this command
does is decide how heavy the work is (REFERENCE §Sizes): **xs and sm** are designed and built right
here, in chat, and write nothing under `docs/` (§Phase 1S); **md and lg** earn one write-once `SPEC.md`
plus a ~12-line `MANIFEST.md` and hand off to `/builder:resume` for the pipeline; **xl** becomes a
`PROGRAM.md` whose children each run it.

**Nothing here creates a branch, a worktree or a ticket, and nothing writes to monday.com**
(REFERENCE §Branch and ticket). Given `--ticket`, check that the current branch name carries the key and
warn once if it does not — and **read `docs/monday/tickets/<id>.md` if it exists**: a dossier's
confirmed affected-areas contract is exactly the scope statement §Apps needs, so a ticket with a dossier
starts from a settled blast radius rather than re-deriving one.

**The folder.** `--path` gives it. Without `--path`, derive a kebab-case name from the free text — or,
for a `--ui2` ref with no free text, from the resolved component or screen name (`C-034 SearchField` →
`search-field`; screen `home-dashboard` → `home-dashboard`). Then **look for that name under
`docs/features/`** before a fresh design. A `SPEC.md` or `MANIFEST.md` there **is** the folder, and the
run becomes the revision conversation below; a **numbered `/build-spec` suite** there is a pre-builder
folder — hand it to `/builder:resume --path <folder>`, which offers the conversion, and stop. Only when
the folder holds neither is it new — confirm the derived name as part of the first question.

**No `--path`, no free text and no `--ui2` ref → the picker**, never an open "which feature?" question.
Run `node .claude/scripts/list-feature-specs.mjs --json` and present ONE AskUserQuestion: one option per
in-flight feature or program (description = its `state` + `next`, and **"needs conversion"** for a
`convert: true` row), plus **New (describe it)**; shipped folders appear only as a count. On a
selection, continue as if invoked with that entry's `path`.

⛔ **DONE is the first check** (REFERENCE §Condense, state detection): a SPEC header carrying `SHIPPED`,
or a `README.md` whose `**Status:**` line opens `SHIPPED` → run no step, print the header, and offer a
new folder for follow-on work.

**An existing SPEC makes this a revision conversation.** Read it, say what exists, discuss. If the
manifest records a `go-ahead:`, settle the ruling here and let **`builder:revise`** apply it — after the
build starts the default is a code fix plus at most one doc line, never a spec rewrite.

**This is a DIALOGUE, not a form.** The design is done when the human says it is.

## Phase 1 — Recon (before any question)

Find the **closest structural baseline already in the repo** and read it, instead of designing in the
abstract. 🔴 **Recon each affected app separately** — this is a four-app monorepo and its apps share no
code, so "the closest existing pattern" is a different file in each one. Spawn parallel Explore agents
(REFERENCE §Agent model tiering) to map:

| App | What to find |
|---|---|
| **server** | the nearest shipped domain: its `src/routes/<x>.ts` module, its `src/services/<x>Service.ts`, its `server/schema/*.yaml` rows, how it checks org permission, and which external service it talks to |
| **client** | the nearest existing page: its `web.php` route, its Blade view, the island mounted into it, the Pinia store behind it, and whether it goes through the `/admin/api` proxy |
| **iphone** | the nearest existing screen: its `Pages/` file, the `Route` case that presents it, the `AppState` entities it reads, the Actions that mutate them, and its offline behaviour |
| **capture** | whether the surface has a `/compare` comparison, a twin and a fixture today |

Plus, across all four: **what already exists that must not be rebuilt** — the single most valuable
recon output, named with `file:line`. In this repo that is usually a component: check
`iphone/MakeReady/Components/` (123 components; `CARD_ARCHITECTURE.md` for the card system),
`client/ui/`, and the **UI 2.0 registry** `docs/ui2/design-system/registry.md`, which is the 2.0
component universe and may already carry a row for what you were about to invent.

Then **classify from recon** (REFERENCE §The classifier). `--size` skips the classification but not the
announcement — **the size is stated with its evidence either way**, before anything is asked, and
classification ratchets up only. A verdict of **xs or sm goes to Phase 1S** and this skill ends there. A
verdict of **lg is a prompt to split**: propose several features now, before anything is built on one
oversized spec; xl takes the program path in Phase 4.

🔴 **The classifier's question 4 is the one that bites here.** Count the apps honestly, from recon and
from the root `CLAUDE.md` §Cross-App Impact Guide — a change that crosses an app boundary is never sm,
whatever it looks like, because the thing that breaks is the contract between them.

**Prototype mode resolves the ref before sizing.** Run

```
node .claude/scripts/list-ui2-refs.mjs --resolve "<ref>" --json
```

Resolution and what it may ask: [`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md). Size from the
**whole resolved set** — a screen ref is never sm; a single component ref can be. A feature whose
manifest `ui2:` line already carries this ref IS the feature: hand it to
`/builder:resume --path <folder>` instead of designing it twice. A design still being specced is not
this command's work — `/ui2-component` writes the contract and `/builder:check --ui2 <ref>` is the
pre-flight; this command takes it once that pre-flight reports READY.

**The classifier's questions** are REFERENCE §The classifier. A feasibility question ("can we…", "is it
possible…") is a spike, not a build: say so and hand it to `superpowers:brainstorming`. **Announce the
verdict with its evidence, in one line** — "existing admin island, no schema, no new endpoint, client
only, ~8 files — calling this sm; say md if you want a spec." In doubt, the heavier size.

| Verdict | Where it goes |
|---|---|
| xs · sm | §Phase 1S — the chat path. Nothing is written under `docs/`; Phases 1P–5 do not run |
| md · lg | Phases 1P–5 below → `SPEC.md` + `MANIFEST.md` → `/builder:resume --path <folder>` |
| xl | Phases 1P–5 with `--size xl` → `PROGRAM.md` + one program go-ahead → `/builder:resume` |

## Phase 1S — xs/sm: the chat path

The bounded design conversation with MakeReady's rules on it — this skill **is** that path; it does not
also invoke a brainstorming skill on top.

1. **Recon** — done in Phase 1: the app, the files, the store, the component, and the nearest pattern to
   copy at `file:line`.
2. **Grill.** xs: 0–1 question. sm: at most 3, one per turn, recommendation first, explored before
   asked. Stop when the answers stop changing the design — **that cap is the whole stopping rule on this
   path**; Phase 2's open-branches list is md/lg/xl only. **Prototype-mode sm** reads the component's
   contract and its frozen snapshot first — that is the design reference, and the design names the
   `C-###` row it implements.
3. **Design in chat.** xs: one sentence. sm: the app · approach · files touched · the recipe skills it
   will read · tests · what you will see in the running app.
4. **One approval.** Stop until yes. Presenting and starting in the same turn skips the gate.
5. **Implement in the main context.** Read the named recipe skills FIRST (REFERENCE §Companion skills);
   TDD where behaviour changes; the house rules of that app (REFERENCE §House rules) — and
   `docker restart makeready-server` after any `server/src` edit; conventional commits carrying the
   `--ticket` key when one was given.
   🔴 **An iPhone commit is an explicit user call**, at this size too.
6. **Fast gates — the subset for that app that the diff can turn red, said out loud**
   (REFERENCE §Quality gates). Report the `client: npm run guard` **delta**, never a green exit.
7. **The human's look at the running app** for anything visual. Say what has and has not been
   human-checked. The PR lock holds in chat form (`builder:resume` §The PR lock): the PR only after the
   human says it works.
8. **Resume.** An xs/sm fits one sitting by definition (classifier rule 5): the branch and `git log`
   carry it, and an interrupted one gets a three-line scratch note — what · where · next — never a doc.

```
📍 <the work>: <shipped | awaiting your look at the app> — next: <the command>
```

## Phase 1P — Prototype mode (`--ui2 <ref>` only)

REFERENCE §Prototype mode steps 1–4 is the procedure; this is how to run it. Without `--ui2`, skip this
phase entirely.

**1. Resolve the ref — never from memory**, with the command above.
[`SCOPE-SELECTION.md`](../resume/SCOPE-SELECTION.md) is the full procedure and the only thing that
decides what gets asked: exit 3 / `ambiguous: true` → ask which row; exit 4 → not found, and the
candidates printed on stderr are what to offer. Everything else asks nothing — a ref means everything
beneath it. **Under `--auto` an ambiguous ref without `--all` refuses to start**: print the resolution
and the literal invocations. Then **echo the resolved scope as a tree before any other work**, naming
what is NOT in scope and **which rows are not yet built as previews**, and classify the size from the
whole set.

**2. Inventory the design.** For every in-scope row: its contract file read **in full**, its designed
states and variant axes, its props, its tokens, its `OQ-` open questions, its fixture and its preview.
Parallel `sonnet` agents, one per row, for a wide screen ref. The full inventory goes to the SDD
workspace (`.claude/scripts/build-spec-workspace.sh <feature>` prints it; git-ignored); only the
summary — rows · states · open questions · unbuilt — reaches SPEC §Prototype.

🔴 **Read the notes, and read them with the tool.** A row's notes are normative build input:
`node capture/lib/ui2-notes.mjs read` — never by eye, and never write one.

**3. Compare against reality — five axes**, parallel where it pays (`sonnet` sweeps, `opus` verdicts):

| # | Axis | How | Where the result belongs |
|---|---|---|---|
| 1 | replaced surfaces | [`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md); an existing §Replaced surfaces re-verifies by fingerprint instead of rediscovering | §Replaced surfaces: the table, then `S#`, then `N#`, each with its owning app |
| 2 | journey edges | the three edge sets — ingress · egress · shared surfaces — each classified. **Include push deep links and invite URLs**: a `Route` case behind a push payload has to keep existing | 🔴 MISSING only → §Findings / §Decisions; the verified edges are said once in chat |
| 3 | component coverage | every element the contract names resolves to a registry row, and the legacy component it replaces is identified in `iphone/MakeReady/Components/` or `client/ui/` | a missing row is a **registry** defect — route it, never invent inline |
| 4 | conventions | REFERENCE §Prototype conventions, item by item | each miss is a gap |
| 5 | what the design persists | a **light** read of the fields and seams — the full Prisma → zod → wire → endpoint → AppState trace belongs to `builder:align`, after this step | §Prototype seams; do not pre-empt align |

**4. Build ONE gap list**, across the whole scope rather than per row: the same defect at eight sites is
**one gap with its eight sites listed**. Order by blast radius — a missing capability or architecture
gap first, a convention miss next, copy and figures last (REFERENCE §Standing traps: structure over
content). That list is Phase 2's agenda.

## Phase 2 — Grill, ONE question per turn (md/lg/xl only)

**AskUserQuestion**, recommendation first and marked.

**Keep a running list of open branches, and end Phase 2 when that list is empty** — not when new answers
stop changing the design, which stops a grill while a fork nobody ruled on is still open. A **branch** is
a choice with two or more defensible answers that the build would otherwise re-litigate — a data-model
shape, an architecture fork, a lifecycle edge, a permission, where a surface lives, **which app owns a
capability**. A question recon already answered, or that has one defensible answer, is not a branch:
decide it and record it. Every question the grill surfaces and everything the human raises goes on the
list, including the branches an answer opens; a branch **closes only when it is a §Decisions row** —
ruled, or OPEN with a recommendation for the decisions gate. The list lives in this conversation and in
the draft's §Decisions, never in a file of its own.

**`--auto`** closes each open branch as the header note above specifies, so the list empties without the
human — who reads those rulings at the go-ahead.

**The fundamentals to work.** Data-model shape (new Prisma model vs extension, org scoping, what is
sensitive and must go through encryption); the one or two **genuinely contested architecture choices** —
2–3 approaches with their trade-offs, which is what the spec hangs on; lifecycle edges (soft delete,
cascades, idempotence, timezones); permissions (which of the five roles, and what an unauthorized caller
sees); UX placement per app (nav home, page vs overlay, loading / empty / error states).

🔴 **Four branches this monorepo always has, and they are asked even when nobody raised them:**

1. **Which apps?** The §Apps table is a design decision, not a formality. Ask it early — it sets
   everything downstream — and check each ⬜ against the root `CLAUDE.md` §Cross-App Impact Guide.
2. **What does a SHIPPED iPhone build see while this rolls out?** An additive field is safe; a renamed
   or removed one is not, and needs a stated transition. This is the branch whose wrong answer ships.
3. **Where does the capability live when the app is closed?** The N1 question (REFERENCE §Standing
   traps) — state that persists without being a field is what a field-by-field harvest walks past.
4. **Does the client need it too, or is this leader-only on iPhone?** The two consumers diverge
   deliberately more often than not; a divergence nobody wrote down becomes a parity bug report.

**In prototype mode the gap list IS the grill.** One gap per turn, offering the three options of
REFERENCE §Prototype mode — *fix it in the design* · *write it into the SPEC* · *out of scope* — with
the recommendation marked. Each gap is a branch, and it closes on its **recorded disposition**: *fixed
in the design* leaves no row at all and routes to `/ui2-component-update` or `/ui2-resolve`, whose
output this run re-reads before the next gap; *written into the SPEC* lands as an `N#` add with its
`T#`/`SC#` rows, a §Findings row, or — only for a deliberate divergence from the live surface — a
§Decisions ruling; *out of scope* lands as a §Out of scope line with the decider.

🔴 **This step never edits a UI 2.0 contract, registry row or note itself.** It routes the gap and reads
the result. Anything the design cannot show — a retirement, a persistence seam, a contested architecture
choice — enters the gap list as an ordinary gap rather than a separate interview.

## Phase 3 — Present the design, then approval

The full design in SPEC section order, each section scaled to its complexity; invite per-section
pushback; revise until approved. **Lead with §Apps and §Contract** — they are what the reader needs to
judge blast radius, and everything else follows from them. **YAGNI ruthlessly** — cuts go to §Out of
scope, where they stay visible.

## Phase 4 — Write the files

**`SPEC.md`** per REFERENCE §SPEC.md. md writes only the sections its work touches — **except §Apps and
§Contract, which are never skipped**; lg writes them all. Copy the §Decisions comment block verbatim and
write every ruling the way it demands — implementable, scoped, the rejected alternative named, "etc."
expanded, **never a quote of the user's prompt**; a genuinely open question is an OPEN row. Verify that
every component the §Client and §iPhone maps name exists NOW and that its props fit; a missing one is a
**(new)** row, and say plainly that approving the spec approves building it. Prototype mode adds
**§Prototype** and **§Replaced surfaces**. Target ≤ 300 lines — a longer SPEC is usually two features.

**Then prove the obligations rather than trusting them**, and fix what it names before handing off:

```
node .claude/scripts/check-flow-obligations.mjs <folder>
```

**`MANIFEST.md`** per REFERENCE §MANIFEST.md: `size`, `state: spec`,
`next: /builder:resume --path docs/features/<feature>`, `head` (the sha at this transition), `ticket`
(from `--ticket`, else `none`), `branch`, `pr: none`, **`apps:`** (the plus-joined in-scope apps from
§Apps), **`contract: open`**, `hold: none`, `go-ahead` / `walk` / `verify: none`, `ui2:` (the resolved
ref and its rows, else `none`), `auto:`.

**`--size xl` stops here instead.** Write `PROGRAM.md` per REFERENCE §PROGRAM.md — the children, their
order (🔴 **ordered by the contract**: a child that produces a contract another consumes ships first),
the decisions they share — plus a program manifest (`tier: program`,
`next: /builder:resume --path docs/features/<program>`, one `child: <name> — spec` line per child, and
**no `state:` line**). Take the one program go-ahead and stop.

**Self-review with fresh eyes** before committing: placeholder scan; internal consistency (does §Testing
cover every endpoint §Contract declares? does every ✅ in §Apps have its section?); scope check;
ambiguity check — a ruling a stranger could implement two ways is not written yet. Fix inline, then
commit `docs(<ticket-or-feature>): design <feature>`.

## Phase 5 — Hand off

Say what was written and where; **lead with the §Apps row** ("server + iphone; client and capture out of
scope because …"), because that is the blast radius; list the OPEN decisions with their recommendations;
in prototype mode add the gap tally — **fixed in the design · written into the SPEC · out of scope** —
and which rows are not yet built as previews. Say that the audit re-verifies the spec against the four
codebases, so it has to be complete enough to audit, not perfect. Then:

```
/builder:resume --path docs/features/<feature>     ← align (prototype mode) or audit (next step)
```

The conversation is resumable — the draft is its own working notes. Every pause ends with the one-line
resume footer:

Mid-conversation:

```
📍 <feature>: spec drafting — resume with /builder:brainstorm --path docs/features/<feature>
```

Once the files are written:

```
📍 <feature>: designed (<size>, <apps>) — next: /builder:resume --path docs/features/<feature>
```
