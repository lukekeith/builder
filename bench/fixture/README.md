# notes

A small command-line notes app: `notes add <text>`, `notes list`, `notes show <id>`, `notes rm <id>`.
Notes live in a JSON file named by `NOTES_FILE` (default `./notes.json`). No dependencies.

Run the tests with `npm test`. The CLI entry point is `src/cli.mjs` and must stay there.
