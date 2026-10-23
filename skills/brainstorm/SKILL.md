---
name: brainstorm
description: The exploration conversation — start here with an idea, a request or a question about how something should work. First grounds every term you used in the code — schema, UI, routes, specs, history — and follows what it finds to the features and data that depend on it, so it plays back what you intend already knowing what your words refer to; explores a vague idea before deciding anything — frames the problem in open questions, finds the design system, UX patterns and prior art the product already has, offers research outside the repo (a community resource such as Mobbin when the session has one, otherwise the web) and runs it only on your yes, and proposes two to four concepts built from all of it until you name one; offers a small change in existing code a quick path — the change proposed in the first turn and built on one yes, no rounds; explains how the code works today in plain words, then asks only what is still open, one question at a time (each with why it matters, what it affects, and pickable options with the recommendation first; facts are looked up, never asked), lays out approaches when there is a real fork, and confirms a shared understanding before anything is written. Only then does it size the work — xs/sm are designed and built in chat, md/lg/xl hand on to /builder:spec — or park the idea, or stop at understanding. A worked-out spec, ticket or design ref goes to /builder:intake instead. Resumable from its workspace record. Use when the user wants to explore, think through, design, build, add or change anything.
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
5. Otherwise it is new: confirm the derived kebab-case name in the first turn (the quick path
   states it instead — §Quick path).

## Intent — the first turn

1. **Read the input** and name what it is: an abstract idea, a directed request, or a brief.
2. **🔴 Ground it in the code before your first word back** — CONVERSATION §Grounding. Every term
   in the input that could name something in the system — a field, an entity, a screen, a status, a
   report column, a feature ("issue date", "the owner view", "a correction") — is a lookup, not a
   question. **Look it up yourself, fast pass first**: one grep for every spelling of every term, then
   read the few hits that matter. That takes seconds and settles most terms; only a term it leaves
   unclear goes deeper. A user who says "look up issue date" and gets back questions about what an
   issue date is has been failed — `issue_date` was one grep away.
3. **The quick check** — §Quick path. A request the grounding shows is a small change in existing
   code is offered the quick path *instead of* the rest of this list; everything below runs only when
   it doesn't qualify, or the user picks the full conversation.
4. **Map it into the tree** (CONVERSATION §The record): the branches the input already settles, the
   ones grounding settled (`assumed`, with evidence), and the ones still open. Say the depth plainly:
   "Your brief settles 9 of 12 decisions — 3 open" or "This is an open idea — I'll explore it with you."
5. **Play back the intent, grounded**: the outcome, who it is for, what success looks like — what the
   user said kept apart from what you assume, the user's key rules quoted in their words — and **what
   each of their terms turned out to be**: "*issue date* is `Certificate.issue_date` — set when the
   cert is generated (`certs/generate.ts:88`), shown on the PDF header and the cert list, read by the
   expiry report." The user corrects a finding; they never explain their own product to you. End
   with the ways on (CONVERSATION §Ways on): `A. That's right — carry on (recommended)` ·
   `B. Build it now — my recommendations on everything still open` · `C. Explore it first` (a
   directed request or brief) or `C. Skip exploring — straight to the questions` (an abstract idea)
   — and "Or say what's wrong."
6. **Recon of the wider area carries on in parallel** (Explore agents, `sonnet`, one per app the
   idea plausibly touches) — how the neighbouring parts work, for *How it works today*; for an
   abstract idea, the wider brief of CONVERSATION §Discovery recon. It never holds up this turn.
7. **Where it goes next.** An **abstract idea** → §Discovery, then §How it works today. A **directed
   request** or a **brief** → §How it works today, then §Rounds. The user overrides either in words
   at any point — "let's explore" enters discovery for any input; "skip discovery" / "just build it"
   leaves it (CONVERSATION §Steering and --auto). A revision conversation never enters discovery.
   "Just build it" at any later point skips the rest of the conversation too (CONVERSATION
   §Steering and --auto).

Write the record (`status: exploring`, `source: brainstorm`). The intent stays `(assumed)` until the
user confirms or corrects it.

## Quick path

Most requests that reach brainstorm in a chat are edits: a label, a guard, a column moved, a
form reworked. The full conversation — playback, how it works today, rounds, confirm, size — is
due diligence they do not need. The grounding already done in the first turn is enough to see that,
so the quick path is decided there, before any of the ceremony starts.

**It qualifies** when the fast pass (and, for the terms the change touches, the follow pass) shows
all of these — REFERENCE §The classifier read against the grounding, not against a settled tree:

- a **directed request** or a **brief** — never an abstract idea, never a revision conversation
  (a live SPEC), never under `--auto`;
- the flow it changes **exists and was read** (classifier rule 1);
- **one app**, and no new model, schema row, endpoint, permission, contract, route, screen or
  shared component (rules 2–4);
- **at most one** product choice left open with more than one defensible answer;
- it fits one sitting.

Any doubt → it does not qualify (the heavier size wins, as everywhere). Not qualifying is silent:
the conversation goes on from §Intent step 4 as it always has.

**When it qualifies, the first turn is the proposal** — no intent playback, no rounds, no name to
confirm (the derived name is stated):

```
Quick path — this is a small change in existing code (<xs|sm>: <the evidence, one line>).

<What you asked, grounded: each of your terms → what it is in the code, one line each.>
<The change. xs: one sentence. sm: the app · the approach · files touched · the recipe skills
it will read · tests · what you will see in the running app.>
```

Then the ways on, as a lettered list (CONVERSATION §Ways on) — no picker:

```
A. Build it (recommended) — <what gets changed and what you will see>
B. Brainstorm it first — the full conversation: intent, how it works today, questions, confirm
Reply A or B — "go" is A. Or say what's wrong.
```

With one open product choice, the build entry becomes one entry per defensible answer —
`A. Build it: <answer> (recommended)` · `B. Build it: <answer>` · … — and *Brainstorm it first*
takes the last letter; never a second question.

A reply in the user's own words is a correction ("the badge on the owner view, not the list"):
revise the proposal and offer the list again. **Picking a Build entry is the small path's one approval** (CONVERSATION §Size and the
small path, step 2) — there is no second one. Then steps 3–6 of the small path run: recipe skills,
TDD where behaviour changes, `commit: manual` respected, the fast gates, the human's look for
anything visual, and the closing footer.

**Brainstorm it first** → §Intent step 4 onward, unchanged, with nothing lost: the grounding stands.

**The record**, written before the question so `/clear` cannot lose it: the header with
`status: sized <xs|sm>` and `input:`, a one-line §Intent (`(assumed)`), and §Size with its evidence
plus `quick path — offered <date>`. Resuming it lands in the small path (CONVERSATION §The record).

**Found bigger mid-build** — a schema row, a second app, a contract the grounding missed: stop, say
what was found, and offer §Intent step 4 onward with the work so far kept. Nothing downgrades; the
size only ratchets up.

## Discovery

For a vague idea, the decision tree is the wrong first move: it asks the user to choose before they
know what they want. Discovery comes first — a frame, recon aimed at what the product already has,
research outside the repo when the user allows it, and concepts built from all of it — and ends
when the user names the concept. The record's §Discovery (CONVERSATION §The record) is rewritten
after every turn.

### The frame

Open questions, in plain chat, **one per turn — no AskUserQuestion, no option list, no
recommendation.** In this order, each one skipped when the input, an earlier answer or grounding already
answers it (then stated as `assumed`, with what it was taken from):

1. **Who it is for** — the people or roles, and what they are doing when they meet it.
2. **The pain or the outcome** — what is hard, slow, missing or wrong today, or what becomes possible.
3. **How it is handled today** — what the product does is looked up and stated (§Grounding); only the
   workaround, or that there is none, is the user's to say.
4. **What better looks like** — what the user would notice, and how they would know it worked.

- **Grounding holds** (CONVERSATION §Grounding): a term in the user's words is looked up before it is
  asked about. The frame asks about intent and judgement, never about a fact the code holds.
- **Reflect, then follow.** After every answer, play the frame back in a few lines — what the user
  said kept apart from what you assume — and follow where they went, a tangent included. Never pull
  them back to the next scripted question while they are mid-thought.
- **Four is the ceiling**; the user ends it sooner with "that's the problem" or similar.

### Research

After the frame is played back and before concepts — once, every discovery:

1. **What the session has.** Read your own tool list. A tool that searches a library of real product
   screens, flows or patterns — Mobbin's `mcp__mobbin__search_screens`, `mcp__mobbin__search_flows`,
   `mcp__mobbin__search_sections`, or another plugin or MCP server of that kind — is a **community
   resource**. `WebSearch` / `WebFetch` are **online research**. Nothing is configured for this; a
   session with neither says so in one line and moves on to concepts, recording
   `Research: skipped (no research tools in this session)`.
2. **Weigh it, out loud.** One or two lines: would research help this idea, and why — a user-facing
   surface, a flow other products have solved, an unfamiliar domain → likely yes, and name what you
   would look for ("how other apps let people filter a list by tags"); an internal refactor, a CLI
   flag, a data migration → likely no, said so.
3. **Offer it — the one closed question in discovery**, an AskUserQuestion (consent to go outside the
   repo is a closed choice). The options are exactly these, each present only when the session has
   the tool for it, in this order: *Research on <resource>* (the community resource) · *Search the
   web* · *Both* (only when both exist) · *Skip* — never merged into fewer, never reworded into one
   combined choice. Your evaluation marks one `(Recommended)`, and each description names what it
   would search for. *Other* carries the user's own search terms.
4. **Do it, bounded.** A community resource: a handful of searches around the frame's terms, read as
   patterns — how a flow is laid out, what a screen offers, what is common and what is rare — never
   as designs to copy. Online: a few searches and the pages that answer them — how products in the
   domain solve it, the common UX patterns and their names, libraries or standards that exist — with
   sources kept. Write §Discovery · *Research* in plain words: what others do, what is common, what
   is worth borrowing and what is not, each with where it was seen.
5. **It feeds the concepts.** A concept may be built from a pattern research found as well as from
   the product's own, and says which is which — a borrowed pattern is one the product does not have
   yet, marked "(from research: <where>)" in *built from*.

🔴 **Never research outside the repo unasked.** Under `--auto` the evaluation is written, no research
runs, and *Research* reads `not run (auto)` (CONVERSATION §Steering and --auto).

### Concepts

When the frame is played back, research (if any) is in and recon (CONVERSATION §Discovery recon) is
in, propose **two to four concepts** in chat, lettered — **A** is the one you recommend, marked
`(recommended)`, and the turn closes with `Reply with a letter — "go" is A. Or combine them, ask
"what if …", or say none fit.` (CONVERSATION §Ways on). Each:

- its letter and a short name
- what the user would experience, as a paragraph, from their point of view
- **the existing patterns it is built from, named** — "the filter chips the certificate list uses",
  "a side panel like the owner view" — a borrowed one marked "(from research: <where>)", and
  anything it needs that the product does not have
- what it is good at, and what it closes off
- a rough feel for size (a day, a week, a program) — never a sized estimate

The user may pick one; combine two (write the combination as a new concept); ask "what if …"
(answer in the concept's terms and revise it); ask for one sketched deeper (a flow in prose, or an
ASCII layout or mermaid diagram when parts move); add their own; or say none fit, which reopens the
frame with what was learned. Every turn rewrites §Discovery · *Concepts* with each concept's
standing and why.

🔴 **No AskUserQuestion in discovery, except the research offer.** The exit is the user naming the
concept. **A letter (or a concept's name) names it outright**: state the two-line confirmation below
and go on in the same turn — no "Right?". A combination, or a concept in the user's own words,
is confirmed in two lines — "**Concept:** <name> — <what it is, one sentence>. <The patterns it uses.>
Right?" — and a yes ends discovery. "That's enough" converges on your recommended concept, stated
as such. Under `--auto`, CONVERSATION §Steering and --auto takes the recommended concept without a
turn.

### After discovery

The chosen concept seeds the tree: each choice it embodies becomes a `settled` branch with its Why
and the user as Who; the other concepts go to *Rejected* with the reason each lost; the concept's
open questions become the first `open` branches. §How it works today then covers only what
discovery did not, and §Rounds runs unchanged. §Confirm's playback opens with the concept.

## How it works today

After discovery, only what §Discovery · *What the product already has* did not cover.

Once the intent is confirmed (under `--auto`, once it is played back), explain what recon found
**to the user**, in plain words: what exists that the idea touches, how it works, where it lives —
with a small diagram when several parts move.
Scale it to the input: a paragraph for a directed request, a real walk-through for an abstract idea.
Name **what already exists that must not be rebuilt**. `file:line` goes in footnotes, never instead
of the explanation. Record it under *How it works today*.

From here on, "explain X" works at any point (CONVERSATION §Rounds).

## Rounds

CONVERSATION §Rounds — one question at a time — until the frontier is empty. After discovery the
tree starts seeded from the concept (§Discovery · After discovery). Where the branches come from:

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

The quick path's proposal ends with
`📍 <feature>: quick path offered (<xs|sm>) — reply A to build, or resume with /builder:brainstorm --path <registry>/<feature>`.

Every pause puts its ways on above that footer as a lettered list (CONVERSATION §Ways on) — the
frame's open questions excepted.

**Continuing:** a bare "go", "yes" or "proceed" after a hand-off footer runs its command yourself.
