Notes can carry tags.

- `notes add <text> --tag <t>` stores the note with that tag; `--tag` may be given more than once.
  A tag is one word, lower-case letters, digits and dashes.
- `notes list` is unchanged for untagged notes; a tagged note's line ends with its tags as
  ` #t1 #t2` (sorted, space before each `#`).
- `notes list --tag <t>` shows only notes carrying that tag, in id order.
- `notes show <id>` prints the text on the first line and, when the note has tags, `tags: t1, t2`
  (sorted) on the second.
- `notes tags` lists every tag in use with its count, one per line as `<tag>  <count>`, sorted by
  tag. With no tags at all it prints nothing.
- Existing notes files without tags keep working.

The CLI entry stays `src/cli.mjs`, the tests stay under `test/` and run with `npm test`, and
there are still no dependencies. The feature is done when it is merged into `main` and
`npm test` is green.
