# Codex sync and release plan

1. Integrate a snapshot of the existing Codex port into an isolated feature branch based on current main. Preserve source worktree and dirty changes. Establish 4.9.0 baseline and map 4.9.1 changes.
2. Implement sync plan/copy/finish/check helpers and the semantic sync skill. Add value-sized decomposition and profile-before-delegation behavior, retaining equivalent lifecycle/estimate protections.
3. Implement pinned release packaging/publication with separate Codex tag/catalog and install documentation.
4. Implement supported-CLI local rollout and runtime-only vendor helper with safe ownership, config preservation and installed-package identity checks.
5. Exercise failure/identity/race/containment contracts with focused tests; run actual Codex CLI in isolated config and temporary host; obtain independent review and fix regressions.
6. Run complete Codex suite and upstream Claude checks on exact integration result. Commit reviewed paths, land locally, publish verified release and confirm remote installation. Do not commit consumer projects or modify original port worktree.
