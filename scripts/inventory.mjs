#!/usr/bin/env node
/**
 * inventory — every local branch and worktree in this repo, and what each needs, against the branch
 * finished features merge into (--into, else the config's merge_into, else base_branch). Read-only.
 *
 *   node <plugin>/scripts/inventory.mjs [--into <branch>] [--json | --summary]
 *
 * The groups and their actions are tidy-core's `inventory`; /builder:tidy acts on them.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireConfig } from './config.mjs'
import { loadFleet, fleetDir, fleetAlive } from './fleet-core.mjs'
import { inventory, summaryLine } from './tidy-core.mjs'

const argv = process.argv.slice(2)
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
const CFG = requireConfig()
const target = opt('--into') ?? CFG.mergeInto
const fleet = existsSync(join(fleetDir(CFG.root), 'fleet.json')) ? loadFleet(CFG.root) : null
const items = inventory(CFG.root, CFG, target, { fleet, lockAlive: fleetAlive(CFG.root) })

if (argv.includes('--json')) console.log(JSON.stringify({ target, items }, null, 2))
else if (argv.includes('--summary')) console.log(summaryLine(items))
else {
  console.log(`# ${CFG.project} — branches and worktrees against ${target}\n`)
  if (!items.length) console.log('Nothing but the target. repo: clean')
  else {
    console.log('| Group | Branch / worktree | Ahead | Worktree | Why · next | Action |\n|---|---|---|---|---|---|')
    const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|')
    for (const i of items) console.log(`| ${i.group} | ${cell(i.name)} | ${i.kind === 'branch' ? i.ahead : '—'} | ${cell(i.worktree)} | ${cell([i.why, i.next].filter(Boolean).join(' · ') || null)} | ${i.action} |`)
    console.log(`\n${summaryLine(items)}`)
  }
}
