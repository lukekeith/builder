/**
 * What `$builder agent` may hand to Codex workers, and what the workers would do with it.
 * Pure over a runtime feature record plus a clock; lifecycle.mjs exposes it through `list` and
 * `agent-ready`.
 *
 * A feature another session is building right now is never handed over: two coordinators on one
 * feature worktree is how work is lost. The signal is the feature's working files — its scratch
 * folder `.builder/<feature>/` (briefs, reports, gate logs) and its tracked ledger.md — written in
 * the last ACTIVE_MS while the feature is approved-planned, planned to build here, or building.
 * A feature only specced in a session is still offered.
 */
import fs from 'node:fs'
import path from 'node:path'

/** How recently a feature's working files must have been written for a session to count as building it. */
export const ACTIVE_MS = 30 * 60 * 1000

/** The newest mtime among the feature's working files, or null. */
export function lastActivity(m) {
  const times = []
  const visit = (dir) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      try { const st = fs.statSync(path.join(dir, n)); if (st.isFile()) times.push(st.mtimeMs) } catch { /* vanished */ }
    }
  }
  if (m?.worktree) visit(path.join(m.worktree, '.builder', m.name))
  if (m?.featurePath) { try { times.push(fs.statSync(path.join(m.featurePath, 'ledger.md')).mtimeMs) } catch { /* none yet */ } }
  return times.length ? Math.max(...times) : null
}

const goAhead = (m) => m?.profileApproved === true || m?.build === 'here'

/** True when a session is building the feature now: approved-planned or building, with fresh working files. */
export function buildingInSession(m, now = Date.now()) {
  if (!(m?.phase === 'building' || (m?.phase === 'planned' && goAhead(m)))) return false
  const at = lastActivity(m)
  return at != null && now - at <= ACTIVE_MS
}

const NOT_BUILT = ['spec', 'aligned', 'audited', 'planned']
const BUILT = ['built', 'signed-off', 'verified']

/**
 * `{ offer, group, does }` when workers can take the feature — `does` says in plain words what they
 * would actually do — or `{ offer: false, reason }`. `group` orders the picker: not built yet (0),
 * part-built (1), built (2), blocked (3).
 */
export function agentOffer(m, now = Date.now()) {
  const f = m.name
  if (m.cleaned || m.phase === 'merged') return { offer: false, reason: `${f} — already merged into ${m.targetBranch || m.originBranch}; bring that branch into yours` }
  if (m.paused) return { offer: false, reason: `${f} — paused; unpause it explicitly first` }
  if (m.awaitingHuman) return { offer: false, reason: `${f} — waiting for your walk; resume it with $builder resume ${f}` }
  if (m.phase === 'exploring') return { offer: false, reason: `${f} — no spec yet; finish the brainstorm and spec first` }
  if (buildingInSession(m, now)) return { offer: false, reason: `${f} — being built in a session; finish it there` }
  if (NOT_BUILT.includes(m.phase)) return { offer: true, group: 0, does: 'not built yet · agents audit, plan, build, test and merge it' }
  if (m.phase === 'building') return { offer: true, group: 1, does: `part-built (${m.currentTask ? `at ${m.currentTask}` : 'in progress'}) · agents build the rest, test and merge it` }
  if (m.phase === 'built') return { offer: true, group: 2, does: `${m.build === 'here' ? 'built here by you' : 'built in a session'}, not tested yet · agents only walk it, verify and merge it` }
  if (BUILT.includes(m.phase)) return { offer: true, group: 2, does: 'tested · agents only verify and merge it' }
  if (m.phase === 'blocked') return { offer: true, group: 3, does: `blocked — ${String(m.nextAction ?? 'see PARKED.md').slice(0, 80)} · picking it rechecks the cause and retries` }
  return { offer: false, reason: `${f} — ${m.phase} is not a state agents can take` }
}

/** Offerable rows in picker order: group, then most recently touched first. Rows carry `agent` and `touchedAt`. */
export const pickerOrder = (rows) =>
  rows.filter((r) => r.agent?.offer).sort((a, b) => a.agent.group - b.agent.group || (b.touchedAt ?? 0) - (a.touchedAt ?? 0))
