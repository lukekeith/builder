// scripts/verify/target.mjs
/**
 * The branch a request compares against — the one the feature will merge into. Every tier selects
 * what changed between that branch and the commit, and the merge tier lands on it, so a wrong one
 * on a stacked branch makes everything below the branch count as changed.
 *
 * In order: an explicit `--target`; the fleet's `--into`, which reaches the agents it runs as
 * BUILDER_TARGET; the `target:` of the feature whose branch this is (its MANIFEST.md in the
 * worktree: `branch:` names it, or it is the fleet's `builder/<feature>`); the config's
 * `merge_into` (else `base_branch`); `main`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, isSet } from '../manifest.mjs'

/** The `target:` of the features on `branch` in the worktree — null unless exactly one is named. */
export function manifestTarget(wt, registry, branch) {
  let names = []
  try {
    names = readdirSync(join(wt, registry), { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[_.]/.test(e.name)).map((e) => e.name)
  } catch {
    return null
  }
  const targets = new Set()
  for (const name of names) {
    let mf
    try {
      mf = parseManifest(readFileSync(join(wt, registry, name, 'MANIFEST.md'), 'utf8'))
    } catch {
      continue
    }
    const mine = (isSet(mf.branch) && mf.branch === branch) || branch === `builder/${name}`
    const target = String(mf.target ?? '').replace(/^(["'])(.*)\1$/, '$2')
    if (mine && isSet(target)) targets.add(target)
  }
  // Two features on one branch naming different targets: no guess — the config's answer stands.
  return targets.size === 1 ? [...targets][0] : null
}

/** → the landing branch for a request from `wt` on `branch`. */
export function landingTarget({ explicit = null, env = process.env, wt, branch, cfg }) {
  if (isSet(explicit)) return explicit
  if (isSet(env.BUILDER_TARGET)) return env.BUILDER_TARGET
  const own = cfg?.ok ? manifestTarget(wt, cfg.registry, branch) : null
  return own ?? (cfg?.ok ? cfg.mergeInto : 'main')
}
