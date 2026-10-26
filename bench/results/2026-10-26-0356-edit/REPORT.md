# benchmark 2026-10-26-0356-edit — edit

builder 5.0.0 · superpowers 7.0.0 · gsd — · default model · 2026-10-26T08:56:31.244Z

## Summary

| Config | Status | Wall | Turns | Tokens (in+out) | Cost | Accept | Fixture tests | Longest step | Orchestrator · Agents · Tools |
|---|---|---|---|---|---|---|---|---|---|
| builder | done | 58s (53s–1m) | 10 (9–12) | 5k | $0.52 ($0.50–$0.55) | 3/3 | 4/4 | /builder:brainstorm 53s | 0.7m 85% · 0.0m 0% · 0.1m 15% |

median (min–max) of 3 reps

## Time per step

| Config | /builder:brainstorm |
|---|---|
| builder | 53s (48s–1m) |

## Turns per step

| Config | /builder:brainstorm |
|---|---|
| builder | 19 |

## builder — rep 1

wall 1m · 10 turns · 5k tokens (in+out) · $0.52 · accept 3/3 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0356-edit/builder-1`

### brainstorm — 1m, 10 turns

split: orchestrator 1.0m (87%) · agents 0.0m (0%) · tools 0.2m (13%)

prompt: `/builder:brainstorm --auto Notes can be edited.`
plugins: builder 5.0.0

- **/builder:brainstorm** — 1m, 19 turns, Bash 9
  - longest waits: 8s after Bash F=/Users/lukekeith/.claude-home/projects/-private-var-folders-m9-828j21md44g2gxs · 7s after Bash git add README.md src/cli.mjs test/cli.test.mjs && git commit -qm "feat(notes):  · 6s after Bash grep -n "Steering and --auto" -A60 /Users/lukekeith/.claude-home/projects/-priva · 5s after Bash mkdir -p .builder/notes-edit && cat > .builder/notes-edit/brainstorm.md <<'EOF' · 5s after Bash cat >> test/cli.test.mjs <<'EOF'

git log main:

```
6cc23a9 Merge branch 'feat/notes-edit'
ce72524 feat(notes): add notes edit <id> <text>
3d924ae fixture
```

## builder — rep 2

wall 58s · 12 turns · 5k tokens (in+out) · $0.55 · accept 3/3 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0356-edit/builder-2`

### brainstorm — 55s, 12 turns

split: orchestrator 0.7m (85%) · agents 0.0m (0%) · tools 0.1m (15%)

prompt: `/builder:brainstorm --auto Notes can be edited.`
plugins: builder 5.0.0

- **/builder:brainstorm** — 53s, 19 turns, Bash 10 · Write 1
  - files: .builder/notes-edit/brainstorm.md
  - longest waits: 7s after Bash sed -i '' 's/^status: sized sm/status: handed-off/' .builder/notes-edit/brainsto · 4s after Write /private/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0356-edit/builder-2/.builder/notes-edit/brainstorm.md · 4s after Bash cat README.md · 4s after Bash cat >> test/cli.test.mjs <<'EOF' · 3s after Bash mkdir -p .builder/notes-edit && git check-ignore -v .builder/notes-edit/brainsto

git log main:

```
394e435 Merge branch 'feat/notes-edit'
afa3bc7 feat(notes): add notes edit <id> <text>
6ac9ca1 fixture
```

## builder — rep 3

wall 53s · 9 turns · 5k tokens (in+out) · $0.50 · accept 3/3 · fixture 4/4
copy: `/var/folders/m9/828j21md44g2gxs0bdctg5hw0000gp/T/bench/2026-10-26-0356-edit/builder-3`

### brainstorm — 50s, 9 turns

split: orchestrator 0.7m (85%) · agents 0.0m (0%) · tools 0.1m (15%)

prompt: `/builder:brainstorm --auto Notes can be edited.`
plugins: builder 5.0.0

- **/builder:brainstorm** — 48s, 19 turns, Bash 8
  - longest waits: 6s after Bash git add README.md src/cli.mjs test/cli.test.mjs && git commit -qm "feat(notes-ed · 5s after Bash cat > .builder/notes-edit/brainstorm.md <<'EOF' · 4s after Bash W=$(/Users/lukekeith/www/builder/scripts/workspace notes-edit) && echo $W && cat · 4s after Bash F=/Users/lukekeith/.claude-home/projects/-private-var-folders-m9-828j21md44g2gxs · 3s after Bash python3 - <<'EOF'

git log main:

```
a68a203 Merge branch 'feat/notes-edit'
e1af774 feat(notes-edit): add notes edit <id> <text>
b8310d1 fixture
```
