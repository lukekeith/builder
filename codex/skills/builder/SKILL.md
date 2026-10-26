---
name: builder
description: Manage a resumable feature build from concept or written brief through specification, planning, implementation, review, verification, and local delivery. Use to start, resume, revise, inspect, or hand off an entire build with persistent checkpoints, task-specific model routing, and isolated Git worktrees.
---

# Builder for Codex

Own the build until its authorized delivery is complete. State lives in files and Git, never only in chat. Explicit user instructions override this workflow. Keep project rules in the host's AGENTS.md and normative specifications; this plugin supplies process, not project architecture.

Invocation: `$builder brainstorm <idea>`, `$builder spec <feature>`, `$builder version`, `$builder agent <feature>`, `$builder build <feature> [--here]`, `$builder <idea>`, `$builder intake <brief>`, `$builder resume <feature> [--here]`, `$builder status`, `$builder handoff <feature>`, `$builder revise <feature> <change>`, `$builder deliver <feature>`, or `$builder init`. Treat plain-language equivalents the same. Modes include `--auto` (make reversible implementation choices within settled scope) and `--agent-walk` (record agent verification, never human sign-off). Do not infer external publication permission from either flag.

## First action and recovery

Resolve `<plugin>` from this skill's location: two directories above `skills/builder`. Use absolute helper paths and an explicit working directory on every tool call. Never depend on a plugin environment variable, shell variable from a previous call, or another agent's current directory.

For version, read [version.md](references/version.md). This is read-only and does not start a feature.

For status, run `node <plugin>/scripts/lifecycle.mjs list` from the host repository. Read-only inspection can run in the starting checkout. For new work, inspect relevant instructions and existing implementations, then run `node <plugin>/scripts/lifecycle.mjs start <feature>` **before any repository edit**, including configuration, conversation notes, spec, or plan. Continue all edits and checks in the returned worktree. Choose the landing target before start: explicit --into, configured merge_into, configured base_branch, then the starting branch if no target was configured. Pass --into when explicitly chosen. The helper captures that target and creates the feature from its committed tip; later checkout/config changes cannot retarget it. Uncommitted starting-checkout changes remain there. If the feature needs those changes, resolve that dependency explicitly rather than copying or stashing them.

For existing work, run `node <plugin>/scripts/lifecycle.mjs resume <feature>` from any worktree of that repository. Read MANIFEST.md, continue.md, and the latest ledger summary at the returned featurePath. Reconcile their task statuses and commit ranges against Git before dispatching. Resume the first incomplete action; do not repeat completed implementations or reviews. If runtime metadata is unavailable, use the tracked manifest's branch, origin, target and target-start-head records to reconstruct identity explicitly before proceeding. Do not invent the starting branch from the current checkout.

Immediately after start, persist the user's intended outcome, settled constraints, and current next action in the feature folder, then checkpoint exploring. Do this before prolonged discovery or delegation so clearing context cannot lose the concept itself.

## Route by current phase

Read only the reference needed now:

- Brainstorm or a new idea: [conversation.md](references/conversation.md), then discovery only when writing a spec.
- Intake: [conversation.md](references/conversation.md) for claim verification, then discovery when writing a spec.
- Spec, alignment, audit, sizing, or revisions: [discovery.md](references/discovery.md).
- Plan and dependency graph: [planning.md](references/planning.md).
- Build preferences, agent handoff, profile/target choice and estimates: [profiles.md](references/profiles.md).
- Build, task review, fix loop, and model allocation: [execution.md](references/execution.md) and [models.md](references/models.md).
- Every checkpoint, pause, and cold resume: [persistence.md](references/persistence.md).
- Walk, sign-off, final acceptance, merge, and cleanup: [delivery.md](references/delivery.md).

**Handoff choices.** A handoff about one feature in spec through verified that would continue (or names the walk) reads as a decision, not a list of commands. Above the options: `Full spec: <path>` and the one command to keep — `Pick up where you left off any time: $builder resume <feature>` — for when the session ends or the user wants to spec several features before building any. Then the ways through, numbered in this order, only those that apply, each explained in plain words for the feature's state and carrying no command:

1. **Agent** · `agent` — Codex workers carry it to merged on their own and the user gets the review of what landed; offered only when the config has an `agent_walk` block. It lands on this machine marked *agent-tested, not human-tested*.
2. **Step by step** · `resume` — carry on here one step at a time, pausing at each decision and for the user's walk (`$builder resume <feature> [--here]` resumes it later).
3. **In this session** · `here` — only before the build starts (spec, aligned, audited, planned): audit and plan what is still to come, then build it right here without workers or reviewer agents.

"go" is option 1 — so where Agent is offered, "go" hands the feature to the workers; say so in the option's line. A reply can also name the option (`agent`, `step by step` / `resume`, `in this session` / `here`). With one option left, name just that. Choosing `here` runs `lifecycle.mjs here <feature>` (it records `build: here`), then routes as usual: audit, decisions gate and plan run in full; execution.md §Build here does the build. Not numbered under `--agent-walk`, before a spec exists, or after landing.

**Pickers and lists.** Where a choice uses the client's question tool, the text above it explains each option — its label in bold as the picker shows it, what it does, what it is good at, what it costs — and why the recommended one is first; never a lettered list or a "reply …" line beside a picker, and never an option for "answer below". A lettered list (`A. … (recommended)` · `B. …`) appears only where the reply is typed in chat, and "go" is A.

**Reviews, not file paths.** Every approval shows what is being approved in the chat, in plain words with the product's own names: what changes for users (before → after, who), what they will see (an ASCII sketch when a layout changes), added · changed · removed, data and migrations (can they be undone?), each app (and what a released app's users see before they update), the decisions with what lost and the assumed ones marked `(assumed)`, risks and open questions, and what is not included. A file path is only a reference line under it. Over ~40 lines, split it into parts (*Part 1 of 3 — What users get* · *Part 2 — Data and apps* · *Part 3 — Decisions and risks*), each ending `A. Looks right — next part` · `B. Change something — say what`; a change is applied and that part shown again. Under `--auto` or an agent handoff nothing is asked, so no review is printed then; the review of **what was built** appears where the user next looks — the walk handoff, or the delivery report, autopilot rulings marked `(auto)`. Unattended steps end in at most six lines.

Lifecycle: exploring → spec → aligned (when relevant) → audited → planned → building → built → signed-off → verified → merged. A skipped irrelevant phase is recorded with its reason. State cannot advance past missing required evidence. A hold or blocked record names its cause, owner, and next action; continue independent startable work when possible.

## Project binding

Read configuration in order: `.codex/builder.md`, `.builder/config.md`, then existing `.claude/builder.md`. The **first existing file** is authoritative; malformed configuration is an error, never permission to fall through. Reuse the existing config without migrating it merely for naming. New config uses [../../assets/PROJECT.template.md](../../assets/PROJECT.template.md), inferred from repository layout, scripts, CI, and conventions, and is written only in the feature worktree. Verify with the bundled config loader. Read the project facts, app roles, gates, commit policy, companion skills, environment constraints and §Standing traps before planning.

`$builder init` always writes the `agent_walk:` block — asking only how a worker drives the app and how an isolated walk environment starts — because without it the repo has no agent mode (no Agent option, `$builder agent` refuses); it is left out only when the owner says agents should never run there. An update to an existing config treats a missing block as the biggest gap. Init also offers the walk environment its own build output folder when a Next.js, Nuxt, SvelteKit or Rails app would share one with its build, suggests a smoke check that proves sign-in can work (a CORS preflight, not only `/health`), marks type-check lines `@typecheck` and tags e2e lines that need the running app `@walk`.

**The config is the owner's.** Workers and the coordinator under `--auto` or an agent handoff never edit the project config. A fix that needs a config change stops as a human step with the exact diff in the park record (persistence.md); a feature branch that changed the config is not delivered until the owner has seen it.

Load the relevant project skills by path or invocation when their work applies. Each project's own rules apply — required skills, story-first development, mandatory checks — as its instructions say. No dependency on GSD or Superpowers installation is required.

## Orchestration and delivery authority

This skill explicitly requests task-scoped subagent delegation when available. The coordinator owns sequencing, durable checkpoints, reviews, and integration. Workers receive isolated task briefs and explicit model/effort settings, never the full conversation; they may not spawn workers, change branches, merge, push, or publish. Serialize writers within a shared worktree. Parallelize independent read-only investigations; parallel feature builds require separate worktrees and isolated external resources.

Keep going across routine phase boundaries under existing authorization. Ask only for material missing product decisions or a genuinely unapproved action; do not add repetitive plan/sign-off approvals to an already authorized build. Manual-commit policies and explicit human walks remain binding. Delivery is a verified **local merge into the immutable recorded target**, following the repository's branch policy. PR, push, deploy, ticket writes, and publishing occur only when requested or already authorized. A repository that requires a reviewed PR for the captured target ends at a concrete verified review branch until that condition is met.

Before ending any unfinished turn, update persistent state and give `$builder resume <feature>` plus the next concrete action. Do not stop at a plan or partial implementation when the user authorized the complete build.
