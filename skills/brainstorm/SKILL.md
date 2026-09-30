---
name: brainstorm
description: The exploration conversation — start here with an idea, a request or a question about how something should work. First grounds every term you used in the code — schema, UI, routes, specs, history — and follows what it finds to the features and data that depend on it, so it plays back what you intend already knowing what your words refer to; explains how the code works today in plain words, then asks only what is still open, one question at a time (each with why it matters, what it affects, and pickable options with the recommendation first; facts are looked up, never asked), lays out approaches when there is a real fork, and confirms a shared understanding before anything is written. Only then does it size the work — xs/sm are designed and built in chat, md/lg/xl hand on to /builder:spec — or park the idea, or stop at understanding. A worked-out spec, ticket or design ref goes to /builder:intake instead. Resumable from its workspace record. Use when the user wants to explore, think through, design, build, add or change anything.
---

# `/builder:brainstorm` — understand it together, then decide what to build

Invocation: **`/builder:brainstorm [--path <folder>] [--ticket <id>] [--auto] [--keep] [--help]
<what you want>`**.
Flags first; free text after them is the work. Ignore any flag this step does not use rather than
erroring on it.

**`--help` first.** If present, render the `builder:help` card and stop.

**The mechanics live in [CONVERSATION.md](CONVERSATION.md)** — the record, rounds, approaches,
confirm, size, steering. Read it now. **Do not load REFERENCE wholesale** — the conversation reads only the three sections CONVERSATION.md
names, when it reaches them; the spec formats belong to `/builder:spec`. Read `.claude/builder.md`:
the apps and the house-rule sources, and for the small path its companion skills, gates, landmines
and `commit:` mode.

**`--ticket <id>`** (REFERENCE §Flags) → write `ticket: <id>` into the record's header; check that
the current branch name carries the key and warn once if it does not; and read the dossier when the
config's `ticket.dossier` names one — a dossier recording a confirmed blast radius settles scope.
Nothing here writes to the ticket system.

**This is a dialogue.** It is done when the user says the understanding is right — not when enough is
known to build.

## Where to start

Take these in order; the first that applies wins.

1. **`--path <folder>` with a `brainstorm.md` in its workspace** → a status other than
   `handed-off`: resume from it (CONVERSATION §The record); a record with `source: intake` belongs
   to `/builder:intake` — hand it there. `handed-off` with a live SPEC, MANIFEST or PROGRAM: fall
   through to step 4 — a new revision, which overwrites the record. **`handed-off` with none of
   them** → nothing to resume: say where the work went (built in chat, stopped at understanding, or
   a spec committed on another branch — `git log --all --oneline -- <registry>/<feature>` finds
   it), offer a new name for new work, and stop.
2. **A design flag, a ticket id as the whole input (not `--ticket` beside a description), or a
   pasted or linked document that already decides most of the design** → offer the better entry:
   "This reads like a worked-out spec — want me to verify it against the code with `/builder:intake`
   instead of exploring from scratch?" On yes, hand it over verbatim. A design flag always goes to
   intake.
3. **No `--path`, no text** → the picker: `node <builder>/scripts/list-features.mjs --json`, one
   AskUserQuestion — the in-progress features and conversations (their `state` + `nextStep`), plus
   **New (describe it)**.
4. **Derive the name** (from `--path` or the text) and check it:
   - no `--path`, and `.builder/<name>/brainstorm.md` already exists with a status other than
     `handed-off` → a conversation under this name is in progress: offer to resume it (step 1)
     rather than overwrite it, or a different name for new work.
   - exists under `<registry>/_archive/` → it shipped: refuse the name, say when (its header line),
     suggest `<name>-v2`.
   - **The DONE check**: a live folder whose SPEC header carries `SHIPPED`, or whose README header
     opens `SHIPPED` → print the header, run no step, and offer a new feature name for follow-on work.
   - build state but no manifest → a pre-builder layout: hand it to `/builder:resume --path <folder>`
     and stop.
   - a live `PROGRAM.md` → existing work, never new: its children are revised one at a time — name
     them and ask which child the change lands in, then take that child's folder through this step.
   - a live `MANIFEST.md` with no `SPEC.md` → hand it to `/builder:resume --path <folder>`, which
     writes the missing SPEC, and stop.
   - a live `SPEC.md` → a **revision conversation**: seed the tree from the SPEC — every ruled
     §Decisions row a `settled` branch; a row still `OPEN` an `open` branch that keeps its
     recommendation — then run the rounds on the change and §Confirm, and **skip §Size**. With no
     `go-ahead:` in the manifest it hands to `/builder:spec --path <folder>`; after a go-ahead, set
     `status: handed-off` and hand each settled change to `/builder:revise --path <folder> <the
     ruling>` — one run per ruling.
5. Otherwise it is new: confirm the derived kebab-case name in the first turn.

## Intent — the first turn

1. **Read the input** and name what it is: an abstract idea, a directed request, or a brief.
2. **🔴 Ground it in the code before your first word back** — CONVERSATION §Grounding. Every term
   in the input that could name something in the system — a field, an entity, a screen, a status, a
   report column, a feature ("issue date", "the owner view", "a correction") — is a lookup, not a
   question. **Look it up yourself, fast pass first**: one grep for every spelling of every term, then
   read the few hits that matter. That takes seconds and settles most terms; only a term it leaves
   unclear goes deeper. A user who says "look up issue date" and gets back questions about what an
   issue date is has been failed — `issue_date` was one grep away.
3. **Map it into the tree** (CONVERSATION §The record): the branches the input already settles, the
   ones grounding settled (`assumed`, with evidence), and the ones still open. Say the depth plainly:
   "Your brief settles 9 of 12 decisions — 3 open" or "This is an open idea — I'll explore it with you."
4. **Play back the intent, grounded**: the outcome, who it is for, what success looks like — what the
   user said kept apart from what you assume, the user's key rules quoted in their words — and **what
   each of their terms turned out to be**: "*issue date* is `Certificate.issue_date` — set when the
   cert is generated (`certs/generate.ts:88`), shown on the PDF header and the cert list, read by the
   expiry report." The user corrects a finding; they never explain their own product to you. Ask
   what is wrong.
5. **Recon of the wider area carries on in parallel** (Explore agents, `sonnet`, one per app the
   idea plausibly touches) — how the neighbouring parts work, for *How it works today*. It never holds
   up this turn.

Write the record (`status: exploring`, `source: brainstorm`). The intent stays `(assumed)` until the
user confirms or corrects it.

## How it works today

Once the intent is confirmed (under `--auto`, once it is played back), explain what recon found
**to the user**, in plain words: what exists that the idea touches, how it works, where it lives —
with a small diagram when several parts move.
Scale it to the input: a paragraph for a directed request, a real walk-through for an abstract idea.
Name **what already exists that must not be rebuilt**. `file:line` goes in footnotes, never instead
of the explanation. Record it under *How it works today*.

From here on, "explain X" works at any point (CONVERSATION §Rounds).

## Rounds

CONVERSATION §Rounds — one question at a time — until the frontier is empty. Where the branches come from:

- **The input first** — every choice it leaves open with more than one defensible answer.
- **The fundamentals, when the idea reaches them**: the data-model shape, lifecycle edges (deletes,
  cascades, idempotence, time), permissions and what an unauthorized caller sees, where a surface
  lives in each app.
- **When more than one app is plausibly involved**, four branches join the tree even if nobody raised
  them: which apps; what a RELEASED build sees while this rolls out (for an app the config marks
  `released_artifact: true`); where the capability lives when the app is closed; do all the consumers
  need it, or only one.

## Size

CONVERSATION §Approaches, §Confirm and §Size and the small path, in that order. Sizing happens only
after the user confirms the understanding and chooses to build, and the size comes from the
confirmed concept. md, lg and xl hand on to `/builder:spec`; xs and sm are designed and built here.

A revision conversation never sizes: after §Confirm it hands to `/builder:spec --path <folder>` (no
`go-ahead:` yet) or, after a go-ahead, sets `status: handed-off` and hands each settled change to
`/builder:revise --path <folder> <the ruling>`.

## Every pause

End each turn that waits on the user with the resume footer:

```
📍 <feature>: brainstorming (<n>/<m> settled) — resume with /builder:brainstorm --path <registry>/<feature>
```

**Continuing:** a bare "go", "yes" or "proceed" after a hand-off footer runs its command yourself.
