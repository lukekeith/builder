---
type: llm
---
The reply is a quick-path proposal for a small change, made in this first turn. It must:
- say it is a small change and name the real code it touches (the `list` case in `src/cli.mjs`, or the notes array it reads);
- say what changes for the user in plain words (newest note first in `notes list`);
- end with a short lettered list where one option builds it now, recommended, and replying "go" picks that option.
It must not ask a series of questions, play back the request at length, or start editing files before the user says yes.
