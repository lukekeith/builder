import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')
const VENDOR = join(SRC, 'scripts', 'vendor.mjs')
const SRC_PLUGIN = JSON.parse(readFileSync(join(SRC, '.claude-plugin/plugin.json'), 'utf8'))
const SRC_MARKET = JSON.parse(readFileSync(join(SRC, '.claude-plugin/marketplace.json'), 'utf8'))

function host({ marketplace, settings, settingsLocal, ignoreLocal = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-host-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  // The machine's own global ignores must not decide what counts as ignored here.
  execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: root })
  mkdirSync(join(root, '.claude'))
  if (ignoreLocal) writeFileSync(join(root, '.gitignore'), '.claude/settings.local.json\n')
  if (marketplace) {
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n')
  }
  if (settings) writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(settings, null, 2) + '\n')
  if (settingsLocal) writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(settingsLocal, null, 2) + '\n')
  return root
}
const vendor = (root, ...args) => spawnSync('node', [VENDOR, root, ...args], { encoding: 'utf8' })

/** Every committed-to-be file in the host (not .git, not the git-ignored local settings). */
function tracked(root) {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (n === '.git' || p.endsWith('settings.local.json')) continue
      statSync(p).isDirectory() ? walk(p) : out.push(p)
    }
  }
  walk(root)
  return out
}
const IDENTIFIERS = [SRC_MARKET.name, SRC_PLUGIN.homepage, SRC_PLUGIN.author?.url, SRC].filter(Boolean)
const leaks = (root) =>
  tracked(root).flatMap((p) => {
    const t = readFileSync(p, 'utf8').toLowerCase()
    return IDENTIFIERS.filter((id) => t.includes(id.toLowerCase())).map((id) => `${p}: ${id}`)
  })

test('a fresh install copies what runs, registers it in the host, and names nothing of its source', () => {
  const root = host()
  const r = vendor(root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const dir = join(root, 'plugins/builder')
  for (const f of ['skills/resume/SKILL.md', 'scripts/fleet.mjs', 'scripts/workspace', 'PROJECT.template.md', 'LICENSE', '.claude-plugin/plugin.json'])
    assert.ok(existsSync(join(dir, f)), f)
  for (const f of ['README.md', 'CHANGELOG.md', 'RELEASING.md', 'CONTRIBUTING.md', 'docs', 'scripts/test', '.claude-plugin/marketplace.json', '.git'])
    assert.ok(!existsSync(join(dir, f)), `${f} must not be vendored`)
  assert.ok(statSync(join(dir, 'scripts/workspace')).mode & 0o100, 'scripts stay executable')
  const pj = JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8'))
  assert.deepEqual(Object.keys(pj).sort(), ['author', 'description', 'name', 'version'])
  assert.deepEqual(pj.author, { name: basename(root) }, 'the host is the author')
  assert.equal(pj.version, SRC_PLUGIN.version)
  const mk = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'))
  const name = mk.name
  assert.ok(mk.plugins.some((p) => p.name === 'builder' && p.source === './plugins/builder'))
  const st = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))
  assert.equal(st.enabledPlugins[`builder@${name}`], true)
  assert.deepEqual(st.extraKnownMarketplaces[name], { source: { source: 'directory', path: '.' } })
  assert.deepEqual(leaks(root), [])
})

test("the host's own marketplace entry says where builder lives; source references are scrubbed from settings", () => {
  const root = host({
    marketplace: { name: 'acme', owner: { name: 'Acme' }, plugins: [{ name: 'builder', source: './tools/builder', description: "Acme's pipeline" }] },
    settings: {
      permissions: { allow: ['Read'] },
      enabledPlugins: { 'other@x': true, [`builder@${SRC_MARKET.name}`]: true, 'builder@acme': false },
      extraKnownMarketplaces: { [SRC_MARKET.name]: { source: { source: 'github', repo: 'someone/builder' } }, acme: { source: { source: 'directory', path: '.' } } },
    },
  })
  const r = vendor(root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(existsSync(join(root, 'tools/builder/skills/resume/SKILL.md')))
  assert.ok(!existsSync(join(root, 'plugins')))
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'tools/builder/.claude-plugin/plugin.json'), 'utf8')).author, { name: 'Acme' })
  const st = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))
  assert.deepEqual(st.enabledPlugins, { 'other@x': true, 'builder@acme': true })
  assert.deepEqual(Object.keys(st.extraKnownMarketplaces), ['acme'])
  assert.deepEqual(st.permissions, { allow: ['Read'] }, 'the rest of settings.json is untouched')
  assert.deepEqual(leaks(root), [])
  // The global install would also answer /builder:* — switched off for this repo, in the git-ignored file.
  const local = JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'))
  assert.equal(local.enabledPlugins[`builder@${SRC_MARKET.name}`], false)
})

test('the local settings are left alone when they are not git-ignored', () => {
  const root = host({ ignoreLocal: false })
  const r = vendor(root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(!existsSync(join(root, '.claude/settings.local.json')))
  assert.match(r.stdout, /settings\.local\.json is not git-ignored/)
})

test('an update replaces the copy wholesale — a file the new version dropped goes — and --dry-run writes nothing', () => {
  const root = host()
  assert.equal(vendor(root).status, 0)
  const dir = join(root, 'plugins/builder')
  writeFileSync(join(dir, 'skills/stale.md'), 'from an old version\n')
  writeFileSync(join(dir, 'skills/resume/SKILL.md'), 'edited\n')
  const dry = vendor(root, '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /- skills\/stale\.md/)
  assert.match(dry.stdout, /~ skills\/resume\/SKILL\.md/)
  assert.ok(existsSync(join(dir, 'skills/stale.md')), 'dry run removed nothing')
  const r = vendor(root)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(dir, 'skills/stale.md')))
  assert.notEqual(readFileSync(join(dir, 'skills/resume/SKILL.md'), 'utf8'), 'edited\n')
  const again = vendor(root)
  assert.match(again.stdout, /already up to date/)
})

test('a leak aborts before anything is written, naming the file and line', () => {
  const root = host()
  const r = vendor(root, '--forbid', 'Walk readiness')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /skills\/.*SKILL\.md:\d+: .*Walk readiness/i)
  assert.ok(!existsSync(join(root, 'plugins')))
})

test('--check reports a clean copy and its version, and fails on a leak', () => {
  const root = host()
  vendor(root)
  const ok = vendor(root, '--check')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, new RegExp(`builder ${SRC_PLUGIN.version.replace(/\./g, '\\.')} .*clean`))
  writeFileSync(join(root, 'plugins/builder/skills/leak.md'), `see ${SRC_MARKET.name}\n`)
  const bad = vendor(root, '--check')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /skills\/leak\.md:1/)
})
