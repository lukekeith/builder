# Agent mode — resume under `--agent-walk`

What `/builder:resume` does when it runs unattended (`/builder:agent`, `/builder:fleet`): every pause
taken without asking, the feature carried all the way to merged. The route table and everything else
stay in [`SKILL.md`](SKILL.md); this file is printed by `node <builder>/scripts/docs.mjs resume-agent`.

**Contents:** §`--agent-walk` · §Ship in agent mode (`--agent-walk`)

## `--agent-walk`

Unattended mode, for `/builder:fleet` (REFERENCE §Flags). It **implies `--auto`** and is recorded on
the manifest as `agent-walk: on YYYY-MM-DD`, so a cold session keeps it. That persisted line governs
unattended runs only: a human `/builder:signoff` sets it to `agent-walk: off`, so the human's own
`/builder:resume` afterwards is interactive and offers **Mark PR ready**. No `agent_walk:` block in the
config → refuse in one line naming `/builder:init --update`.

🔴 **Never call AskUserQuestion or ExitPlanMode** — nobody is there to answer, and a headless run that
asks hangs until it times out.

🔴 **Nothing runs in the background, and no turn ends waiting.** A headless `claude -p` run **exits
when its last turn ends**, and whatever it left running goes with it — a gate suite cut off half-way,
a reviewer whose verdict is never read, a feature the fleet then parks for "no progress". So under
`--agent-walk`, in this command and every step it runs:

- **Never** `run_in_background` on Bash or Agent, never `ScheduleWakeup`, `Monitor` or a cron.
  Subagents run in the foreground, several in one message when they are independent.
- **A command that may outlast one Bash call** (a gate suite, an e2e run, a CI watch) is started with
  `node <builder>/scripts/job.mjs start <name> -- <command>` and then waited on in the foreground,
  **Bash timeout 600000**, with `node <builder>/scripts/job.mjs wait <name>` — again and again while it
  prints `still running` (exit 75), until it prints an exit code. That code is the gate's result.
  Gate suites are always `scripts/gate.mjs` (REFERENCE §Quality gates), so the command under `job.mjs`
  is `node <builder>/scripts/gate.mjs …`, never the config's commands pasted by hand.
- **Never kill a process you did not start in this run**, and never `pkill`/`killall` by pattern:
  other fleet worktrees share this machine, and their suites look exactly like yours. Wrap a command
  of yours that may hang in `timeout`.
- **The run's last message is a handoff after the work finished** — never "waiting on …", "I'll
  pick this up when …", or "still running". Work that cannot finish in this run ends at a committed
  manifest the next run resumes from.

🔴 **Agent mode builds to done. It does not park on work.** A spec the human approved and handed
to agents has no reason to stop short of merged: a merge conflict, a red gate, a failing agent walk,
a plan that came out large, a dev env that won't start — each of those is work, and the run does it.
A park is reserved for **a product decision the spec leaves open that no ruling can responsibly
settle** — which means the spec was not finished — and for the few steps the config reserves to the
human (below). "It's a big call", "the human might want to review this", "a lot of decisions were
auto-ruled" are never reasons: rule, record the ruling where the hand-off lists it, and keep going.

Every point that would ask resolves one of two ways:

- **Take the recommendation** — the default, and the answer for anything local and reversible,
  which after a local-only merge is nearly everything: the human tests the result and changes what
  they don't like.
- **Park** — only for the cases above. Write `blocked: "<why> — next: <step>"` (REFERENCE §How a park reads) and `next:
  /builder:resume --path <folder>` to the manifest, **and `<folder>/PARKED.md`** (REFERENCE §The park
  record — everything a cold reader needs to dig: what is stuck, what was tried, the evidence quoted,
  where to dig), commit both `chore(<ticket-or-feature>): <feature> — parked: <reason>` — write
  PARKED.md, then one call:
  `node <builder>/scripts/advance.mjs <folder> --set 'blocked="<why> — next: <step>"' --set "next=/builder:resume --path <folder>" --add <folder>/PARKED.md --head --commit "chore({key}): {feature} — parked: <reason>"` —
  print the footer, and **end the run**. The reason names the decision the spec is missing, in one line the
  human can answer.
- **A run started after an unpark** — the fleet's prompt says the feature *was parked before* and
  quotes the old line. **Read `<folder>/PARKED.md` first**: it is the investigation so far. Treat it
  as a lead, not a verdict — find out whether its cause still holds in the code and the spec as they
  are now (a newer builder may not stop there at all, a fix may have landed since, a ruling may now
  settle it). Start from *Where to dig*, find the root cause before trying the same fix again
  ([`systematic-debugging`](../systematic-debugging/SKILL.md)), and add what you try under *What was
  tried*. Park again only if it still stands — the line written fresh to REFERENCE §How a park reads
  and the record's sections rewritten with what this attempt learned, never copied back.

| Pause | Under `--agent-walk` |
|---|---|
| Decisions gate · go-ahead · prototype gap · audit code defect | as `--auto`: the recommendation, recorded `auto (recommended)`. 🔴 **A go-ahead is never a reason to park**, however many decisions were auto-ruled on the way to it: handing the feature to agents was the go-ahead. A run that wrote `blocked: "no human go-ahead …"` misread this table |
| A plan that wants to split | build it whole — record `Ruling: built as one feature under --agent-walk — <the split it wanted>` (plan §Writing the plan's dials). Never a park |
| An open scope question the spec can't answer, and no ruling can settle without guessing at what the product should be | park — the spec needs a human. A question a reasonable reading of the SPEC settles is a ruling, not this |
| An audit `blocked:` finding | park, citing it — it is a spec defect (a released contract it would break, a promise it can't keep) |
| A merge conflict · a red gate · a failed agent walk · a dev env that won't come up · a stalled step | work it — never a park. The fleet hands conflicts and env failures to a run of their own (fleet §What it will do) |
| An app the config marks `commit: manual` | park at the start of that app's phase; earlier phases stay committed |
| Dev-DB migrations (§Walk readiness) | `apply_mode: ask` → apply · `human` → park · `agent` → apply |
| Starting or restarting the dev env | never, when `agent_walk.start` is set: the fleet owns it (REFERENCE §Walk readiness) |
| The walk | `/builder:agent-walk --path <folder>` — on PASS it writes the **agent sign-off** and condenses |
| The sign-off | the agent sign-off above — labelled 🤖, never a human's; `/builder:signoff` stays human-only |
| The ship commit and the merge into the target | §Ship in agent mode, no question — handing the feature to agents was the permission for all of it |
| A fix that needs `.claude/builder.md` changed — an `agent_walk.env` value, a gate line, a hook | 🔴 **never edit the config** — the fleet reads the main checkout's copy, so an edit in this worktree does nothing, and the config is the human's to change. Park as a **human step**: `blocked: "config change needed — <what and why> — next: apply the diff in PARKED.md to .claude/builder.md on <target>, then /builder:agent"`, with `<folder>/PARKED.md` (`kind: human-step`) carrying the exact diff and, when you can tell, the value's required form (a JSON list for a pydantic `List[str]`, say). The fleet also parks any branch that changed the config before it merges |
| **Walk env of the fleet's own** (`agent_walk.start` set — batched, `agent_walk.batch` > 1, or one at a time) | the walk lane holds only what needs the running env — readiness, the agent walk and the `@walk` lines; batched, several features per walk (agent-walk §Batched walks). A walk's `## Fixes`, verify and ship run in the parallel lanes under `--no-dev-env`. A verify INCOMPLETE whose fix changes something a walk covered sends the feature back for a re-walk: `advance.mjs <folder> --set state=built --set walk=none --set verify=none --set "next=/builder:agent-walk --path <folder>" --head --commit "chore({key}): {feature} — re-walk after verify fixes"` — the next batch walks only what changed and signs it off again |
| A gate run exits 3 — the walk env stopped answering after it | `blocked: "walk env needs a restart — <what broke it>"`, commit, end the run: the fleet restarts it without a reset (REFERENCE §Quality gates — the mechanism, *Gates and the walk env*) |
| **Any other point that would ask, including ones added later** | the rule above. A pause missing from this table is never a reason to ask |

**The flags carry through:** every step this command runs gets `--auto --agent-walk`, and
`--no-dev-env` when this run has it — `--auto` too, because plan, audit and align read `--agent-walk`
only to park (a plan's split) and would otherwise still raise their own pauses (a plan step's
`ExitPlanMode` for the go-ahead, for one); they do already honour `--auto`, so that's what settles them. Under
`--no-dev-env`, reaching walk readiness writes `ready: pending "dev env (fleet walk lane)"`, commits
(build §When the last phase signs: `advance.mjs … --commit walk-lane`), writes the hand-off
(`handoff.mjs write`), and ends the run.

🔴 **A fresh context per stage — under `--no-dev-env` (the fleet's build lane).** End the run, with
its handoff, at two more commits: **the audit's** (`state: audited`) and **the go-ahead's**
(`state: planned` with `go-ahead:` set). The fleet sees a manifest that moved and starts the next run
on it at once, with a clean context. Everything the next stage needs is on disk — SPEC §Findings and
§Decisions, `PLAN.md`, the manifest, the workspace — while what this run holds is the audit's and the
plan's whole reading, which a build loop would otherwise re-read on every one of its turns: measured,
an orchestrator entered its first implementer dispatch already holding 190–300k tokens. A stage that
ends any other way (a park, a stop) ends as it always has. Outside the fleet — no `--no-dev-env` —
the steps run on in one turn, as below.

**Under `--walk-lane`** (the fleet's walk lane when it owns the walk env) the run does only what needs
the running env — walk readiness and the agent walk — and **ends the run** at `state: signed-off`,
or as soon as the walk writes `## Fixes`: verify, the fixes and ship are the parallel lanes', away
from the folder the env serves from. Never run a gate suite or a build in this run.

**Agent mode's job is a feature merged into the target branch.** A run that stops short of that
without a `blocked:` line has not finished — the fleet runs it again. What it never does, at any step:
write a **human** sign-off (or run `/builder:signoff`), lift a `hold:`, push, open a PR, commit in a
`commit: manual` app, or deploy. None of those is needed to reach merged-into-the-target, so they are
left to the human — only `commit: manual` and `hold:` stop the feature, and they park.

## Ship in agent mode (`--agent-walk`)

Agent mode lands every feature on **one branch: the one the human ran `/builder:agent` or
`/builder:fleet` from**, which the fleet passes as `--into <branch>`. It opens no PR and pushes
nothing — pushing that branch, and any PR from it, stay the human's. The feature has an agent
sign-off (`walk: agent-pass …`, SPEC header `> 🤖 AGENT SIGNED OFF …`) and `verify: READY`. This
runs without a question; a step that can't finish **parks** (`blocked:` + commit + end the run, per
§`--agent-walk`). Long waits go through `scripts/job.mjs`.

1. **Pre-flight.** No `--into` → park `"no target branch — run it through /builder:fleet"`.
   `hold:` set → park (the hold is the human's).
2. **Bring the target in.** `git merge --no-edit <into>` — a local branch, visible from this
   worktree.
   - Nothing new → go on.
   - Nothing new is the normal case: the fleet merges the target into the worktree before every
     build-lane run and before the walk env starts, so the tree already carries it.
   - Merged cleanly with new commits (another feature landed first) → `node <builder>/scripts/gate.mjs
     <every in-scope app>` (through `job.mjs`). The runner re-runs only the apps whose inputs the
     merge changed and quotes the rest. Red → each failure a `- [ ] <app>: … (target sync)` under
     `## Fixes`, fixed per §Working `## Fixes`, gates green, then on.
   - Conflicts → **resolve them, always.** The other side is features that already merged, this side
     a spec the human approved; both are settled, so the job is code that does both. Read this SPEC
     and `git log -p MERGE_HEAD --not HEAD -- <file>` for each file, keep both behaviours, and where
     they truly disagree keep the merged feature's behaviour working while still meeting this spec —
     a ruling in the merge commit message. Then `gate.mjs` for the in-scope apps, fixes until green,
     and commit the merge. Never `git merge --abort` to park.
3. **Ship.** `/builder:ship --path <folder> --into <into>` (its §At ship, agent form) — the SHIPPED
   header naming `<into>`, `MANIFEST.md` removed, the workspace removed, a program child's line set
   to `shipped` — one commit.
4. **End the run.** The fleet merges this branch into `<into>` in the human's checkout (one `--no-ff`
   merge commit per feature, `merge(<feature>): agent-verified, not human-tested`) and removes the
   worktree. Hand off with every ruling the run made, and:
   `📍 <feature>: shipped — merging into <into> (agent-verified, not human-tested)`.

A feature that already has a PR open (a draft from an earlier version of this pipeline) ships the
same way; the PR is left for the human to close.
