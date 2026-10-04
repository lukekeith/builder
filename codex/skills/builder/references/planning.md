# Vertical slices and executable tasks

Borrow the useful unit from decompose-into-slices: a slice delivers a narrow observable outcome through all relevant layers. Several app-specific phases may belong to one slice. This preserves Builder's producer-first and app-gate ownership without turning the feature into "all schemas, then all APIs, then all UI" as its only plan.

Put the hardest uncertainty on the earliest working path. Each slice has ID, outcome/demo line, acceptance IDs, risk, dependencies, and proof. `depends:[]` is an explicit startable node; dependency graph must be acyclic. Name produced/consumed interfaces and invariants at boundaries. For a build crossing runtime/app boundaries, include final assembled-system integration proof. A research spike is labeled as such and must produce an executable decision or experiment before its dependent build can start.

Discuss a consequential scope/decomposition tradeoff when needed. Do not force another approval ceremony if the user's authorization already covers the settled scope and plan. Show the short slice/phase overview and proceed.

## PLAN.md structure

Retain the plan through verification and delivery; never delete it at sign-off. It is recovery evidence when task reports disappear.

Start with goal, SPEC pointer, architecture, global constraints, and these tables:

```markdown
## Slices

| Slice | Outcome / demo | Acceptance | Risk | Depends | Proof |
|---|---|---|---|---|---|
| S01 | User submits one valid item and sees the saved result | A1 | high | [] | API + UI integration |

## Phases

| Phase | Slice | App | Tasks | Goal | Gates |
|---|---|---|---|---|---|
| 1 | S01 | producer | 1–2 | Save and return the exact contracted item | producer fast |
| 2 | S01 | consumer | 3 | Submit and display saved item | consumer fast |

## Proof strategy

Map acceptance IDs to tasks, slice demos, and final integrated scenarios. Identify the checks that must run after assembling every app.
```

Then contiguous task blocks, globally numbered:

```markdown
### Task 1: <independently verifiable deliverable>
App: <configured app>
Phase: 1
Slice: S01
Depends: []
Recipe: <relevant project skill path or named workflow>
Role: implementation

**Files:** exact creation/modification/test paths
**Interfaces:** exact consumed/produced names, types, invariants
**Acceptance:** A1; observable expected behavior and failure case
**Steps:** bounded implementation steps with commands and expected results
**Verification:** focused checks and required build/story checks
**Commit:** project convention; manual if configured
```

Each task owns one app and an independently reviewable deliverable. Fold scaffolding and documentation into the deliverable that needs them. A slice can span apps through multiple tasks; a task cannot cross app boundaries. Reusable shared packages are explicitly configured units or owned by a named app; never hide shared edits under the wrong gate.

Write enough interface and test detail for a fresh worker to implement without guessing. Complete code is appropriate for true mechanical work, but a prose implementation task need not reproduce the whole eventual implementation. Avoid stale line-number requirements and invented snippets that preclude the project's established abstractions.

Meaningful behavior changes use red-green-refactor when it provides useful contract proof. A reversible wording/style change does not earn a mirrored implementation test. For UI tasks, write the project-required stories before implementation and include the applicable Storybook build. The host's test policy wins.

Keep nothing between task blocks or after the last one: `task-brief` extracts from `### Task N` to the next task heading or EOF. Shared context belongs before Task 1 or in SPEC and is added to each brief deliberately.

## Preflight

Check acceptance coverage, dependency acyclicity, interface parity, one-app ownership, app-specific gates, shared dependency impacts, and same-file conflicts. Record specific findings and rulings rather than "plan looks clean." Repair the plan before dispatch. Parallel read-only investigation is useful; writers in the same worktree remain sequential. Small identical mechanical tasks in one app can be one batch, retaining completion evidence per original task.
