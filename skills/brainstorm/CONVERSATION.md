# The design conversation — shared by `/builder:brainstorm` and `/builder:intake`

Both skills run the same conversation machinery and write the same record; they differ in where the
tree comes from (brainstorm: the user's intent; intake: a document's claims). This file is that
machinery (intake's claims are grounded the same way — §Grounding). It is short on purpose: nothing here loads REFERENCE wholesale — the conversation comes first, and
the spec formats belong to `/builder:spec`.

## The record

`.builder/<feature>/brainstorm.md` (`<builder>/scripts/workspace <feature>` prints the directory).
**Rewrite it after every answer** — it is how a long conversation survives `/clear`, and it is the only
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
date* says who ruled it and when: the user and the date, `(assumed at brainstorm)`,
`auto (recommended) YYYY-MM-DD`, or — for an intake row the code confirmed — the `input:` source and
the date it was confirmed. Intake starts each Branch cell with the row's kind — `decision`,
`requirement`, `constraint`, `non-goal` or `claim` — which is how `/builder:spec` tells a document's
choices (rulings) from its statements about the code (facts).

**Tree statuses:** `open` (no answer yet) · `settled` (the user ruled) · `assumed` (recon answered it;
stated to the user, not yet contested) · `stated` (intake: the document says so, not yet checked) ·
`confirmed` (intake: the code agrees — evidence required) · `contradicted` (intake: the code does
something else — evidence required) · `unverifiable` (needs running code or a person).

**Resuming a record** (`--path`): `exploring` or `parked` → say what is settled and what is open,
then the next question; `confirmed` → §Confirm's three ways on (a revision conversation: straight to its
hand-off); `sized xs|sm` → §Size and the small path, from where the working tree shows it
stopped; `sized md|lg|xl` → `/builder:spec --path <folder>`; `handed-off` with no live SPEC,
MANIFEST or PROGRAM → nothing to resume — say where the work went (built in chat, stopped at
understanding, or a spec committed on another branch) and offer a new name for new work; with one →
a new revision (brainstorm's §Where to start step 4).

🔴 **Every settled row keeps its Why, and every rejected option its reason.** `/builder:spec` writes
§Idea and the §Decisions rows from these columns; a row without them becomes a thin spec.

## Grounding

A question is the last resort — and a lookup is cheap, so it comes first. Before the first playback,
and before any question enters a round, look the user's terms up **yourself, inline, one rung at a
time**, stopping at the first rung that answers it:

1. **The fast pass — seconds, every term.** One `git grep` over the repo for every spelling of every
   term at once — case-insensitive, separators optional, so `issue date`, `issue_date`, `issueDate`,
   `IssueDate`, `ISSUE_DATE` and `issue-date` are one pattern:
   `git grep -n -i -E 'issue[ _-]?date|owner[ _-]?view' -- ':!*.lock' | head -60`. Read the hits that
   decide it — the schema line, the label, the route. The user's word is often the *label*, not the
   identifier. One clear meaning → done, and most terms end here.
2. **Follow it — a minute, only the terms that matter to the change.** Where the value is written and
   every place it is read (grep the identifier the fast pass found), the features and screens using it
   (the registry's specs, live and `_archive/`), and when it arrived (`git log -S <identifier>
   --oneline | head`). Enough to say what a change to it would ripple into — a report, an export, a
   released client, existing rows.
3. **Dig — only when 1 and 2 left a term unclear.** Nothing matched, or matches that don't explain
   it: an Explore agent (`sonnet`) searches wider — synonyms, the domain behind the word, docs,
   tests. Only the branches that hang on that term wait for it; the rest of the conversation goes on.

**Then, and only then, ask — and only what the code cannot answer:**

- **One clear meaning** → state it with its evidence and carry on (`assumed`, listed at §Confirm).
- **Several candidates** → ask with them as the options — `Certificate.issue_date` (the PDF header)
  (Recommended) · `Invoice.issuedAt` (billing) — in §Rounds' format. Never an open "what do you mean
  by …".
- **Nothing, after rung 3** → say where you looked, then ask.
- **A choice about what the product *should* do** — intent, priority, taste, a rule the code doesn't
  encode yet — is the user's, and is always a question.

🔴 **The self-check before every question:** a question that uses one of the user's terms you have not
located in the code, or asks for a fact about how the system works today, is not ready — it goes back
up the ladder. Asking the user to define a word that is in their own codebase is the failure this
section exists to stop.

## Rounds

- **The frontier** is every `open` branch whose prerequisites are settled. A question whose answer
  depends on another still-open question waits until that one is answered.
- **🔴 One question per turn, by default** — the frontier question that unblocks the most of the
  tree goes first. Every question has two parts, in this order:

  1. **The briefing, in chat** — a short heading naming the decision, then what a person needs to
     choose or to write their own answer:

     ```
     **Q<n> of ~<m> — <the decision, in a few words>**

     <The question in one plain sentence.>

     **Why it matters:** <what depends on it; what goes wrong if it's decided badly or not at all>
     **What it affects:** <the screens, data, apps, users or later decisions it touches — concrete names from the code>
     **Recommendation:** <the option and why — the evidence behind it, and what it costs you>
     ```

  2. **The choice — one AskUserQuestion**, straight after the briefing: `question` restates it in
     one line; 2–4 options, **your recommendation first with ` (Recommended)` on its label**; each
     label a concrete answer of 1–5 words (never "Option A", never a restated question); each
     description says **what picking it does** — what gets built or changes, and what it makes
     better or worse. The tool adds *Other* for a custom answer, so never add a "something else"
     option. Options that differ in shape (a layout, a data shape, a message's wording) carry a
     `preview`.

  Every option must be a real, defensible answer the user could pick — never a filler to reach two.
  A question with only one defensible answer is not a question: state it as `assumed` (below). A
  question whose answer is free text (a name, a message's wording) still gets options: your drafted
  answer (Recommended), one or two real alternatives, and *Other* for theirs.
- **Several at once, only when they are independent and quick** — two to four closed choices with no
  answer depending on another (which apps, a name, yes/no on a guard). Then send **one briefing per
  question** as above (shortened to a line each for *Why* and *Affects*), followed by **one
  AskUserQuestion carrying all of them** as separate questions — each with its own `header`, options
  and `(Recommended)` label, never a numbered prose list with the answers written inline. Any question
  with real trade-offs to weigh is asked alone.
- **Facts are never the user's job** (§Grounding). A question the code can answer goes up the
  ladder — your own fast grep first, an Explore agent (`sonnet`) only for what that leaves unclear;
  only the branches downstream of a lookup still running wait — ask the next frontier question now,
  and record the lookup under *Waiting on facts*.
- **Say what recon settled, never decide it silently**: `Assumed B5: reuse Toaster — AppShell already
  mounts it (app/shell.tsx:40). Say if not.` An assumption the user doesn't contest stays `assumed`
  and is listed again at §Confirm.
- **After each answer** record the ruling with its Why and the options it rejected (and why), recompute
  the frontier, rewrite the record, and open the next question with one line of progress:
  `8 of 12 settled — 3 open, 1 waiting on a lookup.`
- **"Explain X" at any point** — "how does X work", "what would this touch", "show me the data flow" —
  dispatches a sub-agent, and the answer comes back in plain words (a diagram when parts move),
  recorded under *Explained on request*. It is never refused as off-topic: understanding the system
  is part of the work.

## Approaches

Only when the tree holds a real fork — two or more viable designs that shape the rest of the tree.
Present 2–3, the recommendation first: what each is, its trade-offs, and **what it makes harder
later** — as §Rounds' briefing, then one AskUserQuestion with each approach as an option (the
recommendation first and marked, a `preview` sketching each). The chosen one becomes a settled branch; the others go to *Rejected* with the reason each
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
overrides. Record it: `status: sized <size>`.

**Splitting (lg and xl) is one question, and "one spec" is always an option.** Before anything else
for lg or xl, one AskUserQuestion — §Rounds' format — whose options are:
- **One spec** — the whole confirmed concept as one lg spec (for xl, say what it costs: one long walk).
- **<n> value-sized specs** — each named with what the user can do once it alone ships (REFERENCE
  §The classifier rule 4); never a split by layer, and only when at least two such slices exist.
- Optionally one other real cut (a different value line), never a finer split of the same layers.
Recommend the fewest specs whose each slice ships value — usually one or two. The answer decides
the size: one spec → lg; two or more → xl, its children those slices.

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
recs" (settle every open branch on its recommendation, recorded as the user's ruling), "that's enough"
(jump to §Confirm, listing what is still open as assumed).

**Under `--auto`**: play the intent back as `(assumed)`; every question settles on its recommendation (no AskUserQuestion),
each recorded with `auto (recommended) YYYY-MM-DD` as its Who / date; the recommended approach is
chosen; §Confirm proceeds without waiting and takes **Build it**. §Size takes the splitting
question's recommendation — the fewest specs whose each slice ships value — recorded the same way. xs and sm take
the one approval as the recommendation, recorded the same way. md and above run
`/builder:spec --path <registry>/<feature> --auto` in the same turn. The human reads the assumptions
and every auto ruling at the go-ahead.
