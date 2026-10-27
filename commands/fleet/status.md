---
description: Shows where the fleet stands — every feature in flight, parked with its next step, or merged this run, and the run's progress. Use when asked how the fleet or the agents are doing; --archived [N] lists the latest landings.
argument-hint: "[--archived [N]]"
---

# `/builder:fleet:status` — where the fleet stands

Resolve `<builder>` per [REFERENCE](../../skills/resume/REFERENCE.md) §The scripts, then run
`node <builder>/scripts/fleet.mjs --status $ARGUMENTS` from the repo root. It starts, stops and
changes nothing — it only notes that the status was seen, so the status line and the next session's
brief stop announcing what landed before now (`✔ <feature> merged`).

Reply with its output **as markdown, never inside a code fence**: the heading line, then the table
as a markdown table (the terminal renders it; fenced, it shows as raw pipes), then the `## Parked`
list if there is one — each parked feature with its why and its `next:` step — then any notes as
bullets. Change no cell. Then stop.

How to read it, when asked:

- **The bar covers the whole run** — every feature in it, each one this run merged counted at 100%
  (`N merged this run` in the heading) — and measures **steps, not time**: the manifest state sets a
  floor (planned 15, built 75, verified 92, merged 100); inside the build it climbs per task — a
  share when its brief is written, more at its report, all at its tick (`build 5/9`) — and it moves
  through the plan and the agent walk the same way. Half the bar is not half the wall-clock.
- **`Time`** is each feature's agent time so far. **The line under the heading** gives, for the last
  five landed features, the mean **wall-clock** from start to merge — parks, restarts and queueing
  included — and where it went by stage. For "how long is left", that wall-clock mean for the stages
  the feature hasn't finished is the honest estimate; say it is one.
- **A feature that landed is not a row**: it is counted in the archived line. With `--archived [N]`
  the output lists the latest N landings (20 by default) — relay it the same way.
- **The fleet has ended** (no row in flight): reply with `.builder/fleet/STATUS.md` as markdown
  instead, as above.
