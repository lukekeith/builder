# Discovery, specification, audit, and revision

## Understand before sizing

Ground the user's terms in the repository: search existing entities, routes, screens, specs, history, and dependent consumers before asking what they mean. Explain the current behavior and intended outcome in plain words. Separate user decisions, code-established facts, assumptions, and open questions. Ask one consequential question at a time with a recommendation and tradeoffs; continue independent inspection while awaiting answers. Explore alternative approaches only when a real architectural fork exists.

For intake, treat the supplied brief as proposed requirements. Check it against the current implementation, dependencies, permissions, lifecycle, and rollout constraints; preserve settled choices rather than restarting a brainstorming interview. Read a linked input using available tools before attributing facts to it.

## Settle what the record left open — no section approvals

The owner approved the design when the conversation was confirmed. Never present the spec section by section for approval and never ask whether a section is right: approving a summary the owner cannot evaluate protects nothing and costs a stop. Draft every section from the record first, then list **every choice the draft makes that the record's tree never ruled on** — a scope line, a behavior, what an AI or another app may see or do, what is stored, kept or lost — and sort each one:

- **A product choice** changes what the owner sees or can do, what data is kept, overwritten or lost, what an agent or AI may read or change, something made visible or irreversible, or a shape a released consumer depends on. Ask it before writing, as its own decision in the conversation's rounds format: the decision in one plain sentence, why it matters, what it affects, the recommendation with its evidence, and the real alternatives as the options — recommendation first, each saying what picking it does. An approve/change choice is an approval, not a decision; never offer one here. Record the answer in the record's tree with who and when. The owner's own words in the record already answering it means it is settled: no question.
- **An implementation detail** — storage shape, a limit, an error code, a field type, which internal module owns what — is not asked. Write it as a Decisions row marked `(assumed at spec) YYYY-MM-DD` and list it in the closing summary.

Nothing open means no question at all. Pushback at any point amends the record's tree first, then the spec. Under `--auto` every product choice takes its recommendation, recorded `auto (recommended) YYYY-MM-DD`; it never settles a consequential product, security or destructive choice outside the requested scope.

**Close the spec with one plain summary and no question:** where it was written; what it does in two to four plain sentences for the owner (what they will be able to do, not tables or field lists); what it touches, from Apps; the choices settled with them, one line each; the details assumed at spec, one line each so a wrong one is easy to spot; any OPEN decisions with recommendations; for a supplied design, the gap tally (fixed in the design · written into the spec · out of scope). End with `Anything wrong? Just say what — it's revised before anything is built.` and the handoff choices (SKILL.md). A requested build continues without waiting for a reply.

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
