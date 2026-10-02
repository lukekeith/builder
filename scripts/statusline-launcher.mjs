#!/usr/bin/env node
/**
 * The status line command /builder:statusline installs. Copied to <config>/builder/statusline.mjs,
 * so it outlives plugin versions: it imports nothing from the plugin and finds the current builder
 * on every run. It prints the status line the user had before (run with the same stdin), then
 * builder's line under it when something is running. Never prints an error; always exits 0.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = dirname(HERE)
const json = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
const out = []

/** The renderer to run for `cwd`: the repo's own copy of builder, else a project or user install. */
function renderer(cwd) {
  let root = null
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) { root = d; break }
    if (dirname(d) === d) break
  }
  if (root) {
    const src = json(join(root, '.claude-plugin', 'marketplace.json'))?.plugins?.find((p) => p.name === 'builder')?.source
    const vendored = typeof src === 'string' && join(root, src, 'scripts', 'statusline.mjs')
    if (vendored && existsSync(vendored)) return vendored
  }
  const rows = Object.entries(json(join(CONFIG, 'plugins', 'installed_plugins.json'))?.plugins ?? {})
    .filter(([id]) => id.startsWith('builder@'))
    .flatMap(([, entries]) => entries)
    .filter((e) => e.installPath && existsSync(join(e.installPath, 'scripts', 'statusline.mjs')))
  const pick = rows.find((e) => e.scope === 'project' && root && resolve(e.projectPath ?? '') === root) ?? rows.find((e) => e.scope === 'user')
  return pick ? join(pick.installPath, 'scripts', 'statusline.mjs') : null
}

/** stdout of a command, trailing newlines trimmed; '' when it can't start or outlives `ms`. It runs
 *  in its own process group, and a timeout kills the whole group — nothing it started is left behind. */
function run(cmd, args, { input = '', ms, env = process.env }) {
  return new Promise((done) => {
    let text = ''
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      done('')
    }, ms)
    child.stdout.on('data', (d) => { text += d })
    child.on('error', () => { clearTimeout(timer); done('') })
    child.on('close', () => { clearTimeout(timer); done(text.replace(/\n+$/, '')) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// The previous status line and builder's renderer run side by side: a busy machine costs at most
// the longer of the two budgets, never their sum. BUILDER_STATUSLINE_MS="<wrapped>,<renderer>"
// overrides them (the tests, on a loaded machine).
const [WRAPPED_MS, RENDER_MS] = (process.env.BUILDER_STATUSLINE_MS ?? '').split(',').map(Number)
// A launcher started by a launcher's previous command (builder's own, saved as "previous" under
// another spelling of its path) prints nothing: no recursion, ever.
if (process.env.BUILDER_STATUSLINE_DEPTH) process.exit(0)

try {
  let stdin = ''
  try { stdin = readFileSync(0, 'utf8') } catch {}
  const session = (() => { try { return JSON.parse(stdin) } catch { return {} } })()
  const cwd = session.workspace?.current_dir ?? session.cwd ?? process.cwd()
  const prev = json(join(HERE, 'statusline.prev.json'))?.statusLine?.command
  const script = existsSync(cwd) && statSync(cwd).isDirectory() ? renderer(cwd) : null
  const [wrapped, line] = await Promise.all([
    prev ? run('sh', ['-c', prev], { input: stdin, ms: WRAPPED_MS || 1000, env: { ...process.env, BUILDER_STATUSLINE_DEPTH: '1' } }) : '',
    script ? run(process.execPath, [script, '--cwd', cwd], { ms: RENDER_MS || 1500 }) : '',
  ])
  for (const t of [wrapped, line]) if (t) out.push(t)
} catch {}
// Exit once written: a timed-out child may still hold a pipe open, and must not keep this alive.
if (out.length) process.stdout.write(out.join('\n') + '\n', () => process.exit(0))
else process.exit(0)
