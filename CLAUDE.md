# builder — working in this repo

- Design docs for changes to builder live in `docs/specs/YYYY-MM-DD-<topic>-design.md`, and their
  implementation plans in `docs/plans/YYYY-MM-DD-<topic>.md` — not `docs/superpowers/`, whatever a
  skill's default says.
- Releases follow [RELEASING.md](RELEASING.md): default to a patch; a new flag or capability is a minor.
- `preview/` is the response preview — what each skill prints, path by path (`/preview` opens it).
  When a change alters what a skill prints, run `node preview/preview.mjs --check`, rewrite the
  stale stages to match, and `--stamp` them ([preview/README.md](preview/README.md)).
