#!/usr/bin/env node
// Stands in for `claude -p` in the fleet tests. The scenario file maps a feature to a list of
// steps; each call applies the next one to the manifest in cwd and logs start/end to calls.log.
//   <state>         set state:        READY-PENDING  state: building + ready: pending
//   BLOCK:<reason>  set blocked:      PR:<#n>        set pr:
//   SHIP            what /builder:ship leaves: MANIFEST.md gone, SPEC.md header SHIPPED
// Each step's changes to the spec folder are committed, as a real run's are.
//   NOOP            change nothing    FAIL           exit 3        HANG   never exit
//   SLOW:<step>     wait 150 ms, then <step>
//   SWITCH-THEN-SHIP  run .stub/switch.sh (the human switching branches), then SHIP
//   HANG-CHILD      spawn a grandchild that inherits stdout/stderr, then hang like HANG
//   CHATTY:<ms>:<step>  print a stream-json assistant line every 50 ms for <ms>, then <step>
// The fleet's conflict and walk-env prompts are handled first — see below.
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const prompt = process.argv[process.argv.indexOf('-p') + 1]
const spec = /--path (\S+)/.exec(prompt)[1]
const feature = spec.split('/').pop()
const S = process.env.STUB_STATE
const log = (s) => appendFileSync(join(S, 'calls.log'), `${s}\n`)
const all = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'))
const next = (key, fallback) => {
  const countFile = join(S, `${key.replace(':', '.')}.count`)
  const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0
  writeFileSync(countFile, String(n + 1))
  return (all[key] ?? [])[n] ?? fallback
}

// The fleet's own prompts, not a /builder:resume run: scenario keys `<feature>:resolve` and
// `<feature>:env`.
//   resolve  RESOLVE (default)  every conflicted file gets both sides, markers dropped; commit
//            NOOP               leave the merge as it is      ABORT   git merge --abort
//   env      FIX                touch walk-env-fixed and commit      NOOP (default)
if (/stopped on conflicts/.test(prompt)) {
  const step = next(`${feature}:resolve`, 'RESOLVE')
  log(`resolve ${feature} ${step}`)
  if (step === 'ABORT') execFileSync('git', ['merge', '--abort'])
  if (step === 'RESOLVE') {
    const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    for (const f of files) writeFileSync(f, readFileSync(f, 'utf8').replace(/^(<<<<<<<|=======|>>>>>>>).*\n/gm, ''))
    execFileSync('git', ['add', ...files])
    execFileSync('git', ['commit', '-qm', `stub: resolve ${feature}`])
  }
  process.exit(0)
}
if (/could not bring up the walk env/.test(prompt)) {
  const step = next(`${feature}:env`, 'NOOP')
  log(`envfix ${feature} ${step}`)
  if (step === 'FIX') {
    writeFileSync('walk-env-fixed', 'yes\n')
    execFileSync('git', ['add', 'walk-env-fixed'])
    execFileSync('git', ['commit', '-qm', `stub: fix walk env ${feature}`])
  }
  process.exit(0)
}

let step = next(feature, 'NOOP')
const lane = prompt.includes('--no-dev-env') ? 'build' : 'walk'
log(`start ${feature} ${lane} ${Date.now()} ${step} pid=${process.pid} walk_mark=${process.env.WALK_MARK ?? '-'} wt_mark=${process.env.WT_MARK ?? '-'} project_dir=${process.env.CLAUDE_PROJECT_DIR ?? '-'}`)

const mfPath = join(process.cwd(), spec, 'MANIFEST.md')
const set = (k, v) => {
  let t = readFileSync(mfPath, 'utf8')
  const re = new RegExp(`^${k}:.*$`, 'm')
  t = re.test(t) ? t.replace(re, `${k}: ${v}`) : `${t.trimEnd()}\n${k}: ${v}\n`
  writeFileSync(mfPath, t)
}
const finish = (code = 0) => {
  try {
    execFileSync('git', ['add', '-A', '--', spec], { stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', `stub: ${feature} ${step}`], { stdio: 'ignore' })
  } catch {} // nothing to commit
  log(`end ${feature} ${lane} ${Date.now()} into=${/--into (\S+)/.exec(prompt)?.[1] ?? '-'}`)
  process.exit(code)
}

if (step.startsWith('CHATTY:')) {
  const [, ms, ...restStep] = step.split(':')
  step = restStep.join(':')
  for (const until = Date.now() + Number(ms); Date.now() < until; ) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } }) + '\n')
    await new Promise((r) => setTimeout(r, 50))
  }
  // The real CLI's result repeats the last assistant text; the fleet's .log must not print it twice.
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `did ${step}` }] } }) + '\n')
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
if (step === 'SWITCH-THEN-SHIP') {
  execFileSync('sh', [join(S, 'switch.sh')])
  step = 'SHIP'
}
if (step.startsWith('BLOCK:')) set('blocked', step.slice(6))
else if (step.startsWith('PR:')) set('pr', step.slice(3))
else if (step === 'SHIP') {
  rmSync(mfPath)
  writeFileSync(join(process.cwd(), spec, 'SPEC.md'), `# ${feature} — spec\n> ✅ SHIPPED 2026-09-26 — merged into main · none · 🤖 agent signed off (round 1), not human-tested\n`)
}
else if (step === 'READY-PENDING') {
  set('state', 'building')
  set('ready', 'pending "dev env (fleet walk lane)"')
} else set('state', step)
finish(0)
