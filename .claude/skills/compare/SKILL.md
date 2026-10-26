---
name: compare
description: Local to the builder repo (not part of the release) — re-run the competitive comparison of builder against the latest versions of similar Claude Code plugins, spec-driven tools, orchestrators and Claude Code's own native features, hunt for new tools competing with it, and write a dated, sourced report with what changed since the last run and evidence-backed improvement ideas. Use when the user asks to compare builder with competitors, re-run the comparison or competitor research, or "/compare".
---

# `/compare` — builder against the field

Every claim in the report is a fact with a source: a URL, a `file:line` in this repo, or a measured
number. Nothing speculative survives into the report. A claim an agent couldn't verify is listed
under *Could not verify*, never quoted as fact.

Inputs: [`watchlist.md`](watchlist.md) (what to research) and the newest
`docs/research/*-comparison.md` (the last run, the baseline to diff against).

## 1. Fan out — six research agents in one message

Launch them all at once with the Agent tool (`general-purpose`, background), one per lane of the
watchlist plus discovery. Each prompt names its tools and links from the watchlist and asks for the
same fields:

> for each tool: current version and release date, adoption (GitHub stars via `gh api repos/<r>`,
> installs where a catalog shows them), entry points and how many commands or concepts a user must
> learn, the workflow steps, artifacts written to disk, human checkpoints, use of subagents and
> parallelism, how it merges parallel work and handles conflicts, how it resumes, how it keeps
> context small (always-on token cost if published), how it tests its own skills, published
> performance numbers (and whether anyone independent measured them), and documented user praise
> and complaints (quoted, with URL). **What changed since <the baseline's date>** — new features,
> removals, archives, ownership changes. A source URL for every claim; list what you couldn't verify.
> No speculation.

1. **Lane 1 — skill-workflow plugins.**
2. **Lane 2 — spec-driven development.** Include independent critiques (martinfowler.com,
   Scott Logic and newer ones).
3. **Lane 3 — orchestration and task systems.**
4. **Lane 4 — Claude Code native features.** What a plugin no longer needs to build itself; what
   each native feature still does *not* do (e.g. merging worktrees back).
5. **Lane 5 — guidance and user evidence.** Anthropic's current limits and rules (description
   length, listing budget, SKILL.md size, evals) and at least 10 user quotes grouped by theme.
6. **Discovery — new competitors.** Search for Claude Code (and Codex) plugins, skill packs and
   frameworks that take a feature from idea or spec to merged code, launched or newly popular since
   the baseline: the official plugin catalog (`~/.claude-home/plugins/plugin-catalog-cache.json` or
   `~/.claude/plugins/…` — installs and ranks), GitHub search and trending, Hacker News, awesome-lists
   of Claude Code plugins. For each candidate: what it does, adoption, first release, and whether it
   competes with builder (idea → spec → plan → build → test → merge) or only overlaps one step. Skip
   anything already on the watchlist.

## 2. Measure builder itself — in this session, while they run

Read-only. Never run `--auto`, a fleet, a build or `/builder:benchmark` here; the benchmark numbers
come from its committed reports.

- **Always-on context:** `claude --plugin-dir . plugin details builder` — the projected always-on
  tokens and the per-skill table. For a competitor installed on this machine,
  `claude plugin details <plugin>`.
- **Skill sizes:** lines and words of each `skills/*/SKILL.md`, the largest reference files, and the
  description lengths (`scripts/test/skills-budget.test.mjs` holds the budgets).
- **Benchmarks:** the newest `bench/results/*/REPORT.md` per fixture, and the newest run that
  includes superpowers or GSD — with its date and versions. Say plainly if the head-to-head is stale.
- **Tests and CI:** test count (`node --test` summary line from the last run, or count `test(` in
  `scripts/test/`), and whether `.github/workflows/` runs them.
- **Concept load:** count the terms a new user meets in README.md and `skills/help/SKILL.md`.
- **Release cadence is not a weakness.** builder is early and changes fast on purpose; report the
  version, don't score the churn.

## 3. Verify before you write

Check every builder claim an agent made against the repo yourself (one grep or read each), and
drop or correct what doesn't hold — say so in the report. For competitor claims, keep only those with
a source URL; secondary-source-only claims go under *Could not verify*.

## 4. Write the report

`docs/research/YYYY-MM-DD-comparison.md` (today's date), in this shape:

1. **What was compared** — the lanes, the tools, and the baseline it's diffed against.
2. **What changed since the last run** — per tool: new version, new capability, archived, new
   competitor found. Builder's own movement on the baseline's weaknesses (what got fixed, by which
   release, measured how).
3. **New competitors** — each with a one-line verdict (competes / overlaps one step / not relevant)
   and a recommendation to add it to the watchlist or not.
4. **Where builder stands** — strengths and weaknesses, each with its number and source.
5. **Top improvements** — at most 10, ranked, each as *Facts* (with sources) → *Do* (concrete).
   Skip any idea the facts don't support. Mark ones carried over from the last run.
6. **Could not verify.**
7. **Sources** — every URL cited.

Then update [`watchlist.md`](watchlist.md): add the new competitors the report recommends, retire
archived ones with the date and why.

## 5. Report back

In the chat: the report's path, a short "what changed" list, the new competitors, and the top
improvements as one line each. Don't commit; say the report and watchlist changes are ready to commit.
