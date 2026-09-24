# Changelog

`version` in `.claude-plugin/plugin.json` is the release number. Cut a release with
`claude plugin tag --push`, which refuses to tag unless `plugin.json` and the marketplace entry
agree — see [RELEASING.md](RELEASING.md).

## 2.0.1

Script resolution now prefers **`$CLAUDE_PLUGIN_ROOT`**, the documented way for a plugin to
reference its own files. The previous heuristic searched `~/.claude/plugins` — which finds nothing
for a freshly installed plugin, because the CLI records the install and Claude Code materialises the
files when a session loads it. The old paths remain as fallbacks for contexts where the variable is
not set.

## 2.0.0

**Dependency-free and project-agnostic.** The plugin no longer requires any other plugin, and no
longer knows anything about the repo it runs in.

- The execution engine, its four agent prompts, the plan format and two scripts are vendored
  (MIT — `LICENSE-THIRD-PARTY.md` records what came from where and what the adaptation changed).
- Every project fact moved to a single host file, `.claude/builder.md`: the apps and their roles,
  the literal gate commands, the global constraints pasted into every implementer brief, the house
  rules, the environment landmines, the recipe skills and an optional design source.
- **Apps have roles** — `producer` owns the contract and its phase freezes it, `consumer` codes
  against the frozen shape, `tool` runs after what it reads, `app` is a single-unit repo. Plus
  `commit: manual` (an agent never commits there) and `released_artifact: true` (a contract change
  it reads is breaking until §Apps states the transition).
- **Four craft skills** vendored essentially verbatim: `test-driven-development`,
  `systematic-debugging`, `receiving-code-review`, `verification-before-completion` — handed to
  every implementer by path and cited where they bite.
- Scripts moved into the plugin and read the config: `list-features.mjs`, `check-obligations.mjs`,
  `workspace`, `task-brief`, `review-package`.

Fixes in this line: an app literally named `app` matched the §Apps table header and reported every
app out of scope; a `SPEC.md` with no manifest was misread as analysis rather than an incomplete
feature; the script-resolution recipe used a bare glob (aborts under zsh) and an unsorted `find`
(picked a stale cached version).

## 1.0.0

First release — the pipeline as a plugin: sizing, SPEC/PLAN/MANIFEST, the one-pass audit, one app
per phase, the human walk and the PR lock. Depended on the superpowers plugin.
