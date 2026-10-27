#!/usr/bin/env node
/**
 * archive — the registry back to work in flight. Finished folders leave `<registry>/` for
 * `<registry>/_archive/`, each keeping only its SPEC.md (PROGRAM.md for a program) under a header
 * that says how it ended; everything else in the folder goes, because `git log -- <folder>` keeps
 * it. /builder:archive drives it: `plan` is the review, `apply` the one confirmed change.
 *
 *   node <plugin>/scripts/archive.mjs plan [--into <branch>] [--days N] [--json | --summary]
 *   node <plugin>/scripts/archive.mjs apply <name>… [--into <branch>] [--days N] [--drop "<reason>"] [--no-commit]
 *
 * What it judges finished (tier `finished`, the recommended batch):
 *   shipped   — says it shipped (registry.mjs isShippedFolder) but was never moved → archived as it reads
 *   verified  — verify READY, its code in the target, no ship ran (a manual merge, a `build: here`
 *               feature, a PR merged first) → `condense.mjs --ship --merged <sha>`: `✅ SHIPPED — merged <sha>`
 *   merged    — built (or signed off) and in the target, never verified, untouched for --days (14)
 *               → `✅ CLOSED <date> — merged <sha>, not walked` (`walked, not verified` once signed off)
 *   leftovers — an archived folder still holding a PLAN, manifest or ledger beside its SPEC (moved by
 *               hand), or a `.builder/<name>` workspace of an archived feature → trimmed / removed
 * What it offers only when asked (tier `old`):
 *   abandoned — spec … building, no commit to the folder or its branch for 4 × --days (56)
 *               → `✖ DROPPED <date> — no activity since <date>` (or --drop's reason)
 *   legacy    — a folder with no SPEC.md and no manifest (an earlier pipeline's docs, analysis notes)
 *               → moved as it is: never delete a folder's only docs
 *
 * "In the target" is read from the checkout: apply runs on the target branch (merge_into, or
 * --into), so a folder there at `state: built` got there by a merge (the pipeline commits each state
 * on the feature's branch) or was built there. A folder with uncommitted changes, a feature building
 * in a session right now, or a fleet row in flight is never touched.
 *
 * Trimming keeps SPEC.md / PROGRAM.md and any file the SPEC names — a converted folder's SPEC is an
 * index into the old docs, which stay — and always removes PLAN.md, MANIFEST.md, PARKED.md,
 * continue.md, progress/ledger files and TASK*-RESULT files. A folder with no SPEC is moved whole.
 *
 * apply: one commit, `docs(archive): <n> folders — <names>`; its workspaces removed; archived fleet
 * logs past keep_logs pruned. Refuses (nothing touched) while the registry has uncommitted changes
 * or HEAD is not the target. Names apply's plan did not list are refused unless --drop gives a reason
 * (the owner dropping a feature archive would not have judged abandoned).
 */
import { existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireConfig } from './config.mjs'
import { features, ARCHIVE, isShippedFolder, isArchived } from './registry.mjs'
import { parseManifest, isSet } from './manifest.mjs'
import { read, writeAtomic, git as gitStrict, today, cli, parseArgs, workspaceDir } from './feature-core.mjs'
import { stripPlan, setHeader, ship } from './condense.mjs'
import { newerThanArchive } from './brainstorm-file.mjs'
import { buildingInSession, loadFleet, fleetDir, fleetAlive, pruneArchivedLogs } from './fleet-core.mjs'

const git = (root, args) => gitStrict(root, args, { allowFail: true })
const DAY = 86400000

/** Files that are only ever the pipeline's working state — never the record. */
const ALWAYS_GO = /^(PLAN|MANIFEST|PARKED)\.md$|^continue\.md$|^progress\.md$|^ledger\.md$|^TASK[\w-]*RESULT[\w-]*(\.md)?$/i
const KEEP_DOCS = ['SPEC.md', 'PROGRAM.md']

/** The commit that brought a folder into this checkout: the manifest's `head:` when this branch has
 *  it (the sha the feature was built and verified at), else the last commit touching the folder. */
function mergedSha(root, rel, mf) {
  const head = isSet(mf.head) ? String(mf.head).trim().split(/\s+/)[0] : null
  if (head && git(root, ['merge-base', '--is-ancestor', head, 'HEAD']) !== null) return git(root, ['rev-parse', '--short', head])
  return git(root, ['log', '-1', '--format=%h', '--', rel])
}

/** When the folder, or its branch, last moved — the later of the two, as epoch ms (0 = never committed). */
function lastMoved(root, rel, mf, name, mainline = []) {
  const at = (args) => Number(git(root, args) ?? 0) * 1000
  const folder = at(['log', '-1', '--format=%ct', '--', rel])
  const branch = isSet(mf.branch) ? String(mf.branch).trim() : `builder/${name}`
  // A feature built on the target itself (`build: here`) has no branch of its own: the target's last
  // commit is everyone's, and would keep it looking busy for ever.
  const own = !mainline.includes(branch)
  const onBranch = own && git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null ? at(['log', '-1', '--format=%ct', `refs/heads/${branch}`]) : 0
  return Math.max(folder, onBranch)
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * Every folder archive could act on, each { name, kind, tier, action, why, sha?, path, moved }.
 * `left` lists live folders it leaves alone and why — in flight, uncommitted, running.
 */
export function plan(root, cfg, { target = cfg.mergeInto, days = 14, now = Date.now() } = {}) {
  const reg = cfg.registry
  const items = []
  const left = []
  const fleet = existsSync(join(fleetDir(root), 'fleet.json')) ? loadFleet(root) : null
  const alive = fleet ? fleetAlive(root) : false
  const onTarget = git(root, ['branch', '--show-current']) === target
  for (const name of features(root, reg).sort()) {
    const rel = `${reg}/${name}`
    const dir = join(root, rel)
    const mfText = read(join(dir, 'MANIFEST.md'))
    const mf = mfText ? parseManifest(mfText) : {}
    const hasSpec = existsSync(join(dir, 'SPEC.md'))
    const hasProgram = existsSync(join(dir, 'PROGRAM.md'))
    const row = fleet?.features?.[name]
    const moved = lastMoved(root, rel, mf, name, [target, cfg.baseBranch])
    const add = (kind, tier, action, why, extra = {}) => items.push({ name, kind, tier, action, why, path: rel, moved: moved ? isoDay(moved) : null, ...extra })
    if (git(root, ['status', '--porcelain', '--', rel])) {
      left.push({ name, why: 'uncommitted changes in the folder' })
      continue
    }
    if ((alive && row && !['done', 'parked', 'failed'].includes(row.status)) || buildingInSession(root, name, mf, now)) {
      left.push({ name, why: 'running now' })
      continue
    }
    if (isArchived(root, reg, name)) {
      left.push({ name, why: `${reg}/${ARCHIVE}/${name} already exists — two folders of one name would make "has it shipped?" answer for the wrong one` })
      continue
    }
    if (isShippedFolder(dir)) {
      add('shipped', 'finished', 'archive', 'says it shipped; never moved into the archive', { sha: mergedSha(root, rel, mf) })
      continue
    }
    const condensed = !mfText && hasSpec ? (read(join(dir, 'SPEC.md')) ?? '').slice(0, 1200) : ''
    const state = mfText ? mf.state : /^> (✅ SIGNED OFF|🤖 AGENT SIGNED OFF)/m.test(condensed) ? 'signed-off' : null
    const ready = /^READY\b/.test(mf.verify ?? '')
    const idle = now - moved > days * DAY
    if (mf.tier === 'program') {
      // A program archives itself when its last child ships; one whose children all ended some other
      // way (a child closed or dropped here) never gets that ship, so it is offered here instead.
      const kids = (mf.children ?? []).map((c) => /—\s*(shipped|closed|dropped)\b/.exec(c)?.[1] ?? null)
      if (kids.length && kids.every(Boolean)) {
        const n = (k) => kids.filter((x) => x === k).length
        add('program', 'finished', 'program', `every child ended — ${['shipped', 'closed', 'dropped'].filter(n).map((k) => `${n(k)} ${k}`).join(', ')}`, { kids: { shipped: n('shipped'), closed: n('closed'), dropped: n('dropped') } })
      } else left.push({ name, why: 'a program — it archives itself when its last child ships' })
      continue
    }
    if (onTarget && mfText && ready && ['verified', 'signed-off'].includes(state)) {
      add('verified', 'finished', 'ship', `verify READY and in ${target}; no ship ran`, { sha: mergedSha(root, rel, mf) })
      continue
    }
    if (onTarget && ['built', 'signed-off', 'verified'].includes(state)) {
      if (!idle) {
        left.push({ name, why: `${state}, last moved ${moved ? isoDay(moved) : 'never'} — still in hand; archive closes one after ${days} days` })
        continue
      }
      const walked = state !== 'built' || /^agent-pass/.test(mf.walk ?? '')
      add('merged', 'finished', 'close', `${state} and in ${target}; ${walked ? 'never verified' : 'never walked'}`, { sha: mergedSha(root, rel, mf), walked })
      continue
    }
    if (['spec', 'aligned', 'audited', 'planned', 'building'].includes(state)) {
      if (now - moved > 4 * days * DAY) add('abandoned', 'old', 'drop', `${state}; nothing moved since ${moved ? isoDay(moved) : 'it was written'}`, { reason: `no activity since ${moved ? isoDay(moved) : 'it was written'}` })
      else left.push({ name, why: `${state} — in flight` })
      continue
    }
    if (!mfText && !hasSpec && !hasProgram) {
      add('legacy', 'old', 'move', 'no SPEC.md and no manifest — an earlier pipeline\'s docs or notes; moved as it is')
      continue
    }
    const why = !mfText && hasSpec && !state ? 'a SPEC with no manifest — incomplete; /builder:resume writes the missing one' : !onTarget && state ? `${state} — archive judges merged work on ${target}` : `${state ?? 'no state'} — in flight`
    left.push({ name, why })
  }
  // Archived folders that still hold working files (moved by hand, or by a ship before 5.4).
  const archDir = join(root, reg, ARCHIVE)
  for (const name of existsSync(archDir) ? readdirSync(archDir).filter((n) => !n.startsWith('.')).sort() : []) {
    const dir = join(archDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!git(root, ['status', '--porcelain', '--', `${reg}/${ARCHIVE}/${name}`]) && trimList(root, dir).length)
      items.push({ name, kind: 'leftovers', tier: 'finished', action: 'trim', why: `archived, still holding ${trimList(root, dir).join(', ')}`, path: `${reg}/${ARCHIVE}/${name}`, moved: null })
  }
  // Workspaces of features that are archived and not live — a fleet ship removes the worktree's, not this checkout's.
  for (const name of orphanWorkspaces(root, reg)) items.push({ name, kind: 'leftovers', tier: 'finished', action: 'workspace', why: `.builder/${name} of an archived feature`, path: `.builder/${name}`, moved: null })
  return { target, onTarget, days, items, left }
}

/** `.builder/<name>` and `.builder/kept/<name>` whose name is archived and has no live folder. */
function orphanWorkspaces(root, reg) {
  const base = join(root, '.builder')
  const names = (d) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[_.]/.test(e.name)).map((e) => e.name)
    } catch {
      return []
    }
  }
  const out = []
  // A brainstorm newer than the archiving is a new conversation reusing the name — never a leftover.
  for (const n of names(base).filter((n) => !['fleet', 'kept'].includes(n))) if (isArchived(root, reg, n) && !existsSync(join(root, reg, n)) && !newerThanArchive(root, reg, n)) out.push(n)
  for (const n of names(join(base, 'kept'))) if (isArchived(root, reg, n) && !existsSync(join(root, reg, n))) out.push(`kept/${n}`)
  return [...new Set(out)].sort()
}

/** The tracked top-level entries of a folder that trimming removes — none when it has no SPEC or PROGRAM. */
export function trimList(root, dir) {
  const doc = KEEP_DOCS.map((d) => read(join(dir, d))).filter((t) => t != null)
  if (!doc.length) return []
  const text = doc.join('\n')
  const rel = dir.slice(root.length + 1)
  const tracked = (git(root, ['ls-files', '--', rel]) ?? '').split('\n').filter(Boolean)
  const tops = [...new Set(tracked.map((p) => p.slice(rel.length + 1).split('/')[0]))]
  const named = (e) => text.includes(e)
  return tops.filter((e) => !KEEP_DOCS.includes(e) && (ALWAYS_GO.test(e) || !named(e))).sort()
}

function trim(root, dir) {
  const gone = trimList(root, dir)
  const rel = dir.slice(root.length + 1)
  for (const e of gone) gitStrict(root, ['rm', '-r', '-q', '-f', '--', `${rel}/${e}`])
  return gone
}

/** Header line(s) under the title, the §Plan index cut (its PLAN.md goes with the trim). */
function writeHeader(dir, line) {
  for (const d of KEEP_DOCS) {
    const p = join(dir, d)
    const text = read(p)
    if (text == null) continue
    if (!/^# /m.test(text)) return false
    const next = setHeader(stripPlan(text), [line])
    if (next !== text) writeAtomic(p, next)
    return true
  }
  return false
}

function moveIn(root, reg, name) {
  mkdirSync(join(root, reg, ARCHIVE), { recursive: true })
  gitStrict(root, ['add', '-A', '--', `${reg}/${name}`])
  gitStrict(root, ['mv', `${reg}/${name}`, `${reg}/${ARCHIVE}/${name}`])
  return join(root, reg, ARCHIVE, name)
}

/**
 * A program child that ended here — shipped as it read, closed or dropped — says so on its program's
 * `child:` line, so the program can end too (plan offers a program whose children all ended) instead
 * of waiting for good on a ship that never comes. → what it wrote, or null for no program child.
 */
function settleChild(root, reg, name, state) {
  if (!state) return null
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const prog of features(root, reg)) {
    const mp = join(root, reg, prog, 'MANIFEST.md')
    const text = read(mp)
    if (!text || parseManifest(text).tier !== 'program') continue
    const next = text.replace(new RegExp(`^child:\\s*${esc}(\\s.*)?$`, 'm'), `child: ${name} — ${state}`)
    if (next === text) continue
    writeAtomic(mp, next)
    return `program ${prog}: child ${name} — ${state}`
  }
  return null
}

function dropWorkspace(root, name) {
  for (const ws of [workspaceDir(root, name, { create: false }), join(root, '.builder', 'kept', name)]) rmSync(ws, { recursive: true, force: true })
}

/** One item, done. → the line apply prints. Throws on a refusal; the caller says which folder. */
function applyOne(root, cfg, target, it, dropReason) {
  const reg = cfg.registry
  const date = today()
  if (it.action === 'workspace') {
    rmSync(join(root, '.builder', it.name), { recursive: true, force: true })
    return `✓ ${it.path} — removed`
  }
  if (it.action === 'trim') return `✓ ${it.name} — trimmed: ${trim(root, join(root, it.path)).join(', ')} removed`
  const dir = join(root, reg, it.name)
  const action = it.action
  if (action === 'ship') {
    ship({ _: [dir], merged: it.sha, into: target, 'no-commit': true })
    const arch = join(root, reg, ARCHIVE, it.name)
    const gone = trim(root, arch)
    return `✓ ${it.name} — shipped (merged ${it.sha})${gone.length ? `; ${gone.join(', ')} removed` : ''}`
  }
  let header = null
  if (action === 'archive') {
    const spec = read(join(dir, 'SPEC.md'))
    if (spec != null && !/^> ✅ SHIPPED/m.test(spec.slice(0, 1200))) header = `> ✅ SHIPPED ${date} — merged ${it.sha}`
  }
  if (action === 'close') header = `> ✅ CLOSED ${date} — merged ${it.sha}, ${it.walked ? 'walked, not verified' : 'not walked'}`
  if (action === 'drop') header = `> ✖ DROPPED ${date} — ${dropReason ?? it.reason}`
  if (action === 'program') {
    const k = it.kids
    const tally = ['shipped', 'closed', 'dropped'].filter((x) => k[x]).map((x) => `${k[x]} ${x}`).join(', ')
    header = k.shipped || k.closed ? `> ✅ ${k.shipped && !k.closed ? 'SHIPPED' : 'CLOSED'} ${date} — every child ended: ${tally}` : `> ✖ DROPPED ${date} — every child dropped`
  }
  const hasDoc = KEEP_DOCS.some((d) => existsSync(join(dir, d)))
  if (header && hasDoc && !writeHeader(dir, header)) throw new Error(`its ${existsSync(join(dir, 'SPEC.md')) ? 'SPEC.md' : 'PROGRAM.md'} has no "# " title line to put the header under`)
  const gone = hasDoc && action !== 'move' ? trim(root, dir) : []
  moveIn(root, reg, it.name)
  dropWorkspace(root, it.name)
  const parent = settleChild(root, reg, it.name, { archive: 'shipped', close: 'closed', drop: 'dropped' }[action])
  const what = { archive: 'archived', close: 'closed (not shipped)', drop: 'dropped', move: 'moved as it is', program: 'archived (program)' }[action]
  return `✓ ${it.name} — ${what}${gone.length ? `; ${gone.join(', ')} removed` : ''}${parent ? `; ${parent}` : ''}`
}

/**
 * Undo one item that failed half-way — a header written, files `git rm`'d, the folder moved — so the
 * batch's commit never carries a half-archived folder. The registry was clean when apply began
 * (it refuses otherwise), so HEAD is the state to go back to. → whether it got there.
 */
function rollback(root, reg, it) {
  if (it.action === 'workspace') return true
  const live = it.path.startsWith(`${reg}/${ARCHIVE}/`) ? null : `${reg}/${it.name}`
  const arch = `${reg}/${ARCHIVE}/${it.name}`
  const paths = [live, arch].filter(Boolean)
  git(root, ['reset', '-q', '--', ...paths])
  if (live) {
    git(root, ['checkout', '-q', 'HEAD', '--', live])
    // The archive held no folder of this name (plan refuses one), so whatever is there is this move's.
    git(root, ['clean', '-fdq', '--', arch])
  } else git(root, ['checkout', '-q', 'HEAD', '--', arch])
  return !git(root, ['status', '--porcelain', '--', ...paths])
}

export function apply(root, cfg, names, { target = cfg.mergeInto, days = 14, drop = null, commit = true } = {}) {
  const reg = cfg.registry
  // `drop`: one reason for every name, or { name: reason } — so a batch mixing drops and the rest is one commit.
  const dropFor = (name) => (drop && typeof drop === 'object' ? (drop[name] ?? null) : drop)
  const p = plan(root, cfg, { target, days })
  if (!p.onTarget) return { ok: false, lines: [`archive runs on ${target}, where merged work is — switch to it (git switch ${target}). Nothing was changed.`] }
  const dirty = git(root, ['status', '--porcelain', '--', reg])
  if (dirty) return { ok: false, lines: [`uncommitted changes under ${reg} — commit or stash them first. Nothing was changed.\n${dirty}`] }
  const lines = []
  const done = []
  let refused = 0
  for (const name of names) {
    let it = p.items.find((i) => i.name === name || i.path === name)
    // The owner dropping a feature archive left alone as in flight: their call, with their reason —
    // never one running, uncommitted, or whose name the archive already holds.
    const why = p.left.find((l) => l.name === name)?.why
    if (!it && dropFor(name) && why && !/running now|uncommitted|already exists|a program/.test(why)) it = { name, kind: 'abandoned', tier: 'old', action: 'drop', path: `${reg}/${name}` }
    if (!it) {
      refused++
      lines.push(`✗ ${name} — ${why ? `left alone: ${why}` : 'not a folder archive would act on'}`)
      continue
    }
    try {
      lines.push(applyOne(root, cfg, target, it, it.action === 'drop' ? dropFor(name) : null))
      if (it.action !== 'workspace') done.push(it.name)
    } catch (e) {
      refused++
      const back = rollback(root, reg, it)
      lines.push(`✗ ${name} — ${e.message}${back ? ' — put back as it was' : ` — could not be put back: check git status -- ${it.path}`}`)
    }
  }
  const pruned = pruneArchivedLogs(root, cfg.agentWalk?.keepLogs ?? 30)
  if (pruned) lines.push(`✓ fleet logs — ${pruned} archived log file${pruned === 1 ? '' : 's'} pruned`)
  if (done.length && commit) {
    const pending = git(root, ['status', '--porcelain', '--', reg])
    if (pending) {
      gitStrict(root, ['add', '-A', '--', reg])
      const shown = done.length > 4 ? `${done.slice(0, 4).join(', ')} and ${done.length - 4} more` : done.join(', ')
      gitStrict(root, ['commit', '-q', '-m', `docs(archive): ${done.length} folder${done.length === 1 ? '' : 's'} — ${shown}`, '--', reg])
      lines.push(`committed: ${git(root, ['log', '-1', '--format=%h %s'])}`)
    }
  }
  return { ok: !refused, lines }
}

/** One line for /builder:status and /builder:tidy. */
export function summaryLine(p) {
  const finished = p.items.filter((i) => i.tier === 'finished').length
  const old = p.items.filter((i) => i.tier === 'old').length
  if (!finished && !old) return 'registry: clean'
  return `registry: ${[finished && `${finished} finished`, old && `${old} old`].filter(Boolean).join(' · ')} to archive → /builder:archive`
}

const KIND = { program: 'Program, every child ended', shipped: 'Shipped, not archived', verified: 'Verified, merged — ship it', merged: 'Merged, never verified — close as is', leftovers: 'Leftovers', abandoned: 'Looks abandoned — drop', legacy: 'Old docs — move as is' }

function render(cfg, p) {
  const out = [`**${cfg.project}** — the registry against ${p.target}\n`]
  if (!p.onTarget) out.push(`On another branch: merged work is judged on ${p.target} — switch to it to archive.\n`)
  const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
  for (const tier of ['finished', 'old']) {
    const rows = p.items.filter((i) => i.tier === tier)
    if (!rows.length) continue
    out.push(tier === 'finished' ? '**Finished** — archived on your go-ahead:\n' : '**Old** — archived only if you say so:\n')
    out.push('| Folder | What it is | Becomes | Last moved |', '|---|---|---|---|')
    for (const i of rows) {
      const becomes = { archive: 'SHIPPED (as it reads)', ship: `SHIPPED — merged ${i.sha}`, close: `CLOSED — merged ${i.sha}, ${i.walked ? 'walked, not verified' : 'not walked'}`, drop: `DROPPED — ${i.reason}`, move: 'moved as it is', trim: 'trimmed to its SPEC', workspace: 'removed', program: 'archived with its PROGRAM.md' }[i.action]
      out.push(`| ${cell(i.path)} | ${cell(`${KIND[i.kind]}: ${i.why}`)} | ${cell(becomes)} | ${cell(i.moved)} |`)
    }
    out.push('')
  }
  if (p.left.length) out.push(`Left alone: ${p.left.map((l) => `${l.name} (${l.why})`).join(' · ')}\n`)
  out.push(summaryLine(p))
  return out.join('\n')
}

async function main(argv) {
  const a = parseArgs(argv, { bool: ['json', 'summary', 'no-commit'], repeat: ['drop'] })
  const cfg = requireConfig()
  const target = a.into ?? cfg.mergeInto
  const days = Number(a.days) > 0 ? Number(a.days) : 14
  const [verb, ...names] = a._
  if (verb === 'plan') {
    const p = plan(cfg.root, cfg, { target, days })
    console.log(a.json ? JSON.stringify(p, null, 2) : a.summary ? summaryLine(p) : render(cfg, p))
    return 0
  }
  if (verb === 'apply' && names.length) {
    // --drop "<reason>" (every name) or --drop "<name>=<reason>", repeatable.
    const drops = a.drop ?? []
    const named = drops.filter((d) => /^[\w.-]+=/.test(d))
    const drop = named.length ? Object.fromEntries(named.map((d) => [d.slice(0, d.indexOf('=')), d.slice(d.indexOf('=') + 1)])) : (drops.at(-1) ?? null)
    const r = apply(cfg.root, cfg, names, { target, days, drop, commit: !a['no-commit'] })
    for (const l of r.lines) console.log(l)
    return r.ok ? 0 : 1
  }
  console.error('usage: archive.mjs plan [--into <branch>] [--days N] [--json | --summary] | apply <name>… [--into <branch>] [--drop "<reason>" | --drop "<name>=<reason>"…] [--no-commit]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(main)
