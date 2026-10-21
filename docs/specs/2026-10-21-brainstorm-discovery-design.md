# Brainstorm discovery — design

> 2026-10-21 · builder 4.11.0 · status: approved in conversation (build and release end to end)

## Why

A user of builder reports that `/builder:brainstorm`'s discovery is weak: they start from a
high-level idea and want to explore concepts, and instead get decisions. Reading the skill confirms
the diagnosis. Brainstorm classifies the input as an abstract idea, a directed request or a brief,
grounds every term in the code, plays the intent back, explains how the touched code works today,
and then runs **rounds**: a tree of open decisions, one multiple-choice question per turn with a
recommendation first, until the frontier is empty. Approaches are offered only when the tree holds a
fork, as one more decision. An abstract idea gets exactly the treatment a directed request gets,
with a longer *How it works today*.

That machinery converges; nothing in it diverges. The six complaints, and where each comes from:

| Complaint | Cause in the skill today |
|---|---|
| Jumps to decisions too fast | the first turn after the intent playback is a frontier question |
| No problem framing | nothing asks who it is for, what pain, how it is handled today, what better means |
| No idea generation | §Approaches runs only on a fork in the tree, after the tree exists |
| Questions too closed | §Rounds mandates 2–4 options and a recommendation on every question |
| Not enough exploration | the only open-ended move is "explain X", on request |
| Ignores the design system and UX patterns | recon is briefed to describe how the code works, not what the product already has to build solutions from |
| No outside research | nothing looks beyond the repo: no community resource (Mobbin and the like) is consulted, no online research of how others solve it |

**Success:** a user who opens brainstorm with a vague idea is asked what problem it solves before
anything else, sees two to four concepts built from the product's own components and patterns, can
wander between and combine them in plain conversation, and only after naming the concept meets the
decision rounds that exist today. A directed request or a brief is unaffected. `--auto` runs,
`/builder:agent`, the fleet and the benchmark keep working with no extra turns.

## Decisions (from the conversation)

- **D1 — Where discovery lives.** A discovery phase inside `/builder:brainstorm`, in front of the
  tree, not a separate command and not a loosening of the rounds. The rounds stay as they are.
- **D2 — What enters discovery.** An input classified *abstract idea*; "let's explore" (or similar)
  for any input; "skip discovery" / "just build it" to skip it. No new flag.
- **D3 — Concepts come from the product.** Recon is briefed to find the design system, the UX
  patterns in use and prior art, and every concept names the existing patterns it is built from.
- **D4 — Release.** A patch (4.11.1): an existing skill behaves differently; nothing new is
  reached for by name.
- **D5 — Research is a discovery step.** After the frame and before the concepts, the agent weighs
  whether outside research would help and offers it: a community resource when one is available to
  the session (a plugin or MCP server that searches real product screens, flows and patterns, such
  as Mobbin), otherwise deeper online research of the topic and possible solutions. The user
  permits it; the agent never researches outside the repo unasked.

## Design

### 1. When discovery runs

`SKILL.md` §Intent already names the input as an abstract idea, a directed request or a brief
(step 1). After the intent playback (step 4), the flow forks:

- **abstract idea** → §Discovery (below), then §How it works today and §Rounds as today.
- **directed request, brief** → as today.
- Steering words at any point, recorded under *Steering* in the record: **"let's explore" / "explore
  this"** enters discovery (or returns to its concepts step) for any input; **"skip discovery" /
  "just build it"** leaves it for the tree, with the concept taken as the one the input implies.
- A revision conversation (a live SPEC) never enters discovery.

### 2. The frame

Discovery opens with open questions, in plain chat, one per turn: no AskUserQuestion, no option
list, no recommendation. The four frame questions, in this order, each skipped when the input or an
earlier answer already answers it (then stated as `assumed`):

1. who this is for — the people or roles, and what they are doing when they meet it
2. the pain or the outcome — what is hard, slow, missing or wrong today, or what becomes possible
3. how it is handled today — by the product, by a workaround, or not at all
4. what better looks like — what the user would notice, and how they would know it worked

Rules:

- **Grounding holds.** A term in the user's words is looked up before it is asked about
  (CONVERSATION §Grounding). The frame asks about intent and judgement, never about facts the code
  holds.
- **Reflect, then follow.** After every answer the agent plays the frame back in a few lines, what
  the user said kept apart from what the agent assumes, and follows where the user went, a tangent
  included; it does not pull them back to the next scripted question while they are mid-thought.
- **Four is the ceiling**; the user ends it sooner with "that's the problem" or similar. The frame
  is recorded under §Discovery · *Frame* (record §5).

### 3. Discovery recon

The Explore agents that already run in parallel from the first turn (SKILL §Intent step 5) get a
wider brief for an abstract idea, one agent per app the idea plausibly touches, `sonnet`:

- **what the product already has near the idea** — the capabilities, screens, data and flows the
  idea neighbours or overlaps, and what must not be rebuilt
- **the design system and UX patterns in use** — the components, layouts, navigation and
  interaction conventions, and the empty, loading and error states, each named with where it is
  used ("filter chips: the certificate list, the owner view"); the config's `design:` block's
  `contracts` directory is read when the block is configured
- **prior art** — the registry's `_archive/` specs, `NOTES.md` files, old `.builder/*/brainstorm.md`
  records that touch the idea, and `git log -S <term>` for the idea's terms
- **constraints** — the app's house rules, `released_artifact` apps, permissions in the area

Findings land under §Discovery · *What the product already has*, in plain words with `file:line` as
footnotes; they are the material the concepts are built from and they also feed *How it works
today*, which from here on only has to cover what discovery did not. Recon never holds up a turn:
the frame proceeds while it runs, and the concepts step waits for it.

### 4. Research

After the frame is played back and before concepts, one research step:

- **What is available.** The agent looks at the tools the session has: a tool that searches a
  library of real product screens, flows or patterns — Mobbin's `mcp__mobbin__search_screens`,
  `search_flows`, `search_sections`, or another plugin or MCP server of that kind — is a *community
  resource*; `WebSearch` / `WebFetch` are *online research*. Nothing is configured; the agent reads
  its own tool list.
- **The evaluation, said out loud.** One or two lines on whether research would help this idea and
  why: a user-facing surface, a flow other products have solved, an unfamiliar domain → likely
  helpful, and what the agent would look for ("how other apps let people filter a list by tags",
  "onboarding flows that ask for a goal first"); an internal refactor, a CLI flag, a data migration →
  likely not, said so.
- **The offer — the one closed question in discovery**, an AskUserQuestion, because consent to go
  outside the repo is a closed choice: the options are built from what is available — *Research on
  <resource>* (the community resource, when present), *Search the web*, both when both exist, and
  *Skip* — the agent's evaluation marking the recommended one, and the question naming what it
  would search for. The user may also answer with their own terms to search.
- **The research itself, bounded.** A community resource: a handful of searches around the frame's
  terms, read as patterns — how a flow is laid out, what a screen offers, what is common and what is
  rare — never as designs to copy. Online: a few searches and the pages that answer them — how
  products in the domain solve it, common UX patterns and their names, libraries or standards that
  exist — with sources kept. Both are summarised under §Discovery · *Research* in plain words:
  what others do, what is common, what is worth borrowing and what is not, each with where it was
  seen. Research never holds the frame up and is done before concepts are proposed.
- **It feeds the concepts.** A concept may be built from a pattern research found as well as from
  the product's own ("a tag filter like the one Mobbin shows in most note apps: chips above the
  list"), and says which is which, since a borrowed pattern is something the product does not have
  yet.
- Under `--auto`: the evaluation is written, no research runs (nothing outside the repo without a
  person's yes), and *Research* records `not run (auto)`.

### 5. Concepts

Once the frame is played back, research (if any) is in and recon is in, the agent proposes **two to four concepts** in chat,
each with:

- a short name
- what the user would experience, as a paragraph, from their point of view
- **the existing patterns it is built from, named** — "the filter chips the certificate list uses",
  "a side panel like the owner view" — and anything it would need that the product does not have
- what it is good at, and what it closes off
- a rough feel for size (a day, a week, a program), not a sized estimate

The user may: pick one; combine two (the agent writes the combination as a new concept); ask "what
if …" (the agent answers in the concept's terms, revising it); ask for one to be sketched deeper (a
flow in prose, or an ASCII layout or mermaid diagram when parts move); add their own; or say none
fit, which reopens the frame with what was learned. Every turn rewrites §Discovery · *Concepts*
with each concept's standing and why.

**No AskUserQuestion in discovery, except the research offer (§4).** The exit is the user naming the concept, in their words; the
agent confirms it in two lines ("**Concept:** <name> — <what it is, in one sentence>. <The patterns
it uses.> Right?") and a yes ends discovery. Steering: "that's enough" converges on the agent's
recommended concept, stated as such.

### 6. Hand-off and the record

- The chosen concept **seeds the tree**: each choice it embodies becomes a `settled` branch with its
  Why and the user as Who; the other concepts go to *Rejected* with the reason each lost; the
  concept's open questions become the first `open` branches. §How it works today, §Rounds,
  §Approaches, §Confirm and §Size then run unchanged. §Confirm's playback opens with the concept.
- **The record** (`.builder/<feature>/brainstorm.md`): the header keeps its exact shape (scripts read
  only the header). A new body section goes between *Intent* and *How it works today*:

  ```markdown
  ## Discovery
  Frame: for <who> · pain/outcome: <…> · today: <…> · better: <…>   (each "(assumed)" until confirmed)
  What the product already has: <plain prose; patterns named with where they are used; file:line as footnotes>
  Research: <skipped (why) | not run (auto) | on <resource> / online — what others do, what is common, what is worth borrowing, each with where it was seen>
  Concepts:
  - <name> — <one line> · built from: <patterns> · standing: chosen | open | rejected (<why>)
  Concept: <the chosen one, two lines>
  ```

  A directed request or brief has no §Discovery section. `/builder:spec` reads §Discovery into the
  spec's §Idea, which already carries the concept and the approaches considered: the frame becomes
  the "why" and "what success looks like" lines, the chosen concept is the concept, and the rejected
  concepts join the approaches considered with why each lost.
- **`--auto`** (CONVERSATION §Steering and --auto): the frame is written as `assumed` from the
  input, recon runs, the concepts are written to the record, and the recommended concept is taken,
  recorded `auto (recommended) YYYY-MM-DD`. No extra turns. The human reads the concepts and the
  ruling at the go-ahead, as with every other auto ruling.

### 7. Where the text changes

- `skills/brainstorm/SKILL.md`: §Intent gains the fork (D2 and §1 above); a new §Discovery section
  between §Intent and §How it works today holding §2–§5 in the skill's voice; §Rounds notes that the
  tree is seeded from the concept when discovery ran; the `description:` says discovery in one clause.
- `skills/brainstorm/CONVERSATION.md`: §The record gains the §Discovery body section; §Steering and
  --auto gains the discovery rulings; a new §Discovery recon brief beside §Grounding.
- `skills/spec/SKILL.md`: §Idea reads the record's §Discovery when present.
- `skills/help/SKILL.md`'s brainstorm row and README's brainstorm sentence say that an idea is
  explored before it is decided.
- `CHANGELOG.md` 4.11.1; `.claude-plugin/plugin.json` version.

## Testing

- `node --test 'scripts/test/*.test.mjs'` stays green; `skills-consistency.test.mjs` checks the
  skill files' shape and listings.
- `scripts/brainstorm-file.mjs` reads only the record header, which does not change; its tests prove
  that a record with a §Discovery body still parses.
- **The cost, measured:** `/builder:benchmark` runs brainstorm under `--auto` on the tags feature
  (an abstract-enough idea); the brainstorm step's time and tokens in `bench/results/` before and
  after this change are the measure. The run is part of the release.
- **The behaviour, read:** this is a plugin made of instructions, so the change is proven by reading
  the skill end to end for the rule it adds and by one real conversation from a vague idea, in a
  repo with a design system, checking that the frame is asked openly, the concepts name real
  patterns, the research offer names what it would look for and runs only on a yes, and the tree
  starts only after the concept is named.

## Out of scope

- A separate `/builder:explore` command or a `--explore` flag.
- Changing the rounds, approaches, confirm or size mechanics.
- Discovery for `/builder:intake`: a worked-out spec has had its discovery.
- Visual mockups beyond ASCII and mermaid sketches.
- Configuring research sources in `.claude/builder.md`; the agent uses the tools the session has.
- Research in `--auto` runs: nothing outside the repo without a person's yes.

## Release

Patch, **4.11.1**: how an existing skill behaves. One changelog entry naming the discovery phase and
that `--auto` is unaffected.
