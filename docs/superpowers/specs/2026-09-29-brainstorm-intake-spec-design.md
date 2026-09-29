# Brainstorm, intake and spec — design

**Date:** 2026-09-29 · **Target release:** 4.0.0 (major — brainstorm's behaviour and inputs change; prototype mode moves to a new command) · **Status:** design approved in chat, awaiting spec review

## Why

Feedback on builder: it is not helpful in in-depth brainstorming — exploring the codebase and
understanding high-level ideas. Superpowers' brainstorming and grill-me do this well. Research into
the three skills and into the specs each produced in the same repos (d2m, fai-cd) found why:

- `/builder:brainstorm` is a **router to a build**, not an understanding tool: it sizes first ("recon
  before any question", size announced "before anything is asked"), never discovers or plays back
  intent, asks one 2–4-option picker question per turn, stops at build-relevant forks ("a question
  recon already answered is not a branch: decide it and record it"; xs/sm capped at 3 questions),
  keeps recon internal, and presents the design as SPEC sections led by §Apps and §Contract.
- Machinery precedes conversation: the 716-line REFERENCE, the config, flags, the folder, the picker
  and sizing all load before the first real question.
- Builder specs don't explain the idea: 0/23 open with a Why/Problem/Concept section (superpowers 39/48),
  0/23 have a diagram (12/48), 1/23 quote the owner (13/48), 52–60% of words sit in tables (15%), and
  56% of `Rejected:` clauses carry no reason — by rule: "Record the DECISION, not the conversation",
  "NEVER quote the user's prompt".

**Goal:** a robust layer of exploration in builder, a separate path for verifying a worked-out
document against reality, and specs that keep the idea and its reasoning — without changing the
build pipeline downstream of the spec.

**Success looks like:** a person can explore an idea with builder without committing to build it; a
worked-out doc is verified claim by claim against the code before a spec is written; every new SPEC
opens with why, the concept, the approaches considered and the owner's rules in their own words.

## Decisions (from the design conversation)

| # | Decision | Ruling | Why |
|---|---|---|---|
| 1 | How questioning depth adapts | **No fixed paths.** The input is mapped into a decision tree; depth falls out of how many branches it leaves open. The skill says what it is doing ("your brief settles 9 of 12"). | Rejected: agent-picked fixed paths (still a fixed set), user-picked mode (a decision before any conversation). |
| 2 | Question format | **Mixed.** Numbered plain-text rounds (grill-me format, recommendation per question) by default; the AskUserQuestion picker only when a round is all quick closed choices. | Pickers cap each question at 2–4 short options — part of why builder feels shallow. |
| 3 | Where sizing happens | **After the concept is confirmed**, as the last phase of the conversation — not a separate command. | Size depends on the chosen approach; a separate command adds a handoff without a decision. |
| 4 | Where the tree lives | **A workspace file**, `.builder/<feature>/brainstorm.md`, git-ignored, rewritten each round. | Survives `/clear` and compaction; no half-written SPEC in git; the direct source of §Idea. |
| 5 | Skill structure | **Split conversation from spec writing**: `/builder:brainstorm` and `/builder:intake` converse; a new `/builder:spec` writes. | Separation of responsibilities; brainstorm's context is freed of spec machinery. |
| 6 | Exploration need not end in a build | After confirm: build, park, or stop at understanding. | Some sessions end in "now I get it" or "not worth it". |
| 7 | Code exploration | Recon is narrated to the user, and "explain X" is available at any point; sub-agents fetch facts without blocking the rest of a round. | The feedback is about understanding the codebase, not only designing against it. |
| 8 | Reasoning survives the handoff | The tree records each ruling's why and each rejected option's reason; §Idea quotes the owner. | Otherwise specs come out thin again. |
| 9 | Concrete input | **A new entry, `/builder:intake`**, verifies a worked-out doc / ticket / design ref against the code. Prototype mode moves into it. | Different goal from exploring: the doc is the authority; the job is confirmed / contradicted / gaps. |

## Architecture

```
  abstract idea / request           worked-out doc · ticket · design ref
            │                                       │
   /builder:brainstorm                       /builder:intake
   intent → how it works today →             extract claims → verify each
   rounds → approaches → confirm             against code → gaps → rounds
            │                                       │    (contradictions + gaps only)
            └──────────── .builder/<feature>/brainstorm.md ────────────┘
                                    │ confirm → size
                     xs/sm ─────────┼───────── md · lg · xl
          short design in chat,     │          /builder:spec
          one approval, build       │          sectioned design → SPEC.md (§Idea first)
          (inside brainstorm/intake)│          + MANIFEST.md | PROGRAM.md
                                    ▼
                         /builder:resume → align/audit → plan → build   (unchanged)
                         park → status: parked (+ NOTES.md with --keep)
```

Three skills, one contract between them (`brainstorm.md`). Nothing downstream of `SPEC.md` changes.

## `/builder:brainstorm` — the exploration conversation

Loads only what the conversation needs (the config's apps and house-rule sources); REFERENCE and the
spec formats load in `/builder:spec`.

**Opening (one turn).** Read the input and classify what kind it is (abstract idea · directed
request · brief · spec · design ref). Map it into the tree, marking what it already settles, and say
the depth plainly. Play back the intent — outcome, who it's for, what success looks like — with what
the user said separated from what is assumed, and invite correction. Recon starts in parallel and
never blocks the first reply. A substantial worked-out document or a design ref gets the offer:
"This reads like a worked-out spec — want me to verify it with `/builder:intake` instead?"

**How it works today.** After intent is confirmed: a plain-language walk-through of what the idea
touches, with a small diagram when there are several moving parts, scaled to the input (a paragraph
for a directed request, a real walk-through for an abstract idea). Then on demand: "explain X",
"what would this touch?", "show me the data flow" at any point dispatches a sub-agent and reports in
plain words; the result is kept under *Explained on request*.

**Rounds.**
- Each round asks the whole **frontier**: every open branch whose prerequisites are settled. A
  question depending on another open question waits for a later round.
- Numbered, context per question, recommendation marked ➡️. A round of only quick closed choices
  uses the picker.
- Facts are never asked of the user: a sub-agent looks them up; only questions downstream of that
  lookup wait.
- A branch recon settled is **stated as an assumption** in the round ("Assumed B5: reuse `Toaster` —
  AppShell mounts it; say if not"), never decided silently.
- Branches come from the input first. The four multi-app branches (which apps; what a released build
  sees during rollout; where the capability lives when the app is closed; do all consumers need it)
  join the tree only when more than one app is plausibly involved.
- The user steers at any time: "go deeper on X", "skip that, use your recs", "that's enough".

**Approaches.** Only when the tree holds a real fork (two or more viable designs that shape the rest):
2–3 approaches with trade-offs and what each makes harder later, the recommendation first. The chosen
one becomes a settled branch; the others go to *Rejected* with their reasons.

**Confirm.** "Here's the shared understanding — intent, approach, N decisions. Anything missing or
wrong?" Nothing leaves the workspace before a yes. Then the user picks: **build** (→ size), **park**
(`status: parked`; `--keep` also writes `<registry>/<feature>/NOTES.md`, a summary of Intent, How it
works today and the Tree, which `list-features` reads as the existing *analysis* layout), or **stop at
understanding**.

**Size.** REFERENCE §The classifier, run on the settled concept, announced with evidence; the user
confirms or overrides; lg is offered a split. **xs/sm** continue in this skill as today's §Phase 1S
minus its grill step (short design in chat, one approval, implement, fast gates, the human's look).
**md/lg/xl** set `status: sized <size>` and hand off to `/builder:spec`.

**`--auto`.** Intent is played back as assumptions; each round takes its recommendations, recorded
`auto (recommended) YYYY-MM-DD`; the recommended approach is chosen; sizing and hand-off proceed
without waiting. The human sees the assumptions and every auto ruling at the go-ahead.

**Existing folder.** A live `SPEC.md` makes the run a revision conversation: the tree is seeded from
the SPEC, and the result goes to `/builder:spec` (before a go-ahead) or `/builder:revise` (after).
The archived-name refusal, the picker with no input, and the DONE check are kept.

## `/builder:intake <doc | ticket | design ref>` — verify a worked-out input

1. **Extract** what the input states — decisions, architecture, requirements, constraints — into the
   tree as `stated` branches. A design ref is resolved with the config's `design.resolver` exactly as
   prototype mode does today (SCOPE-SELECTION.md), and its inventory feeds the same tree.
2. **Verify** each claim against the code with parallel sub-agents: **confirmed** (with `file:line`
   evidence), **contradicted** (what the code actually does), or **unverifiable** (needs running code
   or a person).
3. **Find gaps** — branches the input never decides but the build will meet — using the audit's
   adversarial categories: uncovered states (empty, refused, done, legacy), unlisted callers and
   consumers, what a released build sees during rollout. For a design ref, prototype mode's five
   axes (replaced surfaces, journey edges, component coverage, conventions, persistence) are the gap
   hunt, and each gap offers its three dispositions (fix in the design · write into the SPEC · out of
   scope).
4. **Report, then ask only about contradictions and gaps**, in the same round format. Confirmed
   claims are reported ("14 of 19 claims confirmed — list"), not asked.
5. **Confirm, size, hand off** exactly as brainstorm does, with `input:` naming the source.

Prototype mode (REFERENCE §Prototype mode, brainstorm Phase 1P) moves here; brainstorm no longer
takes a design flag. Follow-on (out of scope here): the audit could treat intake's confirmed claims
as already verified.

## `.builder/<feature>/brainstorm.md` — the hand-off file

Rewritten after every round; the one record brainstorm and intake write and spec reads.

```markdown
# <feature> — brainstorm
status: exploring | confirmed | sized <xs|sm|md|lg|xl> | parked | handed-off
source: brainstorm | intake
input: abstract idea | directed request | brief | spec | design ref <ref>
updated: <ISO timestamp>
settled: <n> of <m>

## Intent
Outcome · who it's for · what success looks like        (marked "(assumed)" until confirmed)
In your words: "<the user's key rules, verbatim>"
Assumed (not yet confirmed): …

## How it works today
<prose; ASCII or mermaid diagram when useful; file:line only as footnotes>
Explained on request: <topic> — <summary>

## Tree
| # | Branch | Depends on | Status | Ruling | Why | Rejected (and why) | Evidence |
Status: open · settled · assumed · stated · confirmed · contradicted · unverifiable
Frontier: <branch ids>
Waiting on facts: <branch id> (<what the sub-agent is checking>)

## Approaches
<chosen: … — trade-offs> · <rejected: … — because …>

## Size
<size> — evidence: …
```

- `/builder:brainstorm --path <folder>` or `/builder:intake --path <folder>` with this file present
  resumes at the frontier, saying what is settled and open.
- The header lines (through `settled:`) are the only part `list-features.mjs` reads.
- The file stays through the build as design memory and is removed with the workspace at ship. The
  SPEC is the permanent record.

## `/builder:spec` — write the spec

1. **Precondition:** `brainstorm.md` with `status: sized md|lg|xl`. Otherwise refuse in one line,
   naming `/builder:brainstorm` or `/builder:intake`.
2. Load REFERENCE and `.claude/builder.md`.
3. **Present the design section by section for approval**, in SPEC order — §Idea first, then §Apps
   and §Contract, the per-app sections, §Testing, §Out of scope — each scaled to its complexity.
   Pushback amends the tree first, then the section.
4. **Write** `SPEC.md` + `MANIFEST.md` per REFERENCE (today's brainstorm Phase 4, moved), or
   `PROGRAM.md` + a program manifest at xl. Verify every component the per-app sections name exists.
5. `check-obligations`, self-review, commit `docs(<key>): design <feature>`, set `status: handed-off`,
   hand off to `/builder:resume --path <folder>`.
6. **Revisions before a go-ahead**: a brainstorm or intake revision of an existing spec re-enters
   here to apply its rulings.

## SPEC changes (REFERENCE §SPEC.md)

A new first section, written from `brainstorm.md`:

```markdown
## Idea
**Why.** <the outcome and who it's for, in prose>
**What success looks like.** <how a person will know it works>
**In your words.** "<the owner's key rules, verbatim>" → D3, D7    (each quote linked to its ruling)
**The concept.** <how it works, prose; a mermaid diagram when there is more than one moving part>
**How it fits today.** <prose from "How it works today"; file:line only as footnotes>
**Approaches considered.** <chosen and why> · <rejected and why>
```

- §Decisions keeps "a ruling is implementable, never a quote of the prompt" — the quote moves to
  §Idea *In your words*, linked to the ruling.
- "Record the DECISION, not the conversation" becomes: record the decision **and, in one line, why —
  and why the rejected option lost**. `check-obligations` flags a `Rejected:` clause with no reason.
- Line target ~300 → ~350. Specs written before 4.0.0 have no §Idea; nothing requires one.
- Everything else in SPEC is unchanged; align, audit, plan, build and verify read it as today.

## Integration

- **`list-features.mjs`** scans `.builder/*/brainstorm.md` headers (never bodies) for work with no
  registry folder yet; `/builder:status` shows `brainstorming (6/11 settled)`, `intake (4 contradictions
  open)`, `parked`, `sized md — next: /builder:spec`, each with its command. `handed-off` files are
  skipped. The `/builder:resume` picker offers them; resuming routes to the skill named in `source:`.
- **`/builder:resume`** state table gains: `brainstorm.md` sized md+ and no SPEC → `/builder:spec`.
- **`/builder:help`** decision table: an idea → brainstorm; a worked-out doc, ticket or design →
  intake; a settled concept → spec (normally reached by hand-off).
- **README** skills tree lists `intake` and `spec`.
- **Unchanged:** fleet and `/builder:agent` (they take only written specs), `/builder:revise`, align,
  audit, plan, build, verify, ship.

## Constraints and non-goals

- Nothing downstream of `SPEC.md` changes behaviour.
- Dependency-free: Node standard library only for script changes.
- Not in scope: the audit consuming intake's verification; the earlier "wrong assumptions" fixes
  (plan-time code check, a premise-falsified stop class, audit probes) — a separate design, though
  intent playback and assumption statements here overlap with them.

## Testing

- **Scripts (`node --test`):** list-features reports in-progress brainstorm/intake files with their
  header counts, skips `handed-off`, and reads only header lines; `check-obligations` flags a
  `Rejected:` with no reason and does not demand §Idea of a pre-4.0 spec.
- **Skills (instruction consistency):** a read-through of brainstorm, intake, spec, resume, help and
  REFERENCE for contradictions (who loads REFERENCE, who owns prototype mode, every status value
  handled somewhere).
- **Dry runs on real input:** an abstract idea through brainstorm; one of fai-cd's superpowers-era
  specs through intake; the result through spec.
- **Against the original problem:** a new SPEC has §Idea with a Why, at least one *In your words*
  quote, and approaches with reasons — the three things 0/23, 1/23 and ~44% of builder specs had.
