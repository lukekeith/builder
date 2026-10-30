# bench/local — real-project cases, kept on this machine

Everything here except this file is git-ignored: cases, profiles and results name real projects and
never leave the machine. Nothing committed names one. Placeholder names below.

```
bench/local/
  cases/<case-id>.json        one file per case
  projects/<project>.json     one profile per project
  results/<suite-id>/         suite.json, one folder per attempt, REPORT.md
```

Adding a case is one file: `cases/<id>.json`. A new project also needs its profile once.

## A case — `cases/<id>.json`

The id is the file name. Fields: `project` (the profile name), `feature` (the archived feature's name in
the project's registry), `size` (`xs`, `sm`, `md`, `lg` or `xl`), `covers` (a few words, shown in the picker),
and optionally `estimate` (`{ "minutes": 90, "usd": 12 }`; without it the estimate comes from the feature's archive row).

```json
{ "project": "project-a", "feature": "export-csv", "size": "md", "covers": "two apps, a migration" }
```

## A profile — `projects/<project>.json`

- `repo` (required) — the project's git repo, relative to this file or absolute. It is only read; the case runs in a clone.
- `db_prefix` (required) — the prefix every bench database carries, such as `bench_a_`.
- `agent_walk` — keys set under `agent_walk:` in the clone's `.claude/builder.md`. `claude_args` starts with the runner's
  `--permission-mode`, `--settings` and `--plugin-dir`, which it owns; after them come the profile's `claude_args` when it
  sets one, else the project's own (an `--mcp-config`, a `--model`) — either without those three flags.
- `verify` — a file whose `verify:` block replaces the clone's.
- `files` — `{ "<path in the clone>": "<source file>" }`, copied into the clone and kept out of git. Not `.git`, `builder.md`
  or any path the project tracks: sessions run in fleet worktrees checked out from commits, which hold the committed
  file. A placed file reaches a worktree only through `agent_walk.copy` (comma-separated paths or folders): list it
  there. A placed `--mcp-config` file not in `copy` is refused; any other placed file the profile's `env` or `agent_walk`
  names, a warning.
- `env` — `{ "NAME": "value" }`, set for the setup, the teardown and the fleet — and so for every session the fleet
  starts. Point the project's own scripts at the bench database here: `DATABASE_URL`, `DIRECT_URL`,
  `TEST_DATABASE_URL`, `SUPABASE_DB_URL`, `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `MONGODB_URI`, `MONGO_URL` and every
  `PG*`, `POSTGRES_*`, `MYSQL_*` and `DB_*` are never
  inherited from your shell, so without `env` they are unset.
- `replace` — `[["from", "to"], …]`, literal replacements over the whole clone's `builder.md` — front matter and body —
  after the keys above are set; each must match at least once, or the case is refused (`replace: "<from>" not found`).
  Use it to point the body's prose (a "Walk readiness" section naming your dev database, ports or containers) at the
  bench's. It may not change `agent_walk.claude_args` — set the profile's `agent_walk.claude_args` instead.
- `setup` — a shell command run in the clone before the fleet (timeout 20 min); it may start what the run needs.
  Whatever it starts runs in its own process group, which is stopped once the case ends, however it ends.
- `teardown` — a shell command run in the clone after the fleet, on every path — landed, failed, timed out or
  stopped (timeout 20 min): drop the bench database, stop a container, shut a simulator down by its prefixed name
  (`xcrun simctl shutdown bench_a_iphone` — never `booted`, `all` or a UDID, which carries no prefix).

```json
{
  "repo": "../../../project-a",
  "db_prefix": "bench_a_",
  "agent_walk": { "start": "npm run dev -- --port 4010" },
  "verify": "project-a.verify.yml",
  "files": { ".env": "project-a.env" },
  "env": { "DATABASE_URL": "postgres://localhost:5432/bench_a_main" },
  "replace": [["localhost:3000", "localhost:4010"], ["/app_dev", "/bench_a_main"]],
  "setup": "npm ci && dropdb --if-exists bench_a_main && createdb bench_a_main",
  "teardown": "dropdb --if-exists bench_a_main"
}
```

Before the clone goes, its `.builder/` is saved to `<out>/builder/` — the fleet's logs with every `.jsonl` transcript (the fleet runs with `FLEET_KEEP_STREAMS=1`) and the env-check logs, `archive.jsonl`, `fleet.json`, each landed feature's workspace in `kept/` (`FLEET_KEEP_WORKSPACES=1`), and any worktree still standing under `worktrees/` — never `node_modules`, a symlink, a file over `BENCH_EVIDENCE_CAP_BYTES` (50 MB; a `.jsonl` transcript: `BENCH_EVIDENCE_JSONL_CAP_BYTES`, 500 MB) or past `BENCH_EVIDENCE_TOTAL_CAP_BYTES` (2 GB) — `result.json`'s `evidence.skipped` names them, and `evidence.error` a copy that failed. `result.json` is written before the copy, and the clone goes whatever the copy did. The clone is removed once its `result.json` is written (the logs stay); `BENCH_KEEP_CLONES=1` keeps it to look into.

## Safety rules

A case is refused, before anything is cloned, when the clone's config — or the profile's `env`, `setup`, its
`teardown`, any text file it places, or an MCP config `agent_walk.claude_args` names with `--mcp-config` (each reason
says which: `env: …`, `setup: …`, `files/.env: …`, `mcp: …`) — would touch something of yours:

- the profile has no `db_prefix`, or a database URL (its path or a `?dbname=` / `&dbname=`), `PGDATABASE` / `*_DATABASE`,
  `POSTGRES_DB`, `PGSERVICE`, or a `createdb` / `dropdb` names a database that does not start with it
  (a Postgres or MySQL URL with no name is the default database, and refused; a Redis URL with no path or a numbered
  one names no database; SQLite's `:memory:`, or a `*.sqlite` / `*.db` file at a relative path inside the clone — no
  leading `/`, `~` or `$`, no `..` — is not a server database's name, except in a `PG*` or `POSTGRES_DB` variable);
- a port named is listening now — `*PORT=`, `--port`, `localhost:` / `0.0.0.0:` / `[::1]:`, `docker -p`, and the
  `lsof -iTCP:N` / `-ti:N` / `-i :N`, `fuser N/tcp` and `kill-port N` forms (a database URL's port, a Postgres
  client's `-p` — `psql`, `createdb`, `dropdb`, `pg_dump`, `pg_restore`, whose database is checked — and `PGPORT` /
  `DB_PORT` are the shared database server's, and are not);
- a command stops or empties a database server or service: `flushall`, `flushdb`, `pg_ctl` / `pg_ctlcluster … stop|restart|kill`,
  `mysql.server stop|restart`, `brew services stop|restart|kill` (whatever it names), `pkill` / `killall` of a database
  server process (`postgres`, `mysqld`, `mariadbd`, `redis-server`, `mongod`, `valkey-server`), `launchctl
  unload|bootout|stop|kill` of one (or of a `homebrew.mxcl.<db>` label), and `shutdown`
  anywhere on a line with a database client or server (`mysqladmin`, `mysql`, `mysqld`, `redis-cli`, `redis-server`,
  `valkey-cli`, `mongosh` / `mongo`, `mongod`, `psql`, `pg_ctl`, `postgres`) — piped in, in a `-c` / `--eval` string,
  or as the server's own `--shutdown`;
- a command shuts down or restarts the machine: `shutdown`, `halt`, `reboot` or `poweroff`, by any path, after `exec`,
  `nohup`, `env`, `command` or `time`, or through `sudo`;
- a `docker` or `docker-compose` command names no container carrying the prefix;
- `simctl` targets the booted simulator instead of the bench device by its prefixed name, or `simctl shutdown` names a device
  without the prefix (`simctl shutdown bench_a_iphone` is fine; `all` is not);
- `agent_walk.claude_args` is not set, so sessions would load your own plugins (the runner sets it);
- the feature has no merged archive row, no spec-only commits at the head of its branch, or the clone or builder path contains whitespace;
- the clone's path is inside the project repo or any other git repo, or already exists (clones go under
  `$BENCH_TMP`, `$TMPDIR/bench-suite` by default; results stay here);
- the result folder (`--out`) is inside the project repo;
- a `--mcp-config` path is outside the clone, or is neither tracked by the project nor placed at an untracked path by
  the profile's `files` and listed in `agent_walk.copy`. A tracked one is always checked as committed — that is what
  worktrees load. A JSON config's keys are read as `KEY=value`, so `"PGDATABASE": "…"` is checked too;
- a profile `files` entry is a path the project tracks;
- an `agent_walk.copy` entry (the project's or the profile's) is absolute or contains `..` — the fleet would copy a
  file from outside the clone into the worktrees.

The body of the clone's `builder.md` — prose, which an agent may still run literally — is checked by the same rules,
as warnings: the dry run lists each as a `body: …` line and the case still runs. Add a `replace` for each. Ports named
only in the body never count toward two projects sharing a port. A placed file the profile names but `agent_walk.copy`
leaves out is a `files: <path> is placed but not in agent_walk.copy` warning.

`bench-suite.mjs plan` runs each case's `--dry-run` and shows these reasons and warnings; fix the case or profile and plan again.
`run` (and `--resume`) prints each case's warnings too, and keeps them as `warnings` in `suite.json` and in the case's `result.json`.
