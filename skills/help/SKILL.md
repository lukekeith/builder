---
name: help
description: Help card for the /builder:* pipeline — explains how work is sized (xs/sm designed and built in chat, md/lg as a SPEC plus a manifest, xl as a program of children), what each /builder:* command does and which one to run for a given situation, how a finished design can be read as the requirements, how one-app-per-phase and the contract freeze keep a multi-app repo safe, where the artifacts live, how resuming after a context clear works, how a folder from an earlier pipeline is converted, and how a signed-off feature condenses to its SPEC. Also explains the .claude/builder.md project config the whole family reads. Use when the user asks how the build pipeline works, what the builder commands are, which build skill to use, or for help getting started with speccing or building a feature.
---

# `/builder:help` — how the `/builder:*` pipeline works

`/builder:brainstorm --help` and `/builder:resume --help` render this same card; `--help` on any
other family skill prints that skill's own invocation line and flags, then stops.

Render the parts relevant to what was asked. The family's SKILL.md files and
[`../resume/REFERENCE.md`](../resume/REFERENCE.md) are the source of truth; this card is the map.

## The idea in one paragraph

**One command builds anything, and most of it never reaches a doc.** `/builder:brainstorm` sizes the
request first (REFERENCE §Sizes): **xs and sm** are designed and built in chat and write nothing
under `docs/`; **md and lg** earn one write-once `SPEC.md` plus a ~12-line `MANIFEST.md` and run the
pipeline below; **xl** becomes a `PROGRAM.md` whose children each run it. A finished, specced design
can be the requirements instead of an interview. A spec is audited against the codebase **once**
before any code, then built **one app per phase, the producer before its consumers**, with that
app's gates at every phase close, then 🔒 **walked by you**: your sign-off condenses the folder and
only then come the one deep verify pass and **one PR for the whole feature**. Building the feature
outranks recording it — git history is the full record.

## It reads ONE config file

🔴 **The plugin knows nothing about your project.** Every project fact — the apps, the gate commands,
the house rules, the environment landmines, the recipe skills, the design source — lives in
**`.claude/builder.md`**. Writing it is the whole per-repo setup:

```
/builder:init             # reads the repo, asks what it can't tell, writes .claude/builder.md
/builder:init --update    # fill the gaps in an existing one
```

Nothing else is needed. The plugin ships its own scripts and its own execution engine; there is no
second plugin to install. If a step says it cannot find the config, that file is what's missing.

## Which command do I run?

| You are… | Run |
|---|---|
| **Setting up a repo for the first time** | `/builder:init` — writes `.claude/builder.md` from what the repo contains |
| **Any time — "where are things / what's next?"** | `/builder:resume` (no argument: the picker — every in-flight feature and program) |
| **Wanting something built, unsure how big it is** | `/builder:brainstorm <what you want>` — it recons, announces a size with its evidence, and takes the matching path. The normal way in |
| Sure it's a small change inside one app | `/builder:brainstorm --size sm <what you want>` — recon, ≤3 questions, a design you approve in chat, then built. No docs |
| Sure it's a new feature | `/builder:brainstorm --size md <what you want>` (`--size lg` for a big one) — it designs, writes `SPEC.md` + `MANIFEST.md`, hands on to `/builder:resume` |
| Building from a design that is already specced | `/builder:brainstorm --<design.flag> <ref> <what the work is>` — the contracts are the requirements. The flag's name comes from your config |
| Wondering whether a design is ready to build from | `/builder:check --<design.flag> <ref>` — the pre-flight; it writes nothing |
| Holding a folder from an **earlier pipeline** | `/builder:resume --path <registry>/<name>` — it offers the conversion and leaves every existing doc in place |
| Carrying an existing feature forward | `/builder:resume --path <registry>/<name>` |
| Running one step by hand | `/builder:brainstorm` · `/builder:align` (prototype mode) · `/builder:audit` · `/builder:plan` · `/builder:build` · `/builder:verify` — each takes `--path <folder>` |
| **You just hands-on tested the finished feature** | `/builder:signoff --path <folder> <your words>` — only you can type it; PASS condenses the folder and unlocks verify + the PR, and `--hold "<reason>"` means "it works, don't push yet" |
| Changing something after the spec exists | `/builder:revise --path <folder> <the change>` — post-build the default is a code fix plus at most one doc line |
| Verify is READY and the PR is open | `/builder:ship --path <folder>` — flips the SPEC header to SHIPPED citing the PR, removes the manifest and the workspace |

Flags come first and the free text after them is the work; quote a ref containing spaces. The whole
family parses the same set — REFERENCE §Flags — plus `--hold`, which only sign-off takes.

## The four craft skills

Four more skills ship inside the plugin. They are not pipeline steps — they bind the *way* work is
done, and they apply whether or not you are running a feature through the pipeline at all:

| Skill | Read it when |
|---|---|
| `/builder:test-driven-development` | implementing any feature or bugfix, before writing implementation code |
| `/builder:systematic-debugging` | any bug, test failure or unexpected behaviour — **before proposing a fix** |
| `/builder:receiving-code-review` | review feedback has come back, before you implement any of it |
| `/builder:verification-before-completion` | about to claim anything is complete, fixed or passing |

The pipeline hands all four to every implementer by path, and cites them where they bite: the plan's
steps are written in the TDD cycle, a fix round that stops converging gets the debugging skill, a
`## Fixes` row from a review is read through the review skill, and every gate claim is governed by
the verification skill's iron law — *no completion claim without fresh verification evidence.*

**No command here creates a branch, a worktree or a ticket**, and none writes to your ticket system
— those are yours.

## The sizes

The verdict is announced with its evidence before anything is written, and `--size` forces it. It
**ratchets up only**: complexity found mid-task stops the work and writes the spec then.

**Two things draw the sm/md line, and neither is file count.** A change staying inside existing
contracts *and inside one app* is sm however many files it brushes. It earns a spec the moment it
adds a model, a schema row, an endpoint, a permission, a route or a screen — **or the moment it
crosses an app boundary**, because the contract between the apps is the thing that breaks. Where your
config marks an app `released_artifact: true`, it breaks somewhere nobody can hot-fix. A feasibility
question ("can we…") is a **spike**: answered as a question, not wrapped in a feature folder.

## The order (md and lg)

```
design → (align) → audit (1 pass) → [decisions] → plan → [go-ahead] → build (one app per phase)
              ↑ prototype mode only
   → 🔒 your walk + /builder:signoff (condenses) → verify (the ONE deep pass) → ship
```

**The walk is you, in the running app — or apps.** When the last phase lands, the pipeline runs the
fast gates, prints a script the build wrote **per app**, and stops. Nothing moves until you have
tried it and typed `/builder:signoff`. The walk precedes verify because the deep pass needs every app
up at once, so it runs once, on a build a human has already accepted.

## The multi-app rules (what this pipeline has that a single-app one doesn't)

1. **§Apps gives every app a row, including the ones it doesn't touch.** A ⬜ row states why not in
   one line, and the audit checks that claim — a wrong "not affected" is the most expensive finding
   there is, because it ships.
2. **§Contract is one interface table every consumer codes against**, each row naming its consumers.
   🔴 **It FREEZES when the producer's phase verifies.** A consumer needing a different shape goes
   through `/builder:revise`, which re-opens the freeze deliberately and names every consumer to
   re-check.
3. **One app per phase, the producer before its consumers.** Each app's gates are different commands,
   so a two-app phase cannot be gated — and consumers parallelize when they don't import each other.
4. **An app your config marks `commit: manual` is never committed by an agent** — at any size, under
   any flag.

`node <builder>/scripts/check-obligations.mjs <feature>` turns rules 1 and 2 from habits into a gate.

**In a single-app repo** all of this costs one `§Apps` row and stays quiet — and still works the day
the repo grows a second app.

## The human gates (three, plus the PR lock)

1. **Decisions gate** — the OPEN rows in SPEC §Decisions, asked in one message, recommendation first.
2. **Build go-ahead** — one approval of `PLAN.md`'s `## Phases` table. One artifact, one approval —
   an approved design is not re-approved as a plan.
3. 🔒 **The PR lock** — nothing moves toward a PR until you have personally exercised the finished
   feature and said, in your own words, that it works. A green gate run or a code review is evidence
   for you, never your sign-off. Spend it with `/builder:signoff`.

Otherwise the pipeline keeps working instead of stopping to ask. **`--auto`** takes the recommended
answer at each decision gate and runs until the walk script is printed — **the walk is its terminal
state**, and no flag passes the PR lock or commits in a manual-commit app.

## Resuming

**The manifest is the resume point.** `<registry>/<feature>/MANIFEST.md` is ~12 lines, commits at
every transition, and its `next:` line names the one command that does the next work. Every step ends
with that line:

```
📍 <feature>: <state> — next: <command>
```

After any `/clear`: `/builder:resume --path <registry>/<feature>`. Status of everything:
`node <builder>/scripts/list-features.mjs`. Process scratch — briefs, the ledger, the walk script —
lives in a git-ignored workspace; it is never something you have to read.

## FAQ

- **Can it one-shot a feature?** xs and sm, yes — once you have approved the design in chat. md and
  lg, no: one app at a time, that app's gates fresh at each phase close, your walk before the deep
  pass.
- **Where is the plan?** `<registry>/<feature>/PLAN.md`, committed beside the SPEC: a `## Phases`
  table, then one block per task naming its app, its files and the recipe skill to read first, with
  bite-sized steps carrying the actual code, its test, the command and the commit. SPEC §Plan is only
  the index. Both go at sign-off; `git log` keeps them.
- **Where's the cross-app E2E walk?** Once, in `/builder:verify`, after your sign-off. Never per
  phase: it needs every app up at once, and the phases under it are already covered in seconds.
- **Does it need other plugins?** No. The execution engine, the plan format and the four craft
  skills are vendored (see `LICENSE-THIRD-PARTY.md`), the scripts ship with the plugin, and the only
  thing you supply is `.claude/builder.md`.
- **The audit found problems.** Normal — they become §Findings rows and in-place spec fixes. It is
  capped at **one pass** (a scoped second only when pass 1 changed a contract); anything still
  uncertain rides into the build as a named `build-time risk`. Re-reading prose was measured to find
  nothing that running the software finds.
- **A small change after the build?** Fix the code. A doc line only if a human ruled on it, or an
  un-built task depends on it. `/builder:revise` exists for the contract change that un-built work
  needs, not for every edit.
- **My walk found problems — where do they go?** Into `## Fixes`, the SPEC's last section: `- [ ]`
  tasks worked like build tasks in the main context, **each naming its app**, ticking each box as it
  lands. Then you re-walk what changed and sign off again. A verify INCOMPLETE fills the same list.
- **What stops a shipped feature being rebuilt?** The SPEC header. `✅ SHIPPED` means done and every
  command refuses to run on it. `✅ SIGNED OFF` is *not* done — verify and the PR still run.
- **Does it touch my design system?** It **reads** it and never writes it. A gap is routed to the
  command your config's `design.owned_by` names.
- **Does it update my tickets, or deploy?** Never. Both are explicit commands of yours.
