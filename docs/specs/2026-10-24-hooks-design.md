# Plugin hooks — a session brief and the PR lock — design

> 2026-10-24 · builder 4.14.4 (proposed) · status: the owner chose both

## Why

superpowers ships a SessionStart hook (`hooks/hooks.json` in the plugin) that injects its
`using-superpowers` skill into every session, so Claude reaches for it before the user types. Builder
ships no hooks: it is found only when a request happens to match a skill description — and in a
builder project superpowers' hook ("invoke brainstorming before any creative work") is the louder
voice, so builder's own brainstorm, TDD, debugging and verification lose to their superpowers twins.
Separately, "never open a PR before the human has walked the feature" is only prose in the skills.

## Decisions

- **D1 — Plugin hooks, nothing written to the repo.** `hooks/hooks.json` at the plugin root; Claude
  Code runs them wherever builder is enabled.
- **D2 — SessionStart (`startup|clear|compact`): a short brief, only in a builder project.**
  - Silent (no output, exit 0) unless `$CLAUDE_PROJECT_DIR/.claude/builder.md` exists — builder is
    installed user-scope for every repo, so every other repo pays nothing.
  - Silent under unattended runs (`BUILDER_FLEET_DIR` set — the fleet's sessions know their step).
  - The brief, ~15 lines: builder is set up here; new work starts with `/builder:brainstorm` (small
    changes take its quick path); `/builder:status` and `/builder:resume` for work in flight; the
    in-flight features (up to 5, most recent first) each with its next step, from
    `scripts/list-features.mjs --json`; and **in this repo builder's skills take precedence** over
    their superpowers equivalents (brainstorm over brainstorming, builder:plan/build over
    writing-plans/executing-plans, and builder's test-driven-development, systematic-debugging,
    verification-before-completion and receiving-code-review over superpowers').
  - The entry is bash (a SessionStart hook can run with a broken PATH — anthropics/claude-code#43127);
    it finds `node` itself and, without it, emits the brief minus the feature list. Never fails the
    session: any error → no output, exit 0.
- **D3 — PreToolUse on Bash: the PR lock.** When the command runs `gh pr create` in a builder
  project, find the feature whose manifest `branch:` is the current branch. If one exists and its
  manifest has `walk: none` → deny, with the reason and the next step (`🔒 walk it, then
  /builder:signoff --path <folder>`). `walk: agent-pass …` (an agent sign-off) is allowed only when
  the manifest also says `agent-walk: on`. No builder feature on the branch, or not a builder
  project → allow silently: PRs that have nothing to do with builder are never blocked. Any error →
  allow (the hook never blocks by accident).
- **D4 — Tests** spawn both hooks with fake environments and stdin; `claude plugin validate .`
  checks `hooks.json`. The preview gains a stage showing the brief.
- **D5 — Release: a patch (4.14.4)** — no command or flag a user reaches for; behaviour around the
  existing skills.
