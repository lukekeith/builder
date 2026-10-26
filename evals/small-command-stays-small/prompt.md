---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, AskUserQuestion]
---

/builder:brainstorm --auto add `notes edit <id> <text>`: it replaces a note's text, keeps its id, and prints `edited <id>`; an unknown id fails like `show` does.
