#!/usr/bin/env node
// scripts/verify/verify.mjs
/**
 * verify — the verifier's client (docs/specs/2026-10-27-verifier-design.md). Builds, skills and the
 * fleet call this; it writes requests, starts the service when none runs, and reads verdicts.
 *
 *   verify.mjs request <worktree> <sha|HEAD> --tier commit|phase|merge [--target <b>] [--since <sha>] [--message <m>] [--tree]
 *   verify.mjs verdict <branch> [<sha>] [--json]
 *   verify.mjs wait <request> [--max <seconds>] [--json]       (default 540 — under one 10-minute Bash call)
 *   verify.mjs cancel <request>
 *   verify.mjs status [--json]
 *   (each takes --in <worktree>, default the cwd; the ledger is the main checkout's)
 *
 * Exit: 0 green · 1 red · 2 usage · 3 env-broken · 4 conflict · 5 gone/none · 6 cancelled · 75 pending.
 */
import { spawn } from 'node:child_process'
import { openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, tryGit, mainRoot } from './git.mjs'
import { openLedger, verifyDir } from './ledger.mjs'
import { loadConfig } from '../config.mjs'

const SERVE = fileURLToPath(new URL('./serve.mjs', import.meta.url))
const USAGE = 'usage: verify.mjs request <worktree> <sha|HEAD> --tier commit|phase|merge [--target <branch>] [--since <sha>] [--message <text>] [--tree] | verdict <branch> [<sha>] [--json] | wait <request> [--max <seconds>] [--json] | cancel <request> | status [--json]   (each: [--in <worktree>])'
const EXIT = { green: 0, red: 1, 'env-broken': 3, conflict: 4, gone: 5, cancelled: 6 }
export const exitFor = (status) => EXIT[status] ?? 75

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
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
    for (const l of String(g.msg ?? '').split('\n').slice(0, 6)) lines.push(`      ${l}`)
  }
  for (const b of v.broken) lines.push(`  ⚠ ${b.suite}: ${b.reason}`)
  if (v.files?.length) lines.push(`  conflict in: ${v.files.join(', ')}`)
  if (v.landed) lines.push(`  landed: ${v.landed.slice(0, 7)}`)
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

export function ensureService(root) {
  try {
    const pid = Number(readFileSync(join(verifyDir(root), 'serve.pid'), 'utf8'))
    process.kill(pid, 0)
    return
  } catch {}
  const log = openSync(join(verifyDir(root), 'serve.log'), 'a')
  const idle = process.env.BUILDER_VERIFY_IDLE_MS
  spawn(process.execPath, ['-e', `import(${JSON.stringify(SERVE)}).then((m) => m.serve(${JSON.stringify(root)}${idle ? `, { idleMs: ${Number(idle)} }` : ''})).then(() => process.exit(0))`], { detached: true, stdio: ['ignore', log, log] }).unref()
}

function show(req, json) {
  const v = req.verdict
  if (json) console.log(JSON.stringify(v, null, 2))
  else console.log(summarize(v))
  process.exit(exitFor(v.status))
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
    const req = ledger.newRequest({ worktree: wt, branch, sha, tier, target, ...(opt('--since') && { since: git(wt, 'rev-parse', opt('--since')) }), ...(opt('--message') && { message: opt('--message') }) })
    ensureService(root)
    console.log(req.id)
    return
  }
  if (cmd === 'verdict') {
    const [, branch, sha] = positional
    if (!branch) die(USAGE)
    const full = sha ? tryGit(here, 'rev-parse', sha) ?? sha : null
    const done = ledger.requests((r) => r.branch === branch && r.state === 'done' && r.verdict && (!full || r.sha === full)).at(-1)
    if (done) show(done, flag('--json'))
    const pending = ledger.requests((r) => r.branch === branch && ['queued', 'running', 'folded'].includes(r.state))
    console.log(pending.length ? `verify ${branch}: pending (${pending.map((r) => `${r.tier} ${r.state}`).join(', ')})` : `verify ${branch}: no verdict`)
    process.exit(pending.length ? 75 : 5)
  }
  if (cmd === 'wait') {
    const [, id] = positional
    if (!id) die(USAGE)
    const until = Date.now() + Number(opt('--max') ?? 540) * 1000
    for (;;) {
      const r = ledger.getRequest(id)
      if (!r) die(`no request ${id}`)
      if (r.state === 'done' || (r.state === 'cancelled' && r.verdict)) show(r, flag('--json'))
      if (['queued', 'running', 'folded'].includes(r.state)) ensureService(root)
      if (Date.now() >= until) {
        console.log(`${id}: still ${r.state} — call wait again`)
        process.exit(75)
      }
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  if (cmd === 'cancel') {
    const [, id] = positional
    const r = id && ledger.getRequest(id)
    if (!r) die(`no request ${id}`)
    // Re-read right before writing: the service may have finished it since, and a done verdict must stand.
    const cur = ledger.getRequest(id)
    if (cur && !['done', 'cancelled'].includes(cur.state)) ledger.saveRequest({ ...cur, state: 'cancelled', ...(cur.state === 'queued' && { verdict: { request: cur.id, branch: cur.branch, sha: cur.sha, tier: cur.tier, status: 'cancelled', regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0 } }) })
    console.log(`${id}: cancelled`)
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
