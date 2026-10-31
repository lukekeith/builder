# Fleet token cuts — a lean build lane and script-side bookkeeping — design

**Status:** draft for the owner's review · **Date:** 2026-10-31 · **Branch:** `feat/verifier` (ships in 6.0.0)

## Why

The 6.0 benchmark (suites `2026-10-30-1326` and `-1821`, four landed real cases with full transcripts)
found that a fleet build session's own orchestrator thread carries 50–72% of each case's tokens. The
dispatched agents are cheap; the orchestrator is not, because every turn re-reads its whole context.

Two causes account for most of it:

1. **Builder's instructions are carried on every turn.** The build lane starts on `/builder:resume`
   (`scripts/fleet.mjs:727`), which loads the resume skill (~14.6k tokens), then `docs.mjs resume-agent`
   with AGENT-MODE, then hops to `/builder:build` (~12.6k), which loads the `docs.mjs build` bundle
   (51–67 KB — over the Bash output cap, so it goes to `/tmp` and is read back). The config is printed
   2–3 times. 56–77k tokens of builder text sit in context from the first turns to the last:
   **34–49% of every build session's tokens.** Much of it is not used by a fleet build — the resume
   picker and state detection, the human go-ahead, §SPEC.md and §MANIFEST.md authoring formats, §Walk
   readiness and §When the last phase signs (needed once, at the end).
2. **Per-task bookkeeping is done by the LLM.** Each task costs 2–4 orchestrator turns: write the
   ledger line, file the commit-tier verify request, read the verdict, render the next brief with
   `dispatch.mjs`, copy the printed Agent call, and — for a task review — a whole turn just to render a
   file whose path is known. **27–33% of the build session's tokens.** One run wrote its own
   `/tmp` script to batch the steps.

Measured: b03's build session used 19.0M tokens over 126 turns; a19's 15.1M over 110. The analysis
estimates these two changes together take a build session to roughly 6–7M — about a third — with no
change to what the session does.

**Success:** re-running the same four cases (a19, b03, d03, a26) on the same seeds and profiles, the
build orchestrator's summed context falls by at least 40% per case, its turn count by at least 30%, and
nothing gets worse: every case that landed still lands, fix rounds and final-review findings are no
higher, and the verifier tiers run as before.

## Decisions

- **D1. The build lane starts on `/builder:build`, with a fleet bundle.** `fleet.mjs` starts a build-lane
  session on `/builder:build --path <folder> --agent-walk` (not `/builder:resume`); walk and closing
  lanes keep their current entry. `/builder:build`, when it runs under the fleet (`BUILDER_FLEET_DIR`
  set), reads a new **`docs.mjs fleet-build`** bundle instead of `docs.mjs build`: EXECUTION's task
  loop, the agent-mode rules a build needs, §The verifier, §PLAN.md and the config printed once —
  **at most 30,000 characters**, so it fits one Bash output with no `/tmp` detour. The sections a build
  needs only at one step are fetched at that step, by name: §When the last phase signs at the last
  phase close; §Walk readiness only if the build itself changes it; §SPEC.md and §MANIFEST.md never
  (a fleet build does not author either — it reads the plan, and writes the manifest through
  `advance.mjs`). A human `/builder:build` (no `BUILDER_FLEET_DIR`) is unchanged.
- **D2. `dispatch.mjs` does the bookkeeping in the call that starts the next task.** One call —
  `dispatch.mjs next <folder> --close <N> "<ledger line>"` — writes task N's ledger line, files task N's
  commit-tier verify request, renders task N+1's implementer brief (or task N's review brief when the
  plan's test plan reviews tasks), and prints the one Agent call to make. The review brief's path is
  deterministic, so rendering it is never its own turn. Steps the orchestrator still decides — whether a
  review's findings need a fix round, whether a verdict is red — stay with it; only the steps that are
  pure transcription move to the script. Target: one orchestrator turn plus one Agent turn per task.
- **D3. What does not change.** The task loop, the reviews, the fix-round rules, the verifier tiers, the
  ledger's format and the plan format are untouched; so is everything a human session sees. These are
  changes to how the fleet's build session is fed and to which steps a script takes, not to what the
  build does.

## What changes in builder

| File | Change |
|---|---|
| `scripts/fleet.mjs` | build-lane prompt → `/builder:build --path … --agent-walk` (`runClaude`, ~:727) |
| `scripts/docs.mjs` | new `fleet-build` bundle (≤30k chars, config once); named-section fetch for the step-only sections |
| `skills/build/SKILL.md` | under the fleet: read `docs.mjs fleet-build`; fetch §When the last phase signs at the last close |
| `skills/build/EXECUTION.md` | §Dispatch and §Complete the task use `dispatch.mjs next`; the separate render, ledger and verify-request turns go |
| `scripts/dispatch.mjs` | `next` verb: ledger line + commit-tier request + next brief + the Agent call, in one call |
| `scripts/test/*` | bundle size test (≤30k), `dispatch.mjs next` tests, the fleet prompt test |

## Testing

Unit: the `fleet-build` bundle is ≤30,000 chars and holds the named sections; `dispatch.mjs next`
writes the ledger line, files the request and prints the next brief's Agent call, for an implementer
step and for a review step; a human `/builder:build` still reads `docs.mjs build`. Integration: the
fleet's stub tests run a build lane through `/builder:build`. Measurement: the four-case re-run above,
compared run by run against the `2026-10-30-1821` suite (and a17 from `-1326` where comparable).

## Later (measured, not in this change)

From the same analysis, smaller or larger levers to take after this one is measured:
- Closing sessions fleet-driven: the fleet waits on the merge tier and runs check-obligations, advance
  and ship condense as scripts; an LLM starts only on a red verdict or a finding (2–4M per case).
- A trimmed harness for fleet sessions (`--strict-mcp-config` and a built-in tool allowlist): ~10–15k
  tokens off every turn's floor (8–12%).
- A verifier preflight before the fleet spawns sessions, and one rule for env-broken mid-build.
- Reviewers reply in ≤8 lines and the findings file is saved even when the reviewer did not write it.
- `BUILDER` and the feature folder exported to sessions, ending the per-call path preamble.
- Merge-tier reuse of green results at the same code and target tip.

## Out of scope

Changing what a build checks, reviews or tests to make a number better; human-session flows.
