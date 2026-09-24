---
name: audit
description: Verify a feature spec (docs/features/<feature>/SPEC.md) against all four MakeReady codebases before any code is written — per-app layer and house-pattern compliance (server routes/services/RBAC, client islands/stores/proxy, iPhone AppState/Actions/Routes), schema and lifecycle check, the CROSS-APP CONTRACT audit (producer/consumer parity, breaking changes for shipped iPhone builds, wrong "not affected" claims), component coverage per consumer, replaced-surface and adjacency check, and an adversarial gap hunt — writing findings into SPEC's §Findings & risks and open questions into §Decisions. First code-facing step of the /builder:* pipeline; capped at ONE pass (a second, scoped pass only when pass 1 changed a contract), with anything still uncertain carried into the build as a build-time risk. Use when the user asks to audit, verify, or gap-check a feature spec.
---

# `/builder:audit` — the spec meets four codebases, once

Invocation: **`/builder:audit --path <folder> [--ticket <monday id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

**Load REFERENCE before starting**, and cite it rather than restate it: §House rules is sweep 1's
checklist · §SPEC.md gives the §Findings / §Decisions shapes and the `build-time risk` convention ·
§Apps and §Contract and the contract freeze are sweep 3's subject · §MANIFEST.md is the file written at
the end · §Prototype mode holds the three-way choice · §Standing traps holds the ones this step pays for
· §Agent model tiering sets the model per item. Fingerprints and surface enumeration:
[`SURFACE-CHECK.md`](../resume/SURFACE-CHECK.md).

Input: `<folder>/SPEC.md` + `<folder>/MANIFEST.md`; output: the spec corrected in one write plus the
manifest (§Exit). **Read-only against app code** — `server/`, `client/`, `iphone/` and `capture/` are
never edited here, and neither is a UI 2.0 contract, registry row or note.

Findings are **rows, not essays**: the claim, the evidence (`file:line` where load-bearing), the
resolution. A spec statement the code contradicts is **fixed in place** — no dated markers, no
strikethrough, no per-pass narrative file. An open question with more than one defensible answer is an
OPEN §Decisions row with a recommendation.

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node .claude/scripts/list-feature-specs.mjs --json` and offer only the folders
whose state is `spec` or `aligned`.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` — the folder shipped and was condensed, or it is a pre-builder layout (REFERENCE §Condense) | this step does not run on it. Say so in one line, hand back to `/builder:resume --path <folder>`, which offers the conversion, and stop |
| `state: spec`, and no `ui2:` line or `ui2: none` | run — written-spec mode: sweeps 1–6 |
| `state: spec` **and** a `ui2: <ref> …` line | prototype mode, not yet aligned — `/builder:align` runs first. One line, hand back to `/builder:resume --path <folder>`, stop |
| `state: aligned` | run — prototype mode: sweeps 1–6 **plus** items 7–10 |
| `state: audited` | the pass is spent. Only the cap's scoped second pass below runs; otherwise one line, hand back, stop |
| `state:` anything past `audited` (`planned`, `building`, …) | say so naming the state, hand back, stop |

Handing back is that one line plus the footer below, carrying the manifest's own `state`.

**Prototype mode is the manifest's `ui2:` line being anything other than `none`.** Its **in-scope rows
are the ones `<folder>/SPEC.md` §Prototype lists**. Read that list; **never re-resolve the ref**,
because the registry moves and re-resolving can widen a scope that was settled at design.

## 🔴 The pass cap

**Reading prose about code has a hard ceiling.** Measured on the pipeline this replaced: twelve reading
passes and 164 findings on one feature surfaced none of its four real defects — all four came from
running the software, and building one phase found five spec defects those twelve passes had missed.

| Pass | When | Scope |
|---|---|---|
| 1 | always | the sweep below — **a single agent at the manifest's `size: md`; parallel agents, one per app, only at `size: lg`** |
| 2 | only if pass 1 changed a **contract** (a §Contract row, a schema row, a component API, a permission, a push payload) | the changed contracts and what keys on them — nothing else |
| 3+ | ⛔ never | — |

A pass never audits the previous pass's corrections — if a correction is wrong, the build finds it in
minutes. Anything still uncertain when the cap is spent becomes a §Findings row marked
**`build-time risk`** naming the phase/task that settles it; `/builder:plan` copies the note onto that
task. It is not a blocker and never a reason for another pass.

## The sweep (one pass, all of it; agent tiering per REFERENCE)

**1. Layers & house patterns, per app** — check each in-scope app's section against REFERENCE
§House rules and that app's own `CLAUDE.md`:

- **server** — right layer for each unit (routes thin, services own logic); org-scoped RBAC checked in
  the **service** layer and 🔴 **by the org-level check, not `creatorId`** — a creator-identity check
  locks out org leaders and is a live bug class here; zod on every mutating body, and it must not strip
  fields the consumer sends; schema changes go through `server/schema/*.yaml` + `schema:diff`, never a
  hand-edited migration; external integrations behind their service module; nothing sensitive logged.
- **client** — islands into Blade rather than an SPA; Pinia domain store for API data, UI store for view
  state, no component-level `fetch`; admin calls through the `/admin/api/{path}` proxy with `connect.sid`
  forwarding; design-token SCSS only; 🔴 no `window.confirm`/`alert`/`prompt`.
- **iphone** — `@Observable` + Actions; every shared or mutated server-derived collection in `AppState`
  (`EntityStore` when it has identity), and a mutating Action refreshing derived state in the same call;
  no `APIClient` from Pages or Components; overlays through the typed `Route` system — 🔴 never
  `.sheet`, `.fullScreenCover` or `asyncAfter` choreography; errors routed deliberately.
- **capture** — fixtures manifest-driven, twins additive-only and registered, BEM root checked for a
  collision with a legacy web component.

Spot-verify that the spec's named baselines actually exist with the claimed shapes. **In either mode, a
decision stated in the spec's prose with no §Decisions row is a finding** — an unrecorded ruling is
re-litigated mid-build.

**2. Schema & lifecycle** — every §Schema row has a reason and a migration path (a `server/schema/*.yaml`
edit plus `npm run schema:diff`, never a hand-edited migration); REMOVE / NOT-NULL rows have a Data plan
with a named decider; then the lifecycle hunt: dependent rows on delete/restore, unique-constraint races,
enum membership against the live Prisma enum, indexes the query plan needs, and **what the disk-cached
iPhone copy of this data does when the shape changes**. A change the feature needs with no row is a
finding, and so is a §Schema & API changes section missing either the explicit dated **"No schema change
(established YYYY-MM-DD)"** line or, when it owes rows, the `**Data plan:**` line and the ordering — even
as "independent". Silence reads as nobody having checked.

**3. 🔴 The cross-app contract audit** (`opus`) — the sweep this monorepo exists to have, and the one
whose misses ship. Four checks:

- **Producer/consumer parity.** For every §Contract row: the producer app implements exactly that
  shape, and **every consumer the row names codes against exactly that shape**. A field the server
  returns that no consumer reads is a question; a field a consumer expects that the server does not
  send is a defect. Trace it, don't assume it.
- **Breaking changes for a SHIPPED iPhone build.** 🔴 The most expensive finding class in this repo.
  Any rename, removal, type change, nullability change or enum narrowing on a field a released build
  reads is breaking, and needs a stated transition in §Apps *Backward compatibility* — not a sentence
  saying users will update. Additive is safe; say which each change is.
- **Wrong "not affected" claims.** Every ⬜ row in §Apps is a claim to CHECK, not a fact. Re-derive it
  against the root `CLAUDE.md` §Cross-App Impact Guide and against the code: does this change type
  reach that app? A ⬜ that should be ✅ is a finding **and** a §Apps correction in the same write.
- **Consumer divergence.** Where the client and iPhone deliberately differ, the spec says so; where
  they differ by accident, that is a finding. The two consumers never import each other, so nothing
  else catches it.

A finding here is tagged `contract:` in §Findings, and 🔴 **an unresolved one blocks the plan step** —
it is written as a `blocked:` row (§Exit), because building a consumer against a contract nobody
verified is the failure this sweep prevents.

**4. Component coverage, per consumer** — inventory what exists NOW: `iphone/MakeReady/Components/`
for iOS, `client/ui/` for web, and the **UI 2.0 registry** for 2.0 work. Every view element in §Client
and §iPhone maps to a real component whose **props actually fit**, or a **(new)** row. A 2.0 element
with no registry row is a **registry defect** — a dated row addition plus a spec amendment, routed to
`/ui2-component`, never an inline invention. Loading / empty / error / permission-denied states
specified per view; destructive actions confirm — and on the client, through the confirm-dialog
service, never a native browser dialog. A surface that exists on both consumers and diverges silently
is a finding (sweep 3, consumer divergence).

**5. Adversarial gap hunt** (`opus`) — walk each flow end-to-end hunting unspecified behavior: auth
boundaries, **org isolation** (any externally-supplied entity id is adversarial until ownership-checked,
and the check is the org-level one), empty/missing data, idempotence and double-submit, concurrency,
partial failure mid-transaction, pagination, rate limiting, timezones, seeds/fixtures, **offline and
stale disk cache on iPhone**, **push payload and deep-link target**, and what an error renders as on
each consumer. Grade §Testing against what this hunt surfaced — missing coverage at the right layer is
a finding. Two probe rules: **inherited design docs are audit input, not trusted ground** — their
invariant tables get the same walk; and **join every new fact against the tables keyed on it** and ask
what they now produce.

**6. Replaced surfaces & adjacency** — if the feature absorbs live surfaces, §Client and §iPhone must
name each surface and every capability it has today (covered / dropped-on-purpose) — a feature can be
100% built and still delete capabilities users have; nothing replaced is a one-line statement, not a
gap. 🔴 **A surface exists up to three times here** — a SwiftUI screen, a Vue island, a `/compare`
twin — and the inventory covers all three. Then walk the edges: how users arrive (deep links, push
payloads, invite URLs, QR codes, nav), where they go after, and which shared surfaces (login, phone
verification, org switching) it silently assumes — a missing edge is a finding or an OPEN decision,
never an assumption.

## Prototype mode adds — items 7–10

Same pass, not a second one. Each item is named in the exit verdict with what clears it.

**7. The contracts are read, in full, and their open questions disposed** (`sonnet` sweep, `opus`
verdicts) — for every row in §Prototype: its contract file, its designed states and variant axes, its
props, its tokens, and each `OQ-C-###-n`. 🔴 **Every open question gets a disposition**: answered by a
§Decisions ruling, carried as a §Findings row naming the task that settles it, or explicitly out of
scope with a decider. An OQ nobody disposed of is a mid-build surprise, and it is a finding.
**Read the notes with the tool** — `node capture/lib/ui2-notes.mjs read` — because a PENDING note is
an owner ruling this spec may not yet reflect; a note that contradicts the spec is a finding routed to
`/d2m-notes-assimilate`, never edited here.

**8. The render matches the design, for a BUILT row** — the row's captured preview against its frozen
Figma snapshot:

```
node capture/runners/compare/diff.mjs …          # advisory %, hot bands, delta PNG
```

An unbuilt row is not a failure: say so, and note that its states have never been seen, which is a
`build-time risk` on its first task. 🔴 **Never start or stop a server, and never build a preview to
make this item pass** — `/ui2-component-build` owns that, offered as an option. Capture not answering
on `:5950` → the item is **BLOCKED on environment**, said in the verdict with `/capture-start` as what
clears it; never silently skipped, never reported as PASS.

**9. Enumerate the repoint callers** — the audit *inventories* them; it compares nothing. Per surface
marked REPLACES or ABSORBS, re-grep each app for its **route strings, `Route` cases, imports, deep
links and push payload targets**, and write what you find as a tagged §Findings row per surface, with
its owning app:

```
| R1 | repoint (iphone): <surface> ← <file:line>, <file:line>, … | builder:plan's repoint + retire phase |
```

`/builder:plan` turns each `repoint` row into tasks in that app's phase, and `/builder:verify` re-greps
the same surfaces to zero. **A surface with no hits gets a row saying so** — an absent row reads as
nobody having looked. A surface whose fingerprint sha moved since design is re-enumerated first — that
surface only (`SURFACE-CHECK.md`).

**10. Obligations disposed** — exit 0 means every `N#` has a disposition, every DDL-implying `T#` has
its `SC#`, every app has its §Apps row, and every §Contract row names a consumer. A non-zero exit names
its own rows; settle them in the SPEC edit:

```
node .claude/scripts/check-flow-obligations.mjs <folder>
```

🔴 **Run this in written-spec mode too** — items 1–6 end with it. Its §Apps and §Contract obligations
are not prototype-specific, and they are the cheapest cross-app check this pipeline has.

## A gap this pass finds in the design

The design is the requirements, so a gap against it is resolved before the go-ahead rather than filed.
Take **REFERENCE §Prototype mode's three-way choice** — *fix it in the design* · *write it into the
SPEC* · *out of scope* — **one gap per turn, recommendation first** (AskUserQuestion), the same gap at
several sites counted as one gap with its sites listed.

- **"Fix it in the design"** routes to the command that owns it — `/ui2-component-update` for a
  contract change, `/ui2-resolve` for a preview that disagrees with Figma, `/d2m-notes-assimilate` for
  a pending owner note — and this run **re-reads** the contract before the next gap. 🔴 This step never
  writes a contract, registry row or note itself.
- **`--auto`** takes the recommendation and records it in §Decisions as `auto (recommended)
  YYYY-MM-DD`, under REFERENCE §Prototype mode's rule for what may be recommended.
- **A defect in APP code** is reported with a doc-fix vs code-fix recommendation and asked; under
  `--auto` the doc fix lands now and the code fix becomes a `build-time risk` row naming the task that
  settles it. **No monday ticket is opened unprompted** — that is `/monday-ticket`'s, and it is the
  human's call.

## Exit

**One SPEC edit, at the end of the pass**: corrections in place (including §Apps rows this pass
proved wrong), §Findings & risks rows, OPEN §Decisions rows with recommendations, and `build-time risk`
on anything the cap leaves unsettled.

**The manifest** (REFERENCE §MANIFEST.md): `state: audited`, `head` (the sha at this transition),
`branch`, `apps:` refreshed if sweep 3 corrected §Apps, and `next: /builder:resume --path <folder>` —
one command either way, because the orchestrator routes to the decisions gate when §Decisions has OPEN
rows and to `/builder:plan` when it does not. Commit the SPEC and the manifest **together**:
`docs(<ticket-or-feature>): <feature> audited` — the key is `--ticket` when given, else the manifest's
`ticket:`, else the feature name.

**The hand-off carries a `READY` / `BLOCKED` line** over the contract sweep and, in prototype mode,
items 7–10 plus the `S#` closure — every `S#` in §Replaced surfaces COVERED, DROPPED **with a named
decider**, or carried by a decided §Decisions row; no decider means still open. **Every BLOCKED item is
also a tagged §Findings row**, because a hand-off line dies with the session:

```
| B1 | blocked: <item> — clears when <what> | audit exit |
```

`/builder:plan` refuses to start while a `blocked:` row stands, and `/builder:resume` routes such a
folder to the clearers named in the rows. BLOCKED is not a failed audit: the manifest is still
`state: audited` with the same `next:` line.

Standard handoff (`builder:resume` §Step-end handoff): what the pass found in plain language, grouped
**contract-changing / design-affecting / stale-spec / nits**, with data-integrity items and anything
breaking for a shipped iPhone build called out separately and first; the next command — **never
"another pass"** — and the one-line resume footer:

```
📍 <feature>: audited — next: /builder:resume --path <folder>
```

Append ` · BLOCKED: <n> items` when the verdict is BLOCKED.
