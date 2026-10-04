# Releasing

1. **Make the change** and update `CHANGELOG.md`.
2. **Bump `version`** in `.claude-plugin/plugin.json`. **Default to a patch** — most releases are
   one:
   - **Patch** (`x.y.Z`) — how an existing skill behaves: a new or changed rule, better prompts or
     question format, a fix, a stricter check, a script improvement, docs.
   - **Minor** (`x.Y.0`) — a new capability a user reaches for by name: a new skill or command, a
     new flag, a new optional config key, a substantially new mode (the scale of `/builder:fleet`).
   - **Major** (`X.0.0`) — **only** when a consumer must act to keep working: a required change to
     `.claude/builder.md`, or a MANIFEST / record / folder format the new version can no longer
     read. A redesigned flow that still reads old folders and configs is not a major.

   When unsure between two, take the smaller.
3. **Validate** — this checks the manifests, and the skills, agents and commands in the tree:

   ```bash
   claude plugin validate .
   ```

4. **Commit, then tag and push:**

   ```bash
   claude plugin tag --push -m "builder %s"
   ```

   It creates `builder--v<version>`, and **refuses unless `plugin.json` and the marketplace entry
   agree** — which is the check that stops a release where one says 2.1.0 and the other 2.0.0. Add
   `--dry-run` first to see what it would tag.

## What consumers do

```bash
claude plugin marketplace update claude-builder   # re-read the marketplace from GitHub
claude plugin update builder                      # take the new version (restart to apply)
```

🔴 **A release that changes what `.claude/builder.md` must contain is a breaking change.** The
plugin reads that file from the host repo; if a new version expects a key that an existing config
doesn't have, every consumer breaks on update. Either keep reading the old shape, or make it a major
version and say in the changelog exactly what a consumer must add.

## Codex release (Claude-first)

Claude remains the source of new capabilities. Release Claude first as above, then run `$sync` in Codex in this repository. The sync skill migrates changed behavior, verifies it and publishes Codex; `$sync --no-release` stops before publication. It never treats version equality as feature parity.

The reviewed adaptation baseline and package digest live in `codex/upstream.json`. `node codex/scripts/sync.mjs plan --ref main` produces the upstream diff and disposition template. After semantic adaptation and independent review, `finish --ref <pinned-sha> --report <decisions.json>` aligns the version and runs all Codex tests. Commit the verified package, catalog, baseline and evidence and merge locally into main. Then:

```sh
node codex/scripts/release.mjs --dry-run
node codex/scripts/release.mjs --publish
```

The publisher re-runs tests, requires a clean main, rejects source/package drift and colliding tags, packages an installable archive, and atomically pushes main plus `builder-codex--v<version>` to origin before creating the GitHub release. It can resume a partial publication only when the existing tag points to the same HEAD. Never force/reuse a version tag for different content. `--pack` produces only the verified archive in `dist/`.

Codex consumers install `lukekeith/builder` as a marketplace and `builder@builder-codex` as the plugin. Update with `codex plugin marketplace upgrade builder-codex` then `codex plugin add builder@builder-codex`, and start a new session. `$update-local` rolls it out on this machine using the maintainer's project list and protected runtime vendoring. Consumer project configuration remains authoritative. See [codex/README.md](codex/README.md) for installation, sync evidence, runtime exclusions and local rollout.
