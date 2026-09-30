import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newerRelease, compareVersions } from '../newer.mjs'

const put = (root, files) => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
const plugin = (version) => JSON.stringify({ name: 'builder', version })

/** A repo carrying a copy at plugins/builder, and a config dir with what the machine has installed. */
function machine({ carried = '4.1.1', cache = [], clones = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'newer-repo-'))
  put(repo, { 'plugins/builder/.claude-plugin/plugin.json': plugin(carried), 'plugins/builder/scripts/vendor.mjs': '' })
  const config = mkdtempSync(join(tmpdir(), 'newer-config-'))
  for (const [mkt, version, real = true] of cache)
    put(config, { [`plugins/cache/${mkt}/builder/${version}/.claude-plugin/plugin.json`]: plugin(version), ...(real && { [`plugins/cache/${mkt}/builder/${version}/scripts/vendor.mjs`]: '' }) })
  for (const [mkt, version, real = true] of clones)
    put(config, { [`plugins/marketplaces/${mkt}/.claude-plugin/plugin.json`]: plugin(version), ...(real && { [`plugins/marketplaces/${mkt}/scripts/vendor.mjs`]: '' }) })
  return { repo, config, pluginRoot: join(repo, 'plugins/builder') }
}

test('compareVersions orders by number, not text', () => {
  assert.ok(compareVersions('4.10.0', '4.9.9') > 0)
  assert.ok(compareVersions('4.1.1', '4.1.1') === 0)
  assert.ok(compareVersions('3.0.0', '10.0.0') < 0)
})

test('a vendored copy behind the newest release this machine knows about says so', () => {
  const m = machine({ carried: '4.1.1', cache: [['a', '4.1.1'], ['a', '4.2.0']], clones: [['a', '4.3.0']] })
  assert.deepEqual(newerRelease({ pluginRoot: m.pluginRoot, repoRoot: m.repo, configDir: m.config }), { vendored: true, have: '4.1.1', latest: '4.3.0', behind: true })
})

test('another plugin that happens to be called builder is not a release of this one', () => {
  const m = machine({ carried: '4.1.1', cache: [['a', '4.1.1'], ['other', '9.0.0', false]], clones: [['other', '9.0.0', false]] })
  assert.equal(newerRelease({ pluginRoot: m.pluginRoot, repoRoot: m.repo, configDir: m.config }).behind, false)
})

test('an up-to-date copy, a copy with nothing installed beside it, and a plugin install are not behind', () => {
  const up = machine({ carried: '4.2.0', cache: [['a', '4.2.0']] })
  assert.equal(newerRelease({ pluginRoot: up.pluginRoot, repoRoot: up.repo, configDir: up.config }).behind, false)
  const alone = machine({ carried: '4.2.0' })
  assert.deepEqual(newerRelease({ pluginRoot: alone.pluginRoot, repoRoot: alone.repo, configDir: alone.config }), { vendored: true, have: '4.2.0', latest: null, behind: false })
  const installed = machine({ cache: [['a', '4.2.0']] })
  const cacheRoot = join(installed.config, 'plugins/cache/a/builder/4.2.0')
  assert.equal(newerRelease({ pluginRoot: cacheRoot, repoRoot: installed.repo, configDir: installed.config }).vendored, false, '/builder:update keeps a plugin install current, not this')
})
