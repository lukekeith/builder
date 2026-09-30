#!/usr/bin/env node
/**
 * version — which builder this session is running, and whether it is the newest.
 *
 *   node <plugin>/scripts/version.mjs --root <the plugin root this session loaded>
 *
 * `--root` is the one fact only the session has: the directory it loaded builder from (a skill's
 * base directory, two levels up). A plugin install keeps each version in its own folder, so a
 * session that loaded 4.0.0 keeps running it after 4.2.0 is installed beside it — until
 * /reload-plugins or a restart. Against that it reads, from disk only (it never fetches):
 *
 *  - the install that would load in this repo: a project-scope install for this repo, else the
 *    user-scope one (`claude plugin list --json`; without the CLI, the newest install on disk);
 *  - the newest release this machine knows about — the marketplace copies, as of their last refresh;
 *  - a fleet running in this repo, which keeps the version it started with until it finishes.
 *
 * Only a copy carrying `scripts/vendor.mjs` counts as this plugin — another plugin that happens to
 * be called builder does not. It names nothing of where the plugin came from, so a copy vendored into
 * a repo can carry it.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './newer.mjs'

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const ls = (d) => {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
/** This plugin's version at `dir`, or null when `dir` is not this plugin. */
const versionAt = (dir) => {
  const pj = readJson(join(dir, '.claude-plugin', 'plugin.json'))
  return pj?.name === 'builder' && existsSync(join(dir, 'scripts', 'vendor.mjs')) ? pj.version ?? null : null
}
const newest = (vs) => vs.filter(Boolean).sort(compareVersions).pop() ?? null
const newer = (a, b) => a != null && b != null && compareVersions(a, b) > 0

/**
 * The report: `{ loaded, installed, released, text }`. `pluginList` is `claude plugin list --json`
 * (null when the CLI isn't there); `fleet` is `{ pid, version }` for a fleet running in this repo.
 */
export function versionReport({ loadedRoot, repoRoot, configDir, pluginList = null, fleet = null }) {
  const root = real(loadedRoot)
  const repo = real(repoRoot)
  const loaded = readJson(join(root, '.claude-plugin', 'plugin.json'))?.version ?? '?'
  const vendored = root.startsWith(repo + sep)
  const ours = (pluginList ?? []).filter((r) => /^builder@/.test(r.id) && r.installPath && versionAt(r.installPath))
  const user = ours.find((r) => r.scope === 'user')
  const project = ours.find((r) => r.scope !== 'user' && r.projectPath && real(r.projectPath) === repo)
  // The install this session came from: the row whose folder it loaded — or, when the install has
  // moved on to a newer version since, the row whose versions live beside the one it loaded.
  const loadedRow = ours.find((r) => real(r.installPath) === root) ?? [project, user].find((r) => r && real(join(r.installPath, '..')) === real(join(root, '..')))

  // Where this session's copy came from.
  let from
  if (vendored) from = `this repo's own copy (${relative(repo, root)})`
  else if (loadedRow?.scope === 'user') from = 'the user-scope plugin install'
  else if (loadedRow) from = 'a project-scope plugin install for this repo'
  else if (root.startsWith(real(join(configDir, 'plugins', 'cache')) + sep)) from = 'a plugin install'
  else from = `a copy at ${root}`

  // What would load here on a reload: the repo's own copy, a project install for this repo, else the user install.
  const cacheVersions = ls(join(configDir, 'plugins', 'cache')).flatMap((m) => ls(join(configDir, 'plugins', 'cache', m, 'builder')).map((v) => versionAt(join(configDir, 'plugins', 'cache', m, 'builder', v))))
  const installed = vendored ? loaded : (project ?? user)?.version ?? newest(cacheVersions)

  // The newest release this machine knows about: its marketplace copies, as of their last refresh.
  const known = readJson(join(configDir, 'plugins', 'known_marketplaces.json')) ?? {}
  const clones = ls(join(configDir, 'plugins', 'marketplaces')).map((m) => {
    const dir = join(configDir, 'plugins', 'marketplaces', m)
    const k = Object.values(known).find((x) => x?.installLocation && real(x.installLocation) === real(dir))
    return { version: versionAt(dir), refreshed: k?.lastUpdated ?? null }
  }).filter((c) => c.version)
  const top = clones.sort((a, b) => compareVersions(a.version, b.version)).pop() ?? null
  const released = newest([top?.version, ...cacheVersions])
  const when = top?.refreshed ? ` (marketplace refreshed ${top.refreshed.slice(0, 10)})` : ''

  const lines = [`builder ${loaded} — loaded in this session from ${from}`]
  if (!vendored) {
    lines.push(`installed on this machine: ${installed ?? 'none found'}${project && user && project.version !== user.version ? ` — this repo's project-scope ${project.version} shadows the user-scope ${user.version}` : ''}`)
  }
  lines.push(`newest release known here: ${released ?? 'none found'}${when}`)
  if (fleet) lines.push(`a fleet is running in this repo on ${fleet.version} (pid ${fleet.pid}) — it keeps that version until it finishes${newer(installed, fleet.version) ? `; its next start takes ${installed}` : ''}`)

  let next
  if (vendored && newer(released, loaded)) next = `⬆️ ${released} is on this machine — /builder:vendor copies it into this repo, then /reload-plugins`
  else if (!vendored && newer(installed, loaded)) next = `⬆️ ${installed} is installed but this session loaded ${loaded} — /reload-plugins loads it (no restart needed)`
  else if (!vendored && newer(released, installed)) next = `⬆️ ${released} is out — /builder:update installs it, then /reload-plugins`
  else next = `✅ up to date — the newest release this machine knows about${when}. ${vendored ? '/builder:vendor refreshes and takes a newer one when there is one.' : '/builder:update --check looks for a newer one.'}`
  lines.push(next)
  return { loaded, installed, released, text: lines.join('\n') + '\n' }
}

/** A fleet holding this repo's lock: its pid and the version its script runs from. */
function runningFleet(repo) {
  const pid = Number(readJson(join(repo, '.builder', 'fleet', 'lock')) ?? NaN)
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return null
  }
  let cmd = ''
  try {
    cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return null
  }
  const m = /(\S+)[\\/]scripts[\\/]fleet\.mjs/.exec(cmd)
  const version = m ? readJson(join(m[1], '.claude-plugin', 'plugin.json'))?.version : null
  return version ? { pid, version } : null
}

if (process.argv[1] && fileURLToPath(import.meta.url) === real(process.argv[1])) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--root')
  const loadedRoot = i >= 0 ? argv[i + 1] : join(fileURLToPath(import.meta.url), '..', '..')
  let repoRoot = process.cwd()
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  let pluginList = null
  try {
    pluginList = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }))
  } catch {}
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  process.stdout.write(versionReport({ loadedRoot, repoRoot, configDir, pluginList, fleet: runningFleet(repoRoot) }).text)
}
