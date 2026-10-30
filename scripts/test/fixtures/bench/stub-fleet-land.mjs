#!/usr/bin/env node
// A fleet that lands the feature: an archive row, a 10-line PLAN.md committed, and the args it got.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const feature = process.argv[2]
const root = process.cwd()
const fleet = join(root, '.builder', 'fleet')
mkdirSync(fleet, { recursive: true })
writeFileSync(join(fleet, 'stub-args.json'), JSON.stringify({ argv: process.argv.slice(2), projectDir: process.env.CLAUDE_PROJECT_DIR }))
const plan = join(root, 'docs', 'features', feature, 'PLAN.md')
mkdirSync(join(root, 'docs', 'features', feature), { recursive: true })
writeFileSync(plan, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
const git = (...a) => execFileSync('git', ['-c', 'user.name=stub', '-c', 'user.email=stub@localhost', ...a], { cwd: root, stdio: 'ignore' })
git('add', '--', plan)
git('commit', '-qm', `plan ${feature}`, '--', plan)
appendFileSync(join(fleet, 'archive.jsonl'), JSON.stringify({ feature, merged: 'x', wallMs: 300000, costUsd: 1, stages: { build: 200000 }, timing: [] }) + '\n')
