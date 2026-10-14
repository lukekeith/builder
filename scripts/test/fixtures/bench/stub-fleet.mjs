#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const feature = process.argv[2]
const root = process.cwd()
const logs = join(root, '.builder', 'fleet', 'logs')
mkdirSync(logs, { recursive: true })
let t = Date.now()
const ts = () => new Date((t += 10)).toISOString()
const L = (o) => JSON.stringify(o) + '\n'
let s = L({ type: 'system', subtype: 'init', session_id: 'fleet-1', model: 'stub-model', timestamp: ts() })
for (const skill of ['builder:audit', 'builder:plan', 'builder:build']) {
  s += L({ type: 'assistant', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_use', id: skill, name: 'Skill', input: { skill, args: `--path docs/features/${feature}` } }] } })
  s += L({ type: 'assistant', parent_tool_use_id: skill, timestamp: ts(), message: { content: [{ type: 'tool_use', id: `${skill}-sub`, name: 'Edit', input: { file_path: 'src/cli.mjs' } }] } })
}
s += L({ type: 'result', subtype: 'success', duration_ms: 70, num_turns: 3, total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0 }, result: 'done', session_id: 'fleet-1', timestamp: ts() })
writeFileSync(join(logs, `${feature}-01.jsonl`), s)
if (process.env.STUB_FLEET_PARK) {
  writeFileSync(join(root, 'docs/features', feature, 'MANIFEST.md'), 'size: md\nstate: building\nblocked: "spec leaves the tag format open — next: decide it"\n')
} else {
  appendFileSync(join(root, '.builder', 'fleet', 'archive.jsonl'), L({ feature, profile: 'rush', merged: 'main', pr: null, landedAt: Date.now(), timing: [{ n: 1, lane: 'build', ms: 70 }] }))
}
