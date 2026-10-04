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

**The build profile.** Read the levers: `node <builder>/scripts/profile.mjs --levers <folder>`. The
floors in its `floors` hold whatever the levers say.

- **`testing: none`** → no walk, no walker. After the precondition table passes, go straight to §4
  **AGENT-PASS**'s sign-off at HEAD, the
  header line `> 🤖 AGENT SIGNED OFF — no walk (profile: rush) — not human-tested · YYYY-MM-DD — <sha>`
  (`custom` in place of `rush` under a custom profile).
- **`testing: risky`** → walk only the `[risk]` items and the `## Cross-app (verify E2E)` section.
  Neither present → no walker: AGENT-PASS with `0 items in scope` in the verdict and the hand-off.
- **`testing: full`** → the walk as written.
- **`testing: full+human`** → the walk as written. On AGENT-PASS, instead of the sign-off, park:
  `blocked: "waiting for your walk — next: /builder:resume --path <folder>"` (§4).
- **`persist: low`** → park after 1 failed round, not 5 (§1).

## Precondition — read `<folder>/MANIFEST.md`

| The manifest says | What to do |
|---|---|
| `agent-walk:` is not `on …` | refuse in one line: this step runs only under `--agent-walk`. A human walk is recorded by `/builder:signoff` |
| the config has no `agent_walk:` block | refuse; name `/builder:init --update` |
| `blocked:` set | parked — print it, run nothing |
| `state: built` · `walk: agent-pass …` (walked before agents signed off) | no new round: go straight to §4 **AGENT-PASS**'s sign-off and condense, citing the round that passed — keep the manifest's existing `walk:` sha, never HEAD's |
| `walk:` already set, anything else | nothing to do; hand back to `/builder:resume --path <folder>` |
| `ready:` is not `yes <sha>` with no code commit since that sha (manifest/doc-only commits don't count) | not walkable yet — hand back to `/builder:resume` (walk readiness comes first) |
| `state: built`, `walk: none`, `ready: yes <sha>` and no code commit since that sha (manifest/doc-only commits don't count) | run |

🔴 **The walk subagent runs in the foreground** and its report is read in this run — never
`run_in_background` (resume §`--agent-walk`: a headless run exits when its turn ends).

## 1. Which round

`<WS>` is `"$(<builder>/scripts/workspace <feature>)"` — re-resolve it inline in every command
(REFERENCE §The scripts). The round is one more than the highest existing `<WS>/agent-walk/round-*`.
A failed round is work, not a stop: its items become fixes, `/builder:resume` works them and routes
back here (resume §`--agent-walk`: agent mode builds to done). **From round 3 on**, the dispatch for
each item that failed in the round before also names
[`systematic-debugging`](../systematic-debugging/SKILL.md) — the fix that was tried didn't hold, so the next one starts from the cause. Only
when **five rounds in a row have failed since the last unpark** does the next one park instead. The
fleet writes `<WS>/agent-walk/unparked-after` (the highest round number at that moment) when it
unparks a feature; rounds up to that number are history and don't count — a feature named again
always gets five fresh rounds. The park is written to REFERENCE §How a park reads:
`blocked: "the agent walk failed five rounds running on <what still fails, as behaviour, in plain words> — next: a human walk, then /builder:signoff --path <folder>"`,
with `<folder>/PARKED.md` in the same commit (REFERENCE §The park record, `kind: stuck`): each item
still failing with its *expected* and *saw* from every round it failed, quoted from the reports; the
fix each round tried and its commit; the evidence paths; and *Where to dig* — the code the failing
behaviour runs through, and what the five rounds have ruled out. A human or a later run starts the
dig from there.
🔴 **Between rounds** — before dispatching any round after the first — check for
`.builder/fleet/requests/<feature>.pause`. On one, write `blocked: "revising — next: /builder:revise --path <folder>"`
to the manifest, commit it (`chore(<ticket-or-feature>): <feature> — parked: revising`) and stop.
**Under `persist: low`**, one failed round since the last unpark is the limit: the next one parks
the same way, `failed five rounds running` written as `failed its one round`.
An item that fails because the SPEC never said what it should do is not a fix to retry: rule what
the spec most plausibly means, fix to that, and say so in the hand-off. **Under `unruled: park`**, park
instead — `kind: decision` (REFERENCE §The park record), naming what the spec leaves open.

## 2. Dispatch the walker

**One fresh subagent** — Agent tool, on the most capable model (REFERENCE §Agent model tiering) — and
never the build's context: the agent that built it does not grade it. Its brief is exactly:

- the path to `<WS>/walk.md`, to read in full;
- the config's `agent_walk.driver`, verbatim — how it drives the UI. **No driver** → "there is no UI
  driver: exercise each item through its endpoints, the server log and the database, and mark any
  item that can only be checked by looking at the screen `UNVERIFIABLE`";
- the config's §Environment landmines, verbatim;
- the output directory `<WS>/agent-walk/round-<n>/`;
- the rules: work **every** item — under `testing: risky`, every `[risk]` item and the cross-app
  section, and say so — in order, per app; for each, record `PASS`, `FAIL` or
  `UNVERIFIABLE`, what it did, what it saw, and its evidence files — screenshots `NN-<slug>.png`,
  console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.
  **Never edit code, never commit, never touch the manifest or the SPEC.**
- the report: `<WS>/agent-walk/round-<n>/report.md` — first line `sha: <HEAD at walk start>` (the
  code this round walked; verify ties its quotes to it), then a table `# · App · Item · Result · Evidence`,
  then one line: `verdict: PASS` or `verdict: PROBLEMS (<k>)`.
- the `## Cross-app (verify E2E)` section of `walk.md`, when present, is walked like every other
  item: one report row per step, `#` = `E<k>`, App = `cross-app`, with its evidence. Verify quotes
  these rows instead of driving the app again, so an `E` row without evidence is a `FAIL`.
- any gate the walker runs: a line at or under its baseline (`→ 7 (baseline 7)`) is green — note
  the count and move on; never investigate failures that already fail on the base branch.

## 3. Judge the report

Read `report.md`. Open an evidence file only to spot-check a `FAIL`.

- Every `walk.md` item in scope (under `testing: risky`, the `[risk]` and `E` items) present and `PASS` — `UNVERIFIABLE` allowed only when there is no driver, and
  each one listed — → **AGENT-PASS**.
- Any `FAIL`, an item of `walk.md` missing from the report (count it `FAIL — not walked`), or any
  `UNVERIFIABLE` item while a driver is configured → **AGENT-PROBLEMS**.

## 4. Write it

**AGENT-PASS — the agent sign-off**
- Manifest: `walk: agent-pass YYYY-MM-DD <sha>` — `<sha>` from the passing round's `sha:` line —, `state: signed-off`, `verify: none`, `head`,
  `next: /builder:verify --path <folder>`.
- **Condense** exactly as [`builder:ship`](../ship/SKILL.md) §At sign-off does — the §Plan index cut
  by its heading, `git rm <folder>/PLAN.md` — except the header line written directly under the title
  is:
  `> 🤖 AGENT SIGNED OFF YYYY-MM-DD — <sha> · agent walk round <n> · not human-tested · evidence: .builder/<feature>/agent-walk/round-<n>/`
  (it replaces an older `> 🤖 AGENT-VERIFIED …` line if there is one).
- Commit all of it: `docs(<ticket-or-feature>): <feature> agent signed off (not human-tested)`.

**AGENT-PASS under `testing: full+human`** — no sign-off, no condense. Manifest: `walk:` stays
`none`; `blocked: "waiting for your walk — next: /builder:resume --path <folder>"`; `<folder>/PARKED.md`
with `kind: human-step` (REFERENCE §The park record) citing the passing round. Commit:
`chore(<ticket-or-feature>): <feature> — agent walk round <n> passed, waiting for your walk`, and end
the run. The fleet treats it as a human step; your `/builder:signoff` lands it.

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
📍 <feature>: ⛔ parked — the agent walk failed five rounds running on <what still fails> — next: a human walk, then /builder:signoff --path <folder> · or /builder:agent for five more rounds
~~~

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
