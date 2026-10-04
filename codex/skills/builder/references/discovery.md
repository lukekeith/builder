# Discovery, specification, audit, and revision

## Understand before sizing

Ground the user's terms in the repository: search existing entities, routes, screens, specs, history, and dependent consumers before asking what they mean. Explain the current behavior and intended outcome in plain words. Separate user decisions, code-established facts, assumptions, and open questions. Ask one consequential question at a time with a recommendation and tradeoffs; continue independent inspection while awaiting answers. Explore alternative approaches only when a real architectural fork exists.

For intake, treat the supplied brief as proposed requirements. Check it against the current implementation, dependencies, permissions, lifecycle, and rollout constraints; preserve settled choices rather than restarting a brainstorming interview. Read a linked input using available tools before attributing facts to it.

When presenting a spec for review, explain what changes in plain sentences and call out only choices that change the product or are expensive to undo. Show full tables/types only when useful or requested. Routine plumbing follows settled decisions; do not turn every section into another approval gate.

Persist exploration in the feature folder's brainstorm.md, continue.md and ledger.md. `$builder spec <feature>` reads that conversation record and preserves its rulings, assumptions, reasons, and rejected alternatives; resume the conversation if material decisions remain open. Never leave an unresolved decision exclusively in chat. Once intent is clear and the user has requested building, move directly to the spec. An explicit request to brainstorm only ends at the requested understanding.

## Scale process to the build

All sizes use a worktree, a manifest, a short persistent spec, verification evidence, and local-delivery records. `xs/sm` use a few paragraphs and a short plan; they must still resume after context clearing. `md/lg` use the full applicable sections below. `xl` is a program of child features: PROGRAM.md names children, shared decisions, dependencies, and observable outcomes; each child has its own identity/worktree/checkpoint. Capture the parent's landing target once and create children from that target, not from another child's feature branch. Deliver children in dependency order, then verify the assembled program. Do not multiply documentation for its own sake.

## Value-sized decomposition

When considering a split, always offer One spec for the whole concept and recommend the fewest specs that deliver independently usable outcomes. Explain what a user can do after each child ships. Scaffolding, a data model alone, or an inert UI layer is a task within a feature, not a separately valuable feature. Only independently useful outcomes justify multiple specs; shared plumbing belongs with the first usable outcome. Keep the confirmed concept and its decisions together before proposing children.

## SPEC.md contract

Synthesize established context; do not re-interview or invent risks. Preserve Builder's section names consumed by `check-obligations.mjs`. Add the following outcome and proof fields within them:

- **Idea:** why now, user-visible outcome, literal actions that demonstrate success, existing modules/interfaces to reuse, scope, binding constraints, considered approaches and rationale. Preserve important user wording with pointers to operational decisions. Durable context names modules and interfaces; task plans carry exact paths.
- **Apps:** `| App | In scope | What changes | Section |` with a row for every configured app, including untouched units.
- **Decisions:** `| # | Decision | Ruling | Who / date |`; make rulings specific, scoped, and implementable, with rejected alternatives and their reason. Record assumptions honestly. A consequential OPEN row blocks dependent implementation. Supersede decisions with a dated explanation rather than silently deleting them.
- **Contract:** exact wire/interface shapes, lifecycle invariants, producer and consumers, version/compatibility rules, and how released consumers behave during rollout. Say "No contract change" when true. A producer contract freezes after its phase's successful checks; consumers implement that shape. A revision reopens it explicitly and invalidates dependent proof.
- **Schema & API changes:** `| # | ADD/EDIT/RENAME/REMOVE | Model.field | Wire | Reason | Status |`. Use a no-change statement when appropriate. Include a Data plan for defaults, backfill, deletion, retention, migration ordering, and populated-table changes.
- **One section per in-scope app:** behavior, ownership, failure handling, validation, authorization, retry/idempotency requirements, and integration boundaries actually relevant to this feature.
- **Testing:** completion class (`contract`, `integration`, or `operational`), final integrated acceptance scenarios with IDs, per-app checks, and one assembled-system walk. Contract proof tests observable interfaces; integration proof exercises cooperating real components; operational proof uses the running environment and real dependencies where required. Name what mocks cannot establish. Unavailable mandatory proof remains incomplete.
- **Out of scope:** tempting adjacent changes and explicit non-goals.
- **Findings & risks:** real findings with resolution/owner or a task that retires the uncertainty. Do not use hypothetical audit checklists as filler.
- **Plan:** concise slice index and pointer to PLAN.md, added during planning.

For a supplied design, record Prototype and Replaced surfaces sections when relevant; inspect the design source as requirements. Respect its ownership rules. If a design gap requires a project design skill, route there; do not silently treat missing design as implemented.

## Alignment and audit

Align only when the feature has a normative design/contract source requiring alignment. Audit the settled spec once against actual code: feasibility, coverage, integration seams, permission/data boundaries, migrations, and compatibility. Use focused read-only agents for independent questions, with model routing and a bounded output. Fold their evidence immediately into SPEC, not just a chat recap. Run:

`node <plugin>/scripts/check-obligations.mjs <featurePath>/SPEC.md`

Fix actual gaps and then plan. Avoid repeatedly auditing unchanged decisions. A targeted revision can trigger a scoped audit of affected obligations.

## Revision

Before editing a feature with active workers, pause dispatch and interrupt its writers. Wait until each writer has stopped, read its report, and inspect Git status and owned jobs in the feature worktree. Record completed work and partial edits before applying the revision; never race a coordinator edit against an implementation agent. Pause an in-flight integration or delivery too: a revision requested while waiting to merge invalidates prior approval and candidate proof. This port uses Codex agent controls, not Claude fleet.mjs --pause.

Record the requested change and affected decisions/acceptance IDs. Reconcile SPEC and PLAN together, map completed tasks affected by it, reopen only those tasks/reviews, and invalidate relevant gate/walk/verification evidence. Preserve unaffected completed work. A post-walk revision requires the changed scenario to be walked again. A scope expansion or unresolved product choice may require user input; routine implementation corrections do not.
