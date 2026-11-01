#!/usr/bin/env node
// scripts/verify/verify.mjs
/**
 * verify — the verifier's client (docs/specs/2026-10-27-verifier-design.md). Builds, skills and the
 * fleet call this; it writes requests, starts the service when none runs, and reads verdicts.
 *
 *   verify.mjs request <worktree> <sha|HEAD> --tier commit|phase|merge [--target <b>] [--hold] [--since <sha>] [--message <m>] [--tree]
 *   verify.mjs release <request>   (a held green merge → land it; exit 7 if the target moved, 1 if the checkout refused — then, when your uncommitted changes overlap the feature, an `overlap: <JSON list>` line)
 *   verify.mjs carry <request>     (land a held green merge's branch tip when it added only registry commits; exit 2 if code changed)
 *   verify.mjs verdict <branch> [<sha>] [--tier commit|phase|merge] [--json]   (a `pending: <tier> <state> <id>` line per run still going — after a finished verdict, those newer than it; an id to wait on)
 *   verify.mjs wait <request> [--max <seconds>] [--json]       (default 540 — under one 10-minute Bash call)
 *   verify.mjs cancel <request>
 *   verify.mjs status [--json]
 *   (each takes --in <worktree>, default the cwd; the ledger is the main checkout's)
 *
 * Exit: 0 green · 1 red (release: the checkout refused the fast-forward) · 2 usage · 3 env-broken · 4 conflict · 5 gone/none · 6 cancelled · 7 target moved (release) · 75 pending.
 */
import { spawn } from 'node:child_process'
import { openSync, closeSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, tryGit, mainRoot } from './git.mjs'
import { land, ensureCheckout, mergedCheckout } from './checkouts.mjs'
import { openLedger, verifyDir } from './ledger.mjs'
import { serviceAlive } from './serve.mjs'
import { loadConfig } from '../config.mjs'

const SERVE = fileURLToPath(new URL('./serve.mjs', import.meta.url))
const USAGE = 'usage: verify.mjs request <worktree> <sha|HEAD> --tier commit|phase|merge [--target <branch>] [--hold] [--since <sha>] [--message <text>] [--tree] | release <request> | carry <request> | verdict <branch> [<sha>] [--tier commit|phase|merge] [--json] | wait <request> [--max <seconds>] [--json] | cancel <request> | status [--json]   (each: [--in <worktree>])'
const EXIT = { green: 0, red: 1, 'env-broken': 3, conflict: 4, gone: 5, cancelled: 6 }
export const exitFor = (status) => EXIT[status] ?? 75

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
/**
 * The lines of a failure message worth printing. A test's own failure message is already the failure: its
 * lines less the stack frames, so the values (`1 !== 2`, a diff, jest's Expected/Received) stay. Raw check
 * output (`compare: exit`) is filtered to the lines that say what failed (FAIL, ✗, ✖, error, expected — any
 * case), each with the line after it; else its last 6 lines.
 */
/** A message whose first line names a thrown error (`TypeError: …`, `Error: …`) — not an assertion failure, whose values tell the story. */
const THROWN = /^\s*(Uncaught\s+)?([A-Z]\w*)?Error(\s\[\w+\])?:\s/
const isThrown = (first) => THROWN.test(first) && !/^\s*(Uncaught\s+)?AssertionError\b|ERR_ASSERTION/.test(first)
function failingLines(msg, raw = false) {
  const all = String(msg ?? '').split('\n')
  if (!raw) {
    // Stack frames are noise — except a thrown error's first one, which says where it was thrown.
    const frame = isThrown(all.find((l) => l.trim()) ?? '') ? all.findIndex((l) => /^\s*at\s/.test(l)) : -1
    return all.filter((l, i) => l.trim() && (i === frame || !/^\s*at\s/.test(l))).slice(0, 12)
  }
  const keep = new Set()
  const hits = all.flatMap((l, i) => (/fail|✗|✖|error|expected/i.test(l) ? [i] : [])).slice(-6)
  for (const i of hits) {
    keep.add(i)
    const next = all.findIndex((l, k) => k > i && l.trim())
    if (next > 0) keep.add(next)
  }
  return hits.length ? [...keep].sort((a, b) => a - b).map((i) => all[i]) : all.filter((l) => l.trim()).slice(-6)
}
export function summarize(v) {
  const head = [
    `verify ${v.tier} ${String(v.sha).slice(0, 7)} ${v.branch}: ${String(v.status).toUpperCase()}`,
    v.regressions.length && plural(v.regressions.length, 'regression'),
    v.flakes.length && plural(v.flakes.length, 'flake'),
    v.known.length && `${v.known.length} known`,
    v.debt?.length && `${v.debt.length} newly found debt`,
    v.broken.length && `${v.broken.length} broken`,
    v.reused && `${v.reused} reused`,
    v.untested && 'untested — the config has no verify: block',
    `${Math.round((v.ms ?? 0) / 1000)}s`,
  ].filter(Boolean)
  const lines = [head.join(' · ')]
  for (const g of v.regressions) {
    lines.push(`  ✗ ${g.id} — introduced by ${String(g.introducedBy).slice(0, 7)}${g.note ? ` (${g.note})` : ''}`)
    for (const l of failingLines(g.msg, g.raw)) lines.push(`      ${l}`)
  }
  for (const b of v.broken) lines.push(`  ⚠ ${b.suite}: ${b.reason}`)
  if (v.files?.length) lines.push(`  conflict in: ${v.files.join(', ')}`)
  if (v.landed) lines.push(`  landed: ${v.landed.slice(0, 7)}`)
  if (v.held) lines.push(`  held: tested ${String(v.merged).slice(0, 7)} — verify.mjs release lands it`)
  const sel = Object.entries(v.selection ?? {}).map(([s, x]) => `${s} ${x.files === 'all' ? 'all' : x.files === 0 ? 'none' : plural(x.files, 'file')}`)
  if (sel.length) lines.push(`  selection: ${sel.join(', ')}`)
  return lines.join('\n')
}

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const opt = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : null
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--tier', '--target', '--since', '--message', '--max', '--in'].includes(argv[i - 1]))
const die = (m) => {
  console.error(m)
  process.exit(2)
}

/** Keys a client's env may carry that belong to that client alone — a walk lane, a worktree, a test runner. */
const CLIENT_KEYS = ['CLAUDE_PROJECT_DIR', 'BUILDER_FLEET_DIR', 'PORT', 'DATABASE_URL', 'TEST_DATABASE_URL', 'NODE_TEST_CONTEXT']

/**
 * The env the service runs every test in: the starting client's, less what is that client's own.
 * Whichever client happens to start the service — a walk lane, a fleet worktree, a test — must not
 * decide the database or port every later run uses.
 */
export function serviceEnv(root, env = process.env) {
  const cfg = loadConfig(root)
  const walk = cfg.ok ? cfg.agentWalk : null
  const drop = new Set([...CLIENT_KEYS, ...Object.keys(walk?.env ?? {}), ...Object.keys(walk?.worktreeEnv ?? {})])
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)))
}

export function ensureService(root) {
  // A live pid with a stale heartbeat is not a service: the pid was reused after it died.
  if (serviceAlive(root)) return
  const log = openSync(join(verifyDir(root), 'serve.log'), 'a')
  const idle = process.env.BUILDER_VERIFY_IDLE_MS
  spawn(process.execPath, ['-e', `import(${JSON.stringify(SERVE)}).then((m) => m.runService(${JSON.stringify(root)}${idle ? `, { idleMs: ${Number(idle)} }` : ''}))`], { detached: true, stdio: ['ignore', log, log], env: serviceEnv(root) }).unref()
  closeSync(log)
}

function show(req, json) {
  const v = req.verdict
  if (json) console.log(JSON.stringify(v, null, 2))
  else console.log(summarize(v))
  process.exit(exitFor(v.status))
}

/** The request, if it is a held green merge; else exit 2. */
function heldGreen(ledger, id) {
  const r = id && ledger.getRequest(id)
  const v = r?.verdict
  if (!r || r.tier !== 'merge' || r.state !== 'done' || v?.status !== 'green' || !v.held) die(`${id}: not a held green merge — nothing to release`)
  return r
}

/** What it tested is no longer what would land: not held any more, so the next request runs anew. Exits 7. */
function unhold(ledger, r, reason) {
  // Re-read: only the verdict's own fields change, and a concurrent writer's other fields stand.
  const cur = ledger.getRequest(r.id) ?? r
  ledger.saveRequest({ ...cur, verdict: { ...cur.verdict, held: false } })
  console.log(`${r.id}: target moved — request the merge again (${reason})`)
  process.exit(7)
}

/** Fast-forward the target to `tested` against the tip the merge tier ran on, and record it on the verdict. */
function landHeld(root, ledger, r, tested, extra = {}) {
  const v = r.verdict
  const l = land(root, r.target, tested, v.targetSha)
  if (!l.ok) {
    // The target still where it was tested: git refused the fast-forward (work in the way), not a move.
    if (tryGit(root, 'rev-parse', `refs/heads/${r.target}`) === v.targetSha) {
      // The user's edits overlap the feature: said, then every file as one JSON line the fleet reads.
      if (l.overlap?.length) console.log(`${r.id}: ${r.target} refused the fast-forward (${l.reason})\noverlap: ${JSON.stringify(l.overlap)}`)
      else console.log(`${r.id}: ${r.target} refused the fast-forward (${l.reason.replace(/\s+/g, ' ')}) — uncommitted changes there?`)
      process.exit(1)
    }
    unhold(ledger, r, l.reason)
  }
  const cur = ledger.getRequest(r.id) ?? r
  ledger.saveRequest({ ...cur, verdict: { ...cur.verdict, held: false, landed: tested, ...extra } })
}

async function main() {
  const [cmd] = positional
  if (!cmd || flag('--help')) die(USAGE)
  const here = resolve(opt('--in') ?? (cmd === 'request' ? positional[1] ?? '.' : '.'))
  const root = mainRoot(here)
  const ledger = openLedger(root)

  if (cmd === 'request') {
    const [, wtArg, shaArg] = positional
    const tier = opt('--tier')
    if (!wtArg || !shaArg || !['commit', 'phase', 'merge'].includes(tier)) die(USAGE)
    const wt = resolve(wtArg)
    const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')
    const sha = flag('--tree') ? tryGit(wt, 'stash', 'create') || git(wt, 'rev-parse', 'HEAD') : git(wt, 'rev-parse', shaArg)
    const cfg = loadConfig(root)
    const target = opt('--target') ?? (cfg.ok ? cfg.mergeInto : 'main')
    const req = ledger.newRequest({ worktree: wt, branch, sha, tier, target, ...(flag('--hold') && tier === 'merge' && { hold: true }), ...(opt('--since') && { since: git(wt, 'rev-parse', opt('--since')) }), ...(opt('--message') && { message: opt('--message') }) })
    ensureService(root)
    console.log(req.id)
    return
  }
  if (cmd === 'verdict') {
    const [, branch, sha] = positional
    if (!branch) die(USAGE)
    const tier = opt('--tier')
    if (flag('--tier') && !['commit', 'phase', 'merge'].includes(tier)) die(USAGE)
    // A tier filter keeps a newer phase-tier green from answering a question about the merge tier.
    const mine = ledger.requests((r) => r.branch === branch && (!tier || r.tier === tier))
    const isPending = (r) => ['queued', 'running', 'folded'].includes(r.state)
    const full = sha ? tryGit(here, 'rev-parse', sha) ?? sha : null
    const done = mine.filter((r) => r.state === 'done' && r.verdict && (!full || r.sha === full)).at(-1)
    // One line per pending request, so a caller has an id to `wait` on rather than queueing another run.
    const printPending = (list) => { for (const r of list) console.log(`pending: ${r.tier} ${r.state} ${r.id}`) }
    if (done) {
      const json = flag('--json')
      if (json) console.log(JSON.stringify(done.verdict, null, 2))
      else {
        console.log(summarize(done.verdict))
        // A newer run still going would replace this verdict: name it, the exit stays this verdict's.
        printPending(mine.slice(mine.indexOf(done) + 1).filter(isPending))
      }
      process.exit(exitFor(done.verdict.status))
    }
    const pending = mine.filter(isPending)
    console.log(pending.length ? `verify ${branch}: pending (${pending.map((r) => `${r.tier} ${r.state}`).join(', ')})` : `verify ${branch}: no verdict`)
    printPending(pending)
    process.exit(pending.length ? 75 : 5)
  }
  if (cmd === 'wait') {
    const [, id] = positional
    if (!id) die(USAGE)
    const max = Number(opt('--max') ?? 540)
    if (!Number.isFinite(max) || max <= 0) die(USAGE)
    const until = Date.now() + max * 1000
    for (;;) {
      const r = ledger.getRequest(id)
      if (!r) die(`no request ${id}`)
      if (r.state === 'done' || (r.state === 'cancelled' && r.verdict)) show(r, flag('--json'))
      // A cancel with no verdict yet is answered only by a live service tick, so make sure one runs.
      if (['queued', 'running', 'folded'].includes(r.state) || (r.state === 'cancelled' && !r.verdict)) ensureService(root)
      if (Date.now() >= until) {
        // A request the service keeps dying on is not "still running": say so. A second crash makes it
        // env-broken (serve.mjs MAX_CRASHES), so the next wait answers with that verdict.
        if (r.crashes) console.log(`${id}: ${r.state}, but the verifier service died ${plural(r.crashes, 'time')} running it${r.lastCrash ? ` (last: ${r.lastCrash})` : ''} — see .builder/verify/serve.log; call wait again for its verdict`)
        else {
          // How long it has run, so a caller polling for hours sees that it has, not just "still running".
          const t = r.startedAt ?? r.createdAt
          const mins = t ? Math.floor((Date.now() - Date.parse(t)) / 60000) : null
          console.log(`${id}: still ${r.state}${mins === null ? '' : ` (${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`} so far)`} — call wait again`)
        }
        process.exit(75)
      }
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  if (cmd === 'release') {
    const [, id] = positional
    const r = heldGreen(ledger, id)
    landHeld(root, ledger, r, r.verdict.merged)
    console.log(`landed ${r.verdict.merged.slice(0, 7)} on ${r.target}`)
    return
  }
  if (cmd === 'carry') {
    // A held green merge whose branch has since gained only registry commits (walk results, the
    // manifest, the SPEC, the ship's archive move): those can't change what the tests saw, so the
    // result carries — land the branch tip merged onto the same target tip, without a second run.
    const [, id] = positional
    const r = heldGreen(ledger, id)
    const v = r.verdict
    const cfg = loadConfig(root)
    const registry = `${String(cfg.ok ? cfg.registry : 'docs/features').replace(/\/+$/, '')}/`
    // --no-renames: a code file moved into the registry must list its deletion too, not only where it went.
    const docsOnly = (from, to) => (tryGit(root, 'diff', '--name-only', '--no-renames', from, to) ?? '\0').split('\n').filter(Boolean).every((f) => f.startsWith(registry))
    const head = tryGit(root, 'rev-parse', `refs/heads/${r.branch}`)
    // Code changed: this result can never carry, so it stops being held (the fleet won't try it again).
    const codeChanged = (extra = '') => {
      const cur = ledger.getRequest(id) ?? r
      ledger.saveRequest({ ...cur, verdict: { ...cur.verdict, held: false } })
      console.log(`${id}: code changed since the tested sha — request the merge again${extra}`)
      process.exit(2)
    }
    if (!head || tryGit(root, 'merge-base', '--is-ancestor', r.sha, head) === null || !docsOnly(r.sha, head)) codeChanged()
    if (tryGit(root, 'rev-parse', `refs/heads/${r.target}`) !== v.targetSha) unhold(ledger, r, `${r.target} moved since the merge tier ran`)
    const m = mergedCheckout(ensureCheckout(root, 'carry'), v.targetSha, head, r.message ?? `Merge ${r.branch} into ${r.target}`)
    if (m.conflict || !docsOnly(v.merged, m.sha)) codeChanged(m.conflict ? ` (conflict in ${m.files.join(', ')})` : '')
    landHeld(root, ledger, r, m.sha, { carried: head })
    const n = Number(tryGit(root, 'rev-list', '--count', `${r.sha}..${head}`) ?? 0)
    console.log(`landed ${m.sha.slice(0, 7)} on ${r.target} (carried ${n} doc commit${n === 1 ? '' : 's'})`)
    return
  }
  if (cmd === 'cancel') {
    const [, id] = positional
    const r = id && ledger.getRequest(id)
    if (!r) die(`no request ${id}`)
    // Re-read right before writing: the service may have finished it since, and a done verdict must stand.
    const cur = ledger.getRequest(id)
    if (cur && !['done', 'cancelled'].includes(cur.state)) ledger.saveRequest({ ...cur, state: 'cancelled', ...(cur.state === 'queued' && { verdict: { request: cur.id, branch: cur.branch, sha: cur.sha, tier: cur.tier, status: 'cancelled', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0 } }) })
    console.log(cur && ['done', 'cancelled'].includes(cur.state) ? `${id}: already ${cur.state}${cur.verdict ? ` (${cur.verdict.status})` : ''}` : `${id}: cancelled`)
    return
  }
  if (cmd === 'status') {
    const open = ledger.requests((r) => ['queued', 'running', 'folded'].includes(r.state))
    const flakes = Object.keys(ledger.flakes())
    const cfg = loadConfig(root)
    const target = cfg.ok ? cfg.mergeInto : 'main'
    const out = { open: open.map((r) => ({ id: r.id, tier: r.tier, state: r.state, branch: r.branch, sha: r.sha.slice(0, 7), startedAt: r.startedAt ?? null })), flakes, known: [...ledger.known(target).ids] }
    if (flag('--json')) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(open.length ? open.map((r) => `${r.state.padEnd(8)} ${r.tier.padEnd(6)} ${r.branch} ${r.sha.slice(0, 7)} ${r.id}`).join('\n') : 'verifier: nothing queued or running')
      console.log(`flake list: ${flakes.length}${flakes.length ? ` (${flakes.slice(0, 5).join(', ')}${flakes.length > 5 ? ', …' : ''})` : ''} · known failures on ${target}: ${out.known.length}`)
    }
    return
  }
  die(USAGE)
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  // Every exit path calls process.exit(), and stdout to a pipe is asynchronous on macOS: a verdict
  // past the pipe's 64 KB would be cut off mid-JSON. Blocking writes finish before the exit.
  process.stdout._handle?.setBlocking?.(true)
  main()
}
