# Changelog

`version` in `.claude-plugin/plugin.json` is the release number. Cut a release with
`claude plugin tag --push`, which refuses to tag unless `plugin.json` and the marketplace entry
agree — see [RELEASING.md](RELEASING.md).

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
