# Changelog

`version` in `.claude-plugin/plugin.json` is the release number. Cut a release with
`claude plugin tag --push`, which refuses to tag unless `plugin.json` and the marketplace entry
agree — see [RELEASING.md](RELEASING.md).

## 2.4.0

**Say "go" instead of pasting the next command.** Every handoff still ends with its 📍 footer, but a
bare affirmative in reply — "go", "yes", "proceed", "continue" — now runs that footer's command in the
same turn. Nothing is skipped: the command runs as if typed, and every gate it reaches still asks.
`/builder:resume` is no longer `disable-model-invocation`, so "continue where I left off" works in a
fresh session too, and a mid-build context stop offers "go" to carry on in the session instead of
requiring `/clear`. Footers that "go" can continue end with ` · or say go`; `/builder:status` accepts
a feature's name as the reply.

Unchanged by design: `/builder:signoff` is still typed by the human only, and "approve" after a walk
is answered with the command to type, not a sign-off. A step only the human can do, a hold, and
anything with more than one candidate still stop, and opening the PR asks once even after a "go".
The rule lives in REFERENCE §Continuing on "go".

## 2.3.0

**Walk readiness** — the pipeline no longer asks a human to walk, or sign off, a build the dev
environment isn't running. Green gates run against a test database; the walk doesn't. Before the walk
script is printed (and after walk fixes, and at the end of an xs/sm change) it now checks the dev
database for pending migrations and **asks before applying them**, regenerates and restarts what went
stale, and smokes each changed surface — endpoints, pages, their console and the server log. An
error it finds is fixed as a build defect, not handed over as a walk item. A new manifest line,
`ready:`, records it; `/builder:signoff` refuses a PASS while it is pending, and `/builder:status`
shows what's left.

**Config:** a new `## Walk readiness` section in `.claude/builder.md` — the migrations directory and
the status / apply / regenerate / start / smoke commands, plus `apply_mode: ask | human | agent`.
Optional: without it the pipeline infers the commands and says so. `/builder:init --update` adds it
to an existing config.

## 2.2.0

**`/builder:status`** — every in-progress feature and program in one table, most recently touched
first: what it is (the SPEC's first Overview sentence), the step last completed, the step next, when
it last moved, and the `/builder:resume` command to paste to pick it up. Flags a feature whose branch
isn't the one checked out, and one that can't be resumed as it stands. Backed by
`list-features.mjs --status`, so it reads manifests only and writes nothing.

## 2.1.0

**`/builder:init`** — per-repo setup in one command. It reads the repo (workspaces, gate commands, CI,
`git log`), asks only what it cannot tell, writes `.claude/builder.md` and proves it parses.
`--update` fills gaps in an existing config without touching what a human wrote. The missing-config
message in every script and skill now points at it. No change to the config format.

## 2.0.3

Public release. Correct authorship and homepage, a contribution guide and a PR template. No change
to the pipeline.

## 2.0.2

Corrects the 2.0.1 note, which named the wrong cause. A marketplace install **does** materialise the
plugin on disk immediately. What was wrong is that the fallback hardcoded `~/.claude`, and the
config directory moves — `CLAUDE_CONFIG_DIR` pointed at `~/.claude-home` on the machine this was
found on, where the files were sitting the whole time. The fallback now reads
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.

## 2.0.1

Script resolution now prefers **`$CLAUDE_PLUGIN_ROOT`**, the documented, portable way for a plugin
to reference its own files, with the previous paths kept as fallbacks. (The cause given for the bug
in this release was wrong — see 2.0.2.)

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
