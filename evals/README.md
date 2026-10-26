# evals — what builder does, not what its skills say

Behaviour evals for the moments a user touches most, run with Claude Code's own harness
(`claude plugin eval`, https://code.claude.com/docs/en/plugin-evals). Each case starts from the
benchmark's `notes` fixture (`_fixture/notes.sh`, run by each case's `scaffold.sh`) and checks one
first turn: a plain request reaches brainstorm, a small change gets the quick path, a bigger one is
grounded in the code before any question, help answers in a line, status says when nothing is in
flight.

```bash
claude plugin eval . --scaffold --allow-tools Bash --trust-plugin --threshold 0.8
```

`--scaffold` runs the cases' own `scaffold.sh` (they copy the fixture and `git init`; written here,
read them before running). Each case runs 3 times with the plugin and 3 without (the baseline arm),
so `Δ` is what builder adds. A run costs real model calls — about a dollar a case — so it is a
release check, not CI. Results land in `evals/results/` (git-ignored).

## Last run — 2026-10-26, builder 5.0.0, 3 runs per arm

| Case | With builder | Without | What builder adds |
|---|---|---|---|
| trigger-plain-request | 1.00 | brainstorm never runs | a plain request reaches `/builder:brainstorm` |
| quick-path-first-turn | 0.89 | 0.67 | the small change proposed in the first turn, built on one yes |
| md-first-turn | 1.00 | 0.83 | grounded in the code, a recommended way on |
| help-which-command | 1.00 | 0.00 | a two-line answer — this case found the card being dumped for a question (fixed in 5.0.0) |
| status-nothing-in-flight | 0.83 | 0.50 | "nothing in progress", and how to start |

Agent and judge cost for the run: about $6.
