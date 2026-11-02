# Vertical slices and executable tasks

Borrow the useful unit from decompose-into-slices: a slice delivers a narrow observable outcome through all relevant layers. Several app-specific phases may belong to one slice. This preserves Builder's producer-first and one-app-per-phase ownership without turning the feature into "all schemas, then all APIs, then all UI" as its only plan.

Put the hardest uncertainty on the earliest working path. Each slice has ID, outcome/demo line, acceptance IDs, risk, dependencies, and proof. `depends:[]` is an explicit startable node; dependency graph must be acyclic. Name produced/consumed interfaces and invariants at boundaries. For a build crossing runtime/app boundaries, include final assembled-system integration proof. A research spike is labeled as such and must produce an executable decision or experiment before its dependent build can start.

**Read the audit's code map first.** The audit leaves `.builder/<feature>/audit-digest.md` (discovery.md §Alignment and audit): where the code this feature builds on lives and what is there. Open a file to cite `file:line`, not to rediscover what the audit already read. No map (an audit from before it existed) → read the code as before.

Discuss a consequential scope/decomposition tradeoff when needed. Do not force another approval ceremony if the user's authorization already covers the settled scope and plan.

**The go-ahead.** Show, in the chat: a one-part recap of what is being built and what the audit and the decisions gate changed since the owner approved the design; then the plan as **slices** — each task numbered, grouped by app, with the tests it adds; then the recommended test plan (profiles.md) in one line — its label (`none · end`: how much an agent walks · when it is reviewed) and what it costs for this plan (`profile.mjs --cost`: reviews and the walk) — and why, when a signal raised the walk. Say that the tests themselves run either way: the verifier tests every commit, waits at each phase close and runs every suite on the merged result. Then `A. Build it with this plan` (go) · `B. Change the test plan` · `C. Keep planning`. B asks the two levers as two questions — **Agent walk** (none · the risky parts · all of it) and **Review** (once at the end · once per app · after every slice) — each option leading with what it costs for this plan; on a feature with a released consumer or a breaking schema change, the no-walk option warns that no agent walks it before it lands (it warns, never refuses). Record the choice with `lifecycle.mjs approve <feature> --tests "walk=<v> review=<v>"` and carry on. When the user already authorized the whole build, show the go-ahead and proceed without waiting; under `--auto` or an agent handoff record the recommendation and print nothing more.

**Build here (`build: here`).** Choosing *here* was the go-ahead: present the Phases table and what rides along, record `go-ahead: <who YYYY-MM-DD> (here)` in the manifest, commit `chore(<feature>): <feature> — go-ahead (here)`, and continue straight into execution.md §Build here in the same turn. No profile choice, worker dispatch or landing question. Under `--agent-walk`, `build: here` is ignored.

## PLAN.md structure

Retain the plan through verification and delivery; never delete it at sign-off. It is recovery evidence when task reports disappear.

Start with goal, SPEC pointer, architecture, global constraints, and these tables:

```markdown
## Slices

| Slice | Outcome / demo | Acceptance | Risk | Depends | Proof |
|---|---|---|---|---|---|
| S01 | User submits one valid item and sees the saved result | A1 | high | [] | API + UI integration |

## Phases

| Phase | Slice | App | Tasks | Goal |
|---|---|---|---|---|
| 1 | S01 | producer | 1–2 | Save and return the exact contracted item |
| 2 | S01 | consumer | 3 | Submit and display saved item |

## Proof strategy

Map acceptance IDs to tasks, slice demos, and final integrated scenarios. Identify the checks that must run after assembling every app.
```

Then contiguous task blocks, globally numbered.

**The plan carries decisions, not bodies.** Each task is executed by a fresh worker that sees only its own block plus its brief. What it cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove the task. A step is done when the worker can write exactly one reasonable thing from it. A task has six parts:

1. **Files** — each path with its one responsibility (create, modify, test).
2. **Interfaces** — what it consumes from earlier tasks and what it produces: exact names in backticks, parameters and return types in words.
3. **Behaviour** — one rule per line, each citing the decision behind it (`D3`, a findings row `T2`, a schema change `SC1`, or a global constraint).
4. **Tests** — each test's name and what it proves, then its assertions **as code** with the spec's exact values. The plan pins what each test checks; the worker does not decide it. Every Behaviour line has a test that would fail without it.
5. **Pattern** (optional) — `file:line` of similar code to follow, never pasted code.
6. **Steps** — the red-green cycle with commands: write the listed tests, run them and watch them fail, implement to the Behaviour, run them and watch them pass, commit.

```markdown
### Task 1: <independently verifiable deliverable>
App: <configured app>
Phase: 1
Slice: S01
Depends: []
Acceptance: A1
Recipe: <relevant project skill path or named workflow>
Role: implementation

**Files:**
- Create: `exact/path/file.ts` — <its one responsibility>
- Test: `tests/exact/path/file.test.ts` — <what it covers>

**Interfaces:**
- Consumes: <names from earlier tasks, in backticks, types in words>
- Produces: `parseTags` — takes the raw tag string, returns the normalised tags

**Behaviour:**
- tags are trimmed and lower-cased; duplicates collapse to one (D3)

**Pattern:**
- `path/to/similar.ts:40` — <what to follow>

**Tests:**
- `parseTags collapses duplicates after normalising` — " Work, work " gives one tag (D3)
  (followed by its assertions in a fenced block)

**Steps:**
1. Write the listed tests.
2. Run `<command>` and watch them fail.
3. Implement `parseTags` to the Behaviour.
4. Run `<command>` and watch them pass.
5. Commit — project convention; staged only where the app is `commit: manual`.
```

**Code appears in a task only where the plan must be opinionated** — where a wrong body could still pass the tests — and nowhere else:

- **exact copy the spec fixes** — a message, a config value, a regex;
- **a migration** — its DDL and any backfill (nullability, defaults, foreign-key on-delete, unique constraints, indexes);
- **the frozen contract** — the cross-app wire type, schema or event shape, verbatim from SPEC §Contract, under the producing task's Interfaces (a consumer names it instead);
- **an algorithm the signature and tests don't determine** — a ranking, a parser, a state machine, a retry or locking rule, a transaction boundary;
- **a security-sensitive mechanism** — who may do what, constant-time comparison, hashing and token parameters, and exactly which fields a public response exposes.

A body the signature and tests already determine is a transcript: replace it with words. Never write placeholders (`TBD`, "add appropriate error handling", "write tests for the above", "similar to Task N"), a Behaviour line with no decision behind it, or an Interfaces name the worker cannot find in any task.

Each task owns one app and an independently reviewable deliverable — **a task touches exactly one app**, because the verifier's phase tier waits on one app per phase, and a phase touching two apps makes that wait cover neither cleanly. Fold scaffolding and documentation into the deliverable that needs them. A slice can span apps through multiple tasks; a task cannot cross app boundaries. Reusable shared packages are explicitly configured units or owned by a named app; never hide shared edits under the wrong app. Avoid stale line-number requirements and invented snippets that preclude the project's established abstractions.

Meaningful behavior changes use red-green-refactor when it provides useful contract proof. A reversible wording/style change does not earn a mirrored implementation test. For UI tasks, write the project-required stories before implementation and include the applicable Storybook build. The host's test policy wins.

Keep nothing between task blocks or after the last one: `task-brief` extracts from `### Task N` to the next task heading or EOF. Shared context belongs before Task 1 or in SPEC and is added to each brief deliberately.

## Preflight

Check acceptance coverage, dependency acyclicity, interface parity, one-app ownership (no task's Files cross an app path; every Phases row names one app), every Behaviour line covered by a test, the pinned code limited to the list above, shared dependency impacts, and same-file conflicts. Record specific findings and rulings rather than "plan looks clean." Repair the plan before dispatch. Parallel read-only investigation is useful; writers in the same worktree remain sequential. Small identical mechanical tasks in one app can be one batch, retaining completion evidence per original task.
