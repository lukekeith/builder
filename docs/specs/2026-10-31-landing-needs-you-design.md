# A landing that can't finish asks — never a silent stop — design

**Status:** approved by the owner in conversation (the three-choice design) · **Date:** 2026-10-31 · **Branch:** `feat/verifier`

## Why

A real fleet run (a consuming project, builder 5.5.0) built, walked and agent-signed-off a feature in
32 minutes, then the landing merge into `main` was refused: the owner had uncommitted changes in four
files the feature also changes. The fleet parked and exited. The status line read
`⛔ new-proposal-flow: shipped, but merging into ma…` — cut mid-reason — nothing in the chat explained
it, and the branch's last commit already said "shipped into main". The owner had to ask what happened.

6.0 behaves the same way in different words: the verifier's release refuses the fast-forward and the
fleet parks with `the merge tier passed but landing failed: <reason> — next: /builder:fleet to retry`
(`scripts/fleet.mjs` landing, `scripts/verify/verify.mjs` release exit 1) — no files, no explanation, no
offer to do anything.

The owner's rule: builder never stops without telling the user what happened and offering a way forward
— it acts when it safely can, otherwise it asks, with options. It never touches the user's uncommitted
work without an answer.

## Decisions

- **D1. Catch it early.** When a feature is ready to land, and once when a fleet starts, the fleet checks
  the target checkout for uncommitted changes (tracked, staged or unstaged; untracked files only when the
  feature adds the same path) that overlap the files the feature changes against the target. Changes that
  do not overlap are not a block — git merges around them — and are not mentioned.
- **D2. An overlap parks as "needs you", with the evidence.** The park reason is
  `needs you: your uncommitted changes overlap this feature — <n> files: <a>, <b>, …`; PARKED.md lists every
  file, says the work is done and waiting on `<branch>` at `<sha>`, and offers the three choices in D3.
  Landing is retried as soon as the overlap is gone (the next fleet run, or the choice below).
- **D3. Three choices, raised in the next session.** `/builder:fleet:status` (and the session-start brief,
  and `/builder:resume` with no path) shows the park with one picker:
  - **Commit my changes, then land** — builder shows the changed files and a proposed commit message (one
    commit, or split by the user's word), commits only on approval, then lands the feature.
  - **Set my changes aside, land, put them back** — builder stashes the user's changes (named
    `builder: before landing <feature>`), lands, and re-applies them; a conflict on re-apply is reported
    file by file and left for the user, with the stash kept — never dropped, never force-resolved.
  - **Leave it for now** — nothing changes; the park and its reminder stay.
  Builder never commits, stashes or discards the user's uncommitted work without one of these answers.
- **D4. The status line leads with what is needed.** A park that needs the human reads
  `⛔ <feature> needs you: <short why> — /builder:fleet:status`, with the short why chosen so the
  command always fits; the full reason is in status and PARKED.md.
- **D5. Honest landing words.** The ship commit and the manifest say the feature is ready to land on
  `<target>` until the merge commit exists; "shipped into `<target>`" is written only after it does.
- **D6. The general rule, enforced.** Every park whose reason the fleet classes as human-only
  (`HUMAN_STEP`, `scripts/fleet.mjs:1525`) carries a choice the next session raises — a picker with at
  least one option that moves the work forward — and a test fails any human-only park reason that does
  not name one. Other landing refusals (target checked out elsewhere, worktree gone) get the same shape.

## Testing

Unit: overlap detection (tracked, staged, unstaged, untracked-same-path; a non-overlapping dirty file is
not a block); the park reason and PARKED.md carry every file and the three choices; the status line's
`needs you` form always keeps the command within the column budget; the ship commit's wording before and
after the merge. Integration (stub fleet + a real git fixture): a dirty overlapping checkout parks with the
reason and never touches the files; after a stash-and-land, the user's changes are back and the feature
is merged; a re-apply conflict keeps the stash and reports the files. Skill text: `/builder:fleet:status`
offers the picker for a `needs you` park, with the review shown in the CLI (house rule).
