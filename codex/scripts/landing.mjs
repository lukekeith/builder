/**
 * After a verified landing: the migrations the feature brought, and what this checkout's dev DB
 * needs. Pure decisions here; lifecycle.mjs `deliver` performs the side effects.
 *
 * The feature's walk proved its migrations against its own isolated database. The merge puts the
 * code in the target checkout, where a running dev server may already serve it, so the dev DB must
 * receive the same migrations. Only `apply_mode: agent` with additive migrations runs unattended.
 */

/**
 * The config body's `## Walk readiness` block as `{ migrations, status, apply, apply_mode,
 * regenerate, … }`: `key: value` lines inside its first fenced block, trailing `# comments`
 * dropped, a `<placeholder>` left from the template treated as unset.
 */
export function parseWalkReadiness(body) {
  const text = String(body ?? '')
  const at = text.search(/^## Walk readiness\s*$/m)
  if (at < 0) return {}
  const rest = text.slice(at).split('\n').slice(1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n')
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(section)
  const out = {}
  for (const raw of (fence ? fence[1] : '').split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(raw.replace(/\s{2,}#.*$|\s+#\s.*$/, '').trim())
    if (m && m[2] && !/^<.*>$/.test(m[2])) out[m[1]] = m[2]
  }
  return out
}

/** SQL that drops or rewrites data — never applied unattended, whatever apply_mode says. */
export const DESTRUCTIVE = /\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|CONSTRAINT|DATABASE|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|EXTENSION|DEFAULT|NOT\s+NULL)\b|\bALTER\s+TABLE\b[^;]*\bDROP\b|\bALTER\s+COLUMN\b[^;]*\b(TYPE|SET\s+DATA\s+TYPE)\b|\bUPDATE\s+["'`\w.]+(\s+(AS\s+)?\w+)?\s+SET\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bRENAME\b/i

/**
 * Migration code that is not plain SQL (Alembic, Django, Knex, Rails, Sequelize, TypeORM, Prisma
 * and Mongo scripts, …): calls that drop, rename, change or rewrite, or that execute arbitrary
 * SQL/data changes. Any hit is treated as destructive.
 */
export const DESTRUCTIVE_CODE = /\bop\.drop_|\bdrop_(column|table|index|constraint)\b|\bremove_(column|columns|index|references|reference|table|timestamps)\b|\bdrop(Table|Column|Columns|Index|Foreign|Unique|Primary|Schema|Collection)\w*\b|\bRemoveField\b|\bDeleteModel\b|\bRenameField\b|\bRenameModel\b|\bAlterField\b|\bRunSQL\b|\bRunPython\b|\balter_column\b|\bbatch_alter_table\b|\bchange_column\w*\b|\bchange_table\b|\brename_(column|table|index)\b|\brename(Column|Table)\b|\b(delete_all|update_all|destroy_all)\b|\b(removeColumn|changeColumn|removeConstraint|removeIndex|bulkDelete|bulkUpdate|deleteMany|deleteOne|updateMany)\b|\bexecute\s*\(|\.raw\s*\(|\bbulk_update\b|\.update\s*\(|\.del\s*\(|\.delete\s*\(/

// Where the forward migration ends: its down/downgrade half only runs on rollback.
const UP = /^[ \t]*(?:async\s+)?def\s+(?:upgrade|up|change)\b|\bexports\.up\b|^[ \t]*export\s+(?:async\s+)?function\s+up\b|^[ \t]*(?:async\s+)?up\s*\(/m
const DOWN = /^[ \t]*(?:async\s+)?def\s+(?:downgrade|down)\b|\bexports\.down\b|^[ \t]*export\s+(?:async\s+)?function\s+down\b|^[ \t]*(?:async\s+)?down\s*\(/m

/** The forward half of a migration file: from its up/upgrade definition to its down/downgrade one. */
export function forwardPart(text) {
  const t = String(text ?? '')
  const up = UP.exec(t)
  const from = up ? up.index : 0
  const rest = t.slice(from)
  const down = DOWN.exec(up ? rest.slice(up[0].length) : rest)
  return down ? rest.slice(0, (up ? up[0].length : 0) + down.index) : rest
}

/** True when a landed migration file drops or rewrites data (or cannot be shown not to). */
export function isDestructive({ path = '', text = '' }) {
  if (/\.sql$/i.test(path)) return DESTRUCTIVE.test(text)
  const forward = forwardPart(text)
  return DESTRUCTIVE.test(forward) || DESTRUCTIVE_CODE.test(forward)
}

const count = (n) => `${n} new migration${n === 1 ? '' : 's'}`

/**
 * What to do about migrations a landing brought: `files` are the new migration files
 * ({ path, text }), `readiness` is parseWalkReadiness, `checkedOut` is false when the target
 * branch is checked out nowhere (the merge moved a ref only). Returns `{ action: 'none' }`,
 * `{ action: 'apply', commands }`, or `{ action: 'note', why }` naming what to run by hand.
 *
 * `pending` is the dev DB's own answer when Walk readiness has a `pending:` command (exit 0 =
 * nothing pending — not `status:`, which many tools exit 0 from either way): false → nothing to
 * say, the dev DB already has them; true → behind, or the command couldn't tell; null (no command,
 * or not asked) → git only knows the files landed, so the note says the DB *may* be behind
 * (`kind: 'maybe'` — the caller asks `pending:` then, when it has one).
 */
export function landedMigrations({ files, readiness = {}, checkedOut = true, target = 'the target', pending = null }) {
  if (!files?.length) return { action: 'none' }
  const n = count(files.length)
  const cmds = [readiness.apply, readiness.regenerate].filter(Boolean)
  const run = cmds.map((c) => `\`${c}\``).join(', then ')
  if (!readiness.apply) return { action: 'note', why: `${n} landed, but the config's Walk readiness has no \`apply:\` command — apply them to the dev DB by hand` }
  if (!checkedOut) return { action: 'note', why: `${n} landed on ${target}, which is checked out nowhere — when you switch to it, apply them to the dev DB first: run ${run}` }
  const destructive = files.filter(isDestructive).map((f) => f.path)
  if (destructive.length) return { action: 'note', why: `${n} landed and ${destructive.join(', ')} drops or rewrites data, so it was not applied — check it, then run ${run}` }
  if ((readiness.apply_mode ?? 'ask') !== 'agent') {
    if (pending === false) return { action: 'none', why: `${n} landed; \`${readiness.pending}\` says the dev DB already has them` }
    if (pending === true) return { action: 'note', why: `${n} landed — the dev DB is behind, or \`${readiness.pending}\` couldn't reach it: run ${run}` }
    return { action: 'note', kind: 'maybe', why: `${n} landed — the dev DB may be behind: if it lacks them, run ${run}` }
  }
  return { action: 'apply', commands: cmds }
}

/**
 * The wrap-up after a landing — what the target checkout's running dev env still needs, from Walk
 * readiness, in the order they stand on each other: `restart:` (what doesn't reload by itself),
 * `fixtures:` (the dev data a walk starts from), then `smoke:` last, and only after one of those or
 * an applied migration changed something. Offered by the coordinator in one question; never run
 * unasked — the dev env is the owner's. None when the target is checked out nowhere: no dev env
 * here serves it. Claude's fleet runs the same steps through wrapup.mjs; its switch and tidy steps
 * have no Codex counterpart (Codex lands into the checkout that holds the target, in session).
 */
export function wrapUp({ readiness = {}, checkedOut = true, migrated = false }) {
  if (!checkedOut) return []
  const steps = []
  if (readiness.restart) steps.push({ id: 'restart', title: 'restart what doesn\'t reload by itself, so the dev env serves what landed', command: readiness.restart })
  if (readiness.fixtures) steps.push({ id: 'fixtures', title: 'reset the dev data a walk starts from', command: readiness.fixtures })
  if (readiness.smoke && (steps.length || migrated)) steps.push({ id: 'smoke', title: 'check the running dev app answers', command: readiness.smoke })
  return steps
}

/**
 * A landing the owner's uncommitted changes are in the way of — "needs you" (Claude 6.0's landing
 * needs-you design, adapted: Codex has no fleet, so the coordinator asks in the session). The
 * verifier's release refuses before any git write when the target checkout's uncommitted changes
 * overlap the files the feature changes (verify/checkouts.mjs landOverlap); changes that don't
 * overlap are no block. `files` is that overlap, `checkout` the target checkout holding them.
 *
 * Every needs-you carries choices: at least one moves the work forward, and leaving it is always
 * one of them, last. Builder never commits, sets aside or discards the owner's changes without one
 * of these answers.
 */
export const NEEDS_YOU_CHOICES = [
  { id: 'commit-mine', label: 'Commit my changes, then land', does: 'commits your changes on the target with a message you approve, tests the feature merged onto that, then lands it', run: 'deliver <feature> --commit-mine "<message>"' },
  { id: 'set-aside', label: 'Set my changes aside, land, put them back', does: 'sets your changes aside in a named stash, lands the feature, then puts them back; if they clash on the way back the stash is kept and the files are listed', run: 'deliver <feature> --set-aside' },
  { id: 'leave', label: 'Leave it for now', does: 'nothing changes; the feature lands once your changes no longer overlap it', run: null },
]

const listed = (files) => [...files.slice(0, 3), ...(files.length > 3 ? ['…'] : [])].join(', ')

/** The needs-you record a feature keeps while its landing waits on the owner's changes. */
export function needsYou({ feature, files, target, checkout }) {
  const n = `${files.length} file${files.length === 1 ? '' : 's'}`
  return {
    kind: 'overlap',
    reason: `needs you: your uncommitted changes in ${checkout} overlap this feature — ${n}: ${listed(files)}`,
    files: [...files],
    target,
    checkout,
    choices: NEEDS_YOU_CHOICES.map((c) => ({ ...c, run: c.run && c.run.replace('<feature>', feature) })),
  }
}

/** The stash a set-aside landing keeps the owner's changes in; found again by its sha, never by its place. */
export const stashName = (feature) => `builder: before landing ${feature}`
