---
name: fleet
description: Runs several written specs through the whole pipeline unattended, each in its own worktree, and merges each finished feature; agents work conflicts and failures. Use when the user wants several specs built unattended or overnight; /builder:fleet:status shows where it stands.
---

# `/builder:fleet` — many specs, no one watching

Invocation: **`/builder:fleet [--all | <feature|folder>…] [--parallel N] [--dry-run] [--no-env-check]`** · where it stands: **`/builder:fleet:status`**.

With `agent_walk.start` set, the launch proves the walk env once — start, smoke, stop in a throwaway
worktree of the target, beside the build lanes — and says at once when the config can't bring it
up; `--no-env-check` skips that.

The work is `scripts/fleet.mjs`; this skill checks, confirms once, launches it and reports. Resolve
`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts.

**What it will do, per spec:** a worktree at `<agent_walk.worktrees>/<feature>` on a new branch
`builder/<feature>` (or the branch it is already underway on); `claude -p "/builder:resume --path <spec> --agent-walk"` runs until the feature
is **shipped** (resume's AGENT-MODE.md) — or, only when its spec leaves a
product decision open or the config reserves a step to the human, **parked** with that decision named. Then the fleet **merges
it into the branch checked out here** — one `--no-ff` merge commit per feature, `merge(<feature>):
agent-verified, not human-tested` — and removes its worktree and `builder/` branch. **Migrations
that landed reach your dev DB:** the walk only proved them on its throwaway walk DB, so after a merge
into the branch checked out here the fleet runs the config's §Walk readiness `apply:` then
`regenerate:` in this checkout when `apply_mode: agent` and every new migration is additive; under
`ask`/`human`, or for one that drops or rewrites data, it notes the exact command instead. A merge
written onto a branch checked out nowhere notes it for when you switch. Everything lands
on that one branch, so you test the whole batch in one place. It **never pushes and never opens a
PR** — both stay yours — never writes a *human* sign-off, never lifts a `hold:`, and never deploys.
A re-run must start from the same branch while any of the fleet's features are unfinished.
**Specs named while a fleet is running join its queue** — the same command, no flag: admission is
checked as at a launch, each admitted spec is dropped in `.builder/fleet/inbox/`, and the running fleet
picks it up the moment a lane frees (it polls every 15 s, so a spec added while every lane is busy
never waits for a run to end). `--parallel` is the running fleet's; adding never raises it. **A
parked feature named again is unparked and retried** — whatever parked it: the fleet sets `blocked:`
to `none` in a commit, `chore(<feature>): unparked for a fleet retry — was: <the old line>`, and the
first run is told what the park said so it can check whether the cause still holds. A spec whose
manifest is blocked where it was written is admitted the same way (the dry run says `unparks it`).
A parked feature you did not name stays parked — except that **the fleet retries every park on its
own**, `agent_walk.auto_unpark` times per fleet run (2 by default): it unparks the feature and hands
its park record (REFERENCE §The park record — `<folder>/PARKED.md`, which the fleet writes when the
parking run didn't) to a fresh run that digs from *Where to dig*. A `kind: human-step` park — your
uncommitted changes in the way, a `commit: manual` app — waits for you.
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
until they are merged into the target, then is branched from it, so it builds on its
dependencies' merged code. A dependency that isn't in the run and hasn't shipped refuses the child
(`✗ <child> — waits on <dep> (<state>) — not in this run`); one that parks or fails parks its
waiters too, naming it.

## 1. Where it stands — `/builder:fleet:status`

`/builder:fleet:status` (commands/fleet/status.md) shows the table and says how to read it; asked
here, follow that file. `--status` on this skill still works and means the same.

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

**First, the test plan.** Every spec whose manifest has no `tests:` gets the test plan asked ahead
— `/builder:plan` §Picking the test plan ahead: the slice table per spec when `PLAN.md` exists, the
questions in plain words when it doesn't (up to four specs per AskUserQuestion call, briefed first per
REFERENCE §Before a picker), **Land on?**
once for the run, the *Walk it yourself before it lands?* follow-up. Write and commit `tests:` and
`target:`; the target becomes the run's `--into`. A spec already carrying `tests:` — or an old
`profile:` line, which `profile.mjs` maps — isn't asked again. These choices set how much the agents
test and when they review, so they are asked even though the run is unattended.

Then, above the question, **one line per spec** — REFERENCE §The review at this point: what changes
for users, in plain words from its SPEC §Idea, and its test plan:

~~~
cert-tags     — owners tag certificates and filter the list by tag (web, mobile) · tests own · touched · end
cert-history  — owners see every change made to a certificate, newest first (web) · tests own · touched · end
~~~

Never a list of folder paths: the human is confirming what the agents will build.

Then one AskUserQuestion — **Start the fleet** / **Not now** — whose question restates: how many specs, the
worktree root, the permission args (`claude <claude_args>`), and "merges each finished feature
into <the target> (merge_into, or --into), one merge commit each; nothing is pushed". When the
target is checked out here, mention uncommitted changes in this checkout (`git status --short`): the
fleet merges into this working tree, and a merge that would overwrite one of them parks that feature
until it is out of the way. When it isn't, the merge is written onto the branch without touching
your checkout.
After the test plan, this is the only question the fleet asks.

**A fleet is already running** (the dry run said `adds to the running fleet`): the options are **Add
to the running fleet** / **Not now**, and the question says how many specs join the queue and that
they start as lanes free — the running fleet's `--parallel` stands.

## 4. Launch

Run it **in the foreground**, with `--detach`:

```bash
node <builder>/scripts/fleet.mjs <the same arguments> --detach
```

It starts the fleet in its own session — output to `.builder/fleet/fleet.out` — prints
`fleet started detached (pid N)` and returns at once. 🔴 **Never** launch it as a background task of
this session (the Bash tool's `run_in_background`, or any agent's equivalent): a session's limit on
background tasks, or the session ending, kills the fleet with it — mid-run, with no record of why.
Detached, it outlives the session, and nothing is waiting on it here.

**Adding to a running fleet:** run the same command in the foreground — it drops the specs in the
inbox and returns at once. Print its `↳` / `✗` / `↻` lines, then the footer:

~~~
📍 fleet: <n> spec(s) added to the running fleet — next: /builder:fleet:status
~~~

and stop; the rest of this section is the launch of a NEW fleet.

When the config's `agent_walk.start` is set, each walk in the walk lane gets its own dev env: the
fleet starts it fresh after `reset`, polls `smoke` until it's up, and always stops it after the
walk ends — for any reason, including a park — before running `stop`. An env that won't come up gets
one agent run to find and fix the cause in the branch, then one more try; readiness that needs the
env restarted gets it restarted by the fleet.

**Walks run in batches.** With `agent_walk.start` set, the walk lane takes every feature waiting to
walk — up to `agent_walk.batch` (default 8; 1 walks one feature at a time, as before) — merges their
branches onto the target in a walk worktree of its own (`<worktrees>/_walk`, branch `builder/_walk`,
never merged, removed when the fleet ends), brings the env up **once** (`reset` once), and runs one
session there: readiness for the batch, one walker going screen by screen across every feature
(agent-walk §Batched walks), each verdict written in that feature's own worktree. The deep set's
`@walk` lines then run once against that env, into each feature's `walk-gates.md`. A feature that
conflicts with the others waits for the next batch. The walk lane does nothing else: a walk's fixes,
verify and ship run in the parallel lanes with no env, and a fixed feature rejoins a later batch,
which re-walks only what its fix changed. A batch whose env won't come up falls back to one walk
per feature, with the env-repair run.

A run is killed only when it goes **quiet** — 30 minutes with no output
(`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`) — so a long build that is
still working is never cut off. Each run's words go to `.builder/fleet/logs/<feature>-NN.log` as it
works, its raw stream to the `.jsonl` beside it. A run that changes nothing gets one more run before
the feature parks.

Then say, in two lines: it's running on its own and outlives this session; `/builder:fleet:status`
shows where it stands (and the `builder` status line, if it's on), and §5's report is what
`/builder:fleet:status` shows once every row has landed, parked or failed. Nothing waits on it here,
so a park is told where you look instead: the status line reads `⛔ <feature>: <why>` (and keeps it
after the fleet exits, until a new run changes the row), the next session's brief lists each parked
or failed feature with its next step, and `.builder/fleet/fleet.out` gets a block per park — why,
next, and its PARKED.md. A feature with no commit or ledger tick for 45 minutes gets a `⚠` there and
a line under `/builder:fleet:status`. A fleet whose process is gone with work mid-run shows
`⚠ fleet stopped` under the table, with the `--detach` command that resumes it.

## 5. When it finishes

When asked after the fleet has ended (`/builder:fleet:status` shows no row in flight), reply with `.builder/fleet/STATUS.md` as markdown — the table as a table, not in a code fence — as
§1 does. Then, briefly:

- **done** — merged into the target, its worktree and branch removed, and archived: the row leaves the table for
  `.builder/fleet/archive.jsonl`, the spec folder is under `<registry>/_archive/`, and its logs under
  `.builder/fleet/logs/_archive/` (kept `agent_walk.keep_logs` days, 30 by default). `git log --merges`
  lists them. Test the result here; push when you're happy. `git revert -m 1 <merge>` takes one back out.
- **parked** — the fleet already retried it `agent_walk.auto_unpark` times. STATUS.md's `## Parked`
  list gives each one's why and its recommended `next:` step, and `<folder>/PARKED.md` in its
  worktree has the investigation — what was tried, the evidence, where to dig; relay the why and the
  next step, and point at the record. Naming it again (`/builder:agent`, or `/builder:fleet <feature>`) unparks and retries
  it — answer what it asks in the SPEC first when the next step says so. A park whose why is not a
  decision the spec left open or a step the config reserves — a conflict, a gate, a walk — is work
  the agents should have done; retrying it is the right next step.
- **failed** — the log path.

**Then the review of what landed** — REFERENCE §The review: nobody approved these designs, the audits
or the go-aheads (the run asked nothing), so this is where the human sees them. For each merged
feature, the full review of what was built, sections 1–8, written from its archived
`<registry>/_archive/<feature>/SPEC.md`, every ruling the run took marked `(auto)` — in parts, one
feature after another, each part but the last ending `A. Looks right — next part` · `B. Something's
wrong — say what`. B on a merged feature → a fix is new work (`/builder:brainstorm`), or
`git revert -m 1 <merge>` takes it back out; say which fits. A parked feature gets no review — it
did not land.

**Then the lessons the agents proposed** — each merged SPEC's `lesson for §Standing traps` rows (ship
§At ship). None → nothing. Otherwise list them, one line each with its feature, and one
AskUserQuestion, multi-select, every lesson an option: the ones picked are appended to the config's
`## Standing traps` as `- <the line> (<feature>, <date>)` and committed on the current branch,
`chore(builder): standing traps from the fleet`; the rest stay in their SPECs.

~~~
📍 fleet: <n> merged into <branch> · <m> parked · <k> failed — next: test <branch>; settle the parked ones, then /builder:fleet again
~~~
