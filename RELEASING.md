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
