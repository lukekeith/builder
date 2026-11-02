/**
 * Which test files a commit range can reach, per suite — impact.mjs's import graph, which already
 * knows schema readers, workspace packages, co-changed specs and the changes it can't see past.
 * A suite's `files` glob is relative to its `cwd`; the files returned are repo-relative (see fromCwd).
 */
import { posix } from 'node:path'
import { impactOf, scopeTests } from '../impact.mjs'

export function selectSuites(checkout, base, suites) {
  let impact = null // built once, and only when a suite has a glob to scope
  const out = {}
  for (const s of suites) {
    if (!s.files) {
      out[s.name] = { files: 'all', why: 'the suite names no file glob' }
      continue
    }
    impact ??= impactOf(checkout, { since: base })
    const r = scopeTests(impact, s.cwd && s.cwd !== '.' ? posix.join(s.cwd, s.files) : s.files)
    out[s.name] = r.mode === 'whole' ? { files: 'all', why: r.reason } : r.mode === 'none' ? { files: [], why: r.reason } : { files: r.tests, why: r.why }
  }
  return out
}

/** Repo-relative paths made relative to a suite's cwd, which is where its runner resolves them. */
export const fromCwd = (cwd, files) => files.map((f) => (cwd === '.' ? f : posix.relative(cwd, f)))
