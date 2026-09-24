---
name: init
description: Sets up a repo for the /builder:* pipeline by writing its one project config, .claude/builder.md — copies PROJECT.template.md out of the installed plugin, fills the frontmatter and body from what the repo actually contains (project name, base branch, apps and their paths, the real gate commands, house-rule sources), asks only what the repo cannot answer (app roles, commit mode, optional ticket and design blocks), then proves the result parses. Refuses to overwrite an existing config unless asked; with --update it fills gaps and placeholders in one instead. Use when the user asks to set up, configure, initialise or install builder in a project, when any /builder:* step reports that .claude/builder.md is missing, or when the config still holds template placeholders.
---

# `/builder:init` — configure this repo for `/builder:*`

Invocation: **`/builder:init [--update] [--force]`**. Run it from anywhere inside the repo.

- no flag — write `.claude/builder.md` when there is none; stop if there is one.
- `--update` — keep the existing config and fill only its gaps: missing keys, `<placeholder>` values,
  apps the repo has that the config doesn't list. Every value a human wrote stays as written.
- `--force` — start over from the template. Say what will be replaced and get a yes first.

**The plugin installs once; this runs once per repo.** Installing gives every repo the commands;
this file is what tells them what the repo *is*. It is the only file this command writes.

## 1. Locate

```bash
git rev-parse --show-toplevel                 # the repo root — the config goes here, not in cwd
ls .claude/builder.md 2>/dev/null             # exists already?
echo "$CLAUDE_PLUGIN_ROOT"                    # the template is $CLAUDE_PLUGIN_ROOT/PROJECT.template.md
```

Not a git repo → say so and stop; the pipeline commits, branches and diffs, so it needs one.
`$CLAUDE_PLUGIN_ROOT` empty → resolve the plugin as [REFERENCE](../resume/REFERENCE.md) §The scripts does
and take `PROJECT.template.md` from the directory above `scripts/`. Resolving to nothing → say the
plugin is not reachable from this context and stop; **never write the config from memory of the
template** — it is the contract `config.mjs` parses, and it changes between versions.

Config exists and no flag → print its `project:` and `apps:` names, point at `--update` and
`--force`, and stop.

## 2. Recon — read the repo, don't ask about it

Work out each of these from files, not from the user. Record where each answer came from; step 4
shows it.

| Key | Where to look |
|---|---|
| `project` | root `package.json` `name`, the README's first heading, the repo directory name — in that order |
| `base_branch` | `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), else `main` if it exists, else `master` |
| `registry` | an existing `docs/features/` or other folder of per-feature `SPEC.md`s; otherwise the template's `docs/features` |
| `apps` | workspace declarations first — `package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, a Cargo `[workspace]`, a Gradle/Maven multi-module build. No workspace → **one app** at the root, `role: app`. Skip packages that are only shared libraries, configs or type packages unless they ship on their own |
| app `role` | a guess to confirm, never a fact: whatever serves the API or owns the schema → `producer`; web/mobile/desktop clients → `consumer`; scripts, CLIs, internal dashboards → `tool`; a lone app → `app` |
| app `released_artifact` | `true` for anything installed on a device rather than deployed: mobile apps, desktop apps, published packages and CLIs |
| fast gates, per app | that app's `package.json` scripts (`lint`, `typecheck`, `test`, `build`), `Makefile` targets, `justfile`, `Taskfile`, or the language default (`go test ./...`, `cargo test`, `pytest`). Use the command exactly as the repo runs it, including the package manager the lockfile implies (`pnpm`, `yarn`, `bun`, `npm`) |
| deep gates | e2e suites (`playwright`, `cypress`, `detox`, `e2e` scripts), full builds, and the CI workflow in `.github/workflows/` — CI is the best record of what "passing" means here |
| known-red gates | don't run anything to find out; list the gate commands and ask in step 3 |
| house rules | per-app `CLAUDE.md` / `AGENTS.md`, `docs/architecture*`, `CONTRIBUTING.md` — **point at them**, don't copy them |
| environment landmines | `docker-compose*.yml`, `.env.example`, ports in dev scripts, a README "gotchas" or "troubleshooting" section |
| companion skills | `.claude/skills/` and any project skills the session lists. None → omit the table |
| commit style | `git log --oneline -30` — conventional commits? ticket keys in the subject? That fills the commit line in §Global constraints |
| ticket system | ticket keys in branch names and commit subjects (`ABC-123` → Jira or Linear, `#123` → GitHub). None → omit the block |
| design source | a design-resolver script or design-contracts folder. Almost always absent → omit the block, and say prototype mode stays off |

## 3. Ask only what recon couldn't answer

Ask in **one message**, with your recommendation first on each item, using `AskUserQuestion` where
the answer is a choice:

- the **role** of each app, when there is more than one — show the guessed producer → consumer
  order;
- **`commit: auto` or `manual`** per app — recommend `auto`; `manual` means an agent stages but never
  commits;
- **known-red gates** — which of the listed gates fail on `{base_branch}` today;
- the **ticket** and **design** blocks, only when recon found a sign of one.

Nothing unresolved → skip this step and say so.

## 4. Write `.claude/builder.md`

Start from a copy of the template, then replace every `<placeholder>`:

```bash
mkdir -p .claude && cp "$CLAUDE_PLUGIN_ROOT/PROJECT.template.md" .claude/builder.md
```

- **Frontmatter** — the keys from steps 2–3. Delete the optional `ticket:` and `design:` blocks
  outright when unused; commented-out keys mislead the next reader. Keep the parser's subset: flat
  scalars, the `apps:` list of one-level maps, one level of nested map — `config.mjs` ignores
  anything fancier rather than guessing.
- **Body** — one real paragraph on what the repo is; a `### <app> — fast` block per app with its
  literal commands, each with a `# what it proves` comment; the deep set; §Global constraints with the
  template's fixed bullets kept verbatim and the commit line rewritten to the style `git log` shows;
  §House rules as one line per app pointing at its source; landmines only when recon found some.
- **Delete the template's instructional comments** (the `# ─── … ───` banners and the
  "Copy this file to…" header). What's left should read as this repo's config, not a form.
- A section recon found nothing for and the user didn't answer → keep the heading with a single
  `- none recorded yet` line rather than a placeholder. **No `<…>` may survive** outside a code block.

`--update`: edit the existing file in place — no `cp` — touching only gaps, placeholders and missing
apps, and list each change.

## 5. Prove it

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/list-features.mjs"
grep -n '<[a-z][^>]*>' .claude/builder.md    # any placeholder left over — must print nothing outside code blocks
```

`list-features.mjs` must load the config: with an empty registry it reports no features, and that is
a pass. A `reason` line such as "lists no apps" or "no frontmatter" means step 4 is wrong — fix it and
run again. **Don't run the gate commands** to check them; that is the first phase's job, and on an
unfamiliar repo they can be slow or need services running.

## 6. Report

Under 15 lines:

```
✅ .claude/builder.md written for <project>
   apps: <name> (<role>, <commit>) · …
   base: <branch> · registry: <dir> · ticket: <system|none> · design: <on|off>
   inferred, check these: <the 2–4 guesses most worth a human glance>
📍 next: /builder:brainstorm <what you want built>
```

**Never commit the file.** Say it belongs in git so the whole team runs the same pipeline, and leave
the commit to the user.
