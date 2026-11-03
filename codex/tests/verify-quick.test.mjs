// verify-quick (codex/scripts/verify-quick.mjs) — Claude 6.1.0's quick check after sign-off, adapted to
// Codex: the feature is named (its runtime record locates the worktree), the merge tier is the held
// merge `lifecycle.mjs prepare` asks for, and a pass is recorded runtime-only with `record-check`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { VERIFY_CONFIG, landFeature, settle } from './land-helpers.mjs';

const SCRIPT = new URL('../scripts/verify-quick.mjs', import.meta.url).pathname;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quick = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, BUILDER_TODAY: '2026-11-03' } });

const SPEC = ({ fixes = '- [x] the save button was disabled', schema = '| SC1 | notes | add tags column | 0042_tags |', decision = '| D1 | Tags are free text | Ruled: free text |', apps = '' } = {}) =>
  `# test — spec\n\n## Idea\nTags on notes.\n${apps}\n## Schema & API changes\n| ID | App | Change | Status |\n|---|---|---|---|\n${schema}\n\n## Decisions\n| ID | Question | Ruling |\n|---|---|---|\n${decision}\n\n## Fixes\n${fixes}\n`;

function repo(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-vq-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n'); fs.mkdirSync(path.join(root, '.claude')); fs.writeFileSync(path.join(root, '.claude/builder.md'), VERIFY_CONFIG);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => { settle(root); fs.rmSync(folder, { recursive: true, force: true }); }); return root;
}
/** A built feature with its SPEC; signed off by the agent walk's checkpoint unless `signed` is false. */
async function feature(root, spec = SPEC(), signed = true) {
  const m = await run('start', 'test', { root });
  fs.mkdirSync(m.featurePath, { recursive: true });
  fs.writeFileSync(path.join(m.featurePath, 'SPEC.md'), spec); fs.writeFileSync(path.join(m.featurePath, 'PLAN.md'), '### Task 1\n');
  fs.writeFileSync(path.join(m.worktree, 'feature.txt'), 'feature\n'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-qm', 'built');
  await run('checkpoint', 'test', { root, phase: signed ? 'signed-off' : 'built', next: signed ? 'Choose a check' : 'Walk it' });
  git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-qm', signed ? 'signed off' : 'built');
  return m;
}

test('a signed-off feature with nothing open and the merge tier green on HEAD: PASS, recorded quick at HEAD, and deliver lands it as quick', async t => {
  const root = repo(t); const m = await feature(root);
  const r = quick(root, 'test', '--max-wait', '120');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^quick check — test at [0-9a-f]{7}$/);
  assert.deepEqual(lines.slice(1, 7).map(l => l.split(':')[0]), ['✓ walk', '✓ fixes', '✓ schema', '✓ decisions', '✓ obligations', '✓ merge tier']);
  assert.match(lines[1], /signed off — not human-tested/);
  assert.match(lines[6], /green on [0-9a-f]{7} merged onto work/);
  assert.equal(lines[7], 'QUICK CHECK: PASS');
  assert.match(lines[8], /^recorded: quick check passed at [0-9a-f]{7} — deliver next$/);
  const s = await run('status', 'test', { root });
  assert.equal(s.check.kind, 'quick'); assert.equal(s.check.head, git(m.worktree, 'rev-parse', 'HEAD')); assert.equal(s.check.date, '2026-11-03');
  assert.equal(git(m.worktree, 'status', '--porcelain'), '', 'runtime-only: nothing written to the feature');
  const again = quick(root, 'test', '--max-wait', '120'); assert.equal(again.status, 0); assert.match(again.stdout, /already recorded: quick check at [0-9a-f]{7}/);
  const d = await landFeature(root, 'test'); assert.equal(d.status, 'landed'); assert.equal(d.landedCheck, 'quick');
});

test('gaps are advice: each ✗ names it, nothing is recorded, exit 1; --json carries the same', async t => {
  const root = repo(t);
  await feature(root, SPEC({ fixes: '- [ ] tags overflow on mobile', schema: '| SC1 | notes | add tags column | planned |', decision: '| D1 | Free text or a fixed list? | OPEN |', apps: '\n## Apps\n| App | In scope |\n|---|---|\n| other | ✅ |\n' }));
  const r = quick(root, 'test', '--max-wait', '120');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^✗ fixes: 1 open under ## Fixes — first: tags overflow on mobile$/m);
  assert.match(r.stdout, /^✗ schema: SC1 add tags column — Status "planned"/m);
  assert.match(r.stdout, /^✗ decisions: D1 OPEN in §Decisions$/m);
  assert.match(r.stdout, /^✗ obligations: \d+ dangling — /m);
  assert.match(r.stdout, /^✓ merge tier: /m);
  assert.match(r.stdout, /^QUICK CHECK: GAPS \(4\)$/m);
  assert.equal((await run('status', 'test', { root })).check ?? null, null, 'a gap records nothing');
  const j = quick(root, 'test', '--json', '--max-wait', '120'); assert.equal(j.status, 1);
  const out = JSON.parse(j.stdout); assert.equal(out.pass, false); assert.equal(out.gaps, 4); assert.equal(out.recorded, null); assert.equal(out.checks.length, 6);
});

test('a feature never signed off: the walk is a gap and --skip is refused; a signed-off one is skipped and recorded', async t => {
  const root = repo(t); await feature(root, SPEC(), false);
  const r = quick(root, 'test', '--max-wait', '120'); assert.equal(r.status, 1);
  assert.match(r.stdout, /^✗ walk: not signed off \(built\) — the walk comes first/m);
  const s = quick(root, 'test', '--skip'); assert.equal(s.status, 1); assert.match(s.stderr, /not signed off — there is no check to skip yet/);
  const root2 = repo(t); await feature(root2);
  const k = quick(root2, 'test', '--skip'); assert.equal(k.status, 0, k.stderr); assert.match(k.stdout, /^recorded: check skipped — deliver next$/m);
  assert.equal((await run('status', 'test', { root: root2 })).check.kind, 'skipped');
});

test('a skip holds only at its own commit: after a registry commit it is recorded again; code after the sign-off is a walk gap', async t => {
  const root = repo(t); const m = await feature(root);
  assert.equal(quick(root, 'test', '--skip').status, 0);
  fs.writeFileSync(path.join(m.featurePath, 'walk.md'), 'walk notes\n'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-qm', 'walk notes');
  const again = quick(root, 'test', '--skip'); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /^recorded: check skipped — deliver next$/m);
  assert.equal((await run('status', 'test', { root })).check.head, git(m.worktree, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(m.worktree, 'fix.txt'), 'fix\n'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-qm', 'a fix after sign-off');
  const r = quick(root, 'test', '--max-wait', '120'); assert.equal(r.status, 1);
  assert.match(r.stdout, /^✗ walk: test changed since it was signed off at [0-9a-f]{7} — walk it again and sign off$/m);
});

test('usage: no feature, a bad --max-wait or an unknown feature exit 2', async t => {
  const root = repo(t);
  assert.equal(quick(root).status, 2);
  assert.equal(quick(root, 'test', '--max-wait', 'soon').status, 2);
  const u = quick(root, 'nope'); assert.equal(u.status, 2); assert.match(u.stderr, /Unknown feature: nope/);
});
