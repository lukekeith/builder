# Brainstorm quick path — design

> 2026-10-23 · builder 4.11.2 · status: built from the owner's request (no separate approval round)

## Why

The owner reports that brainstorm is too heavy for the changes people most often make in a chat:
small edits to existing features. Brainstorm takes the prompt and starts the whole conversation —
grounding, an intent playback, how it works today, rounds, confirm, then sizing — and only *after*
all of that does an xs/sm change reach the small path that builds it in chat. The only way out was
to keep answering. "just build it" existed, but it only left discovery and dropped the user into
the rounds.

The owner is fine with brainstorm starting — its grounding is worth having — but a small change
must be buildable without the rest of the ceremony.

**Success:** a request like "make the overdue badge red on the cert list" gets one turn that
shows what the words point to in the code and the proposed change, and one *Build it* builds it.
A user partway through any brainstorm can say "just build it" and be building in that turn if the
work is small. Nothing changes for vague ideas, specs, revisions or `--auto` runs.

## Decisions

- **D1 — The decision point is the first turn, after the fast-pass grounding.** That is the first
  moment there is evidence (the files, the app, whether a schema or route is involved) and the last
  moment before the ceremony starts. Deciding any earlier would be a guess from the wording.
- **D2 — Qualifying reuses the classifier.** REFERENCE §The classifier rules 1–5, read against the
  grounding instead of a settled tree, plus: a directed request or brief only; at most one open
  product choice; never a revision and never `--auto`. Any doubt → no quick path, so the error is
  toward the existing flow, never toward an unexamined build.
- **D3 — One question, and it is the approval.** `A. Build it (recommended)` · `B. Brainstorm it
  first`, as a lettered list (D8). One open product choice turns into several `Build it: <answer>`
  entries instead of a second question. The pick counts as the small path's single approval, so
  there is no second gate.
- **D4 — The record is still written** (`status: sized xs|sm`, `quick path — offered`) so `/clear`
  and resume behave as for any small-path record.
- **D5 — "just build it" leaves the whole conversation.** Open branches take their
  recommendations, sizing runs at once; xs/sm build in that turn; md+ keeps its size (sizes only
  ratchet up) and offers *Write the spec* · *Build it in chat anyway* (the user's override).
- **D6 — `--auto` is untouched**, so `/builder:agent`, the fleet and the benchmark run as before.
- **D7 — Release:** a patch (4.11.2) — an existing skill behaves differently, no new flag.
- **D8 — Ways on are a lettered list** (owner's follow-up: "simple A, B, C style… so the user can
  easily just enter the option they want"). Every brainstorm pause ends with `A. … (recommended)` ·
  `B. …` · `C. …` and "go" is A: the quick path, the playback, the concepts, every round (*Answer
  below* · *Build it now* · *That's enough*), confirm, the small path's approval and the md+
  hand-off. Letters, not numbers, because the question picker numbers its answers and the pipeline
  footers are numbered. Plain chat, not the picker; typed steers still work. The frame's open
  questions are the one exception. Rule: CONVERSATION §Ways on.

## Where it lives

- `skills/brainstorm/SKILL.md` — §Intent step 3 (the quick check), the new §Quick path, the
  name rule, the pause footer.
- `skills/brainstorm/CONVERSATION.md` — §Steering and --auto ("just build it", `--auto`), §The
  record (resuming a quick-path record).
- `skills/help/SKILL.md`, `README.md`, `CHANGELOG.md`, `scripts/test/skills-consistency.test.mjs`.
