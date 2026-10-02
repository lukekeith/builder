---
name: statusline
description: Turn builder's live status line on or off — a `builder` progress bar and what builder is running right now (fleet features, a build in the chat, running gates and jobs) at the end of your existing Claude Code status line, an empty bar marked idle when nothing runs. Writes the statusLine key of your user settings, keeps your previous status line showing in front of it, and puts it back exactly on off. Use when the user asks for live progress, a progress bar or a status line for builder, or to turn it off.
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
