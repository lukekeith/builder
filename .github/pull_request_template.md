## What this changes

<!-- One or two sentences. What is different after this lands? -->

## Why

<!-- The problem. If it's a bug, what did it do, and how did you reproduce it? -->

## How it was exercised

<!-- This plugin is made of instructions, so "it compiles" proves little.
     What did you actually run, or read end to end? -->

- [ ] `claude plugin validate .` passes
- [ ] `scripts/workspace --self-test` passes (if scripts changed)
- [ ] Exercised against a real `.claude/builder.md`

## Checklist

- [ ] **No project specifics leaked into the plugin** — nothing names an app, language, framework or
      command. Anything project-shaped goes in `.claude/builder.md` instead.
- [ ] If a vendored file changed, `LICENSE-THIRD-PARTY.md` still describes it accurately.
- [ ] If this changes what `.claude/builder.md` must contain, it says so — that breaks consumers on
      update and needs a major version.
- [ ] Scripts still have zero dependencies.

## Version

<!-- Don't bump it. Just say what you think this is: patch / minor / major, and why. -->
