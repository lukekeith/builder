# builder against the field — 2026-10-25

Baseline run (no earlier comparison). Builder at 4.14.8 (ffdbfd1). Five research agents; builder's
own claims checked against the repo. Reddit blocked fetches, so user evidence is Hacker News, GitHub
issues and blogs.

## What was compared

- **Skill-workflow plugins:** superpowers 7.0.0/7.0.1, Anthropic's official plugins (feature-dev,
  code-review, pr-review-toolkit, commit-commands, hookify, plugin-dev), compound-engineering 3.32.2.
- **Spec-driven:** GitHub Spec Kit, Kiro, OpenSpec, BMAD (v6.12 / v7 alpha), Tessl.
- **Orchestration:** GSD (now open-gsd/gsd-core), Taskmaster AI, Agent OS v3, claude-flow/Ruflo,
  ccpm, SuperClaude 4.3.0.
- **Claude Code native:** sub-agents, worktrees, `claude --bg` / agent view, workflows, agent teams,
  `/goal`, `/batch`, `/verify`, hooks, skills, headless.
- **Guidance:** Anthropic skill best practices, Claude Code skills/plugins/best-practices docs,
  engineering posts.

## Adoption snapshot

| Tool | Stars (2026-10-25) | Installs (official catalog, 2026-09-25) | Always-on tokens |
|---|---|---|---|
| superpowers | 305,126 | 1,140,665 (#2 of 314) | ~843 |
| code-review (official) | (claude-code repo 153k) | 487,311 (#3) | ~25 |
| feature-dev (official) | — | 275,679 (#11) | ~243 |
| pr-review-toolkit | — | 125,142 | ~2,038 |
| Spec Kit | 142.9k | — | — |
| claude-flow / Ruflo | 79.3k | — | — |
| OpenSpec | 73.0k | — | — |
| GSD (archived original / gsd-core) | 64.2k / 10.9k | — | ~12k default, ~700 `--minimal` |
| BMAD | 54.6k | — | — |
| Taskmaster | 28.3k | — | ~21k (all 36 MCP tools) |
| compound-engineering | 25.7k | not in catalog | (12–36k reported idle in old issues #63, #139) |
| SuperClaude | 23.9k | — | — |
| ccpm | 8.4k | — | — |
| Agent OS | 5.5k | — | — |
| **builder 4.14.8** | — | — | **~6,656** (`claude plugin details`) |

Sources: GitHub API; `~/.claude-home/plugins/plugin-catalog-cache.json`; READMEs below.

## Where builder stood

**Strengths**
- Measured speed work: `tags` 13m/$4.92 (4.12.1) → 8m/$3.91 (4.14.0), 3 reps, ranges don't overlap
  (`bench/results/2026-10-24-1901-tags`). GSD on the same feature: 50m/$19.84
  (`bench/results/2026-10-14-0136-tags`).
- Outcome-scored quality: hidden acceptance tests, 7/7 and 9/9 in every successful run.
- Safety enforced in code: PR-lock hook, `disable-model-invocation` sign-off, `commit: manual`.
- Clean resume from a ~12-line manifest. (Superpowers' ledger is deleted by `git clean -fdx` —
  its release notes.)
- Merges parallel work and has agents resolve conflicts. GSD stops at a conflict ("resolve
  manually", execute-phase.md); native worktrees, `claude --bg`, `/batch` never merge back.

**Weaknesses**
- Always-on context ~6,656 tokens vs superpowers ~843, feature-dev ~243. Three descriptions over
  Anthropic's 1,024-char limit (brainstorm 1,606, agent 1,357, resume 1,276); the listing overflowed
  and dropped 7 builder descriptions (including `help`) in a live session.
- Cost and turns vs superpowers: builder best 60 turns/$3.91; superpowers' only run 32 turns/$2.24
  (stale: n=1, superpowers 6.4.1). ~8 min fixed steps on `tags`; orchestrator 65% of wall time.
- About 60 terms, 34 flags, 14 config keys + 14 `agent_walk` sub-keys, 30 skills, ~11 touchpoints
  from install to a first shipped md feature.
- Behaviour tests are regex on prose (46 in `skills-consistency.test.mjs`); no CI (`.github/` held
  only a PR template).
- Docs drift: README "19 skills" / "13 pipeline skills" (30 exist); two contradictory vendoring
  sections; `PROJECT.template.md:18` still named "Thorough".
- The default "go" hands a feature to agents (4.14.6) and every install gets agent mode (4.14.8),
  while README/help described a human walk before every PR.
- §Standing traps is read at every step but written by none.

(Release cadence — 59 releases in 30 days — is deliberate at this stage and is not scored.)

## Key facts per tool

**superpowers** (github.com/obra/superpowers). 15 skills, 0 commands; a SessionStart hook injects
`using-superpowers` ("1% chance … MUST invoke"). brainstorm → worktree → writing-plans →
subagent-driven-development → TDD → review → finish. Pressure-scenario skill tests
(writing-skills/testing-skills-with-subagents.md) and the Quorum eval harness
(prime-radiant-inc/superpowers-evals, not in CI). v6 claimed −50% wall time, −60% tokens
(blog.fsck.com/2026/06/15/Superpowers-6/). Complaints: v7 brainstorm questions (#2530, 22 👍),
over-specified plans (#895), review loop burns tokens on mechanical tasks (#1120), slowdown from
context (#743), opt-out of auto-trigger (#645), wants compounding learnings (#230, 21 👍).

**Anthropic official.** feature-dev: one command, 7 phases, parallel explorer/architect/reviewer
agents, nothing on disk, no resume. code-review: 5 parallel Sonnet reviewers + Haiku confidence
scoring, drops < 80. All entered by an explicit command, no SessionStart hook.

**compound-engineering** (github.com/EveryInc/compound-engineering-plugin). `/ce-brainstorm` →
`/ce-plan` → `/ce-work` → `/ce-code-review` → `/ce-compound`; `/lfg` runs it hands-off to a PR.
`ce-compound` writes one learning per solved problem to `docs/solutions/` with enum frontmatter,
only when a future engineer would otherwise repeat the mistake; plan and review grep them. SKILL.md
≤ 8,000 bytes enforced by a test (AGENTS.md:110). Fresh-agent A/B skill evals with a simulated user
and a blind grader. Merging stays with the user unless granted.

**Spec Kit** (github.com/github/spec-kit). ~9 core/optional commands plus a constitution. No small
fast path in core. Böckeler: "a LOT of markdown files … I'd rather review code"
(martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html). Eberhardt: spec 4× the module,
"around ten times faster" without SDD (blog.scottlogic.com/2025/11/26/…).

**Kiro** (kiro.dev). requirements (EARS) / design / tasks; Quick Spec runs all three phases with no
approval gates; the blog admits step-by-step approvals "can feel like more process than the problem
requires" (kiro.dev/blog/faster-smarter-specs/). Run-all-tasks in dependency waves.

**OpenSpec** (github.com/Fission-AI/OpenSpec). 4 default commands; delta specs
(ADDED/MODIFIED/REMOVED) merged on archive; brownfield-first.

**BMAD** (github.com/bmad-code-org/BMAD-METHOD). 9 personas; Quick Flow vs full tracks. Users:
"not sure which command I need … recommended commands … are incorrect" (#1543); `/bmad-help`
recommended a non-existent command (#1761).

**GSD.** Original archived 2026-06-26 → open-gsd/gsd-core. 67 commands; waves; merges worktrees
`--no-ff`, stops on conflict. Users: "40% of weekly limit in couple of sessions" (discussion #2372);
a 1,325-line skill file (#2551).

**Taskmaster.** 28 CLI commands, 36 MCP tools (~21k tokens all-on); clusters run on native agent
teams. **Agent OS v3** retired its own spec/task/orchestration in favour of native Claude Code.
**Ruflo:** independent audit found most tools were stubs (gist roman-rr). **ccpm:** GitHub Issues
as source of truth, one worktree per epic.

**Claude Code native** (code.claude.com/docs). Worktree isolation for subagents (no merge-back);
`claude --bg` + agent view (research preview, never merges); workflows (scripted fan-out, no
mid-run input); agent teams (experimental); `/goal`; `/batch` (5–30 worktree units); 33 hook events;
`claude plugin eval` with a Skill-trigger grader.

**Guidance.** Description ≤ 1,024 chars, third person, what + when; listing truncated at 1,536 and
budgeted at 1% of context, least-used descriptions dropped on overflow; SKILL.md < 500 lines;
references one level deep, TOC over 100 lines; after compaction only the first 5,000 tokens of each
skill survive (25k shared); evals before docs; test with Haiku, Sonnet, Opus.

**User evidence themes** (quotes with URLs in the agents' output): ceremony for small tasks
(HN 49967693; superpowers #2076, #1120), markdown overload (Scott Logic; marmelab; HN 45181577),
token cost (HN 46989835; GSD #2372; superpowers #2612, #1152), "which command?" confusion (BMAD
#1543; superpowers #446), mis-triggering (superpowers #54, #2530, #2576), drift from spec (spec-kit
#464). Praise: thoughtful brainstorm questions (HN 48508445), resume from plan, visible progress.
orcabot.com/benchmarks: GSD scored below no plugin on SWE-bench Pro (55.42% vs 55.56%) at 2× tokens.

## Top improvements (this run)

1. Cut always-on context 4–5× (descriptions ≤ 400 chars, maintainer skills out of the listing).
2. SKILL.md under 500 lines; split `resume/REFERENCE.md` (1,112 lines); a size test.
3. Fewer fixed steps for md features; count turns per step.
4. Behaviour evals for the moments users touch most; CI for the unit tests.
5. Docs generated/checked from source (counts, command table).
6. A small vocabulary budget for anything printed to the user.
7. Default path matches the docs (agents test and merge by default — say so).
8. Build on native background sessions; keep the merge/conflict layer.
9. Re-run the head-to-head with current versions, ≥ 3 reps, a no-plugin baseline.
10. Write lessons back to §Standing traps after a feature.

## Could not verify

Reddit primary threads; Kiro and BMAD adoption numbers; BMAD sharding; Tessl's status after
June 2026; Ruflo's 84.8% SWE-bench; ccpm/SuperClaude/Taskmaster percentages; first-hand feedback on
feature-dev, Taskmaster, ccpm, SuperClaude; the reason for GSD's move beyond one secondary source.
