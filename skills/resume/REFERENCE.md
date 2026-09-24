# `/builder:*` — the family's shared reference

Every `builder:*` step reads this file for the shapes it writes and the rules it enforces. Load it
before writing anything into a feature folder; steps cite sections by name (`REFERENCE §Sizes`).

🔴 **This plugin knows nothing about your project.** Every project fact — the apps, the gates, the
house rules, the landmines, the recipe skills, the design source — lives in ONE host file,
**`.claude/builder.md`** (`PROJECT.template.md` is the blank). This reference says what the pipeline
*does*; that config says what it does it *to*. **Read the config before any step that touches code,
and cite it rather than repeating it** — a fact duplicated here would go stale in exactly the way
this pipeline exists to prevent.

No config → no pipeline. Say so in one line and name the fix:
`cp <builder>/PROJECT.template.md .claude/builder.md`.

## The first principle

🔴 **Building the feature outranks recording it.** What is retained is high-level; the detail of
every little change is not. The pipelines this replaced produced suites of 15+ numbered docs per
feature — one reached 99KB in its ledger alone — which then had to be kept in sync with each other
by hand. **Git history is the full record; the working tree keeps only what a future reader needs.**
Three rules follow, binding on every skill in the family:

1. **One write-once `SPEC.md` + one moving `MANIFEST.md` per feature.** The SPEC is written once;
   §Decisions and §Findings append; §Plan — a one-line-per-task index into `PLAN.md` — is appended
   after the audit and stripped at sign-off. One more committed file exists between the audit and
   sign-off: the plan itself, `PLAN.md` (§PLAN.md), deleted by that same condense. The manifest is
   ~12 lines of `key: value`, the only committed file that moves with progress. xs and sm produce
   nothing under `docs/`.
2. **Process state lives in the workspace, never in a committed doc.** The ledger, task briefs,
   reports, review diffs, the walk script and the proof behind a coverage claim live in
   `.builder/<feature>/`, which is git-ignored. A phase close is a ledger line plus `git log`.
3. **Condense at sign-off.** When a human accepts the build, the §Plan index is stripped, `PLAN.md`
   is removed and the header line written; ship flips that line and deletes the manifest. No README
   — the SPEC is the record.

## The scripts

The plugin ships its own; nothing needs installing. Resolve the directory **once per session** and
paste the absolute path thereafter — 🔴 a shell variable does not survive between Bash calls:

```bash
# The supported way: Claude Code sets this to the plugin's own directory, whatever
# the install shape. Use it whenever it is set.
[ -n "$CLAUDE_PLUGIN_ROOT" ] && echo "$CLAUDE_PLUGIN_ROOT/scripts" || {
  # Fallbacks, in order, for contexts where it is not set:
  { ls -d "$(git rev-parse --show-toplevel 2>/dev/null)/plugins/builder/scripts" 2>/dev/null
    find "$HOME/.claude/plugins" -type d -name scripts -path '*builder*' 2>/dev/null | sort -V | tail -1
  } | head -1
}
```

🔴 **Prefer `$CLAUDE_PLUGIN_ROOT`.** It is the documented, portable way for a plugin to reference its
own files, and it is correct for every install shape — marketplace, vendored, or a local skills
directory. The fallbacks exist only because it is not set in every context, and each has a flaw the
variable does not:

- the repo-vendored path only finds a copy checked into the consuming repo;
- the `find` only finds a copy the marketplace has already materialised on disk — **a freshly
  installed plugin may not be there yet**, because the CLI records the install and Claude Code
  fetches the files when a session loads it.

Two details in the fallbacks, both paid for: **no bare `~/.claude/plugins/*/…` glob** (under `zsh` an
unmatched glob aborts the whole command), and **`sort -V | tail -1`** on the `find` (a marketplace
keeps every version it has fetched side by side, so an unsorted `find` returns a stale one — with
2.0.0, 6.3.0 and 10.0.0 present it picked 6.3.0).

Resolving to nothing means the plugin is not reachable from this context; say so rather than guessing
a path.

Below, `<builder>/scripts/x` means that resolved path.

| Script | What it does |
|---|---|
| `list-features.mjs` | every feature in the registry with its state and next command — the picker's data source. `--json` · `--check` · `--all` |
| `check-obligations.mjs` | the cross-section gate on a `SPEC.md` (§SPEC.md). Exit 1 = a dangling obligation, and it names its own rows |
| `workspace <feature>` | prints and ensures the git-ignored workspace for one feature |
| `task-brief PLAN N OUT` | extracts one task's text for its implementer |
| `review-package BASE HEAD OUT` | the commit list, stat summary and diff a reviewer reads in one call |

Every one of them reads `.claude/builder.md` and fails with the one line that fixes it when it
cannot.

## Sizes

| Size | Looks like | Typical files | Design artifact | Audit | Plan | Execution | Human gates |
|---|---|---|---|---|---|---|---|
| **xs** | a copy change, a colour, a prop default, a one-line guard | 1–2 | one sentence in chat | — | — | main context | approve the sentence |
| **sm** | move a button, rework a form's layout, upgrade a component's props, restyle a view | 2–10 | short design in chat, after a grill of ≤3 questions | — | — | main context | approve the design · a look at the running app before the PR |
| **md** | add an endpoint + its screen, add a capability to an existing feature, port one screen to a new pattern | 10–40 | `SPEC.md`, short: overview · apps · decisions · contract · testing; per-app sections only where touched (~120 lines) | 1 pass, single agent | `PLAN.md`, 2–4 phases | the task loop | decisions · go-ahead · the walk |
| **lg** | a new feature: a model + endpoints + screens in each consumer | 40–150 | full `SPEC.md` | 1 pass, parallel agents | `PLAN.md`, 4–7 phases | the task loop | the same three |
| **xl** | a new area across several subsystems | 150+ | `PROGRAM.md`: the children, their order, the decisions they share; each child runs as its own md/lg | per child | per child | per child | one program go-ahead, then per child |

## The classifier

Checked before any question is asked, from recon; announced with the evidence.

1. Does the flow being changed already exist to read? **No → at least md.**
2. A new model, schema change, endpoint, permission or contract change? **Any → at least md.**
3. A new route, screen, or shared component? **Any → at least md.**
4. **Apps touched (from the config's `apps:`)? Two+ → lg.** Three+ with independently shippable
   slices → xl.
5. Fits one sitting? **No → at least md** (the spec exists so `/clear` can happen).

A feasibility question ("can we…", "is it possible…") is a **spike, not a build**: say so, answer it
as a question — read the code, run the experiment, report what you found — and do not wrap it in a
feature folder. A spike that concludes "yes, and here's how" becomes a `/builder:brainstorm` run
afterwards.

🔴 **In a multi-app repo, rule 4 is the one that bites.** A change that crosses an app boundary is
never sm, because the contract between the apps is the thing that breaks — and when a consumer is a
released artifact (the config's `released_artifact: true`), it breaks somewhere that cannot be
hot-fixed. **The sm/md line is drawn by contracts, not file count**: a change inside one app and
inside existing contracts is sm however many files it brushes; the moment it adds a model, a schema
row, an endpoint, a permission, a route or a screen, it earns a spec.

**Classification is announced with evidence, overridable, and ratchets up only.** `--size` forces it.
Hidden complexity found mid-task upgrades: stop, say so, write the spec then. Nothing downgrades
mid-task. When in doubt, the heavier size.

## Flags

| Flag | Meaning |
|---|---|
| `--path <dir\|file>` | the feature folder (or its `SPEC.md` / `PROGRAM.md`). Omitted → the picker |
| `--size xs\|sm\|md\|lg\|xl` | force the size; classification skipped, result still announced |
| `--ticket <id>` | recorded in the manifest; the commit-message key and PR body; triggers the branch-name check. When the config's `ticket.dossier` names a path, that dossier is read as design input |
| `--<design.flag> <ref>` | **prototype mode** — a finished design read AS the requirements. The flag's name comes from the config (`design.flag`), so it reads `--design`, `--ui2`, `--figma`… in your repo. Absent from the config → the flag does not exist and prototype mode never runs |
| `--all` | with a ref that resolves ambiguously: take every match without asking. Otherwise redundant — a ref already means everything beneath it |
| `--auto` | autopilot: recommendations become rulings, marked `auto (recommended)`; ends at the walk |
| `--help` | print the help: on `/builder:brainstorm` or `/builder:resume` the `builder:help` card; on any other family skill its own Invocation line and the flags it reads. Then STOP — no recon, no file touched. Overrides every other flag |
| *free text after the flags* | the work itself: `/builder:brainstorm --size sm move the save button into the header` |

**Parsing convention:** flags first, each as `--key value` (bare for a boolean), free text after them
is the work. A skill **ignores any flag it does not use and never errors on one**, so a family flag
survives a chained command — `--help` is the one flag every skill honours, first. Resolving a design
ref is [`SCOPE-SELECTION.md`](SCOPE-SELECTION.md).

## Branch and ticket

No skill in the family creates a branch, a worktree or a ticket — those belong to the developer.
Given `--ticket`, a skill *checks* that the current branch name carries the key and warns once if it
does not; it never checks anything out. On resume, a current branch different from the manifest's
`branch:` gets one line of warning and the run continues.

🔴 **No skill dispatches an implementer or commits while the checked-out branch is the config's
`base_branch`.** Stop, say the human cuts the branch, and name why: work reaches the base branch only
through a PR.

**Tickets are whatever the config's `ticket.system` says.** When `ticket.dossier` names a path
pattern, the dossier for `--ticket <id>` is **design input**: a dossier that records a confirmed
blast radius is exactly the scope statement §Apps needs, so a ticket with one starts from settled
scope. 🔴 **The family never writes to the ticket system.** Reporting a fix back is a separate,
explicit command the config's §Companion skills names.

## Where things live

```
<registry>/<feature>/
  SPEC.md        design, written once. §Decisions / §Findings append-only. §Plan — the task index —
                 appended after the audit, stripped at sign-off. Header line written at sign-off,
                 flipped at ship.
  PLAN.md        the plan itself, with the code. Written by /builder:plan after the audit, read at
                 the go-ahead, `git rm`-ed by the sign-off condense.
  MANIFEST.md    the only committed file that moves with progress.

<registry>/<program>/
  PROGRAM.md     xl only: the children, order, shared decisions.
  MANIFEST.md    tier: program · per-child states.

.builder/<feature>/                  git-ignored; `<builder>/scripts/workspace <feature>` prints it
  progress.md                        the ledger: phase closes, gate runs, rulings, env notes
  walk.md                            the walk script, written when the last phase signs
  task-N-brief.md · task-N-report.md · review-*.diff
```

`<registry>` is the config's `registry:`. `PLAN.md` is the only committed file `/builder:plan` adds,
and the only one carrying code outside the codebase. Everything process-shaped lives in the
workspace and never moves into a committed doc.

**What is NOT a feature folder.** A design-system program, a ticket dossier directory, a docs site —
none of them are build registries, and `list-features.mjs` reads only the one the config names.

## MANIFEST.md

```markdown
size: md
state: spec | aligned | audited | planned | building | built | signed-off | verified | shipped
next: /builder:resume --path <registry>/<feature>        # the ONE next command, or a decision
head: <sha at last transition>
ticket: <id> | none
branch: <branch at last transition>                   # informational; a mismatch warns
pr: #NNNN | none
apps: <app>+<app>                                     # the in-scope apps, from SPEC §Apps
contract: frozen <YYYY-MM-DD> | open | none           # none = no producer change
hold: none | "<reason>"                               # 🛑 PR HELD, in the human's words
go-ahead: <name YYYY-MM-DD> | auto (recommended) YYYY-MM-DD | none
walk: <name YYYY-MM-DD> | none
verify: READY YYYY-MM-DD | INCOMPLETE YYYY-MM-DD | none
<design.flag>: <the resolved ref and its set> | none   # prototype mode; key named by the config
auto: on YYYY-MM-DD | off
```

**Write moments** — the manifest commits at step transitions and stops, never per phase: spec
written · aligned · audited · planned · built · signed off · verified · shipped, plus **any
mid-build stop** and **the contract freeze** (the phase close that verifies the producer).
Per-phase state is a ledger line plus `git log`.

**`apps:` and `contract:` are the multi-app lines.** `apps:` is the plus-joined in-scope list, so the
picker shows blast radius without opening the spec. `contract:` is the freeze — §The contract freeze.
A single-app repo writes `contract: none` and the freeze machinery stays quiet.

**Program variant:** replace `size:` with `tier: program`, drop `state:` (a program has no state of
its own — its children carry theirs), and add one `child: <name> — <state>` line per child.

## SPEC.md

Sections in this order; md writes only the ones its work touches, lg writes them all. **§Apps and
§Contract are never skipped** in a multi-app repo — they are what makes a cross-app change safe.

```markdown
# <feature> — spec
> size · ticket · (header line written at sign-off: ✅ SIGNED OFF … / ✅ SHIPPED …)

## Overview
## Apps                 | App | In scope | What changes | Section |   one row per config app, always
## Decisions            | # | Decision | Ruling | Who / date |     OPEN rows block the go-ahead
## Contract             the interface every consumer codes against — §The contract freeze
## Schema & API changes | # | ADD/EDIT/RENAME/REMOVE | Model.field | Wire | Reason | Status |
<!-- Every data/API change, or the one line "No schema change (established YYYY-MM-DD)".
     Migrations follow the config's house rules for the producing app. A NOT NULL add on a
     populated table needs a stated backfill. -->
**Data plan:** <backfill/default/retention for anything touching existing rows — REMOVE and
NOT-NULL EDIT rows must appear here. Ordering if the migrations aren't independent.>
## <App>                one section per IN-SCOPE app, named exactly as the config names it:
                       what changes there, in that app's own vocabulary
## Testing              per app · the ONE cross-app E2E walk · the human-verification script
## Out of scope
## Findings & risks     | # | Finding | Resolution |     the audit writes here; a row it cannot settle is marked `build-time risk` naming the task that settles it
## Plan                 the task index + a pointer to PLAN.md; appended by /builder:plan, stripped at sign-off

# prototype mode only — two sections:
## Prototype            the ref · the resolved set, their contracts and whether each is built · frozen paths
## Replaced surfaces    | # | Surface (file:line) | REPLACES/ABSORBS/REUSES | Fingerprint |  then S# gaps, N# adds — each row with its disposition AND its owning app

## Fixes                appended after sign-off: `- [ ]` tasks from a PROBLEMS walk, a verify INCOMPLETE, a review, or a declined re-walk; each naming its app; always the LAST section; absent when empty
```

**`## Fixes` is the only section written after sign-off.**

Target ≤ 300 lines; `list-features.mjs --check` warns at 500 — a longer SPEC is usually two features.

`check-obligations.mjs` reads §Apps, §Contract, §Schema & API changes, §Findings and §Replaced
surfaces, and is what turns each into an enforced obligation rather than a habit.

**The §Decisions comment block, copied into every SPEC verbatim:**

```markdown
<!-- The one place rulings live. Record the DECISION, not the conversation: a stated preference
     is the INPUT to a row, not the row. Write each Ruling as something later code can be checked
     against without re-interpretation:
       · positive and specific — "store the full number, mask at render", not "don't truncate"
       · scope named — which apps, screens or endpoints it binds
       · "etc." / "and so on" expanded into the list, or the test for membership stated
       · the rejected alternative named, when it would otherwise be re-proposed
       · the enforcement hook, where one exists (lint rule, script, test)
     🔴 NEVER quote the user's prompt as the ruling. Operationalize it: a closed list, a measured
     value, an enumerated set of deviations. A ruling a stranger could implement two ways is not
     written yet.
     Who/date carries the provenance, so the Ruling itself needs no quote marks.
     OPEN rows block the build go-ahead. Never delete a ruling; supersede it in place with a date. -->
```

### §Apps — the multi-app section

What stops a spec from shipping a producer change that silently breaks a consumer in production.

```markdown
## Apps

| App | In scope | What changes | Section |
|---|---|---|---|
| <app> | ✅/⬜ | <what changes there> | §<App> |

⬜ rows state **why not** in one line.

**Sequencing:** contract settled → the producer implements and verifies (contract FREEZES) →
consumers build against the frozen contract, parallelizable when they don't import each other →
tools re-capture → the cross-app E2E walk.

**Backward compatibility:** <what a RELEASED build of each `released_artifact` app sees while this
rolls out. An additive field is safe; a renamed or removed one is not, and needs a stated
transition.>

**Blast radius:** <what else reads this data.>
```

🔴 **Every app the config declares gets a row, including the ones it doesn't touch.** An omission you
can read is a decision; a missing row is an oversight. The audit re-derives every ⬜ claim, and
`check-obligations.mjs` fails on a missing row and on an in-scope app with no section of its own.

A **single-app** repo writes one row and the section is a formality — which is correct: it costs a
line, and the pipeline behaves identically if the repo later grows a second app.

### §Contract and the contract freeze

The interface between the producer and its consumers, in whatever form the project's contract takes
— an endpoint table, a schema, a published package API:

```markdown
## Contract

| Contract | Producer | Consumers | Auth | Request | Response | Errors |
|---|---|---|---|---|---|---|
```

**Every row names at least one consumer** — an interface with no consumer is either dead or a
consumer nobody audited, and `check-obligations.mjs` fails on it.

🔴 **The contract FREEZES when the producer's phase verifies.** From that moment consumers code
against it and it is not edited to suit them: a consumer needing a different shape is a
`/builder:revise` contract change that re-opens the freeze deliberately, re-taking the go-ahead if
the phase table moves. The manifest records `contract: frozen <date>`. The reason is blunt: two
consumers building against a moving contract is how one ships broken, and a released artifact cannot
be hot-fixed.

**§Plan is an index, not the plan** — one line per task plus a pointer to `PLAN.md`. Written after
§Findings & risks and stripped at sign-off **by its `## Plan` heading, never by position**:

```markdown
## Plan

The plan, with its code: `<registry>/<feature>/PLAN.md` (§PLAN.md).

- Phase 1 · Task 1 · <name>
- Phase 1 · Task 2 · <name>
```

A row is `Phase N · Task M · <name>` and nothing else. **Task numbering runs across the whole plan**,
because `task-brief` keys on the literal `Task N` heading.

## PLAN.md

The plan itself, written by `/builder:plan` after the audit. **Committed**, beside the SPEC, so the
human reads it at the go-ahead and a reviewer sees it in the PR; the sign-off condense deletes it and
`git log` keeps it.

**Its shape is [`../plan/PLAN-FORMAT.md`](../plan/PLAN-FORMAT.md)** — the header, the `## Phases`
table (`Phase · App · Tasks · Goal · Gates`), then flat `### Task N` blocks carrying `App:`,
`Phase:`, `Recipe:`, **Files**, **Interfaces** and bite-sized `- [ ]` steps with the actual code.
Read it there rather than from a restatement.

The two rules worth repeating because everything else depends on them:

- 🔴 **Nothing sits between task blocks, and nothing after the last one.** `task-brief` reads a task
  from its heading to the next `Task <n>` heading at any level, or to end of file for the last one.
- 🔴 **One app per task, and per phase.** A phase's `Gates` cell is that app's fast set from the
  config; a task straddling apps cannot be gated.

## PROGRAM.md

xl only, ~50 lines.

```markdown
# <program> — program
> tier: program · ticket/epic

## Overview
## Children             | # | Feature (folder) | Size | Apps | One line | Depends on |
## Shared decisions     | # | Decision | Ruling | Who / date |     binding on every child
## Out of scope
```

🔴 **Children are ordered by the contract**, not by convenience: a child producing a contract another
consumes ships first — the phase rule, one level up.

## Prototype mode

Entered by the config's design flag. **The design is the requirements** — a finished, specced design
is read as the spec instead of interviewing for one. It exists only when the config has a `design:`
block; without one, skip every prototype-mode paragraph in this family.

The config's `design:` block names four things: the **flag**, a **resolver** command, where the
**contracts** live, and which commands **own** that design. Procedures:
[`SCOPE-SELECTION.md`](SCOPE-SELECTION.md) (resolving a ref) · [`SURFACE-CHECK.md`](SURFACE-CHECK.md)
(`S#`/`N#` discovery).

1. **Resolve the ref** with the config's resolver and echo the scope as a tree, so what was and
   wasn't read is plain. Classify size from the whole set.
2. **Inventory the design**: for every in-scope item, its contract, its designed states and variants,
   its props, its open questions, and whether it has been **built** (rendered, and diffable against
   the design). The inventory goes to the ledger; only its summary reaches SPEC §Prototype.
3. **Compare against reality**, five axes, in parallel where it pays (`sonnet` sweeps, `opus`
   verdicts): replaced surfaces (`S#`/`N#`, fingerprints); journey edges (ingress · egress · shared
   surfaces); component coverage; conventions (the config's design section); a *light* read of what
   the design persists — the full trace is the align step's.
4. **Walk the gap list** — deduplicated across the set (one gap, N sites), ordered by blast radius,
   one gap per turn, recommendation first, the three options below.
5. **Write** SPEC (+ §Prototype, §Replaced surfaces) and the manifest from what remains.

Then **align** — the conditional step between design and audit: every persisted field traced from
the design through the producer's model, validation, wire and write path, and onward to the property
each consumer reads it from; `SC#`/`T#` rows written; manifest `state: aligned`.

**The three options, offered for every gap:**

| Option | When it is right | What happens |
|---|---|---|
| **Fix it in the design now** | the *contract* is incomplete or wrong — an undesigned state, a prop the build needs | route it to the command the config's `design.owned_by` names, and re-read the contract before proceeding. The design stays the single source of truth |
| **Write it into the SPEC** | the *app* is what changes | an `N#` add → `T#`/`SC#` rows; a deliberate divergence from the live surface → a §Decisions ruling; something a build phase settles → a §Findings row |
| **Out of scope** | neither, for now | a §Out of scope line with the decider, so the cut is visible rather than forgotten |

🔴 **This family NEVER writes the design.** Contracts, registries, tokens and design notes belong to
the commands the config names. Prototype mode *reads* the design and *routes* a gap to its owner. The
design layer is frozen after the go-ahead: a change then goes through `builder:revise`.

Under `--auto` a gap takes the recommended option, and "fix it in the design" is recommended only for
a bounded, mechanical fix — never for a design change.

**An unbuilt design item is still requirements** — its contract is normative whether or not anyone
rendered it. Say which items are unbuilt, because it changes the plan's risk: their states have never
been seen. 🔴 Never report an unbuilt item as built, and never build one to make a check pass — that
is the design pipeline's work, offered as an option.

## The craft skills

Four skills ship inside this plugin and bind the *way* work is done, whatever the project is. They
are invocable (`/builder:<name>`) and they are handed to subagents **by path**, because a subagent
gets only what its brief contains.

| Skill | When it binds | Who reads it |
|---|---|---|
| [`test-driven-development`](../test-driven-development/SKILL.md) | implementing any feature or bugfix, before writing implementation code | every implementer · the plan's steps are written in its cycle |
| [`systematic-debugging`](../systematic-debugging/SKILL.md) | any bug, test failure or unexpected behaviour, **before proposing a fix** | an implementer whose test fails for a reason it cannot name · a fix round that is not converging · `/builder:revise` on a reported problem · `## Fixes` work |
| [`receiving-code-review`](../receiving-code-review/SKILL.md) | receiving review feedback, before implementing any of it | every implementer in the fix loop · the main context working a `## Fixes` list |
| [`verification-before-completion`](../verification-before-completion/SKILL.md) | about to claim anything is complete, fixed or passing | every gate claim, every phase close, `/builder:verify`'s whole verdict, and every hand-off that says a thing works |

🔴 **`verification-before-completion` is the rule this pipeline's gates exist to enforce**, stated
once: *no completion claim without fresh verification evidence.* A phase close that reports gates
green without having run them in that message, a verdict quoting a run from an earlier tree without
saying so, or a hand-off that calls something done because an agent said so — each is the same
violation, and each is what the gate table, the `quote it and say which` rule and the PR lock are
built to prevent.

🔴 **`test-driven-development` outranks a plan step that contradicts it.** The plan's steps are
written in its cycle — failing test, watch it fail, minimal code, watch it pass, commit — and a task
block that omits the failing test is a plan defect, reported rather than quietly followed.

## The project's own rules

These live in `.claude/builder.md` and are **read there, every time**:

| What | Config section | Who reads it |
|---|---|---|
| the apps, their roles, which commit manually, which ship released artifacts | frontmatter `apps:` | every step |
| the literal gate commands, per app, fast and deep | §Quality gates | build (phase close) · verify · the walk |
| the block pasted verbatim into every implementer and reviewer brief | §Global constraints | build · plan |
| the audit's per-app checklist | §House rules | audit · verify |
| what costs hours when rediscovered | §Environment landmines | build · verify · the walk script |
| task → recipe skill | §Companion skills | plan (`Recipe:` lines) · build |
| what this project has already paid to learn | §Standing traps | every step |
| the design source and what a build needs from it | §Design source | prototype mode |

🔴 **A step that needs one of these and cannot find the config does not guess.** It says which
section is missing and stops.

## Quality gates — the mechanism

The **fast set** is the config's per-app block, run **fresh at every phase close by the controller**.
A phase touches ONE app, so its gates are one block, never all of them.

The **deep set** runs ONCE, in `/builder:verify`: every in-scope app's fast set fresh, plus whatever
the config's deep block names, plus consumer parity against the frozen §Contract.

A gate the config marks **KNOWN-RED repo-wide** is recorded as BLOCKED with evidence rather than
failing a feature; where the config asks for a **delta** rather than a green exit, report the delta.

### 🔴 The cross-app E2E walk is an END-OF-BUILD gate, not a per-phase one

It needs every app up at once, which is the slowest and most fragile thing this pipeline does, and
the phases under it are already covered in seconds by cheaper tests. So:

- the plan puts the walk — **authoring** it as well as running it — in the **last phase only**;
- the build never runs it as a phase gate;
- verify runs it once and quotes that run in the verdict;
- prefer the cheapest layer that can catch the defect.

**A small change does not re-earn it.** Feature complete → the walk, always. A later tweak → only if
the diff can change what a consumer does: a contract row, an auth path, a load/save/delete path, or
something the walk script asserts on. `builder:verify` §A re-verify is SCOPED holds the table.

## Condense

Two moments, and the SPEC is the record — no README is written. A PROBLEMS or PARTIAL sign-off does
not condense: the §Plan index and `PLAN.md` may both still be needed for the fix tasks.

| Moment | What happens |
|---|---|
| **sign-off** (PASS, written by `/builder:signoff`) | strip the §Plan index from `SPEC.md` **and** `git rm <folder>/PLAN.md`; write under the title `> ✅ SIGNED OFF <date> — <sha> · by <name>: "<words>"`; commit |
| **ship** (verify READY, the PR open — written ON the PR so the merge carries it) | flip that line to `> ✅ SHIPPED <date> — PR #N · <ticket> · signed off by <name>: "<words>"`; `git rm MANIFEST.md`; remove the workspace; commit on the PR branch |

**State detection, binding on every skill in the family:**

| Signal | State | The family does |
|---|---|---|
| manifest `state:` spec · aligned · audited · planned · building · built | in flight | route on the manifest's `next:` line |
| SPEC header carries `SHIPPED` | **DONE** | run no step; print the header; offer a new feature folder |
| header carries `SIGNED OFF`, manifest `verify: none` | signed off | verify next |
| manifest `verify: READY`, `hold: none` | ready to ship | open the PR, then `/builder:ship` on it |
| manifest `hold:` set | parked | local-only steps until the human lifts the hold |

**Legacy layouts.** 🔴 **The manifest is the discriminator.** A folder holding `MANIFEST.md` is this
pipeline's; a folder without one is something else, and no step runs on it until it is converted:

| Shape | What it is | What happens |
|---|---|---|
| numbered or prose docs **plus build state** — phase docs, or a `STATUS.md` ledger | a feature driven by a pipeline that ran before this one | `/builder:resume --path <folder>` offers ONE action: the conversion below |
| docs with **no build state** | analysis that feeds a design conversation, never pipeline-driven | nothing to convert — its next step is `/builder:brainstorm --path <folder>` |
| a `SPEC.md` with no manifest and no condensed header | a half-written feature, or a half-finished conversion | write the missing manifest from what the SPEC records |
| a README or SPEC header that opens `SHIPPED` | **DONE** | no step runs on it |

**The conversion recipe.** 🔴 **Do not rewrite the content.** The old suite's analysis is the
expensive part and it stays exactly where it is.

1. **Write `MANIFEST.md`** from what the folder already records: `size:` from its breadth, `apps:`
   from whatever scope table it has, `state:` from its build state (every phase doc marked verified →
   `built`; some → `building`; none but a plan exists → `planned`; else `audited` or `spec`),
   `ticket:`, `contract:` (`frozen <date>` when the producer's phase is verified, else `open`), and
   `next: /builder:resume --path <folder>`.
   🔴 **A prior pipeline's "verified" is not this pipeline's sign-off.** The walk here comes BEFORE
   the deep pass, so a pre-walk verdict is not one of ours: write `walk: none` and `verify: none`
   unless a human actually exercised the feature, and say so in the SPEC. A `/builder:signoff`
   record's authority comes from the human typing it; writing one any other way forges the gate.
2. **Write `SPEC.md` as the index this pipeline reads** — §Apps, §Decisions (OPEN rows preserved as
   OPEN), §Contract, §Findings & risks, §Testing, and per-app sections that are **one line each
   pointing at the doc that still holds the detail**. The old docs stay on disk, unedited.
3. **Leave the phase docs alone.** They are the plan; the condense at sign-off removes nothing this
   pipeline did not write — say so in one line rather than deleting work the human may still want.
4. **Record the conversion** with its date and commit it.

Reopening a shipped feature is a deliberate human act: recover the history with
`git log -- <folder>`, say so in the SPEC, and treat it as a new build.

## Agent model tiering

`sonnet` for mechanical sweeps (inventories, enumerations, existence checks); `opus` for judgment
(adversarial gap hunt, contract-parity trace, schema-lifecycle analysis); unsure → `opus`. Parallel
agents are fire-and-fold: brief from the docs, fold results into the docs immediately — an unfolded
agent report dies with the session. The execution engine's own tiering is
[`../build/EXECUTION.md`](../build/EXECUTION.md) §Model selection.
