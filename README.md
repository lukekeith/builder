# builder

A build pipeline for Claude Code. You say what you want; builder works out the design with you,
checks it against your code, builds it, tests it, and merges it. It works in any repo and needs no
other plugin and no `npm install`.

## Install

```bash
claude plugin marketplace add lukekeith/builder
claude plugin install builder@claude-builder
```

Then, in each repo, inside a Claude session:

```
/builder:init
```

It reads the repo — apps, test commands, CI, git history — asks only what it can't tell, and writes
`.claude/builder.md`. Commit that file. It is the only thing builder needs from your project.

## Use it

Three commands cover almost everything:

| Command | When |
|---|---|
| `/builder:brainstorm <what you want>` | Start anything — explore an idea, ask for a change, or ask how something should work |
| `/builder:status` | See everything in progress and what each needs next |
| `/builder:resume` | Pick up where you left off, after a `/clear` or the next day |

At every pause builder says what happens next and recommends one option. Reply **go** to take the
recommendation, or pick another.

## What happens to your request

1. **brainstorm talks it through.** It looks up what your words refer to in the code, explains how
   that part works today, and asks only what is still open.
2. **It sizes the work.** A small change (`xs`, `sm`) is designed and built right there in the chat.
   A bigger one (`md`, `lg`) gets a written spec; a very big one (`xl`) is split into several.
3. **You approve the spec**, shown to you as a plain-language review, and choose who takes it on:
   - **Agent** — what "go" picks. Agents check the spec against the code, plan it, build it in its
     own worktree, try it in the running app, and merge it into your main branch on your machine
     (`merge_into` in the config picks another), marked `🤖 not human-tested`. Nothing is pushed
     and no PR is opened.
   - **Step by step** — the same, but it pauses for you to settle open questions and approve the
     plan and how much testing it gets before agents build it.
   - **In this session** — it is planned and built right here in your session, then stops for you to
     try it. You type `/builder:signoff` when it works; only then come the final check and the PR.
     Only you can type that — the plugin blocks `gh pr create` until you have.

## Words you'll see

| Word | Means |
|---|---|
| **spec** | `SPEC.md` — what the feature is and why, written once and kept |
| **manifest** | `MANIFEST.md` — a ~12-line file that says where the feature stands; how resuming works |
| **plan** | `PLAN.md` — the build, step by step, with the code and tests |
| **walk** | trying the finished feature yourself in the running app |
| **sign-off** | `/builder:signoff` — your verdict after the walk |
| **verify** | the final full check before a PR |
| **park** | a feature stops because it needs a decision only you can make; it says what and why |

## All commands

<!-- Every skill in skills/ appears in this table — scripts/test/docs-drift.test.mjs checks it. -->

| Command | What it does |
|---|---|
| `/builder:brainstorm` | Start here — talks an idea through, then builds it in chat or hands it to `spec` |
| `/builder:intake` | Checks a spec, ticket or design someone already wrote against the code |
| `/builder:spec` | Writes the spec from a confirmed brainstorm or intake |
| `/builder:status` | Everything in progress, with the next step for each |
| `/builder:resume` | Runs a feature's next step |
| `/builder:agent` | Hands unfinished features to agents to finish and merge |
| `/builder:fleet` | Builds several specs unattended, overnight if you like |
| `/builder:fleet:status` | Where the fleet stands — and, once features land, where their time went |
| `/builder:signoff` | Your verdict after testing a feature — only you can type it |
| `/builder:revise` | Changes a feature that is already planned or part-built |
| `/builder:tidy` | Cleans up leftover builder branches and worktrees |
| `/builder:init` | Sets up builder in a repo |
| `/builder:update` · `/builder:version` | Get the newest builder · see which one you're on |
| `/builder:vendor` | Puts a copy of builder inside a repo that won't take outside plugins |
| `/builder:statusline` | A live builder progress bar in your status line |
| `/builder:help` | The help card |

The steps `resume` runs for you, which you can also run by hand: `/builder:audit`, `/builder:plan`,
`/builder:build`, `/builder:agent-walk`, `/builder:verify`, `/builder:ship`, and for building from a
finished design, `/builder:prototype`, `/builder:check` and `/builder:align`. Four skills set how the
work is done: `/builder:test-driven-development`, `/builder:systematic-debugging`,
`/builder:receiving-code-review`, `/builder:verification-before-completion`. `/builder:benchmark` is
a maintainer tool.

## More

- **[The guide](docs/guide.md)** — installing for a whole team, vendoring, updating, the config,
  multi-app repos, agent runs and the test plan, hooks, and what builder never does.
- **[Changelog](CHANGELOG.md)** · **[Contributing](CONTRIBUTING.md)** · **[Releasing](RELEASING.md)**
- **Codex:** builder is also available for Codex — [codex/README.md](codex/README.md).
