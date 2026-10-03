# Agents build every feature — implementation plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans,
> task by task. Steps use `- [ ]` checkboxes.

**Goal:** In a project with `agent_walk`, the go-ahead launches the fleet for the feature with a
build profile chosen in one question, and the work lands on a target recorded at the go-ahead.
Projects without `agent_walk` build by hand exactly as today.

**Architecture:** One new pure module, `profile.mjs`, owns the presets, their levers, the floors,
the recommendation and the estimate. The skills and the fleet ask it and never interpret a preset
name themselves. The fleet gains four small behaviours:
- it brings a spec committed off the target into the worktree;
- it applies per-feature persistence;
- it parks on a pause request;
- it treats "waiting for your walk" as a human step.

The archive records size, profile and tokens. Everything else is skill text.

**Spec:** `docs/specs/2026-10-03-agent-builds-design.md`

## Global Constraints

- Release **4.9.0** (a minor). Old configs, manifests and `archive.jsonl` rows read unchanged.
- **A manifest with a go-ahead but no `profile:` resolves to `thorough`**, which is today's pipeline.
  So does an unknown value: an unknown value warns once on stderr and never throws.
- **The floors hold under every profile, including `custom`:** `fastGates: true`,
  `finalReview: true`, `releasedParity: true`. No lever value turns them off.
- Presets: `rush`, `standard`, `thorough`, `thorough-you`, plus `custom`, written as `custom k=v …`.
  Lever keys:
  - `testing`: `none` | `risky` | `full` | `full+human`
  - `review`: `final` | `per-task` | `per-task+second`
  - `models`: `economy` | `default` | `strong`
  - `verify`: `floors` | `full` | `everything`
  - `persist`: `low` | `default`
  - `unruled`: `recommend` | `park`
  - `landing`: `local` | `pr-ci`
- Never push. The fleet's one-target-per-run rule (4.8) stands.
- Commits are `<area>(<scope>): <subject>`, lower case, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `node --test scripts/test/<file>.test.mjs`. Known timing flakes are fleet "keeps talking"
  and job "wait gives up": re-run them alone before calling them red.

## Review Focus

1. **A plan committed on a working branch that isn't the target.** The worktree must get the spec
   and plan, and must never be cut without them (Task 4).
2. **A manifest with no `profile:`, or a misspelled one** (`profile: thorogh`). It runs as Thorough
   with one warning, never crashes the fleet or the status line (Tasks 1, 7).
3. **`custom` with a lever that would drop a floor** (`custom verify=none`). The value is rejected
   and the floors stay on (Task 1).
4. **A pause request for a feature that isn't in the fleet, or has already landed.** It's a no-op
   with a note, not a park of something else (Task 6).
5. **`--estimate` with history in the old archive shape** (d2m's rows have no `timing`, `size` or
   `profile`). Those rows are ignored, and with fewer than 3 usable rows it returns `null`, never `NaN`
   minutes (Task 1).

## File Structure

| File | Responsibility |
|---|---|
| `scripts/profile.mjs` (new) | presets → levers, floors, `parseProfile`, `recommend`, `estimate`; a small CLI |
| `scripts/config.mjs` | `buildProfileDefault` |
| `scripts/fleet-core.mjs` | `tokensOf(resultEvent)`, archive row fields, `renderArchived` columns, `renderStatus` profile |
| `scripts/fleet.mjs` | spec into the worktree, per-feature persistence, pause requests, the human-walk park, size/profile/tokens to the archive |
| `scripts/list-features.mjs` | `profile` on each row |
| `skills/{plan,resume,build,agent-walk,verify,revise,status,init,help}/…`, `PROJECT.template.md`, `README.md` | the go-ahead question, the routing, and each lever applied where the work happens |

## Tasks

### Task 1: `profile.mjs` — presets, floors, recommendation, estimate

**Files:** Create `scripts/profile.mjs`. Test: `scripts/test/profile.test.mjs`.

**Produces (exact):**
```js
export const PRESETS = {
  rush:           { testing: 'none',       review: 'final',           models: 'economy', verify: 'floors',     persist: 'low',     unruled: 'recommend', landing: 'local' },
  standard:       { testing: 'risky',      review: 'per-task',        models: 'default', verify: 'full',       persist: 'default', unruled: 'recommend', landing: 'local' },
  thorough:       { testing: 'full',       review: 'per-task+second', models: 'strong',  verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
  'thorough-you': { testing: 'full+human', review: 'per-task+second', models: 'strong',  verify: 'everything', persist: 'default', unruled: 'recommend', landing: 'local' },
}
export const LEVERS = { testing: ['none','risky','full','full+human'], review: ['final','per-task','per-task+second'], models: ['economy','default','strong'], verify: ['floors','full','everything'], persist: ['low','default'], unruled: ['recommend','park'], landing: ['local','pr-ci'] }
export const FLOORS = { fastGates: true, finalReview: true, releasedParity: true }
/** 'standard' | 'custom testing=risky review=final' | undefined → { preset, levers, floors, warning|null } */
export function parseProfile(value)
/** → { preset: 'rush'|'standard'|'thorough', signals: string[] }  (signals name why, e.g. 'schema change', '3 apps') */
export function recommend({ specText, planText, cfg })
/** rows: archive.jsonl rows → { minutes, tokens, n } | null when fewer than 3 usable rows */
export function estimate(rows, preset, tasks)
export function planSize(planText)   // → { tasks, phases, apps }
```
CLI: `node scripts/profile.mjs --levers <folder>` → JSON of `parseProfile(manifest.profile)`;
`--recommend <folder>`; `--estimate <folder> --profile <p>` (reads `.builder/fleet/archive.jsonl`).

**Rules for `recommend`:**
- **Thorough** when any of these hold:
  - §Schema & API changes has a data row;
  - PLAN.md has a task whose title or Files mention `migration`;
  - a §Contract row names a consumer in `cfg.released`;
  - three or more ✅ rows in §Apps;
  - a §Contract row whose Auth cell isn't `—`/`none`, or whose cells mention `delete`/`DELETE`.
- **Rush** when there is exactly one ✅ app, no §Contract data rows, no schema rows and
  `planSize.tasks <= 5`.
- **Otherwise** `cfg.buildProfileDefault ?? 'standard'`.

A table's data rows are the `|` lines after the `|---` separator, up to the next `## `.

- [ ] **Step 1: Write the failing tests** (`profile.test.mjs`), one `test()` each:
  - `parseProfile(undefined)` and `parseProfile('none')` give `preset: 'thorough'` and
    `warning: null`.
  - `parseProfile('thorogh')` gives `preset: 'thorough'`, and its `warning` matches `/unknown profile/`.
  - `parseProfile('custom testing=risky review=final')` keeps the other levers at the `standard`
    values.
  - `parseProfile('custom verify=none')` gives the `standard` verify value, a `warning` naming
    `verify=none`, and `floors` deep-equal to `FLOORS`.
  - Every preset's `floors` deep-equals `FLOORS`.
  - `recommend` on fixtures built in the test with template strings:
    - a §Schema row → `thorough`, with signals including `'schema change'`;
    - a contract row consuming a released app (`cfg.released = ['mobile']`) → `thorough`;
    - three ✅ apps → `thorough`;
    - one ✅ app, no contract, four tasks → `rush`;
    - one app, one contract row, eight tasks → `standard`;
    - the same with `buildProfileDefault: 'thorough'` → `thorough`.
  - `estimate`:
    - `[]` → `null`;
    - two `standard` rows → `null`;
    - three `standard` rows → `{ n: 3, … }`. The rows are
      `{ profile: 'standard', size: { tasks: 10 }, lanes: { build: 600000, walk: 300000 }, tokens: { input: 1000000, output: 100000 } }`
      with tasks 10, 10 and 20. Minutes are the median of per-task minutes times the task count:
      with `tasks = 10` that's 15.
    - Rows without `size` or `profile` (d2m's shape) → ignored.
- [ ] **Step 2: Run them.** `node --test scripts/test/profile.test.mjs` should FAIL with "Cannot find
  module".
- [ ] **Step 3: Implement `scripts/profile.mjs`** to the rules above. The section reader is
  `section(text, name)`, which slices from `^## <name>$` to the next `^## `. `tokens` in `estimate`
  is the median of `input + output` per task, times `tasks`.
- [ ] **Step 4: Run them.** They should PASS.
- [ ] **Step 5: Commit.** `feat(profile): presets, floors, recommendation and estimate`

### Task 2: `build_profile_default` in the config

**Files:** Modify `scripts/config.mjs` (the return object near line 149), `PROJECT.template.md` (the
frontmatter, beside `merge_into`). Test: `scripts/test/config.test.mjs`.

**Produces:** `cfg.buildProfileDefault: 'rush' | 'standard' | 'thorough' | null`. Any other value
is `null`, with a note on `cfg.warnings` (or stderr if the config has no warnings list; follow the
file's existing pattern for an invalid optional key).

- [ ] **Step 1: Failing tests.**
  - No key → `null`.
  - `build_profile_default: rush` → `'rush'`.
  - `build_profile_default: fast` → `null`, without throwing.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Implement.** `buildProfileDefault: ['rush','standard','thorough'].includes(fm.build_profile_default) ? fm.build_profile_default : null`.
  Add to the template, commented out:
  `# build_profile_default: standard   # the build profile pre-selected at the go-ahead when the spec doesn't call for Thorough`
- [ ] **Step 4: Run them.** They should PASS.
- [ ] **Step 5: Commit.** `feat(config): build_profile_default`

### Task 3: the archive records size, profile and tokens

**Files:**
- Modify `scripts/fleet-core.mjs`: add `tokensOf`, and add profile/time/tokens to `renderArchived`.
- Modify `scripts/fleet.mjs`:
  - the timing push at line 591;
  - `appendArchive` call at line 690.
- Modify `scripts/test/fixtures/stub-claude.mjs`: the result event at line 77 gains
  `usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 }, total_cost_usd: 0.05`.

Tests: `fleet-core.test.mjs`, `fleet.test.mjs`.

**Produces:**
- `tokensOf(ev) → { input, output, cacheRead, costUsd }`, zeros when `ev?.usage` is missing.
- Each `timing` entry gains `tokens` (that object).
- The archive row gains:
  - `size: planSize(PLAN.md)`, or `null` if there's no plan;
  - `profile: parseProfile(mf.profile).preset`;
  - `tokens: { input, output, cacheRead }`, summed over timing;
  - `costUsd`, summed.

Read `PLAN.md` and the manifest from the worktree *before* the landing removes it. Capture them at
the top of `landNow`.

- [ ] **Step 1: Failing tests.**
  - `tokensOf({ usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 }, total_cost_usd: 0.1 })`
    → `{ input: 5, output: 2, cacheRead: 1, costUsd: 0.1 }`.
  - `tokensOf(null)` → all zeros.
  - In `fleet.test.mjs`, the happy-path spec→merged test's archived row has:
    - `profile: 'thorough'` (the fixture manifest has no `profile:`);
    - `tokens.input` equal to `1000 ×` the number of runs;
    - `costUsd > 0`;
    - `size` of `null` (the fixture has no `PLAN.md`).

    A second test commits a `PLAN.md` with `## Phases` and two `### Task N` headings, then asserts
    `size.tasks === 2`.
  - `renderArchived` has a `Profile` column and a `Time` column using `duration(sum(lanes))`.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Implement** as above. `renderArchived`'s header becomes
  `| Feature | Profile | Time | Tokens | Merged | PR | Landed |`. Tokens are formatted like `2.1M` or
  `340k`, or `—` when absent.
- [ ] **Step 4: Run** both files. They should PASS.
- [ ] **Step 5: Commit.** `feat(fleet): archive size, profile and tokens per landing`

### Task 4: the spec reaches the worktree from any branch

**Files:** Modify `scripts/fleet.mjs` (`ensureWorktree`, around line 258, after the
`git worktree add`). Test: `fleet.test.mjs`.

**Behaviour:**
1. After creating a **new** branch from `TARGET`, check
   `git cat-file -e refs/heads/${TARGET}:${spec}/MANIFEST.md`.
2. If that fails, run `git checkout <HEAD sha of ROOT> -- <spec>` inside `wt`, then
   `git commit -qm "docs(<feature>): spec and plan from <current branch or HEAD sha>"`.
3. `preflight` keeps its "committed on HEAD" check.

An existing branch is left alone: it already carries what it was built from.

- [ ] **Step 1: Failing test.**
  - `makeRepo([])` on `main`.
  - `git checkout -b work`, add `docs/features/a/MANIFEST.md` (`state: planned`, `go-ahead: t 2026-10-03`),
    commit, and run the fleet with `['a']` and the happy scenario.
  - Assert the feature landed on `main`, and that `git log main --oneline` contains
    `spec and plan from work`.
- [ ] **Step 2: Run it.** It should FAIL: the worktree has no manifest, so the feature parks or fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `fleet.test.mjs`. It should PASS, along with the existing tests.
- [ ] **Step 5: Commit.** `fix(fleet): a spec committed off the target is brought into the worktree`

### Task 5: per-feature persistence and the human-walk park

**Files:** Modify `scripts/fleet.mjs`:
- `autoUnpark`, around line 1134;
- `HUMAN_STEP` at line 1059;
- the walk-rounds hint passed in the run prompt.

Test: `fleet.test.mjs`.

**Behaviour:**
- **Automatic-retry budget.** For a feature whose levers have `persist: 'low'`, the budget is `0`.
  Otherwise it's `AW.autoUnpark`. Read the levers with `parseProfile(readManifest(f.worktree ?? ROOT, feature)?.profile)`.
- **`HUMAN_STEP`** gains `|waiting for your walk`, so a Thorough + you park is never retried
  automatically.

- [ ] **Step 1: Failing tests.**
  - **Low persistence:** with `auto_unpark: 2` in `lines`, a feature whose manifest has
    `profile: rush` and scenario `['BLOCK:stuck']` parks after one run with no automatic retry.
    `calls` holds no `unpark` entry for it.
  - **Human walk:** a `profile: thorough-you` feature with scenario `[…HAPPY up to 'built', 'BLOCK:waiting for your walk — next: /builder:resume --path docs/features/a']`
    and `auto_unpark: 2` stays parked with that reason after the run.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** They should PASS.
- [ ] **Step 5: Commit.** `feat(fleet): per-feature persistence; your walk is a human step`

### Task 6: pause requests for `/builder:revise`

**Files:** Modify `scripts/fleet.mjs`:
- the `--pause <feature>` flag, added to `KNOWN_FLAGS` and `USAGE`;
- the check before each run;
- enqueue deletes the request.

Test: `fleet.test.mjs`.

**Behaviour:**
- **`fleet.mjs --pause <feature>`.**
  - If the feature is a row in `fleet.json` with a status other than `done`, write
    `.builder/fleet/requests/<feature>.pause`, print `pause requested: <feature>`, and exit 0.
  - Otherwise print `<feature> isn't in this fleet — nothing to pause` and exit 0.
- **Before `runClaude` for a feature** (both the pool and the walk lane): if its request file
  exists, `park(f, 'revising — next: /builder:revise --path <folder>')`, and don't start the run.
  `HUMAN_STEP` gains `|^revising` so the park is never retried automatically.
- **Naming the feature again** (enqueue, around line 1301) deletes its request file before
  re-queuing.

- [ ] **Step 1: Failing tests.**
  - **Mid-build pause:** start a fleet on `['a']` with scenario `['audited', 'SLOW:planned', 'building']`
    in the background (as the walk-lane test does). After the first `calls` entry appears, run
    `--pause a`. When the fleet exits, `a` is parked with a reason starting `revising`, and runs
    stopped before `building`.
  - **Unknown feature:** `--pause zzz` exits 0, prints `nothing to pause`, and creates no file.
  - **Re-queue:** running the fleet on `['a']` again deletes the request, and the feature continues
    to merged.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** They should PASS.
- [ ] **Step 5: Commit.** `feat(fleet): --pause parks a feature at its next run for a revision`

### Task 7: the profile in status

**Files:**
- Modify `scripts/list-features.mjs`: the row from `inspect` gains `profile`.
- Modify `scripts/fleet-core.mjs`: `renderStatus` gains a Profile column.

Tests: `list-features.test.mjs`, `fleet-core.test.mjs`.

**Behaviour:**
- `profile` is `mf.profile` resolved with `parseProfile(...).preset` when the manifest has
  `go-ahead:` set, and `null` before a go-ahead.
- `renderStatus` shows `rush`, `standard`, `thorough`, `thorough + you` or `custom`.
- A misspelled value shows `thorough` and doesn't throw.

- [ ] **Step 1: Failing tests.**
  - A manifest with `go-ahead: x` and `profile: rush` → `rush`.
  - With a go-ahead and no profile → `thorough`.
  - No go-ahead → `null`.
  - `renderStatus` output contains `| Profile |`.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** They should PASS.
- [ ] **Step 5: Commit.** `feat(status): show each feature's build profile`

### Task 8: the go-ahead question and routing (skill text)

**Files:**
- `skills/plan/SKILL.md`: §"Then take the go-ahead", around line 173, and the footer.
- `skills/resume/SKILL.md`: the routing table around line 90, and §The go-ahead around line 150.
- `skills/agent/SKILL.md`: a feature's `target:` names its `--into`.

Test: `skills-consistency.test.mjs`.

**Text to land:**
- **Plan, after `ExitPlanMode` approves.** If `cfg.agentWalk` is unset, the go-ahead and footer stay
  as today, minus option 2, plus the line `Agents build features once agent_walk is set up —
  /builder:init --update adds it.` Otherwise:
  1. Run `profile.mjs --recommend <folder>` and `--estimate` for each preset.
  2. Ask **one AskUserQuestion**: Rush / Standard / Thorough, the recommendation first and marked,
     the headline naming its signals, and the target in the question as `→ lands on <target>`.
     Each description is what the preset skips. It shows `~N min · ~T tokens (n similar features)`
     when there's an estimate, and the ladder words otherwise. When the recommendation is Thorough,
     Rush's description carries the ⚠ line naming the signal.
  3. **Picked Thorough** → a second question: "Walk it yourself before it lands?" (No (Recommended)
     / Yes → `thorough-you`).
  4. **Other** (Customize) → two AskUserQuestion calls over the seven levers, pre-filled from the
     recommendation, writing `profile: custom k=v …`.
  5. **Target changed** → `target: <branch>`; otherwise `target: <cfg.mergeInto>`.
  6. Write `go-ahead:`, `profile:` and `target:`, commit
     `chore(<feature>): <feature> — go-ahead (<profile>)`, then run
     `node <builder>/scripts/fleet.mjs <feature> --detach --into <target>`.
  7. **A running fleet with a different target** refuses. Relay its message and offer to switch this
     feature's target to the running one, or launch it once that fleet ends.
  8. End with the fleet's launch line and `/builder:status`.
- **Resume.** In a project with `agent_walk`, `state: planned` with a go-ahead, or
  `state: building`, routes to `/builder:agent --path <folder>`. Without `agent_walk` the routing is
  as today. Under `--agent-walk` nothing changes.

- [ ] **Step 1: Failing tests** in `skills-consistency.test.mjs`:
  - plan names `profile.mjs --recommend`, `fleet.mjs` with `--detach --into`, `Walk it yourself
    before it lands`, and `/builder:init --update`;
  - resume routes `planned` with a go-ahead to `/builder:agent` when `agent_walk` is set;
  - plan no longer offers `2. agent` in a project with `agent_walk`.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Edit the three skills.**
- [ ] **Step 4: Run them.** They should PASS. Also run `claude plugin validate .`.
- [ ] **Step 5: Commit.** `feat(plan): the go-ahead picks a build profile and launches the fleet`

### Task 9: each lever applied where the work happens (skill text)

**Files:**
- `skills/build/SKILL.md` and `skills/build/EXECUTION.md` (§Model selection)
- `skills/agent-walk/SKILL.md`
- `skills/verify/SKILL.md`
- `skills/revise/SKILL.md`
- `skills/init/SKILL.md`, `skills/status/SKILL.md`, `skills/help/SKILL.md`, `README.md`

Test: `skills-consistency.test.mjs`.

**Text to land.** Every lever-reading skill opens with: "Read the levers:
`node <builder>/scripts/profile.mjs --levers <folder>`. The floors in its `floors` hold whatever
the levers say."
- **Build.**
  - **`review`:**
    - `final` → no per-task reviewer; the final whole-branch review always runs.
    - `per-task+second` → a second reviewer, on the most capable model, on any task touching
      §Contract or §Schema.
  - **`models`:** EXECUTION.md §Model selection gains two lines:
    - `economy` → integration tasks drop to the cheapest tier that can do them;
    - `strong` → integration tasks and every review run on the most capable model.
  - **`unruled: park`** → a choice the spec doesn't settle parks the feature instead of taking the
    recommendation.
  - **Under `--agent-walk`**, after each task's review: if `.builder/fleet/requests/<feature>.pause`
    exists, park with `revising — next: /builder:revise --path <folder>` and stop.
  - **Writing `walk.md`:** tag `[risk]` on every item touching a §Contract row, an auth or permission
    path, a load/save/delete path, a notification payload or a deep-link target (verify's re-walk
    table).
- **Agent-walk.**
  - **`testing: none`** → no walk. Write the AGENT sign-off as
    `🤖 AGENT SIGNED OFF — no walk (profile: rush) — not human-tested`.
  - **`risky`** → walk only the `[risk]` items and the cross-app section.
  - **`full`** → today's walk.
  - **`full+human`** → today's walk. On AGENT-PASS, instead of the sign-off, park with
    `waiting for your walk — next: /builder:resume --path <folder>`.
  - **`persist: low`** → park after 1 failed round, not 5.
- **Resume.** A feature parked `waiting for your walk`:
  1. Start the worktree's walk env with `agent_walk.env`/`start`.
  2. Print `walk.md`.
  3. Stop for `/builder:signoff --path <folder>`.
  4. After sign-off, run `fleet.mjs <feature> --detach --into <target>`.
- **Verify.**
  - **`verify: floors`** → each app's fast set, plus consumer parity when `cfg.released` is
    affected. No deep set, no E2E, no pattern sweep.
  - **`full`** → today's pass, with cross-app E2E only on the legs the re-walk table names.
  - **`everything`** → today's first verify.
  - **`landing: pr-ci`** → ship opens the PR, and the fleet's land waits for green CI. Use the
    existing ship PR path. If CI isn't configured, note it and merge locally.
- **Revise.** When `.builder/fleet/fleet.json` has the feature in a live fleet with a status other
  than `done`:
  1. Run `fleet.mjs --pause <feature>`.
  2. Wait for its park, polling `fleet.mjs --status` every 30 s, for at most 20 min.
  3. Apply the change in the row's `worktree`, and commit it there.
  4. Run `fleet.mjs <feature> --detach --into <target>`.

  A queued feature with no worktree is revised in place.
- **Init.** `--update` offers `agent_walk` to a config without one, and documents
  `build_profile_default`.
- **Status.** Show the Profile column.
- **Help and README.** The go-ahead's profile question, the four presets, and the floors.

- [ ] **Step 1: Failing tests:**
  - build names `profile.mjs --levers` and `requests/<feature>.pause`;
  - agent-walk names all four testing values and `waiting for your walk`;
  - verify names `verify: floors` and the parity floor;
  - revise names `fleet.mjs --pause`;
  - init names `build_profile_default`;
  - no skill says `/builder:build` is how a user builds when `agent_walk` is set.
- [ ] **Step 2: Run them.** They should FAIL.
- [ ] **Step 3: Edit the skills.**
- [ ] **Step 4: Run them.** They should PASS. Also run `claude plugin validate .`.
- [ ] **Step 5: Commit.** `feat(skills): build, walk, verify and revise read the build profile`

### Task 10: release notes and version

**Files:** `CHANGELOG.md` (`## 4.9.0`), `.claude-plugin/plugin.json` (`4.9.0`).

- [ ] **Step 1:** Write the changelog entry:
  - **New:** the profile question at the go-ahead; agents build every feature where `agent_walk` is
    set; `build_profile_default`; estimates from history; revise pauses a running feature.
  - **Changed:**
    - a spec committed off the target reaches the worktree;
    - the archive records size, profile and tokens;
    - features from before 4.9 run as Thorough;
    - projects without `agent_walk` build by hand as before.
- [ ] **Step 2:** Bump the version.
- [ ] **Step 3:** Run `node --test scripts/test/*.test.mjs` and `claude plugin validate .`. Both
  should be green; re-run the known flakes alone if they fail.
- [ ] **Step 4: Commit.** `chore(release): 4.9.0 — agents build every feature, build profiles`

## Spec coverage

| Spec § | Task |
|---|---|
| §1 the go-ahead launches the fleet, the target, older manifests | 8, 1 (`thorough` default) |
| §2 profiles, levers, floors, risky items, Customize | 1, 9, 8 |
| §3 the question and the recommendation | 1, 8 |
| §4 estimates and history | 1, 3 |
| §5 Thorough + you | 5, 9 |
| §6 revise on a running feature | 6, 9 |
| §7 config | 2, 9 |
| §8 the spec reaches the worktree | 4 |
| §9 status | 7 |
| Release | 10 |
