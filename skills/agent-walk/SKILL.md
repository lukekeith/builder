---
name: agent-walk
description: The unattended stand-in for the human walk, run only under --agent-walk (the /builder:fleet path) — a fresh subagent works the feature's walk.md item by item with the driver the project config's agent_walk block names, records PASS/FAIL per item with evidence, and this step writes an AGENT-PASS or AGENT-PROBLEMS verdict. Never a human sign-off — an agent pass unlocks /builder:verify and a DRAFT PR only, and the SPEC header says the feature is not human-tested. Use when /builder:resume routes here under --agent-walk.
---

# `/builder:agent-walk` — an agent walks it, and says so

Invocation: **`/builder:agent-walk --path <folder> [--ticket <id>]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — ignore any flag this step does not use.

🔴 **This is not a sign-off.** It never writes `✅ SIGNED OFF`, never writes a name into `walk:`,
never condenses, and never runs `/builder:signoff`. It exists so an unattended run can reach a
**draft** PR carrying evidence. Whether that PR goes ready is still the human's sign-off.

## Precondition — read `<folder>/MANIFEST.md`

| The manifest says | What to do |
|---|---|
| `agent-walk:` is not `on …` | refuse in one line: this step runs only under `--agent-walk`. A human walk is recorded by `/builder:signoff` |
| the config has no `agent_walk:` block | refuse; name `/builder:init --update` |
| `blocked:` set | parked — print it, run nothing |
| `walk:` already set | nothing to do; hand back to `/builder:resume --path <folder>` |
| `ready:` is not `yes <sha>` with no code commit since that sha (manifest/doc-only commits don't count) | not walkable yet — hand back to `/builder:resume` (walk readiness comes first) |
| `state: built`, `walk: none`, `ready: yes <sha>` and no code commit since that sha (manifest/doc-only commits don't count) | run |

## 1. Which round

`<WS>` is `"$(<builder>/scripts/workspace <feature>)"` — re-resolve it inline in every command
(REFERENCE §The scripts). The round is one more than the highest existing `<WS>/agent-walk/round-*`.
**Round 3 would start → park instead** (resume §`--agent-walk`):
`blocked: "agent walk failed twice — <the items still failing> — clears when a human walks it or the fixes land"`.

## 2. Dispatch the walker

**One fresh subagent** — Agent tool, on the most capable model (REFERENCE §Agent model tiering) — and
never the build's context: the agent that built it does not grade it. Its brief is exactly:

- the path to `<WS>/walk.md`, to read in full;
- the config's `agent_walk.driver`, verbatim — how it drives the UI. **No driver** → "there is no UI
  driver: exercise each item through its endpoints, the server log and the database, and mark any
  item that can only be checked by looking at the screen `UNVERIFIABLE`";
- the config's §Environment landmines, verbatim;
- the output directory `<WS>/agent-walk/round-<n>/`;
- the rules: work **every** item, in order, per app; for each, record `PASS`, `FAIL` or
  `UNVERIFIABLE`, what it did, what it saw, and its evidence files — screenshots `NN-<slug>.png`,
  console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.
  **Never edit code, never commit, never touch the manifest or the SPEC.**
- the report: `<WS>/agent-walk/round-<n>/report.md` — a table `# · App · Item · Result · Evidence`,
  then one line: `verdict: PASS` or `verdict: PROBLEMS (<k>)`.

## 3. Judge the report

Read `report.md`. Open an evidence file only to spot-check a `FAIL`.

- Every `walk.md` item present and `PASS` — `UNVERIFIABLE` allowed only when there is no driver, and
  each one listed — → **AGENT-PASS**.
- Any `FAIL`, an item of `walk.md` missing from the report (count it `FAIL — not walked`), or any
  `UNVERIFIABLE` item while a driver is configured → **AGENT-PROBLEMS**.

## 4. Write it

**AGENT-PASS**
- Manifest: `walk: agent-pass YYYY-MM-DD <sha>`, `next: /builder:verify --path <folder>`, `head`.
- SPEC header, directly under the title:
  `> 🤖 AGENT-VERIFIED YYYY-MM-DD — <sha> · round <n> · not human-tested · evidence: .builder/<feature>/agent-walk/round-<n>/`
- Commit both: `chore(<ticket-or-feature>): <feature> — agent walk PASS (not human-tested)`.

**AGENT-PROBLEMS**
- Each failing item becomes `- [ ] <app>: <item> — expected <x>, saw <y> (agent walk round <n>)`
  under SPEC `## Fixes` — created as the SPEC's last section if absent.
- Manifest: `walk:` stays `none`; `next: /builder:resume --path <folder>`.
- Commit: `docs(<ticket-or-feature>): <feature> — agent walk round <n>: <k> fixes`.
- `/builder:resume` works them (§Working `## Fixes`), re-runs walk readiness, and routes back here.

## Hand off

The verdict, the round, the counts (pass · fail · unverifiable), and where the evidence is. Then:

~~~
📍 <feature>: agent walk PASS (round <n>, not human-tested) — next: /builder:verify --path <folder> · or say go
📍 <feature>: agent walk round <n> — <k> fixes owed — next: /builder:resume --path <folder> · or say go
📍 <feature>: ⛔ parked — agent walk failed twice — next: a human walk, then /builder:signoff --path <folder>
~~~

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
