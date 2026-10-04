# Read-only version report

For `$builder version`, run `node <plugin>/scripts/version.mjs --root <plugin>` with the exact root resolved from the skill this session loaded. Do not substitute the newest cache folder: that would hide a stale session. If this session's loaded copy predates this helper, read its plugin.json and run the helper from a known newer source with `--root` still pointing to the loaded copy.

The helper reads only local Codex Builder manifests and never fetches or runs Claude. Pass `--config-dir <Codex configuration root>` if this environment uses a nondefault root. An explicitly known source checkout can be included with `--known-root <checkout>/codex`; do not discover it by crawling unrelated repositories. Report the output and distinguish session-loaded, cached, and known source versions. A cached copy does not prove it is enabled, and local knowledge does not establish the latest remote release.

Do not suggest Claude's `/reload-plugins`, `/builder:update`, or `/builder:vendor` commands in Codex. Updating an installation and starting a new session are separate from this read-only report. `$builder status` and cold resume may show a brief newer-local-copy notice using the same helper when available; this must not block feature work.
