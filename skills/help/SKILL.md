---
name: help
description: Help card for the /builder:* pipeline — explains how work is sized (xs/sm designed and built in chat, md/lg as a SPEC plus a manifest, xl as a program of children), what each /builder:* command does and which one to run for a given situation, how a specced UI 2.0 component set enters the build with --ui2, how one-app-per-phase and the contract freeze keep a four-app monorepo safe, where the artifacts live, how resuming after a context clear works, how a pre-builder numbered suite is converted, and how a signed-off feature condenses to its SPEC. Use when the user asks how the build pipeline works, what the builder commands are, which build skill to use, or for help getting started with speccing or building a feature.
---

# `/builder:help` — how the `/builder:*` pipeline works

`/builder:brainstorm --help` and `/builder:resume --help` render this same card; `--help` on any other
family skill prints that skill's own invocation line and flags, then stops (REFERENCE §Flags).

Render the parts relevant to what was asked. The family's SKILL.md files
(`plugins/builder/skills/`) and [`plugins/builder/skills/resume/REFERENCE.md`](../resume/REFERENCE.md)
are the source of truth; this card is the map to them.

## The idea in one paragraph

**One command builds anything, and most of it never reaches a doc.** `/builder:brainstorm` sizes the
request first (REFERENCE §Sizes): **xs and sm** are designed and built in chat and write nothing under
`docs/`; **md and lg** earn one write-once `SPEC.md` plus a ~12-line `MANIFEST.md` in
`docs/features/<feature>/` and run the pipeline below; **xl** becomes a `PROGRAM.md` whose children each
run that pipeline. A specced UI 2.0 component set can be the requirements instead of an interview —
`--ui2 <ref>`. A spec is audited against the four codebases **once** before any code, then built **one
app per phase, server before its consumers**, through subagent-driven development with that app's fast
gates at every phase close, then 🔒 **walked by you**: your sign-off condenses the folder (`PLAN.md` and
its SPEC §Plan index go, the SPEC header becomes `✅ SIGNED OFF`), and only then come the one deep verify
pass and **one PR for the whole feature**. Building the feature outranks recording it — git history is
the full record.

## Which command do I run?

| You are… | Run |
|---|---|
| **Any time — "where are things / what's next?"** | `/builder:resume` (no argument: the picker — every in-flight feature and program; pick one and it continues) |
| **Wanting something built, unsure how big it is** | `/builder:brainstorm <what you want>` — it recons, announces a size with its evidence, and takes the matching path. This is the normal way in |
| Sure it's a small change inside one app | `/builder:brainstorm --size sm <what you want>` — recon, ≤3 questions, a design you approve in chat, then built. No docs |
| Sure it's a new feature | `/builder:brainstorm --size md <what you want>` (`--size lg` for a big one; add `--path docs/features/<name>` when you already know the folder) — it designs, writes `SPEC.md` + `MANIFEST.md`, and hands on to `/builder:resume` |
| Building from a UI 2.0 design that is already specced | `/builder:brainstorm --ui2 C-034 <what the work is>` (or `--ui2 home-dashboard` for a whole screen) — the contracts are the requirements |
| Wondering whether a UI 2.0 ref is ready to build from | `/builder:check --ui2 <ref>` — the pre-flight, run as often as you like; it writes nothing |
| Holding a **pre-builder numbered suite** (`01-architecture.md` … `09-gaps-and-decisions.md`) | `/builder:resume --path docs/features/<name>` — it offers the conversion to `SPEC.md` + `MANIFEST.md` and leaves every numbered doc in place |
| Carrying an existing feature forward | `/builder:resume --path docs/features/<name>` — reads its manifest, runs the next step |
| Running one step by hand | `/builder:brainstorm` · `/builder:align` (prototype mode only) · `/builder:audit` · `/builder:plan` · `/builder:build` · `/builder:verify` — each takes `--path <folder>` |
| **You just hands-on tested the finished feature** | `/builder:signoff --path <folder> <your words>` — only you can type it; PASS condenses the folder and unlocks verify + the PR, and `--hold "<reason>"` means "it works, don't push yet" |
| Changing something after the spec exists | `/builder:revise --path <folder> <the change>` — post-build the default is a code fix plus at most one doc line |
| Verify is READY and the PR is open | `/builder:ship --path <folder>` — flips the SPEC header to SHIPPED citing the PR, removes the manifest and the scratch workspace; the commit rides the PR, so the merge carries it |

Flags come first and the free text after them is the work; quote a ref that contains spaces. The whole
family parses the same set — REFERENCE §Flags — plus `--hold`, which only sign-off takes.

**No command here creates a branch, a worktree or a ticket**, and none writes to monday.com — those are
yours. `--ticket <monday id>` only records the key, reads the ticket's dossier
(`docs/monday/tickets/<id>.md`) as design input, and warns if the current branch name doesn't carry it.

## The sizes

The verdict is announced with its evidence before anything is written — "existing admin island, no
schema, no new endpoint, client only, ~8 files — calling this sm; say md if you want a spec" — and
`--size` forces it. It **ratchets up only**: complexity found mid-task stops the work and writes the
spec then; nothing downgrades.

**Two things draw the sm/md line, and neither is file count.** A change that stays inside existing
contracts *and inside one app* is sm however many files it brushes. It earns a spec the moment it adds a
Prisma model, a schema-YAML row, an endpoint, a permission, a route, a screen or a UI 2.0 registry row
— **or the moment it crosses an app boundary**, because the contract between the apps is the thing that
breaks, and it breaks in a shipped iPhone build that cannot be hot-fixed. What each size looks like and
what it writes: REFERENCE §Sizes. The five questions behind the verdict: REFERENCE §The classifier. A
feasibility question ("can we…") is a spike, not a build — it goes to `superpowers:brainstorming`.

## The order (md and lg)

```
design → (align) → audit (1 pass) → [decisions] → plan → [go-ahead] → build (one app per phase)
              ↑ prototype mode only
   → 🔒 your walk + /builder:signoff (condenses) → verify (the ONE deep pass) → ship
   → the PR merges on GitHub → /builder:ship flips the header to SHIPPED
```

**The walk is you, in the running app — or apps.** When the last phase lands, the pipeline runs the
fast gates, prints a script the build wrote — **per app**, since a four-app feature is walked in two or
three places: the URL or the simulator screen, what to tap, what to look for, and the local facts you
need (which port; SMS codes come from the api container logs, never a database reset) — and stops.
Nothing moves until you have tried it and typed `/builder:signoff`.

The walk precedes verify on purpose: the deep pass needs the server, the client, a simulator and the
capture stack up at once, so it runs once, on a build a human has already accepted. `align` exists only
in prototype mode — it traces every field the design persists to a real Prisma column, endpoint and
`AppState` property.

## The monorepo rules (what this pipeline has that a single-app one doesn't)

1. **§Apps — every app gets a row, including the ones it doesn't touch.** An omission you can read is a
   decision; a missing row is an oversight. A ⬜ row states why not in one line, and the audit checks
   that claim — a wrong "not affected" is the most expensive finding here, because it ships.
2. **§Contract — one endpoint table both consumers code against**, and every row names at least one
   consumer. 🔴 **It FREEZES when the server phase verifies.** From then on the client and iPhone
   phases code against it; a consumer that needs a different shape goes through `/builder:revise`,
   which re-opens the freeze deliberately.
3. **One app per phase, server before its consumers.** Each app's gates are different commands, so a
   two-app phase cannot be gated — and the client and iPhone phases are parallelizable because they
   never import each other.
4. **The iPhone half of the PR lock is stricter.** Committing iPhone code, launching the simulator and
   archiving are explicit user calls at every size and under every flag.

`node .claude/scripts/check-flow-obligations.mjs <feature>` is what turns rules 1 and 2 from habits
into a gate: it fails on a missing app row, an in-scope app with no section, and a contract row with no
consumer.

## The human gates (three, plus the PR lock)

1. **Decisions gate** — the OPEN rows in SPEC §Decisions, asked in one message, recommendation first.
2. **Build go-ahead** — one approval of `PLAN.md`'s `## Phases` table, taken at the end of
   `/builder:plan` (or by `/builder:build` before its first dispatch when the plan step ended without
   it). One artifact, one approval — an approved design is not re-approved as a plan.
3. 🔒 **The PR lock** — nothing moves toward a PR until you have personally exercised the finished
   feature in the running app and said, in your own words, that it works. A green gate run, a clean
   `/compare` diff or a code review is evidence for you, never your sign-off. Spend it with
   `/builder:signoff`; *"it works"* and *"open the PR"* are two different permissions.

Otherwise the pipeline keeps working instead of stopping to ask. **`--auto`** takes the recommended
answer at each decision gate and runs until the walk script is printed — **the walk is its terminal
state**, and no flag passes the PR lock or commits iPhone code. Autopilot rulings are marked
`auto (recommended)` for you to read at the go-ahead.

## Resuming

**The manifest is the resume point.** `docs/features/<feature>/MANIFEST.md` is ~12 lines, commits at
every transition, and its `next:` line names the one command that does the next work (REFERENCE
§MANIFEST.md). Every step ends with the same footer, which is that line:

```
📍 <feature>: <state> — next: <command>
```

**The plan is committed beside it.** `/builder:plan` writes `docs/features/<feature>/PLAN.md` — a
`## Phases` table with an `App` column, then one block per task carrying its code — which you read at
the go-ahead and `/builder:build` executes task by task; on a PASS the sign-off condense deletes it
along with the SPEC's §Plan index, and `git log` keeps it (REFERENCE §PLAN.md).

After any `/clear`: `/builder:resume --path docs/features/<feature>`. Status of everything:
`node .claude/scripts/list-feature-specs.mjs`. Process scratch — the task briefs, the ledger, the walk
script — lives in a git-ignored workspace whose path `.claude/scripts/build-spec-workspace.sh <feature>`
prints; it is never something you have to read.

## FAQ

- **Can it one-shot a feature?** xs and sm, yes — once you have approved the design in chat. md and lg,
  no: one app at a time, that app's gates fresh at each phase close, your walk before the deep pass.
- **Where is the plan — and where did the code steps go?** Into `docs/features/<feature>/PLAN.md`,
  committed beside the SPEC in superpowers' `writing-plans` format: a `## Phases` table, then one block
  per task naming its app, its files and the recipe skill to read first, with bite-sized steps carrying
  the actual code, its test, the command to run and the commit. SPEC §Plan is only the index — one line
  per task. Both go at sign-off.
- **Where's the cross-app E2E walk?** Once, in `/builder:verify`, after your sign-off. Never per phase:
  it needs every app up at once, which is the slowest and most fragile thing here, and the phases under
  it are already covered in seconds by route, service and component tests plus `/compare` diffs.
- **What happened to `/build-spec`?** This replaced it (2026-09-24). The four-app knowledge it carried
  — the per-app impact table, the contract freeze, the per-app gates, the environment landmines — is in
  REFERENCE; the ceremony it carried (15+ numbered docs per feature, kept in sync by hand) is gone.
  An existing numbered suite is converted, not rewritten: `/builder:resume --path <folder>` offers the
  conversion and leaves every numbered doc on disk.
- **The audit found problems.** Normal — they become §Findings rows and in-place spec fixes. It is
  capped at **one pass** (a scoped second only when pass 1 changed a contract); anything still
  uncertain rides into the build as a named `build-time risk`. Re-reading prose was measured to find
  nothing that running the software finds.
- **A small change after the build?** Fix the code. A doc line only if a human ruled on it, or an
  un-built task depends on it. No fan-out, no re-audit — `/builder:revise` exists for the contract
  change that un-built work needs, not for every edit.
- **My walk found problems — where do they go?** Into `## Fixes`, the SPEC's last section: `- [ ]`
  tasks worked like build tasks in the main context (recipe skill read first, its test shipping with
  it, one commit each, **each naming its app**), ticking each box as it lands. Then you re-walk what
  changed and type `/builder:signoff` again. A verify INCOMPLETE fills the same list and ends at a
  scoped re-verify. Anything bigger than a task — a changed contract, a reversed ruling — goes through
  `/builder:revise --path <folder>` first.
- **What stops a shipped feature being rebuilt?** The SPEC header. `✅ SHIPPED` means done and every
  command in the family refuses to run on it; follow-on work is a new feature. `✅ SIGNED OFF` is *not*
  done — verify and the PR still run against it (REFERENCE §Condense).
- **How does it get merged?** On GitHub, and only there. `gh pr create --base main` opens **one** PR for
  the whole feature; `/builder:ship --path <folder>` writes the SHIPPED header on that open PR; CI runs
  (`/monitor-ci`); you merge it on GitHub.
- **Does it touch the UI 2.0 specs?** It **reads** them and never writes them. A gap in a contract,
  registry row or note is routed to the command that owns it — `/ui2-component-update`, `/ui2-resolve`,
  `/d2m-notes-assimilate` — because a note is normative owner input, read with
  `node capture/lib/ui2-notes.mjs read`.
- **Does it update the monday ticket?** No. `/monday-resolve` is the explicit call that does.
- **Does it deploy?** Never. `/deploy` is always your own explicit command.
