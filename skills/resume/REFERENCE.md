# `/builder:*` — the family's shared reference

Every `builder:*` step reads this file for the shapes it writes and the rules it enforces. Load it
before writing anything into a feature folder; steps cite sections by name (`REFERENCE §Sizes`).

🔴 **This plugin knows nothing about your project.** Every project fact — the apps, the gates, the
house rules, the landmines, the recipe skills, the design source — lives in ONE host file,
**`.claude/builder.md`** (`PROJECT.template.md` is the blank). This reference says what the pipeline
*does*; that config says what it does it *to*. **Read the config before any step that touches code,
and cite it rather than repeating it** — a fact duplicated here would go stale in exactly the way
this pipeline exists to prevent.

No config → no pipeline. Say so in one line and name the fix: **`/builder:init`**, which writes it
from the repo (or `cp <builder>/PROJECT.template.md .claude/builder.md` and fill it in by hand).

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
    find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins" -type d -name scripts -path '*builder*' \
      2>/dev/null | sort -V | tail -1
  } | head -1
}
```

`job.mjs` is the one for unattended runs: `start <name> -- <command>` launches a long command
detached under `.builder/jobs/`, and `wait <name>` blocks up to 9 minutes (Bash timeout 600000) and
exits with the command's own code — or 75 with `still running`, to be called again. It is how a
headless run waits on a gate suite without backgrounding anything (resume §`--agent-walk`).

🔴 **Prefer `$CLAUDE_PLUGIN_ROOT`.** It is the documented, portable way for a plugin to reference its
own files, and it is correct for every install shape — marketplace, vendored, or a local skills
directory. The fallbacks exist only because it is not set in every context, and each has a flaw the
variable does not:

- the repo-vendored path only finds a copy checked into the consuming repo;
- the `find` only searches the config directory, and depends on guessing where it is.

Three details in the fallbacks, each paid for by a real failure:

- 🔴 **`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`, never a hardcoded `~/.claude`.** The config directory
  moves — on the machine this was written, it is `~/.claude-home` — and a hardcoded path finds
  nothing there while looking convincingly correct.
- 🔴 **No bare `…/plugins/*/…` glob.** Under `zsh` an unmatched glob aborts the whole command.
- 🔴 **`sort -V | tail -1`**, not `head -1`: a marketplace keeps every version it has fetched side by
  side, so an unsorted `find` returns a stale one — with 2.0.0, 6.3.0 and 10.0.0 present it picked
  6.3.0, and `-V` is what makes 10.0.0 beat 6.3.0.

Resolving to nothing means the plugin is not reachable from this context; say so rather than guessing
a path.

Below, `<builder>/scripts/x` means that resolved path.

| Script | What it does |
|---|---|
| `list-features.mjs` | every feature in the registry with its state and next command — the picker's data source. `--json` · `--check` · `--all` · `--status` (the `/builder:status` table) |
| `check-obligations.mjs` | the cross-section gate on a `SPEC.md` (§SPEC.md). Exit 1 = a dangling obligation, and it names its own rows |
| `gate.mjs <app>… \| --deep [<app>…] \| --all` | 🔴 **the only way a gate block is run** (§Quality gates — the mechanism): runs the config's fast set per app and/or its deep set, applies `flaky:`, `@delta` and `@known-red`, and quotes a set whose inputs are byte-identical to its last green run, naming the sha. Exit 0 green, 1 red. `--force` runs regardless; `--baseline` records the `@delta` counts (the fleet does this at start) |
| `workspace <feature>` | prints and ensures the git-ignored workspace for one feature. `--remove <feature>` deletes it — the ship step's call, because `rm -rf "$(…)"` is refused by the harness |
| `task-brief PLAN N OUT` | extracts one task's text for its implementer |
| `review-package BASE HEAD OUT` | the commit list, stat summary and diff a reviewer reads in one call |

Every one of them reads `.claude/builder.md` and fails with the one line that fixes it when it
cannot.

## Sizes

| Size | Looks like | Typical files | Design artifact | Audit | Plan | Execution | Human gates |
|---|---|---|---|---|---|---|---|
| **xs** | a copy change, a colour, a prop default, a one-line guard | 1–2 | one sentence in chat | — | — | main context | approve the sentence |
| **sm** | move a button, rework a form's layout, upgrade a component's props, restyle a view | 2–10 | short design in chat, once the concept is confirmed in the conversation | — | — | main context | approve the design · a look at the running app before the PR |
| **md** | add an endpoint + its screen, add a capability to an existing feature, port one screen to a new pattern | 10–40 | `SPEC.md`, short: idea · apps · decisions · contract · testing; per-app sections only where touched (~120 lines) | 1 pass, single agent | `PLAN.md`, 2–4 phases | the task loop | decisions · go-ahead · the walk |
| **lg** | a new feature: a model + endpoints + screens in each consumer | 40–150 | full `SPEC.md` | 1 pass, parallel agents | `PLAN.md`, 4–7 phases | the task loop | the same three |
| **xl** | a new area across several subsystems | 150+ | `PROGRAM.md`: the children, their order, the decisions they share; each child runs as its own md/lg | per child | per child | per child | one program go-ahead, then per child |

## The classifier

Run on the confirmed concept, from recon and the settled tree; the size is announced with its
evidence.

1. Does the flow being changed already exist to read? **No → at least md.**
2. A new model, schema change, endpoint, permission or contract change? **Any → at least md.**
3. A new route, screen, or shared component? **Any → at least md.**
4. **Apps touched (from the config's `apps:`)? Two+ → lg.** Three+ with independently shippable
   slices → xl.
5. Fits one sitting? **No → at least md** (the spec exists so `/clear` can happen).

A feasibility question ("can we…", "is it possible…") is a **spike, not a build**: say so, answer it
as a question — read the code, run the experiment, report what you found — and do not wrap it in a
feature folder. A spike that concludes "yes, and here's how" becomes a `/builder:brainstorm` (or `/builder:intake`) run
afterwards.

🔴 **In a multi-app repo, rule 4 is the one that bites.** A change that crosses an app boundary is
never sm, because the contract between the apps is the thing that breaks — and when a consumer is a
released artifact (the config's `released_artifact: true`), it breaks somewhere that cannot be
hot-fixed. **The sm/md line is drawn by contracts, not file count**: a change inside one app and
inside existing contracts is sm however many files it brushes; the moment it adds a model, a schema
row, an endpoint, a permission, a route or a screen, it earns a spec.

**Classification is announced with evidence, overridable, and ratchets up only.** The size is announced with its evidence after the conversation confirms the concept; the user confirms or overrides it.
Hidden complexity found mid-task upgrades: stop, say so, write the spec then. Nothing downgrades
mid-task. When in doubt, the heavier size.

## Flags

| Flag | Meaning |
|---|---|
| `--path <dir\|file>` | the feature folder (or its `SPEC.md` / `PROGRAM.md`). Omitted → the picker |
| `--ticket <id>` | recorded in the manifest; the commit-message key and PR body; triggers the branch-name check. When the config's `ticket.dossier` names a path, that dossier is read as design input |
| `--<design.flag> <ref>` | **prototype mode** — a finished design read AS the requirements. The flag's name comes from the config (`design.flag`), so it reads `--design`, `--ui2`, `--figma`… in your repo. Absent from the config → the flag does not exist and prototype mode never runs |
| `--all` | with a ref that resolves ambiguously: take every match without asking. Otherwise redundant — a ref already means everything beneath it |
| `--auto` | autopilot: recommendations become rulings, marked `auto (recommended)`; ends at the walk |
| `--agent-walk` | **unattended mode**, what `/builder:fleet` runs: implies `--auto`, and **never asks** — every pause takes its recommendation; it parks only on a product decision the spec leaves open, or a step the config reserves to the human (resume §`--agent-walk`). Resume passes `--auto` along with it to every step it runs, so a step that only knows `--auto` still settles its own pauses. The walk and sign-off are `/builder:agent-walk`'s; the feature is shipped and merged into the fleet's target branch, locally (resume §Ship in agent mode). Needs the config's `agent_walk:` block. Recorded on the manifest as `agent-walk: on` |
| `--into <branch>` | agent mode's target: the branch the fleet was run from, which every finished feature is merged into. The fleet passes it; resume §Ship in agent mode needs it |
| `--no-dev-env` | never start, migrate or touch the dev environment. Where a step needs it, write `ready: pending "dev env (fleet walk lane)"`, commit, and end the run. The fleet's build lane passes it, so parallel worktrees never share a dev env |
| `--help` | print the help: on `/builder:brainstorm`, `/builder:intake`, `/builder:spec` or `/builder:resume` the `builder:help` card; on any other family skill its own Invocation line and the flags it reads. Then STOP — no recon, no file touched. Overrides every other flag |
| *free text after the flags* | the work itself: `/builder:brainstorm move the save button into the header` |

**Parsing convention:** flags first, each as `--key value` (bare for a boolean), free text after them
is the work. A skill **ignores any flag it does not use and never errors on one**, so a family flag
survives a chained command — `--help` is the one flag every skill honours, first. Resolving a design
ref is [`SCOPE-SELECTION.md`](SCOPE-SELECTION.md).

## Continuing on "go"

Every handoff ends in a 📍 footer naming the one next command. **The human does not have to paste
it.** When their next message is a **bare affirmative** — "go", "yes", "proceed", "continue",
"approve", "ok", "next", "do it", "keep going" and the like — and **your previous message** ended in
a 📍 footer naming one complete command, run that command yourself through the Skill tool, in that
turn, with the footer's `--path` and the flags the run already carries (`--ticket`, `--auto`). Don't
re-print it and ask them to type it.

**Nothing is skipped.** The command runs exactly as if typed — its own Step 1, the manifest as the
state, every gate and stop intact. An affirmative continues **to the next step**; it never answers a
gate that step will raise (the decisions gate, the go-ahead, a manual-commit app, applying a
migration). Those still ask, as they would have.

**An affirmative does not continue** — answer in one line with what the human does instead:

| The footer names | Why | Answer with |
|---|---|---|
| `/builder:signoff`, or 🔒 your walk | a sign-off an agent starts is void, and "approve" is not "I walked it" | the exact command to type, with their verdict in their words after it |
| a human's step (`<the human's step>`, apply a migration, restart a service) | only they can do it | the step, then "say go once it's done" |
| a placeholder only the human can fill (`<what you want built>`, `<the change>`) | there is nothing to run yet | ask for the missing text |
| `🛑 held` | the pipeline is parked on their call | the hold's words, and that lifting it is theirs |
| `⛔ parked` (`blocked:` set) | an unattended run stopped on a decision the spec leaves open, or a step the config reserves to the human | the reason, and "delete the `blocked:` line once it's settled, then say go" |
| more than one candidate (`/builder:status`, the picker) | "go" doesn't say which | one AskUserQuestion over the candidates; a feature name or row picks directly |

**Opening the PR** — the one outward-facing step an affirmative can reach, through resume's §Ship —
is still asked once, through AskUserQuestion (**Open the PR** / **Not yet**), before `gh pr create`
runs — except under `--agent-walk`, where no PR opens at all: resume §Ship in agent mode merges into
the fleet's target branch locally.

**Anything more than an affirmative is not one.** "go, but make it blue" is a change: take it through
`/builder:revise` (or brainstorm, for a feature not yet audited) exactly as if it had come with no
footer. An affirmative after the conversation moved on — the footer is not in your previous message
— asks which feature, the way the picker does.

**A `/clear` boundary is a recommendation, not a wall.** A skill cannot clear context, but all state
is on disk, so "go" there continues in this session; the footer says the choice:
`next: /builder:resume --path <folder> — say go to continue here, or /clear first for a fresh context`.

**Footers that "go" can continue end with ` · or say go`**, so the human knows it works — e.g.
`📍 <feature>: audited — next: /builder:resume --path <folder> · or say go`. Footers in the
does-not-continue table above don't carry it.

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

<registry>/_archive/<feature>/       shipped: moved here by /builder:ship in the ship commit. Only the
  SPEC.md (PROGRAM.md for a program)  condensed SPEC. Never a row, never read by a routine step;
                                     `list-features.mjs --archived` lists it.

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
walk: <name YYYY-MM-DD> | agent-pass YYYY-MM-DD <sha> | none   # agent-pass: the agent sign-off, written by /builder:agent-walk — never a human's
verify: READY YYYY-MM-DD | INCOMPLETE YYYY-MM-DD | none
ready: yes YYYY-MM-DD <sha> | pending "<what is left>" | none   # §Walk readiness — the dev env runs this build
<design.flag>: <the resolved ref and its set> | none   # prototype mode; key named by the config
auto: on YYYY-MM-DD | off
blocked: none | "<why> — next: <step>"                # parked by an unattended run — §How a park reads; resume runs nothing while it is set
agent-walk: on YYYY-MM-DD | off                        # --agent-walk, recorded so a cold session keeps it
```

**Write moments** — the manifest commits at step transitions and stops, never per phase: spec
written · aligned · audited · planned · built · signed off · verified · shipped, plus **any
mid-build stop** and **the contract freeze** (the phase close that verifies the producer).
Per-phase state is a ledger line plus `git log`.

**`apps:` and `contract:` are the multi-app lines.** `apps:` is the plus-joined in-scope list, so the
picker shows blast radius without opening the spec. `contract:` is the freeze — §The contract freeze.
A single-app repo writes `contract: none` and the freeze machinery stays quiet.

**`blocked:` is not `hold:`.** `hold:` is a human parking a finished PR on purpose; `blocked:` is an
unattended run that could not go on without a human — a scope question, a manual-commit app, a
migration the config says a human applies, five failed agent walk rounds. While it is set,
`/builder:resume` prints it and runs nothing. The human resolves what it names and deletes the line —
or names the feature to `/builder:agent` or `/builder:fleet`, which **always unparks it**: the fleet
sets the line to `none` in a commit (`chore(<feature>): unparked for a fleet retry — was: <the old
line>`) and tells the first run what the park said, whatever parked it and whichever builder version
wrote it. Builder, the code or the spec may have changed since; the run looks again, and parks again
only if the cause still stands.

**Program variant:** replace `size:` with `tier: program`, drop `state:` (a program has no state of
its own — its children carry theirs), and add one `child: <name> — <state>` line per child.

### How a park reads

One line, `"<why> — next: <step>"`, written for someone who has not opened the spec — it is all
`/builder:status`, the fleet table and `/builder:agent` show:

- **why** — what is stuck, in plain words about the product's behaviour or the decision that is
  missing: "the component pane still opens on a struck preview when that preview is named `default`",
  not "D6 pane default on C-027". A decision, finding or row number goes in brackets *after* the
  words, never in place of them. No commit shas and no round-by-round history — those are in
  `git log` and the evidence folder, and a park that retells them hides the one thing that matters.
- **next** — the ONE step you recommend, as a command to paste or a concrete action:
  `answer D4 in SPEC §Decisions, then /builder:agent` · `a human walk, then /builder:signoff --path
  <folder>` · `/builder:agent — a retry, now that <what changed>`. Never "unpark", never
  "clears when …", never a list of alternatives.
- Under 250 characters. A park that needs more has not found its cause yet — the rest goes in the
  park record.

### The park record

The line is the headline; **`<folder>/PARKED.md` is the investigation**, committed beside the
manifest in the same commit as the line, so it travels with the branch to the human, to every later
`/builder:resume` and `/builder:agent` run, and to a fresh session that knows nothing. Written for a
reader who must pick up the dig cold:

```markdown
# <feature> — parked
parked: YYYY-MM-DD <sha> · by <the step: agent-walk round 5 | build phase 3 | resume | the fleet>
kind: stuck | decision | human-step
blocked: "<the manifest line, verbatim>"

## What is stuck
<the behaviour or the missing decision in plain words — what should happen, what happens instead, and
since when; a decision code only in brackets after the words>

## What was tried
- <attempt> — <what happened> (<commit sha | agent walk round n>)

## Evidence
- <path> — <what it shows>, with the lines that matter QUOTED here: the evidence under `.builder/` is
  git-ignored and does not travel with the branch

## Where to dig
- <file:line | SPEC row, its text quoted | test> — <why it is suspect>
- Not yet ruled out: <hypotheses nobody has tested>

## Recommended next step
<the line's next step, and why it beats the alternatives: <the others, one line each>>

## History
- YYYY-MM-DD parked — <why> · YYYY-MM-DD unparked by <who> · …
```

- **`kind:`** — `stuck`: work that didn't converge (a walk that keeps failing, a gate, an env);
  `decision`: the spec leaves a product decision open; `human-step`: the config reserves the step to
  a person (a `commit: manual` app, `apply_mode: human`, your uncommitted changes in the way of a
  merge). The fleet retries `stuck` and `decision` parks on its own (`agent_walk.auto_unpark`); a
  `human-step` park waits for the person.
- **A park that happens again rewrites the sections** with what the new attempt learned, and keeps
  `## History` growing — never a copy of the last record.
- **Unparking** appends a History line and leaves the rest: the next run starts from *Where to dig*,
  looks for the root cause before trying the same fix again
  ([`systematic-debugging`](../systematic-debugging/SKILL.md)), and adds what it tries under
  *What was tried*.
- **Condense removes it** — `git rm <folder>/PARKED.md` at sign-off (§Condense): the feature got past
  it, and `git log -- <folder>/PARKED.md` keeps every version.

## SPEC.md

Sections in this order; md writes only the ones its work touches (**§Idea, §Apps and §Contract are never skipped**), lg writes them all. In a multi-app repo §Apps and
§Contract are what make a cross-app change safe.

```markdown
# <feature> — spec
> size · ticket · (header line written at sign-off: ✅ SIGNED OFF … / ✅ SHIPPED …)

## Idea                 prose, never a table — written from brainstorm.md by /builder:spec:
                       **Why.** the outcome and who it's for · **What success looks like.** how a person
                       will know it works · **In your words.** "<the owner's key rules, verbatim>" → D3, D7
                       (each quote linked to its ruling) · **The concept.** how it works (mermaid when
                       several parts move) · **How it fits today.** prose, file:line only as footnotes ·
                       **Approaches considered.** chosen and why · rejected and why
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

Target ≤ 350 lines; `list-features.mjs --check` warns at 500 — a longer SPEC is usually two features.
A SPEC written before 4.0.0 opens with `## Overview` instead of `## Idea`; it stays valid as it is.

`check-obligations.mjs` reads §Apps, §Contract, §Schema & API changes, §Findings and §Replaced
surfaces, and is what turns each into an enforced obligation rather than a habit.

**The §Decisions comment block, copied into every SPEC verbatim:**

```markdown
<!-- The one place rulings live. Record the DECISION — and, in one line, why, and why the rejected option lost. A stated preference
     is the INPUT to a row, not the row. Write each Ruling as something later code can be checked
     against without re-interpretation:
       · positive and specific — "store the full number, mask at render", not "don't truncate"
       · scope named — which apps, screens or endpoints it binds
       · "etc." / "and so on" expanded into the list, or the test for membership stated
       · the rejected alternative named, with the reason it lost (check-obligations warns on a bare one)
       · the enforcement hook, where one exists (lint rule, script, test)
     🔴 NEVER quote the user's prompt as the ruling. Operationalize it: a closed list, a measured
     value, an enumerated set of deviations. A ruling a stranger could implement two ways is not
     written yet.
     Who/date carries the provenance, so the Ruling itself needs no quote marks.
     The owner's own words go in §Idea "In your words", linked to this row — never in the Ruling.
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

*Depends on* is read by the scripts (`scripts/program.mjs`): `#` row numbers or child folder names,
comma- or space-separated; `—` or empty for none. A dependency is met when its `child:` line reads
`— shipped` or its own folder shows it shipped; a token naming no child is unmet. Until every entry
is met, `/builder:status` shows `⏳ waits on …`, and the fleet holds the child back: it waits for a
dependency in the same run to merge, then branches from that code; a dependency outside the run
refuses it.

## Prototype mode

Entered through `/builder:intake --<design.flag> <ref>`, which runs steps 1–4 below; `/builder:spec` runs step 5. **The design is the requirements** — a finished, specced design
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
   asked in `/builder:intake`'s rounds, recommendation first, the three options below — a "fix it in the design" disposition ends the round, and the contract is re-read before the next.
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

The **fast set** is the config's per-app block, run **at every phase close by the controller**. A
phase touches ONE app, so its gates are one block, never all of them.

The **deep set** is the config's deep block — **what the fast sets do not cover**, an e2e suite, a
whole-repo check — and its verdict is written ONCE, in `/builder:verify`, beside every in-scope
app's fast set and consumer parity against the frozen §Contract. Under the fleet, the build lane
runs the deep block when the last phase closes (in parallel with other builds, off the one-at-a-time
walk lane) and verify quotes that run when nothing has changed the tree since.

🔴 **Every gate block is run through `scripts/gate.mjs`, never by pasting the config's commands.**
The runner does what a controller used to do by hand at every close, in opus turns over 100-line
tails: it runs the block, re-runs a failure the config's `flaky:` list matches (once, the narrow
`rerun:` when given), compares an `@delta` count against the baseline measured on the target branch,
reports an `@known-red` gate without counting it, and prints one line per command and one per set.

**The memo, and what "fresh" means.** The runner records each GREEN set against a content hash of
its inputs — the app's path, every tracked path no other app owns (shared packages, the lockfile,
root config), the registry excluded, and the gate commands themselves. When a later call finds the
tree clean and the hash unchanged, it **quotes** the recorded run, naming the sha and time, and exits
green. That is fresh evidence in [`verification-before-completion`](../verification-before-completion/SKILL.md)'s
sense: the claim rests on a run the runner can prove is against this exact input, not on a model
remembering. A red result is never quoted — red always runs again. Measured before the memo: the same
server suite ran about fourteen times per feature and test execution was 60% of a fleet's wall-clock;
most of those runs re-proved a tree nothing had touched.

**The deep set runs what the branch can reach, not everything.** A deep line marked
`@scoped <glob>` runs only the tests in that glob the branch reaches (`scripts/impact.mjs`): what it
changed; the code reading a schema field it **removed, renamed or retyped** under any spelling
(`issueDate` / `issue_date`), so another feature built on that column is tested with this one — an
added field has no readers yet; everything importing either, seen through barrel re-exports to the
module that provides each name (type-only imports excluded — the typecheck owns types); files that
load one by name (a harness page's `<script src>`, a spec's `goto('/harness.html')`); and tests an
earlier feature changed in the same commit as a file in the impact, which is how a UI spec is tied to
the screen it covers. A change the graph can't see past — a file beside the tests nothing loads, a
runner config, a lockfile — runs the whole suite, and `gate.mjs --whole` forces it. A scoped `@delta`
line with failures in its subset is judged on the whole suite, so a known-red test can't hide a new
one. The selection, with why for each test, is written to `.builder/gates/impact.md`: verify's
evidence. Measured before it: the deep set ran the whole UI suite and every phase gate — eleven
minutes — at every build end and again at every verify after a walk fix.

**Implementers do not run the suite.** Their prompt limits them to the tests of the code they change
plus the type-check; the phase close runs the block once, on the committed tree.

**Baseline drift.** A gate written as a count (`… | grep -c "error TS"   # @delta`) is judged against
the count on the target branch, measured by `gate.mjs --baseline` — the fleet runs it at start in the
main checkout, and a worktree reads it from there. No hard-coded number goes stale in the config.

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

## Walk readiness

🔴 **Green gates are not a walkable app.** Tests run against their own database and their own
process; the human walks the *dev* environment. A migration applied to the test database but not the
dev one, a server still running the old code, a client missing a regenerated type — every gate
passes and the app the human opens is broken. **Nobody is asked to walk, or to sign off, a build
the local environment isn't running.**

Run it at the end of the build (before the walk script is printed), after `## Fixes` work that a
re-walk follows, and at the end of an xs/sm change the human will look at. The commands come from the
config's **§Walk readiness**; a config without that section → infer them from the repo exactly as
`/builder:init` would, say that you did, and suggest `/builder:init --update` to record them.

**Under `--agent-walk`, when the config's `agent_walk.start` is set**, the fleet has already started
an isolated dev env for this worktree, with the config's `agent_walk.env` in the environment, before
this step ever runs — and, first, merged the fleet's target branch into the worktree, so the env runs
the code every other finished feature has landed on. Readiness there:

- still applies migrations and regenerates — steps 1–2 below — but against **that** environment's
  database;
- runs `agent_walk.smoke` in step 3, in place of §Walk readiness's own **smoke**;
- 🔴 **never runs §Walk readiness's `start`, and never restarts anything** — the fleet owns that
  process for the whole walk, and restarting it out from under a running poll is the race this split
  exists to avoid.

A restart-class change — the kind step 2 would otherwise restart for — writes
`blocked: "walk env needs a restart — <what changed>"`, commits and ends the run. That exact prefix is
the fleet's to clear, not the human's: it sets the line back to `none`, restarts the env and runs
readiness again (twice at most). The
walker's URLs, wherever step 3 loads a page or hits an endpoint, come from `agent_walk.driver` and
`agent_walk.env`, never from §Walk readiness's own start/smoke commands.

1. **Migrations.** List the migrations this branch adds
   (`git diff --name-only --diff-filter=A <base_branch>...HEAD -- <the config's migrations path>`),
   then run the config's **status** command against the **dev** database.
   - None pending → say so, with the status output's one line.
   - Pending → 🔴 **ask, don't assume and don't skip.** One AskUserQuestion naming each pending
     migration and the database it would hit: **Apply them now** (recommended) · **I'll apply them
     myself** · **Stop here**. The config's `apply_mode:` decides whether the first option exists:
     `ask` (the default) offers it; `human` drops it — print the exact command instead; `agent`
     applies without asking and says so. A config line reserving the dev database to the human
     (*"applying it to the dev DB is the human's step"*) means `ask`: asking IS handing them the step.
   - Applied → run **status** again and quote it. Still pending, or the apply failed → that is a
     build failure: a fix dispatch against the migration's task, not a walk.
   - **I'll apply them myself** → print the command and stop at `ready: pending "<n> migrations"`.
2. **Regenerate and restart.** Anything the config's §Walk readiness or §Environment landmines says
   goes stale on this kind of change — a generated client, a server without hot reload, a dev
   process that caches a glob — is regenerated or restarted the same way: `ask` by default, never
   silently. A process the human owns (their long-running dev server) is theirs to restart: say which
   one and why, and wait.
3. **Smoke the running app.** With the dev environment up — started by the config's **start**
   command when the agent may start it, otherwise by asking the human to — run the config's
   **smoke** commands, then exercise what this feature touched: hit each changed endpoint or route,
   load each changed page (with a browser tool when one is available, reading its console), and read
   the server's log for errors raised while you did. 🔴 **An error, a failed request or a console
   error on a changed surface is a defect, not a walk item**: it becomes a fix dispatch against the
   task that caused it, then this step runs again. A pre-existing error on an untouched surface is
   named in the hand-off, not fixed.
4. **Record it** in the manifest: `ready: yes <YYYY-MM-DD> <sha>` when all three passed, or
   `ready: pending "<what is left, in a few words>"` — commit it with the step that ran it.
   `ready: pending` means **the walk is not offered**: the hand-off names what is left and the one
   command that finishes it, and `/builder:signoff` refuses a PASS.

A step that genuinely cannot run here — no dev database on this machine, a device-only app — is not
a pass: say which, put it at the **top** of the walk script as the human's first step, and write
`ready: pending "<the step>"` so the sign-off asks them to confirm it.

## Condense

Two moments, and the SPEC is the record — no README is written. A PROBLEMS or PARTIAL sign-off does
not condense: the §Plan index and `PLAN.md` may both still be needed for the fix tasks.

| Moment | What happens |
|---|---|
| **sign-off** (PASS, written by `/builder:signoff`) | strip the §Plan index from `SPEC.md` **and** `git rm <folder>/PLAN.md` (and `PARKED.md` when there is one); write under the title `> ✅ SIGNED OFF <date> — <sha> · by <name>: "<words>"`; commit |
| **agent sign-off** (AGENT-PASS in agent mode, written by `/builder:agent-walk`) | the same condense; the line is `> 🤖 AGENT SIGNED OFF <date> — <sha> · agent walk round <n> · not human-tested · evidence: …` |
| **ship** (verify READY, the PR open — written ON the PR so the merge carries it) | flip that line to `> ✅ SHIPPED <date> — PR #N · <ticket> · signed off by <name>: "<words>"`; `git rm MANIFEST.md`; remove the workspace; `git mv` the folder into `<registry>/_archive/`; commit on the PR branch |

**State detection, binding on every skill in the family:**

| Signal | State | The family does |
|---|---|---|
| manifest `state:` spec · aligned · audited · planned · building · built | in flight | route on the manifest's `next:` line |
| SPEC header carries `SHIPPED` | **DONE** | run no step; print the header; offer a new feature folder |
| header carries `SIGNED OFF`, manifest `verify: none` | signed off | verify next |
| manifest `verify: READY`, `hold: none` | ready to ship | open the PR, then `/builder:ship` on it — in agent mode, ship and merge into the target branch |
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
