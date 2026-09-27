#!/usr/bin/env node
// Stands in for `claude -p` in the fleet tests. The scenario file maps a feature to a list of
// steps; each call applies the next one to the manifest in cwd and logs start/end to calls.log.
//   <state>         set state:        READY-PENDING  state: building + ready: pending
//   BLOCK:<reason>  set blocked:      PR:<#n>        set pr:
//   NOOP            change nothing    FAIL           exit 3        HANG   never exit
//   SLOW:<step>     wait 150 ms, then <step>
//   HANG-CHILD      spawn a grandchild that inherits stdout/stderr, then hang like HANG
//   CHATTY:<ms>:<step>  print a stream-json assistant line every 50 ms for <ms>, then <step>
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const prompt = process.argv[process.argv.indexOf('-p') + 1]
const spec = /--path (\S+)/.exec(prompt)[1]
const feature = spec.split('/').pop()
const S = process.env.STUB_STATE
const scenario = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'))[feature] ?? []
const countFile = join(S, `${feature}.count`)
const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0
writeFileSync(countFile, String(n + 1))
let step = scenario[n] ?? 'NOOP'
const lane = prompt.includes('--no-dev-env') ? 'build' : 'walk'
const log = (s) => appendFileSync(join(S, 'calls.log'), `${s}\n`)
log(`start ${feature} ${lane} ${Date.now()} ${step} pid=${process.pid} walk_mark=${process.env.WALK_MARK ?? '-'} project_dir=${process.env.CLAUDE_PROJECT_DIR ?? '-'}`)

const mfPath = join(process.cwd(), spec, 'MANIFEST.md')
const set = (k, v) => {
  let t = readFileSync(mfPath, 'utf8')
  const re = new RegExp(`^${k}:.*$`, 'm')
  t = re.test(t) ? t.replace(re, `${k}: ${v}`) : `${t.trimEnd()}\n${k}: ${v}\n`
  writeFileSync(mfPath, t)
}
const finish = (code = 0) => {
  log(`end ${feature} ${lane} ${Date.now()}`)
  process.exit(code)
}

if (step.startsWith('CHATTY:')) {
  const [, ms, ...restStep] = step.split(':')
  step = restStep.join(':')
  for (const until = Date.now() + Number(ms); Date.now() < until; ) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } }) + '\n')
    await new Promise((r) => setTimeout(r, 50))
  }
  process.stdout.write(JSON.stringify({ type: 'result', result: `did ${step}` }) + '\n')
}
if (step.startsWith('SLOW:')) {
  step = step.slice(5)
  await new Promise((r) => setTimeout(r, 150))
}
if (step === 'HANG-CHILD') {
  spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })
  await new Promise(() => setInterval(() => {}, 1e6))
}
if (step === 'HANG') await new Promise(() => setInterval(() => {}, 1e6))
if (step === 'FAIL') finish(3)
if (step === 'NOOP') finish(0)
if (step.startsWith('BLOCK:')) set('blocked', step.slice(6))
else if (step.startsWith('PR:')) set('pr', step.slice(3))
else if (step === 'READY-PENDING') {
  set('state', 'building')
  set('ready', 'pending "dev env (fleet walk lane)"')
} else set('state', step)
finish(0)
