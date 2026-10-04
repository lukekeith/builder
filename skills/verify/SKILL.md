---
name: verify
description: The gate of the /builder:* pipeline — verifies a built feature against its spec across every in-scope app and issues a READY / INCOMPLETE verdict with evidence. Runs AFTER the human's walk. The pipeline's ONE deep pass: every affected app's gate suite fresh, consumer parity against the frozen contract, whatever the project config's deep set names, the cross-app E2E walk, a pattern-regression sweep against the config's house rules, and a spec-parity spot-check. Never opens a PR. Use when the user asks to verify a built feature or check whether a feature is done.
---

# `/builder:verify` — is it actually done?

Invocation: **`/builder:verify --path <folder>`**. Flags: [REFERENCE](../resume/REFERENCE.md) §Flags.

It reads four things, and **trusts nothing remembered from the build** — every check runs fresh:

- **`<folder>/SPEC.md`** — §Apps names which apps must be verified at all, §Contract is what each
  consumer is checked against, §Testing names what must pass, §Decisions the load-bearing behaviours,
  §Schema & API changes the rows that had to land, §Findings the `repoint:` rows, and `## Fixes`
  whatever is still owed. In prototype mode, §Prototype and §Replaced surfaces as well.
- **`<folder>/MANIFEST.md`** — `state:` · `apps:` · `contract:` · `walk:` · `verify:` · `hold:` ·
  `head`.
- **`.claude/builder.md`** — §Quality gates (the fast sets and the deep set), §House rules (item 7's
  checklist), §Environment landmines.
- **the ledger** — the sign-off removed `PLAN.md`, so the ledger plus `git log` are the record of
  what was built: `"$(<builder>/scripts/workspace <feature>)/progress.md"`.

🔴 **Re-resolve that path inline in every command that uses it** — a shell variable does not survive
between Bash calls. **The deep set's verdict is written here and nowhere else** — the fleet's build
lane may have run the deep block already, and `gate.mjs` quotes that run when the tree is unchanged
(REFERENCE §Quality gates).

🔴 **Under `--agent-walk` the verdict is written in this run.** No gate, reviewer or walk agent runs in
the background: independent subagents go out together in one foreground message, and a suite that
may outlast one Bash call runs through `scripts/job.mjs start` + `wait` until it reports an exit code
(resume §`--agent-walk`). A verify that ends its turn "waiting on the gates" is lost when the headless
run exits.

**The build profile (under `--agent-walk`).** Read the levers:
`node <builder>/scripts/profile.mjs --levers <folder>`. The floors in its `floors` hold whatever
the levers say — each in-scope app's fast set, and consumer parity when a `released_artifact`
consumer is affected. Without `--agent-walk`, verify runs as written.

- **`verify: floors`** → each app's fast set (item 3 without `--deep`), plus consumer parity
  (item 5) when a `released_artifact` consumer is affected. No deep set, no E2E, no pattern sweep —
  items 1, 2, 4, 6 and 8 still hold; the rest are named as skipped by the profile in the verdict.
- **`verify: full`** → the checklist as written, with the cross-app E2E (item 10) only on the legs
  §A re-verify's table names for this feature's diff.
- **`verify: everything`** → the checklist as written: a feature's first verify, every leg.
- **`testing: none`** (no walk): item 1 holds on the `🤖 AGENT SIGNED OFF — no walk …` header, and
  the verdict's first line says nothing walked it. There is no walk report, so when the verify level
  calls for the cross-app E2E (item 10), verify drives the app for it itself. **`testing: risky`**: item 1 holds on the
  report's `[risk]` and `E` rows.

🔴 **This entire skill is [`verification-before-completion`](../verification-before-completion/SKILL.md)
applied to a feature.** Its iron law governs every line of the verdict: *no completion claim without
fresh verification evidence.* Every item below is a claim that needs a command behind it, run in this
pass; anything quoted from an earlier run is marked as quoted, with which run and on which tree. A
READY verdict assembled from remembered green gates is the failure this step exists to catch.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `signed-off` — an INCOMPLETE verdict leaves the state there, so that is the whole list.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. One line, hand back, stop |
| `walk:` carries a name + date **and** the SPEC header carries `✅ SIGNED OFF` | run |
| `walk: agent-pass …` **and** the SPEC header carries `🤖 AGENT SIGNED OFF` | run, as an **agent-signed-off** feature: checklist item 1 holds on the agent walk report, the verdict says "agent-walked, not human-tested", and READY's `next:` is `/builder:resume --path <folder>` — which, in agent mode, opens the PR and takes it to merged |
| `walk: agent-pass …` at `state: built` (walked before agents signed off) | not signed off yet: hand to `/builder:agent-walk --path <folder>`, which writes the agent sign-off |
| `state: built` with `walk: none` | 🔴 **stop and offer the walk instead** — print `walk.md` and name `/builder:signoff --path <folder>` as what records the verdict. **Under `--agent-walk`:** hand to `/builder:agent-walk --path <folder>` instead. Never run the deep pass on a build nobody has looked at |
| `verify:` already carries a verdict | a **re-verify** — scoped, per §A re-verify is SCOPED |
| `hold:` set | run anyway: verify is local and changes nothing outward. The hold binds the PR, and the verdict carries it instead of a PR command |
| `state:` anything before `built` | not built yet. One line naming the state and the step that owns it, hand back, stop |

**When two rows fit, the more specific wins** — a `verify:` already carrying a verdict makes it the
scoped re-verify row, whatever `state:` says.

**Why the walk comes first:** the deep pass needs every in-scope app up at once — the slowest and
most fragile thing this pipeline runs. A human spots in seconds what it takes twenty minutes to
discover, so the expensive pass is spent once, on what they have already accepted.

## A re-verify is SCOPED

Re-run the gates the diff can turn red; quote the rest from the earlier run on the same tree, saying
which is which. 🔴 **Scope by APP first** — a fix inside one app cannot turn another's gates red, so
those are quoted, not re-run.

🔴 **The cross-app E2E walk is NOT automatically part of a re-verify.** A feature's FIRST verify
always runs it (checklist 10). A re-verify runs it only when the diff can change what a consumer
does — classify the diff, say which class you chose, and quote the earlier run when you skip it:

| The diff touches | The cross-app walk on re-verify |
|---|---|
| a §Contract row, an auth or permission path, a load/save/delete path, a notification payload or a deep-link target | **Yes** — the affected leg |
| only presentation, **but** changes a string, label or accessible name the walk script asserts on, or a surface a visual check diffs | **Yes, narrowly** — that leg and that check |
| only presentation, and nothing the walk or a check reads | **No** — that app's fast gates only, plus a look at the running app if it's visual |

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
3. **Gates green NOW, per app** — one call:
   `node <builder>/scripts/gate.mjs --deep <every in-scope app>` (through `job.mjs` under
   `--agent-walk`). It runs each in-scope app's fast set and the config's deep block, applying the
   config's `flaky:` re-runs, `@delta` baselines and `@known-red` marks itself. A set the runner
   **quotes** — its inputs byte-identical to a green run it recorded, at a sha it names — counts as
   run: that is REFERENCE §Quality gates' rule, and the quoted line with its sha is the evidence the
   verdict cites. A `@scoped` deep line runs only the tests this branch can reach
   (REFERENCE §Quality gates — the mechanism): cite `.builder/gates/impact.md` for which ran and why,
   and name the other features it pulled in. Never run the config's commands by hand beside it,
   never widen a scoped run "to be safe" (`--whole` is for when the impact report is plainly wrong,
   and says why), and never re-run a red gate yourself to see whether it is "really" red — the
   runner already applied the flake rule; a `✗` is a finding.
   A line **at or under its baseline** (`→ 7 (baseline 7)`) is green: report it as `<n> = baseline
   <n>` and move on. Open a failure's log only when the set is red — above its baseline — and then
   only for the failures above it; the ones already failing on the base branch are not this
   feature's to explain.
4. **Schema rows landed** — every §Schema row's Status carries its real migration id or is explicitly
   deferred with a named decider; Data plans executed. 🔴 **And the migration re-applies on a clean
   database** — one that only works against your local state is a production incident waiting.
5. **🔴 Consumer parity against the FROZEN contract** (`opus`) — the check a multi-app repo exists to
   have. For every §Contract row: the producer implements exactly that shape, and **each named
   consumer codes against exactly that shape**, traced in the shipped code with `file:line`. Then the
   compatibility question for every app the config marks `released_artifact: true`: **what does a
   currently-released build see?** Any rename, removal, type change, nullability change or enum
   narrowing on a field it reads is a gate failure unless §Apps states the transition AND the code
   implements it. The manifest's `contract:` must read `frozen` — an open contract on a built feature
   means the producer's phase never closed properly, and that is a finding.
6. **No OPEN decisions** in §Decisions; every *Replaces* item covered or dropped-with-a-decider.
   Shipping by silently deleting a capability users have is a gate failure.
7. **Pattern-regression sweep** on the feature's new code, per app — **the config's §House rules for
   that app, checked mechanically against the diff**. Don't assume the linters covered it: a house
   rule with no lint behind it is exactly the one that regresses, and the config marks which those
   are. Read the diff for them rather than trusting a green gate.
8. **§Testing satisfied** — each named test exists and passes at its layer; in prototype mode every
   `B#` owed row is backed by a committed test or a captured state, not by a walk that saw it once.
9. **Whatever the config's deep set names beyond gates** — a visual diff suite, an integration suite,
   a boundary check. Item 3's `--deep` run covered what the deep block lists; this item is for what
   the config describes in prose beside it. Run it, record the output, and honour the config's own
   caveats about how to read it (an advisory percentage is advisory; a known rendering artifact is
   not a regression).
10. **The cross-app E2E walk** — 🔴 the ONE place the pipeline exercises every app at once: §Testing's
    walk script, executed live. Can't bring the stack up → **BLOCKED-on-environment**, never READY.
    Mandatory on a feature's **first** verify; conditional on a re-verify — see §A re-verify is
    SCOPED, and quote the earlier run when the diff didn't earn a new one.
    **Under `--agent-walk`, the agent walk may already have covered it.** When `walk.md` has a
    `## Cross-app (verify E2E)` section, read `<WS>/agent-walk/round-<n>/report.md` for the round the `🤖 AGENT SIGNED OFF … round <n>` header names
    — never simply the latest round — and take `<walk sha>` from its `sha:` line, the code that
    round walked. Every `E<k>` row `PASS` with evidence, and no code changed since —
    `git diff --quiet <walk sha> -- . ':!<registry>'` exits 0, which also counts uncommitted edits —
    → item 10 is **covered by the agent walk**: cite the report path and the sha, marked quoted. A
    report with no `sha:` line can't be tied to code → item 10 as written. Any `E` row missing or not `PASS`,
    or code changed since → run **only those steps** live (all of them when code changed), as above.
    No such section (built before builder 4.6) → item 10 as written. A human walk never covers it.
11. **Spec-parity spot-check** (`opus` judgment, not grep) — trace the spec's 3–4 most load-bearing
    behaviours (permission gates, tenancy scoping, state rules, offline behaviour, routing) in the
    shipped code with `file:line`. This catches a feature that passes every gate while doing something
    the spec didn't say. **When the impact report lists code of another feature** — it reads a schema
    field this one changed — spot-check that feature's one behaviour on that field too, and stop
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
is a normal outcome; the orchestrator loops it.

🔒 **READY is not shipped: this skill never opens a PR**, never writes to the ticket system, and never
deploys. Hand back to `/builder:resume --path <folder>`. Lead the hand-off with the evidence — which
apps' gates ran, which were quoted from an earlier run, what the contract-parity trace found, what the
deep checks showed, and whether the cross-app walk ran or was quoted — then:

```
📍 <feature>: verify READY (<apps>) — 🛑 held — <the hold's words>
```

Otherwise the two-way footer (REFERENCE §The two-way footer) — option 1 `/builder:resume --path
<folder> (opens the PR)` on READY, `/builder:resume --path <folder>` on INCOMPLETE:

```
📍 <feature>: verify <READY (<apps>) | INCOMPLETE — <n> fixes owed> — next:
   1. resume — continue here, step by step: /builder:resume --path <folder>[ (opens the PR)]
   2. agent  — hand it to agents to finish and merge: /builder:agent --path <folder>
   Reply 1 or 2 (or "resume" / "agent"; "go" is 1)
```

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
