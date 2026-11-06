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
import { readFileSync, writeFileSync, unlinkSync, linkSync, renameSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { randomBytes } from 'node:crypto'
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
import { ensureCheckout, commitExists, checkoutAt, mergedCheckout, copyLocal, setupIfNeeded, changedFiles, land } from './checkouts.mjs'
import { loadConfig } from '../config.mjs'

const MAX_LAND_ATTEMPTS = 5
/** A request the service died running this many times is env-broken: running it again would only die again. */
export const MAX_CRASHES = 2

/** The crash serve.log ends on — its error line (`Error: spawn /bin/bash ENOENT`), else its last line. */
export function lastCrash(root) {
  let text = ''
  try {
    const p = join(verifyDir(root), 'serve.log')
    const size = statSync(p).size
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(Math.min(size, 8192))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    closeSync(fd)
    text = buf.toString('utf8')
  } catch {
    return null
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const err = lines.findLast((l) => /^(\w*Error|verifier service crashed)\b/.test(l))
  return (err ?? lines.at(-1) ?? '').slice(0, 300) || null
}
// git's empty tree: the base of a root commit, which has no parent to diff against.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** A serve.pid untouched this long is a dead holder even if its pid is alive (reused after a reboot or a kill). */
export const STALE_MS = 60000
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

/**
 * The pid lock: true when this process holds it (taken now, or already ours). The pid is written
 * to a temp file first and hard-linked into place, so serve.pid is never empty and two takers
 * can't both create it. A dead holder's file is moved aside (not unlinked) and checked, so a
 * reclaimer never deletes a lock another reclaimer has just taken.
 */
export function takeLock(root) {
  const p = join(verifyDir(root), 'serve.pid')
  const uniq = () => `${p}.${process.pid}.${randomBytes(4).toString('hex')}`
  for (let i = 0; i < 5; i++) {
    const tmp = uniq()
    writeFileSync(tmp, String(process.pid))
    try {
      linkSync(tmp, p)
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    } finally {
      try {
        unlinkSync(tmp)
      } catch {}
    }
    let text
    let mtime
    try {
      text = readFileSync(p, 'utf8')
      mtime = statSync(p).mtimeMs
    } catch {
      continue // released between the link and the read: try again
    }
    const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0
    if (pid === process.pid) return true
    if (pid && alive(pid) && Date.now() - mtime < STALE_MS) return false
    // Unreadable but fresh: a holder from an older build may still be writing it.
    if (!pid && Date.now() - mtime < 5000) return false
    const aside = uniq()
    try {
      renameSync(p, aside)
    } catch {
      continue // another reclaimer moved it first
    }
    let moved = null
    try {
      moved = readFileSync(aside, 'utf8')
    } catch {}
    // Not the dead holder's file: someone took the lock between our read and the rename — put it back.
    if (moved !== text) {
      try {
        linkSync(aside, p)
      } catch {}
    }
    try {
      unlinkSync(aside)
    } catch {}
  }
  return false
}
/** True when a service holds the lock: its pid is alive and its heartbeat is fresh. */
export function serviceAlive(root) {
  const p = join(verifyDir(root), 'serve.pid')
  try {
    const pid = Number(readFileSync(p, 'utf8'))
    return pid > 0 && alive(pid) && Date.now() - statSync(p).mtimeMs < STALE_MS
  } catch {
    return false
  }
}

/**
 * The heartbeat: serve.pid's mtime, touched every `ms` while this process holds it. It runs on a
 * worker thread because setup, git and project hooks are synchronous and block the main thread
 * for minutes — a tick-driven touch would let a busy service look dead.
 */
function heartbeat(root, ms) {
  const src = `const { workerData: { p, pid, ms } } = require('node:worker_threads')
const fs = require('node:fs')
setInterval(() => {
  try {
    if (fs.readFileSync(p, 'utf8').trim() === String(pid)) {
      const t = new Date()
      fs.utimesSync(p, t, t)
    }
  } catch {}
}, ms)`
  const w = new Worker(src, { eval: true, workerData: { p: join(verifyDir(root), 'serve.pid'), pid: process.pid, ms } })
  w.unref()
  return w
}

const dropLock = (root) => {
  try {
    if (Number(readFileSync(join(verifyDir(root), 'serve.pid'), 'utf8')) === process.pid) unlinkSync(join(verifyDir(root), 'serve.pid'))
  } catch {}
}

const shell = (cmd, o) => sh(cmd, o)
const empty = (req, status, extra = {}) => ({ request: req.id, branch: req.branch, sha: req.sha, tier: req.tier, status, regressions: [], flakes: [], known: [], debt: [], broken: [], selection: {}, reused: 0, ms: 0, ...extra })

export async function serve(root, { idleMs = 10 * 60000, tickMs = 500, heartbeatMs = 5000, run = runRequest, verify = null } = {}) {
  const ledger = openLedger(root)
  if (!takeLock(root)) return 'locked'
  const beat = heartbeat(root, heartbeatMs)
  try {
    return await work()
  } finally {
    await beat.terminate()
    dropLock(root)
  }

  /** Done, env-broken: and the requests folded into it take its verdict. */
  function finishCrashed(r, reason) {
    const doneAt = new Date().toISOString()
    const verdict = empty(r, 'env-broken', { broken: [{ suite: '-', reason }] })
    ledger.saveRequest({ ...r, state: 'done', doneAt, verdict })
    for (const id of r.foldedFrom ?? []) {
      const f = ledger.getRequest(id)
      if (f?.state === 'folded') ledger.saveRequest({ ...f, state: 'done', doneAt, verdict })
    }
  }

  async function work() {
    let v = verify
    let untested = false
    if (!v) {
      const r = loadVerify(root)
      // A config with neither gates nor a verify: block → nothing is configured to test: runs are
      // green and say so (`untested`). No config, an un-migrated 5.x one, or a block that is there
      // but wrong is env-broken — none of them may land a merge nobody tested.
      if (!r.ok && /no verify: block/.test(r.reason)) {
        v = { workers: 1, timeoutMs: 15 * 60000, setup: null, setupInputs: [], db: null, simulator: null, env: null, suites: [], checks: [] }
        untested = true
      } else if (!r.ok) {
        for (const q of ledger.requests((x) => x.state === 'queued' || x.state === 'running' || x.state === 'folded')) ledger.saveRequest({ ...q, state: 'done', doneAt: new Date().toISOString(), verdict: empty(q, 'env-broken', { broken: [{ suite: '-', reason: r.reason }] }) })
        return 'idle'
      } else v = r.verify
    }
    const cfg = loadConfig(root)
    const registry = `${String(cfg.ok && cfg.registry ? cfg.registry : 'docs/features').replace(/\/+$/, '')}/`
    /**
     * Whether green run `g` at this sha already proves what a phase request diffed from `base` would:
     * its tier runs every check and suite the phase tier does, and each phase suite was run whole there
     * or from a base at or before this one (a wider range selects at least as much).
     */
    const covers = (g, base) => {
      const has = (x) => !x.tiers.includes('phase') || x.tiers.includes(g.tier)
      if (!(v?.checks ?? []).every(has) || !(v?.suites ?? []).every(has)) return false
      const wider = g.verdict?.base && (g.verdict.base === base || tryGit(root, 'merge-base', '--is-ancestor', g.verdict.base, base) !== null)
      return (v?.suites ?? []).filter((s) => s.tiers.includes('phase')).every((s) => g.verdict?.selection?.[s.name]?.files === 'all' || wider)
    }
    /**
     * A queued commit request at the sha of a queued or running phase request on its branch is
     * answered by that phase run: the fleet requests both for a phase's last commit in the same
     * second, the phase is picked first, and the commit run then re-tested the same commit (4 of 4
     * phase closes on the share benchmark). Folded only when the phase run provably covers it: the
     * phase tier runs every suite and check the commit tier does, and its --since is at or before
     * where the commit run would start (the branch's newest green below the sha).
     */
    const foldIntoPhase = (keep) => {
      const inTier = (t) => (x) => x.tiers.includes(t)
      const commitSuites = (v?.suites ?? []).filter(inTier('commit'))
      const commitChecks = (v?.checks ?? []).filter(inTier('commit'))
      if (!commitSuites.every(inTier('phase')) || !commitChecks.every(inTier('phase'))) return
      const phases = [...keep.filter((r) => r.tier === 'phase'), ...[...running.values()].map((h) => h.req).filter((r) => r.tier === 'phase')]
      for (const c of keep.filter((r) => r.tier === 'commit' && !running.has(r.id))) {
        const p = phases.find((x) => x.branch === c.branch && x.sha === c.sha && x.since)
        if (!p) continue
        const below = ledger.greens(c.branch, ['commit', 'phase']).find((g) => g.sha !== c.sha && tryGit(root, 'merge-base', '--is-ancestor', g.sha, c.sha) !== null)
        if (!below || (below.sha !== p.since && tryGit(root, 'merge-base', '--is-ancestor', p.since, below.sha) === null)) continue
        const cur = ledger.getRequest(c.id)
        const host = ledger.getRequest(p.id)
        if (cur?.state !== 'queued' || !host || host.state === 'done' || host.state === 'cancelled') continue
        ledger.saveRequest({ ...host, foldedFrom: [...(host.foldedFrom ?? []), c.id, ...(cur.foldedFrom ?? [])] })
        ledger.saveRequest({ ...cur, state: 'folded', foldedInto: p.id })
        keep.splice(keep.indexOf(c), 1)
      }
    }
    const walkEnv = cfg.ok ? cfg.agentWalk?.env ?? {} : {}
    // agent_walk.copy: untracked local files the tests may need, copied into every checkout after it moves.
    const local = cfg.ok ? cfg.agentWalk?.copy ?? [] : []
    // agent_walk.env as the fleet hands it to a walk: `{feature}` filled from the builder/<feature>
    // branch. Any other branch has no feature to fill it with, so it can't lease the walk env.
    const walkEnvFor = (branch) => {
      const feature = /^builder\/(.+)$/.exec(branch ?? '')?.[1]
      const out = {}
      for (const [k, val] of Object.entries(walkEnv)) {
        if (String(val).includes('{feature}') && !feature) throw new Error('agent_walk.env needs {feature} — only fleet branches (builder/<feature>) can lease the walk env')
        out[k] = String(val).replaceAll('{feature}', feature)
      }
      return out
    }
    const pool = createPool(v)
    // A request still `running` at start was running when a service died. Back to the queue — unless
    // it has now taken the service down MAX_CRASHES times: then it is env-broken, with the crash
    // serve.log ends on, never re-queued into a loop that restarts and dies every few seconds.
    const crash = lastCrash(root)
    for (const r of ledger.requests((x) => x.state === 'running')) {
      const crashes = (r.crashes ?? 0) + 1
      const noted = { ...r, crashes, ...(crash && { lastCrash: crash }), startedAt: undefined }
      if (crashes < MAX_CRASHES) ledger.saveRequest({ ...noted, state: 'queued' })
      else finishCrashed(noted, `the verifier service died ${crashes} times running this request${crash ? ` — last: ${crash}` : ''}`)
    }
    try {
      pool.dropOrphans()
    } catch {}

    const running = new Map()
    const slots = [...Array(v.workers).keys()]
    let idleSince = Date.now()

    // Set when serve.pid names another process (a sleep outlasted the heartbeat and a second
    // service took the stale lock): what was running is aborted and goes back to the queue for the
    // new owner, with no verdict written.
    let superseded = false
    // Requeue only the record this process started: the new owner may already have taken the
    // request and written its own running record, which must not be flipped back.
    const requeueOwn = (cur, req) => {
      if (cur?.state === 'running' && cur.pid === process.pid && cur.startedAt === req.startedAt) ledger.saveRequest({ ...cur, state: 'queued', startedAt: undefined, pid: undefined })
    }
    const finish = (req, verdict) => {
      const cur = ledger.getRequest(req.id) ?? req
      // A landed merge is never undone, so its verdict stands; anything else goes back to the queue.
      if (superseded && !verdict.landed) return void requeueOwn(cur, req)
      // A merge that already landed is not undone by a late cancel, so its verdict stands.
      if (cur.state === 'cancelled' && !verdict.landed) {
        // Requests folded into it are put back by the next tick's sweep: their owners did not cancel.
        const v2 = verdict.requeue ? empty(req, 'cancelled') : { ...verdict, status: 'cancelled', broken: (verdict.broken ?? []).filter((b) => b.reason !== 'cancelled') }
        ledger.saveRequest({ ...cur, doneAt: new Date().toISOString(), verdict: v2 })
        return
      }
      if (verdict.requeue) {
        const attempts = (cur.attempts ?? 0) + 1
        if (attempts < MAX_LAND_ATTEMPTS) return ledger.saveRequest({ ...cur, state: 'queued', attempts, startedAt: undefined })
        verdict = empty(req, 'env-broken', { broken: [{ suite: '-', reason: `could not land after ${attempts} tries: ${verdict.reason}` }] })
      }
      const done = { ...cur, state: 'done', doneAt: new Date().toISOString(), verdict: { ...verdict, request: req.id, branch: req.branch, sha: req.sha, tier: req.tier } }
      ledger.saveRequest(done)
      // The ledger's list: a commit request can fold into this one while it runs (foldIntoPhase).
      for (const id of done.foldedFrom ?? req.foldedFrom ?? []) {
        const f = ledger.getRequest(id)
        if (f?.state === 'folded') ledger.saveRequest({ ...f, state: 'done', doneAt: done.doneAt, verdict: done.verdict })
      }
    }

    const execute = async (req, slot, signal) => {
      if (!commitExists(root, req.sha)) return empty(req, 'gone')
      if (tryGit(root, 'rev-parse', '--verify', '-q', `refs/heads/${req.target}`) === null) return empty(req, 'env-broken', { broken: [{ suite: '-', reason: `target branch "${req.target}" does not exist` }] })
      const targetSha = git(root, 'rev-parse', `refs/heads/${req.target}`)
      const after = (g) => g && g.sha !== req.sha && tryGit(root, 'merge-base', '--is-ancestor', g.sha, req.sha) !== null
      // The branch's newest green that this sha descends from. Not simply the newest green: a
      // `--tree` run's sha is a `git stash create` commit, never an ancestor of the next real commit,
      // and stopping there would test the whole branch again.
      const lastGreenBelow = (tiers) => ledger.greens(req.branch, tiers).find(after) ?? null
      // Built on the target itself, the merge-base is the sha: there is no branch to cover. The
      // range is then what came after the branch's last green of any tier, else the one commit.
      const onTarget = req.branch === req.target && !req.since
      const mergeBase = onTarget
        ? lastGreenBelow(['commit', 'phase', 'merge'])?.sha ?? tryGit(root, 'rev-parse', '--verify', '-q', `${req.sha}^`) ?? EMPTY_TREE
        : tryGit(root, 'merge-base', targetSha, req.sha) ?? targetSha
      // The commit tier starts after the branch's last green; the phase and merge tiers cover the branch.
      const green = req.since || req.tier !== 'commit' || onTarget ? null : lastGreenBelow(['commit', 'phase'])
      const base = req.since ?? green?.sha ?? mergeBase
      // Nothing to run, decided before a checkout moves: a commit or phase range that changed only the
      // registry (walk results, a manifest, the SPEC) — the merge tier's `carry` rule — and a phase
      // request at a sha an equal-or-wider green run already covered. A benchmark run spent 4 of its 5
      // phase runs re-testing what the commit tier had just tested, and two more on docs-only commits.
      if (req.tier !== 'merge') {
        const changed = (tryGit(root, 'diff', '--name-only', '--no-renames', base, req.sha) ?? '\0').split('\n').filter(Boolean)
        if (changed.length && changed.every((f) => f.startsWith(registry))) return empty(req, 'green', { docsOnly: true, base, why: `only ${registry} changed since ${base.slice(0, 7)}` })
        if (req.tier === 'phase') {
          const prior = ledger.greens(req.branch, ['commit', 'phase']).find((g) => g.sha === req.sha && covers(g, base))
          if (prior) return { ...prior.verdict, reusedFrom: prior.id, base, ms: 0 }
        }
      }
      const checkout = ensureCheckout(root, slot)
      let sha = req.sha
      if (req.tier === 'merge') {
        const m = mergedCheckout(checkout, targetSha, req.sha, req.message ?? `Merge ${req.branch} into ${req.target}`)
        if (m.conflict) return empty(req, 'conflict', { files: m.files })
        sha = m.sha
      } else checkoutAt(checkout, req.sha)
      copyLocal(root, checkout, local)
      setupIfNeeded(checkout, v, (cmd) => shell(cmd, { cwd: checkout, timeout: v.timeoutMs }))
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
            if (!l) {
              await waitOrAbort(1000, signal)
              continue
            }
            if (!needs.some((n) => n.kind === 'walk-env')) return l
            try {
              return { ...l, env: { ...walkEnvFor(req.branch), ...l.env } }
            } catch (e) {
              l.release()
              throw e
            }
          }
        },
        select: selectSuites,
        targetCheckout: async () => {
          if (!targetCo) {
            targetCo = ensureCheckout(root, `t${slot}`)
            checkoutAt(targetCo, targetSha)
            copyLocal(root, targetCo, local)
            setupIfNeeded(targetCo, v, (cmd) => shell(cmd, { cwd: targetCo, timeout: v.timeoutMs }))
          }
          return targetCo
        },
        atCommit: async (s) => {
          checkoutAt(checkout, s)
          copyLocal(root, checkout, local)
        },
      }
      // Every commit in the range, oldest first — what bisect walks to name the one that broke a test.
      const commits = (tryGit(root, 'rev-list', '--reverse', '--first-parent', `${base}..${req.sha}`) ?? '').split('\n').filter(Boolean)
      const verdict = await run({ ...req, sha, base, commits: commits.length ? commits : [req.sha], changed: changedFiles(root, mergeBase, req.sha) }, ctx)
      verdict.sha = req.sha
      verdict.base = base // what this run's selection was diffed from — a later phase request may reuse it (covers)
      if (untested) verdict.untested = true
      if (req.tier === 'merge') {
        verdict.merged = sha
        // The target tip this merge was tested on: a later `release` lands against exactly it.
        verdict.targetSha = targetSha
        // A held merge (its walk runs beside it) records what it tested and leaves the target alone.
        if (verdict.status === 'green' && req.hold) verdict.held = true
        else if (verdict.status === 'green') {
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
        .catch((e) => abort.signal.aborted ? empty(r, 'cancelled') : empty(r, 'env-broken', { broken: [{ suite: '-', reason: String(e.message ?? e).slice(0, 1000) }] }))
        .then((verdict) => finish(r, verdict))
        .finally(() => {
          running.delete(r.id)
          slots.push(slot)
        })
    }

    // Each tick: a cancel nobody answered (never started, or one that raced a service write) gets
    // its verdict; a folded request whose survivor was cancelled goes back to the queue on its own
    // sha (its owner did not cancel), and one whose survivor is done takes the survivor's verdict.
    const sweep = () => {
      const now = new Date().toISOString()
      for (const r of ledger.requests((x) => x.state === 'cancelled' && !x.verdict && !running.has(x.id))) ledger.saveRequest({ ...r, doneAt: now, verdict: empty(r, 'cancelled') })
      for (const f of ledger.requests((x) => x.state === 'folded')) {
        let end = ledger.getRequest(f.foldedInto)
        const seen = new Set([f.id])
        while (end?.state === 'folded' && !seen.has(end.id)) {
          seen.add(end.id)
          end = ledger.getRequest(end.foldedInto)
        }
        if (!end || end.state === 'cancelled' || end.state === 'folded') ledger.saveRequest({ ...f, state: 'queued', foldedInto: undefined, foldedFrom: undefined, commits: undefined })
        else if (end.state === 'done' && end.verdict) ledger.saveRequest({ ...f, state: 'done', doneAt: end.doneAt ?? now, verdict: end.verdict })
      }
    }
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

    // A read error is retried once: a reclaimer's rename can leave the file briefly absent.
    const holdsLock = () => {
      for (let i = 0; i < 2; i++) {
        try {
          return Number(readFileSync(join(verifyDir(root), 'serve.pid'), 'utf8')) === process.pid
        } catch {}
      }
      return false
    }

    for (;;) {
      if (!holdsLock()) {
        superseded = true
        for (const h of running.values()) h.abort.abort()
        // Let the aborted runs wind down (each requeues its request); a run stuck in a blocking
        // call can't hear the abort, so don't wait on it forever.
        for (let i = 0; i < 100 && running.size; i++) await sleep(100)
        for (const h of running.values()) {
          requeueOwn(ledger.getRequest(h.req.id), h.req)
        }
        return 'superseded'
      }
      for (const [id, h] of running) if (ledger.getRequest(id)?.state === 'cancelled') h.abort.abort()
      sweep()
      const { keep, folded } = fold(ledger.requests((x) => x.state === 'queued'))
      for (const f of folded) {
        const r = ledger.getRequest(f.id)
        if (r?.state === 'queued') ledger.saveRequest({ ...r, state: 'folded', foldedInto: f.into })
      }
      // Re-read, and write only what fold changed, so a client's cancel since the listing stands.
      for (const r of keep) {
        if (!r.foldedFrom) continue
        const cur = ledger.getRequest(r.id)
        if (cur?.state === 'queued' && !(same(cur.foldedFrom, r.foldedFrom) && same(cur.commits, r.commits))) ledger.saveRequest({ ...cur, foldedFrom: r.foldedFrom, commits: r.commits })
      }
      foldIntoPhase(keep)
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
  }
}

/**
 * The service as a process: a SIGTERM or SIGINT drops the lock before exiting (so the next client
 * starts a service at once), and a crash is logged and drops it too — never a lock left behind.
 */
export function runService(root, opts = {}) {
  const stop = (code) => () => {
    dropLock(root)
    process.exit(code)
  }
  process.once('SIGTERM', stop(143))
  process.once('SIGINT', stop(130))
  return serve(root, opts)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`verifier service crashed: ${e?.stack ?? e}`)
      dropLock(root)
      process.exit(1)
    })
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: serve.mjs <main checkout>')
    process.exit(2)
  }
  runService(root)
}
