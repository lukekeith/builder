import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leanRepo, run, git, readText } from './fixtures/lean-repo.mjs'

const WS = (r) => join(r.root, '.builder', r.feature)

/**
 * A stub verify client: logs each call, answers `verdict` / `request` / `wait` from env —
 * STUB_VERDICT_OUT/EXIT, STUB_REQ_ID, STUB_WAIT_OUT/EXIT (the `{sha}` token is HEAD's short sha).
 */
function stubVerify() {
  const dir = mkdtempSync(join(tmpdir(), 'vq-stub-'))
  const log = join(dir, 'calls.jsonl')
  const bin = join(dir, 'verify.mjs')
  writeFileSync(
    bin,
    [
      `import { appendFileSync } from 'node:fs'`,
      `import { execFileSync } from 'node:child_process'`,
      `const [cmd, ...rest] = process.argv.slice(2)`,
      `appendFileSync(process.env.STUB_LOG, JSON.stringify([cmd, ...rest]) + '\\n')`,
      `const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()`,
      `const fill = (s) => String(s ?? '').replaceAll('{sha}', sha)`,
      `if (cmd === 'verdict') { console.log(fill(process.env.STUB_VERDICT_OUT ?? 'verify ' + rest[0] + ': no verdict')); process.exit(+(process.env.STUB_VERDICT_EXIT ?? 5)) }`,
      `if (cmd === 'request') { console.log(process.env.STUB_REQ_ID ?? 'req-new'); process.exit(0) }`,
      `if (cmd === 'wait') { console.log(fill(process.env.STUB_WAIT_OUT ?? 'verify merge {sha} b: GREEN · 3s')); process.exit(+(process.env.STUB_WAIT_EXIT ?? 0)) }`,
      `process.exit(2)`,
    ].join('\n') + '\n',
  )
  const calls = () => (existsSync(log) ? readText(log).trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { env: { BUILDER_VERIFY_BIN: bin, STUB_LOG: log }, calls }
}

/** note-tags built, agent-walked (round 1 PASS) and agent-signed-off; §Schema rows landed unless `schema` says otherwise. */
function signedOff({ schema = 'landed — no migration (JSON file)', signoff = 'agent' } = {}) {
  const r = leanRepo('note-tags')
  let mf = readText(join(r.folder, 'MANIFEST.md')).replace('state: planned', 'state: built').replace('contract: none', 'contract: frozen 2026-10-23')
  writeFileSync(join(r.folder, 'MANIFEST.md'), mf)
  const spec = join(r.folder, 'SPEC.md')
  writeFileSync(spec, readText(spec).replace(/\| planned \|$/gm, `| ${schema} |`))
  git(r.root, 'add', '-A')
  git(r.root, 'commit', '-qm', 'built')
  const d = join(WS(r), 'agent-walk', 'round-1')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'report.md'), `sha: ${git(r.root, 'rev-parse', '--short', 'HEAD')}\n\n| # | App | Item | Result | Evidence |\n|---|---|---|---|---|\n| 1 | notes | x | PASS | 01.txt |\n\nverdict: PASS\n`)
  if (signoff === 'agent') assert.equal(run('condense.mjs', [r.rel, '--signoff', 'agent'], { cwd: r.root }).status, 0)
  if (signoff === 'human')
    assert.equal(run('condense.mjs', [r.rel, '--signoff', 'human', '--name', 'Luke', '--words', 'works', '--set', 'walk=Luke 2026-10-23', '--set', 'state=signed-off'], { cwd: r.root }).status, 0)
  return r
}

const GREEN = 'verify merge {sha} builder/note-tags: GREEN · 12s'

test('verify-quick: a signed-off feature whose merge tier is green on HEAD — PASS, `verify: QUICK <date> <sha7>` recorded and committed', () => {
  const r = signedOff()
  const s = stubVerify()
  const head = git(r.root, 'rev-parse', '--short', 'HEAD')
  const out = run('verify-quick.mjs', [r.rel], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: GREEN, STUB_VERDICT_EXIT: '0' } })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.match(out.stdout, /^✓ walk: /m)
  assert.match(out.stdout, /^✓ merge tier: verify merge [0-9a-f]+ builder\/note-tags: GREEN/m)
  assert.match(out.stdout, /^✓ schema: /m)
  assert.match(out.stdout, /^✓ decisions: /m)
  assert.match(out.stdout, /^✓ fixes: /m)
  assert.match(out.stdout, /^✓ obligations: /m)
  assert.match(out.stdout, /^QUICK CHECK: PASS$/m)
  const mf = readText(join(r.folder, 'MANIFEST.md'))
  assert.match(mf, new RegExp(`^verify: QUICK 2026-10-23 ${head}$`, 'm'))
  assert.match(mf, /^state: signed-off$/m)
  assert.match(mf, /^next: \/builder:resume --path docs\/features\/note-tags$/m)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): note-tags — quick check passed')
  assert.equal(git(r.root, 'status', '--short'), '')
  assert.deepEqual(s.calls().map((c) => c[0]), ['verdict'], 'a verdict on HEAD is read, never re-requested')
})

test('verify-quick: code committed after the sign-off is a walk gap — walk it again and sign off; registry commits are not', () => {
  for (const signoff of ['agent', 'human']) {
    const r = signedOff({ signoff })
    const s = stubVerify()
    writeFileSync(join(r.folder, 'walk-notes.md'), 'notes\n')
    git(r.root, 'add', '-A')
    git(r.root, 'commit', '-qm', 'walk notes')
    const clean = run('verify-quick.mjs', [r.rel, '--no-record'], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: GREEN, STUB_VERDICT_EXIT: '0' } })
    assert.match(clean.stdout, /^✓ walk: /m, `${signoff}: ${clean.stdout}`)
    mkdirSync(join(r.root, 'app'), { recursive: true })
    writeFileSync(join(r.root, 'app', 'fix.js'), 'fix\n')
    git(r.root, 'add', '-A')
    git(r.root, 'commit', '-qm', 'a fix after sign-off')
    const out = run('verify-quick.mjs', [r.rel, '--no-record'], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: GREEN, STUB_VERDICT_EXIT: '0' } })
    assert.equal(out.status, 1, out.stdout)
    assert.match(out.stdout, /^✗ walk: note-tags changed since it was signed off at [0-9a-f]{7,} \(app\/fix\.js\) — walk it again and sign off \(the ship refuses it until then\)$/m, signoff)
  }
})

test('verify-quick: gaps are listed one per line and nothing is recorded — exit 1', () => {
  const r = signedOff({ schema: 'planned' })
  const spec = join(r.folder, 'SPEC.md')
  writeFileSync(spec, readText(spec).replace('| D3 | Old files |', '| D3 | Old files | OPEN — nobody has ruled | |\n| D3b | x |') + '\n## Fixes\n\n- [ ] notes: list --tag prints the wrong order\n')
  git(r.root, 'commit', '-qam', 'gaps')
  const s = stubVerify()
  const before = git(r.root, 'rev-parse', 'HEAD')
  const out = run('verify-quick.mjs', [r.rel], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: 'verify merge {sha} builder/note-tags: RED · 1 regression · 9s\n  ✗ test/tags.test.mjs > list order — introduced by abc1234', STUB_VERDICT_EXIT: '1' } })
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^✗ merge tier: verify merge [0-9a-f]+ builder\/note-tags: RED · 1 regression/m)
  assert.match(out.stdout, /^✗ schema: SC1 note\.tags — Status "planned"/m)
  assert.match(out.stdout, /^✗ decisions: D3 /m)
  assert.match(out.stdout, /^✗ fixes: 1 open/m)
  assert.match(out.stdout, /^QUICK CHECK: GAPS \(4\)$/m)
  assert.equal(git(r.root, 'rev-parse', 'HEAD'), before, 'gaps are advice: nothing written, nothing committed')
  assert.match(readText(join(r.folder, 'MANIFEST.md')), /^verify: none$/m)
})

test('verify-quick: never walked — a gap, not a refusal', () => {
  const r = leanRepo('note-tags')
  const s = stubVerify()
  const out = run('verify-quick.mjs', [r.rel, '--no-record'], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: GREEN, STUB_VERDICT_EXIT: '0' } })
  assert.equal(out.status, 1)
  assert.match(out.stdout, /^✗ walk: no sign-off/m)
})

test('verify-quick: no merge-tier verdict — requests one held on HEAD and waits for it in the script', () => {
  const r = signedOff({ signoff: 'human' })
  const s = stubVerify()
  const out = run('verify-quick.mjs', [r.rel, '--json'], { cwd: r.root, env: { ...s.env, STUB_VERDICT_EXIT: '5', STUB_REQ_ID: 'r-42', STUB_WAIT_OUT: GREEN, STUB_WAIT_EXIT: '0' } })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  const j = JSON.parse(out.stdout)
  assert.equal(j.pass, true)
  assert.equal(j.gaps, 0)
  assert.match(j.recorded, /^QUICK 2026-10-23 [0-9a-f]+$/)
  assert.ok(j.checks.find((c) => c.name === 'walk').detail.includes('Luke'))
  const calls = s.calls()
  const req = calls.find((c) => c[0] === 'request')
  assert.deepEqual(req.slice(2), ['HEAD', '--tier', 'merge', '--hold'])
  assert.equal(calls.find((c) => c[0] === 'wait')[1], 'r-42')
})

test('verify-quick: a run still going is waited on, not requested again; past --max-wait it is a gap', () => {
  const r = signedOff()
  const s = stubVerify()
  const env = { ...s.env, STUB_VERDICT_OUT: 'verify builder/note-tags: pending (merge running)\npending: merge running r-7', STUB_VERDICT_EXIT: '75', STUB_WAIT_OUT: 'r-7: still running (2m so far) — call wait again', STUB_WAIT_EXIT: '75' }
  const out = run('verify-quick.mjs', [r.rel, '--max-wait', '1'], { cwd: r.root, env })
  assert.equal(out.status, 1, out.stdout + out.stderr)
  assert.match(out.stdout, /^✗ merge tier: still running \(r-7\)/m)
  assert.equal(s.calls().filter((c) => c[0] === 'request').length, 0)
  assert.ok(s.calls().some((c) => c[0] === 'wait' && c[1] === 'r-7'))
})

test('verify-quick: a green verdict on an older sha holds when only the registry changed since', () => {
  const r = signedOff()
  const tested = git(r.root, 'rev-parse', '--short', 'HEAD~1') // before the sign-off commit: registry-only since
  const s = stubVerify()
  const out = run('verify-quick.mjs', [r.rel, '--no-record'], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: `verify merge ${tested} builder/note-tags: GREEN · 12s`, STUB_VERDICT_EXIT: '0' } })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.equal(s.calls().filter((c) => c[0] === 'request').length, 0)
  assert.match(readText(join(r.folder, 'MANIFEST.md')), /^verify: none$/m, '--no-record writes nothing')
})

test('verify-quick --skip: records `verify: SKIPPED <date>` and commits; refused on a feature never signed off', () => {
  const r = signedOff()
  const out = run('verify-quick.mjs', [r.rel, '--skip'], { cwd: r.root })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  const mf = readText(join(r.folder, 'MANIFEST.md'))
  assert.match(mf, /^verify: SKIPPED 2026-10-23$/m)
  assert.match(mf, /^next: \/builder:resume --path docs\/features\/note-tags$/m)
  assert.equal(git(r.root, 'log', '-1', '--format=%s'), 'docs(note-tags): note-tags — verify skipped')
  const sha = git(r.root, 'rev-parse', 'HEAD')
  assert.equal(run('verify-quick.mjs', [r.rel, '--skip'], { cwd: r.root }).status, 0)
  assert.equal(git(r.root, 'rev-parse', 'HEAD'), sha, 're-run is a no-op')
  const raw = leanRepo('note-tags')
  const no = run('verify-quick.mjs', [raw.rel, '--skip'], { cwd: raw.root })
  assert.equal(no.status, 1)
  assert.match(no.stderr, /not signed off/)
})

test('verify-quick: verify READY already recorded stands — never downgraded to QUICK', () => {
  const r = signedOff()
  run('advance.mjs', [r.rel, '--set', 'verify=READY 2026-10-23', '--set', 'state=verified', '--commit', 'verify-ready'], { cwd: r.root })
  const s = stubVerify()
  const out = run('verify-quick.mjs', [r.rel], { cwd: r.root, env: { ...s.env, STUB_VERDICT_OUT: GREEN, STUB_VERDICT_EXIT: '0' } })
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.match(readText(join(r.folder, 'MANIFEST.md')), /^verify: READY 2026-10-23$/m)
  assert.match(out.stdout, /READY stands/)
})

test('verify-quick: usage — exit 2', () => {
  assert.equal(run('verify-quick.mjs', [], { cwd: tmpdir() }).status, 2)
})
