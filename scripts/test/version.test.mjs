import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { versionReport } from '../version.mjs'

const VERSION = join(dirname(fileURLToPath(import.meta.url)), '..', 'version.mjs')
const put = (root, files) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
const builder = (dir, version, real = true) => ({ [`${dir}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'builder', version }), ...(real && { [`${dir}/scripts/vendor.mjs`]: '' }) })

/** A config dir holding installs (cache) and marketplace clones, and a repo beside it. */
function machine({ installs = [], clones = [], refreshed = '2026-09-30T03:08:16.697Z' } = {}) {
  const config = mkdtempSync(join(tmpdir(), 'ver-config-'))
  const known = {}
  for (const [mkt, v, real] of installs) put(config, builder(`plugins/cache/${mkt}/builder/${v}`, v, real))
  for (const [mkt, v, real] of clones) {
    put(config, builder(`plugins/marketplaces/${mkt}`, v, real))
    known[mkt] = { installLocation: join(config, 'plugins/marketplaces', mkt), lastUpdated: refreshed }
  }
  put(config, { 'plugins/known_marketplaces.json': JSON.stringify(known) })
  const repo = mkdtempSync(join(tmpdir(), 'ver-repo-'))
  const at = (mkt, v) => join(config, 'plugins/cache', mkt, 'builder', v)
  return { config, repo, at }
}
const row = (id, version, scope, installPath, extra = {}) => ({ id, version, scope, enabled: true, installPath, ...extra })

test('a session still on the version it loaded before an update: /reload-plugins', () => {
  const m = machine({ installs: [['mk', '4.0.0'], ['mk', '4.2.0']], clones: [['mk', '4.2.0']] })
  const r = versionReport({ loadedRoot: m.at('mk', '4.0.0'), repoRoot: m.repo, configDir: m.config, pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0'))] })
  assert.equal(r.loaded, '4.0.0')
  assert.equal(r.installed, '4.2.0')
  assert.match(r.text, /^builder 4\.0\.0 — loaded in this session from the user-scope plugin install/m)
  assert.match(r.text, /installed on this machine: 4\.2\.0/)
  assert.match(r.text, /⬆️ .*\/reload-plugins/)
})

test('a newer release the machine has fetched but not installed: /builder:update, with when the marketplace was refreshed', () => {
  const m = machine({ installs: [['mk', '4.2.0']], clones: [['mk', '4.3.0']] })
  const r = versionReport({ loadedRoot: m.at('mk', '4.2.0'), repoRoot: m.repo, configDir: m.config, pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0'))] })
  assert.match(r.text, /newest release known here: 4\.3\.0 \(marketplace refreshed 2026-09-30\)/)
  assert.match(r.text, /⬆️ .*\/builder:update/)
})

test('a project-scope install for this repo is the one that loads here', () => {
  const m = machine({ installs: [['mk', '4.1.0'], ['mk', '4.2.0']], clones: [['mk', '4.2.0']] })
  const r = versionReport({
    loadedRoot: m.at('mk', '4.1.0'),
    repoRoot: m.repo,
    configDir: m.config,
    pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0')), row('builder@mk', '4.1.0', 'project', m.at('mk', '4.1.0'), { projectPath: m.repo })],
  })
  assert.match(r.text, /from a project-scope plugin install for this repo/)
  assert.match(r.text, /shadows the user-scope 4\.2\.0/)
})

test('a vendored copy behind the newest release on this machine: /builder:vendor', () => {
  const m = machine({ installs: [['mk', '4.2.0']], clones: [['mk', '4.2.0']] })
  put(m.repo, builder('plugins/builder', '4.1.1'))
  const r = versionReport({ loadedRoot: join(m.repo, 'plugins/builder'), repoRoot: m.repo, configDir: m.config, pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0'))] })
  assert.match(r.text, /^builder 4\.1\.1 — loaded in this session from this repo's own copy \(plugins\/builder\)/m)
  assert.match(r.text, /⬆️ .*\/builder:vendor/)
})

test('everything current: one ✅ line; another plugin called builder is ignored', () => {
  const m = machine({ installs: [['mk', '4.2.0'], ['other', '9.0.0', false]], clones: [['mk', '4.2.0'], ['other', '9.0.0', false]] })
  const r = versionReport({ loadedRoot: m.at('mk', '4.2.0'), repoRoot: m.repo, configDir: m.config, pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0')), row('builder@other', '9.0.0', 'project', m.at('other', '9.0.0'), { projectPath: '/elsewhere' })] })
  assert.match(r.text, /✅ up to date — the newest release this machine knows about \(marketplace refreshed 2026-09-30\)/)
  assert.doesNotMatch(r.text, /9\.0\.0|⬆️/)
})

test('a fleet running in this repo on an older version says it keeps that version until it finishes', () => {
  const m = machine({ installs: [['mk', '4.2.0']], clones: [['mk', '4.2.0']] })
  const r = versionReport({ loadedRoot: m.at('mk', '4.2.0'), repoRoot: m.repo, configDir: m.config, pluginList: [row('builder@mk', '4.2.0', 'user', m.at('mk', '4.2.0'))], fleet: { pid: 4242, version: '4.0.0' } })
  assert.match(r.text, /a fleet is running in this repo on 4\.0\.0 \(pid 4242\) — it keeps that version until it finishes/)
})

test('version.mjs runs without the claude CLI, reading only the disk', () => {
  const m = machine({ installs: [['mk', '4.0.0'], ['mk', '4.2.0']], clones: [['mk', '4.2.0']] })
  execFileSync('git', ['init', '-q'], { cwd: m.repo })
  const r = spawnSync(process.execPath, [VERSION, '--root', m.at('mk', '4.0.0')], {
    cwd: m.repo,
    encoding: 'utf8',
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: m.config, HOME: process.env.HOME },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^builder 4\.0\.0 — loaded in this session/m)
  assert.match(r.stdout, /installed on this machine: 4\.2\.0/)
})
