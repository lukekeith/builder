---
name: fleet
description: Take a batch of written specs through the whole /builder:* pipeline unattended — one worktree and branch per spec, a parallel build lane, a one-at-a-time walk lane through the dev environment (an isolated one per walk when agent_walk.start is set), an agent walk and agent sign-off in place of the human's, verify, a PR, CI and the MERGE per feature; anything that would ask a question takes its recommendation or parks the feature with a reason. Launches scripts/fleet.mjs in the background and reports its table. Use when the user wants several specs built unattended, overnight, or "sent to an orchestrator"; --status shows the last run.
---

# `/builder:fleet` — many specs, no one watching

Invocation: **`/builder:fleet [--all | <feature|folder>…] [--parallel N] [--dry-run] [--status]`**.

The work is `scripts/fleet.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

**What it will do, per spec:** a worktree at `<agent_walk.worktrees>/<feature>` on a new branch
`builder/<feature>` (or the branch it is already underway on); `claude -p "/builder:resume --path <spec> --agent-walk"` runs until the feature
is **merged** or **parked** (resume §`--agent-walk`, §Ship in agent mode). It **pushes branches, opens
PRs, watches CI and merges them.** It never writes a *human* sign-off, never lifts a `hold:`, never
merges past a required review or with `--admin`, and never deploys — each of those parks instead.
Three lanes: the **build** and **ship** lanes share `--parallel` workers and never touch the dev env;
the **walk** lane (walk readiness, agent walk, sign-off, verify) runs one feature at a time.

**Program children run in waves, not chains.** Every worktree branches off `HEAD`, so a child whose
PROGRAM §Children *Depends on* entries haven't all **shipped** is refused (`✗ <child> — waits on
<dep> (<state>)`) — it would build against a contract that isn't merged. Pick the next wave in a
later run, after the last one's PRs merge.

## 1. `--status`

`node <builder>/scripts/fleet.mjs --status` — print it verbatim and stop.

## 2. Always dry-run first

```bash
node <builder>/scripts/fleet.mjs <the same arguments> --dry-run
```

Print it verbatim. For every `✗` line, say what fixes it in a few words — for `waits on`, merging
that dependency's PR. The script refusing the whole
batch (no `agent_walk:` block, no `claude_args`) → name `/builder:init --update` and stop. `--dry-run`
was asked for → stop here.

## 3. Confirm once

One AskUserQuestion — **Start the fleet** / **Not now** — whose question restates: how many specs, the
worktree root, the permission args (`claude <claude_args>`), and "pushes branches, opens PRs and
merges each feature into <base_branch> once CI is green".
This is the only question the fleet ever asks.

## 4. Launch

Run with the Bash tool's `run_in_background`:

```bash
node <builder>/scripts/fleet.mjs <the same arguments>
```

When the config's `agent_walk.start` is set, each walk in the walk lane gets its own dev env: the
fleet starts it fresh after `reset`, polls `smoke` until it's up, and always stops it after the
walk ends — for any reason, including a park — before running `stop`.

A run is killed only when it goes **quiet** — 30 minutes with no output
(`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`) — so a long build that is
still working is never cut off. Each run's words go to `.builder/fleet/logs/<feature>-NN.log` as it
works, its raw stream to the `.jsonl` beside it. A run that changes nothing gets one more run before
the feature parks.

Then say, in two lines: it's running, `/builder:fleet --status` shows where it stands, and a run that
must outlive this session goes in a terminal instead:
`nohup node <absolute builder path>/scripts/fleet.mjs <arguments> > .builder/fleet/fleet.out 2>&1 &`.

## 5. When it finishes

Print `.builder/fleet/STATUS.md` verbatim. Then, briefly:

- **done** — each merged PR. The worktrees stay; once you've looked, `git worktree remove <worktree>`
  clears one.
- **parked** — the reason; delete the `blocked:` line in the worktree's manifest once it's settled, and
  re-run `/builder:fleet` — it resumes, and retries only what you cleared.
- **failed** — the log path.

~~~
📍 fleet: <n> merged · <m> parked · <k> failed — next: settle the parked ones, then /builder:fleet again
~~~
