---
name: version
description: Which builder this session is running, and whether it is the newest — the version this session loaded, where it came from (a plugin install, or a copy vendored into the repo), what is installed on this machine, the newest release this machine knows about, and any fleet in this repo still running an older one — ending in the one step that brings it current (/reload-plugins, /builder:update or /builder:vendor). Read-only and fast; never fetches. Use when the user asks what version of builder they are on, whether a session or a repo is current, or whether builder needs updating.
---

# `/builder:version` — what this session runs, and whether it's the newest

Invocation: **`/builder:version`**. `--help` prints this line and stops.

**Read-only.** It changes nothing and fetches nothing.

## 1. Run it

The one fact only this session has is **which copy of builder it loaded** — a session keeps the
version it loaded until `/reload-plugins` or a restart, even after a newer one is installed beside
it. That copy is this skill's own base directory (given when the skill loaded, as "Base directory for
this skill"), two levels up. Pass that path — never `$CLAUDE_PLUGIN_ROOT` or a folder found by
listing, which say what is on disk, not what this session is running:

```bash
node "<base directory>/../../scripts/version.mjs" --root "<base directory>/../.."
```

## 2. Show it

Print the output **verbatim**, in a code block. Its last line is the verdict — `✅ up to date` or
`⬆️` with the one step to take. Add nothing unless asked; a bare "go" in reply runs that step
(REFERENCE §Continuing on "go") — `/reload-plugins` is the user's to type, so for that one say so.

~~~
📍 builder <loaded>: <✅ up to date | the ⬆️ step>
~~~
