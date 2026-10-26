# benchmark 2026-10-26-0126-tags — tags

builder 5.0.0 · superpowers 7.0.0 · gsd 1.18.0 · default model · 2026-10-26T06:26:25.820Z

## Summary

| Config | Status | Wall | Turns | Tokens (in+out) | Cost | Accept | Fixture tests | Longest step | Orchestrator · Agents · Tools |
|---|---|---|---|---|---|---|---|---|---|
| gsd | done | 1h20m | 160 | 111k | $32.36 | 7/7 | 4/4 | gsd-plan-phase 35m | 43.9m 55% · 33.4m 42% · 3.1m 4% |

## Time per step

| Config | /gsd-new-project | gsd-discuss-phase | gsd-plan-phase | gsd-execute-phase | gsd-secure-phase | gsd-code-review | gsd-verify-work | gsd-complete-milestone | /gsd-plan-phase | /gsd-execute-phase | gsd-ui-review | /gsd-verify-work |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gsd | 6m | 1m | 35m | 8m | 1m | 14m | 2m | 1m | 2m | 3m | 1m | 1m |

## Turns per step

| Config | /gsd-new-project | gsd-discuss-phase | gsd-plan-phase | gsd-execute-phase | gsd-secure-phase | gsd-code-review | gsd-verify-work | gsd-complete-milestone | /gsd-plan-phase | /gsd-execute-phase | gsd-ui-review | /gsd-verify-work |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gsd | 37 | 13 | 72 | 55 | 29 | 94 | 30 | 25 | 28 | 39 | 11 | 23 |

## gsd

wall 1h20m (install 2s, not counted) · 160 turns · 111k tokens (in+out) · $32.36 · accept 7/7 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd`

### new-project — 1h01m, 61 turns

split: orchestrator 28.8m (47%) · agents 30.2m (49%) · tools 2.0m (3%)

prompt: `/gsd-new-project --auto @REQUEST.md`

- **/gsd-new-project** — 6m, 37 turns, Read 34 · Bash 22 · Write 11 · Agent 6 · Edit 1
  - files: .planning/PROJECT.md, src/cli.mjs, src/store.mjs, test/cli.test.mjs, .claude/gsd-core/templates/research-project/STACK.md, REQUEST.md, .claude/gsd-core/templates/research-project/FEATURES.md, .claude/gsd-core/references/untrusted-input-boundary.md, .claude/gsd-core/references/agent-skills-bootstrap.md, .claude/gsd-core/templates/research-project/ARCHITECTURE.md, .claude/gsd-core/templates/research-project/PITFALLS.md, .planning/research/FEATURES.md, .planning/research/ARCHITECTURE.md, .planning/research/STACK.md, .planning/research/PITFALLS.md, .claude/gsd-core/templates/research-project/SUMMARY.md, .planning/research/SUMMARY.md, .planning/REQUIREMENTS.md, .planning/config.json, .claude/gsd-core/templates/roadmap.md, .claude/gsd-core/templates/state.md, .planning/ROADMAP.md, .planning/STATE.md
  - tests: cat REQUEST.md README.md && npm test 2>&1 | tail -15
  - subagents: gsd-project-researcher — Stack research · gsd-project-researcher — Features research · gsd-project-researcher — Architecture research · gsd-project-researcher — Pitfalls research · gsd-research-synthesizer — Synthesize research · gsd-roadmapper — Create roadmap
  - longest waits: 22s after Bash sed -n 955,990p .claude/gsd-core/workflows/new-project.md; echo ----; grep -nE " · 21s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.claude/gsd-core/templates/research-project/SUMMARY.md · 18s after Bash node .claude/gsd-core/bin/gsd-tools.cjs query commit "docs: complete project res · 15s after Bash node .claude/gsd-core/bin/gsd-tools.cjs query commit "docs: complete project res · 15s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.planning/research/STACK.md
- **gsd-discuss-phase** — 1m, 13 turns, Bash 6 · Write 2 · Skill 1 · Read 1
  - files: .claude/gsd-core/workflows/discuss-phase.md, .planning/phases/01-tags/01-CONTEXT.md, .planning/phases/01-tags/01-DISCUSSION-LOG.md
  - longest waits: 16s after Bash mkdir -p /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10- · 8s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; cat .claude/gsd-core/workflows/discuss-pha · 8s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.claude/gsd-core/workflows/discuss-phase.md · 6s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.planning/phases/01-tags/01-CONTEXT.md · 5s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.planning/phases/01-tags/01-DISCUSSION-LOG.md
- **gsd-plan-phase** — 35m, 72 turns, Bash 83 · Read 42 · Edit 29 · Agent 6 · Write 6 · SendMessage 3 · Skill 1 · ToolSearch 1
  - files: .claude/gsd-core/workflows/plan-phase.md, .planning/phases/01-tags/01-CONTEXT.md, .planning/REQUIREMENTS.md, .planning/STATE.md, .planning/research/SUMMARY.md, src/cli.mjs, src/store.mjs, test/cli.test.mjs, package.json, REQUEST.md, /tmp/tagsproto.4RqXSj/src/cli.mjs, /tmp/tagsproto.4RqXSj/test/tags.test.mjs, .planning/phases/01-tags/01-RESEARCH.md, .planning/phases/01-tags/01-PATTERNS.md, .claude/gsd-core/references/planner-antipatterns.md, .claude/gsd-core/bin/lib/frontmatter.cjs, .planning/phases/01-tags/SKELETON.md, .planning/phases/01-tags/01-01-PLAN.md, .planning/ROADMAP.md, /tmp/gsd-verify-paths-01.json, /tmp/gsd-failing-dirs-01.json, .claude/gsd-core/references/planner-revision.md, .claude/CLAUDE.md, .claude/gsd-core/references/prohibition-probe.md, .claude/gsd-core/bin/lib/probe-core.cjs
  - tests: S=$(mktemp -d /tmp/tagsproto.XXXXXX) && echo $S > /tmp/tagsproto.path && cd /pri · cd /tmp/tagsproto.4RqXSj && npm test 2>&1 | grep -E "^(ok|not ok|# (tests|pass|f · npm test 2>&1 | tail -15; echo "exit=$?"; echo ----; git ls-files -- .claude; gi · node -e 'const e=require("./.claude/gsd-core/bin/lib/edge-probe.cjs");const t="U
  - subagents: gsd-phase-researcher — Research Phase 1 · gsd-pattern-mapper — Pattern map Phase 1 · gsd-planner — Plan Phase 1 · gsd-plan-checker — Verify Phase 1 plans · gsd-planner — Revise Phase 1 plans · gsd-plan-checker — Re-verify Phase 1 plans
  - longest waits: 2m after Bash set -e; S=$(mktemp -d /tmp/gsd-plan-probe-XXXX); mkdir -p $S/src; cp /private/va · 2m after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.planning/phases/01-tags/SKELETON.md · 1m after Bash echo "readme --tag: $(grep -c -- '--tag' README.md)"; echo "readme notes tags: $ · 1m after Bash sed -n 105,160p .claude/gsd-core/references/edge-probe.md; echo ----; sed -n 1,6 · 1m after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.claude/gsd-core/bin/lib/frontmatter.cjs
- **gsd-execute-phase** — 8m, 55 turns, Bash 62 · Read 12 · Edit 8 · Write 2 · Skill 1 · Agent 1
  - files: .claude/gsd-core/workflows/execute-phase.md, .claude/worktrees/agent-a03dc86b92e10fe75/.planning/phases/01-tags/01-01-PLAN.md, .claude/gsd-core/workflows/execute-plan.md, .claude/gsd-core/templates/summary.md, .claude/gsd-core/references/tdd.md, .claude/gsd-core/references/worktree-path-safety.md, .claude/worktrees/agent-a03dc86b92e10fe75/src/cli.mjs, .claude/worktrees/agent-a03dc86b92e10fe75/test/cli.test.mjs, .claude/worktrees/agent-a03dc86b92e10fe75/.claude/CLAUDE.md, .claude/worktrees/agent-a03dc86b92e10fe75/README.md, .claude/worktrees/agent-a03dc86b92e10fe75/test/tags.test.mjs, .claude/worktrees/agent-a03dc86b92e10fe75/.planning/phases/01-tags/01-01-SUMMARY.md
  - tests: node --test --test-reporter=tap test/tags.test.mjs 2>&1 | grep -E '^(not ok|ok|# · node --test --test-reporter=tap test/tags.test.mjs 2>&1 | grep -E '^(not ok|# (t · npm test 2>&1 | grep -E '^(not ok|# (tests|pass|fail))' · G=.claude/gsd-core/bin/gsd-tools.cjs; grep -q '"build"' package.json || echo "⚠ 
  - subagents: gsd-executor — Execute plan 01 of phase 01
  - longest waits: 27s after Bash date -u +%Y-%m-%dT%H:%M:%SZ · 20s after Bash M=$(mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX") && mv "$M" "$M.json" && M · 15s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; M=$(cat /tmp/gsd-wave-manifest-path); WT=$ · 12s after Bash S=.claude/gsd-core/workflows/execute-phase/steps; sed -n '/Resolve ISOLATION/,/^ · 10s after Bash cat >> test/tags.test.mjs <<'EOF'
- **gsd-secure-phase** — 35s, 10 turns, Bash 3 · Skill 1 · Write 1
  - files: .planning/phases/01-tags/01-SECURITY.md
  - longest waits: 10s after Bash grep -n "TAG_RE\|new Map\|nextId++\|save(" src/cli.mjs; git diff --quiet d4a042a · 6s after Skill gsd-secure-phase · 6s after Bash grep -n "TAG_RE\|new Map\|nextId++\|save(" src/cli.mjs; git diff --quiet d4a042a · 4s after Bash P=.planning/phases/01-tags; sed -n '/<threat_model>/,/<\/threat_model>/p' $P/01- · 4s after Bash node .claude/gsd-core/bin/gsd-tools.cjs query commit "docs(phase-01): add/update
- **gsd-code-review** — 5m, 24 turns, Bash 21 · Read 12 · Write 3 · Agent 2 · Skill 1
  - files: src/cli.mjs, test/tags.test.mjs, README.md, REQUEST.md, .planning/phases/01-tags/01-CONTEXT.md, .planning/phases/01-tags/01-REVIEW.md, .claude/gsd-core/references/mandatory-initial-read.md, .planning/phases/01-tags/01-01-PLAN.md, .planning/phases/01-tags/01-01-SUMMARY.md, .planning/REQUIREMENTS.md, .claude/gsd-core/references/gsd-run-resolver.md, .claude/gsd-core/references/verify-mvp-mode.md, .planning/phases/01-tags/01-VERIFICATION.md, .planning/phases/01-tags/01-UAT.md
  - tests: cat src/store.mjs package.json; ls test; git diff 51534f6 --stat -- src test REA · npm test 2>&1 | grep -E "^(not ok|ok|# )"
  - subagents: gsd-code-reviewer — Code review phase 01 · gsd-verifier — Verify phase 01 goal achievement
  - longest waits: 50s after Bash echo "debt markers:"; grep -n -E "TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER" src/cli.m · 24s after Bash node .claude/gsd-core/bin/gsd-tools.cjs query verification.status .planning/phas · 17s after Bash git diff 51534f6 -- src/cli.mjs | head -90; cd /tmp && d=$(mktemp -d) && cd $d & · 17s after Bash ls .claude/gsd-core/bin/ && gsd_run() { node .claude/gsd-core/bin/gsd-tools.cjs  · 14s after Bash CLI="$PWD/src/cli.mjs"; T=$(mktemp -d); n() { NOTES_FILE="$F" node "$CLI" "$@"; 
- **gsd-verify-work** — 2m, 30 turns, Bash 11 · Skill 1 · Read 1
  - files: .claude/gsd-core/workflows/transition.md
  - tests: G=.claude/gsd-core/bin/gsd-tools.cjs; node $G query config-set workflow._auto_ch
  - longest waits: 19s after Skill gsd-verify-work · 14s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; node $G check api-coverage.verify-pre "$PW · 14s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; ls .planning/phases/01-tags/.continue-here · 9s after Bash F=.planning/phases/01-tags/01-UAT.md && node -e ' · 8s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; INIT=$(node $G query init.verify-work 01);
- **gsd-complete-milestone** — 1m, 25 turns, Bash 10 · Write 2 · Skill 1 · Read 1
  - files: .planning/ROADMAP.md, .planning/RETROSPECTIVE.md
  - tests: sed -i '' 's/^\*\*Current focus:\*\* Phase 01 — Tags$/**Current focus:** Plannin
  - longest waits: 13s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; IR=$(node $G query init.complete-milestone · 12s after Bash sed -i '' 's/^\*\*Current focus:\*\* Phase 01 — Tags$/**Current focus:** Plannin · 8s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.planning/ROADMAP.md · 7s after Bash sed -i '' 's/^\*\*Current focus:\*\* Phase 01 — Tags$/**Current focus:** Plannin · 7s after Bash G=.claude/gsd-core/bin/gsd-tools.cjs; ls .planning/*MILESTONE-AUDIT* 2>/dev/null

### plan-phase — 2m, 18 turns

split: orchestrator 2.2m (92%) · agents 0.0m (0%) · tools 0.2m (8%)

prompt: `/gsd-plan-phase 1`

- **/gsd-plan-phase** — 2m, 28 turns, Bash 10 · Read 7
  - files: .claude/gsd-core/workflows/plan-phase.md, .claude/gsd-core/references/revision-loop.md, .claude/gsd-core/references/gate-prompts.md, .claude/gsd-core/references/agent-contracts.md, .claude/gsd-core/references/gates.md, .claude/gsd-core/workflows/plan-phase/detail/elaboration.md
  - tests: cat -n src/cli.mjs && echo "=====STORE=====" && cat -n src/store.mjs && echo "==
  - longest waits: 32s after Bash gsd_run() { node .claude/gsd-core/bin/gsd-tools.cjs "$@"; }; echo "---get-phase- · 27s after Bash git status --short && echo "---SMOKE---" && T=$(mktemp -d) && export NOTES_FILE= · 14s after Bash cat -n src/cli.mjs && echo "=====STORE=====" && cat -n src/store.mjs && echo "== · 6s after Bash cat -n src/cli.mjs && echo "=====STORE=====" && cat -n src/store.mjs && echo "== · 5s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.claude/gsd-core/references/gates.md

### execute-phase — 15m, 70 turns

split: orchestrator 11.7m (76%) · agents 3.2m (21%) · tools 0.6m (4%)

prompt: `/gsd-execute-phase 1`

- **/gsd-execute-phase** — 3m, 39 turns, Bash 16 · Read 3
  - files: .claude/gsd-core/workflows/execute-phase.md, .claude/gsd-core/workflows/execute-phase/steps/verify-phase-goal.md
  - tests: cat REQUEST.md && echo "--- README" && cat README.md && echo "--- package.json" 
  - longest waits: 29s after Bash source /tmp/gsd_resolver.sh · 19s after Bash cat > /tmp/gsd_resolver.sh <<'EOF' · 18s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-012 · 13s after Bash source /tmp/gsd_resolver.sh · 11s after Bash G=/private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126
- **gsd-secure-phase** — 1m, 19 turns, Bash 8 · Skill 1
  - longest waits: 7s after Bash git commit --amend --quiet -m "docs(phase-01): add/update security threat verifi · 6s after Skill gsd-secure-phase · 6s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-012 · 4s after Bash D=.planning/milestones/v1.0-phases/01-tags · 4s after Bash source /tmp/gsd_resolver.sh
- **gsd-ui-review** — 1m, 11 turns, Read 4 · Bash 3 · Skill 1 · Agent 1 · Write 1
  - files: .planning/milestones/v1.0-phases/01-tags/01-01-SUMMARY.md, .planning/milestones/v1.0-phases/01-tags/01-01-PLAN.md, .planning/milestones/v1.0-phases/01-tags/01-CONTEXT.md, src/cli.mjs, .planning/milestones/v1.0-phases/01-tags/01-UI-REVIEW.md
  - subagents: gsd-ui-auditor — UI Audit Phase 01
  - longest waits: 26s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/src/cli.mjs · 11s after Bash source /tmp/gsd_resolver.sh · 8s after Bash source /tmp/gsd_resolver.sh · 7s after Bash source /tmp/gsd_resolver.sh · 6s after Skill gsd-ui-review
- **gsd-code-review** — 9m, 70 turns, Bash 38 · Read 13 · Skill 1 · Agent 1 · Write 1 · Edit 1
  - files: .claude/gsd-core/references/mandatory-initial-read.md, .claude/gsd-core/references/gsd-run-resolver.md, .planning/milestones/v1.0-phases/01-tags/01-VERIFICATION.md, .planning/milestones/v1.0-phases/01-tags/01-UAT.md, .planning/milestones/v1.0-phases/01-tags/01-01-SUMMARY.md, .planning/milestones/v1.0-REQUIREMENTS.md, .claude/gsd-core/references/verification-overrides.md, .claude/gsd-core/references/verifier-phase-gates.md, .claude/gsd-core/references/gates.md, .claude/gsd-core/references/verifier-evidence-gate.md, .claude/gsd-core/workflows/transition.md, .planning/STATE.md
  - tests: git diff --quiet d4a042a -- src/store.mjs test/cli.test.mjs package.json && echo
  - subagents: gsd-verifier — Verify phase 01 goal achievement
  - longest waits: 51s after Bash _GSD_RUNTIME_ROOT="$(git rev-parse --show-toplevel)"; GSD_TOOLS="$_GSD_RUNTIME_R · 35s after Bash sed -n '636,725p' /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench · 32s after Read /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0126-tags/gsd/.claude/gsd-core/workflows/transition.md · 27s after Skill gsd-code-review · 23s after Bash grep -rn "dispositionForProhibition" .claude/gsd-core --include=* -l 2>/dev/null

### verify-work — 1m, 11 turns

split: orchestrator 1.2m (79%) · agents 0.0m (0%) · tools 0.3m (21%)

prompt: `/gsd-verify-work 1 — then merge the work into `main` and leave `main` checked ou`

- **/gsd-verify-work** — 1m, 23 turns, Bash 10
  - tests: find .planning -type f | sort && cat .planning/STATE.md && git status --short |  · git branch --show-current && git branch -a && git status --short --untracked-fil
  - longest waits: 9s after Bash G="node .claude/gsd-core/bin/gsd-tools.cjs"; $G loop render-hooks verify:pre --r · 8s after Bash find .planning -type f | sort && cat .planning/STATE.md && git status --short |  · 8s after Bash git branch --show-current && git branch -a && git status --short --untracked-fil · 7s after Bash git branch --show-current && git branch -a && git status --short --untracked-fil · 6s after Bash cat .planning/milestones/v1.0-phases/01-tags/01-01-SUMMARY.md; cat src/cli.mjs; 

git log main:

```
af4ee43 docs(state): record phase 01 re-verification and close out transition
7a2f988 docs(phase-01): complete phase execution
be35c89 docs(01): UI audit review
1c37714 docs(phase-01): add/update security threat verification
d0d5d41 docs(state): point focus at next milestone
c275bc8 chore: remove REQUIREMENTS.md for v1.0 milestone
e57993f docs: update retrospective for v1.0
2ccaffe chore: archive v1.0 milestone files
e95615c chore: clear auto-advance chain flag at milestone boundary
7b03d98 docs(phase-01): complete phase execution
1f8a87b test(01): complete UAT - 4 passed, 0 issues
7f3c97b test(01): persist human verification items as UAT
f797ee1 docs(01): record code review disposition
026ca77 docs(01): add code review report
cda1279 docs(phase-01): add/update security threat verification
0c01279 docs(phase-01): update tracking after wave 1
85097b2 chore: merge executor worktree (worktree-agent-a03dc86b92e10fe75)
dba505b docs(01-01): complete tags plan
3b6d59e feat(01-01): show tags line, add notes tags command, legacy-file tests
de413b5 feat(01-01): validate tags and lock tag parsing edge cases
```
