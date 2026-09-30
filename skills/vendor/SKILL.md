---
name: vendor
description: Install or update a local copy of this plugin inside the current repo — for a repo whose policy won't accept a plugin fetched from outside it. Copies only what runs (skills, scripts, the template, the licences) into the repo's own plugin folder, registers it in the repo's own marketplace and settings, removes any settings entry naming where the plugin came from, and refuses to finish if anything it wrote still names its source. Re-running it is the update. Use when the user asks to vendor, install locally, copy builder into the repo, or update the repo's local copy of builder.
---

# `/builder:vendor` — a local copy that names nothing outside the repo

Invocation: **`/builder:vendor [--check]`**. `--help` prints this line and stops.

The work is `scripts/vendor.mjs`; this skill finds the newest copy of the plugin to install **from**,
previews, confirms once, runs it and proves the result.

## 1. Refresh, then find the source

The copy is made from this machine's **user-scope plugin install** — never from the repo's own copy
(that would copy it onto itself) — and that install is brought up to the newest release first, so
"already up to date" means up to date with the latest release, not with whatever was last installed.

1. **Find the install.** `claude plugin list --json` → the row whose `id` starts `builder@`, whose
   `scope` is `user`, and whose `installPath` holds `scripts/vendor.mjs` (another plugin that happens
   to be called builder has no `vendor.mjs` — never copy from it). `<marketplace>` is the part of its
   `id` after `@`. **Never hard-code it**, and never pick by sorting folder names: a different
   marketplace's folder can sort after this one's.
2. **Refresh it:**

   ```bash
   claude plugin marketplace update <marketplace>
   claude plugin update builder@<marketplace> --scope user
   ```

   A failure (offline, say) → print it and carry on with the install as it is, saying the copy may
   not be the newest release.
3. **Re-read** `claude plugin list --json`: that row's `installPath` is `<source>`.

No such row → stop: the plugin must be installed at user scope first (`claude plugin install
builder@<marketplace> --scope user`), or cloned, and then `node <clone>/scripts/vendor.mjs <this
repo>` does the same work.

## 2. `--check`

Refresh the marketplace only (step 1's first command, not the second), then
`node <source>/scripts/vendor.mjs "$(git rev-parse --show-toplevel)" --check` — print it verbatim.
Then compare the repo's version with the refreshed marketplace's
(`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/<marketplace>/.claude-plugin/plugin.json`)
and say whether a newer release is out. Stop.

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
Restart Claude Code in this repo afterwards so the new copy loads. From then on, `/builder:status`
and `/builder:resume` in this repo print a ⬆️ line whenever a newer release is on this machine — the
cue to run this again.

~~~
📍 builder <version> vendored into <folder> — clean — next: review git status, commit, restart Claude Code
~~~
