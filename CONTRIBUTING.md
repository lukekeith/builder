# Contributing

Contributions are welcome. The short version: **fork, branch, PR**. Nothing lands on `main` except
through a reviewed pull request.

## The shape of the thing

This plugin is **project-agnostic on purpose**. It names no app, no language, no framework and no
command — every project fact lives in the host repo's `.claude/builder.md`
(`PROJECT.template.md` is the blank). The most common way a change gets rejected is by putting a
project's specifics into the plugin. If your change needs to know something about a repo, it belongs
in the config, and the plugin should read it from there.

`skills/resume/REFERENCE.md` says what the pipeline **does**; the config says what it does it **to**.
Keep that line.

## Before you open a PR

```bash
claude plugin validate .        # manifests, plus the skills/agents/commands in the tree
scripts/workspace --self-test   # the one script with a built-in self-test
```

And exercise what you changed. A scripts change should run against a real config; a skill change
should be read end to end for the rule it adds — this is a plugin made of instructions, so the test
of a change is whether a fresh agent would follow it.

## Things worth knowing

- **Vendored material.** Parts of this plugin are adapted from the
  [superpowers](https://github.com/anthropics/claude-plugins-official) plugin (MIT) —
  `LICENSE-THIRD-PARTY.md` records what, from where, and what the adaptation changed. If you change a
  vendored file, say so in the PR and keep that record accurate. Rules in the four craft skills are
  upstream's; prefer fixing them upstream over diverging here.
- **The four not-vendored-on-purpose skills.** `using-git-worktrees`,
  `finishing-a-development-branch` and `dispatching-parallel-agents` contradict rules this pipeline
  enforces. If you want their behaviour, the conversation is about changing the rule first, not about
  adding the document.
- **Breaking changes are about the config.** The plugin reads `.claude/builder.md` from the host
  repo. A change that expects a key existing configs don't have breaks every consumer on update —
  that is a major version, and the changelog must say exactly what a consumer has to add.
- **Scripts have no dependencies and must keep it that way.** No `npm install`, no network. Node's
  standard library and POSIX shell only; that is what makes the plugin droppable into any repo.

## Releases

Maintainers only — see [RELEASING.md](RELEASING.md). Contributors don't bump the version in a PR;
say in the description whether you think it's a patch, minor or major and why.
