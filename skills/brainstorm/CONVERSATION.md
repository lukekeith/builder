# The design conversation — shared by `/builder:brainstorm` and `/builder:intake`

Both skills run the same conversation machinery and write the same record; they differ in where the
tree comes from (brainstorm: the user's intent; intake: a document's claims). This file is that
machinery. It is short on purpose: nothing here loads REFERENCE wholesale — the conversation comes first, and
the spec formats belong to `/builder:spec`.

## The record

`.builder/<feature>/brainstorm.md` (`<builder>/scripts/workspace <feature>` prints the directory).
**Rewrite it after every round** — it is how a long conversation survives `/clear`, and it is the only
thing `/builder:spec` reads. The header is the lines before the first blank line; scripts read only
the header, so keep it exactly this shape:

```markdown
# <feature> — brainstorm
status: exploring | confirmed | sized <xs|sm|md|lg|xl> | parked | handed-off
source: brainstorm | intake
input: abstract idea | directed request | brief | spec <path|url|pasted> | brief <path|url|pasted> | ticket <id> | design ref <ref>
ticket: <id>
updated: <ISO 8601 timestamp>
settled: <n> of <m>
contradicted: <n>

## Intent
Outcome · who it's for · what success looks like — each marked "(assumed)" until the user confirms it.
In your words: "<the user's key rules, verbatim — never paraphrased>"
Assumed (not yet confirmed): …

## How it works today
<plain prose; an ASCII or mermaid diagram when several parts move; file:line only as footnotes>
Explained on request: <topic> — <what was found>

## Tree
| # | Branch | Depends on | Status | Ruling | Who / date | Why | Rejected (and why) | Evidence |
|---|---|---|---|---|---|---|---|---|
Frontier: <branch ids ready to ask>
Waiting on facts: <branch id> — <what a sub-agent is checking>

## Approaches
Chosen: <approach> — <trade-offs> · Rejected: <approach> — <why it lost>

## Size
<size> — evidence: <apps, contract, surfaces, tasks it implies>
```

`contradicted:` is written by intake only; brainstorm omits the line. `ticket:` is optional —
written when the run has `--ticket <id>` or the input is a ticket, omitted otherwise. `input:` names
where the conversation started: brainstorm writes its kind; intake writes the source it verifies —
the file path or URL, or `pasted` — so a resumed intake re-opens that source. A Tree row's *Who /
date* says who ruled it and when: the user and the date, `(assumed at brainstorm)`, or
`auto (recommended) YYYY-MM-DD`. Intake starts each Branch cell with the row's kind — `decision`,
`requirement`, `constraint`, `non-goal` or `claim` — which is how `/builder:spec` tells a document's
choices (rulings) from its statements about the code (facts).

**Tree statuses:** `open` (no answer yet) · `settled` (the user ruled) · `assumed` (recon answered it;
stated to the user, not yet contested) · `stated` (intake: the document says so, not yet checked) ·
`confirmed` (intake: the code agrees — evidence required) · `contradicted` (intake: the code does
something else — evidence required) · `unverifiable` (needs running code or a person).

**Resuming a record** (`--path`): `exploring` or `parked` → say what is settled and what is open,
then the next round; `confirmed` → §Confirm's three ways on (a revision conversation: straight to its
hand-off); `sized xs|sm` → §Size and the small path, from where the working tree shows it
stopped; `sized md|lg|xl` → `/builder:spec --path <folder>`; `handed-off` with no live SPEC,
MANIFEST or PROGRAM → nothing to resume — say where the work went (built in chat, stopped at
understanding, or a spec committed on another branch) and offer a new name for new work; with one →
a new revision (brainstorm's §Where to start step 4).

🔴 **Every settled row keeps its Why, and every rejected option its reason.** `/builder:spec` writes
§Idea and the §Decisions rows from these columns; a row without them becomes a thin spec.

## Rounds

- **Ask the whole frontier each round**: every `open` branch whose prerequisites are settled. A
  question whose answer depends on another question still open this round waits for a later round.
- **Format** — numbered, each with the context a person needs to answer it and a recommendation:

  ```
  ❓ **Q1 — <title>**: <the question, with what makes it matter; several paragraphs if needed>

  ➡️ <your recommendation, and why>
  ```

  A round made only of quick closed choices (which app, yes/no, one of three names) goes through
  AskUserQuestion instead, recommendation first and marked.
- **Facts are never the user's job.** A question the code can answer goes to a sub-agent (Explore,
  `sonnet`); only the branches downstream of that lookup wait — ask the rest of the frontier now, and
  record the lookup under *Waiting on facts*.
- **Say what recon settled, never decide it silently**: `Assumed B5: reuse Toaster — AppShell already
  mounts it (app/shell.tsx:40). Say if not.` An assumption the user doesn't contest stays `assumed`
  and is listed again at §Confirm.
- **After each round** recompute the frontier, rewrite the record, and open the next round with one
  line of progress: `8 of 12 settled — 3 open, 1 waiting on a lookup.`
- **"Explain X" at any point** — "how does X work", "what would this touch", "show me the data flow" —
  dispatches a sub-agent, and the answer comes back in plain words (a diagram when parts move),
  recorded under *Explained on request*. It is never refused as off-topic: understanding the system
  is part of the work.

## Approaches

Only when the tree holds a real fork — two or more viable designs that shape the rest of the tree.
Present 2–3, the recommendation first: what each is, its trade-offs, and **what it makes harder
later**. The chosen one becomes a settled branch; the others go to *Rejected* with the reason each
lost. No fork → no approaches step, and say so in one line.

## Confirm

When the frontier is empty: **"Here's the shared understanding — <intent in two lines>, <the approach>,
<n> decisions, <k> assumptions. Is anything missing or wrong?"** List every `assumed` branch. Nothing
leaves the workspace before a yes; a correction reopens its branch. Set `status: confirmed`, then
offer three ways on:

- **Build it** → §Size and the small path.
- **Park it** → `status: parked`. With `--keep`, also write `<registry>/<feature>/NOTES.md` — a
  one-page summary of Intent, How it works today and the Tree — and commit it
  `docs(<feature>): notes`; `list-features` reads it as analysis, and a later brainstorm resumes from
  the record.
- **Stop at understanding** → set `status: handed-off` and say so: the conversation is complete,
  and the record stays on disk as the reference. Nothing is written to the repo.

## Size and the small path

Size the **confirmed concept**, not the first request: REFERENCE §Sizes and §The classifier are the
rules — read just those two sections. (The conversation reads exactly three REFERENCE sections: §Sizes and §The classifier here, §Walk readiness at the small path's human look.) Announce the size with its evidence; the user confirms or
overrides; lg is offered a split before anything else. Record it: `status: sized <size>`.

- **md · lg · xl** → hand off: `📍 <feature>: concept confirmed (<size>) — next: /builder:spec --path <registry>/<feature> · or say go`.
- **xs · sm** — no spec, no folder:
  1. **Design in chat.** xs: one sentence. sm: the app · approach · files touched · the recipe skills
     it will read · tests · what you will see in the running app.
  2. **One approval.** Stop until yes. Presenting and starting in the same turn skips the gate.
  3. **Implement in the main context.** Read the named recipe skills FIRST (the config's §Companion
     skills); TDD where behaviour changes; that app's §House rules and §Environment landmines.
     🔴 **In an app the config marks `commit: manual`, stage and stop** — that commit is the human's.
  4. **Fast gates** — the subset for that app that the diff can turn red, said out loud (the config's
     §Quality gates). Report a delta where the config asks for one, never a green exit.
  5. **The human's look at the running app** for anything visual — after REFERENCE §Walk readiness.
     Say what has and has not been human-checked; the PR lock holds in chat form.
  6. Set `status: handed-off` and end: `📍 <the work>: <shipped | awaiting your look at the app> — next: <the command>`.

## Steering and --auto

**The user steers at any time**: "go deeper on X" (open sub-branches under X), "skip that, use your
recs" (settle the frontier on the recommendations, recorded as the user's ruling), "that's enough"
(jump to §Confirm, listing what is still open as assumed).

**Under `--auto`**: play the intent back as `(assumed)`; every round settles on its recommendations,
each recorded with `auto (recommended) YYYY-MM-DD` as its Who / date; the recommended approach is
chosen; §Confirm proceeds without waiting and takes **Build it**. §Size accepts the size as classified
— no lg split offer; a split worth making is recorded under *Size* as a recommendation. xs and sm take
the one approval as the recommendation, recorded the same way. md and above run
`/builder:spec --path <registry>/<feature> --auto` in the same turn. The human reads the assumptions
and every auto ruling at the go-ahead.
