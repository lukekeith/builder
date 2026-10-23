#!/usr/bin/env node
/**
 * preview — the response preview: what builder prints at each stage, path by path.
 *
 *   node preview/preview.mjs [--port 4848] [--open]  # serve preview/ and print the URL; --open opens it in the browser
 *                                                   # (an already-running preview on the port is reused)
 *   node preview/preview.mjs --check         # list stages whose skill section changed since stamped; exit 1 if any
 *   node preview/preview.mjs --stamp <id…>   # record the current hash of each named stage's sources (--all for every stage)
 *
 * A stage (preview/stages/*.json) names the skill section it shows — `source`, plus optional
 * `sources` — as "skills/<x>/<FILE>.md §<heading>". Its `stamp.hash` is the hash of those sections
 * when the stage was last checked against them. A changed section makes the stage stale: the page
 * badges it and --check lists it. Refresh the stage's turns, then --stamp it.
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(DIR, '..')
const STAGES = join(DIR, 'stages')
const version = () => JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version

// The text of one "path §heading" section: from the heading to the next heading of the same or a
// higher level. null when the file or the heading is gone.
export function section(ref) {
  const m = /^(.+?) §(.+)$/.exec(ref || '')
  if (!m) return null
  const file = join(ROOT, m[1])
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').split('\n')
  let start = -1, level = 0, fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence
    if (fence) continue
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i])
    if (!h) continue
    if (start < 0) {
      if (h[2].replace(/`/g, '') === m[2].replace(/`/g, '')) { start = i; level = h[1].length }
    } else if (h[1].length <= level) return lines.slice(start, i).join('\n')
  }
  return start < 0 ? null : lines.slice(start).join('\n')
}

const refs = (s) => [s.source, ...(s.sources || [])].filter(Boolean)
export function hashStage(s) {
  const parts = refs(s).map(section)
  if (parts.some((p) => p == null)) return null
  return createHash('sha256').update(parts.join('\n\u0000\n')).digest('hex').slice(0, 12)
}

export function load() {
  const files = existsSync(STAGES) ? readdirSync(STAGES).filter((f) => f.endsWith('.json')).sort() : []
  const stages = []
  for (const f of files) {
    for (const s of JSON.parse(readFileSync(join(STAGES, f), 'utf8')).stages) {
      const hash = hashStage(s)
      const missing = refs(s).filter((r) => section(r) == null)
      stages.push({ ...s, file: f, status: missing.length ? 'broken' : !s.stamp ? 'unstamped' : s.stamp.hash === hash ? 'current' : 'stale', missing })
    }
  }
  const paths = JSON.parse(readFileSync(join(DIR, 'paths.json'), 'utf8'))
  return { version: version(), paths, stages }
}

function stamp(ids) {
  const all = ids.includes('--all'), seen = new Set()
  for (const f of readdirSync(STAGES).filter((f) => f.endsWith('.json'))) {
    const p = join(STAGES, f), doc = JSON.parse(readFileSync(p, 'utf8'))
    let touched = false
    for (const s of doc.stages) {
      if (!all && !ids.includes(s.id)) continue
      const hash = hashStage(s)
      if (!hash) { console.error(`✖ ${s.id}: source not found — ${refs(s).join(', ')}`); continue }
      s.stamp = { hash, version: version(), date: new Date().toISOString().slice(0, 10) }
      seen.add(s.id); touched = true
    }
    if (touched) writeFileSync(p, JSON.stringify(doc, null, 2) + '\n')
  }
  for (const id of ids) if (id !== '--all' && !seen.has(id)) console.error(`✖ no stage "${id}"`)
  console.log(`stamped ${seen.size} stage${seen.size === 1 ? '' : 's'} at ${version()}`)
}

function check() {
  const { stages, paths } = load()
  const bad = stages.filter((s) => s.status !== 'current')
  const ids = new Set(stages.map((s) => s.id))
  const dangling = paths.flatMap((p) => p.steps.filter((id) => !ids.has(id)).map((id) => `${p.id} → ${id}`))
  for (const s of bad) console.log(`${s.status.padEnd(9)} ${s.id.padEnd(34)} ${s.status === 'broken' ? 'missing: ' + s.missing.join(', ') : refs(s).join(' + ')}`)
  for (const d of dangling) console.log(`dangling  ${d}`)
  console.log(bad.length || dangling.length
    ? `\n${bad.length} stage(s) need a look, ${dangling.length} dangling path step(s). Refresh the turns, then: node preview/preview.mjs --stamp <id…>`
    : `✔ all ${stages.length} stages match their skill sections`)
  process.exit(bad.length || dangling.length ? 1 : 0)
}

const openUrl = (url) => execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], () => {})

function serve(port, open) {
  const url = `http://localhost:${port}`
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
  createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    if (url === '/data.json') {
      try { res.writeHead(200, { 'content-type': types['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(load())) }
      catch (e) { res.writeHead(500); res.end(String(e.stack || e)) }
      return
    }
    const file = normalize(join(DIR, url === '/' ? 'index.html' : url))
    if (!file.startsWith(DIR) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  }).on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e
    // Something holds the port: reuse it when it is a preview server, otherwise say so.
    const ours = await fetch(`${url}/data.json`).then((r) => r.ok).catch(() => false)
    if (!ours) { console.error(`✖ port ${port} is in use by something else — try --port <n>`); process.exit(1) }
    console.log(`builder response preview already running → ${url}`)
    if (open) openUrl(url)
  }).listen(port, () => {
    console.log(`builder response preview → ${url}  (data is re-read on every reload)`)
    if (open) openUrl(url)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--check') check()
  else if (args[0] === '--stamp') stamp(args.slice(1))
  else serve(Number(args[args.indexOf('--port') + 1]) || 4848, args.includes('--open'))
}
