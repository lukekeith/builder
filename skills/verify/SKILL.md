---
name: verify
description: The gate of the /builder:* pipeline — verifies a built feature against its spec across all four MakeReady apps and issues a READY / INCOMPLETE verdict with evidence. Runs AFTER the human's walk. The pipeline's ONE deep pass: every affected app's gate suite fresh, consumer parity against the frozen contract, a /compare pixel diff for every screen with an iPhone twin, the cross-app E2E walk against the local stack, the pattern-regression sweep, and a spec-parity spot-check. Never opens a PR. Use when the user asks to verify a built feature or check whether a feature is done.
---

# `/builder:verify` — is it actually done?

Invocation: **`/builder:verify --path <folder>`**. Flags: [REFERENCE](../resume/REFERENCE.md) §Flags —
**ignore any flag this step does not use rather than erroring on it**.

It reads three things, and **trusts nothing remembered from the build** — every check runs fresh:

- **`<folder>/SPEC.md`** — §Apps names which apps must be verified at all, §Contract is what each
  consumer is checked against, §Testing names what must pass, §Decisions the load-bearing behaviours,
  §Schema & API changes the rows that had to land, §Findings & risks the `repoint:` rows, and `## Fixes`
  whatever is still owed. In prototype mode, §Prototype and §Replaced surfaces as well.
- **`<folder>/MANIFEST.md`** — `state:` · `apps:` · `contract:` · `walk:` · `verify:` · `hold:` ·
  `head`.
- **the SDD ledger** — the sign-off stripped the §Plan index and removed `PLAN.md`, so the ledger plus
  `git log` are the record of what was built:

```
"$(.claude/scripts/build-spec-workspace.sh <feature>)/progress.md"
```

🔴 **Re-resolve that path inline in every command that uses it** — `<feature>` is the folder's basename,
and a shell variable does not survive between Bash calls. Gates: REFERENCE §Quality gates — **the deep
set runs here and nowhere else.**

## Precondition — read `<folder>/MANIFEST.md` first

Without `--path`, run `node .claude/scripts/list-feature-specs.mjs --json` and offer only the folders
whose state is `signed-off` — an INCOMPLETE verdict leaves the state there, so that is the whole list.

| The manifest says | What to do |
|---|---|
| there is no `MANIFEST.md` — the folder shipped and was condensed, or it is a pre-builder layout | this step does not run on it. Say so in one line, hand back to `/builder:resume --path <folder>`, stop |
| `walk:` carries a name + date **and** the SPEC header carries `✅ SIGNED OFF` | run |
| `state: built` with `walk: none` | 🔴 **stop and offer the walk instead** — print `walk.md` from the workspace above and name `/builder:signoff --path <folder>` as what records the verdict. Never run the deep pass on a build nobody has looked at |
| `verify:` already carries a verdict | this is a **re-verify** — scoped, per §A re-verify is SCOPED |
| `hold:` set | run anyway: verify is local and changes nothing outward. The hold binds the PR, and the verdict carries it instead of `next: gh pr create` |
| `state:` anything before `built` | not built yet. One line naming the state and the step that owns it, hand back, stop |

**When two rows fit, the more specific one wins** — a `verify:` line already carrying a verdict makes it
the scoped re-verify row, whatever `state:` says. Handing back is one line plus its own footer:

```
📍 <feature>: <manifest state> — not verified: <reason> — next: <the command the row names>
```

**Why the walk comes first:** the deep pass here needs the server, the client, a simulator and the
capture stack up at once — the slowest and most fragile thing this pipeline runs. A human spots in
seconds what it takes twenty minutes to discover, so the expensive pass is spent once, on what they have
already accepted.

## A re-verify is SCOPED

**A re-verify after a fix is SCOPED:** re-run the gates the diff can turn red; quote the rest from the
earlier run on the same tree, saying which is which. 🔴 **Scope by APP first** — a fix inside
`client/` cannot turn `swiftlint` red, so the iPhone gates are quoted, not re-run.

🔴 **The cross-app E2E walk is NOT automatically part of a re-verify.** A feature's FIRST verify always
runs it (checklist 10). A re-verify runs it only when the diff can change what a consumer does —
classify the diff, say which class you chose, and quote the earlier run when you skip it:

| The diff touches | The cross-app walk on re-verify |
|---|---|
| a §Contract row, an auth or permission path, a load/save/delete path, a push payload or deep link, or a `Route` case | **Yes** — the affected leg of the walk |
| only presentation, **but** changes a string, label or accessible name the walk script asserts on, or a surface a `/compare` twin diffs | **Yes, narrowly** — just that leg and that twin's diff |
| only presentation, and nothing the walk or a twin reads | **No** — that app's fast gates only, plus a look at the running app if it's visual |

The middle row is the one worth reading twice: "cosmetic" is not a safety guarantee. A reworded label
changes a `/compare` twin's pixel diff, and a renamed accessible element changes what the walk taps.

**Batch, don't drip:** in an interactive back-and-forth, the walk waits for the end of the batch of
changes, not each one.

## The checklist (all must hold for READY)

1. **The walk happened** — the SPEC header carries `> ✅ SIGNED OFF <date> — <sha> · by <name>` and the
   manifest's `walk:` names who and when. `/builder:signoff` is `disable-model-invocation`, so that pair
   is proof a human typed it; a header line written by an agent is **void** — re-offer the walk. 🔴 **A
   four-app feature needs a walk that covered each in-scope app**: a sign-off recorded as PARTIAL with
   an app's items unexercised is not a full walk, and those items are named in the verdict.
2. **Every task landed** — the sign-off stripped the §Plan index and removed `PLAN.md`, so the task list
   comes from the ledger's **pre-flight table**, which `builder:build` writes before Task 1 and is the
   durable list. Ledger gone → recover the plan from the sign-off commit's parent:
   `git log -- <folder>/SPEC.md` finds that sha, then `git show <sign-off sha>^:<folder>/PLAN.md` prints
   the plan. Every task has a `Task N: complete` ledger line, every phase its `Phase N: closed` line,
   and the manifest's `head` plus `git log` show the commits. **No `- [ ]` remains under SPEC
   `## Fixes`** — a declined re-walk sits there too. A row explicitly owed to a human judgment is named,
   not blocking. 🔴 **An iPhone phase whose commits were staged but never approved is not landed** —
   say so plainly; it is the human's call, not a failure.
3. **Gates green NOW, per app** — the full fast set for **every app §Apps marks in scope**
   (REFERENCE §Quality gates), outputs recorded. Plus the ones the build never runs: the client PHPUnit
   suite, and `swiftlint` across `iphone/`. Record the two known-red repo-wide gates as BLOCKED with
   evidence rather than failing on them, and report `client: npm run guard` as the **delta**.
4. **Schema rows landed** — every SPEC §Schema & API changes row's Status carries its **real migration
   name** or is explicitly deferred with a named decider; `npm run schema:validate` passes;
   `npm run migrate:status` is clean; Data plans executed. 🔴 **And the migration re-applies on a fresh
   database** — a migration that only works against your local state is a production incident waiting.
5. **🔴 Consumer parity against the FROZEN contract** (`opus`) — the check this monorepo exists to have.
   For every §Contract row: the server implements exactly that shape, and **each named consumer codes
   against exactly that shape**, traced in the shipped code with `file:line`. Then the compatibility
   question: **what does a currently-released iPhone build see?** Any rename, removal, type change,
   nullability change or enum narrowing on a field it reads is a gate failure unless §Apps *Backward
   compatibility* states the transition and the code implements it. The manifest's `contract:` line must
   read `frozen` — an open contract on a built feature means the server phase never closed properly,
   and that is a finding.
6. **No OPEN decisions** in SPEC §Decisions; every *Replaces* item in §Client and §iPhone covered or
   dropped-with-a-decider. Shipping by silently deleting a capability users have is a gate failure.
7. **Pattern-regression sweep** on the feature's new code, per app — mechanical, don't assume the
   linters covered it. **server:** no business logic left in a route module; the org-level permission
   check (never `creatorId`) on every new endpoint; zod on every mutating body and not stripping
   consumer fields; nothing sensitive logged; no hand-edited migration. **client:** no component-level
   `fetch`; admin calls through the proxy; design-token SCSS (report the guard delta); 🔴 no
   `window.confirm`/`alert`/`prompt`. **iphone:** every shared or mutated server-derived collection in
   `AppState` and refreshed by its mutating Action; no `APIClient` from Pages or Components; 🔴 no
   `.sheet`, no `.fullScreenCover`, no `asyncAfter` choreography — grep the diff, don't trust the lint.
   **capture:** twins additive-only and registered; no BEM root colliding with a legacy web component.
8. **§Testing satisfied** — each named test exists and passes at its layer; in prototype mode every
   `B#` owed row is now backed by a committed test or a captured state, not by a walk that saw it once.
9. **`/compare` diffs** — for every screen with an iPhone twin, a fresh capture and diff:

   ```
   node capture/runners/compare/diff.mjs …
   ```

   🔴 Web captures go through the **host artisan on `:8002` with `CAPTURE_BASE_URL`**, not docker
   `:8001`, and the client bundle is rebuilt first — otherwise the shots are silently blank. The diff
   percentage is **advisory**: judge the delta PNG and the hot bands, and consult the `compare-*`
   auto-memories before calling a known snapshot artifact a regression.
10. **The cross-app E2E walk** — 🔴 the ONE place the pipeline exercises every app at once: §Testing's
    walk script, executed live against the local stack (`/dev-start`) with the simulator running. Can't
    bring the stack up → **BLOCKED-on-environment**, never READY. Mandatory on a feature's **first**
    verify; on a re-verify it is conditional — see §A re-verify is SCOPED, and quote the earlier run
    when the diff didn't earn a new one.
11. **Spec-parity spot-check** (`opus` judgment, not grep) — trace the spec's 3–4 most load-bearing
    behaviours (permission gates, org scoping, state rules, offline behaviour, push routing) in the
    shipped code with `file:line`. This catches a feature that passes every gate while doing something
    the spec didn't say.

**Prototype mode adds 12 and 13.**

12. **The residual sweep at zero** — for every §Findings `repoint:` row, re-grep **that row's app** for
    the surface's route strings, `Route` cases and imports: **zero hits**, and the row's `file:line`
    sites all point somewhere new. A behavioural test guard on a retired surface is **ported, not
    deleted** — a deleted guard is a finding, not a clean sweep.
13. **§Replaced surfaces closed and the obligations discharged** — every `S#` COVERED or DROPPED **with
    a named decider**, every `N#` with a disposition, proven rather than read:

    ```
    node .claude/scripts/check-flow-obligations.mjs <folder>
    ```

    Exit 0 or the item fails. 🔴 **Run it in written-spec mode too** — its §Apps and §Contract
    obligations are not prototype-specific.

## The verdict

**One manifest write** (REFERENCE §MANIFEST.md), plus `head` at this transition, and for INCOMPLETE the
failing items as SPEC tasks:

| Outcome | The manifest | The SPEC |
|---|---|---|
| **READY** | `verify: READY YYYY-MM-DD` · `state: verified` · `next: gh pr create --base main …` — or, with `hold:` set, `next: 🛑 held — <the hold's words>` | unchanged |
| **INCOMPLETE** | `verify: INCOMPLETE YYYY-MM-DD` · `state` unchanged · `next: /builder:resume --path <folder>` | each failing item a `- [ ]` under `## Fixes`, **naming its app** and what clears it |

Commit both files together: `docs(<ticket-or-feature>): <feature> — verify <READY|INCOMPLETE>`.
INCOMPLETE is a normal outcome; the orchestrator loops it, and `/builder:revise` routes any fix that is
more than a `## Fixes` task.

🔒 **READY is not shipped: this skill never opens a PR**, never writes to monday.com, and never deploys.
Hand back to `/builder:resume --path <folder>` for the PR → CI → merge → the SPEC header flipped to
`SHIPPED`. Lead the hand-off with the evidence — which apps' gates ran, which were quoted from an
earlier run, what the contract-parity trace found, what the `/compare` diffs showed, and whether the
cross-app walk ran or was quoted — then:

```
📍 <feature>: verify READY (<apps>) — next: gh pr create --base main
```

```
📍 <feature>: verify INCOMPLETE — <n> fixes owed — next: /builder:resume --path <folder>
```
