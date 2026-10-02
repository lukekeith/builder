import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

function setup({ prev, tag = 'B' } = {}) {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')))
  mkdirSync(join(config, 'builder'))
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), join(config, 'builder', 'statusline.mjs'))
  if (prev !== undefined) put(join(config, 'builder', 'statusline.prev.json'), JSON.stringify({ statusLine: prev }))
  const install = join(config, 'plugins/cache/mp/builder/9.9.9')
  put(join(install, 'scripts/statusline.mjs'), `process.stdout.write(${JSON.stringify(tag)} + ' ' + process.argv[3] + '\\n')`)
  put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'builder@mp': [{ scope: 'user', installPath: install }] } }))
  return config
}
const launch = (config, cwd) => {
  const t0 = Date.now()
  const r = spawnSync('node', [join(config, 'builder', 'statusline.mjs')], { input: JSON.stringify({ workspace: { current_dir: cwd } }), encoding: 'utf8' })
  return { ...r, ms: Date.now() - t0 }
}
const cwd = () => realpathSync(mkdtempSync(join(tmpdir(), 'repo-')))

test('prints the previous status line, then builder\'s line, feeding the previous command the same stdin', () => {
  const config = setup({ prev: { type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(\'GSD \'+JSON.parse(s).workspace.current_dir))"' } })
  const dir = cwd()
  const r = launch(config, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `GSD ${dir}\nB ${dir}\n`)
})

test('no previous status line → builder\'s line alone; a failing one → builder\'s line alone', () => {
  const dir = cwd()
  assert.equal(launch(setup({ prev: null }), dir).stdout, `B ${dir}\n`)
  assert.equal(launch(setup({ prev: { type: 'command', command: 'exit 3' } }), dir).stdout, `B ${dir}\n`)
})

test('a previous command that hangs is cut off at 1s; builder\'s line still prints', () => {
  const dir = cwd()
  const r = launch(setup({ prev: { type: 'command', command: 'sleep 5' } }), dir)
  assert.equal(r.stdout, `B ${dir}\n`)
  assert.ok(r.ms < 3000, `took ${r.ms}ms`)
})

test('no builder install → the previous line alone, no error', () => {
  const config = setup({ prev: { type: 'command', command: 'echo GSD' } })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), '{"plugins":{}}')
  const r = launch(config, cwd())
  assert.equal(r.stdout, 'GSD\n')
  assert.equal(r.stderr, '')
})

test('a repo carrying its own copy of builder uses that renderer over the user install', () => {
  const config = setup({ prev: null })
  const dir = cwd()
  mkdirSync(join(dir, '.git'))
  put(join(dir, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'builder', source: './plugins/builder' }] }))
  put(join(dir, 'plugins/builder/scripts/statusline.mjs'), `process.stdout.write('VENDORED\\n')`)
  assert.equal(launch(config, join(dir)).stdout, 'VENDORED\n')
})
