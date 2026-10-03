# Agents build every feature — design

> 2026-10-03 · builder 4.9.0 · status: draft for approval · record: `.builder/agent-builds/brainstorm.md`

## Why

Builder has two ways to build a feature once its plan is approved. **You drive it**
(`/builder:resume` → `/builder:build`), working on whatever branch is checked out, with no worktree,
on a branch you manage yourself. Or **agents drive it** (`/builder:agent` → `fleet.mjs`): a worktree
and branch per feature, an agent walk, verify, a one-at-a-time landing into `merge_into`, and a
cleanup. Since 4.8 the agent path lands in the right place and leaves nothing behind. The
hand-driven path still ties up your checkout, lands wherever you happened to be, and leaves branches
for you to manage.

Once the spec and plan are written there's no reason for the person to drive. What the person does
want is control over **how much** the build costs: a confident, small, single-app change can be
rushed, while a feature with schema changes, released consumers and many files deserves every check.

In the owner's words: *"move completely away from the user driving the build and always send it to
an agent. Once a spec and plan are written and ready for implementation, there's no reason to let the
user drive until it's done."* · *"more controls to the user to pull levers that affect time and
tokens required to build a feature."*

**Success:** you approve a plan once, choose a profile in one question, and get the feature back
merged (or parked with a plain reason). Time and tokens track the profile. Nothing lands on the wrong
branch, and no project that builds today stops being able to build.

## Decisions (from the conversation)

- **D1 — Agents build.** In a project with an `agent_walk` block, the go-ahead launches the fleet
  for that feature. Nobody drives `/builder:build` by hand there.
- **D2 — The target is recorded at the go-ahead.** `target:` goes on the manifest, defaulting to
  `merge_into`. It is shown in the question and can be changed, and is never inferred from the
  current checkout (the 4.8 lesson).
- **D3 — One profile question** at the go-ahead: Rush / Standard / Thorough / Thorough + you /
  Customize…, with the recommendation computed from the spec.
- **D4 — The levers:** testing, review during build, model tier, verify depth, persistence before
  parking, choices the spec left open, and landing.
- **D5 — Testing default:** agents test it, and you test on the target after it lands. The
  `--no-ff` landing makes `git revert -m 1` the undo.
- **D6 — Estimates** come from this repo's fleet history, scaled by plan size. They are shown as
  relative cost, never invented minutes, until there is enough history.
- **D7 — No `agent_walk` block → build by hand, as today.** The go-ahead says why in one line and
  offers to set it up. (finpro, makeready and fai-erp have no block today.)
- **D8 — Floors.** Every preset keeps each app's fast gates at its phase close, the final
  whole-branch review, and consumer parity when a `released_artifact` consumer is affected.
- **D9 — Presets are fixed.** An optional `build_profile_default:` key sets which one is
  pre-selected.
- **D10 — xs/sm work** built in chat by `/builder:brainstorm` is unchanged.
- **D11 — `/builder:revise` on a running feature** parks it at the next task boundary, writes the
  change in its worktree, and re-queues it.
- **D12 — History.** Each landing records time per lane, plan size, the profile, and tokens and cost.

## Design

### 1. The go-ahead launches the fleet (D1, D2, D7)

`/builder:plan` ends as today: the `## Phases` table and one approval through `ExitPlanMode`. Then,
in the same turn:

1. **No `agent_walk` block** → write `go-ahead:` as today and show the existing footer with only
   option 1, plus one line: `Agents build features once agent_walk is set up — /builder:init
   --update adds it.` This is the hand-built path, unchanged.
2. **Otherwise** → the profile question (§3), which also shows the target. Write `go-ahead:`,
   `profile:` and `target:` to the manifest and commit them with the go-ahead, then launch
   `fleet.mjs <feature> --detach --into <target>`. The "1. resume / 2. agent" footer is replaced by
   the fleet's launch line and `/builder:status` as the way to follow it.

`/builder:resume` routes the same way. A manifest at `state: planned` with a go-ahead, or at
`state: building`, in a project with `agent_walk`, goes to `/builder:agent --path <folder>` instead of
`/builder:build`. Under `--agent-walk`, nothing changes: that is the fleet's own run.

**The target and a running fleet.** A fleet has one target per run (4.8). A go-ahead whose target
matches the running fleet joins its queue. One whose target differs is refused with the existing
message, naming both targets, and the question offers to switch this feature to the running fleet's
target or launch it once that fleet finishes.

**Older manifests.** A manifest with a go-ahead but no `profile:` runs as **Thorough**, which is
exactly today's pipeline. No existing feature changes behaviour.

### 2. Profiles and their levers (D3, D4, D8)

| Lever | Rush | Standard | Thorough | Thorough + you |
|---|---|---|---|---|
| Testing | none; you test after landing | agent walks the **risky** walk items | agent walks every item | Thorough, then **your** walk before landing |
| Review during build | final review only | per task + final | per task + final + a second reviewer on contract and schema tasks | as Thorough |
| Model tier | `economy` | `default` (EXECUTION.md §Model selection) | `strong` | as Thorough |
| Verify | floors only | full gates + deep set; cross-app E2E only on the affected legs | everything, full cross-app E2E | as Thorough |
| Persistence | park early (1 walk round, no auto-unpark) | default (5 rounds, `auto_unpark`) | default | default |
| Choices the spec left open | take the recommendation, listed under "Rulings I made" | same | same | same |
| Landing | local `--no-ff` merge | same | same | same |

- **Floors (D8)** hold in every column and under Customize: each app's fast gates at its phase close,
  the final whole-branch review, and consumer parity when a `released_artifact` consumer is affected.
  Customize can't switch them off.
- **Model tiers.** `economy` moves mechanical *and* integration tasks to the cheapest tier that can
  do them. `strong` puts integration tasks and every review on the most capable model. `default` is
  EXECUTION.md as it stands.
- **Risky walk items.** These are the walk items verify's re-walk table already treats as risky
  (`skills/verify/SKILL.md:75`): a §Contract row, an auth or permission path, a load/save/delete path,
  a notification payload, or a deep-link target. Build tags each such item `[risk]` when it writes
  `walk.md`.
- **Customize…** asks the levers in two AskUserQuestion calls (testing, review, models, verify, then
  persistence, open choices, landing), each pre-filled from the recommended preset. Choices made
  this way are only valid there: the park-on-open-choice policy and PR + CI landing. PR + CI landing
  uses the existing ship path's PR and waits for CI before the merge.
- **Where the levers are read.** `scripts/profile.mjs` maps `profile:` to lever values
  (`profile.mjs --levers <folder>` → JSON). Build, agent-walk and verify read it under
  `--agent-walk`. The fleet reads it for persistence and landing. The skills never interpret a
  preset name themselves.

### 3. The question

```
How should agents build "question-refresh"?  → lands on main (change)
Recommended: Thorough — schema change, 4 contract rows, 3 apps

○ Rush              fastest · fewest tokens
  Final review and fast gates only; no agent walk — you test it once it lands.
  ⚠ This feature changes the schema: nothing walks it before it lands.
○ Standard          ~50 min · ~2.1M tokens (8 similar features)
  Every task reviewed, agent walks the risky items, full verify.
● Thorough          ~80 min · ~3.4M tokens (8 similar features)
  The full pipeline: every task reviewed, full agent walk, deep verify with cross-app E2E.
○ Thorough + you    ~80 min + your walk
  As Thorough, then it waits for you to walk it before it lands.
○ Customize…        Set each lever yourself
```

AskUserQuestion takes at most four options, so **Thorough + you** is offered as a second question
("Walk it yourself before it lands?") whenever Thorough is picked, and Customize is the tool's
*Other*. Picking Rush on a feature with a Thorough signal shows the ⚠ line in Rush's own
description. It warns and never refuses (A4).

**The recommendation** (`profile.mjs --recommend <folder>`, from SPEC, PLAN and the config):

- **Thorough** when any of these hold: a §Schema & API changes row or a migration task; a §Contract
  row with a `released_artifact` consumer; three or more apps; an auth/permission or delete path in
  §Contract.
- **Rush** when all of these hold: one app, no §Contract rows, no schema change, five or fewer tasks.
- **Standard** otherwise. `build_profile_default:` replaces Standard as the fallback. A Thorough
  signal still wins, and the headline names the signal.

### 4. Estimates and history (D6, D12)

Today's `appendArchive` already writes `timing` and `lanes` (per-lane ms) for each landing. Added:

- `size: { tasks, phases, apps }` from PLAN.md
- `profile:` the resolved preset, or `custom`
- `tokens: { input, output, cacheRead }` and `costUsd`, summed from each run's final `stream-json`
  `result` event (`fleet.mjs:605` already parses it for `duration_ms` and `num_turns`)

`profile.mjs --estimate <folder>` takes the archived landings with the same profile, works out
minutes and tokens per task, and multiplies by this plan's task count, giving the median plus the
number of features it is based on. **Fewer than 3 comparable landings** → that option shows its
place in the ladder (`fastest · fewest tokens`, `faster`, `full pipeline`) and no number.
`--status --archived` gains a profile column and the time and tokens per landing.

### 5. Thorough + you

The feature goes through Thorough's agent walk. Then, instead of the agent sign-off, the walk lane
parks it with `blocked: "waiting for your walk — next: /builder:resume --path <folder>"`. That is a
human-step park, so `auto_unpark` never touches it (`fleet.mjs:1058`). `/builder:resume` on it
starts that worktree's walk env (`agent_walk.env`/`start`, as the walk lane does), prints `walk.md`,
and stops for your `/builder:signoff`. Signing off re-queues the feature, and the fleet verifies and
lands it.

### 6. Revise on a running feature (D11)

- `/builder:revise --path <folder>` reads `.builder/fleet/fleet.json`. When the feature is
  `building`, `walking` or `queued` in a live fleet, it writes `.builder/fleet/requests/<feature>.pause`.
- Build checks for a pause request after each task's review, and the agent walk between rounds. On
  one, it parks with `blocked: "revising — next: /builder:revise"` and exits cleanly. The ledger
  keeps every finished task.
- Revise waits for the park (polling `--status`, at most the length of one task). It then applies
  the change **in the feature's worktree** and commits it there, deletes the request, and re-queues
  with `fleet.mjs <feature> --detach`. Re-queuing unparks it (`fleet.mjs:546`).
- A feature that is only queued, with no worktree yet, is revised in place on the branch its spec is
  committed on, with no pause.

### 7. Config

- `build_profile_default: rush | standard | thorough` is an optional frontmatter key in
  `.claude/builder.md`. `loadConfig` exposes it, and `PROJECT.template.md` documents it as commented
  out.
- `/builder:init --update` offers to add `agent_walk` to a project that has none.

### 8. Finding: the spec has to reach the worktree

`preflight` (`fleet.mjs:163`) checks that the feature folder is committed on **HEAD**, but
`ensureWorktree` (`fleet.mjs:266`) cuts the branch from the **target**. Today you start fleets on
purpose, so the two rarely differ. Once every go-ahead launches the fleet, a plan committed on a
working branch other than the target is the normal case, and the worktree would be cut without the
spec or plan. **Fix:** when the feature folder isn't on the target, `ensureWorktree` brings it in
with `git checkout HEAD -- <folder>` and commits it on the new branch
(`docs(<feature>): spec and plan from <branch>`).

### 9. Status

`/builder:status` and the fleet table show the profile next to each feature (`Thorough`, `Rush`,
`custom`). The statusline is unchanged.

## Out of scope

- Profiles for hand-built features, meaning projects with no `agent_walk` block.
- xs/sm in-chat builds (D10).
- More than one target per fleet run.
- Profiles for `/builder:fleet` batches launched by hand. Each feature uses its own `profile:`, or
  Thorough if it has none.

## Testing

- `scripts/test/profile.test.mjs`: preset → levers, with floors that hold under any custom value;
  `--recommend` against fixture specs (schema change, released consumer, three apps, a small
  single-app one, a `build_profile_default` override); `--estimate` with 0, 2 and 5 archived
  landings.
- `fleet-core` tests: `appendArchive` writes size, profile, tokens and cost; token sums from a
  recorded `stream-json` result event.
- The fleet test harness: a feature whose folder is committed only on a non-target branch gets its
  spec in the worktree (§8); a pause request parks at a task boundary and re-queues (§6); a Thorough
  + you feature parks as a human step after the agent walk (§5).
- Skill text is checked with `claude plugin validate .`. One end-to-end run in d2m on a small spec
  covers Rush and Standard, and the archive rows are checked for the new fields.

## Release

**4.9.0**, a minor: new behaviour at the go-ahead and a new optional config key. A consumer doesn't
have to change anything. Projects without `agent_walk` build exactly as before, and features with a
go-ahead but no `profile:` run as Thorough, which is today's pipeline.
