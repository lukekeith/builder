---
name: statusline
description: Turn builder's live status line on or off — a line under your existing Claude Code status line showing what builder is running right now (fleet features with progress, a build in the chat, running gates and jobs), blank when nothing runs. Writes the statusLine key of your user settings, keeps your previous status line showing above it, and puts it back exactly on off. Use when the user asks for live progress, a progress bar or a status line for builder, or to turn it off.
---

# `/builder:statusline` — live progress under your status line

Invocation: **`/builder:statusline [on|off|status]`**. `--help` prints this line and stops. With no
argument it toggles.

Run, from this skill's base directory (two levels up is the plugin root):

```bash
node "<base directory>/../../scripts/statusline-install.mjs" <on|off|status, or nothing to toggle>
```

Print its output verbatim. Then:

- **on** → it shows from the next refresh (about 2 seconds), no restart. Say what it tracks: a
  running fleet, a build in the chat while its ledger moved in the last 5 minutes, running gates and
  jobs — and that the line is blank while nothing runs.
- **off** → their previous status line is back as it was.
- **A refusal** (`isn't builder's`, invalid settings JSON) → relay it; never edit settings.json by
  hand to get around it.

It writes only the `statusLine` key of the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json`). A project's own `statusLine` setting overrides it in that project.
