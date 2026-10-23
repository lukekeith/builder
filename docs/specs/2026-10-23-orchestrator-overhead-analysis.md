# Where builder's orchestrator time goes — bench 2026-10-23-1336-tags

Source: the raw stream-json transcripts in `bench/results/2026-10-23-1336-tags/{builder,builder-everything}/`
(builder 4.12.0, orchestrator on claude-opus-5-5). Skill file sizes were measured at repo HEAD `921680e` (4.12.1).
Read-only analysis. The scripts are in `/Users/lukekeith/.claude-home/jobs/7b4bbb7c/tmp/an/`.

**How it was measured.** A *model call* is one API response: a unique `message.id` on the top-level thread
(`parent_tool_use_id == null`). Its **latency** is the time from the event before it (a tool_result or the
skill text) to the timestamp of its last content block, which is when generation ends. Tool time and
agent time are tool_use → tool_result. Per-call output tokens come from each call's visible characters
(text plus tool_use input), scaled to the session's `result.usage.output_tokens`, plus the per-call
`thinking_tokens` estimate. The per-block `usage.output_tokens` snapshots in the stream are partial, so
they can't be used directly. Summed per config, this reproduces the report: 603 s of orchestrator time
for builder and 546 s for builder-everything.

---

## 1. The headline: time is output tokens plus a fixed cost per call. Context size barely matters.

A regression over all 142 orchestrator calls in both configs:

```
latency ≈ 2.4 s per call  +  7.5 ms per output token (≈133 tok/s)        R² = 0.97
adding input terms: +0.008 s per 1k cache-read tokens, ≈0 per 1k cache-created tokens
```

- **Input and context size are not a time driver.** At a 117k-token context (the build step's average
  per call) the read costs about 1 s. Re-loading a 60 KB REFERENCE.md mostly costs money (cache reads),
  not seconds. It costs seconds only when it adds calls: grepping for headings, then `sed`-ing a range,
  then paging again.
- **For builder, 603 s = about 162 s of fixed cost (68 calls × 2.4 s) + about 440 s of generating
  ≈ 54.6k output tokens.** About 7.6k of those tokens are thinking (≈57 s). The rest is text the model
  types: documents, Agent prompts, heredocs and closing reports.
- So there are two levers: **type less** (deterministic content → scripts, shorter closing reports,
  leaner documents) and **make fewer calls** (bundle reads, merge bookkeeping into one script call).

(The report's "79 turns" is `result.num_turns`. Below, "calls" means distinct API responses: 68 for
builder, 77 for builder-everything.)

---

## 2. Per step

Model s is orchestrator time (time not inside any tool). Fixed s is calls × 2.4 s. Out tok is visible
output only; think is the thinking estimate. Cache read/call is the average context per call. Cache new
is tokens newly written to cache, mostly the injected SKILL.md plus tool results.

### builder

| Session | Step | Calls | Model s | Agents s | Fixed s | Out tok | Think | s/call | Cache read/call | Cache new | Three longest calls (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| brainstorm | /builder:brainstorm | 6 | 54 | 0 | 14 | 4.4k | 0.9k | 9.1 | 44k | 48k | 34.8, 9.2, 3.4 |
| brainstorm | builder:spec | 5 | 89 | 0 | 12 | 9.2k | 0.7k | 17.8 | 68k | 19k | 63.3, 10.7, 8.6 |
| fleet-01 | resume (start) | 3 | 8 | 0 | 7 | 0.3k | 0.2k | 2.8 | 36k | 38k | 4.3, 3.0, 1.1 |
| fleet-01 | builder:audit | 7 | 44 | 0 | 17 | 2.1k | 1.0k | 6.3 | 61k | 18k | 12.9, 11.4, 6.1 |
| fleet-01 | builder:plan | 6 | 93 | 0 | 14 | 8.3k | 2.7k | 15.6 | 83k | 24k | 65.1, 9.8, 6.4 |
| fleet-01 | builder:build | 17 | 162 | 147 | 41 | 12.9k | 1.5k | 9.5 | 117k | 40k | 17.0, 16.3, 15.2 |
| fleet-02 | resume (start) | 7 | 26 | 0 | 17 | 1.3k | 0.6k | 3.7 | 47k | 45k | 5.9, 4.7, 4.1 |
| fleet-02 | builder:agent-walk | 7 | 53 | 53 | 17 | 3.0k | 0.2k | 7.6 | 65k | 12k | 14.2, 14.0, 6.1 |
| fleet-02 | builder:verify | 7 | 46 | 0 | 17 | 1.8k | 1.4k | 6.6 | 81k | 17k | 10.4, 7.7, 7.5 |
| fleet-02 | builder:ship | 3 | 27 | 0 | 7 | 2.1k | 0.0k | 8.9 | 90k | 5k | 12.7, 8.8, 5.2 |

### builder-everything

| Session | Step | Calls | Model s | Agents s | Fixed s | Out tok | Think | s/call | Three longest calls (s) |
|---|---|---|---|---|---|---|---|---|---|
| brainstorm | /builder:brainstorm | 8 | 53 | 0 | 19 | 4.4k | 0.4k | 6.6 | 32.3, 9.6, 2.6 |
| brainstorm | builder:spec | 7 | 82 | 0 | 17 | 9.1k | 0.5k | 11.8 | 54.6, 9.2, 6.6 |
| fleet-01 | resume (start) | 3 | 7 | 0 | 7 | 0.2k | 0.2k | 2.3 | 3.2, 3.1, 0.6 |
| fleet-01 | builder:audit | 4 | 34 | 0 | 10 | 1.9k | 1.2k | 8.6 | 14.6, 13.9, 2.9 |
| fleet-01 | builder:plan | 6 | 78 | 0 | 14 | 7.9k | 1.1k | 13.0 | 52.7, 10.8, 6.8 |
| fleet-01 | builder:build | 21 | 176 | 215 | 50 | 15.0k | 1.4k | 8.4 | 16.6, 14.8, 13.8 |
| fleet-02 | resume (start) | 8 | 26 | 0 | 19 | 1.3k | 0.6k | 3.3 | 5.2, 4.6, 4.0 |
| fleet-02 | builder:agent-walk | 6 | 34 | 48 | 14 | 2.7k | 0.4k | 5.7 | 12.4, 7.7, 3.6 |
| fleet-02 | builder:verify | 7 | 32 | 0 | 17 | 1.7k | 1.2k | 4.6 | 6.3, 5.8, 5.2 |
| fleet-02 | builder:ship | 4 | 24 | 0 | 10 | 1.9k | 0.4k | 5.9 | 10.1, 6.0, 4.2 |

### What each step's waits are (builder)

The waits are the gaps between a tool_result and the next model call.

- **brainstorm (54 s).** Four quick recon calls of 1–9 s: CONVERSATION.md plus the repo, REFERENCE
  headings, the REFERENCE §classifier lines, then a repo grep. Then **one 34.8 s call that types
  brainstorm.md** (9.1k chars, about 3.9k tokens), and a 3.4 s Skill handoff.
- **spec (89 s).** A 2.2 s call that `sed`s REFERENCE lines 252–560 (17 KB), a 4.3 s mkdir/rev-parse
  call, then **one 63.3 s call that types SPEC.md (16.7k chars, 187 lines) and MANIFEST.md**. After that:
  an 8.6 s `sed` fix after check-obligations, and a **10.7 s closing report (2.7k chars)**.
- **resume, build lane (8 s).** It reads the config and manifest and appends `agent-walk:`. This is
  cheap because the 43 KB resume SKILL.md is already the session prompt.
- **audit (44 s).** It cats SPEC and the source (3.0 and 3.9 s calls), and a 12.9 s call (≈800 thinking
  tokens) runs check-obligations and npm test. Then 11.4 s and 6.1 s Python heredocs fix SPEC footnotes
  (real audit work), and a 3.7 s manifest `sed` plus commit.
- **plan (93 s).** It cats PLAN-FORMAT.md and greps REFERENCE, then **one 65.1 s call: 2.25k thinking
  tokens plus PLAN.md (13.2k chars, 341 lines, full code and tests for three tasks)**. After that: a
  9.8 s call that runs the plan's code in a scratch copy (17/17 pass), 6.4 s to append the §Plan index
  to SPEC by heredoc, and 3.6 s for the go-ahead `sed` plus commit.
- **build (162 s orchestrator, 147 s agents).** It reads EXECUTION.md plus implementer.md twice. The
  first read died on zsh's `echo ======` (see §5), so it took one extra call. Then **16.3 s to type the
  ledger** (pre-flight conflict table, three `task-brief` script runs, and a Python heredoc appending
  SPEC sections to each brief). After that come **six Agent dispatch calls of 12.6–17.0 s each: three
  implementers, the final review, the fix wave, and later the walk**. Each one types a 2.4–2.7k-char
  prompt, about 70% of it fixed template. Between them: test and git checks of 3–4 s, a 6.8 s
  contract-freeze `sed` plus commit, an 11.9 s Python SPEC F4 correction, and **15.1 s to type walk.md**
  (2.9k chars, largely SPEC §Testing restated) plus a manifest edit plus commit. It ends with a
  **12.1 s closing report (2.5k chars)**.
- **resume, walk lane (26 s, 7 calls).** It re-derives state: the config and manifest, REFERENCE
  headings, REFERENCE lines 735–806, build SKILL.md lines 270–312 plus walk.md, a hand-run CLI readiness
  pass, and the manifest `built` edit plus commit.
- **agent-walk (53 s orchestrator, 53 s agent).** A 4.3 s profile call, a **14.0 s dispatch (2.4k
  chars)**, report checks, a SPEC heading grep, and **a 14.2 s hand-written `node -e` that condenses
  SPEC** (the sign-off). Then list-features.
- **verify (46 s).** Gates through job.mjs (7.5 and 6.9 s), source and diff reads for spec parity
  (10.4 and 6.4 s, ≈700 thinking tokens), the READY `sed` plus commit (7.7 s), and a merge of main.
- **ship (27 s).** An archive check plus SPEC header Python plus workspace removal (8.8 s), `git mv`
  plus commit (5.2 s), and a **12.7 s closing report (2.8k chars)**.

---

## 3. What the orchestrator read into context

**Injected automatically on each Skill call** (once per step, as cache writes):

| File | Size | Loaded |
|---|---|---|
| resume/SKILL.md | 43.4 KB / 526 lines | session prompt of both fleet sessions (2×) |
| brainstorm/SKILL.md | 23.8 KB | brainstorm session prompt |
| build/SKILL.md | 27.9 KB / 380 lines | build |
| plan/SKILL.md | 23.9 KB / 340 lines | plan |
| verify/SKILL.md | 17.9 KB | verify |
| audit/SKILL.md | 14.9 KB | audit |
| agent-walk/SKILL.md | 10.7 KB | agent-walk |
| spec/SKILL.md | 10.3 KB | spec |
| ship/SKILL.md | 9.2 KB | ship |

**Read by hand through Bash cat/sed/grep** (both configs, both counted):

| File (size) | Reads | Where |
|---|---|---|
| resume/REFERENCE.md (60.3 KB, 865 lines) | builder 5, everything 5 | brainstorm: heading grep, then §classifier `sed 94,134`. spec: `sed 252,560` (17 KB; everything used two ranges, 15 KB). plan: `grep Companion` (builder). walk-lane resume: heading grep, then `sed 735,806` (plus `668,720` in everything). Never read whole; **the heading grep is re-run in 3 of the 3 sessions**. |
| build/EXECUTION.md (20.4 KB) | builder 2, everything 3 | build: the whole file, then ranges, because the first read failed on the zsh separator |
| build/prompts/implementer.md (8.8 KB) | builder 2, everything 3 | build: the same call chain |
| build/prompts/task-reviewer.md (8.4 KB) | everything 3 | build |
| brainstorm/CONVERSATION.md (23.3 KB) | builder 1, everything 4 | everything paged it at lines 60–200, 200–260 and 260–300 after the first cat failed |
| plan/PLAN-FORMAT.md (8.0 KB) | 1 each | plan |
| build/prompts/final-reviewer.md (5.2 KB) | 1 each | build |
| build/SKILL.md walk section (lines 270–312) | builder 1 | walk-lane resume (re-reading a skill loaded in the other session) |
| ship/SKILL.md §At sign-off | 1 each | agent-walk, to learn how to condense |
| .claude/builder.md (1.6 KB) | 3 each | start of every session |
| MANIFEST.md | 2 cats per run, plus greps | each fleet session start |
| SPEC.md (about 17 KB) | full cat in audit; sections in verify, agent-walk and walk-lane resume | |
| src/cli.mjs and the tests | brainstorm, audit and verify (3×) | |

Hand-reading docs took **10 calls and 33.5 s for builder, and 13 calls and 31.4 s for
builder-everything.** Most of that is per-call cost, not reading cost.

---

## 4. Bookkeeping and hand-written content

### Bookkeeping operations (builder)

| Step | Manifest edits | Git commits | Ledger writes | `workspace` calls | Other |
|---|---|---|---|---|---|
| spec | (written) | 1 | – | – | – |
| fleet-01 start | 1 | – | – | – | – |
| audit | 1 | 1 | – | – | 2 SPEC Python edits |
| plan | 1 | 1 | – | – | SPEC §Plan appended by heredoc |
| build | 2 | 2 | 6 | 9 | `task-brief` ×3 (already scripted), review-package, 1 SPEC Python edit |
| fleet-02 start | 1 | 1 | – | 1 | – |
| agent-walk | 1 | 1 | – | – | SPEC condensed by `node -e` |
| verify | 1 | 1 | 1 | 1 | merge main |
| ship | 1 | 1 | – | 1 | SPEC header by Python, `git mv` |

That is 10 orchestrator commits on the branch. Of the 16 commits on main, 9 are `chore`/`docs`
bookkeeping commits.

In time: the calls whose main act is manifest/SPEC/git bookkeeping took **13 calls, 75.8 s and 5.1k
tokens**. Ledger calls took 2 calls and 20.6 s, and hand-written SPEC edit scripts took 3 calls and
29.4 s (one is real audit work, one a revise). That is **about 126 s in all for builder, 21% of
orchestrator time.** builder-everything: 128 s, with 8 ledger calls, because review=slice adds a
review-package call plus a ledger line per task.

Task briefs are **already scripted** (`scripts/task-brief`, one loop for all three). What is still
typed by hand is the **Agent prompt for each dispatch**, the **ledger's pre-flight table**, the SPEC
section splice into briefs (a Python heredoc), **walk.md**, the **§Plan index**, the **sign-off
condense**, and every **manifest `sed` plus commit message**.

### Long hand-written content, by output tokens (builder)

| Artifact | Chars | ≈ Tokens (incl. thinking in that call) | Call time |
|---|---|---|---|
| PLAN.md (341 lines, full code) | 13,157 | 8.8k (2.25k thinking) | 65.1 s |
| SPEC.md + MANIFEST.md | 16,750 + 220 | 7.5k | 63.3 s |
| brainstorm.md | 9,056 | 4.1k | 34.8 s |
| 6 Agent prompts (sum) | 14,212 | 8.0k | 85.5 s |
| 3 closing reports (sum) | 8,000 | 4.1k | 35.5 s |
| walk.md + ledger + manifest | 2,857 | 1.7k | 15.1 s |
| ledger + brief splice | 2,507 | 1.6k | 16.3 s |

SPEC.md by section: Idea 3.4k chars, **Decisions 7.6k** (all marked `auto (recommended)`, each with its
reasoning), Testing 2.1k, Contract 1.3k, the rest under 1k each.

---

## 5. Small but real: the zsh `echo =====` trap

`echo ======` in zsh is `=`-expansion and fails with `(eval):1: ===== not found`. The Bash call then
exits 1 and returns a cut result (10,036/10,037 chars). The model re-reads in more calls. It happened in
builder's build (one extra call), and in builder-everything's brainstorm (three CONVERSATION.md paging
calls) and build (two extra EXECUTION/implementer reads). It also appears in every earlier tags run
(10-14 and 10-21), including in superpowers and GSD. It costs about 4 s for builder and about 15 s for
builder-everything in this run.

---

## 6. The brainstorm + spec session under `--auto`

**148 s wall, 144 s of it orchestrator, 11 calls, 15.3k output tokens. That is 24% of the run's
orchestrator time and 28% of its output tokens.** It asked no questions (`--auto`).

| Part | Time | Share |
|---|---|---|
| Recon (CONVERSATION.md, REFERENCE classifier, repo grep, workspace) | about 16 s, 4 calls | 11% |
| **Typing brainstorm.md**: a record that only the next skill, in the same context, reads | 34.8 s | 24% |
| Handoff plus spec's REFERENCE read plus mkdir | about 10 s | 7% |
| **Typing SPEC.md + MANIFEST.md** | 63.3 s | 44% |
| Fix after check-obligations | 8.6 s | 6% |
| Closing report (2.7k chars) | 10.7 s | 7% |

What it produced: brainstorm.md (9.1k chars, a workspace file that is never committed), SPEC.md (16.7k
chars), MANIFEST.md, and one commit. **About two thirds of its time is typing two documents that say
largely the same thing:** §Idea and §Decisions restate brainstorm.md's intent, decisions and
approaches.

---

## 7. Top causes, ranked by seconds (builder config, 603 s orchestrator)

Categories label each call by its main act. A call's 2.4 s fixed cost stays inside its category.

| # | Cause | Seconds (builder / everything) | Evidence |
|---|---|---|---|
| 1 | **Typing the long documents**: PLAN.md, SPEC.md, brainstorm.md, walk.md | 178 / 155 | Four calls, 65 + 63 + 35 + 15 s; 22k output tokens |
| 2 | **Fixed cost per call** (spread across all rows) | 162 / 185 | 68 / 77 calls × 2.4 s |
| 3 | **Bookkeeping**: manifest `sed`, commits, ledger, SPEC surgery | 126 / 125 | 18 calls; 10 commits; hand-written `sed`/Python/`node -e` for each state change |
| 4 | **Typing Agent dispatch prompts** | 86 / 90 | 6 / 7 dispatches at 12.6–17 s each, 2.4–2.7k chars each, about 70% fixed template |
| 5 | Inspecting the repo, gates and tests (mostly real work) | 122 / 114 | audit code read, verify parity, plan-code proof, test runs |
| 6 | **Closing reports** at the end of every session | 36 / 30 | 3 × 2.5–2.8k chars, about 1.2–1.4k tokens each |
| 7 | **Reading builder's docs by hand**: heading greps, range seds, paging, the zsh trap | 34 / 31 | 10 / 13 calls; the REFERENCE heading grep in all 3 sessions |
| 8 | Skill handoff calls | 23 / 18 | 7 steps × (Skill call plus first call after the load) |
| (9) | Thinking (spread) | about 57 / 47 | 7.6k / 6.3k thinking tokens, the most in plan (2.7k) and audit (1.0k) |

---

## 8. Proposals

Savings are for this run (builder config) and come from the fit: 2.4 s per call removed and 7.5 ms per
output token removed. **Internal** means a user sees the same pauses, steps, files and records.
**Visible** means it changes what a user sees.

### P1. Have the Agent prompt come from a script, not the model. About −45 s. Internal.

Extend `scripts/task-brief` (or add `scripts/dispatch`) to render `prompts/implementer.md`,
`task-reviewer.md`, `final-reviewer.md` and the agent-walk prompt into `<WS>/task-N-dispatch.md`. It
fills in the task number and title, the WS paths, the commit subject from PLAN, the test command from
the test plan, the global constraints, and the report path. The Agent call's `prompt` then becomes
"Read `<WS>/task-N-dispatch.md` and follow it", plus the one paragraph of *Context* that only the
controller knows: decisions from earlier tasks and resolved ambiguities. This takes each dispatch from
about 1.3k tokens to about 250.

builder: 6 dispatches, about 6.5k tokens saved, ≈ **−45 to −50 s**. builder-everything: 7 dispatches,
≈ −55 s. The SPEC section splice that build does by hand in a Python heredoc moves into the same script.

Guarantees: unchanged. The fresh implementer and the brief contents are the same, and the dispatch file
lives in the workspace, so it is resumable too.

### P2. One state-change script for manifest + head + commit + ledger. About −35 to −45 s. Internal.

Add `scripts/advance <folder> --state audited [--set go-ahead="auto (recommended) <date>"] [--ledger "<line>"] --commit "<subject>"`.
In one call it sets the keys, rewrites `head:`, appends the ledger line, and commits with the
attribution trailer. Add `scripts/condense <folder> --signoff agent|human` and
`scripts/condense --ship` for the SPEC surgery that agent-walk (14.2 s, `node -e`) and ship (Python)
now hand-write, and have `plan-slices`/`task-brief` emit the SPEC §Plan index from PLAN.md headings
(6.4 s heredoc today).

Each state change goes from a 200–700-token hand `sed` to a one-line call, and several fold into the
call before them. Estimate: −3.6k tokens (−27 s), −4 calls (−10 s), −5 to −10 s for condense and the
index. Call it **−35 to −45 s**.

Guarantees: this *strengthens* them. Manifest writes become deterministic, which matters most for
resume after /clear. Also, three hand-written `sed`s in this run had slightly different shapes
(`echo >>` vs `sed '/^walk: /i'`).

### P3. Under `--auto`, brainstorm writes the SPEC directly; brainstorm.md becomes a stub. About −35 s. Internal (a workspace file).

When `--auto` chains brainstorm into spec in the same context, the 9 KB brainstorm.md is read by
nobody but the next skill, which already holds the conversation. Under `--auto`, write a stub of about
10 lines (size, intent line, pointer to SPEC) and go straight to the SPEC write. Fold the REFERENCE
spec-format lines spec needs into brainstorm's auto path, so the extra handoff and REFERENCE `sed` go
too.

Saves the 34.8 s write, minus a 3 s stub, plus about 6 s of handoff and read: **≈ −35 s** (≈ −33 s in
everything).

Guarantees: without `--auto` nothing changes. Under `--auto` the durable artifact, a committed SPEC,
actually lands *sooner*, so after a crash or /clear there is more to resume from. The one thing lost is
the uncommitted design record for an `--auto` run that dies between the two writes, and a re-run costs
about 50 s.

### P4. Short closing reports in agent mode. About −20 to −25 s. Visible.

Under `--agent-walk`, end the session with the footer plus at most about 6 lines: state, rulings one
line each, and "worth checking". Today it writes three 2.5–2.8k-char reports. The fleet keeps the full
story in the manifest, ledger and walk report, and its park diagnostics read only the last 25 log
lines. In the brainstorm session under `--auto` (not fleet), keep the "choices settled" list but drop
the restated what-it-does and what-it-touches.

About 3.1k tokens: **−23 s** (−20 s in everything).

Visible: shorter session output in fleet logs and in `--auto`. Gates and records are unchanged. Keep
the footer that names the next step (memory: footers name the real next step).

### P5. A doc bundle per step instead of grepping and paging, and fix the zsh separator. About −15 to −20 s (−25 s in everything). Internal.

Each step's SKILL.md tells the model to "load REFERENCE §X". The model then greps headings and `sed`s
ranges, in 2–3 calls per session. Fix it with either of:

- (a) a `scripts/docs <step> [--auto] [--agent-walk]` that prints exactly the sections that step uses,
  for example build gets EXECUTION §Setup → §task loop, implementer.md, task-reviewer.md when
  review≠end, and the profile levers. It is one call that is always under 30 KB, with no zsh-hostile
  separators.
- (b) moving the few REFERENCE sections each step actually uses into that step's SKILL.md under an
  "In agent mode" heading. REFERENCE.md is 865 lines, and spec, the walk-lane resume and brainstorm each
  used one or two contiguous ranges.

Also say in the skills, or print in the bundle, "separate outputs with `echo ---`, not `====`".
`=====` breaks under zsh in every tags run so far.

Saves about 6–7 calls for builder (≈ −17 s) and about 10 for everything (≈ −25 s).

Guarantees: unchanged. This is the "split the 900-line file" idea, but measured: the seconds come from
the calls it removes, not from the bytes. Context size has about no effect on latency here.

### P6. Hand the walk lane a re-entry note. About −10 s. Internal.

The walk lane's resume took 7 calls and 26 s to re-derive what the build lane already knew (REFERENCE
headings, §walk readiness, the build SKILL walk section, walk.md). Have build's phase close write
`<WS>/handoff.md`: the next route, the readiness facts for this config, and the exact REFERENCE lines
for the walk lane. Have resume's agent-mode route table say "walk-ready → read handoff.md, run
readiness, then agent-walk".

About 3 calls fewer: **≈ −10 s**.

Guarantees: the walk lock and the separate walk-lane session are kept. The handoff is a file, so
/clear-resume still works, and resume still checks the manifest before it trusts the handoff.

### P7. Generate walk.md from SPEC §Testing plus the risk tags. About −8 s. Internal.

walk.md's per-app items are SPEC §Testing's verification script with `[risk]` tags added, and its
cross-app section E1–E7 is the same script copied verbatim. Have a script assemble it from SPEC
§Testing and the plan's risk-tagged tasks, so the model only adds "Local facts". 1.7k tokens become
about 0.4k: **≈ −8 s**.

### P8. Leaner `--auto` decision records in SPEC. About −15 to −20 s. Visible (the spec document).

§Decisions is 7.6k of SPEC's 16.7k chars, every row `auto (recommended)` with its reasoning and
alternatives. Under `--auto`, one table row per decision (decision · choice · one-clause why · the
alternative) would cut SPEC by about 30%: ≈ 2.3k tokens, **−17 s**.

Trade: SPEC is the write-once record, and builder promises "every decision with its reasoning". Keep
the reasoning to one clause, never drop it. Rows a human later questions go through
`/builder:revise` anyway.

### P9. Biggest lever, and a trade: apply the proven plan code instead of re-typing it. About −40 s orchestrator, about −100 s agents. Changes builder's model.

Plan already writes every task's full code and tests (13 KB, 65 s) and **proves them in a scratch copy:
17/17 green, 9.8 s**. Build then dispatches three implementers who largely re-type that code. A fast
path could work like this:

- When the plan's code is proven green, a script applies task N's code blocks, runs the slice gate,
  and commits per task.
- An implementer is dispatched only for a task whose blocks don't apply or go red.
- Review stays as the test plan sets.

This saves 3 dispatch calls (≈ −40 s orchestrator) and most of the 147 s of implementer agent time.

**It trades against a stated guarantee**: "a fresh implementer per task" with TDD RED evidence. Offer
it only as an opt-in test-plan lever, for example `impl=apply`, never as a default. The cheaper half,
writing less code in PLAN.md (interfaces and tests only), would save about 25 s of plan time but moves
the work to the implementers, so the net effect is unclear. I don't recommend it without measuring.

### P10. Merge adjacent steps in agent mode. About −10 s. Visible.

Seven Skill handoffs cost about 23 s (the Skill call plus the first call after the load). Under
`--agent-walk`, audit → plan and verify → ship could run as one skill invocation each, which saves
about 3 handoffs, ≈ −8 to −10 s. The per-step commits can stay, so the history still shows each step.

Visible in the transcript and the report's step table. Gates are unchanged, but **don't merge across
the go-ahead or the walk**: the go-ahead and the walk lock must stay distinct steps for human runs.
Small gain, so it comes last.

### Not recommended

- **Lower effort for the orchestrator.** Thinking is about 57 s, mostly in plan (2.7k thinking tokens)
  and audit and verify (≈1k each). That is where judgment happens.
- **Splitting files only to shrink context.** Measured cost: about 0.008 s per 1k cache-read tokens.

---

## 9. Total

| Proposal | builder | everything | Kind |
|---|---|---|---|
| P1 dispatch prompts from a script | −45 to −50 s | −55 s | internal |
| P2 `advance` / `condense` / §Plan index scripts | −35 to −45 s | −35 to −45 s | internal |
| P3 `--auto` brainstorm → SPEC directly | −35 s | −33 s | internal |
| P4 short agent-mode reports | −23 s | −20 s | visible |
| P5 doc bundles plus the zsh separator fix | −17 s | −25 s | internal |
| P6 walk-lane handoff note | −10 s | −10 s | internal |
| P7 walk.md generated | −8 s | −8 s | internal |
| P8 leaner `--auto` decisions | −17 s | −15 s | visible (spec text) |
| P10 merge steps in agent mode | −10 s | −10 s | visible (step list) |
| **Internal only (P1–P3, P5–P7)** | **≈ −150 to −165 s** | **≈ −165 s** | |
| **All except P9** | **≈ −200 to −215 s** | **≈ −210 s** | |
| P9 apply proven plan code (opt-in) | −40 s orch, about −100 s agents | about −50 s orch, about −120 s agents | trades a guarantee |

For builder this would take orchestrator time from about 10.0 min to about 7.4 min with the internal
changes alone, and to about 6.5 min with all non-trading changes. Wall time would go from 14 min to
about 11.5 and about 10.5 min. The savings don't fully add up: P1/P2 and P5/P6 share some calls.
