---
name: update
description: Bring the installed /builder plugin up to the newest release — refreshes the marketplace it came from, updates the user-scope install, prints what changed since the version you had, and names any project-scope install that shadows it in this repo. Only for a copy running from a plugin install; a copy vendored into a repo is updated with /builder:vendor, and this skill is not in one. Use when the user asks to update, upgrade or refresh builder, or asks whether builder is on the latest version.
---

# `/builder:update` — take the newest release

Invocation: **`/builder:update [--check]`**. `--help` prints this line and stops. `--check` reports
what an update would do and changes nothing.

## 1. Where this copy runs from

```bash
echo "$CLAUDE_PLUGIN_ROOT"
```

It must sit under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/<marketplace>/builder/<version>`.
Take `<marketplace>` and `<version>` from that path. **Never hard-code the marketplace name.**

Anywhere else → this is not a plugin install: a clone loaded with `--plugin-dir` updates with
`git pull`, and a copy vendored into a repo with `/builder:vendor`. Say which one and stop.

## 2. Update

```bash
claude plugin marketplace update <marketplace>
claude plugin update builder@<marketplace> --scope user
```

`--check` → run only the first one, then read the latest version from
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/<marketplace>/.claude-plugin/plugin.json`
and compare it with `<version>`. Report the two versions and stop.

A failure → print it verbatim and stop. Don't retry with other flags.

## 3. What changed

Already on the latest → say so in one line. Otherwise read `CHANGELOG.md` from the new install's
folder (`claude plugin list --json` → the user-scope `builder@<marketplace>` row's `installPath`) and
summarise every section newer than `<version>` in a few bullets, **breaking changes first**. A major
bump can change what `.claude/builder.md` must hold, so name `/builder:init --update` when one does.
From 3.8.0 a shipped folder lives under `<registry>/_archive/`. When `list-features.mjs --status` ends
with `🔒 N shipped, not shown — … --sweep …`, name `node <builder>/scripts/registry.mjs --sweep` once:
it `git mv`s them and leaves the commit to the human.

## 4. Anything shadowing it here

A project-scope or local-scope install pins its own version, and in its repo it wins over the user
one. From `claude plugin list --json`, take every `builder@…` row whose `scope` isn't `user` and whose
`projectPath` is this repo's top level (`git rev-parse --show-toplevel`) or inside it. For each, say
which version it pins and give the command that removes it:

```bash
claude plugin uninstall builder@<marketplace> --scope <scope>
```

🔴 **Don't run it unasked.** Removing a project-scope install edits the repo's committed
`.claude/settings.json`: ask once (**Remove it** / **Leave it**). A disabled row from another
marketplace is a vendored copy. `/builder:vendor` updates it, and this skill leaves it alone.

## 5. Hand off

~~~
📍 builder <old> → <new> — restart Claude Code to load it
~~~

The running session keeps the old skills until the restart.
