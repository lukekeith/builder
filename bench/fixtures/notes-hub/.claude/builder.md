---
project: notes-hub
registry: docs/features
base_branch: main
merge_into: main
apps:
  - name: server
    path: apps/server/
    role: producer
    commit: auto
  - name: cli
    path: apps/cli/
    role: consumer
    commit: auto
agent_walk:
  driver: the CLI and curl — with Bash, start nothing yourself; the fleet has the server up on http://localhost:$PORT. Run `node apps/cli/src/cli.mjs …` with NOTES_FILE pointing at a scratch file (a second scratch file is a second user) and NOTES_SERVER=http://localhost:$PORT, call the API with `curl -s -i localhost:$PORT/…`, and read what each prints
  claude_args: {claude_args}
  parallel: 1
  keep_logs: 0
  auto_unpark: 0
  env: PORT=4917
  start: npm start --prefix apps/server
  smoke: curl -sf localhost:$PORT/health
  stop: lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null; exit 0
---

# notes-hub — builder config

Two apps in one repo, Node's own modules only. `server` (`apps/server`) is a small JSON API over
`node:http` — it owns the HTTP contract, so it is the producer. `cli` (`apps/cli`) is the `notes`
command line over a local JSON file; anything it learns to do against the server it does through
that contract, so it is the consumer. `test-support/` holds the one helper both suites share.

## Quality gates

Both suites are slow on purpose: every test file waits `SLOW_TESTS_MS` (default 4000 ms) before it
runs, and the files run one at a time — about 16 s per app. Run single test files while you work.

### server — fast

```
npm run check --prefix apps/server   # every source file parses @typecheck
npm test --prefix apps/server        # the API's own tests, every route end to end
```

### cli — fast

```
npm run check --prefix apps/cli      # every source file parses @typecheck
npm test --prefix apps/cli           # the CLI's own tests, every command end to end
```

### Deep set (verify only)

```
```

## Walk readiness

No database and nothing to migrate. The walk env is the server on its own port (`PORT=4917` from
agent_walk.env), in memory, started with `npm start --prefix apps/server` and probed at `/health`;
the CLI needs no start — it is run directly with `NOTES_FILE` and `NOTES_SERVER` set.

- The server holds its data in memory unless `STORE_FILE` is set: a restart empties it.
- A change under `apps/server/src/` needs a server restart; the CLI is read fresh on every run.

## Global constraints

- **Your task touches ONE app.** Its `App:` line says which. Do not edit another app "while you are in there" — `test-support/` is shared by both and changes only in a task that says so.
- **Run the tests for the code you change, not the app's whole suite** — `node --test apps/<app>/test/<file>.test.mjs`; the phase close runs the gate block once. A test file costs SLOW_TESTS_MS on purpose; `SLOW_TESTS_MS=0` skips it while you iterate, never in a gate. Run every command in the foreground. **Never kill a process you did not start in this task, and never `pkill`/`killall` by pattern**; a test that starts a server listens on port 0 and closes it.
- No dependencies, in either app or at the root. Node's own modules only; tests use `node:test` and `node:assert/strict`, and every test file imports `../../../test-support/slow.mjs` first.
- The entry points stay where they are: `apps/cli/src/cli.mjs` and `apps/server/src/server.mjs`; tests stay under each app's `test/` and run with `npm test --prefix apps/<app>`.
- CLI: every command prints its result on stdout and fails (exit 1, a one-line message on stderr, never a stack trace) on bad input or an unreachable server.
- Server: routes live in `createApp`'s table in `apps/server/src/app.mjs`; a handler returns `[status, body]` or throws `HttpError(status, message)`, which answers `{ "error": message }`; data goes through `createStore` (`apps/server/src/store.mjs`), never a module-level variable; time comes from the `now` the app was created with, never `Date.now()` in a handler.
- Commits: **exactly one commit for this task** — code and tests together — `<type>(<app>): <subject>`. If review sends you back, each fix round is its own commit. **Never `git commit --amend`.**
- Never create a branch, a worktree or a ticket. Never open a PR.
- Report: status · commits · one-line test summary · concerns, under 15 lines; the detail goes to your report file.

## House rules

**server** — routes in `createApp`'s table; validation in the handler, answered as `HttpError(400, …)`; JSON in and out through `http.mjs`; storage through `createStore` collections; injectable `now`; a test per route through `test/helpers.mjs`'s `serve()`.

**cli** — one `case` per command in `src/cli.mjs`; local data through `src/store.mjs`; output on stdout, failures through `fail()`; a test per command through `test/helpers.mjs`'s `notes()`.

## Environment landmines

- Test files run one at a time and each waits SLOW_TESTS_MS first: a whole suite is ~16 s per app, ~32 s for both.
- The walk server is on PORT 4917; tests never use a fixed port.
