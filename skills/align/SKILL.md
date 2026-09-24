---
name: align
description: Prototype-mode step of the /builder:* pipeline, between design and audit — trace every field the in-scope design contracts persist through the producer's model, validation, wire shape and write path, and onward to the property each consumer reads it from, then record what the app lacks as SC# rows in SPEC §Schema & API changes and T# rows in §Findings, tagged by owning app. Runs only when the manifest carries a design ref. Never edits app code and never edits the design source — a naming disagreement leaves as a row or an OPEN decision. Use when the user asks whether the backend can store what a design collects, to align design naming with the app, or invokes /builder:align.
---

# `/builder:align` — can the app store this, and does everyone call it the same thing?

Invocation: **`/builder:align --path <folder> [--ticket <id>] [--auto]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags.

**Load REFERENCE and `.claude/builder.md` before starting**: REFERENCE §Prototype mode's "Then
**align** …" paragraph is this step's contract, §SPEC.md says where `SC#` and `T#` land, §Contract and
the contract freeze is what this step's output becomes; the config's §House rules gives each app's
real shape and §Standing traps holds what this project has already paid to learn.

**Precondition — read `<folder>/MANIFEST.md` first.** Without `--path`, run
`node <builder>/scripts/list-features.mjs --json` and offer only the folders carrying a design ref.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` | nothing to align. One line, hand back, stop |
| no design ref, or the key is `none` | not prototype mode — a written spec has no design to align. One line, hand back, stop |
| `state:` anything past `spec` | already aligned. Say so naming the state, hand back, stop |
| a design ref **and** `state: spec` | run |

**Scope is the manifest's design key** — the resolved set, settled at design. Never re-ask it, never
re-resolve it.

🔴 **This step writes to the feature folder and NOTHING ELSE.** Not app code, not a migration, and
**not the design source**: a contract, registry row or note belongs to the commands the config's
`design.owned_by` names, and a rename that ought to happen in the design leaves here as an OPEN
§Decisions row naming the command that would make it. What the app lacks, misnames or mis-shapes
leaves as a row, not a commit. **`--auto` changes nothing here**: this step asks nothing, and what it
cannot decide stays an OPEN row.

## Phase 1 — Harvest what the design persists (`sonnet`)

**The in-scope items are the ones §Prototype lists.** Read the list from there; never re-resolve the
ref, because the design moves and re-resolving can widen a scope settled at design.

Per item, from its **contract** and — where the item has been built — whatever **fixture or sample
payload** its rendered form is driven by, which is the de-facto shape a real screen would hand it:

- every persisted field: name, type, required, enum members;
- every derived value the producer must reproduce (a service capability, not a field);
- every relationship with its cardinality;
- **every key that payload carries** — each is a field the real screen will need from somewhere;
- and, from **§Replaced surfaces *Adds* (`N#`)**, every capability that persists state **without
  being a field** — a parked draft, a saved filter, a per-user position.

For each, ask: *where does it live when the app is closed?* No answer → a `T#` and its `SC#` (and
usually a `D#` first). That question is the defence against the N1 miss — a field-by-field harvest
walks straight past state that is not a field. New state spanning domains takes one structure.

🔴 **Where the design system carries owner notes, read them with the tool the config names** before
harvesting. A pending note can add or retract a field, and reading notes by eye is how one gets
missed.

## Phase 2 — Map onto the app (`opus` — tracing, not grepping)

Per field, follow the chain **all the way to the consumer that renders it**. The last link is the one
a single-app pipeline doesn't have:

```
the producer's model
  → its validation layer (and what that layer does NOT let through)
  → the wire shape the contract actually returns
  → the endpoint and the write path
  → the property each CONSUMER holds it in
```

One verdict per field: **ALIGNED · RENAME · RESHAPE · MISSING · DESIGN-ONLY**.

- **The app wins for anything that exists** — names, enum members, units, nullability. The design wins
  only for what does not exist yet.
- **Naming matches the LAYER**: a different case convention on each side of the wire can be correct,
  and the transform is explicit. A layer-appropriate difference is ALIGNED, not RENAME. What is **not**
  correct is a difference nobody wrote down.
- **Check the validation layer, not just the model.** A field that exists on the model and is silently
  stripped on the way in or out is MISSING from the consumer's point of view — the config's §House
  rules may already name this as a known class.
- 🔴 **Trace to EVERY consumer §Apps marks in scope.** The same field held in two consumers is two
  mappings, and they diverge silently. A deliberate divergence is a §Decisions row; an accidental one
  is a `T#`.
- **Check what a RELEASED build already stores.** For any app the config marks
  `released_artifact: true`, a RESHAPE on a field it caches is a migration problem on the device, not
  only on the producer — note it, and it becomes §Apps *Backward compatibility*.
- Shapes are checked against the house forms the config's §House rules and §Standing traps name.

## Phase 3 — Write SPEC and the manifest (one edit)

**§Schema & API changes** is the `SC#` ledger: one row per data or wire change,
`| # | ADD/EDIT/RENAME/REMOVE | Model.field | Wire | Reason | Status |`, the **Reason citing the
contract field that drove it**. Below it, the `**Data plan:**` line for anything touching existing
rows (a REMOVE or a NOT-NULL EDIT must appear there, with a named decider) and the ordering when the
migrations are not independent. Owing nothing, write **"No schema change (established
YYYY-MM-DD)"** explicitly — silence reads as nobody having checked.

**§Contract** gains the rows this alignment implies — the shape each consumer will code against, with
its consumers named. It is not frozen yet; the producer's phase close freezes it. Writing it now is
what lets the audit check parity before a line of code exists.

**§Findings & risks** takes the backend worklist, one row per item, tagged `T#`, **named by layer and
by app** — `| T1 | <producer>: model + migration for X | blocking |`,
`| T4 | <consumer>: the state entity and its mutation | trailing |`. A `T#` whose app is a consumer is
what tells `/builder:plan` which phase it lands in.

Every DDL-implying `T#` has its `SC#`; a service-only `T#` has none. Prove that rather than trusting
it, and fix what it names before handing off:

```
node <builder>/scripts/check-obligations.mjs <folder>
```

Then the manifest: `state: aligned`, `next: /builder:resume --path <folder>`, `head`, `branch`, and
`apps:` refreshed if the trace proved a consumer in or out of scope. Commit the manifest **with** the
SPEC edit: `docs(<ticket-or-feature>): <feature> aligned`.

## Hand off

Lead with the two counts that decide what happens next: **fields aligned** — persisted fields whose
verdict is ALIGNED — and **backend items owed**, the `T#` count, which says whether this feature is
days or weeks from buildable. Then **one line per app**: what it owes and why. Name the OPEN
§Decisions rows this step opened, since they block the go-ahead — including any rename that ought to
happen in the design rather than the app, with the command that would make it.

```
📍 <feature>: aligned — <n> fields aligned, <m> T# owed (<per-app split>) — next: /builder:resume --path <folder>
```
