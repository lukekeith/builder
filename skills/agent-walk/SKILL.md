---
name: agent-walk
description: Agent mode's stand-in for the human test — a fresh agent works the feature's walk.md item by item, records pass or fail with evidence, and on a pass writes an agent sign-off that says the feature is not human-tested. Run by /builder:resume under --agent-walk.
---

# `/builder:agent-walk` — an agent walks it, and says so

Invocation: **`/builder:agent-walk --path <folder> [--ticket <id>]`**. Flags:
[REFERENCE](../resume/REFERENCE.md) §Flags — ignore any flag this step does not use.
**`--batch <folder>…`** — the fleet's batched walk: several features in one walk. §Batched walks.

**Read the docs in one call:** `node <builder>/scripts/docs.mjs agent-walk` — builder:ship §At
sign-off, REFERENCE §Condense · §How a park reads · §The park record · §Agent model tiering, and
`.claude/builder.md`. The walker's prompt comes from `dispatch.mjs`, the sign-off from `condense.mjs`,
every other manifest write from `advance.mjs` (REFERENCE §The scripts) — 🔴 each is idempotent:
**after a crash, re-run the same command**; it finishes what is missing or says `already applied`.

🔴 **This is the agent's sign-off, never the human's.** It never writes `✅ SIGNED OFF`, never writes a
name into `walk:`, and never runs `/builder:signoff` (which stays human-only). On a pass it writes
its own, differently-labelled record — `walk: agent-pass`, `> 🤖 AGENT SIGNED OFF …` — and condenses,
so agent mode can take the feature to merged with every record saying it is not human-tested.

**The test plan.** Read the levers: `node <builder>/scripts/profile.mjs --levers <folder>` (an old
`profile:` line with no `tests:` is mapped by it). The floors in its `floors` hold whatever the
levers say. `end` sets how much is walked:

- **`end=none`** or **`end=touched`** → no walk, no walker. After the precondition table passes, go
  straight to §4 **AGENT-PASS**'s sign-off at HEAD, the header line
  `> 🤖 AGENT SIGNED OFF — no walk (tests: end=<none|touched>) — not human-tested · YYYY-MM-DD — <sha>`
  — `node <builder>/scripts/condense.mjs <folder> --signoff agent --no-walk`.
- **`end=risk`** → walk only the `[risk]` items and the `## Cross-app (verify E2E)` section.
  Neither present → no walker: AGENT-PASS with `0 items in scope` in the verdict and the hand-off.
- **`end=everything`** → the walk as written.
- **`walk=you`** → walk what `end` says. On AGENT-PASS, instead of the sign-off, park:
  `blocked: "waiting for your walk — next: /builder:resume --path <folder>"` (§4).
- **`persist=low`** → park after 1 failed round, not 5 (§1).

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
`run_in_background` (resume's AGENT-MODE.md: a headless run exits when its turn ends).

## 1. Which round

`<WS>` is `"$(<builder>/scripts/workspace <feature>)"` — re-resolve it inline in every command
(REFERENCE §The scripts). The round is one more than the highest existing `<WS>/agent-walk/round-*`.
A failed round is work, not a stop: its items become fixes, `/builder:resume` works them and routes
back here (resume's AGENT-MODE.md: agent mode builds to done). **A round after the first walks only
what the fix could change** — the items the last round didn't pass, plus a passed one only when the
fix's diff touches code it exercises; every other pass is carried with its evidence (`dispatch.mjs`
writes the scope and the diff). **From round 3 on**, the dispatch for
each item that failed in the round before also names
[`systematic-debugging`](../systematic-debugging/SKILL.md) — the fix that was tried didn't hold, so the next one starts from the cause. Only
when **five rounds in a row have failed since the last unpark** does the next one park instead. The
fleet writes `<WS>/agent-walk/unparked-after` (the highest round number at that moment) when it
unparks a feature; rounds up to that number are history and don't count — a feature named again
always gets five fresh rounds. The park is written to REFERENCE §How a park reads:
`blocked: "the agent walk failed five rounds running on <what still fails, as behaviour, in plain words> — next: a human walk, then /builder:signoff --path <folder>"`,
with `<folder>/PARKED.md` in the same commit — write PARKED.md, then
`node <builder>/scripts/advance.mjs <folder> --set 'blocked="…"' --add <folder>/PARKED.md --head --commit "chore({key}): {feature} — parked: agent walk failed"`
(REFERENCE §The park record, `kind: stuck`): each item
still failing with its *expected* and *saw* from every round it failed, quoted from the reports; the
fix each round tried and its commit; the evidence paths; and *Where to dig* — the code the failing
behaviour runs through, and what the five rounds have ruled out. A human or a later run starts the
dig from there.
🔴 **Between rounds** — before dispatching any round after the first — check for
`$BUILDER_FLEET_DIR/requests/<feature>.pause` (unset → `.builder/fleet/requests/<feature>.pause`). On one, write `blocked: "revising — next: /builder:revise --path <folder>"`
to the manifest and commit it (`chore(<ticket-or-feature>): <feature> — parked: revising`) — one call,
`node <builder>/scripts/advance.mjs <folder> --set 'blocked="revising — next: /builder:revise --path <folder>"' --head --commit "chore({key}): {feature} — parked: revising"` — and stop.
**Under `persist=low`**, one failed round since the last unpark is the limit: the next one parks
the same way, `failed five rounds running` written as `failed its one round`.
An item that fails because the SPEC never said what it should do is not a fix to retry: rule what
the spec most plausibly means, fix to that, and say so in the hand-off. **Under `unruled=park`**, park
instead — `kind: decision` (REFERENCE §The park record), naming what the spec leaves open.

## 2. Dispatch the walker

**One fresh subagent** — Agent tool, on the most capable model (REFERENCE §Agent model tiering) — and
never the build's context: the agent that built it does not grade it.
`node <builder>/scripts/dispatch.mjs agent-walk <folder>` picks the round (§1), writes the brief to
`<WS>/dispatch-agent-walk-round-<n>.md` and prints the Agent call; send
`Read <file> and do what it says.` — the one paragraph a failed round's fix needs, if any, goes in
`--context`. Its brief is exactly — the script writes it; this is what it holds:

- the path to `<WS>/walk.md`, to read in full;
- the config's `agent_walk.driver`, verbatim — how it drives the UI. **No driver** → "there is no UI
  driver: exercise each item through its endpoints, the server log and the database, and mark any
  item that can only be checked by looking at the screen `UNVERIFIABLE`";
- the config's §Environment landmines, verbatim;
- the output directory `<WS>/agent-walk/round-<n>/`;
- the rules: work **every** item — under `end=risk`, every `[risk]` item and the cross-app
  section, and say so — **walking by screen**: the items grouped by the screen or component they
  exercise, each screen reached once with every item on it checked in order (one session, one
  launch; a fresh start only when an item needs one); after round 1, only what the fix could change
  (§1); for each, record `PASS`, `FAIL` or
  `UNVERIFIABLE`, what it did, what it saw, and its evidence files — screenshots `NN-<slug>.png`,
  console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.
  **Never edit code, never commit, never touch the manifest or the SPEC.**
- the report: `<WS>/agent-walk/round-<n>/report.md` — first line `sha: <HEAD at walk start>` (the
  code this round walked; verify ties its quotes to it), then a table `# · App · Item · Result · Evidence`,
  then one line: `verdict: PASS` or `verdict: PROBLEMS (<k>)`.
- the `## Cross-app (verify E2E)` section of `walk.md`, when present, is walked like every other
  item: one report row per step, `#` = `E<k>`, App = `cross-app`, with its evidence. Verify quotes
  these rows instead of driving the app again, so an `E` row without evidence is a `FAIL`.
- 🔴 **the walker runs no gates** — no test suite, no build, no `gate.mjs`. It judges the running
  app; gates belong to the fix rounds and verify. A build run here rewrites what the walk env's dev
  server serves from this worktree and takes the env down mid-walk.

## 3. Judge the report

Read `report.md`. Open an evidence file only to spot-check a `FAIL`.

- Every `walk.md` item in scope (under `end=risk`, the `[risk]` and `E` items) present and `PASS` — a
  `PASS (carried from round <n> @ <sha>)` row counts, its evidence the earlier round's —
  `UNVERIFIABLE` allowed only when there is no driver, and each one listed — → **AGENT-PASS**.
- Any `FAIL`, an item of `walk.md` missing from the report (count it `FAIL — not walked`), or any
  `UNVERIFIABLE` item while a driver is configured → **AGENT-PROBLEMS**.

## 4. Write it

**AGENT-PASS — the agent sign-off** — the whole of it is one call,
`node <builder>/scripts/condense.mjs <folder> --signoff agent` (it finds the newest round whose report
ends `verdict: PASS`; `--round <n>` names one). Whether the walk passed is §3's judgment, made before
it runs. What it writes:
- Manifest: `walk: agent-pass YYYY-MM-DD <sha>` — `<sha>` from the passing round's `sha:` line —, `state: signed-off`, `verify: none`, `head`,
  `next: /builder:verify --path <folder>`.
- **Condense** exactly as [`builder:ship`](../ship/SKILL.md) §At sign-off does — the §Plan index cut
  by its heading, `git rm <folder>/PLAN.md` — except the header line written directly under the title
  is:
  `> 🤖 AGENT SIGNED OFF YYYY-MM-DD — <sha> · agent walk round <n> · not human-tested · evidence: .builder/<feature>/agent-walk/round-<n>/`
  (it replaces an older `> 🤖 AGENT-VERIFIED …` line if there is one).
- Commit all of it: `docs(<ticket-or-feature>): <feature> agent signed off (not human-tested)`.

**AGENT-PASS under `walk=you`** — no sign-off, no condense. Manifest: `walk:` stays
`none`; `blocked: "waiting for your walk — next: /builder:resume --path <folder>"`; `<folder>/PARKED.md`
with `kind: human-step` (REFERENCE §The park record) citing the passing round. Commit:
`chore(<ticket-or-feature>): <feature> — agent walk round <n> passed, waiting for your walk` — write
PARKED.md, then `node <builder>/scripts/advance.mjs <folder> --set 'blocked="waiting for your walk — next: /builder:resume --path <folder>"' --add <folder>/PARKED.md --head --commit "chore({key}): {feature} — agent walk round <n> passed, waiting for your walk"` — and end
the run. The fleet treats it as a human step; your `/builder:signoff` lands it.

**AGENT-PROBLEMS**
- Each failing item becomes `- [ ] <app>: <item> — expected <x>, saw <y> (agent walk round <n>)`
  under SPEC `## Fixes` — created as the SPEC's last section if absent.
- Manifest: `walk:` stays `none`; `next: /builder:resume --path <folder>`.
- Commit: `docs(<ticket-or-feature>): <feature> — agent walk round <n>: <k> fixes` — after the
  `## Fixes` edit, `node <builder>/scripts/advance.mjs <folder> --set "next=/builder:resume --path <folder>" --add <folder>/SPEC.md --head --commit "docs({key}): {feature} — agent walk round <n>: <k> fixes"`.
- `/builder:resume` works them (§Working `## Fixes`), re-runs walk readiness, and routes back here.

## Batched walks (`--batch`)

The fleet, with a walk env of its own (`agent_walk.start`), walks every feature waiting for it — up
to `agent_walk.batch` (default 8) — **together**: it merges their branches onto the target in its
walk worktree, brings the env up once, and runs this step once, there, as
`/builder:agent-walk --batch --into <target> <folder>…` — each `<folder>` the absolute path of one
feature's folder in **its own** worktree. The env serves the walk worktree, so every feature in the
batch is in the running app. Do, in order:

1. **Walk readiness, once, for the batch** — REFERENCE §Walk readiness under the fleet, run **here**
   (the walk worktree): the migrations every feature adds
   (`git diff --name-only --diff-filter=A <target>...HEAD -- <migrations path>`) applied to the walk
   env's database, regeneration, then `agent_walk.smoke`. Never start or restart the env; a
   restart-class change → write `blocked: "walk env needs a restart — <what>"` into **every** batched
   feature's manifest still waiting to walk (`advance.mjs <folder> --set 'blocked="…"' --head --commit
   "chore({key}): {feature} — walk env needs a restart"`) and end the run — the fleet restarts it
   without a reset and runs this again.
2. **Each feature still at `state: building` with `ready: pending`** — its walk script is in its
   workspace (the build lane wrote it; missing → `node <builder>/scripts/walk-script.mjs <folder>`);
   move it on: `node <builder>/scripts/advance.mjs <folder> --set state=built --set "ready=yes
   <YYYY-MM-DD> <its HEAD>" --set "next=/builder:agent-walk --path <folder>" --head --commit built`.
3. **Per feature, the precondition table and §The test plan** — a feature whose `end` is `none` or
   `touched` signs off `--no-walk` now (§The test plan); a paused one (§1, *Between rounds*) parks as
   revising; a feature whose rounds are spent parks (§1). The rest are walked.
4. **One walker for all of them** — `node <builder>/scripts/dispatch.mjs walk-batch <folder>…` (run
   here; the folders being walked) writes one brief: every walk script, each feature's scope and
   round (a round after its first walks only what its fix could change), walked **by screen across
   every feature**, each feature's report in its own `<WS>/agent-walk/round-<n>/`. One Agent call,
   foreground.
5. **Per feature, §3 and §4** — judge its own report and write it in its own folder: the sign-off
   (`condense.mjs <folder> --signoff agent`, run with that folder's path — every script resolves the
   worktree from it) or its `## Fixes` rows. A failure the walker attributes to another feature in
   the batch is still fixed in the feature it failed in, and the fix's rule says what was seen.
6. **End the run** with one line per feature — its verdict and its next step. Nothing else here: the
   fleet routes each by its manifest — signed off to verify and ship, fixes to the parallel lanes,
   then back into a later batch.

The walk worktree and its branch are the fleet's scratch: never commit there, never merge it.

## Hand off

The verdict, the round, the counts (pass · fail · unverifiable), and where the evidence is. No
review here — this runs headless and nobody reads it (REFERENCE §The review, under `--agent-walk`);
the fleet's report (fleet §5) and, under `walk=you`, your walk (resume §🔒 The walk) show the full
review of what was built. Then:

~~~
📍 <feature>: agent signed off (round <n>, not human-tested) + condensed — next: /builder:verify --path <folder> · or say go
📍 <feature>: agent walk round <n> — <k> fixes owed — next: /builder:resume --path <folder> · or say go
📍 <feature>: ⛔ parked — the agent walk failed five rounds running on <what still fails> — next: a human walk, then /builder:signoff --path <folder> · or /builder:agent for five more rounds
~~~

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.
