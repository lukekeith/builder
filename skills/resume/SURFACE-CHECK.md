# The surface check — what is this replacing, and what can each side do that the other can't?

The procedure behind prototype-mode discovery. Artifact: **SPEC.md §Replaced surfaces** (shape in
[REFERENCE.md](REFERENCE.md) §SPEC.md — the surface table with fingerprints, then the `S#` rows, then
the `N#` rows, each with a disposition and an owning app). The design step writes this section into
SPEC; a stateless caller (`builder:check`) reports the rows in its punch list instead.

Three questions — the last two are the value:

1. **Which live surfaces does this feature replace?** (multi-modal discovery — one grep always misses)
2. **What can those surfaces DO that the new design can't?** → `S#` gap rows
3. **What does the DESIGN specify that the app can't do?** → `N#` add rows — the feature's whole
   point, and the class a build must budget new producer work for

This is distinct from coverage (design → its own conventions), journey edges (feature → outward), and
alignment (fields → columns). A feature can be green on all three and still delete a capability at
cutover; this check is what catches that, at the cheapest moment to learn it.

🔴 **In a multi-app repo a surface exists once per consumer**, and those copies are not
interchangeable. A surface check that inventories one of them is the incomplete one — and where the
config marks a consumer `released_artifact: true`, that is the copy nobody can hot-fix.

## Phase A — Discover (every applicable angle; each finds surfaces the others miss)

1. **The design's own claims** — whatever the contract says it replaces, and a registry status that
   names an existing component directly. Highest yield per minute; treat as leads to confirm, never as
   the answer.
2. **Per consumer: the screens and their routes.** Use the config's `apps:` paths and that app's
   §House rules to know where screens live and how they are registered. A surface presented as an
   overlay with no route of its own is the one most often missed.
3. **Per consumer: the state.** A capability often lives in a store or a state container rather than
   in a screen.
4. **The producer.** The endpoint and service backing the surface; a retirement leaving an endpoint
   with no caller is a finding, not a tidy-up.
5. **Tools.** Any visual-regression or fixture entry pinned to this surface. A retired surface with a
   live check leaves that check asserting against nothing.
6. **Entry points** — links, CTAs, deep links, notification payloads carrying a target, invite or
   share URLs. Replacing a surface must not strand a caller, and a notification target has to keep
   existing.
7. **Tests as a surface spec** — the tests touching those files: the cheapest functionality list, and
   the retirement list at cutover.

Classify the relationship: **REPLACES** (retires at cutover — full enumeration owed) · **ABSORBS**
(enumerate the absorbed part; name the seam) · **REUSES** (no enumeration; don't retire it) ·
**ADJACENT** (a journey edge, not a replaced surface) · **NONE**. *"It replaces nothing"* is a valid,
valuable answer — record it as the finding; don't invent a surface.

## Phase B — Enumerate each REPLACES/ABSORBS surface

**B.0 — Structure over content, always.** Structure is critical; content is not: a missing
*capability* (typed objects, attribution, linking, history, upload, delete, recovery) is architecture —
CRITICAL; picker *membership* ("11 categories vs 5") is usually drift — LOW, demoted, never headlined.
**The breadth trap:** a value existing in the producer's schema is not proof the live UI offers it —
confirm against the rendered surface's options, or the claim becomes fiction.

**B.1 — Both directions.** App→design gaps become `S#` rows. Design→app adds become `N#` rows — a
field-by-field harvest walks past these (a parked draft, a saved filter: state with no column on any
model). **Every `N#` gets its disposition in the same sitting**: a `T#`/`SC#`/`D#` id, or the words
"no backend implication" plus why. The question: *where does this live when the app is closed?*
Enforced by `check-obligations.mjs`.

**B.2 — The per-surface checklist:** affordances (buttons, menus, gestures, inline edit) · states
(loading, empty, each error class, permission-denied) · list mechanics (search, filter, sort,
pagination, reorder, bulk select — the highest-frequency real gaps) · **offline or cached behaviour**,
where a consumer has any — an axis its siblings may not share · the **link contract** (the route, the
URL, the notification target) · **role gating** — what one role sees that another doesn't; designs
almost never model roles · reachable calls · validation · side effects (toasts, cache invalidation,
undo, autosave, a state refresh) · accessibility.

Verdicts: **COVERED** (name the designed state) · **MISSING** (`S#`) · **DROPPED** (needs a reason AND
a named decider — no decider = MISSING; this valve is what keeps the list honest) · **N/A** (an
implementation artifact).

## Phase C — The per-app disposition

Each `S#` and `N#` gets the app that owns it, from the config's `apps:` — that is what routes it into
a phase later. A row owned by two apps is two rows, one per app, since phases are one app at a time. A
row whose app is marked `released_artifact: true` and whose surface ships today carries the
backward-compatibility note from §Apps.

## Phase D — Write the section

SPEC §Replaced surfaces: the surface table with a **fingerprint** (last commit sha) per surface, then
the `S#` rows, then the `N#` rows, each with its disposition and its owning app. One SURFACE is the
bounded unit — write its rows before enumerating the next. No coverage percentage, no per-surface
narrative: the rows are the record.

**Staleness (how a later run verifies in seconds):** re-fingerprint each surface
(`git log -1 --format=%h -- <path>`); an unchanged sha means the rows are still accurate, skip it.
Re-run full discovery only when the selection changed or a new surface appeared in the domain — the
one thing a fingerprint can't detect.

**Consumers:** the design step reads it instead of re-reconning (its retirement list must agree — a
disagreement is a finding); the journey-edge sweep inherits the ADJACENT rows; `builder:verify` blocks
on an open `S#`; the plan's repoint/retire phase IS the REPLACES rows, split per app; `builder:check`
runs this procedure standalone for an author who has not entered the pipeline.
