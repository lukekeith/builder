/**
 * tidy-core — what builder leaves on disk, and taking it away safely. Shared by the fleet (which
 * clears a feature's worktree when it lands or stops) and /builder:tidy (which clears what older
 * runs left). Nothing here pushes, touches a remote, or throws work away: test output is restored,
 * anything else uncommitted is stashed under a name that says whose it was.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dirtyPaths } from './gates-core.mjs'

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/** What test runners rewrite on every run — never anyone's work. */
export const TEST_OUTPUT = ['test-results/', 'playwright-report/', 'coverage/', '.nyc_output/', '.builder/']
const JUNIT = /^junit[^/]*\.xml$/

export const isTestOutput = (path) => TEST_OUTPUT.some((p) => path.startsWith(p)) || JUNIT.test(path.split('/').pop())

const day = (d) => d.toISOString().slice(0, 10)

/**
 * Remove a worktree without losing anything in it: tracked test output is restored, any other
 * uncommitted tracked change is stashed as `builder: <label> leftovers <date>` (stashes are shared
 * by every worktree of the repo, so it is reachable from the main checkout), then the worktree goes.
 * Untracked files go with it — walk evidence, a copied .env. `{ removed, stash, restored }`.
 */
export function clearWorktree(root, wt, label, today = new Date()) {
  if (!existsSync(wt)) {
    tryGit(['worktree', 'prune'], root)
    return { removed: false, stash: null, restored: [] }
  }
  const dirty = dirtyPaths(wt)
  const restored = dirty.filter(isTestOutput)
  if (restored.length) git(['checkout', '--', ...restored], wt)
  let stash = null
  if (dirty.length > restored.length) {
    stash = `builder: ${label} leftovers ${day(today)}`
    git(['stash', 'push', '-m', stash], wt)
  }
  const removed = tryGit(['worktree', 'remove', '--force', wt], root) !== null
  tryGit(['worktree', 'prune'], root)
  return { removed, stash, restored }
}

// ---- the inventory: every branch and worktree, and what each needs ------------------------------

const unquote = (v) => String(v ?? '').trim().replace(/^"(.*)"$/s, '$1')
const FRESH_MS = 5 * 60 * 1000
const UNFINISHED = new Set(['spec', 'aligned', 'audited', 'planned', 'building', 'built', 'signed-off', 'verified'])

/** `git worktree list --porcelain` as [{ path, branch|null, detached, missing }], main checkout first. */
export function worktrees(root) {
  return (tryGit(['worktree', 'list', '--porcelain'], root) ?? '')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const line = (k) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? null
      const path = line('worktree')
      return {
        path,
        branch: line('branch')?.replace(/^refs\/heads\//, '') ?? null,
        detached: block.split('\n').includes('detached'),
        missing: block.split('\n').some((l) => l.startsWith('prunable')) || !existsSync(path),
      }
    })
}

/** The feature a branch carries: `builder/<f>` with its manifest there, or a manifest whose `branch:` names it. */
function featureOf(root, registry, branch) {
  const own = branch.startsWith('builder/') ? branch.slice('builder/'.length) : null
  if (own && tryGit(['cat-file', '-e', `${branch}:${registry}/${own}/MANIFEST.md`], root) !== null) return own
  const exact = `^branch:[[:space:]]*${branch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[[:space:]]*$`
  const hit = tryGit(['grep', '-l', '-E', '-e', exact, branch, '--', registry], root)
  const path = hit?.split('\n').find((l) => l.endsWith('/MANIFEST.md'))
  return path ? path.split('/').slice(-2)[0] : null
}

function manifestOn(root, registry, branch, feature) {
  const text = tryGit(['show', `${branch}:${registry}/${feature}/MANIFEST.md`], root)
  if (text == null) return {}
  const mf = {}
  for (const l of text.split('\n')) {
    const m = /^([a-z][\w-]*):\s*(.*)$/.exec(l)
    if (m) mf[m[1]] = m[2].trim()
  }
  return mf
}

const freshLedger = (dirs, feature, now) =>
  dirs.some((d) => {
    try {
      return now - statSync(join(d, '.builder', feature, 'progress.md')).mtimeMs <= FRESH_MS
    } catch {
      return false
    }
  })

/**
 * Every local branch and worktree except the target, each with its group and the action it needs:
 *   current · running → none        merged → delete              ready → merge
 *   parked → remove-worktree (keep the branch) or keep           in-progress · unknown → ask
 *   dead (a detached, missing or scratchpad worktree) → remove-worktree
 * `fleet` is fleet.json (or null); `lockAlive` whether its process is running.
 */
export function inventory(root, cfg, target, { fleet = null, lockAlive = false, now = Date.now() } = {}) {
  const wts = worktrees(root)
  const main = wts[0]
  const wtOf = new Map(wts.filter((w) => w.branch).map((w) => [w.branch, w]))
  const rows = Object.values(fleet?.features ?? {})
  const items = []
  const refs = (tryGit(['for-each-ref', 'refs/heads', '--format=%(refname:short)\t%(committerdate:iso-strict)'], root) ?? '').split('\n').filter(Boolean)
  for (const ref of refs) {
    const [name, touched] = ref.split('\t')
    if (name === target || name === cfg.baseBranch) continue
    const wt = wtOf.get(name)
    const item = { kind: 'branch', name, worktree: wt && wt !== main ? wt.path : null, touched, ahead: Number(tryGit(['rev-list', '--count', `${target}..${name}`], root) ?? 0) }
    const feature = featureOf(root, cfg.registry, name)
    if (feature) item.feature = feature
    const mf = feature ? manifestOn(root, cfg.registry, name, feature) : {}
    const row = rows.find((r) => r.branch === name)
    const set = (group, action, extra = {}) => items.push(Object.assign(item, { group, action }, extra))
    if (main.branch === name) set('current', 'none')
    else if ((lockAlive && row && !['done', 'parked', 'failed'].includes(row.status)) || (feature && freshLedger([root, item.worktree].filter(Boolean), feature, now))) set('running', 'none')
    else if (item.ahead === 0) set('merged', 'delete')
    else if (feature && (mf.state === 'verified' || (mf.state === 'signed-off' && /^READY/.test(mf.verify ?? '')))) set('ready', 'merge')
    else if (feature && ((mf.blocked && mf.blocked !== 'none') || ['parked', 'failed'].includes(row?.status))) {
      const reason = mf.blocked && mf.blocked !== 'none' ? unquote(mf.blocked) : row.reason ?? ''
      const cut = reason.lastIndexOf(' — next: ')
      set('parked', item.worktree ? 'remove-worktree' : 'keep', { why: cut >= 0 ? reason.slice(0, cut) : reason, next: cut >= 0 ? reason.slice(cut + 9) : `/builder:agent --path ${cfg.registry}/${feature}` })
    } else if (feature && UNFINISHED.has(mf.state)) set('in-progress', 'ask', { next: `/builder:agent --path ${cfg.registry}/${feature}` })
    else set('unknown', 'ask')
  }
  for (const w of wts.slice(1))
    if (w.detached || w.missing || w.path.includes('/scratchpad/'))
      items.push({ kind: 'worktree', name: w.path, path: w.path, group: 'dead', action: 'remove-worktree', why: w.missing ? 'its folder is gone' : w.detached ? 'detached — on no branch' : 'a session scratchpad' })
  return items
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One line for /builder:status and the fleet's report. */
export function summaryLine(items) {
  const n = (g) => items.filter((i) => i.group === g).length
  const parts = [
    n('merged') && `${plural(n('merged'), 'merged branch', 'merged branches')} to delete`,
    n('dead') && plural(n('dead'), 'dead worktree'),
    n('ready') && `${n('ready')} ready to merge`,
    n('parked') && `${n('parked')} parked`,
    n('in-progress') && `${n('in-progress')} in progress`,
    n('unknown') && `${n('unknown')} unknown`,
  ].filter(Boolean)
  return parts.length ? `repo: ${parts.join(' · ')} → /builder:tidy` : 'repo: clean'
}
