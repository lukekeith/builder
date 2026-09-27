#!/usr/bin/env node
/**
 * job — run something longer than one tool call without leaving it behind when a turn ends.
 *
 * A headless `claude -p` run exits when its last turn ends, and anything it started with
 * run_in_background goes with it — a gate suite cut off half-way, a verdict never written. So
 * under --agent-walk nothing runs in the background: a long command is STARTED here (detached,
 * logged, its exit code written when it ends) and then WAITED on in the foreground, one bounded
 * call at a time, until it reports an exit code.
 *
 *   node <plugin>/scripts/job.mjs start <name> -- <shell command>   # returns at once
 *   node <plugin>/scripts/job.mjs wait <name> [--max <seconds>]     # default 540; Bash timeout 600000
 *   node <plugin>/scripts/job.mjs status [<name>]
 *
 * `wait` exits with the job's own exit code once it has one, printing `<name>: exit <n>` and the
 * log's tail; 75 with `<name>: still running …` when --max passes first (call wait again); 70 when
 * the process is gone without an exit code (killed). Files live in <repo>/.builder/jobs/.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const USAGE = 'usage: job.mjs start <name> -- <command> | wait <name> [--max <seconds>] | status [<name>]'
const die = (msg) => {
  console.error(msg)
  process.exit(2)
}
const [cmd, name, ...rest] = process.argv.slice(2)
if (!cmd) die(USAGE)

let root
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  root = process.cwd()
}
const DIR = join(root, '.builder', 'jobs')
const f = (n, ext) => join(DIR, `${n}.${ext}`)
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)
const alive = (pid) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const checkName = (n) => {
  if (!n || !/^[A-Za-z0-9._-]+$/.test(n) || n.startsWith('.')) die(`job name must be letters, digits, . _ - (got: '${n ?? ''}')`)
}
const tail = (n, lines = 40) => (read(f(n, 'log')) ?? '').split('\n').slice(-lines).join('\n')
const elapsed = (n) => {
  const s = Math.round((Date.now() - statSync(f(n, 'pid')).mtimeMs) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** 'done' | 'running' | 'died' | null (no such job). */
const stateOf = (n) => {
  if (read(f(n, 'exit')) != null) return 'done'
  const pid = Number(read(f(n, 'pid')))
  if (!pid) return null
  return alive(pid) ? 'running' : read(f(n, 'exit')) != null ? 'done' : 'died'
}

if (cmd === 'start') {
  checkName(name)
  const sep = rest.indexOf('--')
  const command = sep >= 0 ? rest.slice(sep + 1).join(' ') : ''
  if (!command.trim()) die(USAGE)
  mkdirSync(DIR, { recursive: true })
  const ignore = join(root, '.builder', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  if (stateOf(name) === 'running') die(`${name} is still running — wait on it, or pick another name`)
  for (const ext of ['log', 'exit', 'pid']) rmSync(f(name, ext), { force: true })
  const fd = openSync(f(name, 'log'), 'w')
  // The exit code is written by the wrapper shell, so it lands even though nobody is attached.
  const child = spawn('sh', ['-c', 'sh -c "$1"; echo $? > "$2"', 'job', command, f(name, 'exit')], {
    cwd: process.cwd(),
    stdio: ['ignore', fd, fd],
    detached: true,
  })
  closeSync(fd)
  writeFileSync(f(name, 'pid'), String(child.pid))
  child.unref()
  console.log(`${name}: started (pid ${child.pid}) — log ${f(name, 'log')}\nnext: node ${process.argv[1]} wait ${name}`)
  process.exit(0)
}

if (cmd === 'wait') {
  checkName(name)
  const i = rest.indexOf('--max')
  const max = i >= 0 ? Number(rest[i + 1]) : 540
  if (!(max > 0)) die(`--max must be a positive number of seconds. ${USAGE}`)
  if (stateOf(name) == null) die(`no job named ${name} — start it first`)
  const deadline = Date.now() + max * 1000
  const tick = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    const s = stateOf(name)
    if (s === 'done') {
      const code = Number(read(f(name, 'exit')))
      console.log(`${name}: exit ${code} after ${elapsed(name)}\n--- last lines of ${f(name, 'log')} ---\n${tail(name)}`)
      process.exit(code)
    }
    if (s === 'died') {
      console.log(`${name}: died without an exit code (killed?) after ${elapsed(name)}\n--- last lines of ${f(name, 'log')} ---\n${tail(name)}`)
      process.exit(70)
    }
    if (Date.now() >= deadline) {
      console.log(`${name}: still running (${elapsed(name)}) — call wait again\n--- last lines ---\n${tail(name, 5)}`)
      process.exit(75)
    }
    Atomics.wait(tick, 0, 0, 500)
  }
}

if (cmd === 'status') {
  const names = name ? [name] : existsSync(DIR) ? readdirSync(DIR).filter((x) => x.endsWith('.pid')).map((x) => x.slice(0, -4)) : []
  if (name) checkName(name)
  if (!names.length) console.log('no jobs')
  for (const n of names) {
    const s = stateOf(n)
    console.log(`${n}: ${s == null ? 'no such job' : s === 'done' ? `exit ${read(f(n, 'exit'))}` : s} · ${f(n, 'log')}`)
  }
  process.exit(0)
}

die(USAGE)
