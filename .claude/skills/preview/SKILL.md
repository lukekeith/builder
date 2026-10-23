---
name: preview
description: Local to the builder repo (not part of the release) — open the builder response preview in the browser: what each /builder:* step prints, path by path, from preview/. Starts its server if it isn't running, then reports which stages no longer match their skill. Use when the user asks to preview, view or open builder's responses, the preview page, or "/preview"; with "check" just lists the stale stages.
---

# `/preview` — open the builder response preview

1. **`check` as the argument** → run `node preview/preview.mjs --check` and show its output verbatim;
   stop.
2. **Start or reuse the server** — run `node preview/preview.mjs --open` with `run_in_background:
   true` (it keeps serving across turns; when one is already on port 4848 it opens the browser on
   that one and exits). Wait for its first line, `builder response preview → http://localhost:4848`
   or `… already running → …`, by reading the task output — never a foreground `sleep`.
3. **Then** run `node preview/preview.mjs --check` and end with one line: the URL, and either
   "all stages match their skills" or the count of stale / unstamped / broken stages with the
   command to see them (`/preview check`) and to refresh one (`preview/README.md` § Keeping it
   current).

The page re-reads the stage files on every reload, so after editing `preview/stages/*.json` or a
skill, a browser refresh is enough — no restart.
