import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leanRepo, run, git, readText } from './fixtures/lean-repo.mjs'
import { stripPlan, setHeader } from '../condense.mjs'

const WS = (r) => join(r.root, '.builder', r.feature)

/** A note-tags repo the way agent-walk finds it: §Plan written, built, walk-ready, round reports in the workspace. */
function built({ rounds = [['abc1234', 'PASS']], manifest = {} } = {}) {
  const r = leanRepo('note-tags')
  assert.equal(run('plan-slices.mjs', [r.rel, '--index', '--write'], { cwd: r.root }).status, 0)
  let mf = readText(join(r.folder, 'MANIFEST.md')).replace('state: planned', 'state: built').replace('ready: none', 'ready: yes 2026-10-23 abc1234').replace('contract: none', 'contract: frozen 2026-10-23')
  for (const [k, v] of Object.entries(manifest)) mf = mf.replace(new RegExp(`^${k}:.*$`, 'm'), `${k}: ${v}`)
  writeFileSync(join(r.folder, 'MANIFEST.md'), mf)
  git(r.root, 'add', '-A')
  git(r.root, 'commit', '-qm', 'built')
  rounds.forEach(([sha, verdict], i) => {
    const d = join(WS(r), 'agent-walk', `round-${i + 1}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'report.md'), `sha: ${sha}\n\n| # | App | Item | Result | Evidence |\n|---|---|---|---|---|\n| 1 | notes | x | ${verdict === 'PASS' ? 'PASS' : 'FAIL'} | 01.txt |\n\nverdict: ${verdict === 'PASS' ? 'PASS' : 'PROBLEMS (1)'}\n`)
  })
  return r
}

test('stripPlan: cuts §Plan by its heading, never to EOF when a section follows; a fenced ## Plan is not a heading', () => {
  const spec = '# f — spec\n> md\n\n## Testing\n\n```md\n## Plan\nnot a heading\n```\n\n## Plan\n\n- Phase 1 · Task 1 · a\n\n## Fixes\n\n- [ ] notes: x\n'
  assert.equal(stripPlan(spec), '# f — spec\n> md\n\n## Testing\n\n```md\n## Plan\nnot a heading\n```\n\n## Fixes\n\n- [ ] notes: x\n')
  assert.equal(stripPlan('# f\n\n## Findings & risks\n\nx\n\n## Plan\n\n- a\n'), '# f\n\n## Findings & risks\n\nx\n')
  assert.equal(stripPlan('# f\n\n## Idea\n'), '# f\n\n## Idea\n')
})

test('setHeader: under the title, replacing an earlier sign-off line, an AGENT-VERIFIED line or a hold line', () => {
  const s = '# f — spec\n> md · no ticket\n\n## Idea\n'
  const a = setHeader(s, ['> 🤖 AGENT SIGNED OFF x'])
  assert.equal(a, '# f — spec\n> 🤖 AGENT SIGNED OFF x\n> md · no ticket\n\n## Idea\n')
  assert.equal(setHeader(a, ['> ✅ SIGNED OFF y', '> 🛑 PR HELD (d): "r"']), '# f — spec\n> ✅ SIGNED OFF y\n> 🛑 PR HELD (d): "r"\n> md · no ticket\n\n## Idea\n')
  assert.equal(setHeader('# f\n> 🤖 AGENT-VERIFIED old\n> md\n', ['> 🤖 AGENT SIGNED OFF z']), '# f\n> 🤖 AGENT SIGNED OFF z\n> md\n')
})

test('condense --signoff agent: agent-walk §4 AGENT-PASS in one call — manifest, header, §Plan cut, PLAN.md removed, one commit', () => {
  const r = built()
  const out = run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const spec = readText(join(r.folder, 'SPEC.md'))
  assert.equal(spec.split('\n')[1], '> 🤖 AGENT SIGNED OFF 2026-10-23 — abc1234 · agent walk round 1 · not human-tested · evidence: .builder/note-tags/agent-walk/round-1/')
  assert.equal(spec.split('\n')[2], '> md · no ticket')
  assert.doesNotMatch(spec, /^## Plan$/m)
  assert.match(spec, /^## Findings & risks$/m)
  assert.equal(existsSync(join(r.folder, 'PLAN.md')), false)
  const mf = readText(join(r.folder, 'MANIFEST.md'))
  assert.match(mf, /^walk: agent-pass 2026-10-23 abc1234$/m)
  assert.match(mf, /^state: signed-off$/m)
  assert.match(mf, /^verify: none$/m)
  assert.match(mf, /^next: \/builder:verify --path docs\/features\/note-tags$/m)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): note-tags agent signed off (not human-tested)')
  assert.equal(git(r.root, 'status', '--short'), '')
  assert.throws(() => git(r.root, 'cat-file', '-e', 'HEAD:docs/features/note-tags/PLAN.md'))
})

test('condense --signoff agent: re-run after it landed is a no-op', () => {
  const r = built()
  assert.equal(run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root }).status, 0)
  const sha = git(r.root, 'rev-parse', 'HEAD')
  const again = run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already applied/)
  assert.equal(git(r.root, 'rev-parse', 'HEAD'), sha)
})

test('condense --signoff agent: the last PASS round counts; no PASS round → refused, nothing written', () => {
  const r = built({ rounds: [['aaa1111', 'PROBLEMS'], ['bbb2222', 'PASS']] })
  assert.equal(run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root }).status, 0)
  assert.match(readText(join(r.folder, 'SPEC.md')), /— bbb2222 · agent walk round 2 · not human-tested · evidence: \.builder\/note-tags\/agent-walk\/round-2\//)
  const bad = built({ rounds: [['aaa1111', 'PROBLEMS']] })
  const out = run('condense.mjs', [bad.rel, '--signoff', 'agent'], { cwd: bad.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /no passing agent walk round/)
  assert.equal(git(bad.root, 'status', '--short'), '')
})

test('condense --signoff agent: walk: agent-pass already set keeps ITS sha, not HEAD or the report', () => {
  const r = built({ rounds: [['ccc3333', 'PASS']], manifest: { walk: 'agent-pass 2026-10-22 ddd4444' } })
  assert.equal(run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root }).status, 0)
  assert.match(readText(join(r.folder, 'MANIFEST.md')), /^walk: agent-pass 2026-10-22 ddd4444$/m)
  assert.match(readText(join(r.folder, 'SPEC.md')), /SIGNED OFF 2026-10-22 — ddd4444 · agent walk round 1/)
})

test('condense --signoff agent --no-walk: end=none/touched — the no-walk header at HEAD', () => {
  const r = built({ rounds: [], manifest: { tests: 'slice=own end=touched review=end' } })
  const head = git(r.root, 'rev-parse', '--short', 'HEAD')
  const out = run('condense.mjs', [r.rel, '--signoff', 'agent', '--no-walk'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(readText(join(r.folder, 'SPEC.md')).split('\n')[1], `> 🤖 AGENT SIGNED OFF — no walk (tests: end=touched) — not human-tested · 2026-10-23 — ${head}`)
  assert.match(readText(join(r.folder, 'MANIFEST.md')), new RegExp(`^walk: agent-pass 2026-10-23 ${head}$`, 'm'))
})

test('condense --signoff human: the sign-off line (+ hold line), PLAN.md removed, manifest left to the caller', () => {
  const r = built({ manifest: { hold: '"wait for the release train"' } })
  const out = run('condense.mjs', [r.rel, '--signoff', 'human', '--name', 'Luke', '--words', 'works, ship it', '--sha', 'eee5555'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const lines = readText(join(r.folder, 'SPEC.md')).split('\n')
  assert.equal(lines[1], '> ✅ SIGNED OFF 2026-10-23 — eee5555 · by Luke: "works, ship it"')
  assert.equal(lines[2], '> 🛑 PR HELD (2026-10-23): "wait for the release train"')
  assert.match(readText(join(r.folder, 'MANIFEST.md')), /^state: built$/m)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): condense note-tags at sign-off')
})

test('condense --ship --into: agent form — header flipped, manifest removed, workspace removed, archived, one commit; re-run is a no-op', () => {
  const r = built()
  assert.equal(run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root }).status, 0)
  assert.equal(run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--set', 'state=verified', '--commit', 'verify-ready'], { cwd: r.root }).status, 0)
  const out = run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const arch = join(r.root, 'docs', 'features', '_archive', 'note-tags')
  assert.equal(existsSync(r.folder), false)
  assert.deepEqual(git(r.root, 'ls-files', 'docs/features').split('\n'), ['docs/features/_archive/note-tags/SPEC.md'])
  assert.equal(readText(join(arch, 'SPEC.md')).split('\n')[1], '> ✅ SHIPPED 2026-10-23 — merged into main · no ticket · 🤖 agent signed off (walk round 1), not human-tested')
  assert.equal(existsSync(WS(r)), false)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): note-tags shipped into main')
  assert.equal(git(r.root, 'status', '--short'), '')
  const sha = git(r.root, 'rev-parse', 'HEAD')
  const again = run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root })
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already shipped/)
  assert.equal(git(r.root, 'rev-parse', 'HEAD'), sha)
})

test('condense --ship: a crash before the commit — the re-run finishes it with one commit', () => {
  const r = built()
  run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  const n = +git(r.root, 'rev-list', '--count', 'HEAD')
  assert.equal(run('condense.mjs', [r.rel, '--ship', '--into', 'main', '--no-commit'], { cwd: r.root }).status, 0)
  assert.equal(existsSync(r.folder), false)
  const out = run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(+git(r.root, 'rev-list', '--count', 'HEAD'), n + 1)
  assert.equal(git(r.root, 'status', '--short'), '')
})

test('condense --ship: a crash right after `git rm MANIFEST.md` — the re-run still ships', () => {
  const r = built()
  run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  const spec = join(r.folder, 'SPEC.md')
  writeFileSync(spec, readText(spec).replace(/^> 🤖 AGENT SIGNED OFF.*$/m, '> ✅ SHIPPED 2026-10-23 — merged into main · no ticket · 🤖 agent signed off (walk round 1), not human-tested'))
  git(r.root, 'rm', '-q', 'docs/features/note-tags/MANIFEST.md')
  const out = run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): note-tags shipped into main')
  assert.deepEqual(git(r.root, 'ls-files', 'docs/features').split('\n'), ['docs/features/_archive/note-tags/SPEC.md'])
  assert.equal(git(r.root, 'status', '--short'), '')
})

test('condense --ship: human form on a PR — name and words carried over, hold dropped; refusals', () => {
  const r = built({ manifest: { ticket: 'NT-7' } })
  run('condense.mjs', [r.rel, '--signoff', 'human', '--name', 'Luke', '--words', 'good', '--sha', 'eee5555', '--hold', 'wait'], { cwd: r.root })
  const notReady = run('condense.mjs', [r.rel, '--ship', '--pr', '12'], { cwd: r.root })
  assert.equal(notReady.status, 1)
  assert.match(notReady.stderr, /verify is not READY/)
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  mkdirSync(join(r.root, 'docs', 'features', '_archive', 'note-tags'), { recursive: true })
  writeFileSync(join(r.root, 'docs', 'features', '_archive', 'note-tags', 'SPEC.md'), '# other\n')
  const clash = run('condense.mjs', [r.rel, '--ship', '--pr', '12'], { cwd: r.root })
  assert.equal(clash.status, 1)
  assert.match(clash.stderr, /already exists/)
  git(r.root, 'clean', '-fdq', 'docs/features/_archive')
  const ok = run('condense.mjs', [r.rel, '--ship', '--pr', '12'], { cwd: r.root })
  assert.equal(ok.status, 0, ok.stderr)
  const lines = readText(join(r.root, 'docs', 'features', '_archive', 'note-tags', 'SPEC.md')).split('\n')
  assert.equal(lines[1], '> ✅ SHIPPED 2026-10-23 — PR #12 · NT-7 · signed off by Luke: "good"')
  assert.equal(lines[2], '> md · no ticket')
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(NT-7): note-tags shipped in PR #12')
})

test('condense --ship --into: refused until the target is merged into this branch', () => {
  const r = built()
  run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  git(r.root, 'checkout', '-q', 'main')
  writeFileSync(join(r.root, 'other.txt'), 'x\n')
  git(r.root, 'add', 'other.txt')
  git(r.root, 'commit', '-qm', 'main moved')
  git(r.root, 'checkout', '-q', 'builder/note-tags')
  const out = run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /merge main into this branch first/)
})

test('condense --ship: a program child — its child: line reads shipped', () => {
  const r = built()
  mkdirSync(join(r.root, 'docs', 'features', 'tagging'), { recursive: true })
  writeFileSync(join(r.root, 'docs', 'features', 'tagging', 'MANIFEST.md'), 'tier: program\nchild: note-tags — verified\nchild: tag-colours — spec\n')
  git(r.root, 'add', '-A')
  git(r.root, 'commit', '-qm', 'program')
  run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  assert.equal(run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root }).status, 0)
  assert.equal(readText(join(r.root, 'docs', 'features', 'tagging', 'MANIFEST.md')), 'tier: program\nchild: note-tags — shipped\nchild: tag-colours — spec\n')
  assert.equal(git(r.root, 'status', '--short'), '')
})

test('condense --ship --merged: a feature already in the target — SHIPPED naming the merge, run on the target; refused when the sha is not there', () => {
  const r = built({ manifest: { ticket: 'NT-7' } })
  run('condense.mjs', [r.rel, '--signoff', 'human', '--name', 'Luke', '--words', 'good', '--sha', 'eee5555'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--set', 'state=verified', '--commit', 'verify-ready'], { cwd: r.root })
  // A commit on the feature branch only: not in main.
  const branchOnly = git(r.root, 'rev-parse', '--short', 'HEAD')
  git(r.root, 'checkout', '-q', 'main')
  const elsewhere = run('condense.mjs', [r.rel, '--ship', '--merged', branchOnly], { cwd: r.root })
  assert.equal(elsewhere.status, 1)
  git(r.root, 'merge', '-q', '--no-ff', '-m', 'merge note-tags by hand', 'builder/note-tags')
  const sha = git(r.root, 'rev-parse', '--short', 'HEAD')
  const notThere = run('condense.mjs', [r.rel, '--ship', '--merged', 'deadbeef'], { cwd: r.root })
  assert.equal(notThere.status, 1)
  assert.match(notThere.stderr, /not a commit here/)
  const ok = run('condense.mjs', [r.rel, '--ship', '--merged', sha], { cwd: r.root })
  assert.equal(ok.status, 0, ok.stderr)
  const arch = join(r.root, 'docs', 'features', '_archive', 'note-tags')
  assert.equal(readText(join(arch, 'SPEC.md')).split('\n')[1], `> ✅ SHIPPED 2026-10-23 — merged ${sha} · NT-7 · signed off by Luke: "good"`)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), `docs(NT-7): note-tags shipped — merged ${sha}`)
  assert.equal(git(r.root, 'branch', '--show-current'), 'main')
  assert.equal(git(r.root, 'status', '--short'), '')
})

test('condense --ship --merged: a sha in this branch but not in the target is refused, nothing touched', () => {
  const r = built()
  run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  const sha = git(r.root, 'rev-parse', '--short', 'HEAD')
  const out = run('condense.mjs', [r.rel, '--ship', '--merged', sha], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, new RegExp(`${sha} is not in main`))
  assert.ok(existsSync(join(r.folder, 'MANIFEST.md')))
})

test('condense --ship --into: a human sign-off keeps its signer — never reads as an agent sign-off', () => {
  const r = built()
  run('condense.mjs', [r.rel, '--signoff', 'human', '--name', 'Luke', '--words', 'works', '--sha', 'eee5555'], { cwd: r.root })
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--commit', 'verify-ready'], { cwd: r.root })
  assert.equal(run('condense.mjs', [r.rel, '--ship', '--into', 'main'], { cwd: r.root }).status, 0)
  const line = readText(join(r.root, 'docs', 'features', '_archive', 'note-tags', 'SPEC.md')).split('\n')[1]
  assert.equal(line, '> ✅ SHIPPED 2026-10-23 — merged into main · no ticket · signed off by Luke: "works"')
})
