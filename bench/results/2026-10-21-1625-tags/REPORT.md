# benchmark 2026-10-21-1625-tags — tags

builder 4.11.1 · superpowers 7.0.0 · gsd — · default model · 2026-10-21T21:25:06.127Z

## Summary

| Config | Status | Wall | Turns | Tokens (in+out) | Cost | Accept | Fixture tests | Longest step |
|---|---|---|---|---|---|---|---|---|
| builder-rush | done | 11m | 77 | 45k | $4.89 | 7/7 | 4/4 | builder:build 5m |

## Time per step

| Config | /builder:brainstorm | builder:spec | /builder:resume | builder:audit | builder:plan | builder:build | builder:agent-walk | builder:verify | builder:ship |
|---|---|---|---|---|---|---|---|---|---|
| builder-rush | 55s | 1m | 29s | 33s | 59s | 5m | 1m | 22s | 14s |

## builder-rush

wall 11m · 77 turns · 45k tokens (in+out) · $4.89 · accept 7/7 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush`

### brainstorm — 2m, 13 turns

prompt: `/builder:brainstorm --auto Notes can carry tags.`
plugins: builder 4.11.1

- **/builder:brainstorm** — 55s, 13 turns, Bash 6
  - longest waits: 29s after Bash cd /Users/lukekeith/www/builder; ls .builder 2>/dev/null; F=$(grep -rl '^## The  · 6s after Bash cd /Users/lukekeith/www/builder; ls .builder 2>/dev/null; F=$(grep -rl '^## The  · 6s after Bash cd /Users/lukekeith/www/builder; ls; ls skills; grep -n '^## \|^### ' skills/*/R · 4s after Bash mkdir -p .builder/tags && grep -n builder .gitignore; cat > .builder/tags/brains · 3s after Bash cat /Users/lukekeith/www/builder/skills/brainstorm/CONVERSATION.md; echo ----; c
- **builder:spec** — 1m, 9 turns, Bash 4 · Skill 1
  - longest waits: 48s after Bash cd /Users/lukekeith/www/builder/skills/resume; awk '/^## Branch and ticket/,/^## · 8s after Bash git add docs/features/tags && git commit -q -m "docs(tags): design tags · 6s after Bash mkdir -p docs/features/tags && cat > docs/features/tags/SPEC.md <<'EOF' · 3s after Bash cd /Users/lukekeith/www/builder/skills/resume; awk '/^## Branch and ticket/,/^## · 2s after Skill builder:spec

### fleet 01 (build) — 6m, 38 turns

prompt: `/builder:resume --path docs/features/tags --agent-walk`
plugins: builder 4.11.1

- **/builder:resume** — 6s, 5 turns, Bash 2
  - longest waits: 2s after Bash cat .claude/builder.md; echo ----; cat docs/features/tags/MANIFEST.md; ls docs/f · 1s after Bash cat .claude/builder.md; echo ----; cat docs/features/tags/MANIFEST.md; ls docs/f · 1s after (start) · 1s after Bash sed -i '' 's/^agent-walk: off$/agent-walk: on 2026-10-21/' docs/features/tags/MA · 1s after Bash sed -i '' 's/^agent-walk: off$/agent-walk: on 2026-10-21/' docs/features/tags/MA
- **builder:audit** — 33s, 12 turns, Bash 5 · Skill 1
  - longest waits: 11s after Bash node /Users/lukekeith/www/builder/scripts/check-obligations.mjs docs/features/ta · 11s after Bash cat -n src/cli.mjs src/store.mjs test/cli.test.mjs; ls; cat README.md 2>/dev/nul · 2s after Bash cd docs/features/tags && python3 - <<'EOF' · 2s after Bash node /Users/lukekeith/www/builder/scripts/check-obligations.mjs docs/features/ta · 2s after Bash cat docs/features/tags/SPEC.md; echo ----; ls -R src test; cat package.json; wc 
- **builder:plan** — 59s, 7 turns, Bash 2 · Skill 1 · Write 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/docs/features/tags/PLAN.md
  - longest waits: 39s after Bash cat /Users/lukekeith/www/builder/skills/plan/PLAN-FORMAT.md; node /Users/lukekei · 11s after Bash cat /Users/lukekeith/www/builder/skills/plan/PLAN-FORMAT.md; node /Users/lukekei · 3s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/docs/features/tags/PLAN.md · 2s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/docs/features/tags/PLAN.md · 2s after Skill builder:plan
- **builder:build** — 5m, 37 turns, Bash 40 · Agent 7 · Read 6 · Edit 2 · Skill 1 · Write 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/task-1-brief.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/review-cd96acb..1f96e93.diff, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/task-1-report.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/src/cli.mjs, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/task-2-brief.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/review-1f96e93..7e80403.diff, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/task-2-report.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625-tags/builder-rush.fleet/tags/.builder/tags/task-3-report.md
  - tests: npm test > /tmp/t2.out 2>&1; echo "exit=$?"; grep -E "^# (tests|pass|fail)|^not  · npm test 2>&1 | sed -n '/not ok 11/,/not ok 12/p' | head -25; npm test 2>&1 | se
  - subagents: general-purpose — Implement Task 1: --tag on add · general-purpose — Review Task 1 (spec + quality) · general-purpose — Implement Task 2: list tags · general-purpose — Review Task 2 (spec + quality) · general-purpose — Implement Task 3: show, tags, README · general-purpose — Review Task 3 (spec + quality) · general-purpose — Final review: tags
  - longest waits: 15s after Bash cat -n src/store.mjs package.json; git diff main --stat · 11s after Bash B=/Users/lukekeith/www/builder; WS=$($B/scripts/workspace tags); cat >> "$WS/pro · 10s after Bash B=/Users/lukekeith/www/builder; WS=$($B/scripts/workspace tags); cat >> "$WS/pro · 10s after Bash git rev-parse --short HEAD · 10s after Bash python3 - <<'EOF'

### fleet 02 (walk) — 2m, 26 turns

prompt: `/builder:resume --path docs/features/tags --agent-walk`
plugins: builder 4.11.1

- **/builder:resume** — 24s, 13 turns, Bash 6
  - longest waits: 8s after Bash export NOTES_FILE=$(mktemp -d)/n.json; c(){ node src/cli.mjs "$@"; } · 2s after Bash B=/Users/lukekeith/www/builder; node $B/scripts/gate.mjs notes 2>&1 | tail -15;  · 2s after Bash B=/Users/lukekeith/www/builder; awk '/^## Walk readiness/,/^## [^W]/' $B/skills/ · 2s after Bash cat .builder/tags/progress.md; echo ----; sed -n 1,200p docs/features/tags/SPEC. · 2s after Bash export NOTES_FILE=$(mktemp -d)/n.json; c(){ node src/cli.mjs "$@"; }
- **builder:agent-walk** — 1m, 9 turns, Bash 10 · Skill 1 · Agent 1
  - tests: sed -i '' 's|Supplementary: `npm test` run, see 09-npm-test.txt.|Supplementary: 
  - subagents: general-purpose — Agent walk round 1 for tags
  - longest waits: 9s after Bash sed -i '' 's|Supplementary: `npm test` run, see 09-npm-test.txt.|Supplementary:  · 8s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-162 · 7s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-162 · 7s after Bash R=/private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-21-1625 · 7s after Bash B=/Users/lukekeith/www/builder; node $B/scripts/profile.mjs --levers docs/featur
- **builder:verify** — 22s, 15 turns, Bash 6 · Skill 1
  - longest waits: 4s after Bash cat -n src/cli.mjs; grep -n "test(" test/cli.test.mjs · 3s after Skill builder:verify · 3s after Bash grep -n "'foo'\|list foo\|'Home'\|a_b\|'#a'\|'a b'" test/cli.test.mjs; git diff  · 2s after Bash B=/Users/lukekeith/www/builder; node $B/scripts/job.mjs start verify-tags -- nod · 2s after Skill builder:verify
- **builder:ship** — 14s, 6 turns, Bash 3 · Skill 1
  - longest waits: 7s after Bash mkdir -p docs/features/_archive && git add docs/features/tags/SPEC.md && git mv  · 3s after Skill builder:ship · 2s after Bash /Users/lukekeith/www/builder/scripts/workspace --remove tags · 1s after Bash /Users/lukekeith/www/builder/scripts/workspace --remove tags · 0s after Bash ls docs/features/_archive/tags 2>&1; grep -n '^ticket' docs/features/tags/MANIFE

git log main:

```
318404f merge(tags): agent-verified, not human-tested
28bca4e docs(tags): tags shipped into main
cfa5ce7 docs(tags): tags — verify READY
2115a7b docs(tags): tags agent signed off (not human-tested)
473e445 chore(tags): tags — walk ready, built
ed9bc75 chore(tags): tags — phases closed, awaiting the walk lane
2bf510f feat(tags): show tags, tags command, README
7e80403 feat(tags): list shows and filters tags
1f96e93 feat(tags): --tag on add
cd96acb chore(tags): tags — go-ahead (thorough)
7f38ff0 docs(tags): plan tags
96f4304 docs(tags): tags audited
2be660f chore(tags): agent-walk on
86f3661 docs(tags): design tags
026b1aa fixture
```
