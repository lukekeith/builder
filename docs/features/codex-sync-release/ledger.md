# Delivery evidence

Intent: Claude-first Builder maintenance, semantic Codex sync and release, and matching local rollout. Target main, start b34854bea6bfc21681dd289f7093bdecacc6344e. Existing port source worktree remained untouched; integrated snapshot includes its outstanding 4.9 adaptations. No consumer repository was modified.

Design and plan: docs/specs/2026-10-04-codex-sync-release-design.md and docs/plans/2026-10-04-codex-sync-release.md. Separate alignment is irrelevant: no external normative contract beyond the supplied plugin and official Codex packaging format. Ordinary intermediate approval checkpoints were skipped under the user's build/release authorization.

Implementation: self-contained codex/ package plus marketplace, semantic sync workflow and pinned upstream delta/report/digest helper; source-safe shared copy; latest 4.9.1 profile and value-sized split adaptations; clean/pinned release publisher and archive; verified CLI rollout with local-source transition/rollback; host-owned runtime-only vendoring and config protection.

Independent review: standard model gpt-6.1-sol / medium, read-only agent sync_design. Findings fixed: valid TOML forms, dangling symlinks, conflicting registrations, selected runtime identity, stale read-only session source, release HEAD advancement. Scoped re-review: no remaining release blockers. The standard reviewer is appropriate for bounded script contracts; the coordinator retains architecture/integration ownership.

Verification after final package edits:
- Sync finish complete: 145 Codex tests passed, 0 failed. Includes failed verification/baseline protection, complete/stale reports, source/package identity, branch/tree/tag checks and concurrent-main advancement; rollout and vendor regressions.
- Claude suite: 370 tests passed, 0 failed. Claude plugin validation passed with its existing root CLAUDE.md context warning.
- Ruby YAML safe_load validates all three Codex skills' names/descriptions and length. The Python validator was unavailable due missing PyYAML/environment pip issues; no dependency changes made to the project.
- Real Codex CLI under temporary CODEX_HOME registered the marketplace, installed builder@builder-codex 4.9.1 and populated its cache. Actual updater changed from old local-port source to the selected new source, installed and verified exact runtime identity, vendored into a temporary Git host, and passed --check (exit 0). Host/config/source-switch and vendor writes were real; temporary artifacts cleaned.
- Real five-project --dry-run found d2m, fai-cd, finpro, makeready and fai-erp without host writes.
- Upstream source coverage and package digest check passed; git diff --check clean.

Acceptance is agent-tested, not human-tested. No personal human walk was requested for these script workflows. Final candidate checks and external release/install evidence follow in runtime logs and the final report. Any changed package requires finish again before release.
