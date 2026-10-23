# Approvals you can see — the review, in the CLI — design

> 2026-10-23 · builder 4.13.0 (proposed) · status: from the owner's direction

## Why

> "nobody is going to actually open that file and review, users expect to see a summary of the plan
> in a way they can easily understand directly in the CLI. If there are too many things to fit on
> the screen at once, then just split it in sections and ask the user if it looks right. … We want
> approval, but not a blind approval where the user is expected to read a file. … what is being
> approved, what's being added, what's changing, what's being removed, how it impacts users, key
> ui/ux changes, schema changes, and anything else that might need to be summarized."
>
> "Brief approval requests with no explanation or summarization of what's being approved is not
> acceptable."

Today the design approval at the end of `/builder:spec` is two to four sentences and a footer
pointing at `SPEC.md`. The plan go-ahead shows the slices but not what they build; audit doesn't
say what it changed in the design. (4.10.1 removed section-by-section approvals of the spec's own
format — "§Apps: right?" — because nobody can judge a format. This is the opposite: sections about
impact, in plain words, which is what a person can judge.)

## Decisions

- **D1 — One review format, shared.** REFERENCE §The review defines it; every approval point uses
  it at the depth it needs. A file path is a reference line under the review, never the thing
  approved.
- **D2 — The sections**, each present only when it has content, each in plain words with concrete
  names from the product (screens, commands, fields), never spec jargon:
  1. **What changes for users** — before → after, from the user's side; who is affected.
  2. **What they'll see** — UI/UX changes per screen or command; an ASCII sketch when a layout
     changes.
  3. **Added · Changed · Removed** — three short lists: screens, endpoints, commands, behaviours.
  4. **Data** — every schema change in plain words: what is stored, what happens to existing data,
     whether a migration runs and whether it can be undone.
  5. **Apps** — what changes in each app; a released app (mobile) and what its users see before
     they update.
  6. **Decisions** — each choice settled, one line, with what lost; the ones assumed rather than
     asked marked so a wrong one stands out.
  7. **Risks and open questions** — what could go wrong, what is still open, with the
     recommendation.
  8. **Not included** — what is out of scope, so nobody assumes it is.
  9. **How it gets built and tested** — at the go-ahead only: the slices and the test plan (4.12.0).
- **D3 — Screen-sized parts.** A review that fits in ~40 lines is shown whole. Longer → split into
  parts (*Part 1 of 3 — What users get* · *Part 2 — Data and apps* · *Part 3 — Decisions and
  risks*), each ending in the lettered ways on: `A. Looks right — next part` · `B. Change
  something — say what`. The last part ends with the step's own ways on. A change at any part is
  applied and that part re-shown.
- **D4 — Where it is used:**
  | Step | The review shown |
  |---|---|
  | brainstorm / intake §Confirm | sections 1, 2, 3, 6, 7, 8 from the record — the shared understanding |
  | small path (sm) and quick path (sm) | 1–3 and 4 if any, compact — one part |
  | **spec, end — the design approval** | **the full review, 1–8, in parts** |
  | audit, end | what the audit changed in the design, as a review delta: each section that changed, before → after; nothing changed → one line saying so |
  | plan go-ahead | a one-part recap (1, 3, 4) + section 9 (slices and test plan) + anything the audit changed since the design was approved |
  | revise | the change as a review delta |
  | ship, Open the PR | the PR body shown before asking |
  | agent / fleet confirmation | per feature: one line of 1 and its test plan |
  | the 🔒 walk hand-off after an `--auto` run · the fleet's report | the full review of what was built, from `SPEC.md`, 1–8, in parts |
- **D5 — `--auto` / `--agent-walk` print no review where no approval is asked.** (Revised
  2026-10-23 from timing data: orchestrator time is dominated by output tokens, ~7.5 ms/token, so a
  review nobody reads costs minutes per unattended run.) Spec, audit, plan and revise — and §Confirm
  and the small path — say in one line what they did and how many `auto (recommended)` rulings they
  took. The review is shown **where the human next looks**: the 🔒 walk hand-off of an `--auto` run
  (resume §🔒 The walk) and the fleet's report (fleet §5) open with the full review of what was built,
  written from `SPEC.md`, every auto ruling marked `(auto)` — so nothing lands unseen. The headless
  agent walk prints none.
- **D6 — Release: a minor (4.13.0)** — every approval changes what it shows.
