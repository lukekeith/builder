#!/usr/bin/env node
// A fleet that lands the feature: an archive row, a 10-line PLAN.md committed, and the args (and database environment) it got.
// Also the evidence a real fleet leaves: an archived transcript, an env-check log, a kept workspace, a worktree
// still standing beside the clone, a node_modules file and a 4 KB log (over the tests' evidence cap).
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const feature = process.argv[2]
const root = process.cwd()
const fleet = join(root, '.builder', 'fleet')
mkdirSync(fleet, { recursive: true })
const env = Object.fromEntries(['DATABASE_URL', 'DIRECT_URL', 'TEST_DATABASE_URL', 'PGHOST', 'PGDATABASE', 'BENCH_MARK', 'FLEET_KEEP_STREAMS', 'FLEET_KEEP_WORKSPACES'].map((k) => [k, process.env[k]]))
writeFileSync(join(fleet, 'stub-args.json'), JSON.stringify({ argv: process.argv.slice(2), projectDir: process.env.CLAUDE_PROJECT_DIR, env }))
const plan = join(root, 'docs', 'features', feature, 'PLAN.md')
mkdirSync(join(root, 'docs', 'features', feature), { recursive: true })
writeFileSync(plan, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
const git = (...a) => execFileSync('git', ['-c', 'user.name=stub', '-c', 'user.email=stub@localhost', ...a], { cwd: root, stdio: 'ignore' })
git('add', '--', plan)
git('commit', '-qm', `plan ${feature}`, '--', plan)
appendFileSync(join(fleet, 'archive.jsonl'), JSON.stringify({ feature, merged: 'x', wallMs: 300000, costUsd: 1, stages: { build: 200000 }, timing: [] }) + '\n')
const put = (f, text) => {
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, text)
}
put(join(fleet, 'logs', '_archive', feature, `${feature}-01.jsonl`), '{"type":"result"}\n')
put(join(fleet, 'logs', '_envcheck-1.log'), 'env ok\n')
put(join(fleet, 'logs', 'huge.log'), 'x'.repeat(4096))
put(join(root, '.builder', 'kept', feature, 'ledger.md'), '# ledger\n')
put(join(root, '.builder', 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
put(join(`${root}.fleet`, feature, '.builder', feature, 'review.md'), '# review\n')
put(join(`${root}.fleet`, feature, 'node_modules', 'x.js'), 'x\n')
