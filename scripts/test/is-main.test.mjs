// scripts/test/is-main.test.mjs
// A script run through a symlinked path (a plugin dir under /var → /private/var, a linked checkout)
// must still know it is the main module: argv[1] is the path as typed, import.meta.url the resolved one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('scripts run through a symlinked directory still print their output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismain-'))
  try {
    symlinkSync(ROOT, join(dir, 'b'))
    for (const s of ['docs.mjs', 'verify/verify.mjs', 'advance.mjs', 'dispatch.mjs', 'impact.mjs']) {
      const direct = spawnSync(process.execPath, [join(ROOT, 'scripts', s)], { cwd: dir, encoding: 'utf8' })
      const linked = spawnSync(process.execPath, [join(dir, 'b', 'scripts', s)], { cwd: dir, encoding: 'utf8' })
      assert.ok((direct.stdout + direct.stderr).trim(), `${s} prints something when run directly`)
      assert.equal(linked.stdout + linked.stderr, direct.stdout + direct.stderr, `${s} through a symlink prints what it prints directly`)
      assert.equal(linked.status, direct.status, `${s} exits the same through a symlink`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every main-module guard in scripts/ compares realpaths on both sides', () => {
  const files = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) {
        if (f !== 'test' && f !== 'node_modules') walk(p)
      } else if (f.endsWith('.mjs')) files.push(p)
    }
  }
  walk(join(ROOT, 'scripts'))
  const guards = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (l.includes('process.argv[1]') && l.includes('===')) guards.push([`${relative(ROOT, f)}:${i + 1}`, l])
    })
  }
  assert.ok(guards.length >= 15, `found the guards (${guards.length})`)
  for (const [at, l] of guards) {
    assert.match(l, /realpathSync\(process\.argv\[1\]\)/, `${at} realpaths argv[1]: ${l.trim()}`)
    assert.match(l, /===\s*realpathSync\(/, `${at} realpaths the module path: ${l.trim()}`)
  }
})
