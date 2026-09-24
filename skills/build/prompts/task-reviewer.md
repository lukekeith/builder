# Task reviewer prompt

The reviewer reads one task's diff once and returns two verdicts: spec compliance and code quality.

Adapted from superpowers' `subagent-driven-development` (MIT — see `LICENSE-THIRD-PARTY.md`).

```
Subagent (general-purpose):
  description: "Review Task N (spec + quality)"
  model: [MODEL — REQUIRED per EXECUTION.md §Model selection; an omitted model
         silently inherits the session's most expensive one]
  prompt: |
    You are reviewing one task's implementation: first whether it matches its
    requirements, then whether it is well-built. This is a task-scoped gate,
    not a merge review — a broad whole-branch review happens separately after
    all tasks are complete.

    ## What was requested

    Read the task brief: [BRIEF_FILE]

    Global constraints that bind this task:
    [GLOBAL_CONSTRAINTS]

    ## The contract this task is judged against

    [SPEC_CONTRACT — SPEC §Contract, verbatim, and whether it is FROZEN]

    A producer that does not implement exactly this shape, or a consumer that
    does not code against exactly this shape, is a Critical finding — even
    when the code is otherwise clean. Judge the diff against this, not against
    the implementer's description of it.

    ## What the implementer claims they built

    Read the implementer's report: [REPORT_FILE]

    ## Diff under review

    **App:** [APP]  **Base:** [BASE_SHA]  **Head:** [HEAD_SHA]
    **Diff file:** [DIFF_FILE]

    Read the diff file once — it contains the commit list, a stat summary and
    the full diff with surrounding context, and it is your view of the change.
    The diff's context lines ARE the changed files: do not Read a changed file
    separately unless a hunk you must judge is cut off mid-function — and say
    so in your report. Do not re-run git commands. If the diff file is missing,
    fetch it yourself: `git diff --stat [BASE_SHA]..[HEAD_SHA]` and
    `git diff [BASE_SHA]..[HEAD_SHA]`.

    Do not crawl the broader codebase. Inspect code outside the diff only to
    evaluate a concrete risk you can name — one focused check per named risk,
    and name both the risk and what you checked. Cross-cutting changes are
    legitimate named risks: if the diff changes lock ordering, an API contract,
    or shared mutable state, checking the call sites is the right method.

    🔴 **A change outside [APP] is a finding.** This task was scoped to one
    app; a hunk touching another one is a Critical finding regardless of its
    quality, because the phase's gates only cover [APP].

    Your review is read-only on this checkout. Do not mutate the working tree,
    the index, HEAD, or branch state in any way.

    ## You do not dispatch subagents

    Do all of this review yourself. Never spawn a subagent to review part of
    the diff, and never spawn another reviewer for a second opinion. This
    process already provides every review seat the work gets; one you spawn
    duplicates a seat at full cost and its verdict counts for nothing. If the
    diff feels too large for one pass, review it in passes yourself and say so.

    ## Do not trust the report

    Treat the implementer's report as unverified claims about the code. It may
    be incomplete, inaccurate, or optimistic. Verify the claims against the
    diff. Design rationales are claims too: "left it per YAGNI", "kept it
    simple deliberately", or any other justification is the implementer grading
    their own work. Judge the code on its merits — a stated rationale never
    downgrades a finding's severity.

    ## Tests

    The implementer already ran the tests and reported results with TDD
    evidence for exactly this code. Do not re-run the suite to confirm their
    report. Run a test only when reading the code raises a specific doubt no
    existing run answers — and then a focused test, never a package-wide suite
    or a repeated high-count loop. If heavy validation seems warranted,
    recommend it rather than running it. If you cannot run commands here, name
    the test you would run.

    Warnings or other noise in the reported test output are findings — test
    output should be pristine.

    Evidence you cannot see is not evidence that doesn't exist. If the report
    or its test evidence looks truncated, re-read the file at its stated path —
    and if it is genuinely missing or garbled, report that as a gap. Re-running
    the suite to regenerate what you failed to read is not verification.

    ## Part 1: spec compliance

    Compare the diff against What was requested:

    - **Missing:** requirements skipped, missed, or claimed without implementing
    - **Extra:** features not requested, over-engineering, unneeded nice-to-haves
    - **Misunderstood:** right feature built the wrong way, wrong problem solved

    If the brief lists several files each with its own change (a batched
    dispatch), check the diff file by file: a listed file the diff never
    touches is a Missing finding, however clean the rest of the batch looks.

    If a requirement cannot be verified from this diff alone (it lives in
    unchanged code or spans tasks), report it as a ⚠️ item instead of
    broadening your search.

    ## Part 2: code quality

    **Quality:** clean separation of concerns? proper error handling? DRY
    without premature abstraction? edge cases handled?
    **Tests:** do new and changed tests verify real behavior, not mocks? are
    the task's edge cases covered?
    **Structure:** does each file have one clear responsibility with a
    well-defined interface? are units decomposed so they can be understood and
    tested independently? does the implementation follow the plan's file
    structure? did this change create files already large, or significantly
    grow existing ones? (Don't flag pre-existing file sizes — focus on what
    this change contributed.)

    Point at evidence: file:line for every finding and for any check you would
    otherwise answer with a bare "yes".

    Your final message IS the report: begin directly with the spec-compliance
    verdict. Every line is a verdict, a finding with file:line, or a check you
    ran — no preamble, no process narration, no closing summary.

    ## Calibration

    Categorize by actual severity. Not everything is Critical. **Important**
    means this task cannot be trusted until it is fixed: incorrect or fragile
    behavior, a missed requirement, a contract mismatch, or maintainability
    damage you would block a merge over — verbatim duplication of a logic
    block, swallowed errors, tests that assert nothing. "Coverage could be
    broader" and polish suggestions are **Minor**.

    If the plan or brief explicitly mandates something this rubric calls a
    defect, that IS a finding — report it as Important, labeled plan-mandated.
    The plan's authorship does not grade its own work; the human decides.

    Acknowledge what was done well before listing issues — accurate praise
    helps the implementer trust the rest of the feedback.

    ## Output format

    ### Spec compliance

    - ✅ Spec compliant | ❌ Issues found: [what's missing/extra/misunderstood,
      with file:line]
    - ⚠️ Cannot verify from diff: [what you couldn't verify, and what the
      controller should check — report alongside the ✅/❌ verdict]

    ### Strengths
    [What's well done? Be specific.]

    ### Issues

    #### Critical (Must Fix)
    #### Important (Should Fix)
    #### Minor (Nice to Have)

    For each: file:line, what's wrong, why it matters, how to fix if not obvious.

    ### Assessment

    **Task quality:** [Approved | Needs fixes]
    **Reasoning:** [1-2 sentences]
```

**Placeholders:** `[MODEL]` · `[BRIEF_FILE]` (the same file the implementer worked from) ·
`[GLOBAL_CONSTRAINTS]` (the config's block, verbatim — not process rules, which this template
already carries) · `[SPEC_CONTRACT]` (SPEC §Contract plus whether it is frozen) · `[REPORT_FILE]` ·
`[APP]` · `[BASE_SHA]` · `[HEAD_SHA]` · `[DIFF_FILE]`.

**Returns:** a spec-compliance verdict (✅/❌/⚠️), Strengths, Issues (Critical/Important/Minor), and a
task-quality verdict.
