# Waste analysis — builder 6.2.0, 2026-11-05

Runs: `2026-11-05-0226-tags` (builder, builder-everything) and `2026-11-05-0300-share` (builder,
builder-everything). Default model, 1 rep. All four landed 100% acceptance.

| Run | Config | Wall | Turns | Cost | Orchestrator · Agents · Tools |
|---|---|---|---|---|---|
| tags | builder | 13m | 95 | $5.84 | 8.7m · 3.9m · 0.3m |
| tags | builder-everything | 19m | 110 | $7.43 | 10.6m · 8.3m · 0.4m |
| share | builder | 1h07m | 150 | $13.24 | 25.3m · 38.4m · 3.3m |
| share | builder-everything | 49m | 210 | $17.76 | 28.2m · 18.0m · 3.1m |

Baselines: tags 5.0 (10-26) 13m / 79 turns / $4.68; share 4.14.0 (10-24) 24m.

## Ranked findings

| # | Finding | Saving | Where | Fix |
|---|---|---|---|---|
| 1 | **Hung test, no working cap.** share/builder Task 1 implementer ran 26.3m of 38.4m agent time: `timeout 120` → "command not found" on macOS (hidden by `| grep`), uncapped re-run hung, implementer has no TaskStop, later commands blocked until the background limit killed it. `timeout` also failed silently ~10× per run elsewhere. | ~24m (share/builder); ~10 turns/run | `skills/build/prompts/implementer.md:82`; `agents/implementer.md:4` | Hand implementers the exact test command with `node --test --test-timeout=… --test-force-exit` (or a node wrapper); drop `timeout` everywhere. |
| 2 | **Walk script turns automated tests into walk items.** walk=full: 12/35 rows UNVERIFIABLE (test results the walker may not run; a "Human verification" note turned into a step) → no-code fix session + round 2. walk=risk: generator found 0 items, orchestrator rewrote walk.md by hand. | ~5.5m, ~$2.9 (everything); ~1m (builder) | `scripts/walk-script.mjs:57,97,98`; `scripts/dispatch.mjs:722`; `skills/agent-walk/SKILL.md:131` | **Conditional rule:** items that name a test or check unreachable state are the verifier's — tag `verified-by:` and pass from the green per-test result at that commit. Walk only what needs the running app. |
| 3 | **PLAN.md transcribes the code.** 76KB / 65KB vs a 21.5KB SPEC; 81k output tokens; briefs 26–35KB each. Plan step 13m vs 3–4m on 4.14. | ~3–5m, ~$1/run | `skills/plan/PLAN-FORMAT.md:233-236` | `plan-slices --check` fails a plan > 2× the SPEC. |
| 4 | **Plan step mutation-tests a throwaway implementation** (/tmp prototype + 16 injected bugs). Not asked for; self-review item read as "run it". | 2–3m/run | `skills/plan/PLAN-FORMAT.md:225` | "Check by reading"; prototype only for `[risk]` behaviour. |
| 5 | **A session per stage** (5f652d6, 10-27): costs ~$1/run on tags (+32k cache write, docs bundle, SPEC re-read per session) but pays on share (plan alone 81k output). | ~$0.6–1.0 on small features | `skills/resume/AGENT-MODE.md:103-111`; `scripts/fleet.mjs:46` | Split only above a size threshold (e.g. >4 tasks or ~120k session input). |
| 6 | **Slice reviews find nothing the final review doesn't** (tags 4, share 10 reviews — zero fix rounds; final review caught the only Important bug in both). Same for walk=full on tags (7/7). | ~4m, ~$0.6–1.2/run | test plan | Skip slice reviews when tasks carry pinned tests, or fold into the final review. |
| 7 | **Fix wave on Minor-only findings** ("Ready? Yes", 5 Minors → fix + re-review + verify). | ~2m | `skills/build/EXECUTION.md:341` | Only Critical/Important trigger a wave; Minors go to the ledger. |
| 8 | **Docs bundles over the 30,000-char Bash cap** (audit 46.9K, brainstorm 48.0K, spec-auto 36.2K — verified) → truncated preview, re-reads, the audit's procedure never read inline (7 piecemeal SPEC edits). | 3–5 turns, ~30–45s/run | `scripts/docs.mjs:45,52,57` | Slim `audit-agent` / `brainstorm-auto` bundles under 30K. |
| 9 | **Audit leaves decisions OPEN under `--auto`** → next session re-decides them. | ~38s, 6 turns | `skills/audit/SKILL.md:176,189-191` vs `:251-254` | Write `auto (recommended)` rulings in the audit's one SPEC edit. |
| 10 | **Phase tier re-runs the commit tier at the same commit**; docs-only commits trigger tiers. | ~35–50s/run | `scripts/verify/` | Reuse a green verdict for the same commit; skip tiers on docs-only diffs. |
| 11 | **Orchestrator reads builder's own source** for rules the docs don't state (schema row `SC1`, Recipe values, spec branch, contract freeze). | ~1–2m/run | REFERENCE §SPEC.md template; `PLAN-FORMAT.md:135` | Document them. |
| 12 | **Brainstorm runs the full slow suite** before a docs-only spec. | ~36s (share) | `skills/brainstorm/CONVERSATION.md` | "Grounding reads tests; it doesn't run them." |
| 13 | **Final-review diff carries the feature's docs** (44KB, 12.9KB code). | ~8k Opus tokens/review | `scripts/review-package:39`; `scripts/dispatch.mjs:624` | Exclude the feature folder from the diff. |

## Bench tooling

- The report credits subagent tool calls, files, tests and waits to the orchestrator step
  (`scripts/bench-core.mjs:90-108`, no `e.top` check) — several "orchestrator" leads were implementers.
- `bench/budgets.json`: the `/builder:resume` budget predates build folding into resume (5.0 had
  resume 23 + build 31); every step is flagged over budget.
- Each session loads ~200 MCP tools from the owner's environment (~33k first-turn cache write);
  `--strict-mcp-config` would remove that noise.

## Justified (looked wasteful, wasn't)

Audit thinking and probes (found the real UTF-8 split-chunk bug); verifier suites (112s / 172s
total, never the bottleneck); implementers ran single test files with SLOW_TESTS_MS=0; the final
review on the top model (caught the only Important defect); walk=risk on share (15/15 in 106s).

## Projection

Fixes 1–4 alone bring share/builder from 1h07m to roughly 35–40m (estimate, not measured); 5–13 trim another ~5–8m per run.
