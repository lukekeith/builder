# Scope selection — a ref means everything beneath it

**The canonical procedure for deciding WHICH design items a prototype-mode run operates on.**
`builder:check` and `builder:brainstorm` both follow it verbatim, so the resolution is identical
whichever one is typed. Every later step inherits the recorded selection rather than re-asking.

It applies only when `.claude/builder.md` carries a `design:` block. That block names the **flag**,
the **resolver** command, where the **contracts** live and which commands **own** the design.

## The rule

The design flag takes **everything beneath the ref**. What "beneath" means depends on what the ref
names, and the resolver reports which kind it resolved:

| Ref kind | Resolves to |
|---|---|
| a **container** — a screen, a flow, a page | that container plus **every item it consumes**. Take it whole: half a screen is not a screen |
| a **single item** — one component | that item, plus **the items it consumes** (its dependencies), so the build has everything it renders |
| a **name** | the item with that name; more than one match is ambiguous and asks |
| an **explicit set** — a comma list | exactly those items, taken as given |

**There is no "which items?" question by default.** The one thing that asks is a genuinely ambiguous
ref.

## The procedure

**1. Resolve the ref — never from memory.**

```
<the config's design.resolver> --resolve "<ref>" --json
```

The resolver's contract, which every `design.resolver` must satisfy:

- it prints JSON carrying `kind`, `title`, `ambiguous`, and an array of the resolved **items** — each
  with an id, a name, where its **contract** lives, its **dependencies**, and whether it is **built**
  (rendered and diffable against the design);
- **exit 0** resolved · **exit 3** ambiguous, with the candidates printed · **exit 4** not found,
  with the nearest candidates printed · **exit 2** bad usage;
- it is **static** — it reads the design specs on disk. It starts no server and renders nothing.

**2. Ask only what the resolution leaves genuinely open.**

| Resolution | Ask |
|---|---|
| a container | nothing — take every item it consumes |
| a single item, or a name matching one | nothing — state what it resolved to and proceed |
| an explicit set | nothing — the caller named it |
| `ambiguous` / exit 3 | which item, via `AskUserQuestion`: one option per candidate, label = its id and name, description = where its contract lives; recommend the most recently edited (`git log -1 --format=%ar -- <contract>`) |
| exit 4 | not found. Offer the printed candidates; never guess |
| no ref at all | the picker, not this procedure |

**`--auto` needs a settled scope.** If the ref is ambiguous and `--all` was not given, refuse to
start: print the resolution and the literal invocations that settle it. An autopilot run must never
guess which item it is building.

**3. Echo the resolved scope before doing any work**, so a reader can tell what was and wasn't looked
at — and so a wrong resolution is caught before the expensive part:

```
Scope: <kind> <title>  (<n> items)
  <id>  <name>          <status>   built     <contract path>
  <id>  <name>          <status>   NOT built <contract path>
  …
  NOT in scope: <what the ref does not reach>
  Not yet built: <the unbuilt ids>
```

**4. Read the contract, not the index.** A registry row or a listing entry is an index. For each
in-scope item the normative document is its contract. 🔴 **Read it in full** — its designed states,
its variant axes, its props, its tokens and its open questions are the requirements, and an unread
open question becomes a mid-build surprise.

**5. Stop at the dependency edge.** An item ref takes the items it consumes; it does **not** take the
items that consume *it*. Widening to a consumer is a scope change: say so, and take an explicit
go-ahead. A container ref already has both directions, being the whole container.

## Built and unbuilt items are both legitimate requirements

**Built** means the design has been rendered and diffed against its frozen snapshot, and a human can
look at it. That is the strongest form of requirements a design pipeline produces.

An **unbuilt** item is still requirements: its contract is normative whether or not anyone rendered
it. Say which items are unbuilt in the scope echo and in SPEC §Prototype, because the difference
matters to the plan — an unbuilt item's states have never been seen, so its first build task carries
more risk and the audit's coverage item leans on the contract alone.

🔴 **Never report an unbuilt item as built**, and never render one to make it so: that is the design
pipeline's work, offered as an option, never absorbed into this one.

## Persisting the selection

`builder:check` is stateless — it re-resolves every run, which is correct for a command run
repeatedly while a design settles.

A pipeline run records the answer, because every later step has to honour it:

- Record the resolved scope on the manifest's design key.
- Every subsequent step reads it and does **not** re-ask, and **never re-resolves the ref** —
  re-resolving can widen a scope that was settled at design, because the design moves.
- Changing the selection mid-pipeline is a real decision: state what it invalidates and take an
  explicit go-ahead.
- **The build implements only the selected items.** An item outside the selection ships nothing, and
  nothing in it is edited.
