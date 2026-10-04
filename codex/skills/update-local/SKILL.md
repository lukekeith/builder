---
name: update-local
description: Install or refresh Codex Builder in local projects, matching Claude Builder's local rollout with a shared user install and a protected vendored copy. Use when asked to update local Builder repos or install the Codex release in other projects.
---

# Update local Codex Builder consumers

Resolve `<plugin>` two directories above this skill folder. Run `node <plugin>/scripts/update-local.mjs --dry-run` and show the table. Then run the same command without `--dry-run` for an authorized rollout. A request to update local repos authorizes the listed reversible installation changes; do not insert another approval unless project instructions reserve it.

The default list matches the Claude maintainer's local rollout: `~/www/d2m`, `~/www/fai-cd`, `~/www/finpro`, `~/www/makeready`, `~/www/fai-erp`. Four use one machine-level `builder@builder-codex` install; finpro vendors the runtime in its own repository. Read relevant host instructions before writing there. Never commit in consumer projects. Keep project facts in the existing Builder configuration.

Customize the list in `~/.codex/builder-local.json` or use `--repos <json-file>` with `{ "repos": [{ "name": "my-project", "path": "/absolute/project", "mode": "plugin" }] }`. Vendor mode is `"vendor"`. To test a local build use `--source /absolute/builder-repo`; default source is the published `lukekeith/builder` marketplace on main. `--check` performs no installation or host writes and exits nonzero for stale/missing copies or possible project shadowing.

The updater registers/refreshes the Codex marketplace and re-adds Builder using supported CLI commands. Moving from a known local marketplace to the published source switches only the builder-codex registration, restoring it if registration fails. Other source conflicts need an explicit switch. Stop on global installation failure; never silently carry on using an old version. The table identifies project-local Builder catalogs and disabled global entries, which need inspection before assuming the user install will load.

Vendor updates use the host's `.agents/plugins/marketplace.json` path or `plugins/builder-codex`, enable its own marketplace in `.codex/config.toml`, and disable the global family in that host. Runtime-only copies exclude release, sync and rollout tools and personal/source repository metadata. Copies are replaced whole so deleted files disappear. Existing unrelated destinations, traversal and symlinks are rejected. Locally modified or uncommitted vendor files are skipped; `--force` overwrites only on the user's explicit instruction. Report each failure and the suggested `chore: vendor Codex Builder <version>` subject without committing.

End with the actual installed version and restart/new-session reminder. Do not claim the current session has reloaded. `$sync` migrates and releases features; this command only rolls an existing package out locally.
