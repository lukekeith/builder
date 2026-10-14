#!/usr/bin/env node
// A stand-in for `claude -p` in the bench tests. Scenario: { "<prompt substring>": { skills: [...],
// files: { "rel/path": "content" }, commit: "msg", manifest: "feature-name", brainstormRecord: "sized sm", exit: 0, hang: false } }.
// Emits a stream-json session: init, one Skill tool_use per skill (10 ms apart), a result.
import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const argv = process.argv.slice(2)
if (argv[0] === 'plugin') {
  console.log('builder 0.0.0-stub (plugin-dir)')
  process.exit(0)
}
const prompt = argv[argv.indexOf('-p') + 1] ?? ''
const flags = argv.filter((a) => a.startsWith('--')).join(' ')
appendFileSync(join(process.env.STUB_STATE, 'calls.log'), `${prompt.slice(0, 60).replace(/\n/g, ' ')} | ${flags}\n`)
const all = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'))
const key = Object.keys(all).find((k) => prompt.includes(k))
const s = all[key] ?? { skills: [] }
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let t = Date.now()
const ts = () => new Date((t += 10)).toISOString()
line({ type: 'system', subtype: 'init', session_id: 'stub', model: 'stub-model', plugins: [{ name: 'stub-plugin', version: '0.0.0', path: '/stub/plugin', source: 'stub-plugin@stub' }], timestamp: ts() })
for (const skill of s.skills ?? []) {
  line({ type: 'assistant', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_use', id: `t-${skill}`, name: 'Skill', input: { skill } }] } })
  line({ type: 'user', parent_tool_use_id: null, timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: `t-${skill}`, content: 'ok' }] } })
}
for (const [rel, content] of Object.entries(s.files ?? {})) {
  mkdirSync(join(process.cwd(), dirname(rel)), { recursive: true })
  writeFileSync(join(process.cwd(), rel), content)
}
if (s.manifest) {
  mkdirSync(join(process.cwd(), 'docs/features', s.manifest), { recursive: true })
  writeFileSync(join(process.cwd(), 'docs/features', s.manifest, 'MANIFEST.md'), 'size: md\nstate: spec\nnext: /builder:resume\n')
  writeFileSync(join(process.cwd(), 'docs/features', s.manifest, 'SPEC.md'), '# spec\n')
}
if (s.brainstormRecord) {
  mkdirSync(join(process.cwd(), '.builder/tags'), { recursive: true })
  writeFileSync(join(process.cwd(), '.builder/tags/brainstorm.md'), `# tags — brainstorm\nstatus: ${s.brainstormRecord}\n\n## Intent\n`)
}
if (s.commit) {
  execFileSync('git', ['add', '-A'], { cwd: process.cwd() })
  execFileSync('git', ['-c', 'user.name=stub', '-c', 'user.email=stub@x', 'commit', '-qm', s.commit], { cwd: process.cwd() })
}
if (s.orphan) writeFileSync(join(process.env.STUB_STATE, 'orphan.pid'), String(spawn('sleep', ['30'], { stdio: 'ignore' }).pid))
if (s.hang) setInterval(() => {}, 1000)
else {
  line({ type: 'result', subtype: 'success', duration_ms: 30, num_turns: (s.skills ?? []).length, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 }, result: 'done', session_id: 'stub', timestamp: ts() })
  process.exit(s.exit ?? 0)
}
