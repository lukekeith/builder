#!/usr/bin/env node
// scripts/verify/serve.mjs
/**
 * The verifier service — one per repo (spec §The units — service). Requests are files; the
 * service folds, schedules and runs them on `verify.workers` checkouts, writes verdicts, lands
 * merge-tier greens, and exits after `idleMs` with nothing queued or running. All state is in
 * .builder/verify/, so a crash loses nothing: on start, `running` requests return to `queued` and
 * orphaned databases are dropped.
 *
 *   node scripts/verify/serve.mjs <main checkout>     (started by verify.mjs; never by hand)
 */
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, tryGit, sh } from './git.mjs'
import { openLedger, verifyDir } from './ledger.mjs'
import { loadVerify } from './config.mjs'
import { createPool } from './envpool.mjs'
import { selectSuites } from './select.mjs'
import { runRequest } from './run.mjs'
import { fold, pickNext } from './schedule.mjs'
import { ensureCheckout, commitExists, checkoutAt, mergedCheckout, setupIfNeeded, changedFiles, land } from './checkouts.mjs'
import { loadConfig } from '../config.mjs'

const MAX_LAND_ATTEMPTS = 5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A wait a cancel cuts short (the timer and its abort listener are both cleaned up either way).
const waitOrAbort = (ms, signal) => wait(ms, null, { signal }).catch(() => {})
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The pid lock: true when this process holds it (taken now, or already ours). */
export function takeLock(root) {
  const p = join(verifyDir(root), 'serve.pid')
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch {
      const pid = Number(readFileSync(p, 'utf8'))
      if (pid === process.pid) return true
      if (pid && alive(pid)) return false
      try {
        unlinkSync(p)
      } catch {}
    }
  }
  return false
}
const dropLock = (root) => {
  try {
    if (Number(readFileSync(join(verifyDir(root), 'serve.pid'), 'utf8')) === process.pid) unlinkSync(join(verifyDir(root), 'serve.pid'))
  } catch {}
}

const shell = (cmd, o) => sh(cmd, o)
const empty = (req, status, extra = {}) => ({ request: req.id, branch: req.branch, sha: req.sha, tier: req.tier, status, regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0, ...extra })

export async function serve(root, { idleMs = 10 * 60000, tickMs = 500, run = runRequest, verify = null } = {}) {
  const ledger = openLedger(root)
  if (!takeLock(root)) return 'locked'
  let v = verify
  let untested = false
  if (!v) {
    const r = loadVerify(root)
    // No verify: block (or no config) → nothing is configured to test, as a config with no gate blocks was:
    // runs are green and say so (`untested`). A block that is there but wrong is env-broken.
    if (!r.ok && /no verify: block|no \.claude\/builder\.md/.test(r.reason)) {
      v = { workers: 1, timeoutMs: 15 * 60000, setup: null, setupInputs: [], db: null, simulator: null, env: null, suites: [], checks: [] }
      untested = true
    } else if (!r.ok) {
      for (const q of ledger.requests((x) => x.state === 'queued' || x.state === 'running')) ledger.saveRequest({ ...q, state: 'done', doneAt: new Date().toISOString(), verdict: empty(q, 'env-broken', { broken: [{ suite: '-', reason: r.reason }] }) })
      dropLock(root)
      return 'idle'
    } else v = r.verify
  }
  const cfg = loadConfig(root)
  const walkEnv = cfg.ok ? cfg.agentWalk?.env ?? {} : {}
  const pool = createPool(v)
  for (const r of ledger.requests((x) => x.state === 'running')) ledger.saveRequest({ ...r, state: 'queued', startedAt: undefined })
  try {
    pool.dropOrphans()
  } catch {}

  const running = new Map()
  const slots = [...Array(v.workers).keys()]
  let idleSince = Date.now()

  const finish = (req, verdict) => {
    const cur = ledger.getRequest(req.id) ?? req
    // A merge that already landed is not undone by a late cancel, so its verdict stands.
    if (cur.state === 'cancelled' && !verdict.landed) {
      ledger.saveRequest({ ...cur, doneAt: new Date().toISOString(), verdict: { ...verdict, status: 'cancelled' } })
      return
    }
    if (verdict.requeue) {
      const attempts = (cur.attempts ?? 0) + 1
      if (attempts < MAX_LAND_ATTEMPTS) return ledger.saveRequest({ ...cur, state: 'queued', attempts, startedAt: undefined })
      verdict = empty(req, 'env-broken', { broken: [{ suite: '-', reason: `could not land after ${attempts} tries: ${verdict.reason}` }] })
    }
    const done = { ...cur, state: 'done', doneAt: new Date().toISOString(), verdict: { ...verdict, request: req.id, branch: req.branch, sha: req.sha, tier: req.tier } }
    ledger.saveRequest(done)
    for (const id of req.foldedFrom ?? []) {
      const f = ledger.getRequest(id)
      if (f) ledger.saveRequest({ ...f, state: 'done', doneAt: done.doneAt, verdict: done.verdict })
    }
  }

  const execute = async (req, slot, signal) => {
    if (!commitExists(root, req.sha)) return empty(req, 'gone')
    const targetSha = git(root, 'rev-parse', `refs/heads/${req.target}`)
    const checkout = ensureCheckout(root, slot)
    let sha = req.sha
    if (req.tier === 'merge') {
      const m = mergedCheckout(checkout, targetSha, req.sha, req.message ?? `Merge ${req.branch} into ${req.target}`)
      if (m.conflict) return empty(req, 'conflict', { files: m.files })
      sha = m.sha
    } else checkoutAt(checkout, req.sha)
    setupIfNeeded(checkout, v, (cmd) => shell(cmd, { cwd: checkout }))
    const mergeBase = tryGit(root, 'merge-base', targetSha, req.sha) ?? targetSha
    // The commit tier starts after the branch's last green; the phase and merge tiers cover the branch.
    const green = req.since || req.tier !== 'commit' ? null : ledger.lastGreen(req.branch)
    const base = req.since ?? (green && green.sha !== req.sha && tryGit(root, 'merge-base', '--is-ancestor', green.sha, req.sha) !== null ? green.sha : mergeBase)
    let targetCo = null
    const ctx = {
      verify: v,
      pool,
      ledger,
      checkout,
      targetSha,
      signal,
      baseEnv: {},
      lease: async (needs, o) => {
        // Waits for capacity, but never past a cancel: the run is told at once, not after a poll.
        for (;;) {
          if (signal.aborted) throw new Error('cancelled')
          const l = await pool.lease(needs, o)
          if (l) return needs.some((n) => n.kind === 'walk-env') ? { ...l, env: { ...walkEnv, ...l.env } } : l
          await waitOrAbort(1000, signal)
        }
      },
      select: selectSuites,
      targetCheckout: async () => {
        if (!targetCo) {
          targetCo = ensureCheckout(root, `t${slot}`)
          checkoutAt(targetCo, targetSha)
          setupIfNeeded(targetCo, v, (cmd) => shell(cmd, { cwd: targetCo }))
        }
        return targetCo
      },
      atCommit: async (s) => {
        checkoutAt(checkout, s)
      },
    }
    // Every commit in the range, oldest first — what bisect walks to name the one that broke a test.
    const commits = (tryGit(root, 'rev-list', '--reverse', '--first-parent', `${base}..${req.sha}`) ?? '').split('\n').filter(Boolean)
    const verdict = await run({ ...req, sha, base, commits: commits.length ? commits : [req.sha], changed: changedFiles(root, mergeBase, req.sha) }, ctx)
    verdict.sha = req.sha
    if (untested) verdict.untested = true
    if (req.tier === 'merge') {
      verdict.merged = sha
      if (verdict.status === 'green') {
        const l = land(root, req.target, sha, targetSha)
        if (!l.ok) return { requeue: true, reason: l.reason }
        verdict.landed = sha
      }
    }
    return verdict
  }

  const start = (req, slot) => {
    // Re-read first: a client may have cancelled it since this tick listed the queue.
    if (ledger.getRequest(req.id)?.state !== 'queued') return void slots.push(slot)
    const r = { ...req, state: 'running', startedAt: new Date().toISOString(), pid: process.pid }
    ledger.saveRequest(r)
    const abort = new AbortController()
    running.set(r.id, { req: r, abort })
    execute(r, slot, abort.signal)
      .catch((e) => empty(r, 'env-broken', { broken: [{ suite: '-', reason: String(e.message ?? e).slice(0, 1000) }] }))
      .then((verdict) => finish(r, verdict))
      .finally(() => {
        running.delete(r.id)
        slots.push(slot)
      })
  }

  try {
    for (;;) {
      for (const [id, h] of running) if (ledger.getRequest(id)?.state === 'cancelled') h.abort.abort()
      const { keep, folded } = fold(ledger.requests((x) => x.state === 'queued'))
      for (const f of folded) {
        const r = ledger.getRequest(f.id)
        if (r) ledger.saveRequest({ ...r, state: 'folded', foldedInto: f.into })
      }
      for (const r of keep) if (r.foldedFrom) ledger.saveRequest(r)
      while (slots.length) {
        const next = pickNext(
          keep.filter((r) => !running.has(r.id)),
          { running: [...running.values()].map((h) => h.req) },
        )
        if (!next) break
        keep.splice(keep.indexOf(next), 1)
        start(next, slots.shift())
      }
      if (running.size || keep.length) idleSince = Date.now()
      else if (Date.now() - idleSince >= idleMs) return 'idle'
      await sleep(tickMs)
    }
  } finally {
    dropLock(root)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: serve.mjs <main checkout>')
    process.exit(2)
  }
  serve(root).then(() => process.exit(0))
}
