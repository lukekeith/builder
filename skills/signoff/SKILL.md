---
name: signoff
description: Record the human's own hands-on verdict on a built feature — the durable spend of the /builder:* PR lock. Typed by the human ONLY; an agent can never grant, infer, or simulate it. On "it works" it writes a dated, sha-bound sign-off into the feature's MANIFEST.md and SPEC header, condenses the folder, and unlocks the verify+PR steps; on "found problems" it records each finding as a §Fixes task and the lock stays closed; on "works, but not yet" it records the sign-off AND a hold, so nothing pushes until the human says go. In a multi-app feature it captures WHICH apps were exercised, so a half-walked feature is recorded as PARTIAL rather than passing.
disable-model-invocation: true
---

# `/builder:signoff` — spend the PR lock

**The record's authority comes from who typed it:** `disable-model-invocation` means the Skill tool
refuses it from the model, so a sign-off in the manifest and the SPEC header is proof the human ran
this command. An agent that writes one by hand ("recording what the user said earlier") is forging
the gate — any sign-off whose commit didn't come from this command is **void**, and the pipeline
re-offers the walk.

Invocation: **`/builder:signoff --path <folder> [--hold "<reason>"] <verdict in your own words>`** —
without the verdict it is taken by one question. Flags: [REFERENCE](../resume/REFERENCE.md) §Flags.

**No `--path` = the picker:** run `node <builder>/scripts/list-features.mjs --json` and offer every
row whose manifest is `state: built` with `walk: none`; none eligible → say where each stands and
record nothing.

⛔ **SPEC header carries `✅ SHIPPED`** → run no step: print the header and stop.

## Procedure

1. **Read `<folder>/MANIFEST.md`** and route on it:

   | The manifest says | What this is |
   |---|---|
   | `state: built` · `walk: none` | the normal case — the walk sign-off below |
   | `state: planned` · `go-ahead: none` | not a walk: the **build go-ahead** — §The go-ahead |
   | `walk:` set and a `- [ ] re-walk:` row under `## Fixes` | a **re-sign** — §Re-signing |
   | no `MANIFEST.md` | shipped, or a pre-builder layout — hand back to `/builder:resume`, stop |
   | anything else | report where the feature stands and record nothing |

   The walk script lives at `"$(<builder>/scripts/workspace <feature>)/walk.md"`. 🔴 Re-resolve that
   path inline in every command. **Print the script when the human has not already walked it**; then
   take the verdict in the same sitting.

1b. 🔴 **Walk readiness gates a PASS.** The manifest's `ready:` is not `yes`, or it names a sha
   older than a commit that adds a migration → run the config's migration **status** against the dev
   database now. Pending migrations, or a `ready: pending` step still undone → **do not record a
   PASS**: say what the dev environment is missing, give the one command that fixes it, and offer
   **PROBLEMS** or **PARTIAL** instead. A walk of an app that wasn't running this build didn't test
   this build. (The human confirming a device-only `pending` step they did themselves clears it.)

2. **Report preconditions honestly, never silently:** manifest `head:` vs `git rev-parse HEAD` (were
   the gates fresh on what they tested?); `git status --porcelain` (uncommitted changes — 🔴 **a
   phase in an app the config marks `commit: manual` often ends with its commits staged and
   unapproved, and that is expected**, but it means the tree is dirty and the walk covered a build
   that is not committed: say so); anything new or least-exercised the walk may not have hit. **None
   of them block the recording** — the human tested the running app — but the record carries the
   caveat. 🔴 This step is
   [`verification-before-completion`](../verification-before-completion/SKILL.md) pointed at the
   pipeline itself: the sign-off is the strongest completion claim the whole process makes, so the
   conditions it was made under are stated as evidence, not summarised into a feeling.

3. **Capture the verdict** — their words verbatim, or ONE AskUserQuestion: *"You ran the
   walk-through — what's the verdict?"* → **PASS** / **PASS + HOLD the PR** / **PROBLEMS** /
   **PARTIAL**.

   🔴 **Capture WHICH APPS were exercised.** The manifest's `apps:` line says how many places this
   feature lives, and `walk.md` is written per app. An "it works" that covered one app and never
   opened another is **PARTIAL**, with the unexercised app's items named — not a PASS. Ask explicitly
   when the verdict does not say; a multi-app feature walked in one app is the commonest way a
   half-verified thing reaches a PR.

4. **Write** per §What gets written, then hand off. One commit — that commit IS the durable proof.

## What gets written

| Outcome | MANIFEST.md | SPEC.md | Commit subject |
|---|---|---|---|
| **PASS** | `walk: <name YYYY-MM-DD>` · `state: signed-off` · `head: <sha>` · `hold: none` · `verify: none` — a pre-walk verdict is stale · `next: /builder:verify --path <folder>` | the header line; the §Plan index stripped and `PLAN.md` removed — §The condense | `docs(<key>): <feature> signed off` |
| **PASS + HOLD** | the same, with `hold: "<reason>"` and `next: 🛑 held — local steps only: /builder:verify --path <folder>` | the header line **plus** the `🛑 PR HELD` line | `docs(<key>): <feature> signed off` |
| **PROBLEMS** | `state` and `walk:` unchanged · `next: /builder:resume --path <folder>` | each finding a `- [ ]` under `## Fixes`, in their words, **each naming the app it is in** | `docs(<key>): <feature> — walk found <n> problems` |
| **PARTIAL** | the same as PROBLEMS | each unexercised item a `- [ ]` under `## Fixes`, **grouped by app**; **no header line** | `docs(<key>): <feature> — walk partial, <n> items owed` |

`<key>` is `--ticket` when given, else the manifest's `ticket:`, else the feature name. `## Fixes` is
the SPEC's last section and the only one written after sign-off. **A failed walk is a normal outcome —
record it without spin.**

What was exercised **on which app**, what was skipped and every caveat from step 2 go in the **commit
body** and in one ledger line; the header line stays one line.

## The condense

**On PASS, held or not, condense in the same sitting** — run [`builder:ship`](../ship/SKILL.md)
§At sign-off: it strips the §Plan index by its `## Plan` heading, runs `git rm <folder>/PLAN.md`, and
writes the header line(s). Fold it into the one commit above. The walk is the moment the plan stops
earning its keep: the feature is built, a human has accepted it, and everything the remaining steps
need is in the SPEC, the manifest, the ledger and `git log`.

**The line itself is REFERENCE §Condense's sign-off row.** This step supplies the fields: `<name>` is
the human who typed this command, `<words>` their verdict verbatim on one line, never paraphrased.

**PROBLEMS and PARTIAL do not condense** — `PLAN.md` still holds the task blocks the `## Fixes` work
runs against, and the §Plan index still points at them; both stay.

## The go-ahead

A manifest at `state: planned` with `go-ahead: none` is not a walk: it is the **build go-ahead**,
recorded here because the same "a human typed it" rule applies. Written exactly as `/builder:plan`
writes it: `go-ahead: <name YYYY-MM-DD>`, `head`, `next: /builder:resume --path <folder>`, commit
`chore(<ticket-or-feature>): <feature> — go-ahead`. Label it **GO-AHEAD (build)** wherever printed,
**never as a sign-off**: no header line, no condense, the PR lock untouched.

```
📍 <feature>: go-ahead recorded — next: /builder:resume --path <folder> · or say go
```

## Re-signing

§Sha binding voids a sign-off for the surface a later commit changed, and `/builder:revise` writes
`- [ ] re-walk: <surface> (<app>) — voided by <sha>` under `## Fixes` when the human declines to
re-walk right then. When they do walk it, this command **appends a second `> ✅ SIGNED OFF …` line
under the first** — the header is a stack of dated lines, never an overwrite — ticks that row, and
sets `walk:` to the new date.

## Sha binding

The sign-off covers the app **as tested** (the recorded HEAD). Docs-only commits don't void it; any
commit changing behaviour on a signed-off surface voids it **for that surface** — say so plainly
("your sign-off predates the fix to X — please re-check X") and re-offer that part of the walk.
🔴 **A change in one app does not void the sign-off for another.** Name which app's walk is voided, so
a re-walk is a minute rather than a morning. The ship step quotes the header line in the PR
description, and the SPEC header carries it from then on.

## Handoff

| Outcome | Footer |
|---|---|
| PASS | `📍 <feature>: signed off + condensed — next: /builder:verify --path <folder> · or say go` |
| PASS + HOLD | `📍 <feature>: signed off + condensed — 🛑 held; local steps only — next: /builder:verify --path <folder> · or say go` |
| PROBLEMS / PARTIAL | `📍 <feature>: <n> fixes owed — next: /builder:resume --path <folder> · or say go` |

**Continuing:** a bare "go", "yes" or "proceed" in reply runs the footer's command yourself — never
ask the human to paste it. REFERENCE §Continuing on "go" has the exceptions.

On a hold, name the local-only steps that remain open and that the PR stays parked until the human
lifts it. The condense's own line names what it removed: `§Plan index stripped · PLAN.md removed`.
