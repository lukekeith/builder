// scripts/verify/fleet-hooks.mjs
/**
 * The fleet's calls into the verifier (spec §Merge tier, §The walk beside the merge tier): a held
 * merge request when a feature reaches the walk, its verdict, and the release that lands it.
 * The fleet is a node process, so it waits here without spending a model turn.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git } from './git.mjs'
import { openLedger } from './ledger.mjs'
import { ensureService } from './verify.mjs'

const CLIENT = fileURLToPath(new URL('./verify.mjs', import.meta.url))
const client = (cwd, ...args) => {
  try {
    return { status: 0, out: execFileSync(process.execPath, [CLIENT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).trim() }
  } catch (e) {
    // A usage refusal speaks on stderr, so a failure's words are both streams.
    return { status: e.status ?? 1, out: [e.stdout, e.stderr].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n') }
  }
}

/** A held merge request for the worktree's HEAD — the one already queued, running or held green for it, else a new one (older open ones for the branch are cancelled). */
export function requestMerge(root, wt, { target, message }) {
  const ledger = openLedger(root)
  const head = git(wt, 'rev-parse', 'HEAD')
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')
  const live = ledger.requests((r) => r.tier === 'merge' && r.branch === branch && r.sha === head && (['queued', 'running'].includes(r.state) || (r.state === 'done' && r.verdict?.status === 'green' && r.verdict.held))).at(-1)
  if (live) return live.id
  for (const r of ledger.requests((x) => x.tier === 'merge' && x.branch === branch && ['queued', 'running'].includes(x.state))) client(root, 'cancel', r.id, '--in', root)
  const r = client(wt, 'request', wt, 'HEAD', '--tier', 'merge', '--hold', '--target', target, '--message', message)
  if (r.status !== 0 || !r.out) throw new Error(`verify.mjs request failed (exit ${r.status}): ${r.out}`)
  return r.out
}

/** The latest done merge-tier verdict for exactly this sha of the branch, or null. */
export function mergeVerdict(root, branch, sha) {
  return openLedger(root).requests((r) => r.tier === 'merge' && r.branch === branch && r.sha === sha && r.state === 'done').at(-1)?.verdict ?? null
}

/** The branch's latest held green merge-tier verdict (whatever sha it tested), or null. */
export function heldMerge(root, branch) {
  return openLedger(root).requests((r) => r.tier === 'merge' && r.branch === branch && r.state === 'done' && r.verdict?.status === 'green' && r.verdict.held).at(-1)?.verdict ?? null
}

/**
 * Poll the ledger until the request has a verdict — without blocking the fleet's event loop; null
 * on abort or after `maxMs` (default 3 h): a service that never answers parks the feature rather
 * than holding the fleet forever.
 */
export async function awaitVerdict(root, id, { pollMs = 2000, signal = null, maxMs = 3 * 3600000 } = {}) {
  const ledger = openLedger(root)
  const until = Date.now() + maxMs
  for (;;) {
    const r = ledger.getRequest(id)
    // No request file: nothing will ever answer it, so the caller parks instead of waiting forever.
    if (!r) return null
    if (r?.state === 'done' || (r?.state === 'cancelled' && r.verdict)) return r.verdict
    if (signal?.aborted || Date.now() >= until) return null
    // The service exits when idle; a request still waiting needs one running.
    ensureService(root)
    await new Promise((res) => setTimeout(res, pollMs))
  }
}

/** Land a held green merge: the target fast-forwards to the merge commit it tested. */
export function release(root, id) {
  const r = client(root, 'release', id, '--in', root)
  if (r.status === 0) return { ok: true, sha: openLedger(root).getRequest(id).verdict.landed }
  // One line: it becomes a park reason, and git's words span several.
  return { ok: false, moved: r.status === 7, reason: r.out.replace(/\s+/g, ' ') }
}

/** Land a held green merge whose branch has since gained only registry commits (verify.mjs carry). */
export function carry(root, id) {
  const r = client(root, 'carry', id, '--in', root)
  if (r.status === 0) return { ok: true, sha: openLedger(root).getRequest(id).verdict.landed }
  return { ok: false, moved: r.status === 7, codeChanged: r.status === 2, reason: r.out.replace(/\s+/g, ' ') }
}
