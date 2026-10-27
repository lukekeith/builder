---
name: audit
description: Checks a feature spec against the codebase once, before any code is written — house rules, schema, cross-app contracts and gaps — and writes findings and open questions into the spec. Use when asked to audit or gap-check a spec.
---

# `/builder:audit` — the spec meets the codebase, once

Invocation: **`/builder:audit --path <folder> [--ticket <id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — **ignore any flag this step does not use rather than
erroring on it**.

**Load REFERENCE and `.claude/builder.md` before starting — in one call:**
`node <builder>/scripts/docs.mjs audit` prints every section below, the config and
`SURFACE-CHECK.md` together; cite them rather than restate them:
the config's **§House rules** is sweep 1's checklist and its **§Standing traps** is what this project
has already paid to learn · REFERENCE §SPEC.md gives the §Findings / §Decisions shapes and the
`build-time risk` convention · §Apps and §Contract and the contract freeze are sweep 3's subject ·
§MANIFEST.md is the file written at the end · §Prototype mode holds the three-way choice ·
§Agent model tiering sets the model per item. Surfaces:
[`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md).

Input: `<folder>/SPEC.md` + `MANIFEST.md`; output: the spec corrected in one write plus the manifest.
**Read-only against app code** — nothing under any app's path is edited here, and neither is the
design source.

Findings are **rows, not essays**: the claim, the evidence (`file:line` where load-bearing), the
resolution. A spec statement the code contradicts is **fixed in place** — no dated markers, no
strikethrough, no per-pass narrative. An open question with more than one defensible answer is an
OPEN §Decisions row with a recommendation.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node <builder>/scripts/list-features.mjs --json` and offer only the folders
whose state is `spec` or `aligned`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | this step does not run on it. Say so in one line, hand back to `/builder:resume --path <folder>`, stop |
| `state: spec`, and no design ref | run — written-spec mode: sweeps 1–6 |
| `state: spec` **and** a design ref | prototype mode, not yet aligned — `/builder:align` runs first. One line, hand back, stop |
| `state: aligned` | run — prototype mode: sweeps 1–6 **plus** items 7–10 |
| `state: audited` | the pass is spent. Only the cap's scoped second pass runs; otherwise one line, hand back, stop |
| `state:` anything past `audited` | say so naming the state, hand back, stop |

**Prototype mode is the manifest's design key being anything other than `none`.** Its **in-scope
items are the ones §Prototype lists**. Read that list; **never re-resolve the ref**, because the
design moves and re-resolving can widen a scope that was settled at design.

## 🔴 The pass cap

**Reading prose about code has a hard ceiling.** Measured on the pipeline this replaced: twelve
reading passes and 164 findings on one feature surfaced none of its four real defects — all four came
from running the software, and building one phase found five spec defects those twelve passes missed.

| Pass | When | Scope |
|---|---|---|
| 1 | always | the sweep below — **a single agent at `size: md`; parallel agents, one per app, only at `size: lg`** |
| 2 | only if pass 1 changed a **contract** (a §Contract row, a schema row, a component API, a permission) | the changed contracts and what keys on them — nothing else |
| 3+ | ⛔ never | — |

A pass never audits the previous pass's corrections — if a correction is wrong, the build finds it in
minutes. Anything still uncertain when the cap is spent becomes a §Findings row marked
**`build-time risk`** naming the phase/task that settles it; `/builder:plan` copies the note onto that
task. It is not a blocker and never a reason for another pass.

## The sweep (one pass, all of it)

**1. Layers & house patterns, per app** — check each in-scope app's section against the config's
§House rules for THAT app, and against whatever source of truth it points at. Spot-verify that the
spec's named baselines exist with the claimed shapes. **A decision stated in the spec's prose with no
§Decisions row is a finding** — an unrecorded ruling is re-litigated mid-build.

**2. Schema & lifecycle** — every §Schema row has a reason and a migration path following that app's
house rules; REMOVE / NOT-NULL rows have a Data plan with a named decider. Then the lifecycle hunt:
dependent rows on delete/restore, unique-constraint races, enum membership against what the code
actually has, indexes the query plan needs, and **what a consumer's cached copy of this data does
when the shape changes**. A change the feature needs with no row is a finding, and so is a §Schema
section missing either the explicit dated **"No schema change (established YYYY-MM-DD)"** line or,
when it owes rows, the `**Data plan:**` line and the ordering — even as "independent". Silence reads
as nobody having checked.

**3. 🔴 The cross-app contract audit** (`opus`) — the sweep a multi-app repo exists to have, and the
one whose misses ship. Four checks:

- **Producer/consumer parity.** For every §Contract row: the producer implements exactly that shape,
  and **every consumer the row names codes against exactly that shape**. A field the producer returns
  that no consumer reads is a question; a field a consumer expects that the producer does not send is
  a defect. Trace it, don't assume it.
- **Breaking changes for a RELEASED build.** For every app the config marks
  `released_artifact: true`: any rename, removal, type change, nullability change or enum narrowing
  on a field it reads is breaking, and needs a stated transition in §Apps *Backward compatibility* —
  not a sentence saying users will update. Additive is safe; say which each change is.
- **Wrong "not affected" claims.** Every ⬜ row in §Apps is a claim to CHECK, not a fact. Re-derive it
  against the code and against what the config says that app is for. A ⬜ that should be ✅ is a
  finding **and** a §Apps correction in the same write.
- **Consumer divergence.** Where consumers deliberately differ, the spec says so; where they differ by
  accident, that is a finding. Consumers that never import each other have nothing else catching it.

A finding here is tagged `contract:` in §Findings, and 🔴 **an unresolved one blocks the plan step** —
written as a `blocked:` row, because building a consumer against a contract nobody verified is the
failure this sweep prevents.

**4. Component coverage, per consumer** — inventory what exists NOW in the component sources the
config names. Every view element in a consumer's section maps to a real component whose interface
**actually fits**, or a **(new)** row. Where the project has a design registry, an element with no row
is a **registry defect** — a dated row addition plus a spec amendment, routed to the owning command,
never an inline invention. Loading / empty / error / permission-denied states specified per view;
destructive actions confirm, in whatever way that app's house rules require. A surface existing on
two consumers and diverging silently is a finding (sweep 3).

**5. Adversarial gap hunt** (`opus`) — walk each flow end-to-end hunting unspecified behaviour: auth
boundaries, **tenancy isolation** (any externally-supplied id is adversarial until ownership-checked),
empty/missing data, idempotence and double-submit, concurrency, partial failure mid-transaction,
pagination, rate limiting, timezones, seeds/fixtures, **offline and stale cached state on any
consumer that has one**, **deep-link and notification targets**, and what an error renders as on each
consumer. Grade §Testing against what this hunt surfaced. Two probe rules: **inherited design docs
are audit input, not trusted ground** — their invariant tables get the same walk; and **join every
new fact against the tables keyed on it** and ask what they now produce.

**6. Replaced surfaces & adjacency** — if the feature absorbs live surfaces, each consumer's section
must name every capability that surface has today (covered / dropped-on-purpose) — a feature can be
100% built and still delete capabilities users have; nothing replaced is a one-line statement, not a
gap. 🔴 **A surface can exist once per consumer** and the inventory covers all of them. Then walk the
edges: how users arrive, where they go after, and which shared surfaces it silently assumes — a
missing edge is a finding or an OPEN decision, never an assumption.

## Prototype mode adds — items 7–10

Same pass, not a second one. Each is named in the exit verdict with what clears it.

**7. The contracts are read, in full, and their open questions disposed** — for every item in
§Prototype: its contract, its designed states and variant axes, its props, its tokens, and each open
question. 🔴 **Every open question gets a disposition**: answered by a §Decisions ruling, carried as a
§Findings row naming the task that settles it, or explicitly out of scope with a decider. One nobody
disposed of is a mid-build surprise, and it is a finding. Where the design system carries owner notes,
**read them with the tool the config names** — a pending note is a ruling this spec may not reflect,
and a note contradicting the spec is a finding routed to its owner, never edited here.

**8. The render matches the design, for a BUILT item** — diff its rendered form against the frozen
design snapshot, with whatever command the config names. An unbuilt item is not a failure: say so, and
note that its states have never been seen, which is a `build-time risk` on its first task. 🔴 **Never
start or stop a server, and never build a design item to make this pass** — that is the design
pipeline's work, offered as an option. The tooling not answering → **BLOCKED on environment**, said in
the verdict with what clears it; never silently skipped, never reported as PASS.

**9. Enumerate the repoint callers** — the audit *inventories* them; it compares nothing. Per surface
marked REPLACES or ABSORBS, re-grep each app for its route strings, imports, deep links and
notification targets, and write what you find as a tagged §Findings row per surface, with its owning
app:

```
| R1 | repoint (<app>): <surface> ← <file:line>, <file:line>, … | builder:plan's repoint + retire phase |
```

**A surface with no hits gets a row saying so** — an absent row reads as nobody having looked. A
surface whose fingerprint moved since design is re-enumerated first — that surface only.

**10. Obligations disposed** — exit 0 means every `N#` has a disposition, every DDL-implying `T#` has
its `SC#`, every app has its §Apps row, and every §Contract row names a consumer:

```
node <builder>/scripts/check-obligations.mjs <folder>
```

🔴 **Run this in written-spec mode too** — items 1–6 end with it. Its §Apps and §Contract obligations
are not prototype-specific, and they are the cheapest cross-app check this pipeline has.

## A gap this pass finds in the design

The design is the requirements, so a gap against it is resolved before the go-ahead rather than filed.
Take **REFERENCE §Prototype mode's three-way choice** — **one gap per turn, recommendation first**,
the same gap at several sites counted as one gap with its sites listed.

- **"Fix it in the design"** routes to the command the config's `design.owned_by` names, and this run
  **re-reads** the contract before the next gap. 🔴 This step never writes the design itself.
- **`--auto`** takes the recommendation and records it in §Decisions as `auto (recommended)`.
- **A defect in APP code** is reported with a doc-fix vs code-fix recommendation and asked; under
  `--auto` the doc fix lands now and the code fix becomes a `build-time risk` naming the task that
  settles it. **No ticket is opened unprompted.**

## Exit

**The code map, for the plan's writers** — `<WS>/audit-digest.md` (`<builder>/scripts/workspace
<feature>`; git-ignored, never committed). Per app, one line per file the sweep read that the
feature changes or builds on: `` `path:lines` — what is there `` (the signature, the pattern a new
piece should copy, the test file that covers it). Ask each sweep agent to end its report with those
lines and write them as they come back — never re-read the files to make it. The plan's writers read
it before they open code, so a writer opens a file to copy what it changes, not to rediscover what
this pass already read. It is a map, not a finding: anything that needs a decision is a §Findings row.

**One SPEC edit, at the end of the pass**: corrections in place (including §Apps rows this pass proved
wrong), §Findings & risks rows, OPEN §Decisions rows with recommendations, and `build-time risk` on
anything the cap leaves unsettled.

**The manifest:** `state: audited`, `head`, `branch`, `apps:` refreshed if sweep 3 corrected §Apps,
and `next: /builder:resume --path <folder>` — one command either way, because the orchestrator routes
to the decisions gate when §Decisions has OPEN rows and to `/builder:plan` when it does not. Commit
the SPEC and the manifest **together**: `docs(<ticket-or-feature>): <feature> audited`. All of it is
one call:

```bash
node <builder>/scripts/advance.mjs <folder> --set state=audited \
  --set "next=/builder:resume --path <folder>" [--set "apps=<a>+<b>"] --head \
  --add <folder>/SPEC.md --commit audited
```

After a crash, re-run the same command — it finishes what's missing or says `already applied`
(REFERENCE §The scripts).

**The hand-off carries a `READY` / `BLOCKED` line** over the contract sweep and, in prototype mode,
items 7–10 plus the `S#` closure — every `S#` COVERED, DROPPED **with a named decider**, or carried by
a decided §Decisions row. **Every BLOCKED item is also a tagged §Findings row**, because a hand-off
line dies with the session:

```
| B1 | blocked: <item> — clears when <what> | audit exit |
```

`/builder:plan` refuses to start while a `blocked:` row stands. BLOCKED is not a failed audit: the
manifest is still `state: audited` with the same `next:` line.

Standard handoff, in this order:

1. **What the audit changed in the design** — the review delta, REFERENCE §The review §The delta
   form: each review section a correction moved (what users get or see, added · changed · removed,
   data, apps, decisions, not included), before → after, in plain words — the design the owner
   approved at spec is what it is measured against. Nothing moved → the one line
   `The audit changed nothing in the design you approved.`
2. **What the pass found**, in plain language, grouped **contract-changing / design-affecting /
   stale-spec / nits**, with data-integrity items and anything breaking for a released build called
   out separately and first; the OPEN decisions it raised, each with its recommendation.
3. The next command — **never "another pass"** — and the footer:

```
Full spec: <folder>/SPEC.md
Pick up where you left off any time: /builder:resume --path <folder>
  (if this session ends, or to spec several features before building any of them)

📍 <feature>: audited — how do you want it built?
   1. Agent — sent to agents who plan, build, walk, sign off and verify it, and merge it on their own; you get the review of what landed
   2. Step by step — carry on here one step at a time (next: the plan and your go-ahead to build), pausing for you at each decision and for your walk
   3. In this session — plan it, then build it right here in this session, without the agents or the extra review rounds
   Reply 1, 2 or 3 — "go" is 1.
```

Append ` · BLOCKED: <n> items` after `audited` when the verdict is BLOCKED. The numbered form is
REFERENCE §The two-way footer: no `/builder:*` command on an option line, and "go" is option 1.
Without a config `agent_walk:` block there is no **Agent**: **Step by step** is `1.`, **In this
session** `2.`, and the reply line reads `Reply 1 or 2 — "go" is 1.`

**Under `--auto`** no delta is printed (REFERENCE §The review — nobody approves): one line with the
counts, then the footer. The plan's go-ahead and the walk show what moved. **Under `--agent-walk`**, with no
OPEN §Decisions row and no `blocked:` row, go straight on into `/builder:plan --path <folder> --auto
--agent-walk` in this turn (REFERENCE §Under `--auto` and `--agent-walk`: adjacent steps run as one).

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — on a
numbered footer, option 1 (Agent, where it is offered) — never ask the human to paste it. REFERENCE
§Continuing on "go" has the exceptions.
