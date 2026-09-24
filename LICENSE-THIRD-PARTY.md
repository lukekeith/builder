# Third-party material vendored into this plugin

`/builder:*` ships dependency-free: everything it needs is in this directory. Part of what it needs
was written by someone else, and this file says what, and under what terms.

## superpowers — MIT

The execution engine and the plan format are adapted from the **superpowers** plugin's
`subagent-driven-development`, `writing-plans` and `requesting-code-review` skills, tested against
version **6.3.0**.

| Vendored here | Adapted from |
|---|---|
| `skills/build/EXECUTION.md` | `subagent-driven-development/SKILL.md` |
| `skills/build/prompts/implementer.md` | `subagent-driven-development/implementer-prompt.md` |
| `skills/build/prompts/task-reviewer.md` | `subagent-driven-development/task-reviewer-prompt.md` |
| `skills/build/prompts/re-review.md` | `subagent-driven-development/re-review-prompt.md` |
| `skills/build/prompts/final-reviewer.md` | `requesting-code-review/code-reviewer.md` |
| `skills/plan/PLAN-FORMAT.md` | `writing-plans/SKILL.md` |
| `scripts/task-brief` | `subagent-driven-development/scripts/task-brief` |
| `scripts/review-package` | `subagent-driven-development/scripts/review-package` |
| `skills/test-driven-development/` | `test-driven-development/` (SKILL.md + writing-good-tests.md) |
| `skills/systematic-debugging/` | `systematic-debugging/` (SKILL.md + root-cause-tracing.md + defense-in-depth.md + condition-based-waiting.md + its example + find-polluter.sh) |
| `skills/receiving-code-review/` | `receiving-code-review/SKILL.md` |
| `skills/verification-before-completion/` | `verification-before-completion/SKILL.md` |

The four craft skills are vendored **essentially verbatim** — their rules are upstream's and are not
this plugin's to improve. Three edits only: an attribution line under each title, cross-references
repointed from `superpowers:<name>` to the vendored sibling, and — for `systematic-debugging` — four
files left behind (`test-pressure-1..3.md`, `test-academic.md`, `CREATION-LOG.md`) because they are
artifacts of how that skill was authored and validated, not things a debugging session reads.

**What the adaptation changed**, so a reader of the original is not surprised:

- **The worktree step is gone.** This family never creates a branch or a worktree — those belong to
  the developer — so the guard it carried ("never implement on the base branch") is restated
  explicitly instead of inherited.
- **The workspace is keyed on the FEATURE, not the plan file.** Every feature's plan is `PLAN.md`,
  so upstream's plan-basename naming would put every feature in one directory. `task-brief` and
  `review-package` therefore take a required explicit outfile, and `sdd-workspace` is replaced by
  `scripts/workspace`.
- **The execution-choice prompt is gone.** Upstream's plan skill ends by asking "subagent-driven or
  inline?"; here the engine is always `/builder:build`, and the pipeline's go-ahead is the one
  approval it takes.
- **The finish handoff is gone.** Upstream ends at `finishing-a-development-branch`; here the human
  walk and the PR lock own what happens after the last phase.
- **One app per phase, and the per-app gates** are additions — they have no upstream equivalent.
- **`brainstorming` is not vendored.** It was reachable only as a one-line handoff for feasibility
  spikes; `/builder:brainstorm` now says plainly that a spike is not a build and stops.

**What was left behind, and why none of it is a rule.** Every behavioural rule in the four source
documents is carried here — verified line by line against superpowers 6.3.0. What is not carried:

| Not carried | What it was |
|---|---|
| SDD §When to Use | a decision tree choosing between `subagent-driven-development` and `executing-plans`. Here the engine is always `/builder:build`, so the choice does not exist |
| SDD §The Process | a graphviz rendering of the loop this file states in prose |
| SDD §Example Workflow | an illustrative transcript |
| `writing-plans` §Execution Handoff | the "subagent-driven or inline?" question, already answered |
| `code-reviewer` §Example Output | an illustrative sample report |
| `writing-plans/plan-document-reviewer-prompt.md` | an orphan upstream: no skill in superpowers 6.3.0 references it, and `writing-plans` §Self-Review explicitly says the plan check is a checklist you run yourself, not a subagent dispatch |

## The superpowers skills deliberately NOT vendored

Not an oversight in any case — each either duplicates something this pipeline already does or
contradicts one of its rules:

| Skill | Why not |
|---|---|
| `requesting-code-review` | its reachable part, `code-reviewer.md`, **is** vendored as `prompts/final-reviewer.md`. Its SKILL.md decides *when* to request a review; here the pipeline's structure decides that |
| `executing-plans` | an alternative execution engine. Here the engine is always `/builder:build`, so offering a second one would mean two answers to a settled question |
| `using-git-worktrees` | 🔴 **contradicts a rule.** This family never creates a branch or a worktree — those belong to the developer |
| `finishing-a-development-branch` | 🔴 **contradicts a rule.** Replaced by the human walk, the sign-off and the PR lock, which are stricter: nothing moves toward a PR until a human has exercised the feature and said so |
| `dispatching-parallel-agents` | 🔴 **contradicts a rule.** It encourages parallel dispatch of independent tasks; this engine forbids parallel *implementers* (conflicts) and parallelizes only read-only sweeps, under REFERENCE §Agent model tiering |
| `brainstorming` | `/builder:brainstorm` is this pipeline's design conversation, with sizing, per-app recon and the §Apps/§Contract grill. A second brainstorming skill would compete with it for the same trigger |
| `writing-skills` | about authoring skills. Not this pipeline's domain |
| `using-superpowers` | a meta-skill about discovering skills inside superpowers; meaningless once the needed parts are vendored here |

A repo that wants any of these can install superpowers alongside — nothing in `/builder:*` conflicts
with having it, and the two `contradicts a rule` entries are about what this pipeline *tells an agent
to do*, not about what else may be installed.

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
