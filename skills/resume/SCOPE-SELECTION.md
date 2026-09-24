# Scope selection — a ref means everything beneath it

**The canonical procedure for deciding WHICH UI 2.0 components a prototype-mode run operates on.**
`builder:check` and `builder:brainstorm` both follow it verbatim, so the resolution is identical
whichever one is typed. Every later step inherits the recorded selection rather than re-asking.

## The rule

`--ui2 <ref>` takes **everything beneath the ref**:

| Ref | Resolves to |
|---|---|
| a **screen id** — `home-dashboard`, `screens/home-dashboard`, `docs/ui2/screens/home-dashboard.md` | the screen spec plus **every registry row whose *Consumed by* names it**. The whole screen, because half a screen is not a screen |
| a **component id** — `C-034` | that row, plus **the rows it consumes** (its dependencies), so the build has everything it renders |
| a **registry name** — `SearchField` | the row with that name; more than one match is ambiguous and asks |
| an **explicit set** — `C-034,C-035` | exactly those rows, taken as given |

**There is no "which components?" question by default.** The one thing that asks is a genuinely
ambiguous name.

## The procedure

**1. Resolve the ref — never from memory.**

```
node .claude/scripts/list-ui2-refs.mjs --resolve "<ref>" --json
```

The JSON carries `kind` (`screen` · `component` · `set`), `title`, `screen` (the spec path, for a
screen ref), `ambiguous`, `components[]` — each with `id`, `name`, `status`, `platform`, `figma`,
`contract` (its own contract file, when it has one), `consumedBy`, `dependencies`, `built`,
`preview` and `fixture` — and `unbuilt`, the ids with no preview yet. It is static: it parses
`docs/ui2/design-system/registry.md` and `docs/ui2/screens/`. No capture server, no simulator.

Exit codes: **0** resolved · **3** ambiguous (a name matching more than one row; the candidates are
printed) · **4** not found (the nearest screens and rows are printed as candidates) · **2** bad usage.

**2. Ask only what the resolution leaves genuinely open.**

| Resolution | Ask |
|---|---|
| a screen | nothing — take every component it consumes |
| a component id, or a name matching one row | nothing — state what it resolved to and proceed |
| an explicit set | nothing — the caller named it |
| `ambiguous: true` / exit 3 | which row, via `AskUserQuestion`: one option per candidate, label = `C-### Name`, description = its status and where its contract lives; recommend the most recently edited (`git log -1 --format=%ar -- <contract>`) |
| exit 4 | not found. Offer the printed candidates; never guess |
| no ref at all | the picker, not this procedure |

**`--auto` needs a settled scope.** If the ref is ambiguous and `--all` was not given, refuse to
start: print the resolution and the literal invocations that settle it. An autopilot run must never
guess which component it is building.

**3. Echo the resolved scope before doing any work**, so a reader can tell what was and wasn't
looked at — and so a wrong resolution is caught before the expensive part:

```
Scope: screen home-dashboard → docs/ui2/screens/home-dashboard.md  (17 components)
  C-021  GlyphButton        new                built    components/C-021-glyph-button.md
  C-023  KpiCard            new                NOT built screens/home-dashboard.md §4
  …
  NOT in scope: every row this screen does not consume — 55 others in the registry
  Not yet built as a preview: C-023, C-027, C-049, …
```

**4. Read the contract, not the registry row.** The row is an index. For each in-scope component the
normative document is its `contract` path when it has one, and the *screen spec section* the
`Defined in` column names when it does not. 🔴 **Read the contract in full** — its designed states,
its variant axes, its props, its tokens and its `OQ-` open questions are the requirements, and an
unread open question becomes a mid-build surprise.

**5. Stop at the dependency edge.** A component ref takes the rows it consumes; it does **not** take
the rows that consume *it*. Widening to a consumer is a scope change: say so, and take an explicit
go-ahead. A screen ref already has both directions, being the whole screen.

## Built and unbuilt rows are both legitimate requirements

`built` means a `capture/fixtures/ui2/C-###.json` exists (or a preview view names the row) — so the
design has been rendered and diffed against its frozen Figma snapshot, and a human can look at it.
That is the strongest form of requirements this repo produces.

An **unbuilt** row is still requirements: its contract is normative whether or not anyone has rendered
it. Say which rows are unbuilt in the scope echo and in SPEC §Prototype, because the difference matters
to the plan — an unbuilt row's states have never been seen, so its first build phase carries more risk
and the audit's coverage item leans on the contract alone. 🔴 **Never report an unbuilt row as built**,
and never silently build a UI 2.0 preview to make it so: that is `/ui2-component-build`'s work, offered
as an option, never absorbed into this pipeline.

## Persisting the selection

`builder:check` is stateless — it re-resolves every run, which is correct for a command run repeatedly
while the design settles.

A pipeline run records the answer, because every later step has to honor it:

- Record the resolved scope on the manifest's `ui2:` line
  (`ui2: C-034 SearchField · deps: C-021 · C-039 · C-045`, or `ui2: screen home-dashboard · 17 rows`).
- Every subsequent step reads it and does **not** re-ask, and **never re-resolves the ref** —
  re-resolving can widen a scope that was settled at design, because the registry moves.
- Changing the selection mid-pipeline is a real decision: state what it invalidates (a spec written
  from `C-034` does not describe the whole search bar) and take an explicit go-ahead.
- **The build implements only the selected rows.** A row outside the selection ships nothing, and
  nothing in it is edited.
