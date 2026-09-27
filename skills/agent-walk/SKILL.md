---
name: agent-walk
description: The unattended stand-in for the human walk and sign-off, run only under --agent-walk (agent mode — /builder:agent and /builder:fleet) — a fresh subagent works the feature's walk.md item by item with the driver the project config's agent_walk block names, records PASS/FAIL per item with evidence, and this step writes an AGENT-PASS or AGENT-PROBLEMS verdict. On AGENT-PASS it writes the AGENT sign-off and condenses the folder, so verify, the PR, CI, ship and merge follow unattended. Never a human sign-off — every record says the feature is not human-tested. Use when /builder:resume routes here under --agent-walk.
---

# `/builder:agent-walk` — an agent walks it, and says so

Invocation: **`/builder:agent-walk --path <folder> [--ticket <id>]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — ignore any flag this step does not use.

🔴 **This is the agent's sign-off, never the human's.** It never writes `✅ SIGNED OFF`, never writes a
name into `walk:`, and never runs `/builder:signoff` (which stays human-only). On a pass it writes
its own, differently-labelled record — `walk: agent-pass`, `> 🤖 AGENT SIGNED OFF …` — and condenses,
so agent mode can take the feature to merged with every record saying it is not human-tested.

## Precondition — read `<folder>/MANIFEST.md`

| The manifest says | What to do |
|---|---|
| `agent-walk:` is not `on …` | refuse in one line: this step runs only under `--agent-walk`. A human walk is recorded by `/builder:signoff` |
| the config has no `agent_walk:` block | refuse; name `/builder:init --update` |
| `blocked:` set | parked — print it, run nothing |
| `state: built` · `walk: agent-pass …` (walked before agents signed off) | no new round: go straight to §4 **AGENT-PASS**'s sign-off and condense, citing the round that passed |
| `walk:` already set, anything else | nothing to do; hand back to `/builder:resume --path <folder>` |
| `ready:` is not `yes <sha>` with no code commit since that sha (manifest/doc-only commits don't count) | not walkable yet — hand back to `/builder:resume` (walk readiness comes first) |
| `state: built`, `walk: none`, `ready: yes <sha>` and no code commit since that sha (manifest/doc-only commits don't count) | run |

🔴 **The walk subagent runs in the foreground** and its report is read in this run — never
`run_in_background` (resume §`--agent-walk`: a headless run exits when its turn ends).

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

**AGENT-PASS — the agent sign-off**
- Manifest: `walk: agent-pass YYYY-MM-DD <sha>`, `state: signed-off`, `verify: none`, `head`,
  `next: /builder:verify --path <folder>`.
- **Condense** exactly as [`builder:ship`](../ship/SKILL.md) §At sign-off does — the §Plan index cut
  by its heading, `git rm <folder>/PLAN.md` — except the header line written directly under the title
  is:
  `> 🤖 AGENT SIGNED OFF YYYY-MM-DD — <sha> · agent walk round <n> · not human-tested · evidence: .builder/<feature>/agent-walk/round-<n>/`
  (it replaces an older `> 🤖 AGENT-VERIFIED …` line if there is one).
- Commit all of it: `docs(<ticket-or-feature>): <feature> agent signed off (not human-tested)`.

**AGENT-PROBLEMS**
- Each failing item becomes `- [ ] <app>: <item> — expected <x>, saw <y> (agent walk round <n>)`
  under SPEC `## Fixes` — created as the SPEC's last section if absent.
- Manifest: `walk:` stays `none`; `next: /builder:resume --path <folder>`.
- Commit: `docs(<ticket-or-feature>): <feature> — agent walk round <n>: <k> fixes`.
- `/builder:resume` works them (§Working `## Fixes`), re-runs walk readiness, and routes back here.

## Hand off

The verdict, the round, the counts (pass · fail · unverifiable), and where the evidence is. Then:

~~~
📍 <feature>: agent signed off (round <n>, not human-tested) + condensed — next: /builder:verify --path <folder> · or say go
📍 <feature>: agent walk round <n> — <k> fixes owed — next: /builder:resume --path <folder> · or say go
📍 <feature>: ⛔ parked — agent walk failed twice — next: a human walk, then /builder:signoff --path <folder>
~~~

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
