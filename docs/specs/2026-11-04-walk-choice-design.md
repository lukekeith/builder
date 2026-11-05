# Choose what agents walk, and stop chasing one item — design

**Status:** decisions D1 and D5 taken by the owner (2026-11-04); the rest proposed — nothing built · **Date:** 2026-11-04 · **Branch:** `feat/walk-choice`

## Why

A real fleet run (a consuming project, builder 6.1.1) has been walking one feature for about 19 hours
over 7 rounds. Its walk script lists about 26 items across three areas: server, iPhone, and the
cross-app end-to-end checks. Rounds 1–3 found real problems (4, 5 and 6 failures). Rounds 4, 5 and 6
each failed on the **same single iPhone item**: a list jumps when a new page lands during a fast
scroll. The walker drives the simulator with scripted drags; each round a fix goes in, slow drags
hold, fast drags still jump, and it walks again. Round 7 is the fourth attempt. The owner would
judge that item in seconds by scrolling it, then fix it with Claude. Each round costs about two hours
of an agent on the most capable model, plus a live dev environment.

The owner's rule:

> Sometimes I'm building things I'm comfortable testing myself. It's better to skip the walk and then
> work with Claude to fix it than to wait hours for the walk, which burns a lot of tokens too.

What exists today: the test plan's `walk` lever (`none` · `risk` · `full`, `none` recommended) and
`persist` (`default`: park after 5 failed rounds; `low`: after 1). Both are chosen at the plan's
go-ahead, often long before the walk. Nobody sees what the walk will cover or cost. Nothing narrows
a walk to some apps or areas, and nothing notices one item failing the same way round after round.

The benchmark of 2026-11-04 found a second walk waste: a walk round that failed only because the walk
script listed items the audit had handed to the test suite. The walker isn't allowed to start the
server for those, so it marks them unverifiable, and any unverifiable item fails the round. That
cost about 8 minutes of rework on a small fixture for no defect. D6 covers it.

## Decisions

- **D1. Ask at launch (owner, 2026-11-04).** The confirmation that starts agents (`/builder:agent`
  §3, `/builder:fleet` §3) shows the walk table (D2) and one question, unless every picked feature's
  walk is already `none`. Overnight runs never wait on the user. The choice can be changed later
  from `/builder:fleet:status` until that feature's walk starts.
- **D2. The walk table**, one row per picked feature (and, for a feature over several apps, one
  indented row per walk area: an app, or Cross-app):

  | Feature | What the walk checks | Items | Est. time |
  |---|---|---|---|

  - **What it checks** comes from the spec: its success criteria (SC rows), risk items and cross-app
    rows, summarised in one line per area.
  - **Items** is the count the walk script will hold. A walk script can be built at launch only after
    the build, so this is predicted from the same spec sources `walk-script.mjs` reads, labelled
    "≈".
  - **Est. time** is the items × the project's median minutes per walked item from its fleet archive.
    With fewer than 3 walked features archived, it's the benchmark's rate, labelled as an estimate.
    The estimate includes one fix round when the feature's past walks needed one more often than not.
- **D3. The question:** **Walk everything** · **Select what to walk** · **Skip the walk**.
  - *Select* opens one multi-select: every feature, and for a multi-area feature, each area.
  - The answer is written to each manifest as the existing `walk` lever (`full`/`risk` as planned,
    or `none`), plus a new `walk-areas:` list when only some areas were picked. No new levers.
  - The recommended option: *Walk everything* when the total estimate is under 30 minutes, else
    *Select*, with the cross-app areas pre-picked (they are what a person can't easily check by
    hand). The reason is said above the picker.
- **D4. A skipped walk is said everywhere.** A feature with `walk=none` chosen at launch lands as
  agent-built, **not walked**: in the merge commit, the status line, the landing report and the next
  session's brief. The landing report ends with what the walk would have covered, as a checklist the
  owner works through with Claude.
- **D5. Stop chasing one item (owner, 2026-11-04).** When the **same item fails two walk rounds in a
  row**, and the second round's fix targeted it, the walk stops re-walking that item.
  - The rest of the round is still judged; other failures still get their fix round.
  - Once nothing else is open, the feature parks as **needs you** with that item's evidence from both
    rounds and three choices: **I'll check it myself** (it lands marked "not walked: <item>"), **Fix
    it with me** (`/builder:resume` in a session), and **Let agents keep trying** (one more fix and
    re-walk, then ask again).
  - "Same" means the same walk item id, failing again after a fix targeted it. A different item
    failing never counts.
- **D6. Items the verifier carries are not walk items.** `walk-script.mjs` leaves out every item the
  spec or audit marks as carried by the verifier. If one stays in, the walker records it as PASS
  when the verifier's suite covering it is green at the walked commit, never as UNVERIFIABLE.

## Open details

1. A walk area (D2) is an app, or Cross-app. Should an app's walk also split by screen or surface when
   it holds more than about 10 items, or is the app the smallest choice?
2. When a fleet already running is given a changed choice (D1, from `/builder:fleet:status`) after
   the feature's walk started: stop the walk now, or apply it from the next round?

## Not changed

The walk itself (how items are driven and judged), the walk levers' meaning, the human walk
(`human=yes`), and the verifier tiers. Skipping the walk skips nothing in the merge tier: every suite
still runs before landing.
