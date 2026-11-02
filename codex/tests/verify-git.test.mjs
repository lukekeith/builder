// codex/tests/verify-git.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sh } from '../scripts/verify/git.mjs'

test('sh: a command past its timeout is killed and throws promptly, saying so', () => {
  const t0 = Date.now()
  assert.throws(() => sh('sleep 5; true', { timeout: 200 }), /timed out after 0\.2s/)
  assert.ok(Date.now() - t0 < 2000)
})

test('sh: a command inside its timeout returns its stdout', () => {
  assert.equal(sh('echo hi', { timeout: 5000 }).trim(), 'hi')
})

test('git: a repo with its own identity keeps it — a merged checkout is authored by that user, not builder-verify', async () => {
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { git } = await import('../scripts/verify/git.mjs')
  const { ensureCheckout, mergedCheckout } = await import('../scripts/verify/checkouts.mjs')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vgit-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Pat Tester')
  git(root, 'config', 'user.email', 'pat@example.com')
  writeFileSync(join(root, 'a.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'checkout', '-qb', 'feat')
  writeFileSync(join(root, 'b.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'b')
  const feat = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')
  const co = ensureCheckout(root, 0)
  const m = mergedCheckout(co, git(root, 'rev-parse', 'main'), feat, 'merge feat')
  assert.equal(git(co, 'log', '-1', '--format=%an <%ae>', m.sha), 'Pat Tester <pat@example.com>')
  assert.equal(git(co, 'log', '-1', '--format=%cn <%ce>', m.sha), 'Pat Tester <pat@example.com>')
})
