# Brainstorm and intake conversations

`$builder brainstorm <idea>` explicitly enters exploration. A plain idea follows the same path. `$builder intake <brief>` verifies an already worked-out source instead of restarting its decisions. `$builder spec <feature>` consumes the settled record. Support `--auto`, `--ticket <id>` (metadata only), and `--path <feature-folder>` for resuming; resolve the path through the existing lifecycle identity, never invent a target branch. `--help` explains these modes without starting work. Unsupported Claude flags must be explained rather than silently treated as idea text.

## Ground before playback

After a brief progress update, search every system term in the user's input with rg, including labels and identifier spelling variants. Read the relevant schema, route, UI, specs and tests. Follow writes, reads and dependent consumers only for terms that matter to the proposed change. Consult history or a focused investigator only if the fast search leaves ambiguity. State what each term refers to with evidence; ask between named candidates if several remain. Facts about the current code are lookups, not questions for the user. Explain current behavior in plain words and name existing abstractions to reuse.

## Durable record

Follow SKILL.md's worktree rule before any repository write. Store brainstorm.md in the returned featurePath alongside continue.md and ledger.md; unlike Claude, this port isolates every size and does not keep a separate ignored conversation workspace. Rewrite the record after each answered round and before an unfinished turn:

```markdown
# <feature> — brainstorm
status: exploring
source: brainstorm
input: <idea, or intake source path/URL/pasted>
updated: <ISO timestamp>
settled: <n> of <m>

## Intent
Outcome, audience, success; preserve the user's key rules in their words.
List assumptions separately.

## How it works today
Plain explanation, reuse opportunities and evidence.

## Tree
| ID | Decision or claim | Depends on | Status | Ruling | Who / date | Why | Rejected and why | Evidence |
|---|---|---|---|---|---|---|---|---|

## Approaches
Chosen approach and tradeoffs; rejected alternatives and reasons.

## Next
Ready questions, pending lookups, next action; size only after scope is settled.
```

Use `open`, `settled`, and `assumed` for brainstorm rows. For intake, classify source rows as decisions, requirements, constraints, non-goals or factual claims, then mark checked claims `confirmed`, `contradicted`, or `unverifiable` with evidence. Read the actual source before attributing claims to it. Preserve its settled choices; ask only about contradictions and consequential gaps. A document's desired behavior is not contradicted merely because it is not implemented yet.

## Rounds and confirmation

Ask ready consequential questions with context, a recommendation and tradeoffs; dependent questions wait until prerequisites are settled. Bundle short independent choices when useful, respecting the available question tool's limits. Continue independent lookups while waiting. Record every ruling's reason, every rejected alternative's reason, and who decided. Present 2–3 approaches only for a real architectural fork, including what each makes harder later.

When scope is settled, summarize intent, approach, decisions and remaining assumptions. A brainstorm-only request ends at shared understanding; it never authorizes implementation. If building was already requested, continue to spec without another routine approval. If intent was only exploratory, let the user choose building, parking the idea, or ending at understanding. `--auto` permits reversible choices within the requested scope and records recommendations as auto rulings; it does not turn a brainstorm-only request into a build request.

Record `confirmed`, `parked`, or `handed-off` as appropriate. Size the settled concept using discovery.md, preserving this port's short spec and plan even for xs/sm. Never overwrite an existing conversation, live spec or archived feature with a new idea: resume the record, handle the change as a revision, or use a new name.

On resume, read the record and actual Git state: exploring resumes ready questions; confirmed proceeds only within prior authorization; parked rechecks the cause; handed-off with a live spec routes to revision or the current build phase. Show settled/open counts and the concrete `$builder resume <feature>` action at an unfinished handoff. Explain-on-request and corrections update the record without discarding unaffected rulings.
