/**
 * tidy-core — what builder leaves on disk, and taking it away safely. Shared by the fleet (which
 * clears a feature's worktree when it lands or stops) and /builder:tidy (which clears what older
 * runs left). Nothing here pushes, touches a remote, or throws work away: test output is restored,
 * anything else uncommitted is stashed under a name that says whose it was.
 */
import { existsSync, statSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
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

/** Untracked files in a worktree that aren't ignored — someone's new work, unless it's test output. */
const untracked = (wt) => (tryGit(['ls-files', '--others', '--exclude-standard'], wt) ?? '').split('\n').filter(Boolean)

/** Paths in a worktree that hold someone's uncommitted work: tracked changes and new files, test output aside. */
export const uncommittedWork = (wt) => [...dirtyPaths(wt), ...untracked(wt)].filter((p) => !isTestOutput(p))

/** Why a worktree must not be cleared right now, or null: a git operation half-done, a lock, submodules. */
function busy(root, wt) {
  for (const [file, what] of [['MERGE_HEAD', 'a merge'], ['REBASE_HEAD', 'a rebase'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
    const p = tryGit(['rev-parse', '--git-path', file], wt)
    if (p && existsSync(isAbsolute(p) ? p : join(wt, p))) return `${what} in progress there — finish or abort it first`
  }
  if (worktrees(root).some((w) => w.path === wt && w.locked)) return 'it is locked (git worktree unlock it first)'
  if (existsSync(join(wt, '.gitmodules'))) return 'it has submodules — remove it by hand'
  return null
}

/**
 * Remove a worktree without losing anything in it. Refused — nothing touched — when a merge or
 * rebase is half-done there, it is locked, or it has submodules. Otherwise: the build workspace
 * `.builder/<label>/` (ledger, rulings, walk.md — git-ignored, so `remove --force` would take it) is
 * copied to `<root>/.builder/kept/<label>/`, where the next worktree for it picks it up — unless
 * `keep: false` (the feature is finished, or its branch is being deleted); tracked test
 * output is restored; every other uncommitted change — tracked or new — is stashed as
 * `builder: <label> leftovers <date>` (stashes are shared by every worktree of the repo); then the
 * worktree goes. `{ removed, stash, restored, kept, why }`.
 */
export function clearWorktree(root, wt, label, { today = new Date(), keep = true } = {}) {
  const out = { removed: false, stash: null, restored: [], kept: null, why: null }
  if (!existsSync(wt)) {
    tryGit(['worktree', 'prune'], root)
    return out
  }
  out.why = busy(root, wt)
  if (out.why) return out
  const ws = join(wt, '.builder', label)
  if (keep && existsSync(ws)) {
    out.kept = join(root, '.builder', 'kept', label)
    rmSync(out.kept, { recursive: true, force: true })
    mkdirSync(dirname(out.kept), { recursive: true })
    cpSync(ws, out.kept, { recursive: true })
  }
  out.restored = dirtyPaths(wt).filter(isTestOutput)
  if (out.restored.length && tryGit(['checkout', '--', ...out.restored], wt) === null) return { ...out, restored: [], why: 'git could not restore its test output' }
  const work = uncommittedWork(wt)
  if (work.length) {
    const stash = `builder: ${label} leftovers ${day(today)}`
    if (tryGit(['stash', 'push', '--include-untracked', '-m', stash, '--', ...work], wt) === null) return { ...out, why: 'git could not stash its uncommitted changes — nothing was removed' }
    out.stash = stash
  }
  out.removed = tryGit(['worktree', 'remove', '--force', wt], root) !== null
  if (!out.removed) out.why = 'git could not remove it'
  tryGit(['worktree', 'prune'], root)
  return out
}

/** A workspace clearWorktree kept for <label>, put back into a new worktree. True when there was one. */
export function restoreKept(root, wt, label) {
  const kept = join(root, '.builder', 'kept', label)
  if (!existsSync(kept)) return false
  mkdirSync(join(wt, '.builder'), { recursive: true })
  cpSync(kept, join(wt, '.builder', label), { recursive: true })
  rmSync(kept, { recursive: true, force: true })
  return true
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
        locked: block.split('\n').some((l) => l === 'locked' || l.startsWith('locked ')),
        missing: block.split('\n').some((l) => l.startsWith('prunable')) || !existsSync(path),
      }
    })
}

/** The feature a branch carries: `builder/<f>` with its manifest there, or a manifest whose `branch:` names it. */
export function featureOf(root, registry, branch) {
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
  // A target that isn't there would make every branch look "nothing ahead" — and merged.
  if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], root) === null)
    throw new Error(`The branch to merge into, ${target}, does not exist — create it (git branch ${target}) or set merge_into in .claude/builder.md.`)
  const wts = worktrees(root)
  const main = wts[0]
  const wtOf = new Map(wts.filter((w) => w.branch).map((w) => [w.branch, w]))
  const rows = Object.values(fleet?.features ?? {})
  const items = []
  const refs = (tryGit(['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)\t%(committerdate:iso-strict)'], root) ?? '').split('\n').filter(Boolean)
  for (const ref of refs) {
    const [name, touched] = ref.split('\t')
    if (name === target || name === cfg.baseBranch) continue
    const wt = wtOf.get(name)
    const count = tryGit(['rev-list', '--count', `refs/heads/${target}..refs/heads/${name}`], root)
    const item = { kind: 'branch', name, worktree: wt && wt !== main ? wt.path : null, touched, ahead: count === null ? null : Number(count) }
    const feature = featureOf(root, cfg.registry, name)
    if (feature) item.feature = feature
    const mf = feature ? manifestOn(root, cfg.registry, name, feature) : {}
    const row = rows.find((r) => r.branch === name)
    const set = (group, action, extra = {}) => items.push(Object.assign(item, { group, action }, extra))
    if (main.branch === name) set('current', 'none')
    else if ((lockAlive && row && !['done', 'parked', 'failed'].includes(row.status)) || (feature && freshLedger([root, item.worktree].filter(Boolean), feature, now))) set('running', 'none')
    else if (item.ahead === null) set('unknown', 'ask', { why: 'git could not compare it with the target' })
    else if (item.ahead === 0) set('merged', 'delete')
    else if (feature && (mf.state === 'verified' || (mf.state === 'signed-off' && /^READY/.test(mf.verify ?? '')))) set('ready', 'merge')
    else if (feature && ((mf.blocked && mf.blocked !== 'none') || ['parked', 'failed'].includes(row?.status))) {
      const reason = mf.blocked && mf.blocked !== 'none' ? unquote(mf.blocked) : row.reason ?? ''
      const cut = reason.lastIndexOf(' — next: ')
      // A worktree parked for your walk is where you walk it: the fleet keeps it, and so does tidy.
      set('parked', item.worktree && !/^waiting for your walk/.test(reason) ? 'remove-worktree' : 'keep', { why: cut >= 0 ? reason.slice(0, cut) : reason, next: cut >= 0 ? reason.slice(cut + 9) : `/builder:agent --path ${cfg.registry}/${feature}` })
    } else if (feature && UNFINISHED.has(mf.state)) set('in-progress', 'ask', { next: `/builder:agent --path ${cfg.registry}/${feature}` })
    else set('unknown', 'ask')
  }
  for (const w of wts.slice(1))
    if (w.detached || w.missing || w.path.includes('/scratchpad/'))
      items.push({ kind: 'worktree', name: w.path, path: w.path, worktree: w.missing ? null : w.path, group: 'dead', action: 'remove-worktree', why: w.missing ? 'its folder is gone' : w.detached ? 'detached — on no branch' : 'a session scratchpad' })
  // Nothing goes in the safe batch while a worktree holds someone's uncommitted work.
  for (const i of items)
    if (['delete', 'remove-worktree', 'merge'].includes(i.action) && i.worktree && existsSync(i.worktree) && uncommittedWork(i.worktree).length)
      Object.assign(i, { action: 'ask', why: [i.why, 'uncommitted work in its worktree'].filter(Boolean).join(' · ') })
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
