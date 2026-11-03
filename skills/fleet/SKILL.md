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
product decision open or the config reserves a step to the human, **parked** with that decision named. Then the verifier's **merge
queue** lands it on the branch checked out here — the whole suite on the feature merged onto it, then
a fast-forward to exactly that tested merge commit (`merge(<feature>): agent-verified, not
human-tested`). That merge-tier run is requested, held, when the walk starts and runs beside it.
Verify is optional after sign-off, so the fleet never runs the full `/builder:verify`: before the
ship run it makes the one-call quick check (`verify-quick.mjs`, no model), which reads that held
run and the spec's mechanical items — its gaps are noted in the report, never a block. A run
that goes red at landing (the target moved after the quick check read it green) parks the feature naming the
failing tests, and the fleet retries it. Then the fleet removes its worktree and `builder/` branch. **Migrations
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
the **walk** lane (walk readiness, agent walk, sign-off) runs one feature at a time; a signed-off
feature goes to the ship lane, which quick-checks it first. **Every
worktree is brought up to the target first**: before each build- or ship-lane run, and before the
walk env starts (at walk readiness — never between readiness and the walk), the fleet
merges the target branch into the worktree, so a feature builds on what the others have landed and
the ship step's own merge finds nothing new. **A conflict there goes to an agent**: the merge is left
in progress and a run of its own resolves it — both sides kept, the phase tier green, the
merge committed — and the feature carries on; only a conflict two such runs could not resolve parks.
The merge tier merges the target in itself; a conflict goes to an agent in the feature's worktree,
and a target that moved during the run is tested again. When a merge into the worktree brings new
commits, `agent_walk.sync` runs in the worktree — the install and the test-DB migration a merged-in
package or migration needs (without it, a walk env once failed on a package the merge had just added).
**Builds run in parallel safely when each worktree has its own test database.** The verifier runs the
suites, each run in its own database cloned from a template (`verify.db`) — but an implementer still
runs its own task's tests in its worktree, and a fix round re-runs them, so database-backed tests
there need `agent_walk.worktree_env` (`TEST_DATABASE_URL=…_{feature}`, say), which reaches every run
and `setup` in a worktree with `{feature}` filled in. With it, `parallel: 3` (the default); without
it, use `parallel: 1`.

**A program chain runs to the end in one fleet run.** A child whose PROGRAM §Children *Depends on*
entries haven't shipped **waits** (`⏳ <child> → <branch>, once <dep> merges`): it gets no worktree
until they are merged into the target, then is branched from it, so it builds on its
dependencies' merged code. A dependency that isn't in the run and hasn't shipped refuses the child
(`✗ <child> — waits on <dep> (<state>) — not in this run`); one that parks or fails parks its
waiters too, naming it.

## 1. Where it stands — `/builder:fleet:status`

`/builder:fleet:status` (commands/fleet/status.md) shows the table and says how to read it; asked
here, follow that file. `--status` on this skill still works and means the same.

### A park that needs you — its choices

A `## Parked` entry whose why starts `needs you:` (or, from a 5.x row, `uncommitted changes are in
the way`) is a landing your uncommitted changes refused: the feature is built, signed off and
merge-tested on its branch, but landing it would change files you are editing in the target's
checkout, so the fleet stopped before touching any of them. Its `files:` line lists every one (a 5.x
row has none: `git status --porcelain` then names your changes); the record is
`.builder/fleet/parked/<feature>/PARKED.md`. After the status reply, raise each such park — one
screen each, never as a path to go and read:

1. **The review**, in plain words — what it is, every file, and what each choice does:

   > **`<feature>` is ready to land on `<target>`, but it needs you.** It's built, signed off and
   > merge-tested on `builder/<feature>`. Landing it would change <n> file(s) you have uncommitted
   > edits in, so builder stopped before touching any of them:
   >
   > - `<file>` (one bullet per file)
   >
   > What each choice does:
   >
   > - **Set my changes aside, land, put them back** — all your uncommitted changes go into a stash
   >   named `builder: before landing <feature>`, the feature lands, and your changes come back on
   >   top. If one clashes with what landed, the stash is kept, the files are listed and you're told
   >   how to finish — builder never drops or force-resolves them.
   > - **Commit my changes, then land** — you see the files and a commit message first; they're
   >   committed on `<target>` only once you approve, then the feature lands on top.
   > - **Leave it for now** — nothing changes; the reminder stays, and the next fleet run lands it
   >   once your changes no longer overlap it.
   >
   > **I recommend <the choice>** — <why, below>.

   **The recommendation:** 3 files or fewer → **Set my changes aside, land, put them back** — "only a
   few files: if one clashes when it comes back, it's quick to settle, and nothing of yours is
   committed under a message you didn't write". More than 3 → **Commit my changes, then land** —
   "with this many files a clash on putting them back is likelier, and it would be left in your
   checkout; committed first, your work is safe in git and any clash is the landing's to settle on
   the feature's branch".
2. **One picker** (AskUserQuestion, header `<feature>`, question "How should `<feature>` land?"):
   the recommended choice first with ` (Recommended)` on its label, then the other, then **Leave it
   for now**. Nothing else on the screen is a list of options.
3. **On the answer**, from the repo root (`<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts):
   - **Set aside** → `node <builder>/scripts/fleet.mjs --land <feature> --set-aside`.
   - **Commit** → one more screen first. The commit takes every tracked change (`git add -u`) and the
     untracked files among the park's files — no other untracked file, never an ignored one. From
     `git status --porcelain` show *This commit holds <n> files:* and each file, then any untracked
     file it leaves out, then a proposed message — one line, in the style of `git log -5 --oneline`,
     drawn from `git diff HEAD` of those files. One picker, header `Commit`: **Commit with this
     message (Recommended)** · **I'll write the message** · **Don't commit — leave it**. Only on the
     first (or the message the user writes) run
     `node <builder>/scripts/fleet.mjs --land <feature> --commit-mine "<message>"`; on the last,
     nothing runs.
   - **Leave it** → nothing runs. Say it stays parked, the status line keeps `⛔ <feature> needs you`,
     and the next session's brief raises it again.
4. **Its exit**, relayed — never a silent stop:
   - **0** — landed, and your changes are where you left them (or committed, as it says). Relay its
     lines; next step, in words: test `<feature>` on `<target>` — agent-verified, not human-tested.
   - **1** — something is left for you, and the output says what: show it whole (the file list and
     the steps to finish), then say the next step in words — resolve those files, then drop the
     stash as its last line says; or, when it didn't land, its `next:`. Offer to go through the
     conflicts with them file by file; never resolve them or drop the stash unasked.
   - **2** — refused, nothing touched: say why (its one line) and that nothing of yours changed.
   - **3** — a fleet is running in this repo: nothing was touched; the landing waits for it.
     `/builder:fleet:status` shows when it has finished — then choose again.

A note under the table reading `⚠ <feature> landed on <target>, but your changes set aside for it
came back with conflicts in …` (or, when the landing failed, `⚠ <feature> your changes set aside for
it came back …`) is the same story a session later: say it in words right after the table — the
files, that nothing of theirs was dropped (it is all in the kept stash), and the two steps to finish:
resolve those files, then `git stash drop` the stash the note names. Offer to go through them; run
nothing unasked.

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
walk and when they review, so they are asked even though the run is unattended.

Then, above the question, **one line per spec** — REFERENCE §The review at this point: what changes
for users, in plain words from its SPEC §Idea, and its test plan:

~~~
cert-tags     — owners tag certificates and filter the list by tag (web, mobile) · tests none · end
cert-history  — owners see every change made to a certificate, newest first (web) · tests none · end
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
`fleet started detached (pid N)` once the fleet holds its lock (a few seconds, at most 30). If it
prints `fleet exited at once` instead, the fleet never started: relay that output and its `fleet.out`
tail, and start no watcher. 🔴 **Never** launch it as a background task of
this session (the Bash tool's `run_in_background`, or any agent's equivalent): a session's limit on
background tasks, or the session ending, kills the fleet with it — mid-run, with no record of why.
Detached, it outlives the session.

The **watcher** is the opposite: right after that line (it prints only once the fleet holds its lock),
also run `node <builder>/scripts/fleet.mjs --wait` as a background task of this session (the Bash
tool's `run_in_background`). It prints nothing while the fleet runs; when the fleet exits it prints
what `--status` prints and ends 0 — without marking it seen: only opening `/builder:fleet:status`
does, so an overnight finish still shows on the status line and in the next brief. Its completion
notice is the cue to reply with §5's report — only when its output is that status: a watcher that
was killed or ended non-zero is not a finish. The fleet is never the background task; the watcher is,
because if the session ends or the task is killed nothing is lost — the status line and the next
session's brief still tell.

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
(agent-walk §Batched walks), each verdict written in that feature's own worktree. A feature that
conflicts with the others waits for the next batch. The walk lane does nothing else: a walk's fixes,
the quick check and ship run in the parallel lanes with no env, and a fixed feature rejoins a later batch,
which re-walks only what its fix changed. A batch whose env won't come up falls back to one walk
per feature, with the env-repair run.

A run is killed only when it goes **quiet** — 30 minutes with no output
(`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`) — so a long build that is
still working is never cut off. Each run's words go to `.builder/fleet/logs/<feature>-NN.log` as it
works, its raw stream to the `.jsonl` beside it. A run that changes nothing gets one more run before
the feature parks.

Then say, in two lines: it's running on its own and outlives this session; while this session is open
the chat reports when it finishes (the watcher), otherwise the `builder` status line and the next
session's brief tell; `/builder:fleet:status` shows where it stands any time. A merge: the status line
reads `✔ <feature> merged — /builder:fleet:status` once the fleet has exited (on a narrow line,
`✔ <feature> merged`, then `✔ <n> merged`; never folded into "+N more"), and the next session's brief names it with its sha
and "test it yourself" — both until `/builder:fleet:status` is opened, which then offers the wrap-up
(§5): anything this checkout needs before you test what landed — the migrations, a restart, the
fixtures, the merged branches — in one answer. Say that, rather than offering to run those steps
yourself later. A park: the status line reads `⛔ <feature>: <why>` (and keeps it
after the fleet exits, until a new run changes the row), the next session's brief lists each parked
or failed feature with its next step — one that needs you (your uncommitted changes in a landing's
way) leads the status line as `⛔ <feature> needs you: <why> — /builder:fleet:status`, the command
never cut, and the brief says `⛔ <feature> needs you — <why> — /builder:fleet:status to choose`
(§1 *A park that needs you*), and `.builder/fleet/fleet.out` gets a block per park — why,
next, and its PARKED.md. A feature with no commit or ledger tick for 45 minutes gets a `⚠` there and
a line under `/builder:fleet:status`. A fleet whose process is gone with work mid-run shows
`⚠ fleet stopped` under the table, with the `--detach` command that resumes it.

## 5. When it finishes

When the watcher ends 0 with the status as its output, or when asked after the fleet has ended (`/builder:fleet:status` shows no row in flight), reply with `.builder/fleet/STATUS.md` as markdown — the table as a table, not in a code fence — as
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
  decision the spec left open or a step the config reserves — a conflict, a red verdict, a walk — is work
  the agents should have done; retrying it is the right next step.
- **failed** — the log path.

**Then the wrap-up** — what's left to do in this checkout now that features landed:
`node <builder>/scripts/wrapup.mjs plan --json`. Its steps run in the order they stand on each
other — check out the target, apply the landed migrations to the dev DB, restart, reset the fixtures,
smoke, delete the branches already in the target — each from the config's §Walk readiness (`apply:`,
`regenerate:`, `restart:`, `fixtures:`, `smoke:`) or tidy. No steps and nothing held → say nothing
and go on. Otherwise, above the picker (REFERENCE §Before a picker), in plain words: **what is being
decided** — whether to run them now, here; **the options** — each step on its own line with what it
does (its `title`), then the held ones and why each is held (a migration that may drop data, a
dirty tree in the way, a branch only `/builder:tidy` can settle — never in "all"); **why the
recommendation** — every step is what you'd otherwise do by hand before testing what landed, and
none of them is held. One AskUserQuestion: **Wrap up — all <n> steps (Recommended)** · **Choose
steps** · **Not now**. All → `wrapup.mjs run all`; Choose → one more AskUserQuestion, multi-select,
a step per option, then `wrapup.mjs run <ids…>`; Not now → `wrapup.mjs dismiss`. Print each line it
prints. A `✗` stops the steps after it: name the step, point at the log it names, and say what the
rest would have done. A sentence never offers to run these later from another session — this picker
is where they run.

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
