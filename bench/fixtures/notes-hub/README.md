# notes-hub

Two apps in one repo, no dependencies (Node's own modules only):

- `apps/cli` — the `notes` command line: `notes add <text>`, `notes list`, `notes show <id>`,
  `notes rm <id>`. Notes live in a JSON file named by `NOTES_FILE` (default `./notes.json`).
  Entry point: `apps/cli/src/cli.mjs`.
- `apps/server` — a small JSON API over `node:http`: `GET /health`, and `/notes` (create, list, read,
  delete). It listens on `PORT` (default 4000) and keeps its data in memory, or in the JSON file
  named by `STORE_FILE` when that is set. Entry point: `apps/server/src/server.mjs`
  (`npm start --prefix apps/server`).

Tests: `npm test` at the root runs both suites; `npm test --prefix apps/<app>` runs one. The suites
are slow on purpose: every test file waits `SLOW_TESTS_MS` (default 4000 ms) before it runs — it
stands in for the expensive setup a real suite pays (a database, a browser) — and the files run
one at a time, so a full run of both suites costs about half a minute. `SLOW_TESTS_MS=0` skips the
wait.
