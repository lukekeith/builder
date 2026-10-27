# Token economy, visible parks, finer progress, archive — plan

Spec: [docs/specs/2026-10-27-token-economy-design.md](../specs/2026-10-27-token-economy-design.md).
Branch `feat/token-economy`. Three lanes, merged into the branch at the end.

## Lane 1 — tokens (this session)

1. **D1 measurement** — `fleet-core.mjs`: `tokensOf` adds `cacheCreation` and `byModel`; a
   `streamMeter()` accumulator (orchestrator + per-dispatch turns/start/peak/sum, dispatch kinds from
   the description); `archiveSummary(timing)` → `byKind`, `orchestrator`, `costByModel`. `fleet.mjs`:
   feed every stream line to the meter, store it on the timing entry; archive row gains the summary
   and `quality` (read from the workspace in `noteFacts` before the ship run removes it).
   `renderArchived` shows cost and cost per task. Tests in `fleet-core.test.mjs`.
2. **D5 briefs** — `dispatch.mjs composeBrief` drops the constraints and craft blocks (the prompt
   carries them); `prompts/implementer.md`: Read tool for the brief, two craft skills up front.
   build SKILL §Composing the brief updated. Tests in `dispatch.test.mjs`.
3. **D2–D4 agents** — `agents/{implementer,implementer-skills,reviewer}.md`; `dispatch.mjs` resolves
   recipes to paths (project `.claude/skills/<name>/SKILL.md`) and prints `subagent_type`;
   `config.mjs` reads `agent_types:`; `vendor.mjs` copies `agents/`; template + init docs.
4. **D6–D7 fresh orchestrator** — `AGENT-MODE.md` ends the build-lane run after audit and after the
   go-ahead; `RUN_CAP` 14; `plan-slices.mjs --brief` and `--scan`; EXECUTION.md §Setup 5–6 and build
   SKILL read them instead of PLAN.md.
5. **D8 plan writers** — `plan_writers: per-phase` in config + plan SKILL; audit SKILL writes
   `<WS>/audit-digest.md`.

## Lane 2 — parks and progress (agent, worktree)

D9, D10: `statusline.mjs`, `fleet-core.mjs` (progress, `decide` reasons, stall facts),
`fleet.mjs` (route → fleet.out block, `lastProgress`), the session brief hook, fleet SKILL footer.

## Lane 3 — status and archive (agent, worktree)

D11, D12, D13: `list-features.mjs`, `registry.mjs`, `brainstorm-file.mjs`, `tidy.mjs`,
`condense.mjs` (CLOSED / DROPPED headers), `program.mjs`, new `skills/archive/` + `docs.mjs` step,
status/tidy skill footers, log pruning.

## Finish

Merge lanes 2–3, CHANGELOG 5.4.0, README, version, `preview.mjs --check`, the full test suite,
`claude plugin validate .`, a review of the whole branch. Tag and push stay the human's call.
