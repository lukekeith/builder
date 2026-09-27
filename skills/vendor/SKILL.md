---
name: vendor
description: Install or update a local copy of this plugin inside the current repo — for a repo whose policy won't accept a plugin fetched from outside it. Copies only what runs (skills, scripts, the template, the licences) into the repo's own plugin folder, registers it in the repo's own marketplace and settings, removes any settings entry naming where the plugin came from, and refuses to finish if anything it wrote still names its source. Re-running it is the update. Use when the user asks to vendor, install locally, copy builder into the repo, or update the repo's local copy of builder.
---

# `/builder:vendor` — a local copy that names nothing outside the repo

Invocation: **`/builder:vendor [--check]`**. `--help` prints this line and stops.

The work is `scripts/vendor.mjs`; this skill finds the newest copy of the plugin to install **from**,
previews, confirms once, runs it and proves the result.

## 1. Where to install from

The copy is made from a plugin install on this machine, never from the repo's own copy (that would
copy it onto itself). The newest one:

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/builder/*/ 2>/dev/null | sort -V | tail -1
```

Call it `<source>`. None → stop: the plugin must be installed at user scope first (`claude plugin
install`), or cloned, and then `node <clone>/scripts/vendor.mjs <this repo>` does the same work. To
take a newer release first, update that user-scope install (`claude plugin update … --scope user`)
and run this again.

## 2. `--check`

`node <source>/scripts/vendor.mjs "$(git rev-parse --show-toplevel)" --check` — print it verbatim
and stop. It says which version the repo carries, whether anything names its source, and whether
`<source>` is newer.

## 3. Preview

```bash
node <source>/scripts/vendor.mjs "$(git rev-parse --show-toplevel)" --dry-run
```

Print it verbatim. `+` is a new file, `~` a changed one, `-` a file the new version dropped (the
copy is replaced whole — local edits inside it are lost; project facts belong in
`.claude/builder.md`, which this never touches). **It refuses when the copy would name its source**
— show the lines it names and stop; that is a fix in the plugin, not here. "already up to date" →
say so and stop.

## 4. Confirm, run, prove

One AskUserQuestion — **Install** / **Not now** — restating the version change, the folder, and the
file counts. Then run the same command without `--dry-run`, then `--check`. Show `git status
--short` for what changed.

**Never commit.** The repo's own commit conventions apply; suggest a subject such as
`chore: vendor builder <version>`. If `.claude/builder.md` is missing, name `/builder:init` next.
Restart Claude Code in this repo afterwards so the new copy loads.

~~~
📍 builder <version> vendored into <folder> — clean — next: review git status, commit, restart Claude Code
~~~
