# Build profiles and agent execution

Read this before delegating an agent handoff, even when PLAN.md does not exist; otherwise read it after scope/plan are settled and before implementation. `$builder agent <feature>` hands an existing approved feature to Codex workers; `$builder build <feature>` and resume follow the recorded profile. The helpers use Codex's native subagent tools, not a Claude fleet process. Never invoke `claude -p` to implement this workflow. A configured agent_walk means implementation is delegated where supported; the coordinator owns integration, proof and checkpoints. If delegation is unavailable, disclose the limitation and continue within the user's authorization rather than claim an agent build occurred.

## Select and record

Run `node <plugin>/scripts/profile.mjs --recommend <featurePath> --root <host-repo>` and `--estimate <featurePath> --root <host-repo> --profile <name>`. A valid build_profile_default influences the recommendation; report an invalid setting once at selection/init rather than on every status read. Schema changes, migrations, released consumers and role/permission/owner/scope/delete changes recommend Thorough. A merely signed-in endpoint is not an elevated permission boundary.

When preferences are missing and a user choice would materially improve the build, ask once for profile and target together, recommendation first. Use any profile/target already requested. Do not insert another approval when an authorized build can proceed with configured/default preferences: record the choice and its reason. Profiles are `rush`, `standard`, `thorough`, `thorough-you`, or `custom key=value ...`. Customize exposes stronger models and a second independent reviewer. Thorough-you reserves an actual human walk; ask about that only if it is not already known. Legacy work without profile remains Thorough.

Choose the target before starting the isolated feature: explicit `--into` wins over configured merge_into, then configured base_branch; without those retain the originating branch. Start with `lifecycle.mjs start <feature> --into <target>`; preserve target identity on resume. Do not retarget an existing build by changing configuration. For an existing build recommend its recorded target. A different requested target requires explicit recovery/new identity, not mutation of the old landing transaction.

When the spec/plan was committed on another branch, start brings the committed planning artifacts into the target-based feature worktree; source code and source manifest identity are excluded. A failed or interrupted transfer blocks build approval. After resolving the recorded cause, run `lifecycle.mjs retry-import <feature>`; it preserves changed user files and refuses conflicts instead of overwriting them.

Once ready to build, persist `lifecycle.mjs approve <feature> --profile <value> --into <captured-target>`. Read profile.mjs `--levers` from the feature folder for the effective settings. approval records preferences and never supplies verification or human sign-off evidence.

For `$builder agent`, resolve missing profile preferences and the immutable landing target before any worker begins planning or implementation. Under `--auto`, record the recommendation and explain it briefly. Keep explicitly recorded preferences through later headless go-ahead; never replace them with new defaults. A feature without PLAN.md has no task count, so its estimate is null and profile options use qualitative descriptions. An existing legacy feature without preferences retains Thorough unless the user selects another profile. Resume uses the original feature worktree; write its live artifacts there.

## What the profile changes

| Profile | Additional tests | Independent review | Final acceptance |
|---|---|---|---|
| Rush | No new optional tests; required/project tests still run | Whole-feature final review | Required acceptance and verification floors |
| Standard | Add tests for risk-bearing behavior | Every task | Full spec acceptance and required deep checks |
| Thorough | Full relevant test coverage | Every task | Full walk and all applicable deep verification |
| Thorough + you | Same as Thorough | Every task | Human walk before landing, plus required verification |

Every profile retains app fast gates, independent final review, released-consumer compatibility, project-mandated tests/lint/build/Storybook, security/contract obligations, durable resumable identity, and fresh integration-candidate verification. Optional tests can vary; proof required by the spec cannot be waived. Customize `review=per-task+second` adds a second independent reviewer for contract/schema tasks. `testing=full+human` requires a human walk even with a custom profile. `models=strong` escalates through route.mjs; `economy` selects economical workers only where the established role floor permits it. Never downgrade a required judgment model silently.

`unruled=recommend` allows reversible recommendations within settled scope; a consequential open product/security/destructive decision remains unresolved. `unruled=park` records the decision for its owner. `persist=low` reduces narrative, not checkpoints or completion evidence. `landing=local` never grants push, PR, deploy or publication permission.

## Revisions, human walks and recovery

Pause runtime with `lifecycle.mjs pause <feature>` before interrupting its active writers. Stop further dispatch and landing. Read reports and inspect partial edits before applying the revision. Reconcile spec and plan, invalidate affected completed tasks/proof, then unpause explicitly and requeue the first affected action using Codex workers. Never reuse a paused candidate or let checkpoint clear the pause. Do not start another writer before the previous one stops.

A human walk is a per-feature wait, not a global agent stop. Run `lifecycle.mjs await-human <feature>` and persist the exact feature worktree/resume instructions; retain that worktree. Continue other authorized independent features when possible. Do not auto-unpark a human step or treat “go” as a human PASS. Commit code and tracked preparation evidence before the human walk; the report is tied to that exact HEAD. A later code change requires another walk. After receiving the actual human PASS, run `lifecycle.mjs human-pass <feature> --report "<concise actual report>"`; this clears only that feature's human wait and requires fresh checks. Resume that feature and rerun proof invalidated by fixes.

Codex native workers are session-owned. A context handoff resumes from durable files; it does not keep a detached fleet running. Do not claim unattended execution survives termination of the Codex session. Record interrupted worker/job ownership and next action so a new session can resume without redispatching completed tasks.

## History and estimates

After a successful landing, run `history.mjs record <feature> --root <host-repo>` before cleanup, optionally with `--metrics <actual-measurements.json>`. Measurements contain tokens.input/output, cost, and lane durations in milliseconds only when the runtime actually provides them. Unknown values remain null; never synthesize tokens or cost. History is machine-local in Git-common builder-codex/archive.jsonl and shared across worktrees. Estimates use at least three comparable usable landings with the same profile, scale by plan tasks, and show sample count. Label them history-based estimates, not guarantees. No adequate data means no numerical estimate.

Status reads lifecycle list and shows profile (legacy Thorough), target, phase, pause/human wait and next action for each feature. A merged result is terminal: do not launch it again from a stale branch. Report its target and tell the user how to bring that target into their branch; do not perform an unrelated merge merely to tidy status.
