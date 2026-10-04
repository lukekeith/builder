# Durable checkpoints and cold resume

## Two layers of state

The runtime identity lives under Git's common directory at `builder-codex/features/<feature>.json`. It records originating checkout/branch/SHA, immutable landing target/start SHA, profile, pause/human-wait state, feature worktree and branch, current phase/task/next action, tested feature SHA, and integration candidate. Because every worktree shares this location, a fresh session in the starting checkout can find the build after context clearing. This metadata is machine-local and survives removing ignored scratch files.

The tracked feature folder contains SPEC.md, PLAN.md, MANIFEST.md, ledger.md, and continue.md. It records requirements, task completion ranges, durable decisions, verification summaries, and the next action. Raw logs/diffs can be disposable scratch; **no completed-task identity or unresolved fix exists only in scratch**. Keep the compact current checkpoint separate from append-only progress history. Do not delete PLAN at sign-off.

Runtime metadata is the locator and integration transaction record; SPEC is scope authority; ledger plus Git commits proves task completion. MANIFEST and continue.md are the portable recovery summary. If the locator conflicts with actual Git or tracked evidence, stop dependent actions, reconcile and record the discrepancy; do not choose whichever version permits faster completion.

## Checkpoint moments

Write before a worker dispatch, after its review, at each phase/slice boundary, on a material decision or blocker, before delivery, and before ending an unfinished turn. Preserve identity and completion records even when the current task is mid-fix. Update tracked summaries before the thin handoff.

`node <plugin>/scripts/lifecycle.mjs checkpoint <feature> --phase <phase> --next "<concrete action>" --task "<task ID>"`

Run from a known repository with explicit `--root` where needed. The helper updates MANIFEST in the feature worktree and runtime metadata. Record scope authorization, holds, walk provenance, acceptance coverage, and ledger details in the tracked files. Commit those updates in the worktree where authorized; otherwise identify all uncommitted checkpoint files in the handoff.

After committing final tracked evidence and running required feature checks on that clean HEAD, use:

`node <plugin>/scripts/lifecycle.mjs checkpoint <feature> --phase verified --next "Prepare and verify the merge candidate" --verified-head <full-tested-SHA>`

This verified checkpoint is runtime-only so it cannot dirty the tested tree. MANIFEST's last tracked phase may be signed-off/built; runtime verifiedHead supplies exact verification identity. Report that distinction, rather than writing a new tracked verified claim after testing an earlier commit.

## continue.md: one screenful for a stranger

```markdown
# Continue — <feature> / <slice> / <task>

## Last action
Concrete result, tested commit, commands and outcomes; link to detailed ledger evidence.

## Next action
Exact command or edit. Include its worktree identity and what to do if it fails.

## Why
Reason for that next action and the settled decision it advances.

## Open threads
Pending findings, blockers and owner, modified/untracked files and their purpose,
active jobs/services with owner/PID and cleanup responsibility, required human decisions.

## Do not
Only actual traps, rejected paths, or protected user work discovered in this build.
```

Use repository-relative paths for code and artifacts. Local absolute worktree paths belong in runtime identity, not portable specs. Never include secrets or environment values. Preserve environment facts and important decisions in SPEC/ledger, not only this ephemeral handoff.

Before a deliberate pause, finish or stop only jobs/services this build owns; never kill by broad process-name pattern. A process needed for ongoing work has a documented owner and stop command. Context clearing does not erase Git-common metadata, tracked summaries, or owned-process responsibility.

## Cold read

Read runtime status, MANIFEST, continue.md, and the latest ledger summary. Verify repository/branch, current HEAD, task commit ancestry, dirty files, pending review/fix status, and changed configuration. Completed records whose commits are absent are discrepancies, not permissions to redispatch blindly. If scratch reports vanished, reconstruct from tracked evidence and commit diffs, rerunning only proof that is genuinely missing or invalidated.

For a new clone or lost common metadata, read tracked origin-branch/origin-head/target-branch/target-start-head/profile/branch/registry records and Git history, locate the correct branch/worktree, and reconstruct identity deliberately. For target-based builds, verify feature ancestry against target-start-head; origin-head may belong to an unrelated source branch. Preserve that origin as provenance rather than imposing the legacy origin-ancestry invariant. Do not automatically attach an unrelated checkout or default target. A missing identity blocks merge, but read-only diagnosis and recovery can continue.

Finally cold-read the handoff as someone with no chat history: it must say what to execute next, why, and which work must not be overwritten. `$builder resume <feature>` should suffice in the same local repository.

## Park records and retry

When a build cannot proceed, write PARKED.md in its tracked feature folder before ending the turn. Include the stuck behavior, owner, what was tried, decisive evidence quoted without secrets, where to dig, the recommended next action, and dated retry history. Raw evidence folders may not travel with the branch, so a link alone is insufficient. Distinguish a product decision, an external dependency, and a human step such as protected uncommitted changes or manual commits. Report `<why> — next: <step>` in plain words.

On explicit resume of a parked feature, read PARKED.md first and investigate from its next action. Naming the feature authorizes rechecking the cause, not bypassing a hold, manual commit rule, or missing product decision. Record the retry and preserve the history. Clear the blocker only when evidence shows it is resolved, then checkpoint the actual resumed phase. Do not repeatedly retry a human step or implement an automatic fleet retry policy: this port has no Claude fleet.
