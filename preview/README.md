# Response preview

What builder prints at each stage, path by path, as the user sees it in the terminal. A tool for
working on builder — not shipped behaviour.

```bash
node preview/preview.mjs --open     # serves it → http://localhost:4848 and opens it (or /preview in this repo)
node preview/preview.mjs --check    # which stages no longer match their skill section; exit 1 if any
node preview/preview.mjs --stamp <stage-id…>   # after refreshing a stage (or --all)
```

## How it is put together

- `stages/*.json` — the stages, one file per area. A stage is a short transcript: `user`,
  `tool`, `claude` (markdown, as printed), `picker` (an AskUserQuestion) and `note` (a remark for the
  reader, hideable) turns, all in one sample project, `acme-certs` (apps `api`, `web`, `mobile`).
- `paths.json` — the paths: an ordered list of stage ids each, grouped in the sidebar.
- Every stage names the skill section it shows (`source`, optional `sources`) as
  `skills/<x>/<FILE>.md §<heading>`, and carries a `stamp` — the hash of those sections when the
  stage was last checked against them.

## Keeping it current

A change to a skill section a stage cites makes that stage **stale**: the page badges it and
`--check` lists it. When you change what a skill prints:

1. `node preview/preview.mjs --check` — the stale stages.
2. Rewrite their turns to match the skill as it now reads (a stage whose section changed in a way
   that does not touch what the user sees only needs the stamp).
3. `node preview/preview.mjs --stamp <id…>`.

A new output (a new skill, footer, path) gets a new stage, and a step in `paths.json`. A renamed
heading breaks the stage's source (`broken`) — the test suite fails on that, so fix the `source`.
