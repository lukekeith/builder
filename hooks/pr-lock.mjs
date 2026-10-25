#!/usr/bin/env node
/**
 * The PR lock's decision (hooks/pr-lock is the entry). Reads the PreToolUse call on stdin
 * ({ tool_name, tool_input: { command }, cwd }). When the command runs `gh pr create` in a builder
 * project, it finds the features whose MANIFEST.md `branch:` is the branch the PR would open from
 * (`--head`/`-H`, else the checked-out one) and denies when one of them has not been walked:
 *   - `walk: none` (or no walk line)                → deny: 🔒 walk it, then /builder:signoff
 *   - `walk: agent-pass …` without `agent-walk: on` → deny: an agent's sign-off is not the human's
 *   - a human's name                                → allow
 * No such feature, not a builder project, or any error → allow silently.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig, CONFIG_PATH } from '../scripts/config.mjs'
import { features } from '../scripts/registry.mjs'
import { parseManifest, isSet } from '../scripts/manifest.mjs'

const GH_PR_CREATE = /(?:^|[\s;&|(`])gh\s+(?:-\S+\s+(?:\S+\s+)?)*pr\s+create\b/

const git = (cwd, ...a) => {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null
  } catch {
    return null
  }
}

const unquote = (s) => String(s ?? '').trim().replace(/^["'`]|["'`]$/g, '')

/** `--head <branch>`, `--head=<branch>` or `-H <branch>` on the gh command; `owner:branch` → branch. */
const headFlag = (cmd) => {
  const m = /(?:--head[=\s]+|-H\s+)(["']?)([^\s"';&|]+)\1/.exec(cmd)
  return m ? m[2].replace(/^[^:]+:/, '') : null
}

export function decide(call, env = process.env) {
  if (call?.tool_name !== 'Bash') return null
  const cmd = String(call.tool_input?.command ?? '')
  if (!GH_PR_CREATE.test(cmd)) return null
  const cwd = call.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()
  // The checkout the PR comes from: a worktree carries its own copy of the manifests on its branch.
  const top = git(cwd, 'rev-parse', '--show-toplevel')
  const root = [top, env.CLAUDE_PROJECT_DIR].find((r) => r && existsSync(join(r, CONFIG_PATH)))
  if (!root) return null
  const cfg = loadConfig(root)
  if (!cfg.ok) return null
  const branch = headFlag(cmd) ?? git(cwd, 'branch', '--show-current')
  if (!branch) return null

  for (const name of features(root, cfg.registry).sort()) {
    const path = join(root, cfg.registry, name, 'MANIFEST.md')
    if (!existsSync(path)) continue
    const mf = parseManifest(readFileSync(path, 'utf8'))
    if (unquote(mf.branch) !== branch) continue
    const folder = `${cfg.registry}/${name}`
    const walk = unquote(mf.walk)
    if (!isSet(walk))
      return (
        `🔒 builder's PR lock: ${name} (${folder}) is on ${branch} and has not been walked — its manifest says walk: none. ` +
        `No PR before the human has personally exercised the finished feature. ` +
        `Next: 🔒 walk it, then /builder:signoff --path ${folder}. Tell the user; don't open the PR another way.`
      )
    if (/^agent-pass/.test(walk) && !/^on\b/i.test(unquote(mf['agent-walk'])))
      return (
        `🔒 builder's PR lock: ${name} (${folder}) was signed off by an agent (walk: ${walk}), not by a human, and is not in agent mode. ` +
        `Next: the human tests it, then /builder:signoff --path ${folder}. Tell the user; don't open the PR another way.`
      )
  }
  return null
}

try {
  const reason = decide(JSON.parse(readFileSync(0, 'utf8')))
  if (reason)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n'
    )
} catch {
  // allow: the lock never blocks by accident
}
