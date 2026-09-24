---
name: align
description: Prototype-mode step of the /builder:* pipeline, between design and audit — trace every field the in-scope UI 2.0 contracts and fixtures persist to its Prisma model column, zod schema, wire name, endpoint and service write path, and onward to the AppState property or Pinia store the consumer reads it from, then record what the app lacks as SC# rows in SPEC §Schema & API changes and T# rows in §Findings. Runs only when the manifest carries a ui2: line. Never edits app code and never edits a UI 2.0 contract — a naming disagreement leaves as a row or an OPEN decision. Use when the user asks whether the server can store what a design collects, to align design naming with the app, or invokes /builder:align.
---

# `/builder:align` — can the app store this, and does everyone call it the same thing?

Invocation: **`/builder:align --path <folder> [--ticket <monday id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — flags first, free text after them is the work, and
**ignore any flag this step does not use rather than erroring on it**.

**Load REFERENCE before starting**, and cite it rather than restate it: §Prototype mode's "Then
**align** …" paragraph is this step's contract · §SPEC.md says where `SC#` and `T#` land · §Contract and
the contract freeze is what this step's output becomes · §MANIFEST.md is the file written at the end ·
§Standing traps holds the three this step pays for (the N1 miss, naming matches the LAYER, structure
over content) · §Agent model tiering sets the per-phase model.

**Precondition — read `<folder>/MANIFEST.md` first.** Without `--path`, run
`node .claude/scripts/list-feature-specs.mjs --json` and offer only the folders whose manifest carries a
`ui2:` line.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` (shipped and condensed, or a pre-builder layout) | nothing to align. Say so in one line, hand back, stop |
| no `ui2:` line, or `ui2: none` | not prototype mode — a written spec has no design to align. Say so in one line, hand back, stop |
| `state:` anything past `spec` (`aligned`, `audited`, …) | already aligned. Say so in one line naming the state, hand back, stop |
| `ui2: <ref> …` **and** `state: spec` | run |

Handing back is that one line plus the footer below, carrying the manifest's own `state`.

**Scope is the manifest's `ui2:` line** — the resolved rows, settled at design. Never re-ask it, never
re-resolve it.

🔴 **This step writes to the feature folder and NOTHING ELSE.** Not `server/`, not `client/`, not
`iphone/`, not `capture/`, not a migration — and **not the design layer either**: a UI 2.0 contract,
registry row, note or open question belongs to `/ui2-*` and `/d2m-*`, and a rename that ought to happen
in the design leaves here as an OPEN §Decisions row naming the command that would make it. What the app lacks, misnames or mis-shapes leaves as a row, not a commit. **`--auto`
changes nothing here**: this step asks nothing, and the things it cannot decide stay OPEN rows.

## Phase 1 — Harvest what the design persists (`sonnet`)

**The in-scope rows are the ones `<folder>/SPEC.md` §Prototype lists.** Read the list from there; never
re-run `list-ui2-refs.mjs`, because the registry moves and re-resolving can widen a scope that was
settled at design.

Per row, from its **contract** and — where the row is built — its **fixture**
(`capture/fixtures/ui2/C-###.json`, the de-facto payload shape a real screen would hand it):

- every persisted field: name, type, required, enum members;
- every derived value the server must reproduce (a service capability, not a field);
- every relationship with its cardinality;
- **every key the fixture carries** — that object is what the built preview renders from, so each key is
  a field the real screen will need from somewhere;
- and, from **§Replaced surfaces *Adds* (`N#`)**, every capability that persists state **without being a
  field** — a parked draft, a saved filter, a per-member read position.

For each, ask: *where does it live when the app is closed?* No answer → a `T#` and its `SC#` (and
usually a `D#` first). That question is the defence against the N1 miss (REFERENCE §Standing traps) — a
field-by-field harvest walks straight past state that is not a field. New state spanning domains takes
one structure: common columns plus a per-kind JSON payload, and no native PG enum for an open set.

🔴 **Read the row's notes with the tool** — `node capture/lib/ui2-notes.mjs read` — before harvesting.
A pending owner note can add or retract a field, and reading notes by eye is how one gets missed.

## Phase 2 — Map onto the app (`opus` — tracing, not grepping)

Per field, follow the chain all the way to the consumer that renders it. **The chain has five links in
this monorepo, and the last one is the one a single-app pipeline doesn't have:**

```
Prisma model (server/prisma + server/schema/*.yaml)
  → zod schema (the route's validation, and what it does NOT strip)
  → wire name (what the endpoint actually returns)
  → endpoint + service write path (server/src/routes, server/src/services)
  → the consumer's own model: AppState entity property (iphone) · Pinia store field (client)
```

One verdict per field: **ALIGNED · RENAME · RESHAPE · MISSING · DESIGN-ONLY**.

- **The app wins for anything that exists** — names, enum members, units, nullability. The design wins
  only for what does not exist yet.
- **Naming matches the LAYER**: camelCase Swift or TS beside snake_case wire payloads can be correct,
  and the transform is explicit. A layer-appropriate difference is ALIGNED, not RENAME. What is **not**
  correct is a difference nobody wrote down.
- **Check the zod schema, not just the Prisma model.** A field that exists on the model and is silently
  stripped by the route's zod schema is MISSING from the consumer's point of view — and it is a real
  past bug here, not a hypothetical.
- 🔴 **Trace to BOTH consumers when §Apps marks both in scope.** A field the iPhone app reads from an
  `AppState` property and the web reads from a Pinia store is two mappings, and they diverge silently.
  A divergence that is deliberate is a §Decisions row; one that is accidental is a `T#`.
- **Check what a RELEASED iPhone build already stores.** A RESHAPE on a field a shipped build holds in
  its disk cache is a migration problem on the device, not only on the server — note it, and it becomes
  §Apps *Backward compatibility*.
- Shapes are checked against the house forms: money is a decimal plus a currency, ids are UUIDs,
  value-over-time is a history row, an enum must match the server's members.

## Phase 3 — Write SPEC and the manifest (one edit)

**§Schema & API changes** is the `SC#` ledger (REFERENCE §SPEC.md — same columns): one row per DDL or
wire change, `| # | ADD/EDIT/RENAME/REMOVE | Model.column | Wire | Reason | Status |`, the **Reason
citing the contract field that drove it**. Below it, the `**Data plan:**` line for anything touching
existing rows (a REMOVE or a NOT-NULL EDIT must appear there, with a named decider) and the ordering
when the migrations are not independent. Owing nothing, write **"No schema change (established
YYYY-MM-DD)"** explicitly — silence reads as nobody having checked.

**§Contract** gains the endpoint rows this alignment implies — the shape each consumer will code
against, with its consumers named. It is not frozen yet; the server phase's close freezes it. Writing
it now is what lets the audit check parity before a line of code exists.

**§Findings & risks** takes the backend worklist, one row per item, tagged `T#`, **named by layer and
by app** — `| T1 | server: model + migration for Note | blocking |`,
`| T4 | iphone: AppState entity + Action for notes | trailing |`. A `T#` whose app is a consumer is
what tells `/builder:plan` which phase it lands in.

Every DDL-implying `T#` has its `SC#`; a service-only `T#` has none. Prove that rather than trusting
it, and fix what it names before handing off:

```
node .claude/scripts/check-flow-obligations.mjs <folder>
```

Then the manifest (REFERENCE §MANIFEST.md): `state: aligned`, `next: /builder:resume --path <folder>`,
`head` (the sha at this transition), `branch`, and `apps:` refreshed if the trace proved a consumer in
or out of scope. Commit the manifest **with** the SPEC edit: `docs(<ticket-or-feature>): <feature>
aligned`.

## Hand off

Lead with the two counts that decide what happens next: **fields aligned** — persisted fields whose
verdict is ALIGNED — and **backend items owed**, the `T#` count, which says whether this feature is days
or weeks from buildable. Then **one line per app**: what it owes and why. Name the OPEN §Decisions rows
this step opened, since they block the go-ahead — including any rename that ought to happen in the
design rather than the app, with the `/ui2-*` command that would make it.

```
📍 <feature>: aligned — <n> fields aligned, <m> T# owed (<per-app split>) — next: /builder:resume --path <folder>
```
