#!/usr/bin/env node
/**
 * wrapup — what's left to do here once a fleet has landed features, as steps one answer can run.
 *
 *   node <plugin>/scripts/wrapup.mjs plan [--json]
 *   node <plugin>/scripts/wrapup.mjs run <all|step…>
 *   node <plugin>/scripts/wrapup.mjs dismiss
 *
 * The fleet merges into the target while nobody watches, and leaves this checkout behind it: the dev
 * DB without the migrations that landed, a server that hasn't restarted, fixtures from before, the
 * target not checked out, merged branches still around. Each used to be a note to act on by hand.
 * `plan` turns what is still true of them into steps, in the order they depend on each other:
 *
 *   switch    `git switch <target>` — what landed is tested on the target (only from a clean tree)
 *   migrate   §Walk readiness `apply:` then `regenerate:` — for every migration note still open
 *             (§Walk readiness `pending:`, when set, is asked first: an up-to-date DB settles them)
 *   restart   §Walk readiness `restart:` — after anything landed or migrated
 *   fixtures  §Walk readiness `fixtures:` — after anything landed
 *   smoke     §Walk readiness `smoke:` — last, after any of the three above: the dev server answers
 *   tidy      `tidy.mjs apply delete-branch` for branches wholly in the target (and their worktrees)
 *
 * A migration that may drop or rewrite data, a dirty tree in the way of the switch, and every branch
 * or worktree tidy can't settle without a question are HELD: listed, never in `all`. `run` runs the
 * chosen steps in that order, stops at the first that fails (the later ones stand on it), clears the
 * fleet notes the steps settled, and logs to .builder/fleet/logs/wrapup.log. `run` and `dismiss` (the
 * owner's "Not now") both mark this wrap-up done: landings after it start the next one. Refuses while
 * a fleet runs. Never pushes, never touches a remote.
 */
import { existsSync, mkdirSync, openSync, closeSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { requireConfig } from './config.mjs'
import { fleetDir, loadFleet, saveFleet, fleetAlive, parseWalkReadiness, tailArchive } from './fleet-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRAPPED = 'wrapped'
const DAY_MS = 86400000
const ORDER = ['switch', 'migrate', 'restart', 'fixtures', 'smoke', 'tidy']

/** A fleet note about migrations that landed and are not on the dev DB yet: `⚠ <feature>: … landed …`. */
const MIGRATION_NOTE = /^⚠ ([\w.-]+): \d+ new migrations? landed\b/
/** One of those whose migrations may drop or rewrite data — never applied by a wrap-up. */
const DESTRUCTIVE_NOTE = /drops or rewrites data|may drop or rewrite data/
/** A note that only says the target was not checked out when the feature merged. */
const SWITCH_NOTE = /^([\w.-]+) (merged into|brought \d+ new migrations? to) (\S+)/

/** When the last wrap-up ran or was dismissed, as epoch ms — null when none has. */
export function wrappedAt(root) {
  try {
    return statSync(join(fleetDir(root), WRAPPED)).mtimeMs
  } catch {
    return null
  }
}

/** Landings since the last wrap-up (none run → the last day's), from the archive's tail. */
export function landedSinceWrap(root, now = Date.now()) {
  const since = wrappedAt(root) ?? now - DAY_MS
  return tailArchive(root, 20).filter((r) => r?.feature && Date.parse(r.landedAt ?? '') > since)
}

/**
 * The steps, from what is true now — pure, so the tests can feed it a state. → { steps, held }:
 * each step { id, title, commands: [cmd…], settles: [note…] }; each held { title, why }.
 */
export function wrapSteps({ readiness = {}, notes = [], landed = [], target, checkedOut, treeClean = true, tidyItems = [], pending = null }) {
  const steps = []
  const held = []
  const names = (xs) => [...new Set(xs)].join(', ')
  const intoTarget = landed.filter((r) => !r.target || r.target === target)

  if (intoTarget.length && checkedOut && checkedOut !== target) {
    const settles = notes.filter((n) => SWITCH_NOTE.exec(n)?.[3] === target)
    if (treeClean) steps.push({ id: 'switch', title: `check out ${target} — ${names(intoTarget.map((r) => r.feature))} landed there, and it is what you test`, commands: [`git switch ${target}`], settles })
    else held.push({ title: `check out ${target}`, why: `${checkedOut} has uncommitted changes — commit or stash them first` })
  }

  const migrationNotes = notes.filter((n) => MIGRATION_NOTE.test(n))
  const safe = migrationNotes.filter((n) => !DESTRUCTIVE_NOTE.test(n))
  for (const n of migrationNotes.filter((x) => DESTRUCTIVE_NOTE.test(x))) held.push({ title: `${MIGRATION_NOTE.exec(n)[1]}'s migrations`, why: 'one may drop or rewrite data — read it first, then apply it by hand' })
  let migrate = false
  if (safe.length && pending === false) {
    // The dev DB already has them: the notes are settled with nothing to run.
    steps.push({ id: 'migrate', title: 'nothing to apply — the dev DB already has every migration', commands: [], settles: safe })
  } else if (safe.length && readiness.apply) {
    migrate = true
    const features = safe.map((n) => MIGRATION_NOTE.exec(n)[1])
    steps.push({ id: 'migrate', title: `apply the migrations ${names(features)} brought to the dev DB${readiness.regenerate ? ', then regenerate' : ''}`, commands: [readiness.apply, readiness.regenerate].filter(Boolean), settles: safe })
  } else if (safe.length) held.push({ title: 'the landed migrations', why: "§Walk readiness has no `apply:` command — apply them by hand (or add one)" })

  const moved = intoTarget.length > 0 || migrate
  if (readiness.restart && moved) steps.push({ id: 'restart', title: 'restart the dev server, so it runs what landed', commands: [readiness.restart], settles: [] })
  if (readiness.fixtures && intoTarget.length) steps.push({ id: 'fixtures', title: 'reset the dev fixtures', commands: [readiness.fixtures], settles: [] })
  if (readiness.smoke && steps.some((s) => ['migrate', 'restart', 'fixtures'].includes(s.id) && s.commands.length)) steps.push({ id: 'smoke', title: 'check the dev server answers', commands: [readiness.smoke], settles: [] })

  // tidy's `merged` group: wholly in the target, no uncommitted work in its worktree (that one is `ask`).
  const merged = tidyItems.filter((i) => i.group === 'merged' && i.action === 'delete')
  if (merged.length) steps.push({ id: 'tidy', title: `delete ${merged.length === 1 ? 'the branch' : `${merged.length} branches`} already in ${target} (${names(merged.map((i) => i.name))}), with ${merged.length === 1 ? 'its worktree' : 'their worktrees'}`, commands: [`node ${JSON.stringify(join(HERE, 'tidy.mjs'))} apply delete-branch ${merged.map((i) => JSON.stringify(i.name)).join(' ')}`], settles: notes.filter((n) => n.startsWith('repo: ') || /its worktree \S+ stays/.test(n)) })
  const unsettled = tidyItems.filter((i) => !merged.includes(i) && !['none', 'keep'].includes(i.action))
  if (unsettled.length) held.push({ title: `${unsettled.length} other branch${unsettled.length === 1 ? '' : 'es'} or worktree${unsettled.length === 1 ? '' : 's'}`, why: 'each needs a question of its own — /builder:tidy' })

  steps.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
  return { steps, held }
}

/** The live state wrapSteps reads. Asks the dev DB (§Walk readiness `pending:`) only when there are migration notes to settle. */
function gather(cfg) {
  const root = cfg.root
  const fleet = existsSync(join(fleetDir(root), 'fleet.json')) ? loadFleet(root) : { notes: [] }
  const readiness = parseWalkReadiness(cfg.body)
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  let tidyItems = []
  try {
    tidyItems = JSON.parse(execFileSync(process.execPath, [join(HERE, 'tidy.mjs'), 'plan', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CLAUDE_PROJECT_DIR: root } })).items ?? []
  } catch {}
  const notes = fleet.notes ?? []
  let pending = null
  if (readiness.pending && notes.some((n) => MIGRATION_NOTE.test(n))) {
    try {
      execSync(readiness.pending, { cwd: root, stdio: 'ignore', timeout: 2 * 60 * 1000 })
      pending = false
    } catch {
      pending = true
    }
  }
  return {
    fleet,
    state: { readiness, notes, landed: landedSinceWrap(root), target: cfg.mergeInto, checkedOut: git(['branch', '--show-current']), treeClean: git(['status', '--porcelain', '--untracked-files=no']) === '', tidyItems, pending },
  }
}

function markWrapped(root) {
  mkdirSync(fleetDir(root), { recursive: true })
  writeFileSync(join(fleetDir(root), WRAPPED), `${new Date().toISOString()}\n`)
}

export function render({ steps, held }, landed = []) {
  if (!steps.length && !held.length) return 'Nothing to wrap up.'
  const who = landed.map((r) => r.feature)
  const after = who.length > 3 ? `${who.slice(-2).join(', ')} and ${who.length - 2} more` : who.join(', ')
  const lines = [`Wrap-up${who.length ? ` after ${after} landed` : ''} — ${steps.length} step${steps.length === 1 ? '' : 's'}:`]
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s.id} — ${s.title}${s.commands.length ? ` · ${s.commands.map((c) => `\`${c}\``).join(', then ')}` : ''}`))
  if (held.length) lines.push('', 'Held — not in "all":', ...held.map((h) => `- ${h.title} — ${h.why}`))
  return lines.join('\n')
}

function main(argv) {
  const [verb, ...rest] = argv.filter((a) => !a.startsWith('--'))
  const cfg = requireConfig()
  const root = cfg.root
  if (verb === 'dismiss') {
    markWrapped(root)
    console.log('wrap-up dismissed — the next landing starts a new one')
    return 0
  }
  if (verb !== 'plan' && verb !== 'run') {
    console.error('usage: wrapup.mjs plan [--json] | run <all|switch|migrate|restart|fixtures|smoke|tidy…> | dismiss')
    return 2
  }
  if (fleetAlive(root)) {
    console.log('a fleet is running here — wrap up once it has finished (/builder:fleet:status says when)')
    return verb === 'plan' ? 0 : 1
  }
  const { fleet, state } = gather(cfg)
  const plan = wrapSteps(state)
  if (verb === 'plan') {
    console.log(argv.includes('--json') ? JSON.stringify({ ...plan, landed: state.landed.map((r) => r.feature) }, null, 2) : render(plan, state.landed))
    return 0
  }
  const want = rest.includes('all') ? plan.steps.map((s) => s.id) : rest
  const unknown = want.filter((id) => !plan.steps.some((s) => s.id === id))
  if (!want.length || unknown.length) {
    console.error(unknown.length ? `not a step here now: ${unknown.join(', ')} — wrapup.mjs plan lists them` : 'name the steps, or all')
    return 2
  }
  const log = join(fleetDir(root), 'logs', 'wrapup.log')
  mkdirSync(dirname(log), { recursive: true })
  const settled = new Set()
  let failed = null
  for (const s of plan.steps.filter((x) => want.includes(x.id))) {
    if (failed) {
      console.log(`– ${s.id} — not run: ${failed} failed first`)
      continue
    }
    try {
      for (const cmd of s.commands) {
        const fd = openSync(log, 'a')
        try {
          writeFileSync(fd, `\n$ ${cmd}\n`)
          execSync(cmd, { cwd: root, stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000, env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
        } finally {
          closeSync(fd)
        }
      }
      for (const n of s.settles) settled.add(n)
      console.log(`✓ ${s.id} — ${s.title}`)
    } catch {
      failed = s.id
      console.log(`✗ ${s.id} — failed; see ${log}`)
    }
  }
  if (settled.size) {
    fleet.notes = (fleet.notes ?? []).filter((n) => !settled.has(n))
    saveFleet(root, fleet)
  }
  if (!failed) markWrapped(root)
  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
