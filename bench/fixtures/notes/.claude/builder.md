---
project: notes
registry: docs/features
base_branch: main
merge_into: main
apps:
  - name: notes
    path: ./
    role: app
    commit: auto
agent_walk:
  driver: the CLI itself — run `node src/cli.mjs …` with Bash against a scratch NOTES_FILE and read what it prints
  claude_args: {claude_args}
  parallel: 1
  keep_logs: 0
  auto_unpark: 0
---

# notes — builder config

A single-app repo: one Node CLI (`src/cli.mjs`) over one JSON store (`src/store.mjs`), tested with
Node's own test runner. There is no server and no UI; a feature is walked by running the CLI.

## Quality gates

### notes — fast

```
npm test          # the CLI's own tests, every command end to end
```

### Deep set (verify only)

```
```

## Walk readiness

No dev environment: the walk runs `node src/cli.mjs` directly with `NOTES_FILE` pointing at a
scratch file. Nothing to apply, start or smoke.

## Global constraints

- No dependencies. Node's own modules only.
- The CLI entry stays `src/cli.mjs`; tests stay under `test/` and run with `npm test`.
- Every command prints its result on stdout and fails (exit 1, message on stderr) on bad input.
