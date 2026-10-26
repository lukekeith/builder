Notes can be edited.

- `notes edit <id> <text>` replaces that note's text, keeps its id, and prints `edited <id>`.
- An unknown id makes it fail with exit 1 and `no note <id>` on stderr, as `show` and `rm` do.
- No text (`notes edit 3` or only spaces) makes it fail with exit 1 and the usage line on stderr.
- The usage line names the new command.

The CLI entry stays `src/cli.mjs`, the tests stay under `test/` and run with `npm test`, and
there are still no dependencies. The feature is done when it is merged into `main` and
`npm test` is green.
