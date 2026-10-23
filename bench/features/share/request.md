Notes can be shared through the server: share a note, get a short code, and anyone with the code
can fetch a copy of it until it expires.

The server (`apps/server`):

- It keeps shared notes behind a share code: 8 characters, lower-case letters and digits, unique.
  Shares live in the server's store, so with `STORE_FILE` set they survive a restart.
- Every share has an owner. A request names its owner with the `x-owner-token` header; any
  non-empty string is a token. Creating, listing and deleting shares need it (401 without it);
  fetching one by its code does not.
- `POST /shares` with `{ "text": "...", "days": n }` stores a share and answers 201
  `{ "code", "expiresAt" }`. `days` is a whole number from 1 to 30 and defaults to 7; `expiresAt`
  is the creation time plus that many days, as an ISO 8601 string. Empty text or a bad `days` is
  a 400.
- `GET /shares/:code` answers 200 `{ "code", "text", "expiresAt" }`; 404 for a code it doesn't
  know, 410 once the share has expired (the current time is at or past `expiresAt`).
- `GET /shares` answers 200 with the token's owner's unexpired shares, oldest first, each
  `{ "code", "text", "expiresAt" }`.
- `DELETE /shares/:code` deletes the owner's share: 204; 404 for an unknown code; 403 when the
  share belongs to another owner.
- Errors answer `{ "error": "<message>" }`, as the server's other routes do.
- When `NOTES_NOW` is set (an ISO 8601 timestamp) the server takes it as the current time — that
  is how expiry gets tested.

The CLI (`apps/cli`):

- It reads the server's URL from `NOTES_SERVER` (e.g. `http://localhost:4000`). A command that
  needs the server fails when `NOTES_SERVER` is unset (the message says so) or the server can't be
  reached.
- Its owner token is made on first use and kept in the notes file, so a different `NOTES_FILE` is
  a different owner. Existing notes files keep working.
- `notes share <id> [--days <n>]` shares the note's text and prints only the code. A missing note
  fails with `no note <id>`.
- `notes fetch <code>` adds the shared text as a new local note and prints its id. An unknown code
  fails with `no share <code>`; an expired one fails with a message saying it has expired.
- `notes shares` lists your unexpired shares, oldest first, one per line as
  `<code>  <YYYY-MM-DD>  <text>`, the date being the UTC day of `expiresAt`. With none it prints
  nothing.
- `notes unshare <code>` deletes your share and prints `unshared <code>`; someone else's share or
  an unknown code fails.
- Every failure exits 1 with a one-line message on stderr.

The entry points stay `apps/cli/src/cli.mjs` and `apps/server/src/server.mjs` (which listens on
`PORT`), each app's tests stay under its `test/` and run with `npm test --prefix apps/<app>`, and
there are still no dependencies. The feature is done when it is merged into `main` and `npm test`
is green.
