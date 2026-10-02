# Faster agent-mode verify — design

> 2026-10-02 · builder 4.6.0 · status: design, awaiting review

## Why

A fleet feature spends most of its time checking work that is already written, not writing it. On
d2m's icon-draw — the cleanest recent run, audited → merged in 2h18m — the phase-close gates, the
agent walk and verify took about 1h25m of it, and verify alone 34m. Its log shows where verify's time
went, and none of it was new evidence:

- **The deep set re-ran when it should have been quoted.** It had passed during the build at
  `d8dddbe`; the only commits since touched the feature's own docs (MANIFEST, SPEC, PLAN), which the
  gate's inputs hash already excludes. It re-ran because d2m tracks `test-results/.last-run.json`,
  Playwright rewrites it on every run, and `gate.mjs` never quotes on a dirty tree (`gate.mjs:137`)
  — silently, so nobody saw why.
- **Verify wrote and debugged its own live E2E script** (checklist item 10) against the same running
  app the agent walk had driven minutes earlier. Its first attempt timed out on a locator and the run
  went digging. The largest single cost.
- **It investigated 7 browser-test failures that already fail on main** — counted green by the gate
  (`7 = baseline 7`) — by hunting through baseline files.

**Success:** an agent-run md feature reaches merged about 15–25 minutes sooner, with every guarantee
the pipeline gives today still evidenced. Human-walked features keep exactly today's verify. And we
can see the time per run, so the next change is measured rather than guessed.

## Scope

Four changes. Nothing here changes a config key's meaning, a manifest field or a record format; old
folders and configs read as before.

### 1. Gate reuse that actually happens

- **`gate.mjs` names what made the tree dirty.** When a set is not quoted because of uncommitted
  changes, it prints the paths — `not quoted — uncommitted: test-results/.last-run.json` — up to five,
  then `+N more`. Same on the "result not memoised" line. `isDirty` keeps its meaning; a new
  `dirtyPaths(root)` in `gates-core.mjs` returns the list (`git status --porcelain
  --untracked-files=no`).
- **`/builder:init` (recon and `--update`) warns about tracked test output.** Recon lists tracked
  paths matching known test-artifact patterns — `test-results/`, `playwright-report/`, `coverage/`,
  `.nyc_output/`, `junit*.xml` — and reports them with the fix (`git rm -r --cached <path>` and a
  `.gitignore` line). It never untracks anything itself.
- **d2m, separately:** untrack `test-results/` and ignore it — one commit in d2m, made only with the
  owner's go-ahead, outside this release.

### 2. The agent walk covers verify's cross-app E2E walk (agent mode only)

- **Under `--agent-walk`, the build appends the cross-app walk to `walk.md`.** After the per-app
  sections (build step 4), a section `## Cross-app (verify E2E)` with SPEC §Testing's walk script as
  numbered steps `E1…En`, each with what to do and what to see. Without `--agent-walk`, `walk.md` is
  unchanged.
- **The agent walk works the `E` steps like any item** — the same driver, the same live session, one
  report row each with evidence. They count toward AGENT-PASS like every other item: an `E` step that
  fails is a fix like any other.
- **Verify item 10, in agent mode,** before driving anything: read the latest agent-walk round's
  `report.md`. When every `E` step is `PASS` with evidence, and the code has not changed since the
  round's sha — `git diff --quiet <round sha> HEAD -- . ':!<registry>'` — item 10 is **covered by the
  agent walk**: cite the report path and the sha, mark it quoted (verify's existing rule for quoted
  evidence). Any `E` step missing, not `PASS`, or whose code changed → run **only those steps** live,
  as today. A `walk.md` with no `E` section (a feature built before this release) → item 10 as today.
- **Human-walked features are untouched**: verify still runs its own live E2E after a human walk —
  the human walk is per-app and was never the cross-app check.
- **A re-verify** keeps its existing scoping rules; the agent-walk report is quoted only on the code
  sha it ran against.

### 3. Pre-existing failures are not verify's to investigate

Verify gains one rule beside item 3: a gate line at or under its baseline (`→ 7 (baseline 7)`) is
green. Report the count against baseline in one line and move on; open a failure's log only when the
set is red — more failures than baseline — and then only the failures above it. The same sentence
goes into the agent-walk dispatch for any gate it runs.

### 4. Time per run, measured

- **`runClaude` reads Claude's `result` event** from the stream it already writes to
  `<feature>-NN.jsonl`, and records `{ n, lane, ms, turns }` on the feature in `fleet.json`
  (`fleet.features[f].timing`, appended per run). A run killed by the timeout records its wall-clock
  time and `turns: null`.
- **`archiveRow` carries it** into `archive.jsonl`: `timing` (the per-run list) and `lanes` — total
  ms per lane.
- **`/builder:fleet --status`** adds a `Time` column (sum so far, e.g. `1h12m`) and, for the archived
  line, the mean of the last five landed features per lane.

## Testing

- `gates-core.test.mjs`: `dirtyPaths` lists modified tracked files and ignores untracked ones.
- `gate` CLI test: a dirty tree prints `not quoted — uncommitted: <path>`.
- `fleet.test.mjs`: the stub claude emits a `result` event with `duration_ms`/`num_turns`; the
  archive row carries `timing` and `lanes`; a timed-out run records `turns: null`.
- `fleet-core.test.mjs`: `renderStatus` shows the Time column.
- Skill text (build step 4, agent-walk, verify item 10 and §3's rule, init recon): the existing
  `skills-consistency` test, plus a check that verify and agent-walk name the `E` section the same
  way the build writes it.

## Out of scope

- Running verify concurrently with the agent walk: they share the walk env's app and database, and
  once item 10 is covered by the walk there is little left to overlap.
- Parallel tasks within a phase, and model-tier changes — separate decisions.
- Storing failing test names in the baseline — the count rule in §3 is enough for verify.

## Release

**4.6.0** (minor): time tracking is a new capability. No consumer action; d2m's untracking is a
separate commit in d2m.
