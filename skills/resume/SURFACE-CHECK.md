# The surface check — what is this feature replacing, and what can each side do that the other can't?

The procedure behind prototype-mode discovery. Artifact: **SPEC.md §Replaced surfaces** (shape in
`REFERENCE.md` §SPEC.md — the surface table with fingerprints, then the `S#` rows, then the `N#` rows,
each with a disposition). The design step writes this section into SPEC; a stateless caller
(`builder:check`) reports the rows in its punch list instead of creating a file.

Three questions — the last two are the value:

1. **Which live surfaces does this feature replace?** (multi-modal discovery — one grep always misses)
2. **What can those surfaces DO that the new design can't?** → `S#` gap rows
3. **What does the DESIGN specify that the app can't do?** → `N#` add rows — the feature's whole
   point, and the class a build must budget new server work for

This is distinct from coverage (design → its own conventions), journey edges (feature → outward), and
backend alignment (fields → columns). A feature can be green on all three and still delete a
capability at cutover; this check is what catches that, at the cheapest moment to learn it.

🔴 **In this monorepo a surface exists up to three times** — a SwiftUI screen, a Vue island or Blade
page, and a `/compare` twin — and they are not interchangeable. A surface check that inventories only
one of them is the incomplete one, and the iPhone side is the one that cannot be hot-fixed after it
ships.

## Phase A — Discover (every applicable angle; each finds surfaces the others miss)

1. **The design's own claims** — the UI 2.0 contract's *replaces* / *legacy candidate* notes and the
   registry row's `existing` / `existing-modified` status, which names the legacy file directly.
   Highest yield per minute; treat as leads to confirm, never as the answer.
2. **iPhone** — `iphone/MakeReady/Pages/**` and `Components/**` for the flow's domain, plus the typed
   `Route` cases that present them (an overlay with no page file is the one most often missed).
3. **Client** — `client/routes/web.php` for the route, `client/resources/views/**` for the Blade page,
   `client/resources/js/**` for the island, `client/ui/**` for the component.
4. **State** — `iphone/MakeReady/State/` (`AppState`, its entity stores, the Actions) and
   `client/resources/js/stores/**` (Pinia domain + UI stores). A capability often lives in a store
   rather than in a screen.
5. **Server** — the route module and service that back the surface; a retirement that leaves an
   endpoint with no caller is a finding, not a tidy-up.
6. **Capture** — `/compare` comparisons, twins and fixtures for the surface. A retired surface with a
   live twin leaves the twin asserting against nothing.
7. **Entry points** — links, CTAs, deep links, push payloads with a deep link, invite URLs, QR codes.
   Replacing a surface must not strand a caller, and a push deep link points at a `Route` case that
   has to keep existing.
8. **Tests as a surface spec** — the route tests, component tests and `/compare` diffs touching those
   files: the cheapest functionality list, and the retirement list at cutover.

Classify the relationship: **REPLACES** (retires at cutover — full enumeration owed) · **ABSORBS**
(enumerate the absorbed part; name the seam) · **REUSES** (no enumeration; don't retire it) ·
**ADJACENT** (a journey edge, not a replaced surface) · **NONE**. *"It replaces nothing"* is a valid,
valuable answer — record it as the finding; don't invent a surface.

## Phase B — Enumerate each REPLACES/ABSORBS surface

**B.0 — Structure over content, always.** Structure is critical; content is not: a missing
*capability* (typed objects, attribution, linking, history, upload, delete, recovery) is architecture —
CRITICAL; picker *membership* ("11 categories vs 5") is usually drift — LOW, demoted, never headlined.
**The breadth trap:** an enum member existing in the server's Prisma schema is not proof the live UI
offers it — confirm against the rendered surface's options, or the claim becomes fiction.

**B.1 — Both directions.** App→design gaps become `S#` rows. Design→app adds become `N#` rows — a
field-by-field harvest walks past these (a parked draft, a saved filter: state with no column on any
model). **Every `N#` gets its disposition in the same sitting**: a `T#`/`SC#`/`D#` id, or the words
"no backend implication" plus why. The question: *where does this live when the app is closed?*
Enforced by `check-flow-obligations.mjs`.

**B.2 — The per-surface checklist:** affordances (buttons, menus, swipe actions, long-press, inline
edit) · states (loading, empty, each error class, permission-denied) · list mechanics (search, filter,
sort, pagination, drag-reorder, bulk select — the highest-frequency real gaps) · **offline behaviour**
(what the disk cache serves when the network is gone — an iPhone-only axis the web surface has no
equivalent of) · deep-link contract (the `Route` case, the web URL, the push payload) · **role gating**
(what an Owner sees that an Admin, a Group Leader or a Member doesn't — designs almost never model
roles, and this app has five) · reachable API calls · validation · side effects (toasts, cache
invalidation, undo, autosave, an `AppState` refresh) · accessibility.

Verdicts: **COVERED** (name the designed state) · **MISSING** (`S#`) · **DROPPED** (needs a reason AND
a named decider — no decider = MISSING; this valve is what keeps the list honest) · **N/A** (an
implementation artifact).

## Phase C — The per-app disposition

Each `S#` and `N#` row gets the app that owns it — `server` · `client` · `iphone` · `capture` — because
that is what routes it into a phase later. A row owned by two apps is two rows: one per app, each with
its own disposition, since the phases are one-app-at-a-time. A row whose app is `iphone` and whose
surface ships today carries the backward-compatibility note from §Apps.

## Phase D — Write the section

SPEC §Replaced surfaces: the surface table with a **fingerprint** (last commit sha) per surface, then
the `S#` rows, then the `N#` rows, each with its disposition and its owning app. One SURFACE is the
bounded unit — write its rows before enumerating the next. No coverage percentage, no per-surface
narrative: the rows are the record.

**Staleness (how a later run verifies in seconds):** re-fingerprint each surface
(`git log -1 --format=%h -- <path>`); an unchanged sha means the rows are still accurate, skip it.
Re-run full discovery only when the component selection changed or a new route, page or registry row
appeared in the domain (the one thing a fingerprint can't detect).

**Consumers:** the design step reads it instead of re-reconning (its retirement list must agree — a
disagreement is a finding); the journey-edge sweep inherits the ADJACENT rows; `builder:verify` blocks
on an open `S#`; the plan's repoint/retire phase IS the REPLACES rows, split per app;
`builder:check` runs this procedure standalone for an author who has not entered the pipeline.
