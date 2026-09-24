# Releasing

1. **Make the change** and update `CHANGELOG.md`.
2. **Bump `version`** in `.claude-plugin/plugin.json` (semver: a new rule or skill is a minor; a
   changed contract a consumer's `.claude/builder.md` must satisfy is a major).
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
