# builder — MakeReady's build pipeline (Claude Code plugin)

Invoked as `/builder:<skill>`. Start with **`/builder:brainstorm <what you want>`**; `/builder:help` is
the card.

Ported from FinPro's `builder` plugin (2026-09-24) and adapted to this four-app monorepo. It **replaces**
the `/build-spec*` family: the four-app knowledge that pipeline carried — the per-app impact table, the
cross-app contract and its freeze, the per-app quality gates, the environment landmines — lives in
`skills/resume/REFERENCE.md`; the ceremony it carried (15+ numbered docs per feature, kept in sync by
hand) is gone.

## What a fresh clone needs

- **Nothing for this plugin.** `.claude-plugin/marketplace.json` at the repo root lists it from
  `./plugins/builder`, and `.claude/settings.json` enables `builder@makeready` — Claude Code loads the
  checked-out version live, so the branch you have checked out is the pipeline you run.
- **`superpowers` (external, installed once per machine).** `/builder:build` executes plans through
  `superpowers:subagent-driven-development` and `/builder:plan` composes them with
  `superpowers:writing-plans`. The project enables `superpowers@claude-plugins-official`, but an
  externally sourced plugin is not auto-installed:

  ```
  claude plugin install superpowers@claude-plugins-official --scope project
  ```

  Tested against superpowers 6.3.0 (`skills/build/CONSTRAINTS.md`).

## Layout

`skills/<name>/SKILL.md` — one per command. `skills/resume/REFERENCE.md` is the family's single fact
sheet; `SCOPE-SELECTION.md` and `SURFACE-CHECK.md` beside it are the prototype-mode procedures.
`skills/build/CONSTRAINTS.md` is the MakeReady constraints block pasted into every implementer and
reviewer brief.

## The four scripts it shells out to

They live in `.claude/scripts/` (outside the plugin, because they are repo facts):

| Script | What it does |
|---|---|
| `list-feature-specs.mjs` | enumerates `docs/features/` with each feature's state and next command — the picker's data source. Recognises the pre-builder numbered suite and flags it for conversion |
| `list-ui2-refs.mjs` | resolves a `--ui2 <ref>` (a `C-###`, a registry name, a screen id, or a comma list) against `docs/ui2/design-system/registry.md` and `docs/ui2/screens/`, reporting each row's contract, fixture, preview and whether it is built |
| `check-flow-obligations.mjs` | the cross-section gate on a `SPEC.md`: every `N#` disposed, every DDL-implying `T#` carrying its `SC#`, every `SC#` REMOVE with a named decider, **every app present in §Apps with a section when in scope, and every §Contract row naming a consumer** |
| `build-spec-workspace.sh` | prints and ensures the git-ignored SDD workspace for one feature |

## What this pipeline does NOT own

- **The UI 2.0 design system.** `docs/ui2/`, `capture/fixtures/ui2/` and
  `iphone/MakeReady/UI2Preview/` belong to `/ui2-*` and `/d2m-*`. This family **reads** a contract as
  requirements (`--ui2 <ref>`) and **routes** any gap to the command that owns it. It never writes a
  contract, a registry row, a token or a note.
- **monday.com.** `--ticket <id>` records the key and reads the dossier at
  `docs/monday/tickets/<id>.md` as design input. Reporting a fix back is `/monday-resolve`, explicitly.
- **Deploys.** `/deploy` is always the user's own command.
- **iPhone commits, simulator launches and archives.** Explicit user calls at every size, under every
  flag — an iPhone build that reaches TestFlight cannot be hot-fixed.
