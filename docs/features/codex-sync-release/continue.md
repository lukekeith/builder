# Codex sync, release and local rollout
User wants Claude-first Builder development, one sync workflow that migrates latest Claude features into Codex and releases it, plus Codex update-local equivalent covering Claude's five local consumers.
Starting checkout main b34854b. Target main. Isolated branch builder/codex-sync-release.
Existing port /Users/lukekeith/www/builder-codex-port is branch codex/builder-port with substantial uncommitted 4.9 work. Preserve it; user clarification pending on extending that snapshot. No source files copied yet.
Claude local-only updater: /Users/lukekeith/www/builder/.claude/skills/update-local/{SKILL.md,update-local.mjs}. It uses global plugin mode for d2m, fai-cd, makeready, fai-erp; finpro is vendored.
Next: settle dependency on existing port; bring the port into this integration worktree without changing its source; implement semantic sync skill plus durable upstream delta tracking, verified release helper, marketplace packaging, and local rollout with safe vendor replacement. Version-only sync cannot imply feature parity.

Dependency resolved: snapshot existing Codex package including current uncommitted 4.9 adaptations into this feature worktree; original port untouched. This is an explicit integration snapshot, not staging or committing the source worktree.

Implementation complete pending final review/checks and publication. New sync/release/vendor/update-local helpers and skills, tests and Codex docs live in this worktree. Initial independent review found TOML/source-selection/symlink/tag-race issues; fixed with regressions. Focused tests 15/15 and real isolated Codex CLI install/source-switch/vendor/check passed. No real consumer repository changed. Next: final scoped review, sync finish/full suite, local integration, release and remote install verification.

Final review resolved. Codex 145/145, Claude 370/370, real CLI rollout smoke and skill YAML validation passed. Upstream 4.9.1 coverage/digest recorded. Next: commit, prepare integration candidate, fresh candidate checks, local merge, separate Codex publication, and verify remote-source installation. Source port and real consumers untouched.
