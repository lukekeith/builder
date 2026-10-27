---
name: archive
description: Moves finished feature folders out of the registry — shipped, merged but never shipped, abandoned — each kept as its SPEC under a SHIPPED, CLOSED or DROPPED header; one review, one confirmation, one commit. Use when asked to archive, clean up or close finished specs, or a status line names /builder:archive.
---

# `/builder:archive` — the registry holds only work in flight

Invocation: **`/builder:archive [--into <branch>]`**. `--help` prints this line and stops.

Resolve `<builder>` per [REFERENCE](../resume/REFERENCE.md) §The scripts. A finished folder is
noise in `/builder:status` and its PLAN, manifest and ledgers are dead weight; `git log -- <folder>`
keeps every one of them, so the folder keeps only its `SPEC.md` (`PROGRAM.md` for a program) under a
header saying how it ended, in `<registry>/_archive/`. What each header means, when asked:
`node <builder>/scripts/docs.mjs archive` (REFERENCE §Condense and §Before a picker, one call).

## 1. The review

```bash
node <builder>/scripts/archive.mjs plan [--into <branch>]
```

Print it **verbatim, as markdown**: the **Finished** table, the **Old** table, the `Left alone:`
line, the `registry:` line. Each row says what the folder is, what it becomes and when it last moved —
that table is the review; never ask anyone to open a folder to judge it. `registry: clean` → say so
and stop:

~~~
📍 registry: clean — nothing finished outside <registry>/_archive/
~~~

A line saying it is on another branch → relay it, name `git switch <target>`, and stop: merged work is
judged on the target.

## 2. One confirmation

Above the picker, in plain words (REFERENCE §Before a picker):

- **What is being decided** — which of the listed folders leave the registry, in one commit.
- **Your options:**
  - **Archive the finished ones** — every **Finished** row: shipped ones move as they read; a verified
    one gets its `SHIPPED — merged <sha>` header; one merged but never verified is closed
    `CLOSED — not walked` (or `walked, not verified`), never called shipped; leftovers are trimmed.
  - **Those and the old ones** — also every **Old** row: an abandoned feature is closed
    `DROPPED — <reason>` and no longer satisfies a program dependency; a folder with no SPEC (an earlier
    pipeline's docs, notes) moves whole — nothing in it is deleted.
  - **Not now** — nothing changes.
- **Why the recommended one** — the **Finished** rows are already in the target or say they shipped;
  the **Old** ones are a guess from inactivity, so they go only when you say so.

One AskUserQuestion: **Archive the finished ones** (Recommended) · **Those and the old ones** ·
**Not now**. No **Finished** rows → offer **Archive the old ones** · **Not now**. A reply naming
folders ("just m and a", "drop f — superseded by g") archives exactly those; a reason given for one
is its `DROPPED` reason.

## 3. Apply

```bash
node <builder>/scripts/archive.mjs apply <path…> [--into <branch>]
```

The paths are the chosen rows' first column. A folder the owner drops that the plan left as in flight
takes `--drop "<name>=<their reason>"` in the same call — one per dropped folder, so the batch is
still one commit. Print each line it prints; a folder that fails half-way is put back as it was. It refuses — nothing
changed — off the target branch or while the registry has uncommitted changes; relay the line.

## 4. Done

Run `archive.mjs plan --summary` again and end with one footer:

~~~
📍 archived <n> — <names> · <the registry: line>
~~~

🔴 It never pushes, never deletes a folder's only docs (no SPEC → moved whole), never touches a
folder with uncommitted changes, one building in a session, or one a fleet is running, and never
writes `SHIPPED` on a feature that was not verified.
