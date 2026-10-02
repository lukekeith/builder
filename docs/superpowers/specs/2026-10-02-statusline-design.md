# `/builder:statusline` — live progress of running builder work in Claude Code's status line

Date: 2026-10-02 · Release: 4.4.0 (minor — a new skill)

## Intent

While builder is doing long work — a fleet, a build in the chat, a gate suite — the user wants to see
its progress in real time without asking. Claude Code's status line is the only fixed, live region a
terminal session has (it renders in the footer, below the input, and re-runs on a `refreshInterval`
timer). A plugin cannot set `statusLine` itself, so builder ships the renderer and a toggle skill that
writes the user's setting, keeps their existing status line working, and puts it back on `off`.

Success: with it on, a running fleet, an in-chat build and a running gate each appear on their own
line under the user's existing status line, updating every ~2 s, and the line vanishes when nothing
runs. Turning it off restores the settings byte-for-byte in the `statusLine` key.

## Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | Track fleet, in-chat builds and gate runs | Each is minutes long and checked on by hand today; each is one small file | Fleet only — builds and gates stay invisible; fleet + builds — a 5-minute deep gate is the thing you most want to see ticking |
| D2 | Builder's output is its own line **below** the wrapped status line | The wrapped line (GSD's today) is untouched; builder gets full width; no extra row when idle | Above — further from the existing line's habit; appended — truncates on narrow terminals |
| D3 | Writes the **user** settings (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`) | One toggle covers every repo; blank where there's no builder work; a project setting would override the user's line per repo | Project `settings.local.json`; a `--project` flag (YAGNI) |
| D4 | A **stable launcher** copied to `<config>/builder/statusline.mjs` resolves the current builder copy on every tick | Survives `claude plugin update`, `/update-local` and `/builder:update` alike with no extra step | Pointing the setting at the versioned install path and rewriting it in `/builder:update` (breaks on any other update path); a SessionStart hook that rewrites settings every session |
| D5 | `gate.mjs` writes a running marker | Without it an in-chat gate run leaves nothing on disk until it ends, so D1's "gates" would only ever mean fleet jobs | Showing only `job.mjs` jobs |

## Components

### `skills/statusline/SKILL.md` — the toggle

`/builder:statusline [on|off|status] [--help]`. Bare → `off` when builder's statusLine is installed,
else `on`. Runs `node <plugin>/scripts/statusline-install.mjs <verb>` and relays its output. After `on`
or `off`: says the change takes effect on the next refresh (no restart needed). Included in vendored
copies (vendor copies `skills/` and `scripts/`).

### `scripts/statusline-install.mjs` — the only writer of settings

- **Config dir**: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Settings file: `<config>/settings.json`.
  State: `<config>/builder/` — `statusline.mjs` (the launcher) and `statusline.prev.json`.
- **Builder's setting** is recognised by its command containing `<config>/builder/statusline.mjs`.
- **`on`**: copy `scripts/statusline-launcher.mjs` → `<config>/builder/statusline.mjs` (overwrite —
  this is also how the launcher itself is upgraded). If the current `statusLine` is not builder's,
  write it verbatim to `statusline.prev.json` as `{ "statusLine": <value or null> }`. Then set
  `statusLine` to `{ "type": "command", "command": "node \"<launcher>\"", "refreshInterval": 2 }`,
  preserving every other key and the file's 2-space JSON formatting. Already on → re-copies the
  launcher, leaves `prev` alone, reports "already on".
- **`off`**: current `statusLine` not builder's → refuse ("the status line isn't builder's — left
  alone"), exit 1. Else restore `prev.statusLine` (delete the key when it is `null`), delete `prev`.
  The launcher file stays (harmless; `on` overwrites it).
- **`status`**: on/off; the wrapped command from `prev`; which builder copy the launcher resolves
  for the cwd; one rendered sample of builder's line for the cwd's repo (or "idle").
- Settings written atomically (temp file + rename). Unparseable settings → refuse, change nothing.

### `scripts/statusline-launcher.mjs` — copied out, kept tiny and stable

Must not depend on anything else in the plugin: it outlives versions.

1. Read stdin (the status line JSON). `cwd` = `workspace.current_dir` ?? `cwd` ?? `process.cwd()`.
2. **Wrapped line**: if `prev.statusLine.command` exists, run it with the same stdin through `sh -c`,
   1000 ms timeout; take its stdout (trailing newline trimmed). Failure or timeout → nothing.
3. **Resolve builder** for `cwd`, first hit wins:
   1. a vendored copy: walk up from `cwd` to the repo root; its `.claude-plugin/marketplace.json`
      entry named `builder` → `<root>/<source>/scripts/statusline.mjs`;
   2. `<config>/plugins/installed_plugins.json`: a `builder@*` entry with `scope: project` and
      `projectPath` == that root, else `scope: user` — whose `installPath` holds
      `scripts/statusline.mjs`.
4. Run it as `node <renderer> --cwd <cwd>`, 500 ms timeout; its stdout is builder's line.
5. Print the wrapped output, then builder's line on a new line when non-empty. Any exception → print
   whatever was gathered. Never prints an error, never exits non-zero.

### `scripts/statusline.mjs` — the renderer

`node statusline.mjs --cwd <dir> [--width <n>] [--now <ms>]` (`--now` for tests). Prints one line or
nothing.

- **Repo root**: walk up from `--cwd` to the dir with `.git`. When `.git` is a **file** (a worktree),
  follow `gitdir:` to `<main>/.git/worktrees/<name>` and take `<main>`. No git process is spawned.
- **Registry**: `loadConfig(<main>)` from `config.mjs`; `ok: false` (no config) → print nothing.
  Otherwise `registry` (default `docs/features`).
- **Fleet**: `<main>/.builder/fleet/lock` holds a pid that is alive → fleet is running. From
  `fleet.json`: `done` = features with `status: done`, `total` = all features. Each non-done feature →
  `readProgress(worktree ?? main, registry, feature, status)` → `<name> <progressBar(pct)> <label>`;
  `status` `parked`/`failed` → `⛔ <name>`; `queued`/`waiting` → counted, not listed. Segment: `⚙ fleet <done>/<total>` then the features. Lock
  missing or pid dead → no fleet segment, even if `fleet.json` has rows.
- **In-chat builds**: each `<main>/.builder/<feature>/progress.md` modified within 5 min whose
  `<registry>/<feature>/MANIFEST.md` state is `planned` or `building` and that isn't a running fleet
  feature → `<feature> build <done>/<total>` (via `featureProgress`).
- **Gates**: `<root>/.builder/gates/running.json` with a live pid → `gate <sets> ⏱ <elapsed>`; each
  `<root>/.builder/jobs/<name>.pid` with no `.exit` and a live pid → `job <name> ⏱ <elapsed>`. Checked
  in the main root and in each running fleet feature's worktree. Elapsed as `45s`, `3m`, `1h12m`.
- **Line**: segments joined by ` · ` in the order fleet, builds, gates. Width = `--width` ??
  `$COLUMNS` ?? 120. Over width → drop whole trailing items and append ` +<n> more`.
- **Budget**: only `existsSync`/`readFileSync`/`statSync` on known paths; no directory walk beyond
  `.builder/` and `.builder/jobs/` listings. Any throw → print nothing, exit 0.

### `scripts/gate.mjs` — running marker (D5)

When it is about to **run** (not quote) any set: write `<root>/.builder/gates/running.json` =
`{ "sets": "<app names or deep>", "pid": <process.pid>, "startedAt": <ISO> }`, and remove it in a
`process.on('exit')` handler. A stale marker (dead pid) is ignored by the renderer and overwritten by
the next run.

## Error handling

The renderer and launcher fail silent; the installer fails loud. A broken builder never costs the user
their existing status line: the wrapped command runs first and its output is printed whatever builder
does.

## Testing — `scripts/test/statusline.test.mjs`

Uses a temp `CLAUDE_CONFIG_DIR` and fixture repos; no real settings touched.

- **Installer**: on → off restores `statusLine` exactly (with a prior line, and with none → key
  removed); on twice keeps the original `prev`; off when the line was replaced by something else →
  refuses, file unchanged; other settings keys preserved; unparseable settings → refuses.
- **Renderer**: idle repo → empty; fleet with a live lock pid (the test's own pid) → segment with
  `done/total` and bars; dead pid → empty; in-chat ledger fresh → `build N/M`, stale (>5 min via
  `--now`) → empty; running gate marker and job → `⏱`; width overflow → `+N more`; `--cwd` inside a
  worktree (`.git` file) → reads the main root's fleet.
- **Launcher**: wrapped command that hangs → builder's line still printed within budget; wrapped
  command failing → builder's line only; no resolvable builder → wrapped output only; vendored copy
  preferred over the user install.
- **gate.mjs**: the marker exists during a run and is gone after it.

## Docs and release

- `skills/help/SKILL.md` card: one line for `/builder:statusline`.
- README: a short "Live progress in the status line" section.
- CHANGELOG `## 4.4.0`, `plugin.json` 4.4.0.

## Out of scope

Progress for steps that write nothing while running (a brainstorm, an audit in the chat); per-project
settings; colour themes.
