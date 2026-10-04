import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planSync, copyShared, finishSync, verifySync, packageHash } from '../scripts/sync.mjs';
import { releasePlan, release } from '../scripts/release.mjs';
const put = (root, name, value) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  put(root, '.claude-plugin/plugin.json', { name: 'builder', version: '1.0.0' });
  put(root, 'scripts/manifest.mjs', 'old\n'); put(root, 'skills/flow/SKILL.md', 'old flow\n');
  put(root, 'codex/plugin.json', { name: 'builder', version: '1.0.0' }); put(root, 'codex/scripts/manifest.mjs', 'old\n');
  put(root, 'codex/tests/pass.test.mjs', 'import test from "node:test"; test("proof", () => {});\n');
  put(root, '.agents/plugins/marketplace.json', { name: 'builder-codex', plugins: [{ name: 'builder', source: { source: 'local', path: './codex' } }] });
  git('add', '.'); git('commit', '-m', 'baseline'); const base = git('rev-parse', 'HEAD');
  put(root, 'codex/upstream.json', { commit: base, version: '1.0.0' });
  put(root, '.claude-plugin/plugin.json', { name: 'builder', version: '1.1.0' });
  put(root, 'scripts/manifest.mjs', 'new\n'); put(root, 'skills/flow/SKILL.md', 'new flow\n');
  git('add', '.'); git('commit', '-m', 'Claude first');
  return { root, git };
}
function report(root) {
  const plan = planSync(root);
  const decisions = plan.files.map(file => ({ file, disposition: 'adapted', reason: 'Fixture equivalent exercised by proof test', evidence: ['codex/tests/pass.test.mjs'] }));
  const file = path.join(root, 'decisions.json'); put(root, 'decisions.json', { ...plan, decisions }); return file;
}
test('sync enumerates upstream behavior, safely copies shared helpers, and requires decisions', t => {
  const { root } = fixture(t), plan = planSync(root);
  assert.deepEqual(plan.files, ['.claude-plugin/plugin.json', 'scripts/manifest.mjs', 'skills/flow/SKILL.md']);
  put(root, 'codex/scripts/manifest.mjs', 'Codex edit\n');
  assert.throws(() => copyShared(root), /Codex edits/);
  assert.equal(fs.readFileSync(path.join(root, 'codex/scripts/manifest.mjs'), 'utf8'), 'Codex edit\n');
  put(root, 'codex/scripts/manifest.mjs', 'old\n'); assert.deepEqual(copyShared(root), ['scripts/manifest.mjs']);
  const file = report(root), data = JSON.parse(fs.readFileSync(file)); data.decisions.pop(); put(root, 'decisions.json', data);
  assert.throws(() => finishSync(root, 'main', file), /Every upstream/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'codex/plugin.json'))).version, '1.0.0');
});
test('failed verification does not advance source baseline or version', t => {
  const { root } = fixture(t), file = report(root), before = fs.readFileSync(path.join(root, 'codex/upstream.json'), 'utf8');
  put(root, 'codex/tests/pass.test.mjs', 'process.exit(1);\n');
  assert.throws(() => finishSync(root, 'main', file));
  assert.equal(fs.readFileSync(path.join(root, 'codex/upstream.json'), 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'codex/plugin.json'))).version, '1.0.0');
});
test('release rejects stale package, dirty tree, wrong branch and colliding tag', t => {
  const { root, git } = fixture(t);
  finishSync(root, 'main', report(root)); assert.equal(verifySync(root).version, '1.1.0');
  assert.throws(() => releasePlan(root), /clean repository/);
  git('add', '.'); git('commit', '-m', 'verified port');
  assert.equal(releasePlan(root).tag, 'builder-codex--v1.1.0');
  put(root, 'codex/scripts/manifest.mjs', 'unverified edit'); assert.throws(() => verifySync(root), /changed since/);
  git('restore', 'codex/scripts/manifest.mjs');
  git('checkout', '-b', 'other'); assert.throws(() => releasePlan(root), /main/); git('checkout', 'main');
  git('tag', 'builder-codex--v1.1.0', 'HEAD~1'); assert.throws(() => releasePlan(root), /another commit/);
});
test('stale decisions and incomplete evidence cannot certify adaptation', t => {
  const { root } = fixture(t), file = report(root), data = JSON.parse(fs.readFileSync(file));
  data.target = data.base; put(root, 'decisions.json', data); assert.throws(() => finishSync(root, 'main', file), /Stale/);
  const fresh = JSON.parse(fs.readFileSync(report(root))); fresh.decisions[0].evidence = []; put(root, 'decisions.json', fresh);
  assert.throws(() => finishSync(root, 'main', file), /Missing Codex evidence/);
});
test('package digest detects content and executable permissions', t => {
  const { root } = fixture(t), dir = path.join(root, 'codex'), before = packageHash(dir);
  fs.chmodSync(path.join(dir, 'scripts/manifest.mjs'), 0o755); assert.notEqual(packageHash(dir), before);
});

test('publication pins verification HEAD and refuses main advancement during tests', t => {
  const { root, git } = fixture(t);
  put(root, 'codex/tests/pass.test.mjs', `import { execFileSync } from 'node:child_process';\nif (process.env.BUILDER_TEST_ADVANCE_MAIN) execFileSync('git', ['commit', '--allow-empty', '-m', 'concurrent advancement'], { cwd: ${JSON.stringify(root)} });\n`);
  finishSync(root, 'main', report(root)); git('add', '.'); git('commit', '-m', 'verified port');
  process.env.BUILDER_TEST_ADVANCE_MAIN = '1';
  try { assert.throws(() => release(root, 'pack'), /advanced during verification/); }
  finally { delete process.env.BUILDER_TEST_ADVANCE_MAIN; }
  assert.equal(git('tag', '--list'), ''); assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});
