# Changelog

`version` in `.claude-plugin/plugin.json` is the release number. Cut a release with
`claude plugin tag --push`, which refuses to tag unless `plugin.json` and the marketplace entry
agree — see [RELEASING.md](RELEASING.md).

## 5.2.0

The walk env and the gates stop tripping over each other. From a fleet run on a Next.js + FastAPI
monorepo that parked twice and lost about an hour: a build gate run during the walk rewrote the
`.next` folder the walk env's `next dev` served from, verify's e2e suite ran against the wrong
environment, and an agent's config fix went into a copy the fleet never reads. **Nothing to change
in `.claude/builder.md`** — `@walk` is opt-in. Investigation: every code path, `file:line`, in this
release's commit history.

**Walks, much leaner** (`docs/specs/2026-10-26-lean-walks-design.md`). makeready's one-screen chart
feature was walked as 18 checks a round — its 9 items and the same script again as cross-app steps —
re-walked in full each round from a fresh launch per item, ~27 min a round. d2m's 20-feature fleet
spent 623 min in the one-at-a-time walk lane, 339 of them in verify.
- **One app in scope → the verification script is the walk.** No cross-app section repeating it;
  the per-app test items are the gates' to prove. A one-app feature's `end=risk` now walks its
  `[risk]` items only.
- **A re-walk covers only what the fix changed** — the items that didn't pass, plus a passed one the
  fix's diff touches; every other pass is carried with its evidence.
- **The walker walks by screen** — every item on a screen in one visit, one launch.
- **Batched walks** — with `agent_walk.start`, the walk lane takes every feature waiting (up to
  `agent_walk.batch`, default 8; 1 = one at a time) into one walk branch, brings the env up once,
  and runs one walker across all of them by screen; each verdict lands in its own feature.
- **Verify and a walk's fixes leave the walk lane** — they run in the parallel lanes with no env;
  `@walk` gates run once per batch against the batch's env, into each feature's `walk-gates.md`.

**Added:**
- **`agent_walk.batch`** — how many features one walk takes (default 8).
- **`@walk` on a gate line** — the line needs the running app (an e2e suite). Under the fleet it runs
  in verify against the walk env, with `agent_walk.env`; the build lane skips it. Outside the fleet
  it changes nothing.

**Changed:**
- **In the walk lane, every untagged gate runs with the test env.** Gates there used to inherit
  `agent_walk.env`, so a config that sets the same key in `worktree_env` and `env` (a test database
  and the walk database) ran verify's integration suites against the walk database. They now get
  the build lane's values back — exactly what the build lane already did.
- **The walker runs no gates.** It judges the running app; a build it ran took the walk env down.
- **A restart mid-walk skips `agent_walk.reset`.** The walk database keeps its migrations, and a
  reset that copies a dev database no longer runs on every restart.
- **Under the fleet, gate lines come from the main checkout's config** — the one the fleet reads —
  so a branch can't loosen its own gates; `gate.mjs` says when the branch's copy differs.
- **Agents never edit `.claude/builder.md`.** A fix that needs a config change parks as a human
  step with the exact diff (resume's AGENT-MODE.md), and the fleet parks any branch that changed the
  config before it merges, so a config change never lands unseen.
- **`/builder:init`** offers the walk env its own output folder when a Next.js, Nuxt, SvelteKit or
  Rails app would share one with its build, suggests a smoke that proves sign-in can work (a CORS
  preflight, not only `/health`), and tags e2e lines `@walk`.

**Fixed:**
- **A gate that breaks the walk env is caught at once.** In the walk lane `gate.mjs` re-polls
  `agent_walk.smoke` after each set and exits 3 with what to do — write the restart line — instead of
  every later check failing against a dead env and the feature parking.
- **`job.mjs` keeps quoting.** It joined a command's words with spaces and re-split them, so
  `-- pytest -k "a and b"` lost its filter. Several words are now shell-quoted; one is a shell
  command as written.

## 5.1.0

Agent work can land back on the feature branch you are on. **Nothing to change in
`.claude/builder.md`** — leaving `merge_into` out still means `base_branch`.

**Added:**
- **`merge_into: current`** — an opt-in config value: the target is the branch checked out in the
  main worktree when the fleet launches (a fleet worktree's own `builder/<feature>` branch is never
  it; a detached HEAD falls back to `base_branch`). For a feature-branch workflow, where a fleet that
  merges into `main` strands the work away from the branch it was specced on. The dry run says
  `merges into: <branch> (merge_into: current)`.

**Changed:**
- **Land on? recommends the branch you are on.** When the checked-out branch is not `base_branch`
  (and not a `builder/*` branch), it is the recommendation, ahead of `merge_into` — it is where the
  spec, and often the config, was committed. Plan's go-ahead A line names the same target.
- **The fleet refuses a target with no `agent_walk:` block before anything starts.** Each worktree
  is cut from the target, so its agents read the target's `.claude/builder.md`; a target that
  predates the agent config used to park every feature on its first run. The dry run now exits 2
  with the fix: commit the config to the target, or `--into <the branch you're on>`.

## 5.0.0

Easier to start, lighter on every session, faster in agent mode, and checked by what it does. Built
from a comparison against superpowers, Anthropic's official plugins, compound-engineering, Spec Kit,
Kiro, OpenSpec, BMAD, GSD, Taskmaster and Claude Code's own features
(`docs/research/2026-10-25-comparison.md`). **Nothing to change in `.claude/builder.md`** — every
config, manifest and feature folder from 4.x reads as before.

**Measured** (`bench/results/`, 2026-10-26, Opus 5.5, Claude Code 2.1.310, every run passing its
hidden acceptance tests):

| Feature | builder 5.0 | builder 4.14.8 (same day) | superpowers 7.0.0 | no plugin | GSD |
|---|---|---|---|---|---|
| `tags` (md, 3 reps) | 11m · 76 turns · $4.57 | 11m · 70 turns · $4.58 | 9m · $2.66 | 1m · $0.30 | 1h20m · $32.36 (1 rep) |
| `edit` (xs, 3 reps) | 58s · $0.52 (was 6m · $3.41 before the sizing fix) | — | 4m · $1.21 | 28s · $0.23 | — |

On `tags` 5.0 matches 4.14.8; the 8m of 2026-10-24 is not reached by either today, so that drift is
not this release's. The turn budgets (`bench/budgets.json`) still flag most steps as over.

**Changed:**
- **Builder costs every session a third of what it did.** Its skill descriptions sat in every
  session's context — about 6,700 tokens, against superpowers' ~840 — and three were over
  Anthropic's 1,024-character limit, so Claude Code was dropping seven of them (including `help`)
  from its skill list. Each is now one plain "what it does, when to use it" sentence: about 2,200
  tokens in all, held there by a test. The maintainer-only benchmark no longer loads at all.
- **A README and help card a new user can read.** The README is now install, three commands, what
  happens to a request, seven words you'll see, and every command in one table; the detail moved to
  `docs/guide.md`. The help card is rewritten in plain words, and a specific question
  ("how do I pick up yesterday's work?") gets a few-line answer instead of the whole card.
- **The docs say what "go" does.** With agent mode — every install since 4.14.8 — "go" hands a
  build to agents, who merge it on your machine marked *not human-tested*. The README, help,
  plugin description and `/builder:init` now say so plainly, and how to test it yourself instead.
- **Agent runs are leaner** (Part 2 of the lean orchestrator, about −50 s on the benchmark's small
  feature by the overhead model): every step ends in at most six lines; an `--auto` ruling is one
  table row with its reason in one clause; audit runs straight into plan and a READY verify straight
  into ship, each still committing its own step.
- **A new command or endpoint only its own app uses stays small.** The sizing rules made any new
  endpoint or route md, and the benchmark's xs task — adding `notes edit` — went through the full
  pipeline (spec, audit, plan, agents, walk, verify) in all three reps: 6 minutes and $3.41 where
  plain Claude Code took 28 seconds. Now one app, on data it already stores, with no new screen and
  nothing outside the app calling it, is sm — built in the chat. It is md once another app or a
  released artifact depends on it, or it needs a model, a schema row, a permission or a screen.
- **`resume` is under 500 lines** — its agent-mode sections moved to `resume/AGENT-MODE.md`, which
  agent runs read in the same one call they already made. Long reference files open with a
  contents line.

**Added:**
- **A lesson for next time.** Every step reads the config's §Standing traps; nothing wrote it. At
  ship, a cost this feature paid — a fix round, a red gate, a failed walk — that the next feature
  would pay too becomes one proposed line: a human ship asks once, an agent ship leaves it in the
  SPEC and the fleet's report offers it.
- **Behaviour evals** (`evals/`, run with `claude plugin eval`): a plain request reaches brainstorm,
  a small change gets the quick path, a bigger one is grounded in the code first, help answers in a
  line, status says when nothing is in flight — each against a no-plugin baseline.
- **CI** runs the unit tests, the workspace self-test and the preview check on every push and PR.
- **Benchmark:** a no-plugin `baseline` config, an xs feature (`edit`), and turn budgets per step
  (`bench/budgets.json`) the report marks a step against.
- **`/compare`** (this repo only, never shipped) re-runs the competitor comparison.

**Fixed:**
- **The fleet's progress bar covers the whole run.** It was the mean of the rows still in flight, so
  a feature that merged left the total — five features with one merged read as the other four's
  average, not 20% higher. Now every feature the run holds counts once and each one it merged counts
  at 100%: five with one merged and four not started reads 20%, the heading says `1 merged this
  run`, and a spec added while the fleet runs grows the total. The status line's `⚙ fleet n/total`
  and its bar count the same way. A new fleet run starts its count fresh.
- **A fleet run that starts without builder loaded is stopped.** Claude Code says `--bare` will
  become the default for `-p`, and bare mode skips plugin hooks — the PR lock — and OAuth sign-in.
  The fleet now checks each run's start and stops one that has no builder, saying why. Why the fleet
  stays on `claude -p` rather than background sessions: `docs/specs/2026-10-26-native-background-sessions-design.md`.
- **Stale docs:** the README's skill counts, a second contradictory way to vendor, and the
  template's old profile wording. A test now checks the README names every skill and no doc names a
  command that doesn't exist.

## 4.14.8

**Changed:**
- **Every install gets agent mode.** `/builder:init` treated the `agent_walk:` block as opt-in and
  recommended *not yet*, so a repo could be set up with builder and still have no agent mode — no
  *Agent* option on the build footers, `/builder:agent` and `/builder:fleet` refusing. Now init always
  writes the block (asking only how agents drive the app and how the walk environment starts), and
  `--update` treats a missing block as the biggest gap and adds it. A repo goes without agent mode
  only when you say you don't want agent runs there.

## 4.14.7

**Fixed:**
- **A fleet run killed by a timeout says so in its log.** A run stopped by the idle timeout (no
  output for 30 min) or the run timeout (6 h) left an empty log, which read like a lost one. Its log
  now ends `[fleet] killed: no output for 30 min (the idle timeout)` — or the run-timeout line.
- **The test suite is green, reliably.** The fleet's timeout tests used a 400 ms window shorter than
  the stub `claude` takes to start on a busy machine, so a run was killed before it began — one test
  failed every time and two passed without testing what they claimed. They now use a window wide
  enough to start in, prove each run really reached its step, and check log contents, not just that
  the file exists. Two job tests gave a 2 s job too little margin under load. No user was affected:
  real runs use a 30-minute idle timeout.

## 4.14.6

**Changed:**
- **The build options read as a decision, not a list of commands.** The numbered handoff footer now
  offers, in this order, **1. Agent** (it is sent to agents who carry it to merged on their own, and
  you get the review of what landed), **2. Step by step** (was `resume`: carry on here one step at a
  time, pausing for you at each decision and for your walk) and **3. In this session** (was `here`:
  audit and plan what is still to come, then build it right here without the agents or the extra
  review rounds) — each present only where it applies and explained in plain words for the state
  (REFERENCE §The two-way footer has the per-state wording). No option carries a `/builder:*`
  command any more; above them sit `Full spec:` and the one command to keep, `Pick up where you left
  off any time: /builder:resume --path <folder>`, for when the session ends or you want to spec
  several features before building any. **"go" is still option 1 — so where Agent is offered, "go"
  now hands the feature to the agents**; a reply can also name the option (`agent`, `step by step` /
  `resume`, `in this session` / `here`).
  Signoff's PASS hand-off now offers the same choice (verify and merge by agents, or step by step).

## 4.14.5

**Fixed:**
- **A vendored copy carries the hooks.** `/builder:vendor` copied `skills/` and `scripts/` but not
  `hooks/`, so a repo running its own copy got neither the session brief nor the PR lock. It now
  copies `hooks/` too, with the entry scripts still executable; the host's marketplace loads the copy
  as a plugin, so Claude Code runs its hooks exactly as from an install. The vendor step already turns
  the user-scope builder off in that repo, so its hooks never run twice.

## 4.14.4

**Added:**
- **A session brief and the PR lock — builder's first hooks.** In a repo with `.claude/builder.md`,
  every session (startup, `/clear`, compaction) now opens with a short brief: start new work with
  `/builder:brainstorm`, `/builder:status` and `/builder:resume` for work in flight, the features in
  flight (up to five) with their next step, and builder's skills taking precedence over their
  superpowers twins in this repo — so builder's brainstorm, plan, build, TDD, debugging,
  verification and review are the ones Claude reaches for. And `gh pr create` on a builder
  feature's branch is now **denied** until the feature has been walked and signed off (an agent's
  sign-off passes only in agent mode), with the next step in the reason. Both are silent in every
  other repo, never touch a PR on a branch no builder feature owns, and let everything through on
  any error. README §Hooks says how to turn them off.

## 4.14.3

**Fixed:**
- **A program's go-ahead is its review, not a file and a Yes / No.** At xl, spec showed `PROGRAM.md`
  raw and asked "Approve the program?" before any explanation. Now the one program go-ahead is the
  whole program's review in parts — what customers get, what they'll see, added · changed · removed,
  **the children in plain words** (what users can do once each ships, its apps, what it waits on, in
  build order and why), data, apps, the shared decisions, risks, what's not included — ending in
  `A. Approve the program` · `B. Change something` · `C. One spec instead`. Resume's child picker is
  briefed first (each child and why the recommended one is next), and a program's footer is one line.

## 4.14.2

**Changed:**
- **Before a picker, the options are explained — never a second menu.** When a choice is offered
  in a picker you select with the arrow keys, the text above it now explains each option (its label
  in bold, as the picker shows it: what it does, what it's good at, what it costs) and why the
  recommended one is first — instead of a one-line recommendation. No letters, no "Reply …" line,
  and never an option for "answer the question below" above a picker. One rule, REFERENCE §Before a
  picker, for every picker: brainstorm and intake rounds, spec's product choices, the splitting
  question, approaches, the decisions gate, the go-ahead's test-plan questions, agent and fleet picks.

## 4.14.1

**Fixed:**
- **A question round shows one menu, not two.** Each round printed a lettered `A. Answer below ·
  B. Build it now · C. That's enough` list and then opened the picker — which takes the input, so
  the letters were a menu nobody could answer. Now a lettered list appears only where you type the
  reply in chat (the quick path, confirm, the research offer, concepts, hand-offs — unchanged); a
  round's choices all live in its picker. Every third round, while two or more questions are open,
  the picker carries a second tab, **Keep going?** — Keep answering · Build it now · That's enough.
  "just build it" and "that's enough" still work typed in any round.

## 4.14.0

**Faster:**
- **The orchestrator stops typing what a script can write** — internal; nothing you see changes
  (the measured number comes with the release). Every subagent prompt (implementer, task review,
  re-review, final review and its fix wave, agent walk) is rendered by `scripts/dispatch.mjs` and
  the Agent call becomes "Read <file> and do what it says"; reviewers write their findings to a
  workspace file the fix round passes on instead of pasting. Every manifest / ledger / commit change
  is one `scripts/advance.mjs` call, the sign-off and ship condense is `scripts/condense.mjs`, and
  SPEC §Plan is `plan-slices.mjs --index --write`. Each step reads its docs in one
  `scripts/docs.mjs <step>` call. The build writes `walk.md` with `scripts/walk-script.mjs` and ends
  with a `scripts/handoff.mjs` note the fleet's walk lane reads instead of re-deriving the state
  (falling back to the old way when it is stale). Under `--auto`, brainstorm writes the SPEC itself
  and keeps only a stub record. Every script is idempotent — after a crash, the skills re-run the
  same command — so unattended runs still finish with no human. Separators are `echo ---`, never
  a row of `=` (zsh). Design: `docs/specs/2026-10-23-lean-orchestrator-design.md`.
- **Measured** against the 4.12.1 baseline: **tags 13m → 8m** (3 reps; 12–14 → 7–9, no overlap),
  orchestrator 8.6 → 5.4 min, tokens −37%, cost $4.92 → $3.91, 7/7 accept every rep. **share 24m →
  24m** (2 reps; 21–27 → 22–25): the orchestrator fell 14.5 → 12.6 min and tokens −19%, but the
  big feature's time is now mostly its agents and slow test suites (9.3 min), which this release
  doesn't touch (`bench/results/2026-10-24-1901-tags`, `…-1927-share`).

## 4.13.0

**Changed:**
- **Every approval shows what you are approving — in the chat, never a file to open.** A new shared
  format, REFERENCE §The review, sets what an approval shows, in plain words with the product's own
  names: what changes for users (before → after, who), what they'll see (an ASCII sketch when a
  layout changes), added · changed · removed, data and migrations (can it be undone?), each app (and
  what a released app's users see before they update), the decisions with what lost and the assumed
  ones marked `(assumed)`, risks and open questions, and what is not included. A file path is only a
  reference line under it.
- **Long reviews come in screen-sized parts.** Over ~40 lines, a review is split — *Part 1 of 3 —
  What users get* · *Part 2 — Data and apps* · *Part 3 — Decisions and risks* — each ending
  `A. Looks right — next part` · `B. Change something — say what`. A change is applied and that part
  shown again; the last part ends with the step's usual footer.
- **Where you see it:**
  - **`/builder:spec`** — the full review, in parts, *is* the design approval. It replaces the
    two-to-four-sentence summary; the product questions before writing are unchanged.
  - **Brainstorm and intake confirm** — the shared understanding as a review; the **small path** and
    the **quick path** show a compact one (what changes, what you'll see, added/changed/removed, data).
  - **`/builder:audit`** and **`/builder:revise`** — what they changed in the design you approved,
    section by section, before → after ("The audit changed nothing…" when nothing moved).
  - **The plan go-ahead** — a one-part recap of what is being built and what the audit and the
    decisions gate changed since you approved the design, above the slices and the test plan.
  - **Opening the PR** — the PR body is printed in full before you're asked.
  - **`/builder:agent` / `/builder:fleet`** — one line per feature above the confirmation: what it
    changes for users, and its test plan.
- **Under `--auto` and agent mode no review is printed where nothing is asked** — writing one costs
  minutes of output that nobody reads. Instead you see the full review of **what was built** where
  you next look: the walk hand-off after an `--auto` run, and the fleet's report for every merged
  feature, autopilot rulings marked `(auto)`. Design: `docs/specs/2026-10-23-cli-review-design.md`.

## 4.12.2

**Fixed:**
- **Only a breaking schema change raises the end recommendation.** An ADD-only §Schema row is new
  surface nothing relies on yet, so it no longer recommends an agent walk; EDIT, RENAME and REMOVE
  still do, as do migrations, a released consumer, auth or delete, and 3+ apps. On the benchmark a
  CLI field addition was getting a full walk it didn't need.
- **The fleet waits out a Claude Code update.** An auto-update swaps the `claude` binary out for a
  few seconds; an unattended run started in that window ended `spawn claude ENOENT` and failed its
  feature. The fleet now waits up to 3 minutes for `claude` to be back before starting a run.

## 4.12.1

**Changed:**
- **The benchmark can be trusted.** With `--repeat N` every figure reads `median (min–max)`, so a
  one-minute effect is no longer lost in one rep's noise. A new column splits each run's time into
  **orchestrator** (the controlling session thinking, reading and writing its records), **agents**
  (subagents doing the work) and **tools** — rebuilt into old reports from their raw streams. It
  shows where builder's time actually goes: on the tags run, 73% orchestrator, 24% agents, 3% tools.
- **A bigger benchmark feature, `share`**, on a new two-app fixture, `notes-hub` (a notes CLI and a
  `node:http` server, test suites slow on purpose at ~35 s): ~10–12 slices across both apps, with 9
  hidden acceptance tests. Features now name their fixture (`features/<f>/feature.json`); `tags`
  keeps the original, moved to `bench/fixtures/notes/`. Design:
  `docs/specs/2026-10-23-benchmark-trust-design.md`.

## 4.12.0

**New:**
- **The test plan replaces Rush / Standard / Thorough.** The profiles barely differed where the time
  goes (13 / 15 / 14 min on the benchmark), and nobody could see what they cost. The go-ahead now
  shows the plan as **slices** — each task numbered, grouped by app, with the tests it adds — and
  what the recommended test plan costs, in runs and, once the gates have run, minutes. Then
  `A. Build it with this plan` (go) · `B. Change the test plan` · `C. Keep planning`. B asks three
  questions, each option saying what it costs for this plan:
  - **Testing per slice** — its own tests (recommended) · plus the app's suite when the app's slices
    are done (the old behaviour) · the app's suite after every slice · none while building.
  - **Testing at the end** — the touched apps' suites once (recommended) · plus an agent tries the
    risky parts · everything (deep suites, cross-app E2E, full walk) · nothing, you'll test it.
  - **Review** — once at the end (recommended) · once per app · after every slice.

  The recommended plan is the fast one; a schema change, migration, released consumer, auth/delete
  or 3+ apps raises only the *end* recommendation, and says why. Two floors hold under every plan:
  a type-check of every touched app (gate lines marked `@typecheck`, run by `gate.mjs --typecheck`)
  and the final whole-branch review. The plan is written to the manifest as `tests:` and governs
  in-chat builds as well as agent builds. `/builder:agent` and `/builder:fleet` ask it ahead.
  An old `profile:` line, and `build_profile_default`, are still read — mapped to the plan they
  meant. `gate.mjs` now records each app's fast-set duration for the estimates. Design:
  `docs/specs/2026-10-23-test-plan-design.md`.
  Measured on the benchmark (`bench/results/2026-10-23-1336-tags`, a 3-slice, one-app feature):
  the recommended plan and `everything` both took 14 min ($5.24 / $5.34), all acceptance tests
  passing. The recommended build ran no task reviewers (5 min vs 6) and its final review caught
  what they would have. On a feature this small the fixed steps — brainstorm, spec, audit, plan,
  the walk lane, verify, ship, about 8 min — dominate; the levers pay off with many slices and slow
  suites, which the go-ahead's cost line now shows before you choose.

## 4.11.3

**Changed:**
- **Brainstorm's research starts from what the project already has, and names no product.** Discovery
  no longer looks for one particular screen library. For anything with a UI it first states the
  project's own design system — what it offers for the idea and how it should be used here — before
  anything else is offered. Then it reads what the session actually has installed (any plugin, MCP
  server or skill that could help) and offers, as a lettered list: *Stay with what we have* · *Look
  at <installed tool>* · *Search the web* · *Suggest a plugin* (only when nothing installed covers
  a reference that would help — installing it is yours). Patterns found outside are described in
  the design system's terms. A UI change's design and *How it works today* name the design-system
  components to use, and the record gains a *Design system* line. Design:
  `docs/specs/2026-10-23-brainstorm-design-system-first-design.md`.

## 4.11.2

**Changed:**
- **`/builder:brainstorm` has a quick path for small changes.** A directed request or brief that the
  first-turn grounding shows is a small change in existing code — one app, the flow already there,
  no new model, endpoint, permission, contract, route, screen or shared component, at most one open
  product choice — no longer starts the full conversation. The first turn proposes the change (xs: a
  sentence; sm: app, approach, files, tests, what you'll see) and asks once: **Build it** or
  **Brainstorm it first**. Build it is the small path's approval, so the change is built, gated and
  handed back with no rounds, no confirm and no sizing turn. Any doubt and the conversation runs as
  before. **"just build it"** now leaves the conversation from anywhere, not only discovery: open
  questions take their recommendations and it sizes straight away — xs/sm build in that turn, md and
  up say so and offer the spec or building in chat anyway.
- **Every brainstorm pause ends in a lettered list of ways on** — `A. … (recommended)`, `B. …`,
  `C. …`, and "go" is A — so continuing is one letter, never a phrase to remember. The quick path,
  the intent playback, the concepts, every round (*A. Answer below* · *B. Build it now* · *C.
  That's enough*), the confirm (*Build it* · *Park it* · *Stop here*), the small path's approval and
  the md+ hand-off (*Write the spec* · *Build it in chat anyway* · *Park it*) all use it. Letters,
  not numbers, so a way on never collides with the question picker's numbered answers. Typed
  phrases such as "just build it" still work. `--auto` never takes the quick path, so
  `/builder:agent`, the fleet and the benchmark are unchanged. Design:
  `docs/specs/2026-10-23-brainstorm-quick-path-design.md`.

## 4.11.1

**Changed:**
- **`/builder:brainstorm` explores before it decides.** A vague idea now enters a discovery phase in
  front of the decision tree: the problem is framed in open questions (who, pain or outcome, how it
  is handled today, what better looks like — one per turn, no option lists), recon finds the design
  system, UX patterns and prior art the product already has, the agent weighs whether outside
  research would help and offers it — a community resource such as Mobbin when the session has one,
  otherwise online research — running it only on your yes, and two to four concepts built from
  those patterns are proposed and explored in plain conversation until the user names one. The
  concept then seeds the rounds, which run as before. A directed request or brief is unaffected;
  "let's explore" opens discovery for any input, "skip discovery" leaves it. `--auto` takes the
  recommended concept with no extra turn, so `/builder:agent`, the fleet and the benchmark are
  unchanged. Measured on the benchmark (`bench/results/2026-10-21-1625-tags`): the tags request is a
  brief, so discovery is not entered and the brainstorm step costs what it did before — 54 s
  before, 54 s after. Design: `docs/specs/2026-10-21-brainstorm-discovery-design.md`.

## 4.11.0

**New:**
- **`/builder:benchmark`** — runs one small feature through builder at rush, standard and thorough and
  through superpowers and GSD, unattended, and reports time per step, what happened in each step,
  turns, tokens, cost, and whether the feature works (acceptance tests the agent never sees). Steps
  come from each session's `stream-json` — the Skill calls that open them, with subagent work inside
  them. Results land in `bench/results/<run>/` (`REPORT.md` + `runs.json` committed, raw streams
  not). `--status` while it runs; `--report <run-id>` rebuilds one. Design:
  `docs/specs/2026-10-13-benchmark-design.md`.

## 4.10.2

**Fixed:**
- **`/builder:agent` no longer offers a feature a session is building.** A feature that is planned
  with a go-ahead, or building, and whose workspace was written in the last 30 minutes is being built
  in a session, so agents taking it too would mean two builders on one feature. It isn't offered,
  `--path` refuses it, and the fleet's pre-flight refuses it however it's named. A feature you only
  just specced in a session is still offered.
- **Work on a branch several features share isn't handed to agents.** Agents would treat that branch
  as one feature's branch (d2m's `feat/design-versions` carried two). The feature says which others
  share the branch: merge it into the target first, or finish them in a session.
- **The picker says what agents would actually do.** For example, "built in a session, not tested
  yet · agents only walk it, verify and merge it". Features not built yet are listed first.

## 4.10.1

**Changed:**
- **`/builder:spec` no longer asks you to approve it section by section.** Your "yes" at the end of
  the brainstorm is the approval. Section approvals ("Right / Change something") asked you to judge
  summaries you couldn't evaluate, and they buried the real decisions. Now:
  - Before writing, the spec lists every choice it makes that the conversation never settled.
  - A **product choice** (what you see or can do, what data is kept or lost, what an AI may read or
    change) is asked as a real decision: why it matters, what it affects, a recommendation, and the
    alternatives as options.
  - An **implementation detail** is recorded in §Decisions as "assumed at spec" without asking.
  - The step ends with one plain summary (what it does, what it touches, what was settled and what
    was assumed) and no question. Say what's wrong, and it's revised.

## 4.10.0

**New:**
- **Build it here, without the ceremony.** Every handoff before the build now offers a third way
  through: `3. here` (or `2.` without `agent_walk`), or `/builder:resume --path <folder> --here`.
  - **Still runs:** the audit, the decisions gate and the plan, in full.
  - **Then:** the plan's go-ahead shows the phase table and goes straight on. This session works
    `PLAN.md` task by task: test first, one commit per task the house way (`commit: manual` apps are
    staged for you), and each app's fast gates at its phase close.
  - **Skipped:** the fleet, the worktree, the reviewer agents, the final review, the deep set, walk
    readiness, sign-off and verify.
  - **At the end:** it stops at `state: built` (`build: here` on the manifest, `here` in
    `/builder:status`). `/builder:resume` can still walk, verify and ship it when you want the full
    finish.

## 4.9.3

**Fixed:**
- **`/builder:spec`'s section approval only approves.** Approving a section (§Idea, §Contract, …)
  could show alternative designs as answer options, with the explanation cut off above the question
  box. You were asked to approve "the three checks" without seeing them. Now:
  - The approval's options are only **Right** and **Change something**.
  - The question names every check in its own text.
  - A "check" that is really an unsettled choice goes back into the brainstorm's tree. It is asked as
    its own question first, with why it matters, what it affects, a recommendation, and options that
    say what each one does.

## 4.9.2

**Fixed:**
- **Migrations a feature brings reach your dev DB when it lands.** Under the fleet, the walk applied
  a feature's migrations to its throwaway walk DB. The merge then put the code on your branch, but
  nothing ran in your checkout, so a hot-reloading dev server hit a schema it didn't have. That
  happened in d2m on 2026-09-27 and again now. After merging into the branch checked out in this
  folder, the fleet now looks for new files under §Walk readiness `migrations:`:
  - `apply_mode: agent` and additive migrations: it runs `apply:` and then `regenerate:` there.
  - `ask`, `human`, or a migration that drops or rewrites data: it leaves a note naming the exact
    command.
  - A merge written onto a branch checked out nowhere: it notes the migrations for when you switch
    to that branch.

## 4.9.1

**Fixed:**
- **Handing features to agents asks for the build profile first.** `/builder:agent` and
  `/builder:fleet` took features before they were planned, so the go-ahead ran headless and chose
  the profile and landing branch without asking. That undid the point of the levers. Now each pick
  without a `profile:` gets the profile question (Rush / Standard / Thorough, the Thorough follow-up,
  Customize) and **Land on?** before the one confirmation. A headless go-ahead keeps what you chose.
  A feature with no plan yet shows the ladder words, never "0 min".
- **Splits are cut by value, not by layer, and "one spec" is always offered.** A slice now counts
  toward a split only when it gives you something you can use once it alone ships. A shell, a data
  model or a button that does nothing yet is not a slice. The split question always offers **One
  spec** next to value-sized specs, and recommends the fewest. (A d2m design had become five layered
  children where one or two specs fit.)
- **`/builder:tidy` keeps a worktree parked for your walk.** It used to put it in the safe batch
  to remove.
- **`/builder:resume` writes to the fleet's copy.** When it routes on a feature's worktree, an
  unpark and every other edit go to that worktree, never to your checkout's stale manifest.

## 4.9.0

**Agents build every feature, and you pick how hard they try:**

- **The go-ahead asks how to build, and where to land.** One prompt, two questions. The profile is
  Rush, Standard or Thorough, with the recommended one first; Customize is under Other. "Land on?"
  recommends `merge_into`. Picking Thorough asks once more whether you walk the feature yourself
  before it lands. Rush and Standard trade review and verify depth for speed; **Thorough and
  Thorough + you are today's pipeline** (default models, every task reviewed, full agent walk, deep
  verify). Stronger models and a second reviewer on contract and schema tasks are Customize-only.
- **Agents build every feature in a project with `agent_walk` set.** The go-ahead launches the
  fleet, so nothing is built by hand there. The fleet never pushes; PR and CI landing is not part
  of this release.
- **New optional `build_profile_default` in `.claude/builder.md`** sets the profile the go-ahead
  recommends. An invalid value is ignored, and named by `/builder:init` and the go-ahead's
  recommendation (no longer on every status line render).
- **Estimates come from your own history.** The archive now records plan size, profile, tokens and
  cost for every landing. Estimates are drawn from it, and show numbers only after three comparable
  landings. `/builder:status` and the fleet table show each feature's profile.
- **`/builder:revise` on a feature agents are building pauses it.** It runs `fleet.mjs --pause`,
  applies the change in the feature's worktree and re-queues it, so a revision no longer races the
  agents.

**Changed:**
- **A spec or plan committed on a branch other than the target reaches the feature's worktree.**
  It is brought in before the build; when the copies differ, HEAD's copy wins. A failed bring-in
  heals on the next run.
- **Features approved before 4.9 have no `profile:` and run as Thorough**, which is today's
  pipeline, so nothing about them changes.
- **Projects without `agent_walk` build by hand exactly as before.**
- **Thorough + you is a human step in the fleet.** Your walk waits for you instead of stalling the
  other features, and each feature keeps its own state. The fleet keeps that feature's worktree,
  `/builder:resume` reads the fleet's copy there, starts its walk env and gives you the exact
  `/builder:signoff --path` into it; the sign-off is recorded there and hands the feature back.
  `/builder:agent` never unparks it.
- **A feature the fleet already landed can't be launched again from a branch that still holds the
  live copy.** The fleet refuses it and says to merge the target into your branch, and
  `/builder:status` shows `Landed on <target> — merge <target> into this branch` instead of its old
  step. A go-ahead whose `target:` differs from the run's `--into` is refused too, naming the
  `--into` that runs it.
- **A revision asked for while a feature waits to merge parks it instead of landing it**, and the
  pause check finds the request from inside a fleet worktree (`BUILDER_FLEET_DIR`).
- **Go-aheads from before 4.9 in an `agent_walk` project keep building by hand.** Only a manifest
  carrying `profile:` or `target:` is routed to the agents.
- **An ordinary signed-in endpoint no longer makes the recommendation Thorough.** A §Contract row
  counts only when its Auth cell names a role, permission, owner or scope, or the row deletes
  something.

## 4.8.1

**Changed:**
- **`/builder:spec` shows each section in plain words, not as the file holds it.** It used to paste
  the raw section and ask whether it was right; the §Contract table in particular gave you nothing to
  decide. Now each section is a short plain summary, then **What to check**: only the items that
  change the product or are expensive to undo, such as an agent acting without you, data being
  overwritten, or a shape a released consumer depends on. If nothing needs your judgement it says so.
  The full section text is shown only when you ask for it.

## 4.8.0

**Nothing left behind:**

- **Work lands where you say, not where you happen to be.** New optional `merge_into:` in
  `.claude/builder.md` (default `base_branch`). Fleets — `/builder:fleet`, `/builder:agent` — merge
  there whatever is checked out, even from a detached HEAD; `--into <branch>` picks another for one
  run. (Before, features landed on the branch checked out at launch, which is how d2m's work ended up
  on a feature branch needing a second merge.)
- **A fleet cleans up after itself.** A merged feature's worktree and branch are removed — whatever
  the branch is called — even when a test run rewrote a tracked file in it (`test-results/` and the
  like are restored); real uncommitted changes are stashed as `builder: <feature> leftovers <date>`,
  never lost. A parked or failed feature keeps only its branch; its worktree is recreated when it's
  picked again.
- **One picture of the repo.** `/builder:status` and every fleet report end with a `repo:` line —
  `repo: clean`, or `2 merged branches to delete · 1 dead worktree · 1 ready to merge → /builder:tidy`.
- **New `/builder:tidy`.** Every local branch and worktree against `merge_into`: merged, ready,
  running, parked (why · next), in progress, unknown, dead. One confirmation deletes what's merged,
  removes dead worktrees and stopped features' worktrees, and merges what's verified (a branch behind
  the target goes to the fleet to be brought up to date); every unknown or unfinished branch gets its
  own question — finish with agents, merge as is, keep, or delete. Never pushes; never drops a stash.

**Changed:** a fleet with unfinished work refuses a different target, naming the `--into` that
continues it. A feature whose own branch is checked out in your main folder is refused at launch
(switch away first) rather than given a fresh `builder/` branch.

## 4.7.0

**New:**
- **Fleets outlive the session that launched them.** `fleet.mjs --detach` starts the fleet in its own
  session (output in `.builder/fleet/fleet.out`) and returns at once; `/builder:fleet` and
  `/builder:agent` now always launch that way. A fleet started as an agent session's background task
  — Claude Code's or Codex's — was killed when that session hit its background-task limit (about two
  hours) or ended, mid-run and with no record of why.
- **`--status` says when a fleet died.** A fleet whose process is gone with features mid-run shows
  `⚠ fleet stopped — its process is gone with N features mid-run (…). Resume: node …/fleet.mjs
  --detach …` under the table, instead of `building` forever.

## 4.6.0

**Faster agent-run features** — about 15–25 minutes less per feature, nothing weaker:

- **The agent walk covers verify's cross-app E2E walk.** Under the fleet, the build adds the spec's
  cross-app walk to `walk.md` as steps `E1…En`; the agent walk runs them in the session it already
  drives, and verify quotes that report instead of driving the app again — only when no code changed
  since, and only the steps it didn't cover run live. Human-walked features are unchanged.
- **Failures already failing on the base branch are not re-investigated.** A gate at or under its
  baseline is green; verify reports the count and moves on.
- **`gate.mjs` says why it didn't quote:** `uncommitted: test-results/.last-run.json — not quoted`.
  `/builder:init` now flags tracked test output (`test-results/`, `coverage/`, …), the usual cause.
- **Time per run.** The fleet records each run's duration and turns; the archive keeps them per lane,
  and `/builder:fleet --status` shows a Time column and the recent mean per lane.

## 4.5.0

**New:**
- **Handoffs offer the agent.** Wherever agents could take the next step — after spec, align, audit,
  plan, a go-ahead, a stopped or finished build, a sign-off with fixes owed, and verify — the footer
  is a numbered choice instead of one command:

  ```
  📍 screen-row-dots: designed (md, server+web) — next:
     1. resume — continue here, step by step: /builder:resume --path docs/features/screen-row-dots
     2. agent  — hand it to agents to finish and merge: /builder:agent --path docs/features/screen-row-dots
     Reply 1 or 2 (or "resume" / "agent"; "go" is 1)
  ```

  Holds, human-only steps and anything before a spec stay single-line, and so does every footer in
  a repo whose config has no `agent_walk:` block.
- **`/builder:agent --path <folder>`** — hand one named feature to agents without the picker: the
  dry run and the one confirmation, then the fleet.

## 4.4.1

**Changed:**
- **`/builder:statusline` is one row.** Builder's segment now goes at the end of your existing
  status line, ` │ ` between, as `builder` with one bar of overall progress (the mean of a running
  fleet's features and any build in the chat), then the details: `… │ builder ▓▓▓▓▓░░░░░ 52% ·
  ⚙ fleet 2/4 · cover-sheet build 4/9`. Gates and jobs alone show without a bar; with nothing running it reads
  `builder ░░░░░░░░░░ idle`, so the row always has the same shape. A multi-line
  previous status line keeps its rows; builder joins the last.
- **The context meter shows from the first refresh.** Before a session's first reply Claude Code
  sends no context percentage, and a wrapped line that draws a meter (GSD's) left it out; the
  launcher now hands it an empty window, so the meter reads 0% instead of vanishing.
- **`--on`, `--off`, `--status` instead of a toggle.** Bare `/builder:statusline` only ever turns it
  on (or refreshes the launcher); turning it off takes `--off`. The old bare words still work.
- The launcher itself changed: run **`/builder:statusline`** once to refresh it.

## 4.4.0

**New:**
- **`/builder:statusline`** — a live line under your Claude Code status line while builder works:
  a running fleet with each feature's progress, a build in the chat, running gates and jobs. Blank
  when nothing runs; refreshes every two seconds. `on`, `off`, `status`, or bare to toggle. It
  writes the `statusLine` key of your user settings, keeps your existing status line showing above
  it, and `off` restores it exactly. Survives plugin updates without a re-run, and uses a repo's
  own vendored copy of builder where there is one.
- **Gate runs leave a marker** — `.builder/gates/running.json` while a set is running, which the
  status line reads.

## 4.3.1

**Changed:**
- **`/builder:brainstorm` and `/builder:intake` ask one question at a time.** Each question opens
  with a short briefing — the question in one sentence, **Why it matters**, **What it affects** and
  the **Recommendation** with its reasoning — then a picker with 2–4 concrete answers, the
  recommendation first and labelled `(Recommended)`, each saying what picking it does and what it
  makes better or worse. *Other* is always there for your own answer. A few quick, independent
  choices can still come together, as one picker with a tab per question; anything with real
  trade-offs is asked alone. Approaches use the same picker, with a preview of each. The record is
  rewritten after every answer.

## 4.3.0

**New:**
- **`/builder:version`**: which builder this session is running, and whether it's the newest. It
  reports:
  - the version this session actually loaded, which a session keeps until `/reload-plugins` or a
    restart even after a newer one is installed beside it;
  - where it came from: a user-scope or project-scope install, or the repo's own vendored copy;
  - what's installed on this machine, and a project-scope install that shadows the user-scope one;
  - the newest release this machine knows about, with when the marketplace was last refreshed;
  - a fleet running in this repo on an older version, which keeps that version until it finishes.

  It ends with the one step that brings the session current: `/reload-plugins`, `/builder:update`
  or `/builder:vendor`. It is read-only and never fetches, and it is included in vendored copies.

## 4.2.0

**New:**
- **A vendored copy tells you when it's behind.** In a repo carrying its own copy of builder,
  `/builder:status` and `/builder:resume` now print `⬆️ builder <latest> is available — this repo
  carries <have>. Run /builder:vendor to update it.` whenever this machine has a newer release. The
  check reads only the plugin installs and marketplace copies already on disk. `list-features.mjs
  --json` carries it as a top-level `builder` field.

**Changed:**
- **`/builder:vendor` refreshes before it copies.** It updates the marketplace and your user-scope
  install first, so "already up to date" means up to date with the latest release. `--check` does the
  same refresh without copying, and says whether a newer release is out.

**Fixed:**
- `/builder:vendor` picked its source by sorting folder paths, so another marketplace's plugin that
  happened to be called builder could win, and it would stop with an error. It now takes the
  user-scope `builder` install from `claude plugin list --json`, and only one that includes
  `scripts/vendor.mjs`.

## 4.1.1

**Fixed:**
- A `@scoped @delta` line with no baseline yet no longer records its subset count as one. A clean
  subset would have set the baseline to 0 and failed every later whole-suite run that has known-red
  tests. A subset that fails and is re-run whole records that whole-suite count; otherwise the
  baseline waits for `gate.mjs --baseline`, which the fleet runs at start.

## 4.1.0

**Changed:**
- **Naming a parked feature always unparks it.** `/builder:agent` now offers parked features, and
  picking one (or `/builder:fleet <feature>`) retries it whatever parked it and whichever builder
  version wrote the park: the fleet sets `blocked:` to `none` in a commit quoting the old line, and
  tells the first run what the park said so it checks whether the cause still holds. Before, the
  fleet read the `blocked:` line back and parked the feature again before any agent ran. A spec
  blocked where it was written is admitted the same way. A parked feature you did not name stays
  parked.
- **The agent walk's five-round cap starts over at an unpark**, so a retried feature gets five
  fresh rounds instead of parking at once.
- **Every park leaves a record: `<folder>/PARKED.md`**, committed with the `blocked:` line (REFERENCE
  §The park record). It holds what is stuck, what was tried, the evidence with the key lines quoted
  (the evidence folders don't travel with the branch), where to dig, the recommended next step and a
  history. Agent-walk, build and resume write it when they park; the fleet writes one when the
  parking run didn't. Every retry reads it first and starts from *Where to dig*. `/builder:resume` on a
  parked feature shows it and offers **Unpark and dig in**, and sign-off removes it.
- **The fleet retries parks on its own**: `agent_walk.auto_unpark` (default 2, 0 turns it off) per
  park per fleet run, each a fresh run handed the record. A `kind: human-step` park (your
  uncommitted changes, a `commit: manual` app) waits for you.
- **The deep set runs only what the branch can reach.** A gate line marked `@scoped <glob>` runs just
  the tests in that glob the branch reaches (the new `scripts/impact.mjs`), with `{tests}` marking
  where the file list goes. "Reaches" covers:
  - what the branch changed;
  - code reading a schema field it removed, renamed or retyped, under any spelling;
  - anything importing either, seen through barrel re-exports (type-only imports excluded);
  - pages and specs that load one of those files by name;
  - tests another feature changed in the same commit as that code.

  A change it can't trace (a file beside the tests that nothing loads, a runner config, a lockfile)
  runs the whole suite, and so does `gate.mjs --whole`. Why each test was picked is written to
  `.builder/gates/impact.md`, which verify cites. PROJECT.template now warns against a deep-set
  wrapper that re-runs the fast sets.
- **Brainstorm grounds your words in the code before it says anything back** (CONVERSATION
  §Grounding), a rung at a time, stopping at the first that answers. First, seconds: one grep for
  every spelling of every term, done by the session itself. Second, only the terms that matter:
  where the value is written and read, and which features use it. Last, only for a term still
  unclear: an Explore agent that searches wider, while the rest of the conversation goes on. Its
  first playback says what each term turned out to be. It asks you only for choices
  about what the product should do, or to pick between candidates it names, and never to define a
  word that is in your codebase.
- The inbox race is fixed: a feature added to a running fleet could be queued twice when a second
  add landed mid-drain.
- **A park reads as `<why> — next: <step>`** (REFERENCE §How a park reads): the stuck behaviour in
  plain words, not bare decision codes, commit shas or round-by-round history, plus the one step to
  take. The fleet's own parks follow it, `--status` adds a `## Parked` list giving each parked
  feature's why and next step, and `/builder:agent` shows both before it asks. An older
  `— clears when …` line still reads as its next step.

## 4.0.0

**Breaking:**
- `/builder:brainstorm` is now an exploration conversation. It plays back your intent, explains how
  the code works today, asks in rounds (every ready question, each with a recommendation; facts are
  looked up, never asked), lays out approaches, and confirms before anything is written. **Sizing
  happens after the concept is confirmed**, not first; an idea can also be parked or left at
  understanding.
- **Prototype mode moved to the new `/builder:intake`.** `/builder:brainstorm --<design.flag> <ref>`
  is now `/builder:intake --<design.flag> <ref>`.
- **Spec writing moved to the new `/builder:spec`**, which reads the conversation's workspace record
  (`.builder/<feature>/brainstorm.md`). md/lg/xl brainstorms hand off to it.
- **`--size` is retired** — the size is announced after the concept is confirmed, and you override
  it there.

**New:**
- `/builder:intake <doc | ticket | design ref>` verifies a worked-out input claim by claim —
  confirmed, contradicted or unverifiable — finds the gaps it never decides, and asks only about
  those.
- Every new `SPEC.md` opens with **§Idea**: why, what success looks like, your key rules in your own
  words (linked to the rulings), the concept, how it fits today, and the approaches considered.
  Decisions keep one line of why and why the rejected option lost; `check-obligations` warns on a
  bare rejection. Specs written before 4.0 stay valid.
- `/builder:status` and `/builder:resume` list conversations in progress (`brainstorming (6/11
  settled)`, `intake (3 contradicted…)`, `sized md — spec not written`, `parked idea`).

## 3.8.0

**Finished features are archived, so nothing routine slows down as the count of shipped work grows.**

- **The registry.** `/builder:ship` moves a shipped folder into `<registry>/_archive/<feature>/` in the
  ship commit (a program follows when its last child ships). `list-features.mjs` — behind
  `/builder:status`, `/builder:resume` and `/builder:agent` — program dependencies,
  `check-obligations --all` and `fleet --all` read only in-flight folders; "has X shipped?" is one path
  check. `list-features.mjs --archived [--limit N]` lists the archive, newest first.
- **The fleet.** A feature that lands leaves `fleet.json` for `.builder/fleet/archive.jsonl`; its logs
  move to `logs/_archive/<feature>/` and are pruned after `agent_walk.keep_logs` days (30). `--status`
  shows work in flight plus one `N archived` line; `--status --archived [N]` lists the latest landings.
- **Migration.** An existing `fleet.json` archives its `done` rows the first time it loads. Folders
  that shipped before 3.8 stay where they are until you run `node <builder>/scripts/registry.mjs
  --sweep` once — it `git mv`s them and leaves the commit to you.
- `/builder:brainstorm` refuses a feature name that is already archived and suggests `<name>-v2`.

## 3.7.0

**Agent mode builds to done; it parks only on a decision the spec left open.** A feature handed to
`/builder:agent` or `/builder:fleet` is an approved spec, so the problems that used to park it are now
work an agent does:

- **Merge conflicts.** When bringing the target into a worktree conflicts, the fleet leaves the
  merge in progress and runs an agent to resolve it — both sides kept, the touched apps' gates green,
  the merge committed — then carries on. Only a conflict two such runs could not resolve parks. Before
  a shipped feature merges into the target the fleet brings the target into its branch the same way,
  so that merge never conflicts. §Ship in agent mode resolves every conflict instead of only
  "mechanical" ones.
- **Landing after you switch branches.** A feature that ships while the checkout is on another
  branch still lands on the target: the `--no-ff` merge commit is written straight onto it.
- **A walk env that won't come up** gets one agent run to find and fix the cause, then one more try.
  A readiness step that needs the env restarted writes `blocked: "walk env needs a restart — …"`,
  which the fleet clears itself, restarting the env, instead of waiting for you.
- **A plan that wants to split** is built whole under `--agent-walk`, the split recorded as a ruling.
- **A failed agent walk** is fixed and walked again for up to five rounds (from round 3 the fixes go
  through systematic-debugging), not parked after two.
- **The build's stop classes** under `--agent-walk`: destructive, security-sensitive and outside-the-repo
  operations are avoided with a ruling instead of parking; only a `commit: manual` app and a plan too
  broken to rule on still park.

What still parks: an open scope question no ruling can settle, an audit `blocked:` finding, a
`commit: manual` app, `apply_mode: human` migrations, a `hold:`, and your own uncommitted changes in
the way of the merge. No config changes.

## 3.6.0

**Add to a running fleet.** `/builder:fleet <specs>` — and `/builder:agent`'s picks — while a fleet is
running no longer refuse with "Another fleet is running": admission is checked as at a launch, each
admitted spec is dropped in `.builder/fleet/inbox/` (one file per spec, so nothing needs a lock), and
the running fleet drains the inbox whenever a lane looks for work and on a 15 s poll
(`FLEET_INBOX_POLL_MS`), so a spec added while every lane is busy starts the moment one frees. A parked
or failed feature named again is retried. A dry run says `adds to the running fleet (pid N)`; naming
nothing while one runs is still refused, now with the hint. An inbox a dead fleet left behind is drained
at the next start. The running fleet's `--parallel` stands. `/builder:agent` stops offering features
already in the running fleet. No config changes.

## 3.5.1

- The progress bar reads the ledger at `state: planned` too: the build writes `state: building` only at
  a phase close or a stop, so a feature two tasks into its first phase showed `15% · planned` instead
  of `build 2/9`.

## 3.5.0

**Progress in the fleet table.** `--status` now renders the table live instead of printing the saved
file, with a `Progress` column per feature — `▓▓▓▓░░░░░░ 43% · build 2/4` — and an overall bar in the
heading (the mean over the rows). The percentage counts pipeline steps, not time: each manifest state
sets a floor (spec 0 → planned 15 → built 75 → signed-off 80 → verified 90 → merged 100), and inside
`building` the span to 70 scales with the ledger's `Task N: complete` lines against the plan's
`### Task N` headings. `STATUS.md` carries the same column at every save. No config changes.

## 3.4.1

- The fleet's status table drops the always-empty `PR` and `Evidence` columns and the repeated worktree
  path (the target and the worktree root are named once above it), so the terminal's table renderer
  stops wrapping `Runs` and feature names onto two lines.

## 3.4.0

**`agent_walk.sync`** — an optional command the fleet runs in a worktree right after merging the target
in with new commits, with `worktree_env` and `{feature}` filled in: the install and the test-DB
migration a merged-in package or migration needs. Without it, a walk env failed on `Cannot find
package '@d2m/colors'` — the package another feature had just landed on main, merged in after the
worktree's `npm ci`. A failing `sync` parks the feature naming its log. No existing config changes.

## 3.3.5

- The fleet saves its table before measuring `@delta` baselines and says so in a note, so `--status`
  during those minutes shows the queue as it is; a note about a worktree that no longer exists is dropped.

## 3.3.4

- `/builder:fleet --status` (and the end-of-run report) reply with the status as a rendered markdown
  table instead of pasting the file in a code fence, which showed as raw pipes in the terminal.

## 3.3.3

- The fleet saves `setupOwed` the moment a worktree is created, and saves a failed setup at once, so a
  fleet killed before its next save does not treat that worktree as prepared on the re-run.

## 3.3.2

- `gate.mjs` creates `.builder/gates/` before a command runs, so a gate line can `tee` its full output
  there on the first run.

## 3.3.1

- A `<placeholder>` gate line written `cd <dir> && …` names the changed test files relative to `<dir>`
  and takes only files under it, for a package whose dotenv path is relative to its own directory.
- The fleet measures `@delta` baselines only when the target sha has moved since the last
  measurement — an e2e-sized baseline is minutes, not something to pay at every start.

## 3.3.0

**The gates run once, and builds run side by side.** Measured on one fleet day (two repos, seven
features): test execution was ~60% of a d2m-sized feature's wall-clock, the same server suite ran
about fourteen times per feature, and `parallel: 1` — set because the suites shared one test database
— serialised four builds of three hours each. No config key is required; every new key is optional.

- **`scripts/gate.mjs`** runs an app's fast set (`gate.mjs <app>…`), the deep set (`--deep`), or
  every app (`--all`) from `.claude/builder.md` §Quality gates, and is now the only way a gate block
  is run — phase close, last-phase gates, verify, the ship step's target sync. It records each green
  set against a content hash of its inputs (the app's path, every tracked path no other app owns, the
  commands themselves; the registry excluded) and **quotes** that run, naming the sha, when the tree is
  clean and the hash is unchanged. A red run is never quoted. REFERENCE §Quality gates says why that
  is fresh evidence in the iron law's sense.
- **Flakes and baselines are the config's call, not a model's.** A `flaky:` list (`match:` a regex on
  the failure output, `rerun:` the narrow command that proves the file alone) gets one automatic
  re-run; a gate comment ending `@delta` means the command prints a count that must not exceed the base
  branch's, measured by `gate.mjs --baseline` (the fleet runs it at start in the main checkout, and a
  worktree reads it from there); `@known-red` marks inherited debt that is reported, never counted.
  The template's deep set is now "only what the fast sets don't cover".
- **Implementers no longer run the app's suite.** The prompt limits them to the tests of the code they
  change plus the type-check; the phase close runs the block once. Reviewers are told not to re-run
  suites at all.
- **The build lane runs the deep set** when the last phase closes under `--no-dev-env`, in parallel
  with other builds; verify quotes it if the tree is unchanged, so the one-at-a-time walk lane no
  longer spends 40–50 minutes on gates per feature.
- **`agent_walk.worktree_env`** — `KEY=VALUE` pairs with `{feature}` that reach EVERY run and `setup`
  in a worktree (the walk lane's `env` layers on top). A `TEST_DATABASE_URL` per worktree, plus a
  `setup` that creates it (`setup` now has `{feature}` filled in too), is what makes `parallel: 3`
  safe for suites that share a database. `/builder:init` recommends it in place of `parallel: 1`.
- **The fleet merges the target into each worktree** before every build- and ship-lane run, and
  before the walk env starts at walk readiness and at verify (never between readiness and the walk),
  so features integrate as they land, the walk env never runs code the run has since merged past, and
  the ship step's own merge finds nothing new. A conflict parks the feature naming the cause.
- **Never kill what you did not start.** Implementer, reviewer and controller prompts, and the
  template's §Global constraints: no `pkill`/`killall` by pattern, no killing PIDs found in `ps`,
  `timeout` on a command that may hang. One lane's `pkill -f "node --test"` killed the other lane's
  verify suite (exit 137) and cost a nine-minute re-run.
- **`workspace --remove <feature>`** replaces `rm -rf "$(workspace …)"` at ship: the harness refuses
  an `rm -rf` on a substituted path, and inside a chained command that refusal ran nothing — five of
  five agent-mode ships lost a turn to it.
- **A go-ahead is never a park.** `/builder:plan` and resume's `--agent-walk` table now say so
  explicitly; a run had written `blocked: "no human go-ahead"` on a spec whose decisions were all
  auto-ruled, which cost the feature its fleet day.
- **Tiny tasks.** The plan step folds a one-line change into an existing task of the same app, or
  marks the task `tiny` on its `Recipe:` line so the build reviews it at the cheapest tier — three
  consecutive one-task phases had cost as much as a phase of five real tasks.
- The fleet's `.log` no longer prints a run's final message twice.

## 3.2.0

- **`/builder:update` — take the newest release from inside a session.** It refreshes the marketplace
  the running copy came from (read from its install path, never hard-coded), updates the user-scope
  install, summarises the changelog since the version you had with breaking changes first, and names
  any project- or local-scope install in the current repo that pins an older version over it,
  offering to remove it. `--check` only reports. `scripts/vendor.mjs` leaves it out of a vendored
  copy: that is updated with `/builder:vendor`.

## 3.1.1

- **`/builder:resume` with no argument asks which feature, from a list.** The picker now runs before
  Step 1 instead of being a section the flow reached last, and it fits AskUserQuestion the way
  `/builder:agent` does: at most four options, the most recently touched unfinished features, the one
  closest to done recommended, parked ones listed underneath with their reasons. **Other** takes any
  feature by name, or new work for `/builder:brainstorm`. A pick on another branch switches to it
  when the tree is clean.

## 3.1.0

**`/builder:vendor` — a local copy that names nothing outside the repo.** For a repo whose policy
rejects a plugin fetched from elsewhere (a settings entry naming this marketplace got a PR reverted).
`scripts/vendor.mjs <repo>` copies only what runs — `skills/`, `scripts/` without tests,
`PROJECT.template.md`, the licences, a `plugin.json` cut to name, description, version and the host as
author — into the folder the repo's own marketplace names for `builder` (else `plugins/builder`),
enables it from that marketplace, removes settings entries naming this one, and switches the
user-scope install off in the git-ignored `settings.local.json`. It scans the copy for the source's
marketplace name, repo, homepage, owner and path **before writing anything**, and everything it
wrote after. Re-running it is the update: the copy is replaced whole. `--dry-run` previews, `--check`
proves an existing copy clean and names a newer version.

## 3.0.1

- **A *Depends on* entry outside the program counts.** `glyph-library (shipped)` named a shipped
  program in the registry, but the parser read it as two unknown children and held the child back
  for good. A parenthetical is now a note, and a token that isn't a child is looked up as a registry
  feature or program — met when its SPEC or PROGRAM header says SHIPPED or its manifest says
  `state: shipped`. A token naming nothing still holds the child back.
- **A planned feature no longer claims its spec branch.** A manifest's `branch:` is honoured only from
  `building` on (was `planned`), so a feature planned on the branch another feature is building on
  gets its own `builder/<feature>` branch instead of colliding with it.

## 3.0.0

**Agent mode finishes the job, on your branch.** `/builder:agent` and `/builder:fleet` now take every
feature all the way — verified and **merged into the branch you ran them from** — or park it with the
reason a human is needed. Run it against five specs and you get five merge commits on one branch to
test, not five worktrees to walk. No config key changes, but what `--agent-walk` does has changed, so
it is a major.

- **Agent sign-off.** An agent walk that passes writes the agent's sign-off (`walk: agent-pass`,
  `state: signed-off`, SPEC header `> 🤖 AGENT SIGNED OFF … not human-tested`) and condenses the
  folder, the way `/builder:signoff` does for a human. `/builder:signoff` stays human-only, and a
  human sign-off over an agent one hands the feature back to the human flow.
- **Ship in agent mode** (resume): merge the target branch in (fast gates if it moved; a conflict
  that isn't mechanical parks), then `/builder:ship` with a `SHIPPED … merged into <branch>` header.
- **The fleet merges** each shipped feature into the branch checked out where it was started — its
  target, kept in `fleet.json` — as one `--no-ff` merge commit, `merge(<feature>): agent-verified,
  not human-tested`, then removes the feature's worktree and `builder/` branch. A merge your
  uncommitted changes are in the way of parks, untouched, and the next fleet run retries it. A
  re-run from another branch is refused while the fleet has unfinished work. **Nothing is pushed and
  no PR is opened** — both stay yours. Every run is told the target (`--into <branch>`).
- **The fleet has a ship lane** sharing the parallel pool with builds, so shipping never holds the
  one-at-a-time walk lane. A feature with an open PR (an agent draft from 2.x) is taken on and
  merged locally; its PR is left for you to close.
- **Program chains run in one fleet run.** A child waits for its dependencies in the same run to be
  merged into the target, then is branched from it. A dependency outside the run refuses the child;
  one that parks parks its waiters.

**Headless runs finish what they start.** A `claude -p` run exits when its last turn ends, taking
anything it backgrounded with it — in practice, a verify whose gate suite was cut off three runs in a
row, then parked for "no progress".

- Under `--agent-walk` nothing runs in the background: no `run_in_background`, `ScheduleWakeup` or
  `Monitor`; subagents run in the foreground; a long command goes through the new
  **`scripts/job.mjs`** (`start` it detached, `wait` on it in bounded foreground calls until it
  reports an exit code); and a run's last message is a handoff after the work finished.
- The fleet streams each run's output (`--output-format stream-json`) and kills a run only after **30
  minutes of silence** (`FLEET_IDLE_TIMEOUT_MS`), with a 6-hour backstop (`FLEET_RUN_TIMEOUT_MS`),
  instead of a flat 45 minutes that killed healthy long builds. The `.log` gets the run's words as it
  works; the raw stream goes to a `.jsonl` beside it.
- One run with no progress gets another; two in a row park.

## 2.7.0

**Program dependencies are enforced for unattended runs.** A program child whose PROGRAM §Children
*Depends on* entries haven't all shipped is no longer offered by `/builder:agent`, and the fleet
refuses it (`✗ <child> — waits on <dep> (<state>)`) instead of building it off `HEAD` against a
contract that isn't merged. `list-features.mjs --json` gains a `waitsOn` array per row, and
`/builder:status` shows `⏳ waits on …` as the next step. A dependency counts as shipped when its
program `child:` line says so or its own folder does (a `✅ SHIPPED` header or `state: shipped`); a
*Depends on* token naming no child holds the child back. Chains run one wave per fleet run, after
each merge. No config change.

## 2.6.0

**An isolated walk env, owned by the fleet.** `agent_walk` gains five optional keys: `copy` (untracked
files — a `.env`, local certs — brought into each NEW worktree; never overwrites a tracked file, and a
missing source is just noted), `setup` (runs once per new worktree, after `copy`; a failure parks the
feature with `setup failed — see <log>` and is retried on the next fleet run), `env` (whitespace-
separated `KEY=VALUE` pairs, quotes allowed, `{feature}` substituted, merged over the environment and
passed to the walk lane only — its headless `claude -p` runs and the `reset`/`start`/`smoke`/`stop`
hooks; build-lane runs and `setup` never see it, so parallel builds can't hit the walk env's ports or
database — and it can never set `CLAUDE_PROJECT_DIR`; the fleet drops it and notes that), and
`start`/`smoke` (a second dev env for the walk lane: the fleet spawns `start` detached after `reset`,
polls `smoke` every 2s for up to 5 min, and — after the walk ends for any reason, including a park —
always kills `start`'s process group before running `stop`).
If `smoke` never passes, or `start` exits first, the feature parks with "walk env didn't come up". A
`start` with no `smoke` just waits 10s. REFERENCE §Walk readiness now says what changes when the fleet
has already started this env: it runs `agent_walk.smoke` in place of its own, never starts or
restarts anything, and a restart-class change parks instead of restarting.

**`/builder:init`'s `--update`** now **offers** an `agent_walk:` block once, rather than filling it in
outright, when the config has none — a missing optional block is not a gap.

**Correction:** 2.5.0 said `/builder:init --update` adds the `agent_walk:` block. It offers it instead.

## 2.5.0

**Unattended runs.** `/builder:agent` lets you tick unfinished features — at any step before the PR — and hands them to agents until each is a draft PR or parked with a reason; `/builder:fleet` takes a batch of written specs to draft PRs with no human in the
loop: one worktree and `builder/<feature>` branch per spec, builds in parallel, walks one at a time
through the shared dev environment. `scripts/fleet.mjs` does the work and resumes from
`.builder/fleet/fleet.json` if stopped, and continues a feature already underway on its own branch; `--dry-run` and `--status` show the plan and the table.

**`--agent-walk`** — the mode the fleet runs in — implies `--auto` and never asks: each pause takes
its recommendation or **parks** the feature with a new manifest line, `blocked:`, which
`/builder:resume` honours until a human clears it. **`--no-dev-env`** keeps parallel builds off the dev
environment. **`/builder:agent-walk`** replaces the human walk with a fresh agent working `walk.md`
with the configured driver, and records `walk: agent-pass` and `🤖 AGENT-VERIFIED — not human-tested`
— never a human sign-off. Two failed rounds park the feature.

**The PR lock, amended once:** an agent-verified feature may open a **draft** PR; marking it ready
still requires `/builder:signoff`, which stays human-only. A human PASS supersedes the agent's verdict.

**Config:** an optional `agent_walk:` block (`driver`, `claude_args`, and optionally `worktrees`,
`parallel`, `reset`, `stop`). Without it nothing changes. `/builder:init --update` adds it.

**Scripts:** `scripts/manifest.mjs` (shared parser), `scripts/fleet-core.mjs`, `scripts/fleet.mjs`, and
the first test suite — `node --test 'scripts/test/*.test.mjs'`.

## 2.4.0

**Say "go" instead of pasting the next command.** Every handoff still ends with its 📍 footer, but a
bare affirmative in reply — "go", "yes", "proceed", "continue" — now runs that footer's command in the
same turn. Nothing is skipped: the command runs as if typed, and every gate it reaches still asks.
`/builder:resume` is no longer `disable-model-invocation`, so "continue where I left off" works in a
fresh session too, and a mid-build context stop offers "go" to carry on in the session instead of
requiring `/clear`. Footers that "go" can continue end with ` · or say go`; `/builder:status` accepts
a feature's name as the reply.

Unchanged by design: `/builder:signoff` is still typed by the human only, and "approve" after a walk
is answered with the command to type, not a sign-off. A step only the human can do, a hold, and
anything with more than one candidate still stop, and opening the PR asks once even after a "go".
The rule lives in REFERENCE §Continuing on "go".

## 2.3.0

**Walk readiness** — the pipeline no longer asks a human to walk, or sign off, a build the dev
environment isn't running. Green gates run against a test database; the walk doesn't. Before the walk
script is printed (and after walk fixes, and at the end of an xs/sm change) it now checks the dev
database for pending migrations and **asks before applying them**, regenerates and restarts what went
stale, and smokes each changed surface — endpoints, pages, their console and the server log. An
error it finds is fixed as a build defect, not handed over as a walk item. A new manifest line,
`ready:`, records it; `/builder:signoff` refuses a PASS while it is pending, and `/builder:status`
shows what's left.

**Config:** a new `## Walk readiness` section in `.claude/builder.md` — the migrations directory and
the status / apply / regenerate / start / smoke commands, plus `apply_mode: ask | human | agent`.
Optional: without it the pipeline infers the commands and says so. `/builder:init --update` adds it
to an existing config.

## 2.2.0

**`/builder:status`** — every in-progress feature and program in one table, most recently touched
first: what it is (the SPEC's first Overview sentence), the step last completed, the step next, when
it last moved, and the `/builder:resume` command to paste to pick it up. Flags a feature whose branch
isn't the one checked out, and one that can't be resumed as it stands. Backed by
`list-features.mjs --status`, so it reads manifests only and writes nothing.

## 2.1.0

**`/builder:init`** — per-repo setup in one command. It reads the repo (workspaces, gate commands, CI,
`git log`), asks only what it cannot tell, writes `.claude/builder.md` and proves it parses.
`--update` fills gaps in an existing config without touching what a human wrote. The missing-config
message in every script and skill now points at it. No change to the config format.

## 2.0.3

Public release. Correct authorship and homepage, a contribution guide and a PR template. No change
to the pipeline.

## 2.0.2

Corrects the 2.0.1 note, which named the wrong cause. A marketplace install **does** materialise the
plugin on disk immediately. What was wrong is that the fallback hardcoded `~/.claude`, and the
config directory moves — `CLAUDE_CONFIG_DIR` pointed at `~/.claude-home` on the machine this was
found on, where the files were sitting the whole time. The fallback now reads
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.

## 2.0.1

Script resolution now prefers **`$CLAUDE_PLUGIN_ROOT`**, the documented, portable way for a plugin
to reference its own files, with the previous paths kept as fallbacks. (The cause given for the bug
in this release was wrong — see 2.0.2.)

## 2.0.0

**Dependency-free and project-agnostic.** The plugin no longer requires any other plugin, and no
longer knows anything about the repo it runs in.

- The execution engine, its four agent prompts, the plan format and two scripts are vendored
  (MIT — `LICENSE-THIRD-PARTY.md` records what came from where and what the adaptation changed).
- Every project fact moved to a single host file, `.claude/builder.md`: the apps and their roles,
  the literal gate commands, the global constraints pasted into every implementer brief, the house
  rules, the environment landmines, the recipe skills and an optional design source.
- **Apps have roles** — `producer` owns the contract and its phase freezes it, `consumer` codes
  against the frozen shape, `tool` runs after what it reads, `app` is a single-unit repo. Plus
  `commit: manual` (an agent never commits there) and `released_artifact: true` (a contract change
  it reads is breaking until §Apps states the transition).
- **Four craft skills** vendored essentially verbatim: `test-driven-development`,
  `systematic-debugging`, `receiving-code-review`, `verification-before-completion` — handed to
  every implementer by path and cited where they bite.
- Scripts moved into the plugin and read the config: `list-features.mjs`, `check-obligations.mjs`,
  `workspace`, `task-brief`, `review-package`.

Fixes in this line: an app literally named `app` matched the §Apps table header and reported every
app out of scope; a `SPEC.md` with no manifest was misread as analysis rather than an incomplete
feature; the script-resolution recipe used a bare glob (aborts under zsh) and an unsorted `find`
(picked a stale cached version).

## 1.0.0

First release — the pipeline as a plugin: sizing, SPEC/PLAN/MANIFEST, the one-pass audit, one app
per phase, the human walk and the PR lock. Depended on the superpowers plugin.
