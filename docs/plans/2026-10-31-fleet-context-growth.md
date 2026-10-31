# Fleet context growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A fleet build session's context stays near where it starts — compact plan outline, one-line script output, short agent replies, bundles that carry only what the step acts on, `BUILDER_DIR`, env facts in briefs, red verdicts that show the failure — and a planned-for feature goes straight to `/builder:plan`.

**Architecture:** Output-shape changes in `plan-slices.mjs`, `dispatch.mjs`, `advance.mjs`, `verify.mjs`, `docs.mjs` and the prompt templates; one routing change in `fleet-core.mjs`; an env var from `fleet.mjs`; skill text follows. Nothing changes what a build dispatches, commits, verifies or merges (D6 adds env facts to briefs).

**Tech Stack:** Node ≥ 20 ESM, `node:test`.

**Spec:** `docs/specs/2026-10-31-fleet-context-growth-design.md` · evidence: the growth analysis (`$CLAUDE_JOB_DIR/tmp/growth-analysis.md` §5 maps each change to file:line).

## Global Constraints

- A human session (no `BUILDER_FLEET_DIR`) reads and does what it does today, except D3's shorter agent replies and D7's red summary, which apply everywhere.
- Every bundle and script print a fleet session reads in one call stays ≤ 30,000 characters.
- No consuming project's name in anything committed.
- Full suite: timing tests in fleet/bench may fail under load (re-run alone); vendor.test fails in this tree only because of git-ignored bench/local.

## Review Focus

1. A plan whose pre-flight ruling needs a task's Files/Interfaces after D1 — the scan says to read it with `task-brief`; the orchestrator must still be able to rule. Task 1.
2. An `audited` feature **with** an OPEN decision or a `blocked:` row — must stay on `/builder:resume`. Task 4.
3. D3's model tier in the one-line Agent call must equal what §Model selection would pick for that dispatch kind and task. Task 2.
4. A config with no §Environment landmines / §Standing traps sections — `fleet-setup` and the brief print nothing for them, never fail. Tasks 3, 6.
5. `BUILDER_DIR` unset (a human session) — skills fall back to resolving `<builder>` as today. Task 5.

---

### Task 1: Compact plan outline (D1)
**Files:** `scripts/plan-slices.mjs` (`planBrief` ~:146–156), `skills/build/EXECUTION.md` (~:73–80) · Test: `scripts/test/plan-slices.test.mjs`
- [ ] Tests: `--brief` on the existing large-plan fixture prints no `## Global constraints` text, exactly one line per task matching `/^\d+ · \S+ · \d+ · .+ · .* · \d+ files$/m`, and is ≤ 30,000 chars; a fixture with 60 tasks stays ≤ 30,000.
- [ ] Implement; EXECUTION's pre-flight paragraph says a ruling that needs a task's Files/Interfaces reads it with `task-brief`.
- [ ] `node --test scripts/test/plan-slices.test.mjs scripts/test/skills-consistency.test.mjs` PASS · commit `feat(plan): plan-slices --brief is one line per task, without Global constraints`.

### Task 2: One line per fact (D3)
**Files:** `scripts/dispatch.mjs` (`emit` ~:794–805; the `REQUIRED —` model strings ~:349,393,440,466,502,538), `scripts/advance.mjs` (~:97), `skills/build/prompts/implementer.md` (~:177–186), `prompts/final-reviewer.md` (~:89–115), `prompts/re-review.md` (~:71–90), `skills/build/SKILL.md` (~:28–29) · Tests: `dispatch.test.mjs`, `advance.test.mjs` (or wherever ledger output is tested), `skills-consistency.test.mjs`
- [ ] Tests: `dispatch.mjs implementer|task-review|… ` prints paths relative to the repo root, no `brief:` line, and exactly one Agent-call line naming `subagent_type` and `model`; the model equals today's tier for that kind (assert per kind against the current mapping); `next` output for a mid-phase close is ≤ 6 lines; `advance.mjs --ledger` prints `ledger: +1 line`.
- [ ] Implement; prompts: implementer reply ≤ 6 lines of ≤ 100 chars (status, commit, one test line, one line per concern), no report path; final reviewer: verdict + one line per finding by severity, no Strengths; re-review: one verdict line per finding + `new breakage: …`. Full reports still go to their files. SKILL: a routine dispatch uses the model the Agent-call line names; §Model selection only for an escalation.
- [ ] Tests PASS; `node preview/preview.mjs --check` — re-stamp what this made stale · commit `feat(dispatch): one line per fact — relative paths, a one-line Agent call with its model, short agent replies`.

### Task 3: Bundles carry only what the step acts on (D4)
**Files:** `scripts/docs.mjs` (`CONFIG` ~:61, `bundle()` ~:87–104, `fleet-build` ~:60), `skills/resume/AGENT-MODE.md` (new `## Agent mode in the build lane` excerpt section), `skills/build/SKILL.md` (~:321–324) · Test: `docs.test.mjs`
- [ ] Tests: `fleet-setup` prints the config's apps list and §House rules / §Environment landmines / §Standing traps when present, and none of `verify:`, `agent_walk:`, §Quality gates, §Walk readiness, §Global constraints; a config without those sections prints only what exists; `fleet-build` under a `review=end` manifest omits EXECUTION §3, under `review=slice` includes it; `fleet-build` carries `## Agent mode in the build lane` and not `## \`--agent-walk\``; every call ≤ 30,000.
- [ ] Implement. The excerpt section holds, verbatim from AGENT-MODE where they exist: never ask; never background work; foreground verify wait; never kill what you did not start; build to done; the never-do list; the end commit; the unpark pointer. `resume-agent` still prints the whole file. Drop the fleet fetch of EXECUTION §The final whole-branch review from SKILL.
- [ ] Tests + skills-consistency + preview PASS · commit `feat(docs): fleet bundles carry only what the build acts on`.

### Task 4: An audited feature goes straight to `/builder:plan` (D2)
**Files:** `scripts/fleet-core.mjs` (`buildLanePrompt` ~:42), `scripts/fleet.mjs` (the manifest/spec read it needs), `scripts/docs.mjs` (`resume-agent` ≤ 30k), `skills/plan/SKILL.md` (under the fleet, read what resume used to print for it) · Tests: `fleet-core.test.mjs`, `docs.test.mjs`
- [ ] Tests: `audited` with no OPEN decision row and no `blocked:` → `/builder:plan --path <f> --auto --agent-walk --into <T> --no-dev-env`; `audited` with an OPEN decision or `blocked:` → `/builder:resume …` unchanged; `resume-agent` ≤ 30,000.
- [ ] Implement; check the plan skill under `--agent-walk` started directly does every step resume used to do before invoking it (record the go-ahead, `agent-walk: on`, end the run at the go-ahead commit) and add what is missing.
- [ ] Tests PASS; `fleet.test.mjs` once (`--test-concurrency=2`) · commit `feat(fleet): an audited feature with nothing open goes straight to /builder:plan`.

### Task 5: `BUILDER_DIR` (D5)
**Files:** `scripts/fleet.mjs` (`envFor` ~:272–283), skill command lines in `skills/build/*`, `skills/plan/SKILL.md`, `skills/resume/AGENT-MODE.md` · Tests: `fleet.test.mjs` (env passed to the stub claude), `skills-consistency.test.mjs`
- [ ] Tests: the stub claude sees `BUILDER_DIR` equal to the builder root; skills-consistency accepts `"$BUILDER_DIR"/scripts/…` and still requires every script path to exist.
- [ ] Implement; skills say once, near the top, that under the fleet `<builder>` is `$BUILDER_DIR`; command lines use `"$BUILDER_DIR"` where the fleet runs them. A human session resolves `<builder>` as today.
- [ ] Tests + preview PASS · commit `feat(fleet): BUILDER_DIR — no path prefix on every command`.

### Task 6: Environment facts in every brief (D6)
**Files:** `scripts/dispatch.mjs` (`composeBrief` ~:241–265), `skills/build/EXECUTION.md` §1 (`--context` guidance) · Test: `dispatch.test.mjs`
- [ ] Tests: the implementer brief carries the config's §Environment landmines verbatim and the ledger's `## env notes` lines; with neither present it carries neither and does not fail.
- [ ] Implement; EXECUTION §1: `--context` carries only the hand-over from the previous task.
- [ ] Tests PASS · commit `feat(dispatch): every brief carries the environment landmines and the ledger's env notes`.

### Task 7: A red verdict shows the failure (D7)
**Files:** `scripts/verify/verify.mjs` (`summarize` ~:47–50) · Test: `verify-client.test.mjs` (or the file testing `summarize`)
- [ ] Tests: a red check whose output starts with an npm banner and later has `✗ test/x.test.mjs > y` and `expected 1, got 2` → the summary shows those lines, not the banner; output with no matching line → its last 6 lines.
- [ ] Implement; tests PASS · commit `fix(verify): a red verdict shows the failing lines, not the first lines`.

### Task 8: Measure (operational — stop for the human)
- [ ] `node scripts/bench-suite.mjs plan b03,d03,a26,a19 --replan --lanes 3` (after the dfwrepro profile's walk database is fixed); show the schedule; Run it / Not now.
- [ ] When done: `bench-suite.mjs history b03 d03 a26 a19`; compare build tokens/turns per task and peak against the `-1237`/`-1418` rows, plan-session peak, and landing/fix rounds/findings.
