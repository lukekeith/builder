import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { leanRepo, run, git, readText } from './fixtures/lean-repo.mjs'

const WS = (r) => join(r.root, '.builder', r.feature)

/** note-tags where the build lane ended: phases closed, gates memoised, walk.md written, ledger with a ruling. */
function walkReady() {
  const r = leanRepo('note-tags')
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace('state: planned', 'state: building').replace('contract: none', 'contract: frozen 2026-10-23').replace('ready: none', 'ready: pending "dev env (fleet walk lane)"'))
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'cli.mjs'), '// built\n')
  git(r.root, 'add', '-A')
  git(r.root, 'commit', '-qm', 'chore(note-tags): note-tags — phases closed, awaiting the walk lane')
  const head = git(r.root, 'rev-parse', '--short', 'HEAD')
  mkdirSync(join(r.root, '.builder', 'gates'), { recursive: true })
  writeFileSync(join(r.root, '.builder', 'gates', 'fast-notes.json'), JSON.stringify({ hash: 'x', head, when: '2026-10-23T13:47:00.000Z', exit: 0, lines: ['✓ npm test (16s)'] }))
  mkdirSync(WS(r), { recursive: true })
  writeFileSync(join(WS(r), 'progress.md'), '# builder ledger — plan: docs/features/note-tags/PLAN.md\nTask 3: complete (commits a..b, no task review (tests: review=end))\nRuling: list --tag a --tag Bad reports invalid tag — both exit 1 — costs a one-line reorder\nTask 2: minor (deferred): show calls tagsOf twice\n')
  assert.equal(run('walk-script.mjs', [r.rel], { cwd: r.root }).status, 0)
  return { ...r, head }
}

test('handoff write: the build lane\'s end state — state, head, gates per app, contract, walk.md, open items, the walk lane\'s route', () => {
  const r = walkReady()
  const out = run('handoff.mjs', ['write', r.rel, '--note', 'Deep set: none configured — nothing ran.'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const h = readText(join(WS(r), 'handoff.md'))
  assert.match(h, /^# note-tags — handoff from the build lane\n/)
  assert.match(h, new RegExp(`^written: 2026-10-23 · head: ${r.head} · branch: builder/note-tags$`, 'm'))
  assert.match(h, /^state: building$/m)
  assert.match(h, /^ready: pending "dev env \(fleet walk lane\)"$/m)
  assert.match(h, /^contract: frozen 2026-10-23$/m)
  assert.match(h, /^tests: slice=own end=risk review=end$/m)
  assert.match(h, new RegExp(`- notes — fast: PASS at ${r.head} \\(2026-10-23T13:47:00.000Z\\) — no code change since`))
  assert.match(h, /- deep set: none configured/)
  assert.match(h, /walk\.md — 12 per-app items \(11 \[risk\]\) \+ cross-app E1–E7/)
  assert.match(h, /Ruling: list --tag a --tag Bad reports invalid tag/)
  assert.match(h, /Task 2: minor \(deferred\): show calls tagsOf twice/)
  assert.match(h, /Deep set: none configured — nothing ran\./)
  assert.match(h, /REFERENCE §Walk readiness/)
  assert.match(h, /advance\.mjs docs\/features\/note-tags --set state=built --set "ready=yes <YYYY-MM-DD> <sha>" --set "next=\/builder:agent-walk --path docs\/features\/note-tags" --head --commit built/)
  assert.match(h, /No database and nothing to migrate|No dev environment/)
})

test('handoff write: re-running with nothing changed leaves the file as it was', () => {
  const r = walkReady()
  run('handoff.mjs', ['write', r.rel], { cwd: r.root })
  const p = join(WS(r), 'handoff.md')
  const before = readText(p)
  const out = run('handoff.mjs', ['write', r.rel], { cwd: r.root })
  assert.match(out.stdout, /unchanged/)
  assert.equal(readText(p), before)
})

test('handoff read: trusted while only docs moved — prints it, then the walk lane\'s docs; stale after a code commit or a manifest move', () => {
  const r = walkReady()
  run('handoff.mjs', ['write', r.rel], { cwd: r.root })
  writeFileSync(join(r.folder, 'SPEC.md'), readText(join(r.folder, 'SPEC.md')) + '\n')
  git(r.root, 'commit', '-qam', 'docs: spec typo')
  const ok = run('handoff.mjs', ['read', r.rel], { cwd: r.root })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /^trust: ok — /m)
  assert.match(ok.stdout, /# note-tags — handoff from the build lane/)
  assert.match(ok.stdout, /\n## Walk readiness\n/)
  assert.match(ok.stdout, /\n## When the last phase signs\n/)
  assert.doesNotMatch(run('handoff.mjs', ['read', r.rel, '--no-docs'], { cwd: r.root }).stdout, /## Walk readiness\n/)

  writeFileSync(join(r.root, 'src', 'cli.mjs'), '// changed\n')
  git(r.root, 'commit', '-qam', 'fix: later code')
  const stale = run('handoff.mjs', ['read', r.rel], { cwd: r.root })
  assert.equal(stale.status, 3)
  assert.match(stale.stdout, /^stale: code changed since the handoff \(src\/cli\.mjs\) — re-derive from the manifest/m)

  const r2 = walkReady()
  run('handoff.mjs', ['write', r2.rel], { cwd: r2.root })
  run('advance.mjs', [r2.rel, '--set', 'state=built', '--commit', 'built'], { cwd: r2.root })
  const moved = run('handoff.mjs', ['read', r2.rel], { cwd: r2.root })
  assert.equal(moved.status, 3)
  assert.match(moved.stdout, /stale: the manifest moved since the handoff \(state: building → built\)/)
})

test('handoff read: no handoff → exit 3, saying what to do instead', () => {
  const r = leanRepo('note-tags')
  const out = run('handoff.mjs', ['read', r.rel], { cwd: r.root })
  assert.equal(out.status, 3)
  assert.match(out.stdout, /^stale: no handoff\.md/m)
  assert.equal(run('handoff.mjs', ['nope', r.rel], { cwd: r.root }).status, 2)
})
