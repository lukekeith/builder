# Native background sessions for the fleet — evaluation

> 2026-10-26 · builder 5.0.0 · status: decided — keep `claude -p`; add the bare-mode guard

## Why

The 2026-10-25 comparison (`docs/research/2026-10-25-comparison.md`, improvement 8) found Claude Code
now ships much of what the fleet built itself: worktree isolation, `claude --bg` with agent view
(`claude agents`), scripted workflows. Agent OS v3 retired its own orchestration for them, and
Taskmaster runs its clusters on agent teams. The question: should the fleet launch its runs as native
background sessions instead of `claude -p`?

## What the docs say (code.claude.com/docs, read 2026-10-26, Claude Code 2.1.310)

- `claude --bg "<prompt>"` starts a background session in the current directory; `--bg` rejects
  `-p`. State comes from `claude agents --json` (`status`, `waitingFor`, `sessionId`, …), output from
  `claude logs <id>`, and `claude stop <id>` ends one (agent-view.md).
- **Exit status and cost are not documented for `--bg` sessions.** Only `-p` documents them:
  `total_cost_usd` in its JSON result and "exits with code 0 on success and a non-zero code when the
  run fails" (headless.md). The fleet reads both.
- **A background session pushes and may open a PR.** For isolated sessions "Claude commits without
  asking, and pushes the branch when the repository has a remote," and may open a draft PR; it never
  merges (agent-view.md). Builder's agent mode promises it never pushes and never opens a PR.
- "Agent view is in research preview. The interface and keyboard shortcuts may change"
  (agent-view.md).
- Workflows have no external CLI to start, query or stop a run from a script (workflows.md).
- `--bare` "is the recommended mode for scripted and SDK calls, and will become the default for `-p`
  in a future release" (headless.md). `claude --help`: bare mode skips "hooks (those defined in
  settings and by installed plugins)", and its Anthropic auth "is strictly ANTHROPIC_API_KEY or
  apiKeyHelper … (OAuth and keychain are never read)". There is no `--no-bare` flag.

## Decisions

- **D1 — The fleet keeps `claude -p`.** Moving to `--bg` would lose the exit status and cost the fleet
  decides on, and would push branches and open PRs that agent mode promises never to. The merge and
  conflict layer — the thing no native feature does — stays builder's.
- **D2 — Guard against bare mode.** If `-p` turns bare by default, a fleet run would start without
  builder's skills and hooks — no PR lock — and, for a subscription user, without sign-in. The fleet
  now reads each run's `system/init` event and stops the run when the `builder` plugin is not among
  its `plugins`, saying why in the log (`fleet-core.mjs initWithoutBuilder`).
- **D3 — Revisit** when `--bg` documents exit status and cost and has a no-push setting, or when
  `-p` sessions can appear in agent view; either would let the fleet hand its status display to
  Claude Code without giving up a guarantee.
