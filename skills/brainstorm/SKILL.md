---
name: brainstorm
description: The exploration conversation — start here with an idea, a request or a question about how something should work. Plays back what you intend, explains how the code works today in plain words, then asks in rounds only what is still open (every question ready to ask, each with a recommendation; facts are looked up, never asked), lays out approaches when there is a real fork, and confirms a shared understanding before anything is written. Only then does it size the work — xs/sm are designed and built in chat, md/lg/xl hand on to /builder:spec — or park the idea, or stop at understanding. A worked-out spec, ticket or design ref goes to /builder:intake instead. Resumable from its workspace record. Use when the user wants to explore, think through, design, build, add or change anything.
---

# `/builder:brainstorm` — understand it together, then decide what to build

Invocation: **`/builder:brainstorm [--path <folder>] [--auto] [--keep] [--help] <what you want>`**.
Flags first; free text after them is the work. Ignore any flag this step does not use rather than
erroring on it.

**`--help` first.** If present, render the `builder:help` card and stop.

**The mechanics live in [CONVERSATION.md](CONVERSATION.md)** — the record, rounds, approaches,
confirm, size, steering. Read it now. **Do not load REFERENCE wholesale** — the conversation reads only the three sections CONVERSATION.md
names, when it reaches them; the spec formats belong to `/builder:spec`. Read `.claude/builder.md` for the apps and the house-rule
sources only.

**This is a dialogue.** It is done when the user says the understanding is right — not when enough is
known to build.

## Where to start

Take these in order; the first that applies wins.

1. **`--path <folder>` with a `brainstorm.md` in its workspace** → resume from its `status:`
   (CONVERSATION §The record). A record with `source: intake` belongs to
   `/builder:intake` — hand it there.
2. **A design flag, a ticket id, or a pasted or linked document that already decides most of the
   design** → offer the better entry: "This reads like a worked-out spec — want me to verify it
   against the code with `/builder:intake` instead of exploring from scratch?" On yes, hand it over
   verbatim. A design flag always goes to intake.
3. **No `--path`, no text** → the picker: `node <builder>/scripts/list-features.mjs --json`, one
   AskUserQuestion — the in-progress features and conversations (their `state` + `nextStep`), plus
   **New (describe it)**.
4. **Derive the name** (from `--path` or the text) and check it:
   - exists under `<registry>/_archive/` → it shipped: refuse the name, say when (its header line),
     suggest `<name>-v2`.
   - **The DONE check**: a live folder whose SPEC header carries `SHIPPED`, or whose README header
     opens `SHIPPED` → print the header, run no step, and offer a new feature name for follow-on work.
   - build state but no manifest → a pre-builder layout: hand it to `/builder:resume --path <folder>`
     and stop.
   - a live `SPEC.md` → a **revision conversation**: seed the tree from the SPEC — every ruled
     §Decisions row a `settled` branch; a row still `OPEN` an `open` branch that keeps its
     recommendation — then run the rounds on the change and §Confirm, and **skip §Size**. With no
     `go-ahead:` in the manifest it hands to `/builder:spec --path <folder>`; after a go-ahead, to
     `/builder:revise --path <folder>`.
5. Otherwise it is new: confirm the derived kebab-case name in the first turn.

## Intent — the first turn

1. **Read the input** and name what it is: an abstract idea, a directed request, or a brief.
2. **Map it into the tree** (CONVERSATION §The record): the branches the input already settles and
   the ones it leaves open. Say the depth plainly: "Your brief settles 9 of 12 decisions — 3 open" or
   "This is an open idea — I'll explore it with you."
3. **Play back the intent**: the outcome, who it is for, what success looks like — what the user said
   kept apart from what you assume, the user's key rules quoted in their words. Ask what is wrong.
4. **Start recon in parallel** (Explore agents, `sonnet`, one per app the idea plausibly touches) —
   it never holds up this turn.

Write the record (`status: exploring`, `source: brainstorm`). The intent stays `(assumed)` until the
user confirms or corrects it.

## How it works today

Once the intent is confirmed, explain what recon found **to the user**, in plain words: what exists
that the idea touches, how it works, where it lives — with a small diagram when several parts move.
Scale it to the input: a paragraph for a directed request, a real walk-through for an abstract idea.
Name **what already exists that must not be rebuilt**. `file:line` goes in footnotes, never instead
of the explanation. Record it under *How it works today*.

From here on, "explain X" works at any point (CONVERSATION §Rounds).

## Rounds

CONVERSATION §Rounds, until the frontier is empty. Where the branches come from:

- **The input first** — every choice it leaves open with more than one defensible answer.
- **The fundamentals, when the idea reaches them**: the data-model shape, lifecycle edges (deletes,
  cascades, idempotence, time), permissions and what an unauthorized caller sees, where a surface
  lives in each app.
- **When more than one app is plausibly involved**, four branches join the tree even if nobody raised
  them: which apps; what a RELEASED build sees while this rolls out (for an app the config marks
  `released_artifact: true`); where the capability lives when the app is closed; do all the consumers
  need it, or only one.

## Approaches, confirm, size

CONVERSATION §Approaches, §Confirm and §Size and the small path, in that order. Sizing happens only
after the user confirms the understanding and chooses to build. A revision conversation never sizes:
after §Confirm it hands to `/builder:spec --path <folder>` (no `go-ahead:` yet) or
`/builder:revise --path <folder>` (after a go-ahead).

## Size

The size comes from the confirmed concept (CONVERSATION §Size and the small path). md, lg and xl hand
on to `/builder:spec`; xs and sm are designed and built here.

## Every pause

End each turn that waits on the user with the resume footer:

```
📍 <feature>: brainstorming (<n>/<m> settled) — resume with /builder:brainstorm --path <registry>/<feature>
```

**Continuing:** a bare "go", "yes" or "proceed" after a hand-off footer runs its command yourself.
