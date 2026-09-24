# The execution engine — the task loop `/builder:build` runs

Adapted from superpowers' `subagent-driven-development` (MIT — see
[LICENSE-THIRD-PARTY.md](../../LICENSE-THIRD-PARTY.md), which lists what the adaptation changed).
`builder:build` is the wrapper; this file is the loop.

**Core principle:** a fresh implementer per task + a task review (spec + quality) after each + one
broad review at the end = high quality, fast iteration.

**Why subagents:** you delegate to agents with isolated context. By crafting their instructions
precisely you keep them focused; they never inherit your session's history — you construct exactly
what they need. That also preserves your own context for coordination.

**Narration:** between tool calls, narrate at most one short line — the ledger and the tool results
carry the record.

**Continuous execution.** Do not pause to check in between tasks. Execute every task the phase
holds. "Should I continue?" prompts and progress summaries waste the human's time — they approved
the plan, so execute it.

**Rulings, not stalls.** A running plan does not wait on a human. Conflicts, ambiguities, plan
defects, a cap you would have asked to exceed — decide them. The SPEC is the binding authority, the
plan is its argument, and your judgment settles what neither answers. Record every decision in the
ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and keep going. A wrong
ruling costs rework the human can see and undo; a session parked on a question costs their whole day
and buys nothing.

**Five things stop you, and only these:** an irreversible or destructive operation; a
security-sensitive action; a side effect outside this repo that norms say you ask about first (a
push, a merge, a publish, a deploy); **a commit in an app the config marks `commit: manual`**; and a
plan so broken that every path forward is a guess. For those, stop and ask.

---

## Setup

Conversation memory does not survive compaction. Controllers that lost their place have re-dispatched
entire completed task sequences — the single most expensive failure observed. **Track progress in a
ledger file, not only in todos.**

1. **Workspace.** `<plugin>/scripts/workspace <feature>` prints and ensures it. Every brief, report,
   review diff, the ledger and `walk.md` live there; it is git-ignored and never committed.
   🔴 **A shell variable does not survive between Bash calls** — the working directory persists,
   shell state does not. Never resolve a path in one call and use the variable in the next: it
   expands to nothing and the brief lands at `/task-1-brief.md`. **Re-resolve inline in every
   command**, and below `<WS>/` is shorthand for that command substitution written out in the same
   command, never for a variable.
2. **No worktree, no branch.** Build on the branch already checked out. If it differs from the
   manifest's `branch:`, print ONE warning line and continue; never check anything out.
   🔴 **On the config's `base_branch`, dispatch nothing and commit nothing** — stop and say the human
   cuts the branch. (Upstream got this guard from its worktree step, which this family does not use.)
3. **Ledger** `<WS>/progress.md`, whose first line is its identity:
   `# builder ledger — plan: <folder>/PLAN.md`. Create it with that line if absent. If an existing
   ledger's first line names a different plan, it is another feature's — leave it and start a fresh
   one. Keep an `## env notes` section: an environment fact that cost time here saves it next
   session. **The ledger is your recovery map** — the commits it names exist in git even when your
   context no longer remembers creating them. After compaction, trust the ledger and `git log` over
   your own recollection. (`git clean -fdx` destroys the workspace; recover from `git log`.)
4. **Resume point:** the first `### Task N` in `PLAN.md` with no `Task N: complete` line in the
   ledger. Never re-dispatch a task the ledger calls complete. A task whose last ledger line is a fix
   round is mid-loop — resume the loop at the next round.
5. **Read the plan once**, note its Global Constraints, and create a todo per task. Read the SPEC
   too: it is the authority the plan argues from, and conflicts inside the plan resolve against it.
6. **Before Task 1 only — the pre-flight conflict scan.** Its output is a **table, not a verdict**:
   - one row for every pair of tasks sharing a file or an interface (one block's **Interfaces**
     Produces against another's Consumes, one block's **Files** against another's);
   - one row per task for whether its own **Files**, **Interfaces** and steps agree;
   - 🔴 one row per task for whether its **Files stay inside its `App:`** — a task reaching into
     another app breaks that phase's gates, which are one app's commands.

   "The scan is clean" without those rows is not a scan you ran. Write the table to the ledger, rule
   on every finding with the SPEC as binding authority, record each as `Ruling: …`, then dispatch
   Task 1. On a resume the table is already in the ledger — do not re-run it.

---

## Model selection

Use the least powerful model that can handle each role.

- **Mechanical implementation** (1–2 files, the block carries the complete code): the cheapest tier —
  it is transcription plus testing.
- **Integration and judgment** (multi-file coordination, a permission path, state plus its mutations):
  a standard model.
- **Architecture and design, and the final whole-branch review:** the most capable available.
- **Reviews:** the same judgment, scaled to the diff's size, complexity and risk. Scoped re-reviews
  of small fix diffs take a cheap-to-mid tier.
- **Fix-loop escalation (rounds 4–5):** at least one tier above the implementer that got stuck.

🔴 **Always name the model on every dispatch.** An omitted model inherits your session's — often the
most capable and most expensive — which silently defeats this section.

**Turn count beats token price.** Wall-clock and context cost scale with how many turns a subagent
takes, and the cheapest models routinely take 2–3× the turns on multi-step work. Use a mid-tier model
as the floor for reviewers and for implementers working from prose.

---

## The task loop

**Batch small same-shape work.** Several tasks that are each a small, independent edit of the same
kind — the same field added across files — go in ONE dispatch listing every file and its change,
reviewed as one unit. 🔴 **Only ever within one app.** Reserve one-dispatch-per-task for work with
its own judgment, tests or review surface.

Everything you paste into a dispatch prompt — and everything a subagent prints back — stays resident
in your context for the rest of the session. **Hand artifacts over as files.**

**Waiting on dispatched subagents.** Never poll a wait interface with short timeouts, and never sit in
one silent, open-ended wait either. While you have local work — ledger updates, packaging the next
review, reading reports — keep working; child results arrive on their own. When you are genuinely
idle, wait in bounded stretches (five to ten minutes, where your platform allows), and between
stretches post one line of status and reconcile your live children: list them, and chase any that
finished without reporting. A bounded stretch keeps nearly all of a long wait's efficiency while
guaranteeing a stuck or lost child is noticed within minutes, not at the end of the session.

### 1. Dispatch the implementer

Record **BASE** (`git rev-parse HEAD`) before dispatching — the review package and fix-round diffs
need it.

- **Task brief:** `<plugin>/scripts/task-brief <folder>/PLAN.md N "<WS>/task-N-brief.md"`. The brief
  is the single source of requirements; exact values (numbers, strings, signatures, test cases)
  appear only there. **Never make a subagent read the whole plan file.**
- **The dispatch carries:** one line on where this task fits; the brief path, introduced as *"read
  this first — it is your requirements, with the exact values to use verbatim"*; interfaces and
  decisions from earlier tasks the brief cannot know; your resolution of any ambiguity you noticed;
  and the report-file path.
- **Report file:** `<WS>/task-N-report.md`, named in the dispatch.
- A dispatch describes ONE task, not the session's history. Do not paste accumulated prior-task
  summaries into later dispatches — a real session's dispatch hit 42k chars of which 99% was pasted
  history.
- The implementer **never dispatches subagents** — not helpers, and never a reviewer. Review arrives
  from you, after the report. Every reviewer a worker spawned duplicated the review the controller
  dispatched anyway: a full extra seat per task.
- If an earlier task parked a finding in the area this task touches, carry a pointer to that ledger
  entry.
- Record the implementer's agent identity — fix rounds 1–3 resume it.
- **Never dispatch implementation subagents in parallel** (conflicts).

Template: [prompts/implementer.md](prompts/implementer.md)

### 2. Handle the report

**DONE** → generate the review package and dispatch the task reviewer.

**DONE_WITH_CONCERNS** → read the concerns first. Correctness or scope concerns are addressed before
review; observations are noted and you proceed.

**NEEDS_CONTEXT** → provide the missing context and re-dispatch.

**BLOCKED** → assess: a context problem gets more context and the same model; work needing more
reasoning gets a more capable model; a task too large gets broken up; a wrong plan gets a ruling,
ledgered, carried into the re-dispatch. 🔴 **Never ignore an escalation or force the same model to
retry without changes.**

If the implementer asks questions — before or mid-task — answer clearly and completely.

### 3. Review the task

Per-task reviews are task-scoped gates; the broad review happens once at the end. **Never skip the
task review, and never accept a report missing either verdict** — spec compliance AND task quality.
Implementer self-review never replaces it.

- **Hand the reviewer its diff as a file:**
  `<plugin>/scripts/review-package BASE HEAD "<WS>/review-<base7>..<head7>.diff"`. Use the BASE you
  recorded — **never `HEAD~1`**, which silently truncates a multi-commit task. Never dispatch a task
  reviewer without a diff file.
- **Reviewer inputs:** the same brief file, the report file, the review package — plus the global
  constraints, **plus SPEC §Contract**, so the diff is judged against the contract rather than
  against the implementer's description.
- The global-constraints block is the reviewer's attention lens: copy it verbatim from the config's
  §Global constraints and the SPEC. The template already carries the process rules.
- Do not add open-ended directives ("check all uses") without a concrete reason. Do not ask a
  reviewer to re-run tests the implementer already ran. 🔴 **Do not pre-judge findings** — if your
  prompt contains "do not flag", "don't treat X as a defect", "at most Minor" or "the plan chose",
  stop: you are pre-judging to spare yourself a review loop.
- The reviewer may report **⚠️ Cannot verify from diff** items — requirements living in unchanged code
  or spanning tasks. These don't block the rest of the review, but **you resolve each one yourself**
  before marking the task complete. A confirmed gap enters the fix loop.

Template: [prompts/task-reviewer.md](prompts/task-reviewer.md)

### 4. The fix loop

Triggered by spec ❌, any Critical or Important finding, or a ⚠️ item you confirmed. Two routes leave
it immediately:

- **Minor findings** go to the ledger (`Task <N>: minor (deferred): <one-liner>`) and the final review
  is pointed at that list. They never enter the loop.
- **A plan-mandated finding** — or any finding conflicting with the plan's text — is yours to rule on:
  weigh it against the plan with the SPEC as binding authority, and ledger the ruling before acting.
  Do not dismiss a finding because the plan mandates it, and do not dispatch a fix that contradicts
  the plan without a recorded ruling.

Everything else enters. A round is one fix dispatch plus one scoped re-review. **Five rounds maximum
per task.**

- **Rounds 1–3 — resume the original implementer.** Send the open findings verbatim; its context is
  intact. If your harness cannot message a live subagent, dispatch a fresh one carrying the brief
  path, the report path and the findings — the report file is the persistent memory either way.
- **Rounds 4–5 — a fresh implementer, one tier up**, with this framing: *"A prior implementer
  attempted this task N times; you own it now. Read the report file for what was tried."* A loop that
  survives three resumes usually means the implementer cannot see its own problem.
- **Every round:** the implementer fixes, re-runs the tests covering the amended code, appends its
  fix report to the same report file, and returns the short contract. Confirm the fix report names the
  covering tests, the command and the output before re-dispatching the reviewer.
- **The re-review is scoped:** `review-package FIX_BASE HEAD …` where FIX_BASE is the head the
  previous review saw. The re-reviewer verdicts each finding ADDRESSED or NOT ADDRESSED and flags new
  breakage **in the fix diff only**. New Critical/Important breakage joins the open list;
  out-of-scope observations go to the ledger as deferred minors and never extend the loop.
- **After each round:** `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <one-liners>; commits <a7>..<b7>)`

🔴 **Never fix findings yourself in the controller.** Your context stays clean for coordination, and
controller fixes skip review entirely.

Template: [prompts/re-review.md](prompts/re-review.md)

**The breaker.** When round 5's re-review still leaves findings open, stop dispatching and adjudicate
each one yourself — you hold the plan and cross-task context the reviewer lacks:

- **The reviewer is wrong, or the point is contestable:** park it —
  `Task <N>: parked — <finding> — Ruling: <why the code stands>`. The final review sees both sides.
- **Real, but nothing downstream builds on it:** park it the same way, ruled real and deferred.
- **Real and load-bearing** — a later task builds on it, or it reveals a plan defect: rule on the
  smallest change that unblocks the dependent work, ledger it, and carry it into the next task's
  dispatch. Parking a structural failure silently lets every dependent task build on it.

**Adjudicate only at the cap.** Adjudicating earlier to end a loop is pre-judging with a different
name. Every adjudication is a ledger entry — a silent discard is forbidden.

### 5. Complete the task

When the review is clean — or every open finding is parked with a ruling at the cap — append:

- `Task <N>: complete (commits <base7>..<head7>, review clean)`
- `Task <N>: complete (commits <base7>..<head7>, <K> parked)` after a tripped breaker

Then mark the todo complete and move on. **Never move to the next task while the review has open
Critical/Important issues** that are neither fixed nor parked-with-ruling at the cap.

---

## The final whole-branch review

After the last phase's tasks, not after each phase. Run
`review-package <merge-base> HEAD "<WS>/review-final.diff"` and dispatch
[prompts/final-reviewer.md](prompts/final-reviewer.md) **on the most capable available model**,
pointed at the ledger's deferred-minor and parked lines and at SPEC §Contract.

If it returns findings, dispatch **ONE** fix subagent with the complete list — not one fixer per
finding. Per-finding fixers each rebuild context and re-run suites; a real session's final-review fix
wave cost more than all its tasks combined. Then run **exactly one** scoped re-review of the fix wave.
Adjudicate residuals as in the breaker. **There is no second fix wave** — residual load-bearing
findings surface to the human in the hand-off.

---

## Finish

Collect every ledger line containing `Ruling:` — pre-flight rulings, parked findings, breaker
adjudications, all of them — into the hand-off under **"Rulings I made"**, in the order made, each
with what it costs if wrong. The list is exhaustive. **That list is the only place the decisions you
took on the human's behalf reach them.** A ruling that dies with the workspace was a decision made in
secret.

⛔ **Do not delete the workspace.** Upstream deletes it at its finish; here the walk,
`/builder:verify` and the sign-off still read the ledger, the reports and `walk.md`.
`/builder:ship` removes it, at ship.

---

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "Close enough on spec compliance" | Reviewer found spec gaps = not done. Fix, or hit the cap and adjudicate — those are the only exits. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. Resume the implementer. |
| "One more round will converge" | Past the cap, rounds don't converge — the failure is structural. Adjudicate and route. |
| "The reviewer will just find something new anyway" | Scoped re-reviews verify fixes; they cannot wander. New findings on untouched code go to the ledger. |
| "This finding is obviously wrong, I'll drop it" | You adjudicate only at the cap, and every ruling is a ledger entry. Silent discards are forbidden. |
| "The fix was small, skip the re-review" | Unreviewed fixes are how regressions land. Every round ends with a scoped re-review. |
| "Reviews slow the loop down" | The loop without reviews is just unverified churn. Reviews are its brakes and steering. |
| "Ledger bookkeeping is overhead" | The ledger is what survives compaction. Controllers without one have re-dispatched entire completed sequences. |
| "The implementer spawned its own reviewer — free extra assurance" | A duplicate seat reviewing the same diff. A worker-spawned reviewer is a defect to flag, not rigor. |
| "This phase only touches two files in another app, I'll fold it in" | Then the phase has no gates — they are one app's commands. Split it. |
