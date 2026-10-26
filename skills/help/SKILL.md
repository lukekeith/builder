---
name: help
description: The builder help card — which command to run when, how work is sized, where its files live and how resuming works. Use when the user asks how builder works or which builder command to use.
---

# `/builder:help` — how builder works

`/builder:brainstorm --help`, `/builder:intake --help`, `/builder:spec --help` and `/builder:resume --help` render this same card; `--help` on any
other builder skill prints that skill's own invocation line and flags, then stops.

**A question gets an answer, not the card.** When the user asks something specific ("how do I pick
up yesterday's work?"), answer it in two to four lines — the command, what it does, at most one
related command — and stop; end with `/builder:help shows the whole card.` Only a bare
`/builder:help` (or `--help`) renders the card below, in these words. The skills and
[`../resume/REFERENCE.md`](../resume/REFERENCE.md) are the source of truth; this card is the map.

## In one paragraph

You say what you want with `/builder:brainstorm`. It looks up what your words refer to in the code,
explains how that part works today, asks only what is still open, and — once you agree on what to
build — sizes it. A small change is built right there in the chat. A bigger one gets a written spec
you approve; it is checked against the code once, planned, built one app at a time, tested, and
merged. By default agents build and test it and merge it on your machine, marked *not human-tested*;
you can test it yourself instead, and then nothing becomes a PR until you sign off.

## Setup

Everything builder knows about your project lives in one file, **`.claude/builder.md`**: your apps,
their test commands, your house rules. `/builder:init` writes it from what the repo contains and
asks only what it can't tell; `/builder:init --update` fills gaps in an existing one. If a step says
it can't find the config, that file is what's missing. Nothing else needs installing.

## Which command do I run?

| You want to… | Run |
|---|---|
| **Start anything** — explore an idea, ask for a change, think something through | `/builder:brainstorm <what you want>` |
| **Build from a spec, brief or ticket someone already wrote** | `/builder:intake <file · ticket · pasted doc>` — checks every claim against the code and asks only about what's contradicted or missing |
| **See everything in progress** | `/builder:status` — one table, with the next step for each |
| **Pick up where you left off** | `/builder:resume` — no argument lists everything in flight |
| **Hand unfinished work to agents** | `/builder:agent` — tick features from a list; agents finish each and merge it. Every hand-off where agents could take over offers it as **1. Agent**, except the plan go-ahead, which launches agents itself |
| **Build several specs while you're away** | `/builder:fleet <features…>` |
| **Build it yourself in this session** | pick **In this session** on a hand-off before the build (or `/builder:resume --path <folder> --here`) — it is planned and built here, then stops for you to try it |
| **Record that you tried it and it works** | `/builder:signoff --path <folder> <your words>` — only you can type it; `--hold "<reason>"` means "works, don't push yet" |
| **Change a feature that's already planned or part-built** | `/builder:revise --path <folder> <the change>` |
| **Clean up leftover branches and worktrees** | `/builder:tidy` |
| **Build from a finished design** | `/builder:check --<design.flag> <ref>` to see if it's ready, then `/builder:intake --<design.flag> <ref>` — the flag's name comes from your config |
| **Update builder, or see which one you're on** | `/builder:update` · `/builder:version` (a copy inside the repo updates with `/builder:vendor`) |
| **Watch it run** | `/builder:statusline` — a live builder progress bar; `--off` removes it |

The steps `/builder:resume` runs for you can also be run by hand, each with `--path <folder>`:
`/builder:spec`, `/builder:audit`, `/builder:plan`, `/builder:build`, `/builder:verify`,
`/builder:ship`. Flags come first and the free text after them is the request.

## What happens to a feature

**Size.** Decided once you agree on what to build, with the reason; you can override it, and it only
ever goes up.
- **xs / sm** — stays inside existing code and one app. Designed and built in the chat; nothing is
  written under `docs/`.
- **md / lg** — adds a model, a schema field, an endpoint, a permission, a route or a screen, or
  crosses from one app into another. Gets `SPEC.md` and a ~12-line `MANIFEST.md`.
- **xl** — split into several features under one `PROGRAM.md`.
- "Can we…?" is answered as a question, not turned into a feature.

**Order (md and lg):**

```
spec → audit (once) → open questions → plan → go-ahead → build (one app at a time)
     → tested → verify (the one deep check) → merged, or a PR after your sign-off
```

**Who tests it.** After you approve the spec the hand-off offers:
1. **Agent** — "go" picks it. Agents plan, build, try it in the running app, verify, and merge it
   into your main branch on your machine (`merge_into` picks another), recorded as
   `🤖 AGENT SIGNED OFF — not human-tested`. Nothing is pushed; no PR.
2. **Step by step** — the same, pausing for you at the open questions and the plan's go-ahead.
3. **In this session** — built here, then 🔒 it stops for **your walk**: you try it in the running
   app and type `/builder:signoff`. Only then come verify and **one PR for the whole feature**. A
   plugin hook blocks `gh pr create` until you have signed off.

**Several apps in one repo.** Each app gets its own phase, the one that provides an API before the
ones that use it, and each phase runs that app's own tests. The shared contract between apps freezes
once the providing app's phase passes; only `/builder:revise` reopens it, and it names every app to
re-check. An app marked `commit: manual` is never committed by an agent.

## The go-ahead and the test plan

The plan is shown as numbered slices, grouped by app, each with the tests it adds, and a test plan
with what it costs. "go" takes the recommended one; *Change the test plan* asks:
- **Testing per slice** — its own tests (recommended) · plus the app's suite when its slices are
  done · the app's suite after every slice · none while building.
- **Testing at the end** — the touched apps' suites once (recommended) · plus an agent tries the
  risky parts · everything · nothing — you test it.
- **Review** — once at the end (recommended) · once per app · after every slice.

With the end set to the risky parts or everything, it also asks **Walk it yourself before it
lands?** — yes parks the agent build for your walk and lands it after your sign-off. A breaking
schema change, a migration or a released consumer raises the recommended end, and says why. **Two
floors hold under every plan:** a type-check of every touched app before the work lands, and one
final whole-branch review.

## Resuming

Each feature's `MANIFEST.md` says where it stands and what's next, and every step ends with:

```
📍 <feature>: <state> — next: <what happens next>
```

Reply **go** to continue, or pick a numbered option where there's more than one way on — "go" picks
1. After a `/clear`, `/builder:resume` (or just ask to continue). A few things wait for you on
purpose: your walk and sign-off, a step only you can do, a hold, and opening the PR, which asks
once. "go, but …" is a change, not a go.

## Words you'll see

**spec** `SPEC.md`, what and why, kept after it ships · **manifest** `MANIFEST.md`, where it stands ·
**plan** `PLAN.md`, the build step by step · **walk** trying it yourself in the running app ·
**sign-off** your verdict after the walk · **verify** the final full check · **park** stopped for
a decision only you can make, with what and why.

## FAQ

- **Where are the files?** `<registry>/<feature>/` — `SPEC.md`, `MANIFEST.md`, `PLAN.md`. When it
  ships, the folder shrinks to its `SPEC.md` and moves to `<registry>/_archive/`; git keeps the rest.
- **The audit found problems.** Normal — they become fixes in the spec. It runs once; anything still
  uncertain is carried into the build as a named risk.
- **My walk found problems.** They go in the spec's `## Fixes` list, each naming its app; they're
  fixed, you try again, and sign off.
- **A small change after the build?** Just fix the code. `/builder:revise` is for a change that
  unbuilt work depends on.
- **Does it need other plugins, update my tickets, deploy, or write my design system?** No. It
  never creates a ticket, pushes, or deploys.
- **What are its hooks?** Two, silent outside a repo with `.claude/builder.md`: a short brief at
  session start, and the PR lock. The guide (`docs/guide.md` in the plugin's repo) says how to turn
  them off.
- **How work is done.** Four skills set it, and every implementer gets them:
  `/builder:test-driven-development`, `/builder:systematic-debugging`,
  `/builder:receiving-code-review`, `/builder:verification-before-completion` — *no claim that
  something works without fresh evidence.*
