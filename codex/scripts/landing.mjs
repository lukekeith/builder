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
export const DESTRUCTIVE = /\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA|VIEW|CONSTRAINT)\b|\bALTER\s+TABLE\b[^;]*\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bRENAME\b/i

const count = (n) => `${n} new migration${n === 1 ? '' : 's'}`

/**
 * What to do about migrations a landing brought: `files` are the new migration files
 * ({ path, text }), `readiness` is parseWalkReadiness, `checkedOut` is false when the target
 * branch is checked out nowhere (the merge moved a ref only). Returns `{ action: 'none' }`,
 * `{ action: 'apply', commands }`, or `{ action: 'note', why }` naming what to run by hand.
 */
export function landedMigrations({ files, readiness = {}, checkedOut = true, target = 'the target' }) {
  if (!files?.length) return { action: 'none' }
  const n = count(files.length)
  const cmds = [readiness.apply, readiness.regenerate].filter(Boolean)
  const run = cmds.map((c) => `\`${c}\``).join(', then ')
  if (!readiness.apply) return { action: 'note', why: `${n} landed, but the config's Walk readiness has no \`apply:\` command — apply them to the dev DB by hand` }
  if (!checkedOut) return { action: 'note', why: `${n} landed on ${target}, which is checked out nowhere — when you switch to it, apply them to the dev DB first: run ${run}` }
  const destructive = files.filter((f) => DESTRUCTIVE.test(f.text ?? '')).map((f) => f.path)
  if (destructive.length) return { action: 'note', why: `${n} landed and ${destructive.join(', ')} drops or rewrites data, so it was not applied — check it, then run ${run}` }
  if ((readiness.apply_mode ?? 'ask') !== 'agent') return { action: 'note', why: `${n} landed — the dev DB is behind: run ${run}` }
  return { action: 'apply', commands: cmds }
}
