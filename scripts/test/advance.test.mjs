import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { leanRepo, run, git, readText } from './fixtures/lean-repo.mjs'
import { setManifestKeys } from '../feature-core.mjs'

const ws = (r) => join(r.root, '.builder', r.feature)

test('setManifestKeys: replaces in place, keeps a comment, inserts a new key in REFERENCE order', () => {
  const text = 'size: md\nstate: planned   # moves\nhead: abc\nwalk: none\nverify: none\nblocked: none\n'
  const out = setManifestKeys(text, [['state', 'built'], ['ready', 'yes 2026-10-23 abc'], ['contract', 'frozen 2026-10-23']], ['blocked'])
  assert.equal(out, 'size: md\nstate: built   # moves\nhead: abc\ncontract: frozen 2026-10-23\nwalk: none\nverify: none\nready: yes 2026-10-23 abc\n')
  assert.equal(setManifestKeys('', [['state', 'spec']]), 'state: spec\n')
  assert.equal(setManifestKeys('a-b: 1\n', [['zzz', 'x']]), 'a-b: 1\nzzz: x\n')
})

test('advance: keys, head, branch, ledger line and the commit — one call, only the manifest committed', () => {
  const r = leanRepo('note-tags')
  writeFileSync(join(r.root, 'README.md'), '# dirty, not ours\n')
  const before = git(r.root, 'rev-parse', '--short', 'HEAD')
  const out = run('advance.mjs', [r.rel, '--set', 'state=built', '--set', 'ready=yes 2026-10-23 ' + before, '--set', 'next=/builder:agent-walk --path docs/features/note-tags', '--head', '--ledger', 'Walk readiness: clean', '--commit', 'built'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const mf = readText(join(r.folder, 'MANIFEST.md'))
  assert.match(mf, /^state: built$/m)
  assert.match(mf, new RegExp(`^head: ${before}$`, 'm'))
  assert.match(mf, /^branch: builder\/note-tags$/m)
  assert.match(mf, /^next: \/builder:agent-walk --path docs\/features\/note-tags$/m)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'chore(note-tags): note-tags — built, awaiting the walk')
  assert.equal(git(r.root, 'log', '-1', '--format=%b'), '')
  assert.deepEqual(git(r.root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/features/note-tags/MANIFEST.md'])
  assert.match(git(r.root, 'status', '--short'), /M README.md/)
  const ledger = readText(join(ws(r), 'progress.md'))
  assert.equal(ledger, '# builder ledger — plan: docs/features/note-tags/PLAN.md\nWalk readiness: clean\n')
  assert.match(out.stdout, /commit: [0-9a-f]+ chore\(note-tags\)/)
})

test('advance: re-running the same call after it landed is a no-op — no second commit, no second ledger line', () => {
  const r = leanRepo('note-tags')
  const args = [r.rel, '--set', 'state=audited', '--head', '--ledger', 'audit: pass 1 clean', '--commit', 'audited']
  assert.equal(run('advance.mjs', args, { cwd: r.root }).status, 0)
  const sha = git(r.root, 'rev-parse', 'HEAD')
  const again = run('advance.mjs', args, { cwd: r.root })
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already applied/)
  assert.equal(git(r.root, 'rev-parse', 'HEAD'), sha)
  assert.equal(readText(join(ws(r), 'progress.md')).split('\n').filter((l) => l === 'audit: pass 1 clean').length, 1)
})

test('advance: a crash between the manifest write and the commit — the re-run commits it once', () => {
  const r = leanRepo('note-tags')
  const args = [r.rel, '--set', 'contract=frozen 2026-10-23', '--set', 'state=building', '--ledger', 'Phase 2 (notes): closed — gates deferred to the end (tests: slice=own) · abc1234', '--commit', 'chore({key}): {feature} — contract frozen at phase 2']
  assert.equal(run('advance.mjs', [...args.slice(0, -2), '--no-commit'], { cwd: r.root }).status, 0)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'fixture')
  const out = run('advance.mjs', args, { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'chore(note-tags): note-tags — contract frozen at phase 2')
  assert.equal(git(r.root, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(readText(join(ws(r), 'progress.md')).split('\n').length, 3)
})

test('advance: --add commits a SPEC edit with the manifest; the ticket is the key; trailer and body go in the message', () => {
  const r = leanRepo('note-tags')
  writeFileSync(join(r.folder, 'MANIFEST.md'), readText(join(r.folder, 'MANIFEST.md')).replace('ticket: none', 'ticket: NT-7'))
  writeFileSync(join(r.folder, 'SPEC.md'), readText(join(r.folder, 'SPEC.md')) + '\n## Fixes\n\n- [ ] notes: x\n')
  const out = run('advance.mjs', [r.rel, '--set', 'next=/builder:resume --path docs/features/note-tags', '--add', join(r.rel, 'SPEC.md'), '--commit', 'docs({key}): {feature} — agent walk round 1: 1 fixes', '--body', 'round 1 evidence in the workspace', '--trailer', 'Co-Authored-By: X <x@example.com>'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(NT-7): note-tags — agent walk round 1: 1 fixes')
  assert.equal(git(r.root, 'log', '-1', '--format=%b').trim(), 'round 1 evidence in the workspace\n\nCo-Authored-By: X <x@example.com>')
  assert.deepEqual(git(r.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['docs/features/note-tags/MANIFEST.md', 'docs/features/note-tags/SPEC.md'])
})

test('advance: --unset drops a key; nothing changed and no --commit is a quiet no-op', () => {
  const r = leanRepo('note-tags')
  assert.equal(run('advance.mjs', [r.rel, '--unset', 'target', '--commit', 'chore({key}): drop target'], { cwd: r.root }).status, 0)
  assert.doesNotMatch(readText(join(r.folder, 'MANIFEST.md')), /^target:/m)
  const out = run('advance.mjs', [r.rel, '--set', 'state=planned'], { cwd: r.root })
  assert.equal(out.status, 0)
  assert.match(out.stdout, /manifest: unchanged/)
})

test('advance: a ledger that names another plan is never written', () => {
  const r = leanRepo('note-tags')
  run('advance.mjs', [r.rel, '--ledger', 'x'], { cwd: r.root })
  writeFileSync(join(ws(r), 'progress.md'), '# builder ledger — plan: docs/features/other/PLAN.md\n')
  const out = run('advance.mjs', [r.rel, '--ledger', 'y'], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /another feature's ledger/)
  assert.equal(readText(join(ws(r), 'progress.md')), '# builder ledger — plan: docs/features/other/PLAN.md\n')
})

test('advance: bad input is refused before anything is written', () => {
  const r = leanRepo('note-tags')
  const out = run('advance.mjs', [r.rel, '--set', 'novalue', '--commit', 'built'], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /key=value/)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'fixture')
  assert.equal(existsSync(join(ws(r), 'progress.md')), false)
  assert.equal(run('advance.mjs', [], { cwd: r.root }).status, 2)
})
