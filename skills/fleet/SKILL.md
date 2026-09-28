---
name: fleet
description: Take a batch of written specs through the whole /builder:* pipeline unattended — one worktree and branch per spec, a parallel build lane, a one-at-a-time walk lane through the dev environment (an isolated one per walk when agent_walk.start is set), an agent walk and agent sign-off in place of the human's, verify, and a MERGE of every finished feature into the branch it was run from; anything that would ask a question takes its recommendation; merge conflicts, red gates, failed walks and a dev env that won't start are worked by agents, and a feature parks only on a decision its spec leaves open. Launches scripts/fleet.mjs in the background and reports its table. Use when the user wants several specs built unattended, overnight, or "sent to an orchestrator"; --status shows the last run.
---

# `/builder:fleet` — many specs, no one watching

Invocation: **`/builder:fleet [--all | <feature|folder>…] [--parallel N] [--dry-run] [--status]`**.

The work is `scripts/fleet.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

**What it will do, per spec:** a worktree at `<agent_walk.worktrees>/<feature>` on a new branch
`builder/<feature>` (or the branch it is already underway on); `claude -p "/builder:resume --path <spec> --agent-walk"` runs until the feature
is **shipped** (resume §`--agent-walk`, §Ship in agent mode) — or, only when its spec leaves a
product decision open or the config reserves a step to the human, **parked** with that decision named. Then the fleet **merges
it into the branch checked out here** — one `--no-ff` merge commit per feature, `merge(<feature>):
agent-verified, not human-tested` — and removes its worktree and `builder/` branch. Everything lands
on that one branch, so you test the whole batch in one place. It **never pushes and never opens a
PR** — both stay yours — never writes a *human* sign-off, never lifts a `hold:`, and never deploys.
A re-run must start from the same branch while any of the fleet's features are unfinished.
**Specs named while a fleet is running join its queue** — the same command, no flag: admission is
checked as at a launch, each admitted spec is dropped in `.builder/fleet/inbox/`, and the running fleet
picks it up the moment a lane frees (it polls every 15 s, so a spec added while every lane is busy
never waits for a run to end). `--parallel` is the running fleet's; adding never raises it. A parked
feature named again is retried, once its `blocked:` line is cleared in its worktree.
Three lanes: the **build** and **ship** lanes share `--parallel` workers and never touch the dev env;
the **walk** lane (walk readiness, agent walk, sign-off, verify) runs one feature at a time. **Every
worktree is brought up to the target first**: before each build- or ship-lane run, and before the
walk env starts (at walk readiness and at verify — never between readiness and the walk), the fleet
merges the target branch into the worktree, so a feature builds on what the others have landed and
the ship step's own merge finds nothing new. **A conflict there goes to an agent**: the merge is left
in progress and a run of its own resolves it — both sides kept, the touched apps' gates green, the
merge committed — and the feature carries on; only a conflict two such runs could not resolve parks.
Before merging a shipped feature into the target the fleet brings the target into its branch the
same way, so the merge into the target never conflicts, and it lands even if you have switched this
checkout to another branch meanwhile (the merge commit is written straight onto the target). When that merge brings
new commits, `agent_walk.sync` runs in the worktree — the install and the test-DB migration a merged-in
package or migration needs (without it, a walk env once failed on a package the merge had just added).
**Builds run in parallel safely when each worktree has its own test database**: `agent_walk.worktree_env`
(`TEST_DATABASE_URL=…_{feature}`, say) reaches every run and `setup` in a worktree, `{feature}` filled
in, and `setup` can create that database. With it, `parallel: 3`; without it, suites that share one
database must run with `parallel: 1`. If the config has `@delta` gates, the fleet measures their
baselines on the target branch at start (`gate.mjs --baseline`, log in `.builder/fleet/logs/`).

**A program chain runs to the end in one fleet run.** A child whose PROGRAM §Children *Depends on*
entries haven't shipped **waits** (`⏳ <child> → <branch>, once <dep> merges`): it gets no worktree
until they are merged into this branch, then is branched from it, so it builds on its
dependencies' merged code. A dependency that isn't in the run and hasn't shipped refuses the child
(`✗ <child> — waits on <dep> (<state>) — not in this run`); one that parks or fails parks its
waiters too, naming it.

## 1. `--status`

`node <builder>/scripts/fleet.mjs --status` — reply with its contents **as markdown, never inside a
code fence**: the heading line, then the table as a markdown table (the terminal renders it; fenced,
it shows as raw pipes), then any notes as bullets. Change no cell. Then stop.

The table is rendered live: its `Progress` column reads each feature's manifest, plan and ledger from
its worktree at that moment, and the heading's bar is the mean across the rows. It measures **steps,
not time** — the manifest state sets a floor (planned 15, built 75, verified 90, merged 100) and inside
the build the bar climbs with `Task N: complete` ledger lines against the plan's tasks (`build 5/9`).
Half the bar is not half the wall-clock: the walk lane is one at a time and a task takes as long as it
takes. If asked how long is left, say that.

## 2. Always dry-run first

```bash
node <builder>/scripts/fleet.mjs <the same arguments> --dry-run
```

Print it verbatim. For every `✗` line, say what fixes it in a few words — for `waits on`, adding
that dependency to the run. A line `adds to the running fleet (pid N)` means a fleet is already
running here and the specs join its queue — §3 and §4 say how that changes the wording. The script refusing the whole
batch (no `agent_walk:` block, no `claude_args`) → name `/builder:init --update` and stop. `--dry-run`
was asked for → stop here.

## 3. Confirm once

One AskUserQuestion — **Start the fleet** / **Not now** — whose question restates: how many specs, the
worktree root, the permission args (`claude <claude_args>`), and "merges each finished feature
into <the current branch> here, one merge commit each; nothing is pushed". Mention uncommitted
changes in this checkout (`git status --short`): the fleet merges into this working tree, and a merge
that would overwrite one of them parks that feature until it is out of the way.
This is the only question the fleet ever asks.

**A fleet is already running** (the dry run said `adds to the running fleet`): the options are **Add
to the running fleet** / **Not now**, and the question says how many specs join the queue and that
they start as lanes free — the running fleet's `--parallel` stands.

## 4. Launch

Run with the Bash tool's `run_in_background`:

```bash
node <builder>/scripts/fleet.mjs <the same arguments>
```

**Adding to a running fleet:** run the same command in the foreground — it drops the specs in the
inbox and returns at once. Print its `↳` / `✗` / `↻` lines, then the footer:

~~~
📍 fleet: <n> spec(s) added to the running fleet — next: /builder:fleet --status
~~~

and stop; the rest of this section is the launch of a NEW fleet.

When the config's `agent_walk.start` is set, each walk in the walk lane gets its own dev env: the
fleet starts it fresh after `reset`, polls `smoke` until it's up, and always stops it after the
walk ends — for any reason, including a park — before running `stop`. An env that won't come up gets
one agent run to find and fix the cause in the branch, then one more try; readiness that needs the
env restarted gets it restarted by the fleet.

A run is killed only when it goes **quiet** — 30 minutes with no output
(`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`) — so a long build that is
still working is never cut off. Each run's words go to `.builder/fleet/logs/<feature>-NN.log` as it
works, its raw stream to the `.jsonl` beside it. A run that changes nothing gets one more run before
the feature parks.

Then say, in two lines: it's running, `/builder:fleet --status` shows where it stands, and a run that
must outlive this session goes in a terminal instead:
`nohup node <absolute builder path>/scripts/fleet.mjs <arguments> > .builder/fleet/fleet.out 2>&1 &`.

## 5. When it finishes

Reply with `.builder/fleet/STATUS.md` as markdown — the table as a table, not in a code fence — as
§1 does. Then, briefly:

- **done** — merged into this branch: `git log --merges` lists them. Test the result here; push
  when you're happy. `git revert -m 1 <merge>` takes one back out.
- **parked** — the decision the spec left open (or the human step the config reserves); answer it in
  the SPEC, delete the `blocked:` line in the worktree's manifest, and re-run `/builder:fleet` — it
  resumes, and retries only what you cleared. A park that names anything else — a conflict, a gate, a
  walk — is a fleet bug worth reporting.
- **failed** — the log path.

~~~
📍 fleet: <n> merged into <branch> · <m> parked · <k> failed — next: test <branch>; settle the parked ones, then /builder:fleet again
~~~
