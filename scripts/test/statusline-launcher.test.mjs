import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..')
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

function setup({ prev, tag = 'B', body } = {}) {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-')))
  mkdirSync(join(config, 'builder'))
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), join(config, 'builder', 'statusline.mjs'))
  if (prev !== undefined) put(join(config, 'builder', 'statusline.prev.json'), JSON.stringify({ statusLine: prev }))
  const install = join(config, 'plugins/cache/mp/builder/9.9.9')
  put(join(install, 'scripts/statusline.mjs'), body ?? `process.stdout.write(${JSON.stringify(tag)} + ' ' + process.argv[3] + '\\n')`)
  put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'builder@mp': [{ scope: 'user', installPath: install }] } }))
  return config
}
// Generous budgets unless a test is about the budgets: a loaded machine (the whole suite in
// parallel) can take seconds just to start node, and that is not what these tests check.
const launch = (config, cwd, ms = '20000,20000') => {
  const t0 = Date.now()
  const r = spawnSync('node', [join(config, 'builder', 'statusline.mjs')], { input: JSON.stringify({ workspace: { current_dir: cwd } }), encoding: 'utf8', env: { ...process.env, BUILDER_STATUSLINE_MS: ms } })
  return { ...r, ms: Date.now() - t0 }
}
const cwd = () => realpathSync(mkdtempSync(join(tmpdir(), 'repo-')))

test('prints the previous status line, then builder\'s segment on the same row, feeding the previous command the same stdin', () => {
  const config = setup({ prev: { type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(\'GSD \'+JSON.parse(s).workspace.current_dir))"' } })
  const dir = cwd()
  const r = launch(config, dir)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, `GSD ${dir} │ B ${dir}\n`)
})

test('no previous status line → builder\'s line alone; a failing one → builder\'s line alone', () => {
  const dir = cwd()
  assert.equal(launch(setup({ prev: null }), dir).stdout, `B ${dir}\n`)
  assert.equal(launch(setup({ prev: { type: 'command', command: 'exit 3' } }), dir).stdout, `B ${dir}\n`)
})

test('a previous command that hangs is cut off at its budget; builder\'s line still prints', () => {
  const dir = cwd()
  const r = launch(setup({ prev: { type: 'command', command: 'sleep 30' } }), dir, '1000,20000')
  assert.equal(r.stdout, `B ${dir}\n`)
  assert.ok(r.ms < 20000, `waited for the hung command: ${r.ms}ms`)
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

test('the previous command and the renderer run side by side, not one after the other', () => {
  const marks = mkdtempSync(join(tmpdir(), 'marks-'))
  const span = (name) => `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(join(marks, name))} + '.start', String(Date.now())); const t = Date.now(); while (Date.now() - t < 3000); fs.writeFileSync(${JSON.stringify(join(marks, name))} + '.end', String(Date.now())); process.stdout.write(${JSON.stringify(name)} + '\\n')`
  const esm = span('SLOW').replace("const fs = require('fs');", "import fs from 'node:fs';")
  const config = setup({ prev: { type: 'command', command: `node -e ${JSON.stringify(span('GSD'))}` }, body: esm })
  const r = launch(config, cwd())
  assert.equal(r.stdout, 'GSD │ SLOW\n')
  const at = (n) => Number(readFileSync(join(marks, n), 'utf8'))
  assert.ok(at('GSD.start') < at('SLOW.end') && at('SLOW.start') < at('GSD.end'), 'the two ran at the same time')
})

test('a previous status line that prints and then exits non-zero still shows', () => {
  const dir = cwd()
  assert.equal(launch(setup({ prev: { type: 'command', command: 'echo GSD; exit 1' } }), dir).stdout, `GSD │ B ${dir}\n`)
})

test('a hung previous command leaves nothing running behind it once cut off', () => {
  const marks = mkdtempSync(join(tmpdir(), 'orphan-'))
  const dir = cwd()
  const r = launch(setup({ prev: { type: 'command', command: `sleep 30 & echo $! > ${join(marks, 'pid')}; wait` } }), dir, '1000,20000')
  assert.equal(r.stdout, `B ${dir}\n`)
  const pid = Number(readFileSync(join(marks, 'pid'), 'utf8'))
  let alive = true
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); spawnSync('sleep', ['0.1']) } catch { alive = false }
  }
  if (alive) process.kill(pid, 'SIGKILL')
  assert.equal(alive, false, 'the grandchild sleep was left running')
})

test('the previous command runs marked as nested, and a nested launcher prints nothing — so builder\'s own launcher saved as the previous line cannot recurse', () => {
  const dir = cwd()
  const seen = setup({ prev: { type: 'command', command: 'echo "depth=$BUILDER_STATUSLINE_DEPTH"' } })
  assert.equal(launch(seen, dir).stdout, `depth=1 │ B ${dir}\n`)
  const nested = spawnSync('node', [join(setup({ prev: { type: 'command', command: 'echo GSD' } }), 'builder', 'statusline.mjs')], { input: '{}', encoding: 'utf8', env: { ...process.env, BUILDER_STATUSLINE_DEPTH: '1' } })
  assert.equal(nested.stdout, '')
})

test('a multi-line previous status line keeps its rows; builder\'s segment joins the last', () => {
  const dir = cwd()
  assert.equal(launch(setup({ prev: { type: 'command', command: 'printf "ONE\\nTWO\\n"' } }), dir).stdout, `ONE\nTWO │ B ${dir}\n`)
})

test('before the first response (no context percentage) the previous line is handed an empty window; a real one passes through untouched', () => {
  const config = setup({ prev: { type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(\'CTX \'+JSON.parse(s).context_window?.remaining_percentage))"' } })
  const dir = cwd()
  const feed = (context_window) => spawnSync('node', [join(config, 'builder', 'statusline.mjs')], { input: JSON.stringify({ workspace: { current_dir: dir }, context_window }), encoding: 'utf8', env: { ...process.env, BUILDER_STATUSLINE_MS: '20000,20000' } }).stdout
  assert.equal(feed({ remaining_percentage: null, used_percentage: null }), `CTX 100 │ B ${dir}\n`)
  assert.equal(feed({ remaining_percentage: 79, used_percentage: 21 }), `CTX 79 │ B ${dir}\n`)
  assert.equal(launch(config, dir).stdout, `CTX undefined │ B ${dir}\n`, 'no context_window at all is left alone')
})

test('with builder installed and nothing running, the segment still shows: an empty bar marked idle', () => {
  const dir = cwd()
  const config = setup({ prev: { type: 'command', command: 'echo GSD' }, body: '' })
  assert.equal(launch(config, dir).stdout, 'GSD │ builder ░░░░░░░░░░ idle\n')
})
