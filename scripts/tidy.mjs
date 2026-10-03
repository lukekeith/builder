#!/usr/bin/env node
/**
 * tidy — take a repo back to: the branch features merge into, plus only what unfinished work still
 * needs. /builder:tidy drives it; every destructive step is one the owner chose.
 *
 *   node <plugin>/scripts/tidy.mjs plan [--into <branch>] [--json]
 *   node <plugin>/scripts/tidy.mjs apply <action> <branch|worktree path>… [--into <branch>]
 *
 * Actions: delete-branch (a branch fully in the target, and its worktree) · force-delete-branch
 * (unmerged — only after the owner chose delete) · remove-worktree (keeps the branch) · merge (a
 * branch that carries the target merges --no-ff; a feature branch behind it is handed to the fleet,
 * listed on a final `handed:` line). One line per item; exit 1 when any item was refused.
 * Never pushes, never touches a remote, never loses uncommitted work (it is stashed by name).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireConfig } from './config.mjs'
import { loadFleet, fleetDir, fleetAlive } from './fleet-core.mjs'
import { inventory, summaryLine, clearWorktree, worktrees } from './tidy-core.mjs'

const argv = process.argv.slice(2)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
const CFG = requireConfig()
const ROOT = CFG.root
const TARGET = opt('--into') ?? CFG.mergeInto
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd = ROOT) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
const items = () => inventory(ROOT, CFG, TARGET, { fleet: existsSync(join(fleetDir(ROOT), 'fleet.json')) ? loadFleet(ROOT) : null, lockAlive: fleetAlive(ROOT) })

const [verb, action, ...rest] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--into')

if (verb === 'plan') {
  const all = items()
  if (argv.includes('--json')) console.log(JSON.stringify({ target: TARGET, items: all, summary: summaryLine(all) }, null, 2))
  else for (const i of all) console.log(`${i.group.padEnd(12)} ${i.action.padEnd(16)} ${i.name}${i.why ? ` — ${i.why}` : ''}`)
  process.exit(0)
}
if (verb !== 'apply' || !action || !rest.length) {
  console.error('Usage: tidy.mjs plan [--into <branch>] [--json] | apply <delete-branch|force-delete-branch|remove-worktree|merge> <name>… [--into <branch>]')
  process.exit(2)
}

let refused = 0
const handed = []
const ok = (name, what) => console.log(`✓ ${name} — ${what}`)
const no = (name, why) => {
  refused++
  console.log(`✗ ${name} — ${why}`)
}
const exists = (b) => tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null
const ahead = (b) => Number(tryGit(['rev-list', '--count', `${TARGET}..${b}`]) ?? 0)
const wtOf = (b) => worktrees(ROOT).slice(1).find((w) => w.branch === b)
const mainBranch = () => worktrees(ROOT)[0]?.branch
const labelOf = (b) => b.replace(/^builder\//, '')

/** The branch's worktree, cleared; a stash is reported. '' when there was none. */
function dropWorktree(b) {
  const w = wtOf(b)
  if (!w) return ''
  const { stash } = clearWorktree(ROOT, w.path, labelOf(b))
  return stash ? `; uncommitted changes are in stash "${stash}"` : ''
}

function deleteBranch(b, force) {
  if (!exists(b)) return no(b, 'no such branch')
  if (b === TARGET || b === CFG.baseBranch) return no(b, 'is the branch features merge into')
  if (b === mainBranch()) return no(b, 'is checked out in the main checkout — switch away first')
  const lost = ahead(b)
  if (lost && !force) return no(b, `${plural(lost, 'commit')} not in ${TARGET}; delete it only with force-delete-branch`)
  const had = !!wtOf(b)
  const stash = dropWorktree(b)
  if (tryGit(['branch', '-D', b]) === null) return no(b, 'git refused to delete it')
  ok(b, lost ? `deleted, with ${plural(lost, 'commit')} that ${lost === 1 ? 'was' : 'were'} not in ${TARGET}${stash}` : `deleted${had ? ' (and its worktree)' : ''}${stash}`)
}

function removeWorktree(name) {
  const w = worktrees(ROOT).slice(1).find((x) => x.path === name || x.branch === name)
  if (!w) {
    tryGit(['worktree', 'prune'])
    return existsSync(name) ? no(name, 'not a worktree of this repo') : ok(name, 'already gone; pruned')
  }
  const { removed, stash } = clearWorktree(ROOT, w.path, w.branch ? labelOf(w.branch) : 'detached')
  if (!removed && existsSync(w.path)) return no(name, 'git could not remove it')
  ok(name, `worktree removed${w.branch ? '' : ' (it was on no branch)'}${stash ? `; uncommitted changes are in stash "${stash}"` : ''}`)
}

/** The fleet's merge rule: the target checked out here → git merge (clean tree); checked out nowhere → write the merge onto the ref. */
function mergeBranch(b) {
  if (!exists(b)) return no(b, 'no such branch')
  if (!ahead(b)) return deleteBranch(b, false)
  const feature = tryGit(['cat-file', '-e', `${b}:${CFG.registry}/${labelOf(b)}/MANIFEST.md`]) !== null ? labelOf(b) : null
  const carries = tryGit(['merge-base', '--is-ancestor', `refs/heads/${TARGET}`, b]) !== null
  if (!carries && feature) {
    handed.push(feature)
    return console.log(`→ ${b} — behind ${TARGET}: the fleet brings it up to date and merges it`)
  }
  const message = `merge(${feature ?? labelOf(b)}): merged by /builder:tidy`
  const elsewhere = worktrees(ROOT).slice(1).find((w) => w.branch === TARGET)
  if (elsewhere) return no(b, `${TARGET} is checked out in ${elsewhere.path} — merge it there`)
  if (mainBranch() === TARGET) {
    if (tryGit(['diff', '--quiet', 'HEAD']) === null) return no(b, `${TARGET} has uncommitted changes here — commit or stash them first`)
    if (tryGit(['merge', '--no-ff', '--no-edit', '-m', message, b]) === null) {
      tryGit(['merge', '--abort'])
      return no(b, `merging into ${TARGET} conflicted — backed out${feature ? `; /builder:agent --path ${CFG.registry}/${feature} resolves it` : ''}`)
    }
  } else {
    if (!carries) return no(b, `doesn't carry ${TARGET} and ${TARGET} isn't checked out — check out ${TARGET} and run it again`)
    const old = git(['rev-parse', `refs/heads/${TARGET}`])
    const commit = tryGit(['commit-tree', `${b}^{tree}`, '-p', old, '-p', b, '-m', message])
    if (!commit || tryGit(['update-ref', `refs/heads/${TARGET}`, commit, old]) === null) return no(b, `writing the merge onto ${TARGET} failed`)
  }
  const stash = dropWorktree(b)
  tryGit(['branch', '-D', b])
  ok(b, `merged into ${TARGET}${stash}`)
}

const run = { 'delete-branch': (n) => deleteBranch(n, false), 'force-delete-branch': (n) => deleteBranch(n, true), 'remove-worktree': removeWorktree, merge: mergeBranch }[action]
if (!run) {
  console.error(`Unknown action ${action}.`)
  process.exit(2)
}
for (const name of rest) run(name)
if (handed.length) console.log(`handed: ${handed.join(' ')}`)
process.exit(refused ? 1 : 0)
