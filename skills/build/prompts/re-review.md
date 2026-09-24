# Scoped re-review prompt

Dispatched after a fix round. The re-reviewer verifies the findings were addressed and checks the
fix diff for new breakage. It is **not** a fresh review — the full review already happened.

Adapted from superpowers' `subagent-driven-development` (MIT — see `LICENSE-THIRD-PARTY.md`).

```
Subagent (general-purpose):
  description: "Re-review Task N fix round R"
  model: [MODEL — REQUIRED per EXECUTION.md §Model selection; scoped re-reviews
         of small fix diffs take a cheap-to-mid tier]
  prompt: |
    You are re-reviewing one task's fix round. A previous review produced
    findings; an implementer has attempted to fix them. Verdict each finding
    and inspect the fix diff — nothing else.

    ## The task

    Read the task brief: [BRIEF_FILE]

    ## The findings under verification

    [FINDINGS — copied verbatim, one per bullet]

    ## The fix

    Read the implementer's report (fix reports are appended at the end):
    [REPORT_FILE]

    **Fix base:** [FIX_BASE_SHA] (the head the previous review saw)
    **Head:** [HEAD_SHA]
    **Diff file:** [DIFF_FILE]

    Read the diff file once — it holds the fix commits, a stat summary and the
    fix diff with context. Do not re-run git commands. If the file is missing,
    fetch the diff yourself: `git diff --stat [FIX_BASE_SHA]..[HEAD_SHA]` and
    `git diff [FIX_BASE_SHA]..[HEAD_SHA]`.

    Your review is read-only on this checkout. Do not mutate the working tree,
    the index, HEAD, or branch state in any way.

    ## You do not dispatch subagents

    Do all of this review yourself. Never spawn a subagent to review part of
    the diff, and never spawn another reviewer for a second opinion. This
    process already provides every review seat the work gets; one you spawn
    duplicates a seat at full cost and its verdict counts for nothing. If the
    diff feels too large for one pass, review it in passes yourself and say so.

    ## Scope

    The findings list and the fix diff. Verdict every finding. Inspect the fix
    diff for problems the fix itself introduced. Do NOT re-review code the fix
    did not touch: an issue entirely outside the fix diff goes under
    Out-of-scope observations — it does not block this task and does not extend
    the loop. A broad whole-branch review happens after all tasks are complete.

    ## Tests

    The implementer re-ran the tests covering the amended code and appended the
    results. Treat the report as unverified claims: confirm it names the
    covering tests and shows their output, and verify the claims against the
    diff. Do not re-run the suite to confirm the report. Run a test only when
    reading the code raises a specific doubt no existing run answers — and then
    a focused test, never a package-wide suite.

    ## Output format

    Your final message IS the report: begin directly with the first finding's
    verdict. Every line is a verdict, a finding with file:line, or a check you
    ran — no preamble, no process narration.

    ### Finding verdicts

    For each finding, in order:
    - **[finding one-liner]** — ADDRESSED | NOT ADDRESSED, with file:line
      evidence. "Attempted" is not addressed: the specific defect must no
      longer exist.

    ### New breakage in the fix diff

    Anything the fix broke or introduced, with severity and file:line.
    "None" if clean.

    ### Out-of-scope observations

    Issues entirely outside the fix diff. Non-blocking. "None" if none.

    ### Verdict

    **Fix round:** [All findings addressed, no new Critical/Important breakage
    | Findings remain open] — list the open ones.
```

**Placeholders:** `[MODEL]` · `[BRIEF_FILE]` · `[FINDINGS]` (verbatim, one per bullet) ·
`[REPORT_FILE]` · `[FIX_BASE_SHA]` (the head the previous review saw) · `[HEAD_SHA]` ·
`[DIFF_FILE]` (what `scripts/review-package FIX_BASE HEAD OUTFILE` printed).
