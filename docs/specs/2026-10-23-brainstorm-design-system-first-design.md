# Brainstorm research: design system first, no named product — design

> 2026-10-23 · builder 4.11.3 · status: from the owner's correction

## Why

4.11.1 added outside research to discovery and named one product in the skill — Mobbin's tool ids
as the "community resource". The owner never meant that as part of builder: "the point was to look
at existing plugins the user may have installed that can help with discovery … always start with
what's available and how it should be used before exploring new ideas."

## Decisions

- **D1 — Builder names no product.** What is offered comes from reading the session's own tool list:
  any plugin, MCP server or skill that would help, named by what it is in that session.
- **D2 — The ladder: here → installed → outside.** (1) the project's design system and house
  patterns, and how they should be used for this idea — stated, never asked; (2) the installed
  tools that would help; (3) the web, or a suggested kind of plugin when nothing installed covers
  it. Rung 1 always runs; anything that searches outside the repo needs the user's yes.
- **D3 — The offer is a lettered list** (CONVERSATION §Ways on), not a picker: *Stay with what we
  have* · *Look at <installed tool>* · *Search the web* · *Suggest a plugin*, four at most.
- **D4 — Outside patterns are read through the design system**: each says which existing
  components would build it and what the design system lacks.
- **D5 — The design system reaches past discovery**: a UI change's sm design and *How it works
  today* name the design-system components to use. The record gains `Design system:`.
- **D6 — Release:** a patch (4.11.3).
