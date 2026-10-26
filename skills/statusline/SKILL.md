---
name: statusline
description: Turns builder's live progress bar in the Claude Code status line on or off. Use when the user asks for a builder progress bar or status line, or to turn it off.
---

# `/builder:statusline` — live progress in your status line

Invocation: **`/builder:statusline [--on|--off|--status]`**. `--help` prints this line and stops.
With no argument it turns it **on** (or, when already on, refreshes the launcher) — it never turns
it off; that takes `--off`.

Run, from this skill's base directory (two levels up is the plugin root):

```bash
node "<base directory>/../../scripts/statusline-install.mjs" <--on|--off|--status, or nothing for --on>
```

Print its output verbatim. Then:

- **on** → it shows from the next refresh (about 2 seconds) in every open session, no restart, and
  stays on across restarts until `--off`. Say what it tracks: a
  running fleet, a build in the chat while its ledger moved in the last 5 minutes, running gates and
  jobs, as `builder` with one bar of overall progress after their own status line — and that the
  segment reads `builder ░░░░░░░░░░ idle` while nothing runs.
- **off** → their previous status line is back as it was.
- **A refusal** (`isn't builder's`, invalid settings JSON) → relay it; never edit settings.json by
  hand to get around it.

It writes only the `statusLine` key of the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`). A project's own `statusLine` setting overrides it in that project.
