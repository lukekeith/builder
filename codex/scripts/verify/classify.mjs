/**
 * One failing test → what it means (spec §Judging a failure), the cheapest question first. The re-runs
 * are never a whole suite: the runner answers each question with one run per suite, of just that suite's
 * failing tests together, so rerunHere/rerunOnTarget return that run's status for this test. Only `regression` dispatches a fix; `broken` (the target re-run could not run) is env-broken.
 * (A run with no report at all is env-broken — decided by the runner before anything gets here.)
 */
export async function classify(f, ctx) {
  if (ctx.known.has(f.id)) return { kind: 'known' }
  if (ctx.isFlaky(f.id)) return { kind: 'flake', listed: true }
  if ((await ctx.rerunHere(f)) === 'pass') return ctx.branchOwns(f.file) ? { kind: 'regression', note: 'flaky test this branch owns' } : { kind: 'flake', listed: false }
  const there = await ctx.rerunOnTarget(f)
  if (there === 'fail') return { kind: 'debt' }
  // The target re-run produced no report: an environment problem, not this branch's fault — never a fix.
  if (there === 'broken') return { kind: 'broken' }
  return { kind: 'regression' }
}
