# `/builder:*` — the family's shared reference

Every `builder:*` step reads this file for the shapes it writes and the rules it enforces. Load it
before writing anything into a feature folder; steps cite sections by name (`REFERENCE §Sizes`).

**Contents:** §The first principle · §The scripts · §Sizes · §The classifier · §Flags · §Continuing on "go" · §The two-way footer · §Before a picker · §The review — what an approval shows · §Branch and ticket · §Where things live · §MANIFEST.md · §SPEC.md · §PLAN.md · §PROGRAM.md · §Prototype mode · §The craft skills · §The project's own rules · §Quality gates — the mechanism · §Walk readiness · §Condense · §Agent model tiering

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
headless run waits on a gate suite without backgrounding anything (resume's AGENT-MODE.md).

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
| `gate.mjs <app>… \| --deep [<app>…] \| --all` | 🔴 **the only way a gate block is run** (§Quality gates — the mechanism): runs the config's fast set per app and/or its deep set, applies `flaky:`, `@delta` and `@known-red`, and quotes a set whose inputs are byte-identical to its last green run, naming the sha. Exit 0 green, 1 red. `--force` runs regardless; `--baseline` records the `@delta` counts (the fleet does this at start); `<app>… --typecheck` runs only the lines marked `@typecheck` — the type-check floor every test plan keeps |
| `workspace <feature>` | prints and ensures the git-ignored workspace for one feature. `--remove <feature>` deletes it — the ship step's call, because `rm -rf "$(…)"` is refused by the harness |
| `task-brief PLAN N OUT` | extracts one task's text for its implementer |
| `review-package BASE HEAD OUT` | the commit list, stat summary and diff a reviewer reads in one call |
| `docs.mjs <step>` | every doc section one step reads — the REFERENCE sections it names, its own companion files, the config — printed whole in one call (`--list` shows the map; `--prompts` adds build's four prompt templates). Read-only |
| `advance.mjs <folder> --set k=v… [--head] [--ledger "<line>"] [--add <path>] --commit <subject\|preset>` | ONE state change: manifest keys in §MANIFEST.md's order, `head:`/`branch:`, a ledger line, and a commit of only the manifest plus the `--add` paths. Presets: `audited` · `aligned` · `plan` · `built` · `walk-lane` · `verify-ready` · `verify-incomplete` |
| `condense.mjs <folder> --signoff agent\|human … \| --ship (--pr N \| --into <branch>)` | the SPEC surgery of §Condense — header line, §Plan cut, `git rm` PLAN.md, the archive move at ship — plus its manifest write and commit |
| `plan-slices.mjs <folder> --index --write` | SPEC §Plan's index from PLAN.md's headings, put into SPEC.md |
| `plan-slices.mjs <folder> --brief` · `--scan` | the build orchestrator's view of the plan — the header and each task's head, never its code — and the pre-flight conflict scan's mechanical rows (build EXECUTION.md §Setup 5–6) |
| `dispatch.mjs <kind> <folder> …` | a subagent's whole prompt — implementer, task-review, re-review, final-review, agent-walk — rendered from `skills/build/prompts/` into the workspace; the Agent call is "Read <file> and do what it says" |
| `walk-script.mjs <folder>` | `<WS>/walk.md` from SPEC §Testing, per app, `[risk]`-tagged, with the cross-app E steps under `--agent-walk`; the orchestrator fills only its marked blocks |
| `handoff.mjs write\|read <folder>` | the build lane's end state for the walk lane (`<WS>/handoff.md`); `read` exits 3 with `stale:` when the manifest or the code moved since |

🔴 **Every one of these is idempotent — after a crash, a `/clear` or a session that died, re-run the
same command.** Each looks before it writes: a ledger line already there is skipped, an unchanged
manifest is not rewritten, a commit already made prints `already applied`, a condense already done
prints `already condensed` / `already shipped`. Never hand-edit what one of them half-wrote; run it
again. Unattended runs (`--agent-walk`, the fleet) rely on exactly this.

**Separate outputs with `echo ---`**, never a row of `=` signs: under zsh a word starting with `=` is a
filename expansion, the command fails, and its output is cut off.

Every one of them reads `.claude/builder.md` and fails with the one line that fixes it when it
cannot.

## Sizes

| Size | Looks like | Typical files | Design artifact | Audit | Plan | Execution | Human gates |
|---|---|---|---|---|---|---|---|
| **xs** | a copy change, a colour, a prop default, a one-line guard | 1–2 | one sentence in chat | — | — | main context | approve the sentence |
| **sm** | move a button, rework a form's layout, upgrade a component's props, restyle a view, add a command or an endpoint only its own app uses | 2–10 | short design in chat, once the concept is confirmed in the conversation | — | — | main context | approve the design · a look at the running app before the PR |
| **md** | add an endpoint + its screen, add a capability to an existing feature, port one screen to a new pattern | 10–40 | `SPEC.md`, short: idea · apps · decisions · contract · testing; per-app sections only where touched (~120 lines) | 1 pass, single agent | `PLAN.md`, 2–4 phases | the task loop | decisions · go-ahead · the walk |
| **lg** | a new feature: a model + endpoints + screens in each consumer | 40–150 | full `SPEC.md` | 1 pass, parallel agents | `PLAN.md`, 4–7 phases | the task loop | the same three |
| **xl** | a new area across several subsystems | 150+ | `PROGRAM.md`: the children, their order, the decisions they share; each child runs as its own md/lg | per child | per child | per child | one program go-ahead, then per child |

## The classifier

Run on the confirmed concept, from recon and the settled tree; the size is announced with its
evidence.

1. Does the flow being changed already exist to read? **No → at least md.**
2. A new model, schema change, permission or contract change? **Any → at least md.** A new
   endpoint counts here when another app or a released artifact (`released_artifact: true`) will call
   it.
3. A new screen or shared component? **Any → at least md.**

   🔴 **A new command, endpoint or route that only its own app uses is not md on its own.** One app,
   on data that app already stores, no new screen, nothing outside the app calling it — `notes edit`,
   a `GET /export` the app's own UI links to — is sm: it is code inside existing contracts. It becomes
   md the moment another app or a released artifact depends on it, or it needs a model, a schema row,
   a permission or a screen.
4. **Apps touched (from the config's `apps:`)? Two+ → lg.** Three+ with independently shippable
   slices → xl. 🔴 **A slice is shippable only when it gives the user something they can use on its
   own** — say, in one sentence, what they can do once it alone lands. A layer is not a slice: a
   shell with nothing behind it, a data model no screen uses, a UI whose action does nothing yet.
   Fewer than two such slices → **lg, one spec**, however many apps and files it touches.
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
row, a permission, a screen, or an endpoint or route another app depends on, it earns a spec.

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
| `--batch <folder>…` | `/builder:agent-walk` only, run by the fleet in its walk worktree: several features walked together — one env, one walker by screen (agent-walk §Batched walks) |
| `--agent-walk` | **unattended mode**, what `/builder:fleet` runs: implies `--auto`, and **never asks** — every pause takes its recommendation; it parks only on a product decision the spec leaves open, or a step the config reserves to the human (resume's AGENT-MODE.md). Resume passes `--auto` along with it to every step it runs, so a step that only knows `--auto` still settles its own pauses. The walk and sign-off are `/builder:agent-walk`'s; the feature is shipped and merged into the fleet's target branch, locally (resume's AGENT-MODE.md §Ship in agent mode). Needs the config's `agent_walk:` block. Recorded on the manifest as `agent-walk: on` |
| `--into <branch>` | agent mode's target: the `merge_into` branch (default `base_branch`; `current` = the branch checked out when the fleet launched; `--into` for one run), which every finished feature is merged into. The fleet passes it; resume's AGENT-MODE.md §Ship in agent mode needs it |
| `--here` | **build it here, without the ceremony** — the human's choice on a handoff footer (**In this session**, §The two-way footer). Resume records `build: here` on the manifest and routes as usual: align, audit, the decisions gate and the plan still run in full; the go-ahead shows the slice table and proceeds; `/builder:build` then works `PLAN.md` in this session (build §Build here) and stops at `state: built`. No fleet, no worktree, no reviewer agents, no walk-readiness lock, no sign-off or verify. Ignored under `--agent-walk` |
| `--walk-lane` | the fleet's walk lane when it owns the walk env: walk readiness and the agent walk only — end the run at `signed-off`, or once the walk writes `## Fixes`; verify, fixes and ship belong to the parallel lanes. Never run a gate suite or a build here (AGENT-MODE.md) |
| `--no-dev-env` | never start, migrate or touch the dev environment. Where a step needs it, write `ready: pending "dev env (fleet walk lane)"`, commit, and end the run. The fleet's build lane passes it, so parallel worktrees never share a dev env |
| `--help` | print the help: on `/builder:brainstorm`, `/builder:intake`, `/builder:spec` or `/builder:resume` the `builder:help` card; on any other family skill its own Invocation line and the flags it reads. Then STOP — no recon, no file touched. Overrides every other flag |
| *free text after the flags* | the work itself: `/builder:brainstorm move the save button into the header` |

**Parsing convention:** flags first, each as `--key value` (bare for a boolean), free text after them
is the work. A skill **ignores any flag it does not use and never errors on one**, so a family flag
survives a chained command — `--help` is the one flag every skill honours, first. Resolving a design
ref is [`SCOPE-SELECTION.md`](SCOPE-SELECTION.md).

## Continuing on "go"

Every handoff ends in a 📍 footer naming the one next command (on a numbered footer, each option
stands for one). **The human does not have to paste it.** When their next message is a **bare affirmative** — "go", "yes", "proceed", "continue",
"approve", "ok", "next", "do it", "keep going" and the like — and **your previous message** ended in
a 📍 footer naming one complete command, run that command yourself through the Skill tool, in that
turn, with the footer's `--path` and the flags the run already carries (`--ticket`, `--auto`). Don't
re-print it and ask them to type it.

**On a numbered footer** (§The two-way footer) a bare affirmative picks **option 1**. Where the
footer offers **Agent**, that is Agent: "go" hands the feature to the agents —
`/builder:agent --path <folder>`, whose own questions and one confirmation still ask. Where it does
not, option 1 is **Step by step**, the command the single-line footer would have named, and
everything below applies to it.

**Nothing is skipped.** The command runs exactly as if typed — its own Step 1, the manifest as the
state, every gate and stop intact. An affirmative continues **to the next step**; it never answers a
gate that step will raise (the decisions gate, the go-ahead, a manual-commit app, applying a
migration). Those still ask, as they would have.

**An affirmative does not continue** — answer in one line with what the human does instead:

| The footer names | Why | Answer with |
|---|---|---|
| `/builder:signoff`, or 🔒 your walk (Step by step on the walk, when it is option 1 or picked by name) | a sign-off an agent starts is void, and "approve" is not "I walked it" | the exact command to type, with their verdict in their words after it |
| a human's step (`<the human's step>`, apply a migration, restart a service) | only they can do it | the step, then "say go once it's done" |
| a placeholder only the human can fill (`<what you want built>`, `<the change>`) | there is nothing to run yet | ask for the missing text |
| `🛑 held` | the pipeline is parked on their call | the hold's words, and that lifting it is theirs |
| `⛔ parked` (`blocked:` set) | an unattended run stopped on a decision the spec leaves open, or a step the config reserves to the human | the reason, and "delete the `blocked:` line once it's settled, then say go" |
| more than one candidate (`/builder:status`, the picker) | "go" doesn't say which | one AskUserQuestion over the candidates; a feature name or row picks directly |

**Opening the PR** — the one outward-facing step an affirmative can reach, through resume's §Ship —
is still asked once, through AskUserQuestion (**Open the PR** / **Not yet**), before `gh pr create`
runs — except under `--agent-walk`, where no PR opens at all: resume's AGENT-MODE.md §Ship in agent mode merges into
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

## The two-way footer

**Wherever another way through the next step exists, the footer offers it.** A footer about one
feature whose `state` is one of `spec aligned audited planned building built signed-off verified`
and that would end in ` · or say go` (or names the walk) is printed as a numbered choice. It is there
to help the human decide how the feature gets built — less is more: each option says in plain words
what picking it does, and **no option line carries a `/builder:*` command**. Its options, in this
order, are those that apply, numbered from 1 with no gaps when one is absent:

- **Agent** — only when the config has an `agent_walk:` block. Runs `/builder:agent --path <folder>`.
- **Step by step** — always. Runs the command the single-line footer would have named (for the
  walk, the human's walk and then `/builder:signoff --path <folder>`).
- **In this session** — only before the build starts (`state` is `spec`, `aligned`, `audited` or
  `planned`). Runs `/builder:resume --path <folder> --here` — the audit and the plan still run, only
  the ones still to come; then this session builds it without the ceremony (REFERENCE §Flags
  `--here`).

```
Full spec: <registry>/<feature>/SPEC.md
Pick up where you left off any time: /builder:resume --path <registry>/<feature>
  (if this session ends, or to spec several features before building any of them)

📍 <feature>: <what just happened> — how do you want it built?
   1. Agent — <it is sent to agents who carry it to merged on their own — the steps that remain, in plain words — and you get the review of what landed>
   2. Step by step — <carry on here one step at a time (next: <the next step in plain words>), pausing for you at each decision and for your walk>
   3. In this session — <audit and plan it (only the steps still to come), then build it right here in this session, without the agents or the extra review rounds>
   Reply 1, 2 or 3 — "go" is 1.
```

- **`Full spec:`** — the feature's `SPEC.md` (`PROGRAM.md` for a program). Where the step's own
  output already ends with that line — spec's design review — it is not printed twice.
- **`Pick up where you left off any time:`** — the one command the footer shows, always
  `/builder:resume --path <folder>`, with its reason on the line under it.
- **The question** — `— how do you want it built?` before the build is done; from the walk on
  (`built`, `signed-off`, `verified`, fixes owed) it reads `— what next?`.
- **The reply line** — `Reply 1, 2 or 3 — "go" is 1.`, or `Reply 1 or 2 — "go" is 1.` with two
  options. With only one option left (no `agent_walk:` block, after the build), the single-line
  footer is printed instead.

**Each explanation is one or two plain lines, written for the state** — the steps that remain, never
the ones done:

| State | 1. Agent — | 2. Step by step — | 3. In this session — |
|---|---|---|---|
| `spec` (designed), `aligned` | sent to agents who check it against the code, plan, build, walk, sign off and verify it, and merge it on their own; you get the review of what landed | carry on here one step at a time (next: checking the spec against the code), pausing for you at each decision and for your walk | audit and plan it, then build it right here in this session, without the agents or the extra review rounds |
| `audited` | sent to agents who plan, build, walk, sign off and verify it, and merge it on their own; you get the review of what landed | carry on here one step at a time (next: the plan and your go-ahead to build), pausing for you at each decision and for your walk | plan it, then build it right here in this session, without the agents or the extra review rounds |
| `planned` | sent to agents who build, walk, sign off and verify it, and merge it on their own; you get the review of what landed | carry on here one step at a time (next: the build, after your go-ahead if it isn't given yet), pausing for you at each decision and for your walk | build it right here in this session, without the agents or the extra review rounds |
| `building` (stopped) | sent to agents who finish the build, walk, sign off and verify it, and merge it on their own; you get the review of what landed | carry on with the build here (next: phase N/M), pausing for you at each decision and for your walk | — |
| `built` (the walk) | sent to agents who walk it in the running app, sign it off as the agent (not human-tested), verify it and merge it; you get the review of what landed | you walk it yourself in the running app, then sign it off here | — |
| fixes owed (signoff PROBLEMS / PARTIAL, verify INCOMPLETE) | sent to agents who fix what was found, re-check it and merge it on their own; you get the review of what landed | fix them here one at a time, then re-walk or re-verify what they touched | — |
| `signed-off` | sent to agents who verify it and merge it on their own; you get the review of what landed | carry on here (next: verify — every app's gates fresh, then the PR), pausing for you before the PR opens | — |
| `verified` (READY) | sent to agents who merge it on their own, without a PR; you get the review of what landed | carry on here (next: open the PR — asked once before it opens) | — |
| `verified`, PR open | sent to agents who finish it and merge it on their own; you get the review of what landed | carry on here (next: condense it to its shipped spec once the PR merges) | — |

**Replies.** `go`, `yes` or any bare affirmative is **option 1**, by §Continuing on "go" — **so where
Agent is offered, "go" hands the feature to the agents**; where it is not, "go" is Step by step. A
reply may also name the option:

- **Agent** — its number or `agent` → run `/builder:agent --path <folder>` through the Skill tool in
  that turn; its own questions and its one confirmation still ask.
- **Step by step** — its number, `step by step` or `resume` → the command the single-line footer
  would have named, exactly as §Continuing on "go" runs it — so on the walk it answers with the
  signoff command to type, after the human has walked it.
- **In this session** — its number, `in this session` or `here` → run
  `/builder:resume --path <folder> --here` through the Skill tool in that turn.

**Not numbered:** a footer under `--agent-walk` (no human reads it); one in the does-not-continue table
other than the walk — 🛑 held, a human's step, a placeholder, more than one candidate; a footer before
a spec exists (brainstorm, intake) or after the feature merged; and plan's go-ahead footer, which
launches the agents itself, builds here, or, without the block, names `/builder:init --update`.

## Before a picker

🔴 **When a choice is offered in a picker (AskUserQuestion), the text above it explains the choice —
it is never a second menu.** The user selects with the arrow keys; what they need on screen first is
what each option means and why the recommended one is first:

- **What is being decided**, in one plain sentence, and why it matters.
- **Your options** — one line per picker option, its label in bold exactly as the picker shows it,
  in the picker's order: what picking it does, what it is good at, what it costs or closes off.
- **Why the recommended one** — the evidence behind it and what you give up by picking it.

Never letters, numbers or a "Reply A, B or C" line above a picker, and never an option for "answer
the question below" — answering is what the picker is for. A lettered list belongs only where the
reply is typed in chat (CONVERSATION §Ways on). A picker whose options are self-evident (Run it /
Not now, Open the PR / Not yet) needs only the sentence saying what happens on each.

brainstorm and intake rounds (CONVERSATION §Rounds), spec's product choices, the splitting question,
approaches, the decisions gate, the go-ahead's test-plan questions, the test plan picked ahead
(agent, fleet), and every other AskUserQuestion in the family follow this.

## The review — what an approval shows

🔴 **No approval asks anyone to read a file.** Every point where the human approves shows, in the
chat, what they are approving — in plain words, with the product's own names (screens, commands,
fields, buttons), never spec shorthand (`D3`, `§Contract`, `T#`, `SC#`). A file path is a
**reference line** under the review (`Full spec: <registry>/<feature>/SPEC.md`), never the thing
approved. 🔴 **A bare approval request — "Spec written, approve?" — with nothing summarized is not an
approval**, and no step may ask one.

This is not the section-by-section approval 4.10.1 removed ("§Apps: right?" — a format nobody can
judge). The review is about **impact**, which a person can judge.

### The sections

Each is present only when it has content, in this order:

| # | Section | What it says |
|---|---|---|
| 1 | **What changes for users** | before → after, from the user's side; who is affected and who sees nothing new |
| 2 | **What they'll see** | the UI/UX change per screen or command; an ASCII sketch when a layout changes |
| 3 | **Added · Changed · Removed** | three short lists — screens, endpoints, commands, behaviours. `Removed: nothing` is said, never left out: a removal is what users miss |
| 4 | **Data** | every schema change in plain words: what is stored, what happens to existing data, whether a migration runs and whether it can be undone |
| 5 | **Apps** | what changes in each app; for a `released_artifact` app, what its users see before they update |
| 6 | **Decisions** | each choice settled, one line, with what lost; one assumed rather than asked ends `(assumed)`, one taken under `--auto` ends `(auto)` — so a wrong one stands out |
| 7 | **Risks and open questions** | what could go wrong, what is still open, each with the recommendation |
| 8 | **Not included** | what is out of scope, so nobody assumes it is coming |
| 9 | **How it gets built and tested** | the go-ahead only: the slices and the test plan (plan §The go-ahead) |

### Screen-sized parts

A review that fits in **~40 lines** is shown whole. Longer → **parts**, one per turn, by default:
*Part 1 of 3 — What users get* (1–3) · *Part 2 of 3 — Data and apps* (4–5) · *Part 3 of 3 —
Decisions and risks* (6–8). A part with nothing in it is dropped and the rest renumbered. Every part
but the last ends in the lettered ways on (CONVERSATION §Ways on — plain chat, never AskUserQuestion):

```
A. Looks right — next part
B. Change something — say what
Reply A or B — "go" is A.
```

🔴 **The last part ends with the step's own ways on** — its footer, its A/B/C — and the reference
line just above them. A change at any part is applied (the record, the SPEC, the plan — whatever
holds it) and **that part re-shown**, with the same two ways on; the review goes on from there. A
reply in the user's own words is a change, never an A.

A filled example — the design approval at the end of `/builder:spec`, three parts, three turns:

```
Here's what cert-tags will do — 3 parts, one at a time.

Part 1 of 3 — What users get

What changes for users
  Before: an owner finds "everything for the site B audit" by scrolling the certificate list.
  After:  an owner tags certificates with their own labels ("audit 2026", "site B") and filters
          the list by one or more tags — on the web and in the mobile app.
  Who:    certificate owners. Other viewers see nothing new — tags are private to the owner.

What they'll see
  Certificate list (web, mobile) — chips under each name, a Tags filter beside Status:
    ┌ Certificates ─────────────────── [Status ▾] [Tags ▾] ┐
    │ Boiler 3 — gas safety                  due 12 Nov    │
    │   (audit 2026) (site B)                              │
    └──────────────────────────────────────────────────────┘
  Owner view — a Tags row with "+ Add tag"; typing offers the tags you already have.
  Settings → Tags — rename, recolour, delete. Delete asks first:
    "Remove 'site B' from 14 certificates?"

Added · Changed · Removed
  Added:   tags on certificates · the Tags filter · Settings → Tags · tag endpoints in api
  Changed: the certificate list takes an optional tag filter
  Removed: nothing

A. Looks right — next part
B. Change something — say what
Reply A or B — "go" is A.

> a

Part 2 of 3 — Data and apps

Data
  New:       a tag (name, colour, owner) and a link between tags and certificates.
  Existing:  certificates are untouched — every one starts with no tags.
  Migration: one, additive — two new tables, nothing altered; undone by dropping them.
  Deleting a tag deletes its links only; the certificates are never touched.

Apps
  api    — stores tags, returns them to the owner only, filters the list. Built first.
  web    — the chips, the filter, the owner-view editor, Settings → Tags.
  mobile — the same chips, filter and editor. Released app: people on today's version see
           no change and nothing breaks — every field it reads stays as it is.

A. Looks right — next part
B. Change something — say what
Reply A or B — "go" is A.

> a

Part 3 of 3 — Decisions and risks

Decisions
  · Deleting a tag takes it off every certificate, after a confirm naming the count
    — not blocking the delete while in use (owners stuck untagging one by one).
  · Only the certificate's owner sees its tags — not every viewer (private notes made public).
  · A tag name is 1–32 characters, unique per owner ignoring case (assumed)
  · Up to 200 tags per owner, 20 per certificate (assumed)
  · Adding a tag name you already have reuses that tag (assumed)
  · Colours come from the 8 chip colours already in use — no free colour picker (assumed)

Risks and open questions
  · Filtering a long list by several tags could be slow — an index on the link is planned;
    the audit checks the query.
  · Nothing open.

Not included
  · Tags shared between owners or across a team.
  · Tagging many certificates at once.
  · Tags in exports and reports.

Full spec: docs/features/cert-tags/SPEC.md
Pick up where you left off any time: /builder:resume --path docs/features/cert-tags
  (if this session ends, or to spec several features before building any of them)

📍 cert-tags: designed (lg, api+web+mobile) — how do you want it built?
   1. Agent — …
```

### Where it is shown, and how much

| Step | The review shown |
|---|---|
| brainstorm / intake — CONVERSATION §Confirm | 1, 2, 3, 6, 7, 8 from the record — the shared understanding |
| the small path and the quick path (xs · sm) | 1–3, and 4 when anything stored changes — compact, one part |
| **spec, end — the design approval** (spec §3) | **the full review, 1–8, in parts** |
| **spec at xl — the one program go-ahead** (spec §2) | the full review, 1–8, for the **whole program**, in parts, plus **the children** in plain words: each child's name, what users can do once *it alone* ships, its apps, and what it waits on — in build order, with why that order (the contract) |
| audit, end | the review delta (below) — what the audit changed in the design |
| plan, the go-ahead (plan §The go-ahead) | a one-part recap (1, 3, 4) + anything the audit changed since the design was approved, above section 9 — the slices and the test plan |
| revise | the change as a review delta |
| ship — opening the PR (resume §Ship) | the PR body, printed in full before the question |
| agent / fleet — the one confirmation | per feature, one line of 1 and its test plan |
| the 🔒 walk hand-off, after an `--auto` run (resume §🔒 The walk) · the fleet's report (fleet §5) | the full review of **what was built**, from `SPEC.md`, in parts |

### The delta form

Audit and revise change a design the human already approved, so they show **only what moved**: each
section that changed, by name, as before → after, in the same plain words.

```
What the audit changed in the design
  Data      before: tags are deleted with their owner's account
            after:  an owner's tags are deleted with the account and their links with them —
                    the audit found accounts are soft-deleted, so links would have dangled
  Not included  + Tag filter in the mobile offline cache — the cache has no filter support
```

Nothing changed → one line: `The audit changed nothing in the design you approved.`

### Under `--auto` and `--agent-walk`

🔴 **No approval is asked, so no review is printed** — not at §Confirm, the small path, spec, audit,
the go-ahead or revise. In an unattended run writing it costs minutes of output and nobody reads it.
Each of those steps says in one line what it did and how many rulings it took as `auto
(recommended)`.

The review is shown **where the human next looks**, so nothing lands unseen: the 🔒 walk hand-off of
an `--auto` run (resume §🔒 The walk) and the fleet's report (fleet §5) open with the full review of
what was built, written from `SPEC.md` — sections 1–8, in parts, every `(auto)` ruling marked.

**Closing reports under `--agent-walk` are short.** Nobody reads a headless run's prose; the fleet
reads the manifest, the ledger and the walk report, and its park diagnosis reads the log's last 25
lines. So every step ends with **at most six lines, then its footer**: the state it reached, each
ruling it took in one line (`ruled: <decision> → <choice>`), and one `worth checking:` line when
there is something a human should look at. Never restate what the feature does or what it touches.

**Decision rows under `--auto` are one line each.** §Decisions gets one table row per ruling —
`| D<n> | <decision> | <choice> — <why, in one clause>; not <the alternative> | auto (recommended)
YYYY-MM-DD |`. The reason is never dropped, only kept to one clause; a ruling a human questions later
goes through `/builder:revise`.

**Adjacent steps run as one under `--agent-walk`.** Audit continues straight into `/builder:plan`
when it leaves no OPEN §Decisions row and no `blocked:` row, and a verify READY continues straight
into resume's AGENT-MODE.md §Ship in agent mode — in the same turn, with no return to the route table (each step
still makes its own commit, so the history shows every step). Never across the go-ahead or the walk
in a human run.

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
tests: slice=<v> end=<v> review=<v> [models=… persist=… unruled=… walk=you]  # the test plan (plan §The go-ahead); an old profile: line without it is still read
walk: <name YYYY-MM-DD> | agent-pass YYYY-MM-DD <sha> | none   # agent-pass: the agent sign-off, written by /builder:agent-walk — never a human's
verify: READY YYYY-MM-DD | INCOMPLETE YYYY-MM-DD | none
ready: yes YYYY-MM-DD <sha> | pending "<what is left>" | none   # §Walk readiness — the dev env runs this build
<design.flag>: <the resolved ref and its set> | none   # prototype mode; key named by the config
auto: on YYYY-MM-DD | off
blocked: none | "<why> — next: <step>"                # parked by an unattended run — §How a park reads; resume runs nothing while it is set
agent-walk: on YYYY-MM-DD | off                        # --agent-walk, recorded so a cold session keeps it
build: here | none                                     # --here: built in the session without the ceremony (build §Build here); absent = none
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

🔴 **Children are cut by value, never by layer.** Each child's *One line* says what the user can do
once that child alone has shipped. A child that can't say it (a shell, a data model, a step whose
output nothing uses yet) folds into the child that makes it useful. Two value-sized children beat
five layered ones: every child costs an audit, a plan, a go-ahead, a walk and a landing, and children
that share contracts freeze them across specs.

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
A fast-set line marked `@typecheck` is the app's type-check: `gate.mjs <app>… --typecheck` runs only
those lines — the floor that holds under every test plan, `tests: end=none` included. An app with
none marked prints `no @typecheck line for <app>` and exits green; the implementer's per-task
type-check is then all there is, and verify says so.

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

**Gates and the walk env (`@walk`).** Under the fleet, the walk lane runs with the walk env up and
with `agent_walk.env` (its ports, its database) in the environment. With a walk env of the fleet's
own (`agent_walk.start`) the walk lane holds only readiness, the walk and the `@walk` lines — verify
and `## Fixes` rounds run in the parallel lanes, away from the folder the env serves from, one walk
at a time or batched; without `start`, verify and fixes stay in the walk lane. `gate.mjs` keeps the
two apart:

- **An untagged line runs with the test env** — `agent_walk.env`'s keys go back to their build-lane
  values (`worktree_env`, or unset) — so a unit or integration suite never runs against the walk
  env's database or URLs, in the walk lane exactly as in the build lane.
- **A line marked `@walk` needs the running walk env** — an e2e suite against the app. It gets
  `agent_walk.env`, runs in the walk lane (right after the sign-off, into `walk-gates.md`, when the
  fleet owns the env; else in verify), and the build lane skips it (`~ … @walk`). Outside the fleet
  the tag changes nothing: the line runs against whatever env is up, as before.
- **An e2e-looking line without `@walk`** (playwright, cypress, `e2e`…) is not run under the fleet —
  its URLs would fall back to the human's dev stack — and is printed `? … unverified`; `@local` marks
  one that starts its own stack. Outside the fleet nothing changes.
- **The fleet smokes the env after every walk run.** Red means the env died under the run: a verdict
  that run committed (doc-only) is dropped, the env restarts without a reset, and the walk runs
  again — once — instead of turning a dead env into `## Fixes`.
- **After each set in the walk lane, `gate.mjs` re-polls `agent_walk.smoke`.** When a gate broke the
  running env — a build rewriting the folder the dev server serves from (Next.js `.next`, Nuxt
  `.nuxt`, SvelteKit `.svelte-kit`) — it exits **3** and says so: write
  `blocked: "walk env needs a restart — <what broke it>"`, commit and end the run; the fleet restarts
  the env **without a reset**. The lasting fix is the walk env's own output folder, set through
  `agent_walk.env` (`/builder:init` offers it).
- **Under the fleet the gate lines come from the main checkout's config** — the one the fleet reads —
  never the branch's copy: a branch can't loosen its own gates, and `gate.mjs` warns when the two
  differ.

**Quoting a line.** A line that passed is remembered (`.builder/gates/lines.json`) with the commit it
passed at. A later run quotes it — `⏩ <cmd> — green at <sha>; changed since: … — none is this set's
input` (or `— none reaches <glob>` for a `@scoped` line, by the import graph from that commit) — and
the quote is evidence like a run. A `@delta`, `@known-red`, `@walk` or `<…>` line, a dirty tree,
`--force` and `--whole` never quote. **`@parallel`** lines start together across the run's sets.

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

🔴 **Under the fleet, the walk's migrations are applied to the walk env's database, not your dev DB.**
Your dev DB gets them when the feature lands: `scripts/fleet.mjs` runs `apply:` then `regenerate:` in
the checkout it merged into (apply_mode `agent`, additive migrations only) or notes the command.

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
