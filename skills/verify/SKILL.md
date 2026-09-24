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
between Bash calls. **The deep set runs here and nowhere else.**

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
| `state: built` with `walk: none` | 🔴 **stop and offer the walk instead** — print `walk.md` and name `/builder:signoff --path <folder>` as what records the verdict. Never run the deep pass on a build nobody has looked at |
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
   a human typed it; a header written by an agent is **void** — re-offer the walk. 🔴 **A multi-app
   feature needs a walk that covered each in-scope app**: a sign-off recorded PARTIAL with an app's
   items unexercised is not a full walk, and those items are named in the verdict.
2. **Every task landed** — the task list comes from the ledger's **pre-flight table**. Ledger gone →
   recover the plan from the sign-off commit's parent: `git log -- <folder>/SPEC.md` finds that sha,
   then `git show <sign-off sha>^:<folder>/PLAN.md`. Every task has a `Task N: complete` line, every
   phase its `Phase N: closed` line. **No `- [ ]` remains under `## Fixes`.** 🔴 **A phase in a
   `commit: manual` app whose commits were staged but never approved is not landed** — say so plainly;
   it is the human's call, not a failure.
3. **Gates green NOW, per app** — the full fast set for **every app §Apps marks in scope**, plus
   whatever the config's deep block adds, outputs recorded. Record the config's KNOWN-RED gates as
   BLOCKED with evidence; report a delta where it asks for one.
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
   a boundary check. Run it, record the output, and honour the config's own caveats about how to read
   it (an advisory percentage is advisory; a known rendering artifact is not a regression).
10. **The cross-app E2E walk** — 🔴 the ONE place the pipeline exercises every app at once: §Testing's
    walk script, executed live. Can't bring the stack up → **BLOCKED-on-environment**, never READY.
    Mandatory on a feature's **first** verify; conditional on a re-verify — see §A re-verify is
    SCOPED, and quote the earlier run when the diff didn't earn a new one.
11. **Spec-parity spot-check** (`opus` judgment, not grep) — trace the spec's 3–4 most load-bearing
    behaviours (permission gates, tenancy scoping, state rules, offline behaviour, routing) in the
    shipped code with `file:line`. This catches a feature that passes every gate while doing something
    the spec didn't say.

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
📍 <feature>: verify READY (<apps>) — next: <the PR command>
📍 <feature>: verify INCOMPLETE — <n> fixes owed — next: /builder:resume --path <folder>
```
