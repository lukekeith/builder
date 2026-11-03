---
name: verify
description: The optional deep check on a feature after sign-off — the verifier's merge tier (every suite and check on the feature merged onto the target), contract parity and a spec spot-check — ending in READY or INCOMPLETE with evidence. Use when asked to verify a feature or whether it's done.
---

# `/builder:verify` — is it actually done?

Invocation: **`/builder:verify --path <folder>`**. Flags: [REFERENCE](../resume/REFERENCE.md) §Flags.

**Optional.** After sign-off the human picks a quick check, ship it, or this — the **Full verify**
choice (resume §After sign-off), for when a deep check is worth its tokens: the build's reviews and
the walk already checked the feature. Nothing refuses a PR, ship or merge for want of its READY, and
agent mode runs the one-call quick check (`verify-quick.mjs`) instead, never this.

It reads four things, and **trusts nothing remembered from the build** — every check runs fresh:

- **`<folder>/SPEC.md`** — §Apps names which apps must be verified at all, §Contract is what each
  consumer is checked against, §Testing names what must pass, §Decisions the load-bearing behaviours,
  §Schema & API changes the rows that had to land, §Findings the `repoint:` rows, and `## Fixes`
  whatever is still owed. In prototype mode, §Prototype and §Replaced surfaces as well.
- **`<folder>/MANIFEST.md`** — `state:` · `apps:` · `contract:` · `tests:` · `walk:` · `verify:` ·
  `hold:` · `head`.
- **`.claude/builder.md`** — the `verify:` block and §Verification, §House rules (item 7's
  checklist), §Environment landmines. `node <builder>/scripts/docs.mjs verify` prints it in one call
  with the REFERENCE sections this step cites — §The verifier, §The two-way footer,
  §Continuing on "go". **Under the fleet (`BUILDER_FLEET_DIR` set, or `--agent-walk`), two calls, each
  one Bash output: `docs.mjs verify --no-config`, then `docs.mjs fleet-config verify`** — the front
  matter and §Verification, §Global constraints, §House rules, §Environment landmines, §Quality gates,
  §Walk readiness, plus the opening prose and any section the project added.
- **the ledger** — the sign-off removed `PLAN.md`, so the ledger plus `git log` are the record of
  what was built: `"$(<builder>/scripts/workspace <feature>)/progress.md"`.

🔴 **Re-resolve that path inline in every command that uses it** — a shell variable does not survive
between Bash calls. **The merge tier is this step's evidence** — the fleet requested it when the
walk started (under the fleet; otherwise verify requests it); read it, never re-run it.

**Under `--no-dev-env`** (the fleet's parallel lanes) there is no env and verify never drives the
app: anything that needs the app driven on code changed since the walk — item 10's live steps — is a
re-walk (AGENT-MODE.md §Batched walks), never a run here.

🔴 **Under `--agent-walk` the verdict is written in this run.** No reviewer or walk agent runs in the
background: independent subagents go out together in one foreground message, and the merge tier is
read with `verify.mjs wait <id>` in the foreground (Bash timeout 600000; exit 75 → call again)
(resume's AGENT-MODE.md). A verify that ends its turn "waiting on the verifier" is lost when the
headless run exits.

**The test plan.** `node <builder>/scripts/profile.mjs --levers <folder>` — it reads the manifest's
`tests:` line, and maps an old `profile:` or `slice=`/`end=` line. Tests are not a lever:
READY = the merge tier green on HEAD + the walk passed. The floors in its `floors` hold whatever the
levers say — **the final whole-branch review**, which the build ran. The checklist holds as written
under every lever, consumer parity when a `released_artifact` consumer is affected (item 5)
included. `walk` sets what the walk was: **`walk=none`** → no agent walk; item 1 holds on the `🤖 AGENT SIGNED OFF — no walk …` header, and
the verdict's first line says the feature was not walked. **`walk=risk`** → item 1 holds on the
report's `[risk]` and `E` rows. **`walk=full`** → the whole walk.

🔴 **This entire skill is [`verification-before-completion`](../verification-before-completion/SKILL.md)
applied to a feature.** Its iron law governs every line of the verdict: *no completion claim without
fresh verification evidence.* Every item below is a claim that needs a command behind it, run in this
pass; anything quoted from an earlier run is marked as quoted, with which run and on which tree. A
READY verdict assembled from a remembered or older verdict is the failure this step exists to catch.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `signed-off` — an INCOMPLETE verdict leaves the state there, so that is the whole list.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `walk:` carries a name + date **and** the SPEC header carries `✅ SIGNED OFF` | run |
| `walk: agent-pass …` **and** the SPEC header carries `🤖 AGENT SIGNED OFF` | run, as an **agent-signed-off** feature: checklist item 1 holds on the agent walk report, the verdict says "agent-walked, not human-tested", and READY's `next:` is `/builder:resume --path <folder>` — which, in agent mode, opens the PR and takes it to merged |
| `walk: agent-pass …` at `state: built` (walked before agents signed off) | not signed off yet: hand to `/builder:agent-walk --path <folder>`, which writes the agent sign-off |
| `state: built` with `walk: none` | 🔴 **stop and offer the walk instead** — print `walk.md` and name `/builder:signoff --path <folder>` as what records the verdict. **Under `--agent-walk`:** hand to `/builder:agent-walk --path <folder>` instead. Never call a build READY that nobody has looked at |
| `verify:` already carries READY or INCOMPLETE | a **re-verify** — scoped, per §A re-verify is SCOPED. `QUICK …` or `SKIPPED …` → run in full: the human chose the deep check after all |
| `hold:` set | run anyway: verify is local and changes nothing outward. The hold binds the PR, and the verdict carries it instead of a PR command |
| `state:` anything before `built` | not built yet. One line naming the state and the step that owns it, hand back, stop |

**When two rows fit, the more specific wins** — a `verify:` already carrying a verdict makes it the
scoped re-verify row, whatever `state:` says. Under `--agent-walk` this skill is not the route at
all — AGENT-MODE §Ship in agent mode quick-checks and ships — so it runs only when asked by name.

**Why the walk comes first:** a human (or the agent walk) spots in seconds what a suite takes minutes
to discover; the merge tier runs beside the walk, so neither waits on the other.

## A re-verify is SCOPED

Request the merge tier on the new HEAD; it runs everything on the merged result, so there is nothing
to scope by hand.

🔴 **The cross-app E2E walk is NOT automatically part of a re-verify.** A feature's first verify
reads it from the walk (checklist 10). A re-verify walks it again only when the diff can change
what a consumer does — classify the diff, say which class you chose, and quote the earlier run when you skip it:

| The diff touches | The cross-app walk on re-verify |
|---|---|
| a §Contract row, an auth or permission path, a load/save/delete path, a notification payload or a deep-link target | **Yes** — the affected leg |
| only presentation, **but** changes a string, label or accessible name the walk script asserts on, or a surface a visual check diffs | **Yes, narrowly** — that leg and that check |
| only presentation, and nothing the walk or a check reads | **No** — the merge tier on HEAD, plus a look at the running app if it's visual |

The middle row is worth reading twice: "cosmetic" is not a safety guarantee. A reworded label changes
a visual diff, and a renamed element changes what the walk does.

**Batch, don't drip:** in an interactive back-and-forth, the walk waits for the end of the batch.

## The checklist (all must hold for READY)

1. **The walk happened** — the SPEC header carries `> ✅ SIGNED OFF <date> — <sha> · by <name>` and
   `walk:` names who and when. `/builder:signoff` is `disable-model-invocation`, so that pair is proof
   a human typed it; a `✅ SIGNED OFF` header written by an agent is **void** — re-offer the walk.
   🔴 **A multi-app feature needs a walk that covered each in-scope app**: a sign-off recorded PARTIAL
   with an app's items unexercised is not a full walk, and those items are named in the verdict.
   **Agent-verified** (`walk: agent-pass …`): the proof is instead `<WS>/agent-walk/round-<n>/report.md`
   with every item `PASS` at a sha this verify covers. It proves an agent walked it — never that a
   human did — and the verdict says so in its first line.
2. **Every task landed** — the task list comes from the ledger's **pre-flight table**. Ledger gone →
   recover the plan from the sign-off commit's parent: `git log -- <folder>/SPEC.md` finds that sha,
   then `git show <sign-off sha>^:<folder>/PLAN.md`. Every task has a `Task N: complete` line, every
   phase its `Phase N: closed` line. **No `- [ ]` remains under `## Fixes`.** 🔴 **A phase in a
   `commit: manual` app whose commits were staged but never approved is not landed** — say so plainly;
   it is the human's call, not a failure.
3. **The merge tier is green on HEAD** — `node <builder>/scripts/verify/verify.mjs verdict <branch>
   --tier merge`. Its verdict holds for HEAD when its sha is HEAD or the commits since touch only the
   registry — `git diff --quiet <its sha> HEAD -- . ':!<registry>'` exits 0 (the sign-off, condense
   and verify records; the rule `carry` lands by) — so the fleet's held run stands, never re-run.
   A `pending: merge … <id>` line — still running (exit 75), or a newer run printed after an older
   verdict — → `verify.mjs wait <id>` on it, never a second request. No verdict and none pending
   (exit 5), or code changed since its sha → `verify.mjs request <worktree> HEAD --tier merge
   --hold` and `verify.mjs wait <id>`. Quote the verdict line — `verify merge <sha> <branch>: …`, the request
   id, the counts. **Regressions** fail this item: each becomes a `## Fixes` row naming
   its test and the commit that introduced it. **Flakes, known failures and newly found debt** are
   reported in the verdict and do not fail it. **Env-broken** is BLOCKED-on-environment, never READY.
   **`untested`** (the config names no tests) is not READY unless the human has said this project
   has no tests — then the verdict says so in those words.
4. **Schema rows landed** — every §Schema row's Status carries its real migration id or is explicitly
   deferred with a named decider; Data plans executed. 🔴 **And the migration re-applies on a clean
   database** — one that only works against your local state is a production incident waiting.
5. **🔴 Consumer parity against the FROZEN contract** (`opus`) — the check a multi-app repo exists to
   have. For every §Contract row: the producer implements exactly that shape, and **each named
   consumer codes against exactly that shape**, traced in the shipped code with `file:line`. Then the
   compatibility question for every app the config marks `released_artifact: true`: **what does a
   currently-released build see?** Any rename, removal, type change, nullability change or enum
   narrowing on a field it reads is a blocking finding unless §Apps states the transition AND the code
   implements it. The manifest's `contract:` must read `frozen` — an open contract on a built feature
   means the producer's phase never closed properly, and that is a finding.
6. **No OPEN decisions** in §Decisions; every *Replaces* item covered or dropped-with-a-decider.
   Shipping by silently deleting a capability users have is a blocking finding.
7. **Pattern-regression sweep** on the feature's new code, per app — **the config's §House rules for
   that app, checked mechanically against the diff**. Don't assume the linters covered it: a house
   rule with no lint behind it is exactly the one that regresses, and the config marks which those
   are. Read the diff for them rather than trusting a green verdict.
8. **§Testing satisfied** — each named test exists and passes at its layer; in prototype mode every
   `B#` owed row is backed by a committed test or a captured state, not by a walk that saw it once.
9. **Whatever the config's §Verification names beyond the verifier** — a check described in prose that
   has no suite or check in the `verify:` block. Run it here and quote it.
10. **The cross-app walk** — its evidence is the agent walk's `## Cross-app (verify E2E)` rows and
    any e2e suite's result in the merge tier; there is no separate live cross-app pass. Quote the
    walk's `E` rows when the code is unchanged since the walk (the diff since its sha touches only the
    registry). With no `E` rows and no e2e suite in the merge tier, the verdict says the cross-app
    path was not exercised. On a re-verify, whether a leg is walked again follows §A re-verify is
    SCOPED — quote the earlier run when the diff didn't earn a new one.
    **One app in scope:** there is no cross-app walk to run — the feature's walk script *was* the
    verification script (`walk-script.mjs`), so the agent walk's report covers this item exactly as
    `E` rows would: its rows for the round the sign-off header names, every in-scope row `PASS` (a
    carried row counts) and no code changed since its `sha:`. A human-walked single-app feature: the
    walk the sign-off records covers it.
    **Under `--agent-walk`, the agent walk may already have covered it.** When `walk.md` has a
    `## Cross-app (verify E2E)` section, read `<WS>/agent-walk/round-<n>/report.md` for the round the `🤖 AGENT SIGNED OFF … round <n>` header names
    — never simply the latest round — and take `<walk sha>` from its `sha:` line, the code that
    round walked. Every `E<k>` row `PASS` with evidence, and no code changed since —
    `git diff --quiet <walk sha> -- . ':!<registry>'` exits 0, which also counts uncommitted edits —
    → item 10 is **covered by the agent walk**: cite the report path and the sha, marked quoted. A
    report with no `sha:` line can't be tied to code → treat it as code changed since. Any `E` row
    missing or not `PASS`, or code changed since → **only those steps** are walked again (all of them
    when code changed) — under `--no-dev-env` that is a re-walk (AGENT-MODE.md §Batched walks), never
    a run here. No such section (built before builder 4.6) → the merge tier's e2e suites are the
    evidence. A human walk never covers it.
11. **Spec-parity spot-check** (`opus` judgment, not grep) — trace the spec's 3–4 most load-bearing
    behaviours (permission gates, tenancy scoping, state rules, offline behaviour, routing) in the
    shipped code with `file:line`. This catches a feature that passes every suite while doing something
    the spec didn't say. **When the merge tier's selection pulled in another feature's
    tests** — they read a schema field this one changed — spot-check that feature's one behaviour on that field too, and stop
    there: the rest of the codebase is not this verify's to re-prove.

**Prototype mode adds 12 and 13.**

12. **The residual sweep at zero** — for every §Findings `repoint:` row, re-grep **that row's app**
    for the surface's strings, routes and imports: **zero hits**, and the row's sites all point
    somewhere new. A behavioural test guard on a retired surface is **ported, not deleted** — a
    deleted guard is a finding, not a clean sweep.
13. **§Replaced surfaces closed and the obligations discharged** — every `S#` COVERED or DROPPED
    **with a named decider**, every `N#` with a disposition, proven rather than read:

    ```
    node <builder>/scripts/check-obligations.mjs <folder>
    ```

    Exit 0 or the item fails. 🔴 **Run it in written-spec mode too** — its §Apps and §Contract
    obligations are not prototype-specific.

## The verdict

**One manifest write**, plus `head` at this transition, and for INCOMPLETE the failing items as SPEC
tasks:

| Outcome | The manifest | The SPEC |
|---|---|---|
| **READY** | `verify: READY YYYY-MM-DD` · `state: verified` · `next:` the PR command — or, with `hold:` set, `next: 🛑 held — <the hold's words>` | unchanged |
| **INCOMPLETE** | `verify: INCOMPLETE YYYY-MM-DD` · `state` unchanged · `next: /builder:resume --path <folder>` | each failing item a `- [ ]` under `## Fixes`, **naming its app** and what clears it |

Commit both together: `docs(<ticket-or-feature>): <feature> — verify <READY|INCOMPLETE>`. INCOMPLETE
is a normal outcome; the orchestrator loops it. One call each — the presets carry the subject:

```bash
# READY
node <builder>/scripts/advance.mjs <folder> --set "verify=READY YYYY-MM-DD" --set state=verified \
  --set "next=<the PR command | 🛑 held — <the hold's words>>" --head --commit verify-ready
# INCOMPLETE — the ## Fixes rows written to SPEC.md first
node <builder>/scripts/advance.mjs <folder> --set "verify=INCOMPLETE YYYY-MM-DD" \
  --set "next=/builder:resume --path <folder>" --head --add <folder>/SPEC.md --commit verify-incomplete
```

After a crash, re-run the same command — it finishes what's missing or says `already applied`
(REFERENCE §The scripts).

🔒 **READY is not shipped: this skill never opens a PR**, never writes to the ticket system, and never
deploys. Hand back to `/builder:resume --path <folder>`. Lead the hand-off with the evidence — the
merge-tier verdict (sha, request, counts), what the contract-parity trace found, and whether the cross-app walk ran or was quoted — then:

```
📍 <feature>: verify READY (<apps>) — 🛑 held — <the hold's words>
```

Otherwise the two-way footer (REFERENCE §The two-way footer) — Step by step runs `/builder:resume
--path <folder>` either way (on READY it opens the PR, asked once); no `/builder:*` command on an
option line:

```
Full spec: <folder>/SPEC.md
Pick up where you left off any time: /builder:resume --path <folder>
  (if this session ends, or to spec several features before building any of them)

📍 <feature>: verify READY (<apps>) — what next?
   1. Agent — sent to agents who merge it on their own, without a PR; you get the review of what landed
   2. Step by step — carry on here (next: open the PR — asked once before it opens)
   Reply 1 or 2 — "go" is 1.

📍 <feature>: verify INCOMPLETE — <n> fixes owed — what next?
   1. Agent — sent to agents who fix what was found, re-check it and merge it on their own; you get the review of what landed
   2. Step by step — fix them here one at a time, then re-verify what they touched
   Reply 1 or 2 — "go" is 1.
```

Without a config `agent_walk:` block only Step by step is left: the single line
`📍 <feature>: verify <…> — next: /builder:resume --path <folder> · or say go`.

**An INCOMPLETE never blocks** — verify is optional. When the human says to ship it as is,
`node <builder>/scripts/verify-quick.mjs <folder> --skip` records `verify: SKIPPED`, then resume §Ship;
the `## Fixes` rows stay for later.

**Under `--agent-walk`, a READY goes straight on** into resume's AGENT-MODE.md §Ship in agent mode in this turn — no
footer, no return to the route table (REFERENCE §Under `--auto` and `--agent-walk`: adjacent steps
run as one). The hand-off above is then the six-line closing report, not the evidence list.

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — on a
numbered footer, option 1 (Agent, where it is offered) — never ask the human to paste it. REFERENCE
§Continuing on "go" has the exceptions.
