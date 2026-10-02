#!/usr/bin/env node
/**
 * The status line command /builder:statusline installs. Copied to <config>/builder/statusline.mjs,
 * so it outlives plugin versions: it imports nothing from the plugin and finds the current builder
 * on every run. It prints the status line the user had before (run with the same stdin), then
 * builder's line under it when something is running. Never prints an error; always exits 0.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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

try {
  let stdin = ''
  try { stdin = readFileSync(0, 'utf8') } catch {}
  const session = (() => { try { return JSON.parse(stdin) } catch { return {} } })()
  const cwd = session.workspace?.current_dir ?? session.cwd ?? process.cwd()

  const prev = json(join(HERE, 'statusline.prev.json'))?.statusLine?.command
  if (prev) {
    const r = spawnSync('sh', ['-c', prev], { input: stdin, encoding: 'utf8', timeout: 1000 })
    const text = (r.stdout ?? '').replace(/\n+$/, '')
    if (text) out.push(text)
  }

  const script = existsSync(cwd) && statSync(cwd).isDirectory() ? renderer(cwd) : null
  if (script) {
    const r = spawnSync(process.execPath, [script, '--cwd', cwd], { encoding: 'utf8', timeout: 500 })
    const line = (r.stdout ?? '').replace(/\n+$/, '')
    if (line) out.push(line)
  }
} catch {}
if (out.length) process.stdout.write(out.join('\n') + '\n')
