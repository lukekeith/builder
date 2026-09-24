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
