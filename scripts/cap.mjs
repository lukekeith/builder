#!/usr/bin/env node
/**
 * cap — run one command with a time limit, portably: `timeout` is GNU coreutils and macOS has none,
 * so an agent told to "wrap it in timeout" gets `command not found`, often hidden by a `| grep`, and
 * then runs the command uncapped. One such hung test cost a benchmark run 24 minutes.
 *
 *   node <builder>/scripts/cap.mjs <seconds> '<shell command>'     one argument: run through sh -c
 *   node <builder>/scripts/cap.mjs <seconds> <cmd> [args…]          several: run as given
 *
 * The command runs in its own process group, so the cap kills everything it started (a test
 * runner's workers, a server it spawned) and nothing else on the machine. Over the limit: SIGTERM to
 * the group, SIGKILL 5 s later, `cap: … killed after Ns` on stderr, exit 124 (as `timeout` does).
 * A command that cannot start exits 127 with the reason. Otherwise the command's own exit code.
 */
import { spawn } from 'node:child_process'

export function run(seconds, argv, { graceMs = 5000, stdio = 'inherit' } = {}) {
  return new Promise((resolveRun) => {
    const [cmd, args] = argv.length === 1 ? ['sh', ['-c', argv[0]]] : [argv[0], argv.slice(1)]
    const child = spawn(cmd, args, { stdio, detached: true })
    let killed = false
    let done = false
    const group = (sig) => {
      try {
        process.kill(-child.pid, sig)
      } catch {}
    }
    const timer = setTimeout(() => {
      killed = true
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), graceMs).unref()
    }, seconds * 1000)
    const finish = (code, msg) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (msg) process.stderr.write(`cap: ${msg}\n`)
      resolveRun(code)
    }
    child.on('error', (err) => finish(127, `could not start ${cmd}: ${err.message}`))
    child.on('exit', (code, signal) => {
      if (killed) {
        group('SIGKILL') // anything in the group that outlived the leader
        return finish(124, `${argv.join(' ')} killed after ${seconds}s`)
      }
      finish(code ?? (signal ? 128 + 15 : 1))
    })
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (group(sig), finish(130)))
  })
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const [secs, ...argv] = process.argv.slice(2)
  const seconds = Number(secs)
  if (!(seconds > 0) || !argv.length) {
    process.stderr.write("usage: node cap.mjs <seconds> '<shell command>' | <cmd> [args…]\n")
    process.exit(2)
  }
  process.exit(await run(seconds, argv))
}
