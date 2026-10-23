# benchmark 2026-10-23-1336-tags — tags

builder 4.12.0 · superpowers 7.0.0 · gsd — · default model · 2026-10-23T18:36:54.203Z

## Summary

| Config | Status | Wall | Turns | Tokens (in+out) | Cost | Accept | Fixture tests | Longest step |
|---|---|---|---|---|---|---|---|---|
| builder | done | 14m | 79 | 53k | $5.24 | 7/7 | 4/4 | builder:build 5m |
| builder-everything | done | 14m | 84 | 52k | $5.34 | 7/7 | 4/4 | builder:build 6m |

## Time per step

| Config | /builder:brainstorm | builder:spec | /builder:resume | builder:audit | builder:plan | builder:build | builder:agent-walk | builder:verify | builder:ship |
|---|---|---|---|---|---|---|---|---|---|
| builder | 56s | 1m | 36s | 46s | 1m | 5m | 1m | 47s | 27s |
| builder-everything | 54s | 1m | 36s | 36s | 1m | 6m | 1m | 34s | 24s |

## builder

wall 14m · 79 turns · 53k tokens (in+out) · $5.24 · accept 7/7 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder`

### brainstorm — 2m, 14 turns

prompt: `/builder:brainstorm --auto Notes can carry tags.`
plugins: builder 4.12.0

- **/builder:brainstorm** — 56s, 10 turns, Bash 4 · Write 1
  - files: .builder/note-tags/brainstorm.md
  - longest waits: 32s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 7s after Bash cd /Users/lukekeith/www/builder; f=$(grep -l '^## The classifier' skills/*/REFER · 3s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder/.builder/note-tags/brainstorm.md · 3s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 3s after Bash cd /Users/lukekeith/www/builder; ls skills/brainstorm scripts; grep -n '^## ' sk
- **builder:spec** — 1m, 12 turns, Bash 4 · Write 2 · Skill 1
  - files: docs/features/note-tags/SPEC.md, docs/features/note-tags/MANIFEST.md
  - longest waits: 57s after Bash mkdir -p /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10- · 9s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 5s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 4s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 3s after Bash cd /Users/lukekeith/www/builder; sed -n 252,560p skills/resume/REFERENCE.md

### fleet 01 (build) — 7m, 37 turns

prompt: `/builder:resume --path docs/features/note-tags --agent-walk`
plugins: builder 4.12.0

- **/builder:resume** — 9s, 5 turns, Bash 2
  - longest waits: 4s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d · 2s after Bash cd docs/features/note-tags && grep -q '^agent-walk:' MANIFEST.md || echo 'agent- · 1s after (start) · 1s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d · 1s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d
- **builder:audit** — 46s, 12 turns, Bash 6 · Skill 1
  - tests: node /Users/lukekeith/www/builder/scripts/check-obligations.mjs docs/features/no
  - longest waits: 12s after Bash cat -n src/cli.mjs src/store.mjs test/cli.test.mjs; cat README.md; ls; ls /Users · 9s after Bash node /Users/lukekeith/www/builder/scripts/check-obligations.mjs docs/features/no · 4s after Bash python3 - <<'EOF' · 3s after Bash python3 - <<'EOF' · 3s after Skill builder:audit
- **builder:plan** — 1m, 13 turns, Bash 5 · Skill 1 · Write 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/docs/features/note-tags/PLAN.md
  - longest waits: 44s after Bash cd ../../.. && git log -1 --format=%H; node /Users/lukekeith/www/builder/scripts · 22s after Bash cd ../../.. && git log -1 --format=%H; node /Users/lukekeith/www/builder/scripts · 5s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/docs/features/note-tags/PLAN.md · 5s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/docs/features/note-tags/PLAN.md · 4s after Bash T=$(mktemp -d) && cp -R src test package.json "$T"/ && cd "$T" && python3 - "$OL
- **builder:build** — 5m, 36 turns, Bash 27 · Agent 5 · Read 5 · Skill 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/.builder/note-tags/task-2-brief.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/src/cli.mjs, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/test/tags.test.mjs, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder.fleet/note-tags/.builder/note-tags/task-3-brief.md
  - tests: git log --oneline -2; git show --stat HEAD | tail -5; node --test test/ 2>&1 | g · node --test test/*.test.mjs 2>&1 | grep -E '^# (pass|fail)'
  - subagents: general-purpose — Implement Task 1: tag parsing · general-purpose — Implement Task 2: list --tag filter · general-purpose — Implement Task 3: show and tags · general-purpose — Final review: note-tags · general-purpose — Fix wave: harden tag tests
  - longest waits: 18s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 14s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 13s after Bash WS=$(/Users/lukekeith/www/builder/scripts/workspace note-tags); /Users/lukekeith · 12s after Bash F=docs/features/note-tags; python3 - <<'EOF' · 10s after Bash sed -n 1,30p test/tags.test.mjs

### fleet 02 (walk) — 3m, 28 turns

prompt: `/builder:resume --path docs/features/note-tags --agent-walk`
plugins: builder 4.12.0

- **/builder:resume** — 27s, 13 turns, Bash 6
  - longest waits: 4s after Bash B=/Users/lukekeith/www/builder; sed -n 270,312p $B/skills/build/SKILL.md; echo - · 3s after Bash cat .claude/builder.md | head -80; echo ----; cat docs/features/note-tags/MANIFE · 3s after Bash B=/Users/lukekeith/www/builder; grep -n "^## \|^### " $B/skills/resume/REFERENCE · 3s after Bash cd docs/features/note-tags && H=$(git rev-parse --short HEAD) && sed -i '' -e 's · 3s after Bash git merge-base --is-ancestor main HEAD && echo "main already in"; export NOTES_F
- **builder:agent-walk** — 1m, 13 turns, Bash 8 · Skill 1 · Agent 1
  - subagents: general-purpose — Agent walk round 1
  - longest waits: 15s after Bash git rev-parse --short HEAD && cat .builder/note-tags/walk.md && ls && ls src · 13s after Agent general-purpose Agent walk round 1 · 12s after Bash OUT=.builder/note-tags/agent-walk/round-1 && mkdir -p $OUT && S=$(mktemp -d)/wal · 11s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 11s after Bash cat > .builder/note-tags/agent-walk/round-1/report.md <<'EOF'
- **builder:verify** — 47s, 15 turns, Bash 6 · Skill 1
  - longest waits: 8s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 5s after Skill builder:verify · 4s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 4s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 4s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133
- **builder:ship** — 27s, 6 turns, Bash 3 · Skill 1
  - longest waits: 10s after Bash mkdir -p docs/features/_archive && git add docs/features/note-tags/SPEC.md && gi · 8s after Skill builder:ship · 5s after Bash /Users/lukekeith/www/builder/scripts/workspace --remove note-tags · 3s after Bash mkdir -p docs/features/_archive && git add docs/features/note-tags/SPEC.md && gi · 0s after Bash ls docs/features/_archive/note-tags 2>&1; grep -l 'child: note-tags' docs/featur

git log main:

```
8913315 merge(note-tags): agent-verified, not human-tested
e9dfabd docs(note-tags): note-tags shipped into main
6999c68 docs(note-tags): note-tags — verify READY
d25dc49 docs(note-tags): note-tags agent signed off (not human-tested)
f1d1e7d chore(note-tags): note-tags — built, awaiting the walk
310d574 chore(note-tags): note-tags — phases closed, awaiting the walk lane
b303caf docs(note-tags): correct F4 — a flag-looking --tag value is a valid tag
b6b8ad1 test(note-tags): harden tag tests per final review
611d08d chore(note-tags): note-tags — contract frozen at phase 2
5f5f84e feat(note-tags): show tags and the tags command
e37a004 feat(note-tags): filter list by one tag
25731a0 feat(note-tags): add --tag and tagged list lines
9f3d406 chore(note-tags): note-tags — go-ahead (own · risk · end)
f6f3963 docs(note-tags): plan note-tags
992bbc4 docs(note-tags): note-tags audited
1a5815c docs(note-tags): design note-tags
f79b62c fixture
```

## builder-everything

wall 14m · 84 turns · 52k tokens (in+out) · $5.34 · accept 7/7 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything`

### brainstorm — 2m, 17 turns

prompt: `/builder:brainstorm --auto Notes can carry tags.`
plugins: builder 4.12.0

- **/builder:brainstorm** — 54s, 13 turns, Bash 6 · Write 1
  - files: .builder/note-tags/brainstorm.md
  - longest waits: 32s after Bash /Users/lukekeith/www/builder/scripts/workspace note-tags && git check-ignore .bu · 10s after Bash cd /Users/lukekeith/www/builder; R=$(ls skills/*/REFERENCE.md REFERENCE.md 2>/de · 3s after Bash sed -n 60,200p /Users/lukekeith/www/builder/skills/brainstorm/CONVERSATION.md |  · 2s after Bash cat /Users/lukekeith/www/builder/skills/brainstorm/CONVERSATION.md; echo ====; c · 1s after Bash sed -n 260,300p /Users/lukekeith/www/builder/skills/brainstorm/CONVERSATION.md; 
- **builder:spec** — 1m, 14 turns, Bash 5 · Skill 1 · Write 1 · Edit 1
  - files: docs/features/note-tags/SPEC.md
  - longest waits: 55s after Bash mkdir -p /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10- · 8s after Bash git add docs/features/note-tags && git commit -q -m "docs(note-tags): design not · 3s after Bash cd /Users/lukekeith/www/builder/skills/resume; sed -n 235,360p REFERENCE.md; sed · 3s after Edit /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything/docs/features/note-tags/SPEC.md · 2s after Bash cat > docs/features/note-tags/MANIFEST.md <<EOF

### fleet 01 (build) — 8m, 38 turns

prompt: `/builder:resume --path docs/features/note-tags --agent-walk`
plugins: builder 4.12.0

- **/builder:resume** — 8s, 4 turns, Bash 2
  - longest waits: 3s after Bash cd docs/features/note-tags && sed -i '' 's/^auto: on 2026-10-23$/auto: on 2026-1 · 2s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d · 1s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d · 1s after (start) · 0s after Bash cat .claude/builder.md; echo ----; cat docs/features/note-tags/MANIFEST.md; ls d
- **builder:audit** — 36s, 9 turns, Bash 3 · Skill 1
  - tests: cat test/cli.test.mjs; ls; cat README.md 2>/dev/null; node /Users/lukekeith/www/
  - longest waits: 13s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 12s after Bash cat test/cli.test.mjs; ls; cat README.md 2>/dev/null; node /Users/lukekeith/www/ · 3s after Bash cat test/cli.test.mjs; ls; cat README.md 2>/dev/null; node /Users/lukekeith/www/ · 3s after Skill builder:audit · 2s after Bash cd docs/features/note-tags && python3 - <<'EOF'
- **builder:plan** — 1m, 10 turns, Bash 4 · Skill 1 · Write 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/docs/features/note-tags/PLAN.md
  - longest waits: 49s after Bash ls /Users/lukekeith/www/builder/scripts/ | head -50; grep -n -i "companion" -A8  · 10s after Bash cat /Users/lukekeith/www/builder/skills/plan/PLAN-FORMAT.md · 4s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/docs/features/note-tags/PLAN.md · 4s after Bash ls /Users/lukekeith/www/builder/scripts/ | head -50; grep -n -i "companion" -A8  · 3s after Skill builder:plan
- **builder:build** — 6m, 37 turns, Bash 36 · Agent 7 · Read 5 · Skill 1 · Write 1 · Edit 1
  - files: /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/.builder/note-tags/task-1-report.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/.builder/note-tags/task-1-brief.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/.builder/note-tags/review-ad8ec16..695cf77.diff, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/src/cli.mjs, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/.builder/note-tags/task-3-brief.md, /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-1336-tags/builder-everything.fleet/note-tags/.builder/note-tags/review-82e55df..91b73f1.diff
  - tests: npm test 2>&1 | grep -E '^# (tests|pass|fail)'; git diff --stat · cat src/cli.mjs | head -45 && head -25 test/tags.test.mjs && git status --short 
  - subagents: general-purpose — Implement Task 1: tags on add/list · general-purpose — Review Task 1 (spec + quality) · general-purpose — Implement Task 2: list --tag filter · general-purpose — Review Task 2 (spec + quality) · general-purpose — Implement Task 3: show/tags/usage · general-purpose — Review Task 3 (spec + quality) · general-purpose — Final review: note-tags
  - longest waits: 24s after Bash D=$(mktemp -d) && export NOTES_FILE=$D/n.json && C=src/cli.mjs · 15s after Bash WS=$(/Users/lukekeith/www/builder/scripts/workspace note-tags); cat >> "$WS/prog · 14s after Bash B=/Users/lukekeith/www/builder/scripts; node $B/job.mjs start deep-notes -- node · 14s after Bash cat -n src/cli.mjs src/store.mjs && git diff 2ccc22d dd15440 -- README.md src/st · 13s after Bash WS=$(/Users/lukekeith/www/builder/scripts/workspace note-tags); /Users/lukekeith

### fleet 02 (walk) — 2m, 29 turns

prompt: `/builder:resume --path docs/features/note-tags --agent-walk`
plugins: builder 4.12.0

- **/builder:resume** — 28s, 13 turns, Bash 7
  - longest waits: 4s after Bash cat .builder/note-tags/walk.md; echo ----; sed -n '/^## Contract/,/^## Schema/p' · 4s after Bash sed -n 735,806p /Users/lukekeith/www/builder/skills/resume/REFERENCE.md; sed -n  · 3s after Bash export NOTES_FILE=$(mktemp -d)/n.json; c(){ echo "\$ $*"; node src/cli.mjs "$@"; · 3s after Bash cd /Users/lukekeith/www/builder/skills/resume; grep -n "^## \|^### " REFERENCE.m · 2s after Bash cd docs/features/note-tags && sed -i '' -e 's/^state: building/state: built/' -e
- **builder:agent-walk** — 1m, 13 turns, Bash 7 · Skill 1 · Agent 1
  - subagents: general-purpose — Agent walk round 1 for note-tags
  - longest waits: 13s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 13s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133 · 13s after Bash git rev-parse --short HEAD && cat .builder/note-tags/walk.md && ls src · 10s after Bash node /Users/lukekeith/www/builder/scripts/profile.mjs --levers docs/features/not · 5s after Bash cd /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-23-133
- **builder:verify** — 34s, 18 turns, Bash 6 · Skill 1
  - longest waits: 4s after Bash git diff main...HEAD -- src README.md | cat; sed -n '/^## Decisions/,/^## Contra · 4s after Bash B=/Users/lukekeith/www/builder/scripts · 3s after Skill builder:verify · 3s after Skill builder:verify · 3s after Bash B=/Users/lukekeith/www/builder/scripts
- **builder:ship** — 24s, 9 turns, Bash 4 · Skill 1
  - longest waits: 9s after Bash git commit -qm "docs(note-tags): note-tags shipped into main · 4s after Skill builder:ship · 3s after Bash /Users/lukekeith/www/builder/scripts/workspace --remove note-tags · 3s after Bash ls docs/features/_archive/note-tags 2>&1; grep -l 'child: note-tags' docs/featur · 2s after Bash ls docs/features/_archive/note-tags 2>&1; grep -l 'child: note-tags' docs/featur

git log main:

```
dde44b5 merge(note-tags): agent-verified, not human-tested
57c55ed docs(note-tags): note-tags shipped into main
be806b1 docs(note-tags): note-tags — verify READY
58e07eb docs(note-tags): note-tags agent signed off (not human-tested)
c17f1f1 chore(note-tags): note-tags — walk-ready, built
f10140a chore(note-tags): note-tags — phases closed, awaiting the walk lane
dd15440 chore(note-tags): note-tags — contract frozen at phase 1
91b73f1 feat(note-tags): tags in show, the tags command, usage and README
82e55df feat(note-tags): filter list by --tag
695cf77 feat(note-tags): store tags on add and show them in list
ad8ec16 docs(note-tags): plan note-tags — go-ahead auto (recommended) (own+app · everything · slice)
d6cc5e2 docs(note-tags): note-tags audited
2ccc22d bench(note-tags): test plan slice=own+app end=everything review=slice
d42ed6b docs(note-tags): design note-tags
2c49e0f fixture
```
