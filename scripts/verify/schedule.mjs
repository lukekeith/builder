/**
 * What runs next (spec §The units — scheduler): merge before phase before commit, oldest first,
 * one merge per target at a time; queued commit requests on one branch fold into one run over
 * every commit they name, so a busy branch costs one run, not one per commit.
 */
export const PRIORITY = { merge: 0, phase: 1, commit: 2 }

/**
 * `queued` oldest first → the requests to keep and the folded ids. A survivor carries `commits`
 * (every sha it covers, in order) and `foldedFrom` (the ids it absorbed), so the run can name
 * every commit it proves and the ledger can answer for each folded request.
 */
export function fold(queued) {
  const keep = []
  const folded = []
  const newestByBranch = new Map()
  for (const r of queued) {
    if (r.tier !== 'commit') {
      keep.push(r)
      continue
    }
    const older = newestByBranch.get(r.branch)
    if (!older) {
      newestByBranch.set(r.branch, r)
      keep.push(r)
      continue
    }
    const survivor = {
      ...r,
      commits: [...(older.commits ?? [older.sha]), ...(r.commits ?? [r.sha])],
      foldedFrom: [...(older.foldedFrom ?? []), older.id],
    }
    keep[keep.indexOf(older)] = survivor
    newestByBranch.set(r.branch, survivor)
    folded.push({ id: older.id, into: r.id })
  }
  return { keep, folded }
}

/** The next request to start, or null: a merge waits while another merge runs on its target. */
export function pickNext(queue, { running }) {
  const busy = new Set(running.filter((r) => r.tier === 'merge').map((r) => r.target))
  const order = [...queue].sort(
    (a, b) => PRIORITY[a.tier] - PRIORITY[b.tier] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  return order.find((r) => !(r.tier === 'merge' && busy.has(r.target))) ?? null
}
